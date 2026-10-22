import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MemoryRecord } from 'dsh-memory'
import { defaultInjectSettings } from '../../memory-local/src/inject-settings.ts'
import { procedureTerms, renderProcedureIndex } from '../src/procedures.ts'

const cfg = defaultInjectSettings.procedures

function rec(content: string, options: Partial<MemoryRecord> & { triggers?: string[] } = {}): MemoryRecord {
  return {
    id: content,
    scope: 'project:D:/repo',
    kind: 'procedure',
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

test('流程索引:当前工作区的流程总是可见,其它 scope 必须命中触发词', () => {
  const local = rec('发布 dsh-memory 的完整流程', { id: 'proc-local', scope: 'project:D:/repo' })
  const global = rec('npm 发布前先 whoami', { id: 'proc-global', scope: 'global', triggers: ['npm', 'publish'] })
  const unrelated = rec('部署 k8s 的流程', { id: 'proc-k8s', scope: 'global', triggers: ['kubectl'] })
  const rendered = renderProcedureIndex([local, global, unrelated], cfg, {
    query: '准备 npm publish 新版本',
    projectScopes: ['project:D:/repo'],
  })!
  assert.ok(rendered)
  assert.ok(rendered.ids.includes('proc-local'), '工作区流程不需要触发词')
  assert.ok(rendered.ids.includes('proc-global'), 'query 命中 npm/publish')
  assert.ok(!rendered.ids.includes('proc-k8s'))
  assert.ok(rendered.text.includes('npm/publish'))
  assert.ok(rendered.text.includes('发布 dsh-memory 的完整流程'))
  assert.ok(!rendered.text.includes('部署 k8s 的流程'))
})

test('流程索引:triggers 优先于 tags,工具名也能触发', () => {
  const record = rec('用 ops_bash 跑发布脚本', {
    id: 'proc-tool',
    scope: 'global',
    tags: ['release'],
    triggers: ['ops_bash', 'devcred'],
  })
  assert.deepEqual(procedureTerms(record), ['ops_bash', 'devcred'])
  const rendered = renderProcedureIndex([record], cfg, {
    tools: ['ops_bash'],
    projectScopes: ['project:D:/other'],
  })!
  assert.equal(rendered.count, 1)
  assert.ok(rendered.text.includes('ops_bash/devcred'))
})

test('流程索引:条数 / 预算上限与空结果', () => {
  const records = Array.from({ length: 8 }, (_, i) => rec(`流程 ${i}`, {
    id: `p-${i}`,
    scope: 'project:D:/repo',
    importance: 1 - i / 10,
  }))
  const capped = renderProcedureIndex(records, { ...cfg, maxItems: 3 }, { projectScopes: ['project:D:/repo'] })!
  assert.equal(capped.count, 3)
  assert.equal(capped.stats.omitted.filter((entry) => entry.reason === 'top_k').length, 5)
  const tight = renderProcedureIndex(records, { ...cfg, maxItems: 8, tokenBudget: 20 }, { projectScopes: ['project:D:/repo'] })
  assert.equal(tight, null, '预算连第一行都放不下时返回 null')

  const none = renderProcedureIndex([], cfg, { projectScopes: ['project:D:/repo'] })
  assert.equal(none, null)
  const disabled = renderProcedureIndex(records, { ...cfg, enabled: false }, { projectScopes: ['project:D:/repo'] })
  assert.equal(disabled, null)
})

test('流程索引:退役与过期流程不出现', () => {
  const old = rec('旧发布流程', { id: 'old', scope: 'project:D:/repo' })
  const fresh = rec('新发布流程', { id: 'new', scope: 'project:D:/repo', supersedes: 'old' })
  const expired = rec('临时流程', { id: 'expired', scope: 'project:D:/repo', expiredAt: Date.now() - 1000 })
  const rendered = renderProcedureIndex([old, fresh, expired], cfg, { projectScopes: ['project:D:/repo'] })!
  assert.deepEqual(rendered.ids, ['new'])
  assert.ok(!rendered.text.includes('旧发布流程'))
  assert.ok(!rendered.text.includes('临时流程'))
})
