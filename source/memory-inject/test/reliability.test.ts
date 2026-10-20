import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MemoryHit, MemoryRecord } from 'dsh-memory'
import { renderDigest } from '../src/digest.ts'
import { renderRules } from '../src/rules.ts'
import { InjectionState } from '../src/state.ts'
import { InjectAuditStore, auditQuery } from '../src/audit.ts'
import {
  BehaviorSignalStore,
  detectPhase,
  failureSignal,
  highRiskSignal,
  toolResultFailure,
} from '../src/signals.ts'
import { MemoryInjector, defaultInjectConfig } from '../src/inject.ts'
import { defaultInjectSettings, type DigestSettings, type RulesSettings } from '../../memory-local/src/inject-settings.ts'

const digestCfg: DigestSettings = defaultInjectSettings.digest
const rulesCfg: RulesSettings = defaultInjectSettings.rules

function rec(content: string, options: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: content,
    scope: 'project:D:/repo',
    kind: 'fact',
    content,
    tags: [],
    source: { origin: 'explicit', at: 0 },
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
    importance: 0.5,
    ...options,
  } as MemoryRecord
}

function hit(record: MemoryRecord): MemoryHit {
  return { record, score: 0.8 }
}

const msg = (role: string, text: string) => ({ role, content: [{ type: 'text', text }] })

test('摘要:32 条候选只装前几条时,统计互斥、截断有标签索引', () => {
  const now = Date.now()
  const records = Array.from({ length: 32 }, (_, i) => rec(
    i === 31
      ? '发布某个包之前要确认凭据、版本和工作区状态，并准备回退方案；这是一段不应该出现在标签索引里的长正文。'.repeat(3)
      : `记忆 ${i} ${'内容'.repeat(40)}`,
    {
      id: `id-${i}`,
      importance: i === 31 ? 0.05 : 0.9,
      updatedAt: now - i * 1000,
      tags: i === 31 ? ['release', 'publish', 'credentials'] : [`tag-${i}`],
    },
  ))
  const rendered = renderDigest(records, { ...digestCfg, topK: 8, tokenBudget: 400 })
  assert.ok(rendered)
  const stats = rendered!.stats
  assert.equal(stats.candidates, 32)
  assert.equal(stats.injected, rendered!.count)
  assert.ok(stats.injected <= 8)
  assert.equal(
    stats.injected + stats.omittedTopK + stats.omittedBudget + stats.omittedSuperseded + stats.omittedExpired,
    32,
    '每条候选只能落在一个互斥的统计桶里',
  )
  assert.ok(stats.truncated)
  assert.ok(stats.hint.injected > 0, '被截断的记录必须留下标签索引')
  assert.ok(rendered!.text.includes('相关记忆索引'))
  assert.ok(stats.omitted.some((entry) => entry.id === 'id-31' && entry.reason !== 'superseded'))
  assert.ok(stats.hintIds.includes('id-31'), '发布记忆即使正文被截断也应进入标签索引')
  assert.ok(rendered!.text.includes('release/publish/credentials'), '标签索引使用结构化标签')
  assert.ok(!rendered!.text.includes('这是一段不应该出现在标签索引里的长正文'), '标签索引不能复制整段正文')

  // 提高正文预算不能破坏 topK / 截断口径;标签预算独立。
  const bigger = renderDigest(records, { ...digestCfg, topK: 8, tokenBudget: 800 })
  assert.ok(bigger)
  assert.ok(bigger!.stats.injected >= stats.injected)
  assert.ok(bigger!.stats.injected <= 8)
  assert.equal(bigger!.stats.candidates, 32)
})

