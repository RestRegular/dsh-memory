import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { memoryForgetTool, memoryGetTool, memoryListTool, memorySaveTool, memorySearchTool } from '../../tool-memory/src/index.ts'

const DIR = mkdtempSync(join(tmpdir(), 'dsh-memory-visibility-'))
const PROJECT = 'project:test-workspace'
/** 会话 cwd 解析出的项目键(provider 会把路径规范成反斜杠)。 */
const CWD_PROJECT = 'project:D:\\w'

let svc: LocalMemoryService

beforeEach(() => {
  svc = new LocalMemoryService({ storeDir: DIR, scopes: { global: true, project: true } })
  svc.setDefaultScope('project')
  svc.setProjectScope(PROJECT)
})

after(() => {
  svc.flushSync()
  rmSync(DIR, { recursive: true, force: true })
})

const agent = (header: Record<string, unknown>) => ({ session: { header } })

/**
 * 0.22.0 起「普通限制」下 memory_* 必须带 description。这组用例只考察可见域
 * 的解析与审批结论,统一由包装器补一条说明;description 的强制行为本身在
 * tool-memory/test/tools.test.ts 里单独覆盖。
 */
function described(tool) {
  const run = tool.execute.bind(tool)
  tool.execute = (args, exec) => run({ description: '测试调用：可见域断言', ...args }, exec)
  return tool
}

test('默认没有覆盖:resolveReadScopes 仍是会话 + 项目 + global', () => {
  assert.equal(svc.visibleScopes(agent({ id: 's1', cwd: 'D:/w' })), undefined)
  assert.deepEqual(svc.sessionVisibility('s1'), null)
  assert.deepEqual(
    svc.resolveReadScopes(agent({ id: 's1', cwd: 'D:/w' })),
    ['session:s1', CWD_PROJECT, 'global'],
  )
})

test('设置后只返回覆盖集合;恢复默认后回到三路集合', () => {
  svc.setSessionVisibility('s1', ['project:D:/w', 'global'])
  assert.deepEqual(svc.sessionVisibility('s1'), {
    scopes: [{ scope: CWD_PROJECT }, { scope: 'global' }],
    level: 'absolute',
  })
  assert.deepEqual(
    svc.resolveReadScopes(agent({ id: 's1', cwd: 'D:/w' })),
    [CWD_PROJECT, 'global'],
  )
  assert.deepEqual(svc.setSessionVisibility('s1', null), null)
  assert.deepEqual(svc.sessionVisibility('s1'), null)
  assert.deepEqual(
    svc.resolveReadScopes(agent({ id: 's1', cwd: 'D:/w' })),
    ['session:s1', CWD_PROJECT, 'global'],
  )
})

test('空选择与相对 scope 被拒绝', () => {
  assert.throws(
    () => svc.setSessionVisibility('s1', []),
    (error: Error & { code?: string }) => error.code === 'SCOPE_EMPTY',
  )
  assert.throws(
    () => svc.setSessionVisibility('s1', ['project', 'all']),
    (error: Error & { code?: string }) => error.code === 'SCOPE_INVALID',
  )
})

test('子 Agent 沿 parentSession 链继承根会话的可见范围', () => {
  const headers = new Map<string, Record<string, unknown>>([
    ['root', { id: 'root' }],
    ['child', { id: 'child', origin: 'subagent', parentSession: 'root' }],
    ['grand', { id: 'grand', origin: 'subagent', parentSession: 'child' }],
  ])
  svc.setSessionLookup((id) => {
    const header = headers.get(id)
    return header === undefined ? undefined : { header }
  })
  svc.setSessionVisibility('root', ['project:test-workspace', 'global'])

  assert.deepEqual(
    svc.visibleScopes(agent({ id: 'child', origin: 'subagent', parentSession: 'root' })),
    [PROJECT, 'global'],
    '子 Agent 的 session scope 映射到父会话',
  )
  assert.deepEqual(
    svc.visibleScopes(agent({ id: 'grand', origin: 'subagent', parentSession: 'child' })),
    [PROJECT, 'global'],
    '孙 Agent 沿链继续找到根会话',
  )
})

