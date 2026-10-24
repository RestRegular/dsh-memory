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

test('普通限制:范围外命中会发起一次审批;允许后返回、拒绝后隐藏', async () => {
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
  const allowed = await search.execute({ query: 'beta' }, agentCtx)
  assert.deepEqual([...new Set(allowed.records.map((r) => r.scope))].sort(), ['global', PROJECT].sort())
  assert.equal(calls.length, 1)
  assert.equal((calls[0] as { tool: string }).tool, 'memory_search')
  assert.equal((calls[0] as { query: string }).query, 'beta')
  assert.equal(allowed.withheld, undefined)

  svc.requestOutOfScope = async () => 'rejected'
  const denied = await search.execute({ query: 'beta' }, agentCtx)
  assert.deepEqual([...new Set(denied.records.map((r) => r.scope))], [PROJECT])
  assert.equal(denied.withheld?.reason, 'rejected')
  assert.ok((denied.withheld?.count ?? 0) >= 1)
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

  // 0.20.0:绝对限制下显式问范围外的 scope 不再报错暴露可见域,而是当作那里没有记忆。
  const outsideScope = await search.execute({ query: '秘密', scope: 'global' }, agentCtx)
  assert.deepEqual(outsideScope.records, [])
  assert.equal(outsideScope.withheld, undefined, '绝对限制不告诉模型"被挡住"')

  const all = await search.execute({ query: '秘密 结论', scope: 'all' }, agentCtx)
  assert.deepEqual(all.records.map((r) => r.scope), [PROJECT], "'all' 只等于所有可见范围")

  const list = described(memoryListTool({ getService: () => svc }))
  const listed = await list.execute({ scope: 'all' }, agentCtx)
  assert.deepEqual([...new Set(listed.records.map((r) => r.scope))], [PROJECT])

  const get = described(memoryGetTool({ getService: () => svc }))
  const globalRecord = (await svc.list({ scope: 'global' }))[0]!
  const got = await get.execute({ ids: [globalRecord.id] }, agentCtx)
  assert.equal(got.records.length, 0, 'memory_get 不能读可见范围之外的正文')
  assert.deepEqual(got.missing, [globalRecord.id])
  assert.equal(got.withheld, undefined, '绝对限制:被挡住也按不存在处理')

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

  // 显式 all 才会碰到范围外;拒绝时把真实原因告诉模型。
  const denied = await search.execute({ query: '默认策略', scope: 'all' }, agentCtx)
  assert.deepEqual(denied.records.map((r) => r.scope), ['global'])
  assert.equal(asked, 1)
  assert.equal(denied.withheld?.reason, 'rejected')
  assert.ok((denied.withheld?.count ?? 0) >= 1)

  // 允许一次 → 范围外记录也返回。
  svc.requestOutOfScope = async () => 'allowed-once'
  const allowed = await search.execute({ query: '默认策略', scope: 'all' }, agentCtx)
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
  assert.deepEqual(got.missing, [elsewhere.id])
  assert.equal(got.withheld?.reason, 'timeout')
})

test('写入护栏:绝对限制下范围外写入/删除按不存在处理', async () => {
  svc.setSessionVisibility('s1', { scopes: [{ scope: PROJECT }], level: 'absolute' })
  const agentCtx = { agent: agent({ id: 's1', cwd: 'D:/w' }) }
  const save = described(memorySaveTool({ getService: () => svc }))

  await assert.rejects(
    () => save.execute({ scope: 'global', content: '绝对限制不该写进去' }, agentCtx),
    (error: Error & { code?: string }) => error.code === 'SCOPE_NOT_WRITABLE' && !/可见/.test(error.message),
    '范围外写入报"不存在或不可写",不暴露可见域',
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
    (error: Error & { code?: string }) => error.code === 'RECORD_NOT_FOUND',
    '范围外的 id 当作不存在',
  )
  assert.ok(
    (await svc.list({ scope: 'global', kind: 'fact' })).some((r) => r.id === secret.id),
    '范围外记录不能被删掉',
  )
  const byQuery = await forget.execute({ query: '绝对限制全局秘密', scope: 'global' }, agentCtx)
  assert.deepEqual(byQuery, { removed: 0, ids: [] }, '范围外按 query 删除静默无匹配')
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
