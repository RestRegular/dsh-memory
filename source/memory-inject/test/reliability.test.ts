import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MemoryHit, MemoryRecord } from 'dsh-memory'
import { renderDigest } from '../src/digest.ts'
import { renderRules } from '../src/rules.ts'
import { InjectionState } from '../src/state.ts'
import { InjectAuditStore, auditQuery, sanitizeAuditText } from '../src/audit.ts'
import {
  BehaviorSignalStore,
  detectPhase,
  assistantVisibleText,
  commandText,
  failureSignal,
  goalText,
  highRiskSignal,
  textHasTag,
  textTagSignal,
  todoText,
  toolCallDescription,
  toolResultFailure,
} from '../src/signals.ts'
import { MemoryInjector, defaultInjectConfig } from '../src/inject.ts'
import { DEFAULT_AUTO_RECALL_TAGS, defaultInjectSettings, type DigestSettings, type RulesSettings } from '../../memory-local/src/inject-settings.ts'

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

test('摘要:superseded 旧记录与 rule 都不进入正文、索引或常驻规则', () => {
  const oldFact = rec('旧发布结论', { id: 'old-fact', tags: ['release'] })
  const newFact = rec('新发布结论', { id: 'new-fact', supersedes: 'old-fact' })
  const digest = renderDigest([oldFact, newFact], { ...digestCfg, topK: 8, tokenBudget: 800 })!
  assert.equal(digest.stats.omittedSuperseded, 1)
  assert.deepEqual(digest.stats.bodyIds, ['new-fact'])
  assert.ok(!digest.stats.hintIds.includes('old-fact'))
  assert.ok(!digest.text.includes('旧发布结论'))

  // 规则已经常驻系统提示(rules 段),摘要必须排除它,避免同一个 id 两个通道重复。
  const oldRule = rec('旧发布规则', { id: 'old-rule', kind: 'rule', tags: ['release'] })
  const newRule = rec('新发布规则', { id: 'new-rule', kind: 'rule', supersedes: 'old-rule' })
  assert.equal(renderDigest([oldRule, newRule], { ...digestCfg, topK: 8, tokenBudget: 800 }), null)
  const mixed = renderDigest([oldRule, newRule, oldFact, newFact], { ...digestCfg, topK: 8, tokenBudget: 800 })!
  assert.equal(mixed.stats.omittedRules, 2)
  assert.ok(!mixed.stats.bodyIds.includes('new-rule'))
  assert.ok(!mixed.stats.hintIds.includes('new-rule'))
  assert.ok(!mixed.text.includes('新发布规则'))

  const rules = renderRules([oldRule, newRule], { ...rulesCfg, maxItems: 10, tokenBudget: 500 })!
  assert.equal(rules.stats.omittedSuperseded, 1)
  assert.ok(rules.text.includes('新发布规则'))
  assert.ok(!rules.text.includes('旧发布规则'))
  assert.deepEqual(rules.stats.injectedEntries, [{ id: 'new-rule', updatedAt: 0 }])
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

test('摘要去重:summary 状态参与 seenInContext,不会被 hint 降级,正文仍可继续召回', () => {
  const state = new InjectionState()
  state.markSummary('s1', [{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 1 }])
  assert.equal(state.statusOf('s1', 'a'), 'summary_injected')
  assert.deepEqual([...state.seenInContext('s1', [{ id: 'a', updatedAt: 1 }])], ['a'], '同版本摘要已出现')
  assert.equal(state.seenInContext('s1', [{ id: 'a', updatedAt: 2 }]).size, 0, '内容版本变了 → 摘要要重新给')

  // 标签索引比摘要弱:后面再注入 hint 不能把 summary 降级。
  state.markHint('s1', [{ id: 'a', updatedAt: 1 }])
  assert.equal(state.statusOf('s1', 'a'), 'summary_injected')

  // 摘要不算正文:自动召回仍可以补一次正文。
  assert.deepEqual(state.filterNewContent('s1', [{ id: 'a', updatedAt: 1 }]).fresh.map((r) => r.id), ['a'])

  // 正文盖过摘要,summary 也不能把正文降级。
  state.markContent('s1', [{ id: 'b', updatedAt: 1 }])
  state.markSummary('s1', [{ id: 'b', updatedAt: 1 }])
  assert.equal(state.statusOf('s1', 'b'), 'content_injected')
  assert.equal(state.seenInContext('s1', [{ id: 'b', updatedAt: 1 }]).size, 1)
})

test('审计环:按会话保留、最新在前、可按会话过滤', () => {
  const audit = new InjectAuditStore()
  for (let i = 0; i < 205; i++) {
    audit.record({
      at: i, sessionId: i % 2 === 0 ? 'even' : 'odd', kind: 'evaluation', channel: 'recall', stage: 'searched',
      outcome: 'success', trigger: 'turn_start', phase: 'unknown', candidates: i,
      selected: { contentIds: [], hintIds: [], count: 0 }, omitted: [], dedup: { skipped: 0, updated: 0, lastTextSame: false }, budgets: {},
      retrieval: { ok: true, count: i },
    })
  }
  assert.equal(audit.list().length, 205, '全局容量 2000 内全部保留')
  assert.equal(audit.list()[0]!.candidates, 204)
  assert.equal(audit.list('odd').length, 102)
  assert.ok(audit.list('odd').every((entry) => entry.sessionId === 'odd'))
})

test('审计 v2:每会话容量、丢弃计数、seq 单调、返回副本', () => {
  const audit = new InjectAuditStore({ capacity: 100, perSessionCapacity: 5 })
  for (let i = 0; i < 10; i++) {
    audit.record({
      sessionId: 's1', kind: 'evaluation', channel: 'recall', stage: 'searched', outcome: 'success',
      candidates: i, selected: { contentIds: [], hintIds: [], count: 0 }, omitted: [],
      dedup: { skipped: 0, updated: 0, lastTextSame: false }, budgets: {},
    })
  }
  assert.equal(audit.list('s1').length, 5)
  assert.equal(audit.stats().dropped, 5)
  assert.equal(audit.stats().entries, 5)
  const page = audit.query({ sessionId: 's1', limit: 2 })
  assert.equal(page.total, 5)
  assert.equal(page.entries.length, 2)
  assert.ok(page.nextCursor)
  assert.ok(page.entries[0]!.seq > page.entries[1]!.seq)
  // 返回副本：调用方修改不能污染 store。
  page.entries[0]!.candidates = 999
  assert.notEqual(audit.list('s1').find((entry) => entry.id === page.entries[0]!.id)!.candidates, 999)
  const next = audit.query({ sessionId: 's1', limit: 2, cursor: page.nextCursor })
  assert.ok(next.entries.every((entry) => !page.entries.some((prev) => prev.seq === entry.seq)))
})

test('审计 v2:筛选、问题视图与稳定游标', () => {
  const audit = new InjectAuditStore()
  const record = (extra: Record<string, unknown>) => audit.record({
    sessionId: 's1', kind: 'evaluation', channel: 'recall', stage: 'searched', outcome: 'success',
    trigger: 'turn_start', ...extra,
  } as never)
  record({ candidates: 3, selected: { contentIds: ['a'], hintIds: [], count: 1 }, omitted: [] })
  record({ outcome: 'failed', trigger: 'tool_failure', error: { stage: 'search', code: 'retrieval_failed' } })
  record({ channel: 'digest', outcome: 'skipped', reasonCode: 'no_candidates', omitted: [{ id: 'b', reason: 'budget' }] })
  assert.equal(audit.query({ channel: 'digest' }).total, 1)
  assert.equal(audit.query({ trigger: 'tool_failure' }).total, 1)
  assert.equal(audit.query({ outcome: 'failed' }).total, 1)
  assert.equal(audit.query({ memoryId: 'a' }).total, 1)
  assert.equal(audit.query({ memoryId: 'b' }).total, 1)
  assert.equal(audit.query({ problem: true }).total, 2)
  assert.throws(() => audit.query({ limit: 0 }), /limit/)
  assert.throws(() => audit.query({ cursor: 'nope' }), /cursor/)
})

test('审计查询脱敏:不把凭据形状写进审计,先限长再扫描', () => {
  const query = auditQuery('deploy with token=abcdefgh12345678 and sk-1234567890abcdefghij')
  assert.ok(query)
  assert.ok(!query!.includes('abcdefgh12345678'))
  assert.ok(!query!.includes('sk-1234567890abcdefghij'))
  assert.ok(query!.includes('[REDACTED:'))

  const long = sanitizeAuditText(`${'x'.repeat(5000)} token=abcdefgh12345678`)
  assert.ok(long)
  assert.ok((long!.text ?? '').length <= 200, '超长输入只保留 200 字')
  assert.equal(long!.chars, 5000 + ' token=abcdefgh12345678'.length)
  const signalLike = sanitizeAuditText('工具描述 token=abcdefgh12345678')
  assert.ok(signalLike)
  assert.ok(!(signalLike!.text ?? '').includes('abcdefgh12345678'))
  assert.equal(signalLike!.redacted, true)
})

test('行为信号:标签触发、失败分类、description 优先', () => {
  const tags = DEFAULT_AUTO_RECALL_TAGS
  assert.equal(highRiskSignal('bash', 'npm publish --access public', { tags })?.reason, 'before_high_risk_tool')
  assert.equal(highRiskSignal('bash', 'git push origin main', { tags })?.phase, 'release')
  assert.equal(highRiskSignal('bash', 'ls -la', { tags }), undefined)
  assert.equal(highRiskSignal('bash', '部署到生产环境', { tags })?.phase, 'deploy')
  assert.ok(['migrate', 'migration', 'database', 'deploy'].includes(highRiskSignal('bash', 'prisma migrate deploy', { tags })?.tag ?? ''))
  assert.equal(highRiskSignal('bash', 'drop table users', { tags })?.tag, 'drop')
  assert.equal(highRiskSignal('bash', 'npm publish', { tags, description: '发布 dsh-memory 0.9.7', useToolDescription: true })?.query, '发布 dsh-memory 0.9.7')
  // 自定义标签:不依赖内置列表
  assert.equal(highRiskSignal('bash', 'docker build .', { tags: ['build'] })?.tag, 'build')
  assert.equal(textHasTag('deploy the production service', 'deploy'), true)
  assert.equal(textHasTag('redeploy', 'deploy'), false, '词内子串不命中')
  assert.equal(textHasTag('部署到生产', 'deploy'), true, '英文标签匹配中文文本')
  assert.equal(textHasTag('release the package', '发布'), true, '中文标签匹配英文文本')
  assert.equal(toolCallDescription(JSON.stringify({ description: '部署到测试环境' })), '部署到测试环境')
  const textSignal = textTagSignal('准备发布新版本', { tags: ['发布', 'release'], source: 'assistant' })
  assert.equal(textSignal?.tag, '发布')
  assert.equal(textSignal?.reason, 'text_tag_match')
  assert.ok(textSignal?.query.includes('发布'))
  assert.equal(textTagSignal('完全无关的内容', { tags: ['发布'] }), undefined)
  assert.equal(assistantVisibleText({ data: { message: { content: [{ type: 'reasoning', text: '隐藏推理' }, { type: 'text', text: '部署到生产' }] } } }), '部署到生产', '只取可见 text 块')
  assert.equal(todoText({ data: { todos: [{ content: '发布包' }, { content: '写文档' }] } }), ['发布包', '写文档'].join(String.fromCharCode(10)))
  assert.equal(commandText({ data: { name: 'deploy', args: '--prod' } }), 'deploy --prod')
  assert.equal(goalText({ data: { goal: { objective: '数据库迁移' } } }), '数据库迁移')
  assert.equal(toolCallDescription('not json'), undefined)
  assert.equal(failureSignal('bash', 'E401', 'unauthorized')?.errorClass, 'MISSING_CREDENTIAL')
  assert.equal(failureSignal('bash', 'ETIMEDOUT', 'timed out')?.errorClass, 'TIMEOUT')
  assert.equal(failureSignal('bash', undefined, 'aborted by user')?.errorClass, 'ABORTED_UNKNOWN')
  assert.equal(failureSignal('bash', 'EACCES', 'permission denied')?.errorClass, 'PERMISSION_DENIED')
  const described = failureSignal('bash', 'E401', 'unauthorized', { description: '部署到测试环境时缺少凭据' })
  assert.ok(described.query.includes('部署到测试环境时缺少凭据'))
  assert.ok(described.query.includes('credentials'))
  const other = failureSignal('bash', 'E401', 'unauthorized', { description: '发布 npm 包' })
  assert.notEqual(described.key, other.key, '不同 description 应可各自触发一次')
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
  const signal = highRiskSignal('bash', 'git push origin main', { tags })!
  assert.equal(store.note('s1', signal), true)
  assert.equal(store.note('s1', signal), false, '相同信号不重复排队')
  assert.equal(store.take('s1')?.key, signal.key)
  assert.equal(store.take('s1'), undefined)
})

test('状态型记忆:注入带“使用前验证”前缀,过期正文不进入召回', async () => {
  const live = rec('当前部署在测试环境', { id: 'state-live', kind: 'state', tags: ['deploy'], expiredAt: Date.now() + 60_000 })
  const digest = renderDigest([live], { ...digestCfg, topK: 8, tokenBudget: 800 })!
  assert.ok(digest.text.includes('【状态，使用前验证】'))

  const expired = rec('当前部署在生产环境', { id: 'state-old', kind: 'state', expiredAt: Date.now() - 1000 })
  const injector = new MemoryInjector(async () => [hit(expired), hit(live)], { ...defaultInjectConfig, tokenBudget: 500 }, {})
  const input = { messages: [msg('user', '现在部署在哪')] }
  const result = await injector.maybeInjectDetailed(input, input, { query: '部署环境', sessionId: 'state-s' })
  assert.deepEqual(result?.ids, ['state-live'])
  assert.ok(result?.text?.includes('【状态，使用前验证】'))
  assert.ok(!result?.text?.includes('当前部署在生产环境'))
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

test('标签触发的自动召回只接受带该标签的记忆', async () => {
  const tagged = hit(rec('发布前检查凭据', { id: 'tagged', tags: ['release', 'credentials'], updatedAt: 1 }))
  const unrelated = hit(rec('dsh-memory digest 预算', { id: 'unrelated', tags: ['dsh-memory', 'digest'], updatedAt: 1 }))
  const injector = new MemoryInjector(async () => [unrelated, tagged], { ...defaultInjectConfig, tokenBudget: 500 }, {})
  const input = { messages: [msg('user', '准备发布')] }
  const result = await injector.maybeInjectDetailed(input, input, {
    query: 'release', tag: 'release', requireTag: true, sessionId: 's1',
  })
  assert.deepEqual(result?.ids, ['tagged'])

  const noTag = new MemoryInjector(async () => [unrelated], { ...defaultInjectConfig, tokenBudget: 500 }, {})
  const blocked = await noTag.maybeInjectDetailed(input, input, {
    query: 'release', tag: 'release', requireTag: true, sessionId: 's2',
  })
  assert.equal(blocked?.text, undefined)
  assert.equal(blocked?.candidates, 0)
})