test('被 scope 开关禁用的项会被剔除;全被禁用时返回空集合', () => {
  const gated = new LocalMemoryService({ storeDir: DIR, scopes: { project: false, global: false } })
  gated.setSessionVisibility('s1', [CWD_PROJECT, 'global', 'session:s1'])
  assert.deepEqual(gated.resolveReadScopes(agent({ id: 's1', cwd: 'D:/w' })), ['session:s1'])
  gated.setSessionVisibility('s1', [CWD_PROJECT, 'global'])
  assert.deepEqual(gated.visibleScopes(agent({ id: 's1', cwd: 'D:/w' })), [])
  gated.flushSync()
})

test('覆盖会落盘,另一个 provider 实例能读到', () => {
  svc.setSessionVisibility('persisted', ['global'])
  const other = new LocalMemoryService({ storeDir: DIR })
  assert.deepEqual(other.sessionVisibility('persisted'), { scopes: [{ scope: 'global' }], level: 'absolute' })
  other.flushSync()
})

test('0.19.1 起记忆类型不再细化:提交的 kinds 被忽略,同 scope 的所有类型都可读', async () => {
  await svc.save({ scope: 'global', kind: 'rule', content: '全局规则 alpha' })
  await svc.save({ scope: 'global', kind: 'fact', content: '全局事实 alpha' })
  svc.setSessionVisibility('s1', { scopes: [{ scope: 'global', kinds: ['rule'] }], level: 'absolute' })
  assert.deepEqual(svc.sessionVisibility('s1'), { scopes: [{ scope: 'global' }], level: 'absolute' }, 'kinds 不落盘')
  const agentCtx = { agent: agent({ id: 's1', cwd: 'D:/w' }) }
  const search = described(memorySearchTool({ getService: () => svc }))
  const result = await search.execute({ query: 'alpha' }, agentCtx)
  assert.deepEqual(result.records.map((r) => r.kind).sort(), ['fact', 'rule'])
  const get = described(memoryGetTool({ getService: () => svc }))
  const facts = await svc.list({ scope: 'global', kind: 'fact' })
  const got = await get.execute({ ids: [facts[0]!.id] }, agentCtx)
  assert.equal(got.records.length, 1, '同 scope 的事实仍可读')
})

test('普通限制:范围外命中默认只给索引;requestApproval=true 才审批', async () => {
  await svc.save({ scope: 'global', kind: 'fact', content: '全局发布流程 beta' })
  await svc.save({ scope: PROJECT, kind: 'fact', content: '项目发布流程 beta' })
  svc.setSessionVisibility('s1', { scopes: [{ scope: PROJECT }], level: 'normal' })
  const agentCtx = { agent: agent({ id: 's1', cwd: 'D:/w' }) }
  const search = described(memorySearchTool({ getService: () => svc }))

  const calls: unknown[] = []
  svc.requestOutOfScope = async (_agent, input) => {
    calls.push(input)
    return 'allowed-once'
  }
  // 0.27.0:默认不发审批,global 命中以索引给出(withheld=out-of-scope)。
  const indexed = await search.execute({ query: 'beta' }, agentCtx)
  assert.deepEqual([...new Set(indexed.records.map((r) => r.scope))].sort(), [PROJECT].sort())
  assert.deepEqual(indexed.outOfScope?.scopes, [{ scope: 'global', records: 1 }])
  assert.equal(indexed.withheld?.reason, 'out-of-scope')
  assert.equal(calls.length, 0)

  // 显式要求审批:允许后 global 并入 records(0.26 及以前的行为)。
  const allowed = await search.execute({ query: 'beta', requestApproval: true }, agentCtx)
  assert.deepEqual([...new Set(allowed.records.map((r) => r.scope))].sort(), ['global', PROJECT].sort())
  assert.equal(calls.length, 1)
  assert.equal((calls[0] as { tool: string }).tool, 'memory_search')
  assert.equal((calls[0] as { query: string }).query, 'beta')
  assert.equal(allowed.withheld, undefined)

  svc.requestOutOfScope = async () => 'rejected'
  const denied = await search.execute({ query: 'beta', requestApproval: true }, agentCtx)
  assert.deepEqual([...new Set(denied.records.map((r) => r.scope))], [PROJECT])
  assert.equal(denied.withheld?.reason, 'rejected')
  assert.ok((denied.withheld?.count ?? 0) >= 1)
  assert.deepEqual(denied.outOfScope?.scopes, [{ scope: 'global', records: 1 }], '被拒的命中仍以索引给出')
})

