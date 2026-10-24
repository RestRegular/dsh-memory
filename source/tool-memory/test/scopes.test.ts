import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  memorySaveTool,
  memoryScopesTool,
  type ScopeCatalogEntryView,
  type VisibilityPolicyView,
} from '../src/index.ts'
import { renderScopesResult } from '../src/render.ts'

const NORMAL: VisibilityPolicyView = {
  level: 'normal',
  scopes: [{ scope: 'global' }],
  source: 'explicit',
}

const entries: ScopeCatalogEntryView[] = [
  {
    scope: 'global',
    name: '全局',
    description: '所有项目共享',
    origin: 'global',
    records: 3,
    inScope: true,
    readable: true,
    writable: true,
    canRequestRead: false,
    canRequestWrite: false,
    accessStatus: 'default',
    updatedAt: 1,
  },
  {
    scope: 'handbook',
    description: '团队约定与流程',
    origin: 'custom',
    inScope: false,
    readable: false,
    writable: false,
    canRequestRead: true,
    canRequestWrite: false,
    accessStatus: 'restricted',
    updatedAt: 2,
  },
  {
    scope: 'secret-notes',
    description: '绝对隔离的私人笔记',
    origin: 'custom',
    inScope: false,
    readable: false,
    writable: false,
    canRequestRead: false,
    canRequestWrite: false,
    accessStatus: 'restricted',
    updatedAt: 3,
  },
]

const service = {
  save: async () => ({ id: 'x', scope: 'global' }),
  search: async () => [],
  forget: async () => ({ removed: 0, ids: [] }),
  list: async () => [],
  scopeCatalog: () => entries,
  visibilityPolicy: () => NORMAL,
  requestScopeGrants: async (_agent: unknown, input: { requests: Array<{ scope: string; permissions: Array<'read' | 'write'> }> }) => ({
    results: input.requests.flatMap((request) => request.permissions.map((permission) => ({
      scope: request.scope,
      permission,
      status: 'granted' as const,
    }))),
    outcome: 'allowed-once' as const,
  }),
}

const tool = memoryScopesTool({ getService: () => service })
const agentExec = { agent: { session: { header: { id: 's1', cwd: 'D:/w' } } } }

test('memory_scopes list：默认列出范围外条目，且不带正文/记录数', async () => {
  const result = await tool.execute({ action: 'list', description: '看看有哪些作用域' }, agentExec)
  assert.equal(result.total, 3)
  assert.equal(result.scopes.length, 3)
  const handbook = result.scopes.find((item) => item.scope === 'handbook')!
  assert.equal(handbook.description, '团队约定与流程')
  assert.equal(handbook.inScope, false)
  assert.equal(handbook.records, undefined, '范围外不返回条数')
  assert.equal('content' in handbook, false, '目录不返回正文')
})

test('memory_scopes list：includeOutOfScope=false 只列范围内；limit 截断', async () => {
  const inside = await tool.execute({ action: 'list', includeOutOfScope: false, description: '只看范围内' }, agentExec)
  assert.deepEqual(inside.scopes.map((item) => item.scope), ['global'])

  const limited = await tool.execute({ action: 'list', limit: 1, description: '只看一个' }, agentExec)
  assert.equal(limited.scopes.length, 1)
  assert.equal(limited.total, 3)
  assert.equal(limited.omitted, 2)
})