test('摘要:标签索引也有独立预算和条数上限,溢出会报告', () => {
  const records = Array.from({ length: 32 }, (_, i) => rec(`记忆 ${i}`, { id: `id-${i}`, importance: 0.5, tags: [`t${i}`] }))
  const rendered = renderDigest(records, {
    ...digestCfg,
    topK: 1,
    tokenBudget: 20,
    hintBudget: 40,
    hintMaxItems: 2,
  })
  assert.ok(rendered)
  assert.equal(rendered!.stats.injected, 0)
  assert.equal(rendered!.stats.hint.injected, 2)
  assert.ok(rendered!.stats.hint.omittedTopK + rendered!.stats.hint.omittedBudget > 0)
  assert.ok(rendered!.text.includes('另有'))
})

test('摘要/规则:superseded 旧记录不进入正文、索引或常驻规则', () => {
  const oldRule = rec('旧发布规则', { id: 'old-rule', kind: 'rule', tags: ['release'] })
  const newRule = rec('新发布规则', { id: 'new-rule', kind: 'rule', supersedes: 'old-rule' })
  const digest = renderDigest([oldRule, newRule], { ...digestCfg, topK: 8, tokenBudget: 800 })!
  assert.equal(digest.stats.omittedSuperseded, 1)
  assert.deepEqual(digest.stats.bodyIds, ['new-rule'])
  assert.ok(!digest.stats.hintIds.includes('old-rule'))
  assert.ok(!digest.text.includes('旧发布规则'))

  const rules = renderRules([oldRule, newRule], { ...rulesCfg, maxItems: 10, tokenBudget: 500 })!
  assert.equal(rules.stats.omittedSuperseded, 1)
  assert.ok(rules.text.includes('新发布规则'))
  assert.ok(!rules.text.includes('旧发布规则'))
})

test('规则:mandatory 排最前,超出预算时明确警告而不是静默丢弃', () => {
  const mandatory = rec('必须保留的发布前置条件', { id: 'm', kind: 'rule', tags: ['mandatory'], importance: 0.1 })
  const normal = rec('普通规则', { id: 'n', kind: 'rule', importance: 0.9 })
  const ordered = renderRules([normal, mandatory], { ...rulesCfg, maxItems: 10, tokenBudget: 500 })!
  const lines = ordered.text.split('\n').filter((line) => line.startsWith('- '))
  assert.ok(lines[0]!.includes('必须保留的发布前置条件'), 'mandatory 必须排在最前')

  const tight = renderRules([normal, mandatory], { ...rulesCfg, maxItems: 1, tokenBudget: 20 })
  assert.ok(tight)
  assert.equal(tight!.stats.mandatoryOmitted, 1)
  assert.ok(tight!.text.includes('警告'), 'mandatory 溢出必须有醒目提示')
})

test('会话级注入状态:区分 hint/content、版本更新与跨会话去重', () => {
  const state = new InjectionState()
  state.markHint('s1', [{ id: 'a', updatedAt: 1 }])
  assert.equal(state.statusOf('s1', 'a'), 'hint_injected')
  assert.deepEqual(state.filterNewContent('s1', [{ id: 'a', updatedAt: 1 }]).fresh.map((r) => r.id), ['a'], '只注入标签后应允许补正文')

  state.markContent('s1', [{ id: 'a', updatedAt: 1 }])
  assert.equal(state.statusOf('s1', 'a'), 'content_injected')
  assert.equal(state.filterNewContent('s1', [{ id: 'a', updatedAt: 1 }]).deduplicated.length, 1)
  assert.equal(state.filterNewContent('s1', [{ id: 'a', updatedAt: 2 }]).updated.length, 1, '内容更新要重新评估')
  assert.equal(state.filterNewContent('s2', [{ id: 'a', updatedAt: 1 }]).deduplicated.length, 0, '另一个会话不能沿用去重状态')

  state.clear('s1')
  assert.equal(state.statusOf('s1', 'a'), 'not_seen')
})