test('无限制:不做范围过滤,也不发起审批', async () => {
  await svc.save({ scope: 'global', kind: 'fact', content: '全局发布流程 gamma' })
  await svc.save({ scope: PROJECT, kind: 'fact', content: '项目发布流程 gamma' })
  svc.setSessionVisibility('s1', { scopes: [{ scope: PROJECT }], level: 'none' })
  const agentCtx = { agent: agent({ id: 's1', cwd: 'D:/w' }) }
  let asked = 0
  svc.requestOutOfScope = async () => { asked++; return 'rejected' }
  const search = described(memorySearchTool({ getService: () => svc }))
  const result = await search.execute({ query: 'gamma', scope: 'all' }, agentCtx)
  assert.deepEqual([...new Set(result.records.map((r) => r.scope))].sort(), ['global', PROJECT].sort())
  assert.equal(asked, 0)
})

test('可见域变更通知:下一次 take 拿到配置,再取为空', () => {
  const agentCtx = agent({ id: 's1', cwd: 'D:/w' })
  assert.equal(svc.takeVisibilityNotice(agentCtx), undefined)
  svc.setSessionVisibility('s1', { scopes: [{ scope: 'global', kinds: ['rule'] }], level: 'normal' })
  assert.deepEqual(svc.takeVisibilityNotice(agentCtx), {
    config: { scopes: [{ scope: 'global' }], level: 'normal' },
  })
  assert.equal(svc.takeVisibilityNotice(agentCtx), undefined)
})

test('工具层把可见范围当白名单:显式 scope 视为不存在、memory_get 过滤、all 收窄', async () => {
  await svc.save({ scope: 'global', kind: 'fact', content: '全局秘密' })
  await svc.save({ scope: PROJECT, kind: 'fact', content: '项目结论' })
  svc.setSessionVisibility('s1', [PROJECT])
  const agentCtx = { agent: agent({ id: 's1', cwd: 'D:/w' }) }

  const search = described(memorySearchTool({ getService: () => svc }))
  const result = await search.execute({ query: '秘密 结论' }, agentCtx)
  assert.deepEqual(result.records.map((r) => r.scope), [PROJECT], '只搜可见范围')

  // 0.23.0:绝对限制下也告诉 Agent 真实原因(不再假装"那里没有记忆")。
  const outsideScope = await search.execute({ query: '秘密', scope: 'global' }, agentCtx)
  assert.deepEqual(outsideScope.records, [])
  assert.equal(outsideScope.withheld?.reason, 'absolute', '绝对限制:命中被挡住时说明原因')

  const all = await search.execute({ query: '秘密 结论', scope: 'all' }, agentCtx)
  assert.deepEqual(all.records.map((r) => r.scope), [PROJECT], "'all' 只等于所有可见范围")
  assert.equal(all.withheld?.reason, 'absolute')

  const list = described(memoryListTool({ getService: () => svc }))
  const listed = await list.execute({ scope: 'all' }, agentCtx)
  assert.deepEqual([...new Set(listed.records.map((r) => r.scope))], [PROJECT])

  const get = described(memoryGetTool({ getService: () => svc }))
  const globalRecord = (await svc.list({ scope: 'global' }))[0]!
  const got = await get.execute({ ids: [globalRecord.id] }, agentCtx)
  assert.equal(got.records.length, 0, 'memory_get 不能读可见范围之外的正文')
  assert.deepEqual(got.missing, [], '被挡住 ≠ 不存在:不再进 missing')
  assert.equal(got.withheld?.reason, 'absolute')
  assert.equal(got.withheld?.count, 1)

  // 不设置覆盖时回到默认策略(会话 + 项目 + global,普通限制),global 仍在范围内。
  svc.setSessionVisibility('s1', null)
  const legacyGet = await get.execute({ ids: [globalRecord.id] }, agentCtx)
  assert.equal(legacyGet.records.length, 1)
})

