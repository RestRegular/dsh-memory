import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { memoryGetTool, memoryListTool, memorySearchTool } from '../../tool-memory/src/index.ts'

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
  assert.deepEqual(svc.sessionVisibility('s1'), ['project:D:/w', 'global'])
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
  assert.deepEqual(other.sessionVisibility('persisted'), ['global'])
  other.flushSync()
})

test('工具层把可见范围当白名单:显式 scope 被拒、memory_get 过滤、all 收窄', async () => {
  await svc.save({ scope: 'global', kind: 'fact', content: '全局秘密' })
  await svc.save({ scope: PROJECT, kind: 'fact', content: '项目结论' })
  svc.setSessionVisibility('s1', [PROJECT])
  const agentCtx = { agent: agent({ id: 's1', cwd: 'D:/w' }) }

  const search = memorySearchTool({ getService: () => svc })
  const result = await search.execute({ query: '秘密 结论' }, agentCtx)
  assert.deepEqual(result.records.map((r) => r.scope), [PROJECT], '只搜可见范围')

  await assert.rejects(
    () => search.execute({ query: '秘密', scope: 'global' }, agentCtx),
    (error: Error & { code?: string }) => error.code === 'SCOPE_NOT_VISIBLE',
    '显式 global 不在可见范围内',
  )

  const all = await search.execute({ query: '秘密 结论', scope: 'all' }, agentCtx)
  assert.deepEqual(all.records.map((r) => r.scope), [PROJECT], "'all' 只等于所有可见范围")

  const list = memoryListTool({ getService: () => svc })
  const listed = await list.execute({ scope: 'all' }, agentCtx)
  assert.deepEqual([...new Set(listed.records.map((r) => r.scope))], [PROJECT])

  const get = memoryGetTool({ getService: () => svc })
  const globalRecord = (await svc.list({ scope: 'global' }))[0]!
  const got = await get.execute({ ids: [globalRecord.id] }, agentCtx)
  assert.equal(got.records.length, 0, 'memory_get 不能读可见范围之外的正文')
  assert.deepEqual(got.missing, [globalRecord.id])

  // 不设置覆盖时保持原行为(显式 global + 按 id 取全文都可用)。
  svc.setSessionVisibility('s1', null)
  const legacyGet = await get.execute({ ids: [globalRecord.id] }, agentCtx)
  assert.equal(legacyGet.records.length, 1)
})