test('审计环:最新在前、按会话过滤、有上限', () => {
  const audit = new InjectAuditStore()
  for (let i = 0; i < 205; i++) {
    audit.record({
      at: i, sessionId: i % 2 === 0 ? 'even' : 'odd', trigger: 'turn_start', phase: 'unknown',
      candidates: i, contentIds: [], hintIds: [], omitted: [], dedupSkipped: 0, budgets: {},
      retrieval: { ok: true, count: i },
    })
  }
  assert.equal(audit.list().length, 200)
  assert.equal(audit.list()[0]!.candidates, 204)
  assert.equal(audit.list('odd').length, 100)
  assert.ok(audit.list('odd').every((entry) => entry.sessionId === 'odd'))
})

test('审计查询脱敏:不把凭据形状写进审计', () => {
  const query = auditQuery('deploy with token=abcdefgh12345678 and sk-1234567890abcdefghij')
  assert.ok(query)
  assert.ok(!query!.includes('abcdefgh12345678'))
  assert.ok(!query!.includes('sk-1234567890abcdefghij'))
  assert.ok(query!.includes('[REDACTED:'))
})

test('行为信号:高风险工具/失败分类/阶段判断', () => {
  assert.equal(highRiskSignal('bash', 'npm publish --access public')?.reason, 'before_high_risk_tool')
  assert.equal(highRiskSignal('bash', 'git push origin main')?.phase, 'release')
  assert.equal(highRiskSignal('bash', 'ls -la'), undefined)
  assert.equal(failureSignal('bash', 'E401', 'unauthorized')?.errorClass, 'MISSING_CREDENTIAL')
  assert.equal(failureSignal('bash', 'ETIMEDOUT', 'timed out')?.errorClass, 'TIMEOUT')
  assert.equal(failureSignal('bash', undefined, 'aborted by user')?.errorClass, 'ABORTED_UNKNOWN')
  assert.equal(failureSignal('bash', 'EACCES', 'permission denied')?.errorClass, 'PERMISSION_DENIED')
  assert.equal(detectPhase('npm publish'), 'release')
  assert.equal(detectPhase('实现一个标签页'), 'development')
  assert.equal(detectPhase('随便聊聊'), 'unknown')

  const failure = toolResultFailure({
    data: {
      message: { isError: true, content: [{ type: 'text', text: 'missing token' }], source: { callId: 'c1' } },
      error: { code: 'E401' },
    },
  })
  assert.equal(failure.isError, true)
  assert.equal(failure.code, 'E401')

  const store = new BehaviorSignalStore()
  const signal = highRiskSignal('bash', 'git push origin main')!
  assert.equal(store.note('s1', signal), true)
  assert.equal(store.note('s1', signal), false, '相同信号不重复排队')
  assert.equal(store.take('s1')?.key, signal.key)
  assert.equal(store.take('s1'), undefined)
})

test('自动召回链路:标签命中后补正文,正文已注入则去重', async () => {
  const state = new InjectionState()
  const record = rec('发布前先检查 devcred 凭据', { id: 'publish-1', kind: 'procedure', tags: ['release'], updatedAt: 1 })
  const injector = new MemoryInjector(async () => [hit(record)], { ...defaultInjectConfig, topK: 5, tokenBudget: 500 }, {}, state)
  state.markHint('s1', [{ id: record.id, updatedAt: 1 }])
  const input = { messages: [msg('user', '准备发布')], sessionId: 's1' }
  const first = await injector.maybeInjectDetailed(input, input, { sessionId: 's1', query: 'release publish credentials', trigger: 'before_high_risk_tool' })
  assert.ok(first?.text?.includes('发布前先检查'))
  assert.deepEqual(first!.ids, [record.id])
  const second = await injector.maybeInjectDetailed(input, input, { sessionId: 's1', query: 'release publish credentials', trigger: 'before_high_risk_tool' })
  assert.equal(second?.text, undefined, '相同正文不应重复注入')
  assert.ok((second?.dedupSkipped ?? 0) >= 1)

  const other = await injector.maybeInjectDetailed({ ...input, sessionId: 's2' }, input, { sessionId: 's2', query: 'release' })
  assert.ok(other?.text, '另一个会话不能沿用旧会话的去重状态')
})