test('新会话默认可见域:会话 + 项目 + global,普通限制;范围外命中真实原因', async () => {
  await svc.save({ scope: 'global', kind: 'fact', content: '默认策略全局 alpha' })
  await svc.save({ scope: 'other-project', kind: 'fact', content: '默认策略别处 alpha' })
  const agentCtx = { agent: agent({ id: 's1', cwd: 'D:/w' }) }

  // 0.20.0:没有显式覆盖时不再是"无限制",而是默认策略。
  const policy = svc.visibilityPolicy(agent({ id: 's1', cwd: 'D:/w' }))
  assert.equal(policy.source, 'default')
  assert.equal(policy.level, 'normal')
  assert.deepEqual(policy.scopes.map((rule) => rule.scope), ['session:s1', CWD_PROJECT, 'global'])
  assert.deepEqual(
    svc.visibleScopes(agent({ id: 's1', cwd: 'D:/w' })),
    undefined,
    'visibleScopes 仍只代表"显式覆盖",默认策略不算',
  )

  const search = described(memorySearchTool({ getService: () => svc }))
  let asked = 0
  svc.requestOutOfScope = async () => { asked += 1; return 'rejected' }
  // 默认策略下的普通检索只搜默认三路:不会每次都弹审批。
  const plain = await search.execute({ query: '默认策略' }, agentCtx)
  assert.deepEqual(plain.records.map((r) => r.scope), ['global'])
  assert.equal(asked, 0, '默认检索不主动搜范围外')

  // 显式 all 会碰到范围外:默认只给索引,不发审批。
  const denied = await search.execute({ query: '默认策略', scope: 'all' }, agentCtx)
  assert.deepEqual(denied.records.map((r) => r.scope), ['global'])
  assert.equal(asked, 0, '0.27.0 起范围外命中默认不弹审批')
  assert.deepEqual(denied.withheld, { count: 1, reason: 'out-of-scope' })
  assert.deepEqual(denied.outOfScope?.scopes, [{ scope: 'other-project', records: 1 }])

  // requestApproval=true → 拒绝时把真实原因告诉模型。
  const rejected = await search.execute({ query: '默认策略', scope: 'all', requestApproval: true }, agentCtx)
  assert.deepEqual(rejected.records.map((r) => r.scope), ['global'])
  assert.equal(asked, 1)
  assert.equal(rejected.withheld?.reason, 'rejected')
  assert.ok((rejected.withheld?.count ?? 0) >= 1)

  // 允许一次 → 范围外记录也返回。
  svc.requestOutOfScope = async () => 'allowed-once'
  const allowed = await search.execute({ query: '默认策略', scope: 'all', requestApproval: true }, agentCtx)
  assert.deepEqual(
    [...new Set(allowed.records.map((r) => r.scope))].sort(),
    ['global', 'other-project'].sort(),
  )

  // memory_get 默认走审批;超时按"超时未答复"而不是"用户拒绝"。
  svc.requestOutOfScope = async () => 'timeout'
  const elsewhere = (await svc.list({ scope: 'other-project', kind: 'fact' })).find((r) => r.content === '默认策略别处 alpha')!
  const get = described(memoryGetTool({ getService: () => svc }))
  const got = await get.execute({ ids: [elsewhere.id] }, agentCtx)
  assert.equal(got.records.length, 0)
  assert.deepEqual(got.missing, [], '被审批挡住 ≠ 不存在')
  assert.equal(got.withheld?.reason, 'timeout')
})

