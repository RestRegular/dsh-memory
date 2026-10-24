import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  memorySaveTool,
  memorySearchTool,
  type AccessDecisionView,
  type VisibilityPolicyView,
} from '../src/index.ts'

const PROJECT = 'project:D:/w'

const records = [
  {
    record: { id: 'g1', scope: 'global', kind: 'fact', content: '全局记忆', tags: [], importance: 0.5, updatedAt: 1 },
    score: 0.9,
  },
  {
    record: { id: 'h1', scope: 'handbook', kind: 'fact', content: '范围外记忆', tags: [], importance: 0.5, updatedAt: 2 },
    score: 0.8,
  },
]

interface Harness {
  tool: ReturnType<typeof memorySaveTool> | ReturnType<typeof memorySearchTool>
  asked: number
  saved: Array<Record<string, unknown>>
}

function harness(
  policy: VisibilityPolicyView,
  decisions: Record<string, AccessDecisionView>,
  kind: 'save' | 'search',
): Harness {
  const asked = { count: 0 }
  const saved: Array<Record<string, unknown>> = []
  const service = {
    save: async (input: unknown) => {
      saved.push(input as Record<string, unknown>)
      return { id: 'new-id', scope: 'handbook' }
    },
    search: async () => records,
    list: async () => records.map((item) => item.record),
    forget: async () => ({ removed: 0, ids: [] }),
    getByIds: () => records.map((item) => item.record),
    visibilityPolicy: () => policy,
    accessEvaluator: () => (request: { action: string; scope: string }) =>
      decisions[`${request.action}:${request.scope}`] ?? { allowed: true, requestable: false },
    requestOutOfScope: async () => {
      asked.count += 1
      return 'rejected'
    },
  }
  const tool = kind === 'save'
    ? memorySaveTool({ getService: () => service })
    : memorySearchTool({ getService: () => service })
  return {
    tool,
    get asked() { return asked.count },
    saved,
  }
}

const agentExec = { agent: { session: { header: { id: 's1', cwd: 'D:/w' } } } }

const ABSOLUTE: VisibilityPolicyView = { level: 'absolute', scopes: [{ scope: 'global' }], source: 'explicit' }
const NORMAL: VisibilityPolicyView = { level: 'normal', scopes: [{ scope: 'global' }], source: 'explicit' }

test('absolute：search 不发起审批，withheld=absolute', async () => {
  const h = harness(ABSOLUTE, {
    'read:global': { allowed: true, requestable: false },
    'read:handbook': { allowed: false, reason: 'ABSOLUTE_ISOLATION', requestable: false },
  }, 'search')
  const result = await h.tool.execute({ query: '记忆', description: '查记忆' }, agentExec)
  assert.equal(result.records.length, 1)
  assert.deepEqual(result.withheld, { count: 1, reason: 'absolute' })
  assert.equal(h.asked, 0, 'absolute 下不能弹审批')
})

test('normal：范围外 search 会发起一次审批，拒绝后 withheld=rejected', async () => {
  const h = harness(NORMAL, {
    'read:global': { allowed: true, requestable: false },
    'read:handbook': { allowed: false, reason: 'SCOPE_NOT_IN_RANGE', requestable: true },
  }, 'search')
  const result = await h.tool.execute({ query: '记忆', description: '查记忆' }, agentExec)
  assert.equal(result.records.length, 1)
  assert.deepEqual(result.withheld, { count: 1, reason: 'rejected' })
  assert.equal(h.asked, 1)
})

test('absolute：memory_save 直接拒绝，不弹审批', async () => {
  const h = harness(ABSOLUTE, {
    'write:handbook': { allowed: false, reason: 'ABSOLUTE_ISOLATION', requestable: false },
  }, 'save')
  await assert.rejects(
    h.tool.execute({ content: '新内容', scope: 'handbook', description: '写入测试' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'VISIBILITY_ABSOLUTE',
  )
  assert.equal(h.asked, 0)
  assert.equal(h.saved.length, 0)
})

test('normal：范围外 memory_save 先审批；用户拒绝则失败', async () => {
  const h = harness(NORMAL, {
    'write:handbook': { allowed: false, reason: 'SCOPE_NOT_IN_RANGE', requestable: true },
  }, 'save')
  await assert.rejects(
    h.tool.execute({ content: '新内容', scope: 'handbook', description: '写入测试' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'VISIBILITY_REJECTED',
  )
  assert.equal(h.asked, 1)
  assert.equal(h.saved.length, 0)
})

test('显式 write:false 不弹审批，直接 SCOPE_READ_ONLY', async () => {
  const h = harness(NORMAL, {
    'write:handbook': { allowed: false, reason: 'WRITE_DISABLED', requestable: false },
  }, 'save')
  await assert.rejects(
    h.tool.execute({ content: '新内容', scope: 'handbook', description: '写入测试' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'SCOPE_READ_ONLY',
  )
  assert.equal(h.asked, 0)
})