test('memory_scopes：普通限制下缺 description 直接拒绝', async () => {
  await assert.rejects(
    tool.execute({ action: 'list' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'DESCRIPTION_REQUIRED',
  )
})

test('memory_scopes request：默认只申请只读，透传 scope 与权限', async () => {
  const result = await tool.execute({
    action: 'request',
    requests: [{ scope: 'handbook' }, { scope: 'secret-notes', permissions: ['read', 'write'] }],
    reason: '需要团队约定',
    description: '申请 handbook',
  }, agentExec)
  assert.deepEqual(result.results, [
    { scope: 'handbook', permission: 'read', status: 'granted' },
    { scope: 'secret-notes', permission: 'read', status: 'granted' },
    { scope: 'secret-notes', permission: 'write', status: 'granted' },
  ])
})

test('memory_scopes request：缺少 requests / 超过 5 个 scope 明确拒绝', async () => {
  await assert.rejects(
    tool.execute({ action: 'request', description: '申请' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'REQUESTS_REQUIRED',
  )
  await assert.rejects(
    tool.execute({
      action: 'request',
      requests: Array.from({ length: 6 }, (_, i) => ({ scope: `scope-${i}` })),
      description: '批量申请',
    }, agentExec),
    (error: Error & { code?: string }) => error.code === 'REQUESTS_TOO_MANY',
  )
})

test('老 provider 没有 scopeCatalog 时明确报不支持', async () => {
  const old = memoryScopesTool({ getService: () => ({ save: async () => ({ id: 'x', scope: 'global' }), search: async () => [], forget: async () => ({ removed: 0, ids: [] }), list: async () => [] }) })
  await assert.rejects(
    old.execute({ action: 'list', description: '看看目录' }, { _noAgent: true }),
    (error: Error & { code?: string }) => error.code === 'SCOPES_UNAVAILABLE',
  )
})

test('渲染：范围外写明可申请/不可申请，且不出现正文', async () => {
  const result = await tool.execute({ action: 'list', description: '渲染检查' }, agentExec)
  const text = renderScopesResult(result, (scope) => (scope === 'global' ? '全局' : scope))
  assert.match(text, /团队约定与流程/)
  assert.match(text, /可申请只读/)
  assert.match(text, /绝对隔离的私人笔记/)
  assert.match(text, /不可申请/)
  assert.match(text, /3 条/, '范围内才渲染条数')
  assert.equal(text.includes('一条正文'), false)
})

test('渲染：目录带 initial 正文（normal），absolute 时条目本就不会带', () => {
  const text = renderScopesResult({
    scopes: [{
      scope: 'handbook',
      description: '团队约定',
      origin: 'custom',
      inScope: false,
      readable: false,
      writable: false,
      canRequestRead: true,
      canRequestWrite: false,
      accessStatus: 'restricted',
      updatedAt: 1,
      initialRecords: [{ id: 'i1', kind: 'fact', content: '本作用域用于团队约定' }],
    }],
    total: 1,
    omitted: 0,
  }, (scope) => scope)
  assert.match(text, /初始记录：\[fact\] 本作用域用于团队约定/)
})

test('渲染：grant 结果显示授予 / 不可申请及原因', () => {
  const text = renderScopesResult({
    results: [
      { scope: 'handbook', permission: 'read', status: 'granted' },
      { scope: 'secret-notes', permission: 'write', status: 'not-requestable', reason: 'ABSOLUTE_ISOLATION' },
    ],
    outcome: 'allowed-once',
  }, (scope) => scope)
  assert.match(text, /handbook：只读 → 已授予（本会话）/)
  assert.match(text, /secret-notes：写入 \/ 删除 → 不可申请（绝对限制）/)
})

test('memory_save 把 scopeDescription / scopeRule 传给 provider', async () => {
  let captured: Record<string, unknown> | undefined
  const saveTool = memorySaveTool({
    getService: () => ({
      save: async (input: unknown) => {
        captured = input as Record<string, unknown>
        return { id: 'abc', scope: 'handbook' }
      },
      search: async () => [],
      forget: async () => ({ removed: 0, ids: [] }),
      list: async () => [],
      visibilityPolicy: () => ({ level: 'none', scopes: [], source: 'explicit' }),
    }),
  })
  await saveTool.execute({
    content: '本作用域用于测试',
    scope: 'handbook',
    scopeDescription: '测试用作用域',
    scopeRule: '只记录与测试有关的内容',
  } as never)
  assert.equal(captured?.scopeDescription, '测试用作用域')
  assert.equal(captured?.scopeRule, '只记录与测试有关的内容')
})
