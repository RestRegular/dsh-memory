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

test('memory_scopes request：默认只申请只读，写权限显式列出', async () => {
  const readOnly = await tool.execute({
    action: 'request',
    scopes: ['handbook'],
    reason: '需要团队约定',
    description: '申请 handbook',
  }, agentExec)
  assert.deepEqual(readOnly.results, [
    { scope: 'handbook', permission: 'read', status: 'granted' },
  ])

  const readWrite = await tool.execute({
    action: 'request',
    scopes: ['secret-notes'],
    permissions: ['read', 'write'],
    reason: '需要读写',
    description: '申请 secret-notes',
  }, agentExec)
  assert.deepEqual(readWrite.results, [
    { scope: 'secret-notes', permission: 'read', status: 'granted' },
    { scope: 'secret-notes', permission: 'write', status: 'granted' },
  ])
})

test('memory_scopes request：缺少 scopes / 超过 5 个 scope 明确拒绝', async () => {
  await assert.rejects(
    tool.execute({ action: 'request', description: '申请' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'REQUESTS_REQUIRED',
  )
  await assert.rejects(
    tool.execute({
      action: 'request',
      scopes: Array.from({ length: 6 }, (_, i) => `scope-${i}`),
      description: '批量申请',
    }, agentExec),
    (error: Error & { code?: string }) => error.code === 'REQUESTS_TOO_MANY',
  )
})

test('memory_scopes request：展示前缀 custom:<名字> 自动归一，重复写法合并', async () => {
  const result = await tool.execute({
    action: 'request',
    scopes: ['custom:handbook', 'handbook'],
    reason: '展示名直接粘进来',
    description: '验归一',
  }, agentExec)
  assert.deepEqual(result.results, [
    { scope: 'handbook', permission: 'read', status: 'granted' },
  ])
})

test('memory_scopes request：非法名字 / all 明确报错，不落幽灵授权', async () => {
  await assert.rejects(
    tool.execute({ action: 'request', scopes: ['foo:bar'], description: '非法名' }, agentExec),
    (error: Error & { code?: string; message?: string }) => error.code === 'SCOPE_INVALID'
      && /bare scope name/.test(error.message ?? ''),
  )
  await assert.rejects(
    tool.execute({ action: 'request', scopes: ['all'], description: '申请全部' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'SCOPE_NOT_WRITABLE',
  )
})

test('memory_scopes edit：更新用途 / 别名（都可省略、空串表示清空），别名字段不影响描述', async () => {
  const calls: Array<Record<string, unknown>> = []
  const editService = {
    ...service,
    // 无限制：编辑只看"能不能写"，这里不需要可见域判定。
    visibilityPolicy: () => ({ level: 'none' as const, scopes: [], source: 'explicit' as const }),
    describeScope: (scope: string, description: string, by: string) => {
      calls.push({ kind: 'describe', scope, description, by })
      return { scope, description }
    },
    renameScope: (scope: string, name?: string | null) => {
      calls.push({ kind: 'rename', scope, name })
      return { scope, ...(typeof name === 'string' && name !== '' ? { name } : {}) }
    },
  }
  const editTool = memoryScopesTool({ getService: () => editService })

  const both = await editTool.execute({
    action: 'edit',
    scope: 'global',
    scopeDescription: '所有项目共享的事实与偏好',
    scopeName: '共享',
    description: '更新 global 的用途与别名',
  }, agentExec)
  assert.deepEqual(both, { scope: 'global', description: '所有项目共享的事实与偏好', name: '共享' })
  assert.deepEqual(calls, [
    { kind: 'describe', scope: 'global', description: '所有项目共享的事实与偏好', by: 's1' },
    { kind: 'rename', scope: 'global', name: '共享' },
  ], '会话 id 作为 createdBy 传给 provider')
  const text = renderScopesResult(both, (scope) => scope)
  assert.match(text, /作用域已更新：global:共享（global）/)
  assert.match(text, /用途：所有项目共享的事实与偏好/)
  assert.match(text, /别名：共享/)

  // 只给用途：别名一点都不碰（不产生 rename 调用）。
  calls.length = 0
  const onlyDescription = await editTool.execute({
    action: 'edit', scope: 'global', scopeDescription: '只改用途', description: '只改用途',
  }, agentExec)
  assert.deepEqual(onlyDescription, { scope: 'global', description: '只改用途' })
  assert.deepEqual(calls.map((call) => call.kind), ['describe'])

  // 只给别名：空串 = 移除。
  calls.length = 0
  const onlyName = await editTool.execute({
    action: 'edit', scope: 'global', scopeName: '', description: '移除别名',
  }, agentExec)
  assert.deepEqual(onlyName, { scope: 'global', name: '' })
  assert.deepEqual(calls.map((call) => call.kind), ['rename'])
  assert.match(renderScopesResult(onlyName, (scope) => scope), /别名：已移除/)

  // 用途清空：空串原样交给 provider（由它写成空描述并回退默认描述）。
  calls.length = 0
  const cleared = await editTool.execute({
    action: 'edit', scope: 'global', scopeDescription: '', description: '清空用途',
  }, agentExec)
  assert.deepEqual(cleared, { scope: 'global', description: '' })
  assert.match(renderScopesResult(cleared, (scope) => scope), /用途：已清空/)

  // 两个字段都没给 / 没给 scope：明确报错，不写任何东西。
  await assert.rejects(
    () => editTool.execute({ action: 'edit', scope: 'global', description: '啥也没改' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'EDIT_NOTHING_TO_UPDATE',
  )
  await assert.rejects(
    () => editTool.execute({ action: 'edit', scopeDescription: 'x', description: '没给作用域' }, agentExec),
    (error: Error & { code?: string }) => error.code === 'SCOPE_REQUIRED',
  )
})

test('memory_scopes edit：范围外作用域要求先申请写权限，不写元数据、不弹审批', async () => {
  let writes = 0
  const editService = {
    ...service,
    // handbook 在范围外且可申请（普通限制）：编辑需要写权限，先走 action=request。
    accessEvaluator: () => (request: { scope: string }) => (request.scope === 'handbook'
      ? { allowed: false, reason: 'SCOPE_NOT_IN_RANGE', requestable: true }
      : { allowed: true, requestable: false }),
    describeScope: (scope: string, description: string) => {
      writes += 1
      return { scope, description }
    },
    renameScope: (scope: string, name?: string | null) => {
      writes += 1
      return { scope, ...(typeof name === 'string' && name !== '' ? { name } : {}) }
    },
  }
  const editTool = memoryScopesTool({ getService: () => editService })
  await assert.rejects(
    () => editTool.execute({ action: 'edit', scope: 'handbook', scopeDescription: '团队约定', description: '编辑 handbook' }, agentExec),
    (error: Error & { code?: string; message?: string }) => error.code === 'SCOPE_NOT_WRITABLE'
      && /action: "request"/.test(error.message ?? ''),
  )
  assert.equal(writes, 0, '没权限时一条元数据都不写')
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