test('写入护栏:绝对限制下范围外写入/删除被拒绝并说明原因', async () => {
  svc.setSessionVisibility('s1', { scopes: [{ scope: PROJECT }], level: 'absolute' })
  const agentCtx = { agent: agent({ id: 's1', cwd: 'D:/w' }) }
  const save = described(memorySaveTool({ getService: () => svc }))

  await assert.rejects(
    () => save.execute({ scope: 'global', content: '绝对限制不该写进去' }, agentCtx),
    (error: Error & { code?: string }) => error.code === 'VISIBILITY_ABSOLUTE' && /绝对限制/.test(error.message),
    '范围外写入报绝对限制,并告诉 Agent 怎么调整',
  )
  assert.equal(
    (await svc.list({ scope: 'global', kind: 'fact' })).some((r) => r.content === '绝对限制不该写进去'),
    false,
  )
  const ok = await save.execute({ scope: PROJECT, kind: 'fact', content: '绝对限制写进项目' }, agentCtx)
  assert.equal(ok.scope, PROJECT)

  const forget = described(memoryForgetTool({ getService: () => svc }))
  const record = (await svc.list({ scope: 'global', kind: 'fact' })).find((r) => r.content === '绝对限制不该写进去')
  await svc.save({ scope: 'global', kind: 'fact', content: '绝对限制全局秘密' })
  const secret = (await svc.list({ scope: 'global', kind: 'fact' })).find((r) => r.content === '绝对限制全局秘密')!
  assert.equal(record, undefined)
  await assert.rejects(
    () => forget.execute({ id: secret.id }, agentCtx),
    (error: Error & { code?: string }) => error.code === 'VISIBILITY_ABSOLUTE' && /绝对限制/.test(error.message),
    '范围外的 id 明确告知是绝对限制',
  )
  assert.ok(
    (await svc.list({ scope: 'global', kind: 'fact' })).some((r) => r.id === secret.id),
    '范围外记录不能被删掉',
  )
  await assert.rejects(
    () => forget.execute({ query: '绝对限制全局秘密', scope: 'global' }, agentCtx),
    (error: Error & { code?: string }) => error.code === 'VISIBILITY_ABSOLUTE' && /绝对限制/.test(error.message),
    '范围外按 query 删除也说明原因',
  )
  assert.ok(
    (await svc.list({ scope: 'global', kind: 'fact' })).some((r) => r.id === secret.id),
    '记录仍然在',
  )
})

test('写入护栏:普通限制下范围外写入/删除先审批,拒绝与超时都讲真实原因', async () => {
  svc.setSessionVisibility('s1', { scopes: [{ scope: PROJECT }], level: 'normal' })
  const agentCtx = { agent: agent({ id: 's1', cwd: 'D:/w' }) }
  const save = described(memorySaveTool({ getService: () => svc }))
  const calls: Array<{ tool: string; action?: string; query: string }> = []
  svc.requestOutOfScope = async (_agent, input) => {
    calls.push({ tool: input.tool, action: input.action, query: input.query })
    return 'rejected'
  }
  await assert.rejects(
    () => save.execute({ scope: 'global', kind: 'fact', content: '普通限制被拒写入' }, agentCtx),
    (error: Error & { code?: string }) => error.code === 'VISIBILITY_REJECTED' && /用户拒绝/.test(error.message),
  )
  assert.equal(calls[0]?.tool, 'memory_save')
  assert.equal(calls[0]?.action, 'write')
  assert.equal(
    (await svc.list({ scope: 'global', kind: 'fact' })).some((r) => r.content === '普通限制被拒写入'),
    false,
  )

  svc.requestOutOfScope = async () => 'timeout'
  await assert.rejects(
    () => save.execute({ scope: 'global', kind: 'fact', content: '普通限制超时写入' }, agentCtx),
    (error: Error & { code?: string }) => error.code === 'VISIBILITY_TIMEOUT' && /超时/.test(error.message),
  )

  svc.requestOutOfScope = async () => 'allowed-once'
  const saved = await save.execute({ scope: 'global', kind: 'fact', content: '普通限制批准写入' }, agentCtx)
  assert.equal(saved.scope, 'global')
  const record = (await svc.list({ scope: 'global', kind: 'fact' })).find((r) => r.content === '普通限制批准写入')!
  assert.ok(record)

  const forget = described(memoryForgetTool({ getService: () => svc }))
  svc.requestOutOfScope = async (_agent, input) => {
    calls.push({ tool: input.tool, action: input.action, query: input.query })
    return 'rejected'
  }
  await assert.rejects(
    () => forget.execute({ id: record.id }, agentCtx),
    (error: Error & { code?: string }) => error.code === 'VISIBILITY_REJECTED' && /用户拒绝/.test(error.message),
  )
  assert.equal(calls[calls.length - 1]?.action, 'delete')
  assert.ok(
    (await svc.list({ scope: 'global', kind: 'fact' })).some((r) => r.id === record.id),
    '拒绝后记录还在',
  )

  svc.requestOutOfScope = async () => 'allowed-once'
  const removed = await forget.execute({ id: record.id }, agentCtx)
  assert.equal(removed.removed, 1)
})

test('provider 层也守写入:有 agent 时范围外 save 拒绝;面板写入(无 agent)不受影响', async () => {
  const agentCtx = agent({ id: 's1', cwd: 'D:/w' })
  svc.setSessionVisibility('s1', { scopes: [{ scope: PROJECT }], level: 'absolute' })
  await assert.rejects(
    () => svc.save({ scope: 'global', kind: 'fact', content: 'provider 绝对拒绝', agent: agentCtx } as never),
    (error: Error & { code?: string }) => error.code === 'SCOPE_NOT_WRITABLE',
  )
  // 面板是用户本人操作:不带 agent,照常可写。
  const panel = await svc.save({ scope: 'global', kind: 'fact', content: 'provider 面板写入' })
  assert.equal(panel.scope, 'global')

  svc.setSessionVisibility('s1', { scopes: [{ scope: PROJECT }], level: 'normal' })
  await assert.rejects(
    () => svc.save({ scope: 'global', kind: 'fact', content: 'provider 未审批', agent: agentCtx } as never),
    (error: Error & { code?: string }) => error.code === 'VISIBILITY_APPROVAL_REQUIRED',
  )
  const approved = await svc.save({
    scope: 'global',
    kind: 'fact',
    content: 'provider 审批后写入',
    agent: agentCtx,
    visibilityApproved: true,
  } as never)
  assert.equal(approved.scope, 'global')
})

test('0.23 可读开关:read:false 的作用域不参与读取,memory_get 说明不可读', async () => {
  await svc.save({ scope: 'global', kind: 'fact', content: '不可读开关 全局正文' })
  await svc.save({ scope: PROJECT, kind: 'fact', content: '可读开关 项目正文' })
  svc.setSessionVisibility('s1', {
    scopes: [{ scope: PROJECT }, { scope: 'global', read: false }],
    level: 'normal',
  })
  const agentCtx = { agent: agent({ id: 's1', cwd: 'D:/w' }) }
  assert.equal(svc.isScopeReadable(agentCtx.agent, 'global'), false)
  assert.equal(svc.isScopeWritable(agentCtx.agent, 'global'), true, '不可读不等于不可写')
  assert.deepEqual(svc.resolveReadScopes(agentCtx.agent), [PROJECT], '读取集合跳过 read:false')

  let asked = 0
  svc.requestOutOfScope = async () => { asked += 1; return 'allowed-once' }
  const search = described(memorySearchTool({ getService: () => svc }))
  const res = await search.execute({ query: '开关' }, agentCtx)
  assert.deepEqual(res.records.map((record) => record.scope), [PROJECT])
  assert.equal(res.withheld?.reason, 'read-disabled', '命中不可读作用域时说明原因')
  assert.equal(asked, 0, 'read:false 不发起审批')

  const get = described(memoryGetTool({ getService: () => svc }))
  const globalRecord = (await svc.list({ scope: 'global' }))[0]!
  const got = await get.execute({ ids: [globalRecord.id] }, agentCtx)
  assert.equal(got.records.length, 0)
  assert.deepEqual(got.missing, [], '不可读 ≠ 不存在')
  assert.equal(got.withheld?.reason, 'read-disabled')
})

test('0.23 可写开关:write:false 的作用域可读,但写入/删除被拒绝并说明原因', async () => {
  await svc.save({ scope: 'global', kind: 'fact', content: '只读作用域 全局正文' })
  svc.setSessionVisibility('s1', {
    scopes: [{ scope: PROJECT }, { scope: 'global', write: false }],
    level: 'normal',
  })
  const agentCtx = { agent: agent({ id: 's1', cwd: 'D:/w' }) }
  assert.equal(svc.isScopeReadable(agentCtx.agent, 'global'), true)
  assert.equal(svc.isScopeWritable(agentCtx.agent, 'global'), false)

  const search = described(memorySearchTool({ getService: () => svc }))
  const res = await search.execute({ query: '只读作用域', scope: 'global' }, agentCtx)
  assert.deepEqual(res.records.map((record) => record.scope), ['global'], '可读仍然能读')

  const save = described(memorySaveTool({ getService: () => svc }))
  await assert.rejects(
    () => save.execute({ scope: 'global', kind: 'fact', content: '只读作用域 不该写' }, agentCtx),
    (error: Error & { code?: string }) => error.code === 'SCOPE_READ_ONLY' && /不可写/.test(error.message),
  )
  const record = (await svc.list({ scope: 'global', kind: 'fact' }))[0]!
  const forget = described(memoryForgetTool({ getService: () => svc }))
  await assert.rejects(
    () => forget.execute({ id: record.id }, agentCtx),
    (error: Error & { code?: string }) => error.code === 'SCOPE_READ_ONLY' && /不可写/.test(error.message),
  )
  assert.ok((await svc.list({ scope: 'global', kind: 'fact' })).some((item) => item.id === record.id))
})

test('0.23 工作区绑定:默认可见范围包含绑定作用域,新会话继承并持久化', async () => {
  await svc.save({ scope: 'handbook', kind: 'fact', content: '绑定作用域 手册正文' })
  const a = agent({ id: 's1', cwd: 'D:/w' })
  assert.deepEqual(svc.workspaceBindings(a), [])
  assert.deepEqual(svc.setWorkspaceBindings(a, ['global', 'handbook']), ['global', 'handbook'])
  assert.deepEqual(svc.workspaceBindings(a), ['global', 'handbook'])
  // 0.25.13：绑定是工作区级设置，当前会话读什么并没有变 —— 不排「记忆权限已更新」提示。
  assert.equal(svc.takeVisibilityNotice(a), undefined, '绑定变化不往上下文注入权限提示')
  assert.deepEqual(svc.defaultScopes(a), ['session:s1', CWD_PROJECT, 'global'], '默认基础范围不包含额外绑定')

  assert.deepEqual(
    svc.resolveReadScopes(agent({ id: 's2', cwd: 'D:/w' })),
    ['session:s2', CWD_PROJECT, 'global', 'handbook'],
    '同一工作区的新会话默认看到绑定作用域',
  )
  assert.deepEqual(
    svc.visibilityPolicy(agent({ id: 's2', cwd: 'D:/w' })).scopes.map((rule) => rule.scope),
    ['session:s2', CWD_PROJECT, 'global', 'handbook'],
  )
  assert.deepEqual(
    svc.resolveReadScopes(agent({ id: 's3', cwd: 'D:/other' })),
    ['session:s3', 'project:D:\\other', 'global'],
    '别的工作区不受影响',
  )

  const other = new LocalMemoryService({ storeDir: DIR, scopes: { global: true, project: true } })
  assert.deepEqual(other.workspaceBindings(agent({ id: 's9', cwd: 'D:/w' })), ['global', 'handbook'], '绑定落盘')
  other.flushSync()

  assert.throws(
    () => svc.setWorkspaceBindings(a, ['session:s1']),
    (error: Error & { code?: string }) => error.code === 'SCOPE_INVALID',
    '会话作用域不能绑定到工作区',
  )
})
