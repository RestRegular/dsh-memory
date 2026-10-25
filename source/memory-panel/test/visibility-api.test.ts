import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleRequest } from '../lib/index.js'
import { LocalMemoryService } from '../../memory-local/src/index.ts'

const ROUTE = '/memory/api'
const LOOPBACK = { host: '127.0.0.1:19387' }

function ctxWith(service, session) {
  const sessions = session === undefined ? undefined : { get: (id) => (id === session.id ? session : undefined) }
  return {
    get: (name) => (name === 'memory' ? service : name === 'sessions' ? sessions : undefined),
    logger: { warn() {} },
  }
}

function fakeRes() {
  const out = { status: null, body: null }
  return {
    out,
    writeHead(status) { out.status = status },
    end(text) { try { out.body = JSON.parse(text) } catch { out.body = text } },
  }
}

const get = (url) => ({ url, method: 'GET', headers: LOOPBACK })
const post = (url, body) => ({
  url,
  method: 'POST',
  headers: LOOPBACK,
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
})

function makeService(dir) {
  return new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
}

test('面板 /visibility:GET 返回自己的覆盖、生效策略与默认范围目录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-visibility-'))
  const svc = makeService(dir)
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  try {
    await svc.save({ scope: 'global', kind: 'rule', content: '全局规则' })
    const res = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, get(`${ROUTE}/visibility?session=s1`), res)
    assert.equal(res.out.status, 200)
    const value = res.out.body.value
    assert.equal(value.sessionId, 's1')
    assert.equal(value.override, null)
    assert.equal(value.inherited, false)
    assert.equal(value.source, 'default', '没有显式覆盖时来源是默认策略')
    assert.equal(value.effective?.level, 'normal', '默认限制等级是普通限制')
    assert.deepEqual(
      value.effective?.scopes.map((s) => s.scope),
      ['session:s1', 'project:D:\\w', 'global'],
      '默认可见域 = 会话 + 项目 + global',
    )
    const scopes = value.scopes.map((s) => s.scope)
    assert.deepEqual(scopes.slice(0, 3), ['session:s1', 'project:D:\\w', 'global'], '当前会话/项目/global 在最前')
    assert.deepEqual(value.defaults, ['session:s1', 'project:D:\\w', 'global'], '首次打开按默认集合预选')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /visibility:POST 写入范围 + 等级;0.19.1 忽略 kinds;空选择 400;恢复默认', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-visibility-'))
  const svc = makeService(dir)
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  try {
    const set = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/visibility`, {
      session: 's1',
      visibility: {
        scopes: [{ scope: 'session:s1' }, { scope: 'global', kinds: ['rule'] }],
        level: 'normal',
      },
    }), set)
    assert.equal(set.out.status, 200)
    const override = set.out.body.value.override
    assert.equal(override.level, 'normal')
    assert.deepEqual(override.scopes, [{ scope: 'session:s1' }, { scope: 'global' }], 'kinds 不再落盘')
    assert.equal(set.out.body.value.source, 'explicit')
    assert.deepEqual(set.out.body.value.effective?.scopes, override.scopes, '自己的覆盖就是生效策略')

    const empty = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/visibility`, { session: 's1', visibility: { scopes: [], level: 'normal' } }), empty)
    assert.equal(empty.out.status, 400)
    assert.equal(empty.out.body.error.code, 'SCOPE_EMPTY')

    const reset = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/visibility`, { session: 's1', visibility: null }), reset)
    assert.equal(reset.out.status, 200)
    assert.equal(reset.out.body.value.override, null)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /visibility:兼容 0.18 的 { scopes: string[] } 写法', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-visibility-'))
  const svc = makeService(dir)
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  try {
    const res = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/visibility`, { session: 's1', scopes: ['global'] }), res)
    assert.equal(res.out.status, 200)
    assert.deepEqual(res.out.body.value.override, { scopes: [{ scope: 'global' }], level: 'absolute' })
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /approvals:列待审批并回答一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-visibility-'))
  const svc = makeService(dir)
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  try {
    const agent = { session }
    const verdict = svc.requestOutOfScope(agent, {
      tool: 'memory_search',
      query: '发布流程',
      description: '查发布流程是否踩过坑',
      items: [{
        id: 'abc12345deadbeef',
        scope: 'global',
        kind: 'rule',
        content: '范围外规则正文',
        tags: ['release'],
        importance: 0.9,
        updatedAt: Date.now(),
        reason: 'scope',
      }],
    })

    const list = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, get(`${ROUTE}/approvals?session=s1`), list)
    assert.equal(list.out.status, 200)
    assert.equal(list.out.body.value.approvals.length, 1)
    assert.equal(list.out.body.value.approvals[0].query, '发布流程')
    assert.equal(list.out.body.value.approvals[0].description, '查发布流程是否踩过坑', '审批载荷带上工具调用的说明')
    assert.equal(list.out.body.value.approvals[0].items[0].content, '范围外规则正文')
    const id = list.out.body.value.approvals[0].id

    const answer = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/approvals`, { id, outcome: 'allowed-once' }), answer)
    assert.equal(answer.out.status, 200)
    assert.equal(answer.out.body.value.answered, true)
    assert.deepEqual(await verdict, { outcome: 'allowed-once' })

    const again = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/approvals`, { id, outcome: 'rejected' }), again)
    assert.equal(again.out.body.value.answered, false, '已经回答过的审批不能重复消费')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /approvals?summary=1:只回审批身份与会话,不带条目正文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-visibility-'))
  const svc = makeService(dir)
  const s1 = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  const s2 = { id: 's2', header: { id: 's2', cwd: 'D:/w' } }
  const item = (id: string, content: string) => ({
    id,
    scope: 'global',
    kind: 'rule',
    content,
    tags: ['release'],
    importance: 0.8,
    updatedAt: Date.now(),
    reason: 'scope' as const,
  })
  try {
    void svc.requestOutOfScope({ session: s1 }, {
      tool: 'memory_search',
      query: '发布流程',
      description: '查发布流程是否踩过坑',
      items: [item('aaaaaaaa1111', '范围外正文一')],
    })
    void svc.requestOutOfScope({ session: s2 }, {
      tool: 'memory_get',
      mode: 'grant',
      query: '需要团队约定',
      items: [item('bbbbbbbb2222', '范围外正文二')],
    })

    const all = fakeRes()
    await handleRequest(ctxWith(svc, s1), ROUTE, get(`${ROUTE}/approvals?summary=1`), all)
    assert.equal(all.out.status, 200)
    assert.equal(all.out.body.value.approvals.length, 2, '摘要覆盖所有会话')
    for (const approval of all.out.body.value.approvals) {
      assert.equal(typeof approval.id, 'string')
      assert.ok(approval.sessionId === 's1' || approval.sessionId === 's2')
      assert.equal(approval.items, undefined, '摘要不带条目正文')
      assert.equal(approval.query, undefined, '摘要不带查询语句')
      assert.equal(approval.description, undefined, '摘要不带用途说明')
    }
    const s1Only = fakeRes()
    await handleRequest(ctxWith(svc, s1), ROUTE, get(`${ROUTE}/approvals?summary=1&session=s1`), s1Only)
    assert.deepEqual(s1Only.out.body.value.approvals.map((a) => a.sessionId), ['s1'], '可按会话过滤')
    assert.equal(s1Only.out.body.value.approvals[0].mode, undefined, '普通条目审批不带 mode')

    const s2Only = fakeRes()
    await handleRequest(ctxWith(svc, s1), ROUTE, get(`${ROUTE}/approvals?summary=1&session=s2`), s2Only)
    assert.equal(s2Only.out.body.value.approvals[0].mode, 'grant', 'grant 审批保留 mode')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /approvals?summary=1:旧 provider 没有轻量方法时回退完整列表', async () => {
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  const memory = {
    store: {},
    pendingVisibilityApprovals: () => [{ id: 'a1', sessionId: 's1', tool: 'memory_search', action: 'read', query: 'q', items: [], createdAt: 1, expiresAt: 2 }],
  }
  const res = fakeRes()
  await handleRequest(ctxWith(memory, session), ROUTE, get(`${ROUTE}/approvals?summary=1`), res)
  assert.equal(res.out.status, 200)
  assert.equal(res.out.body.value.approvals.length, 1)
  assert.equal(res.out.body.value.approvals[0].id, 'a1')
})

test('面板 /approvals:allowedIds 逐条允许,只返回勾选的条目', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-visibility-'))
  const svc = makeService(dir)
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  const item = (id: string) => ({
    id,
    scope: 'global',
    kind: 'rule',
    content: `正文 ${id}`,
    tags: [],
    importance: 0.5,
    updatedAt: Date.now(),
    reason: 'scope' as const,
  })
  try {
    const agent = { session }
    const partial = svc.requestOutOfScope(agent, {
      tool: 'memory_search',
      query: '发布流程',
      items: [item('aaaaaaaa1111'), item('bbbbbbbb2222'), item('cccccccc3333')],
    })
    const list = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, get(`${ROUTE}/approvals?session=s1`), list)
    const id = list.out.body.value.approvals[0].id
    const res = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/approvals`, {
      id,
      outcome: 'allowed-once',
      allowedIds: ['aaaaaaaa1111', 'cccccccc3333', 'unknown-id'],
    }), res)
    assert.equal(res.out.status, 200)
    assert.deepEqual(await partial, { outcome: 'allowed-once', allowedIds: ['aaaaaaaa1111', 'cccccccc3333'] }, '只保留本次请求里存在的条目')

    // 全部勾选 = 老口径(不带 allowedIds,表示本次请求全部允许)。
    const all = svc.requestOutOfScope(agent, { tool: 'memory_search', query: 'q', items: [item('aaaaaaaa1111'), item('bbbbbbbb2222')] })
    await handleRequest(ctxWith(svc, session), ROUTE, get(`${ROUTE}/approvals?session=s1`), list)
    const allId = list.out.body.value.approvals[0].id
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/approvals`, {
      id: allId,
      outcome: 'allowed-once',
      allowedIds: ['aaaaaaaa1111', 'bbbbbbbb2222'],
    }), fakeRes())
    assert.deepEqual(await all, { outcome: 'allowed-once' })

    // 一条都没勾 = 拒绝。
    const none = svc.requestOutOfScope(agent, { tool: 'memory_search', query: 'q', items: [item('aaaaaaaa1111')] })
    await handleRequest(ctxWith(svc, session), ROUTE, get(`${ROUTE}/approvals?session=s1`), list)
    const noneId = list.out.body.value.approvals[0].id
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/approvals`, {
      id: noneId,
      outcome: 'allowed-once',
      allowedIds: [],
    }), fakeRes())
    assert.deepEqual(await none, { outcome: 'rejected' }, '空 allowedIds 按拒绝处理')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /visibility:没有 session 参数返回 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-visibility-'))
  const svc = makeService(dir)
  try {
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/visibility`), res)
    assert.equal(res.out.status, 400)
    assert.equal(res.out.body.error.code, 'SESSION_REQUIRED')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /visibility:read/write 状态与工作区绑定落盘,默认范围包含绑定作用域', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-visibility-'))
  const svc = makeService(dir)
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  try {
    await svc.save({ scope: 'handbook', kind: 'fact', content: '绑定作用域正文' })

    const set = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/visibility`, {
      session: 's1',
      visibility: {
        scopes: [{ scope: 'global', read: false }, { scope: 'project:D:\\w' }, { scope: 'handbook' }],
        level: 'normal',
      },
      bindings: ['handbook'],
    }), set)
    assert.equal(set.out.status, 200)
    const value = set.out.body.value
    assert.deepEqual(value.override.scopes, [
      { scope: 'global', read: false },
      { scope: 'project:D:\\w' },
      { scope: 'handbook' },
    ])
    assert.equal(value.workspace, 'project:D:\\w')
    assert.deepEqual(value.bindings, ['handbook'], '只存额外绑定,默认作用域不重复落盘')
    assert.deepEqual(value.defaultScopes, ['session:s1', 'project:D:\\w', 'global'], '默认基础范围')
    const globalItem = value.scopes.find((item) => item.scope === 'global')
    assert.equal(globalItem.read, false, '可读状态随目录返回')
    assert.equal(globalItem.write, true)
    assert.equal(globalItem.bound, true, '默认作用域显示为已绑定')
    assert.equal(globalItem.defaultBound, true, '默认作用域不可取消绑定')
    const handbookItem = value.scopes.find((item) => item.scope === 'handbook')
    assert.equal(handbookItem.bound, true, '额外绑定显示为已绑定')
    assert.equal(handbookItem.defaultBound, false)
    assert.equal(value.scopes.find((item) => item.scope === 'session:s1')?.bindable, false, '会话作用域不可绑定')

    // 恢复默认:绑定保留,默认范围额外并入 handbook。
    const reset = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/visibility`, {
      session: 's1',
      visibility: null,
      bindings: ['handbook'],
    }), reset)
    assert.equal(reset.out.status, 200)
    assert.equal(reset.out.body.value.override, null)
    assert.deepEqual(reset.out.body.value.defaults, ['session:s1', 'project:D:\\w', 'global', 'handbook'])
    assert.deepEqual(reset.out.body.value.bindings, ['handbook'])

    // 会话作用域不能绑定到工作区。
    const bad = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/visibility`, {
      session: 's1',
      visibility: null,
      bindings: ['session:s1'],
    }), bad)
    assert.equal(bad.out.status, 400)
    assert.equal(bad.out.body.error.code, 'SCOPE_INVALID')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /bindings:单独保存工作区绑定,不动会话可见范围,也不给会话注入权限提示', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-bindings-'))
  const svc = makeService(dir)
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  const agentLike = { session: { header: { id: 's1', cwd: 'D:/w' } } }
  try {
    await svc.save({ scope: 'handbook', kind: 'fact', content: '绑定作用域正文' })
    // 先给会话设一份显式覆盖：绑定不应该把它清掉（这是和 /visibility 的关键区别）。
    svc.setSessionVisibility('s1', { scopes: [{ scope: 'session:s1' }, { scope: 'global' }], level: 'normal' })
    // 把「设置可见范围」时排队的提示取走，避免误判。
    svc.takeVisibilityNotice(agentLike)

    const res = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/bindings`, {
      session: 's1',
      bindings: ['handbook', 'handbook'],
    }), res)
    assert.equal(res.out.status, 200)
    assert.deepEqual(res.out.body.value, { sessionId: 's1', bindings: ['handbook'] }, '重复项去重后返回落盘结果')
    assert.deepEqual(svc.workspaceBindings(agentLike), ['handbook'], '绑定立即落盘')
    assert.deepEqual(
      svc.sessionVisibility('s1')?.scopes.map((rule) => rule.scope),
      ['session:s1', 'global'],
      '单独保存绑定不改会话可见范围',
    )
    assert.equal(svc.takeVisibilityNotice(agentLike), undefined, '绑定变化不注入「记忆权限已更新」提示')

    // 空数组 = 解除全部绑定。
    const cleared = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/bindings`, { session: 's1', bindings: [] }), cleared)
    assert.equal(cleared.out.status, 200)
    assert.deepEqual(cleared.out.body.value.bindings, [])
    assert.deepEqual(svc.workspaceBindings(agentLike), [])

    // 会话作用域 / 别名 / 非数组都按 400 拒绝。
    for (const bad of [['session:s1'], ['all'], 'handbook']) {
      const rejected = fakeRes()
      await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/bindings`, { session: 's1', bindings: bad }), rejected)
      assert.equal(rejected.out.status, 400, `非法绑定必须 400: ${JSON.stringify(bad)}`)
      assert.equal(rejected.out.body.error.code, 'SCOPE_INVALID')
    }
    const noSession = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/bindings`, { bindings: ['handbook'] }), noSession)
    assert.equal(noSession.out.status, 400)
    assert.equal(noSession.out.body.error.code, 'SESSION_REQUIRED')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /update:编辑新建修正版,旧记录保留且指向关系正确', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-update-'))
  const svc = makeService(dir)
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  try {
    const old = await svc.save({ scope: 'global', kind: 'fact', content: '旧内容', tags: ['old'] })
    const res = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/update`, {
      id: old.id,
      content: '新内容',
      tags: ['new'],
      importance: 0.9,
    }), res)
    assert.equal(res.out.status, 200)
    const value = res.out.body.value
    assert.equal(value.superseded, old.id)
    assert.notEqual(value.record.id, old.id, '编辑生成新 id')
    assert.equal(value.record.content, '新内容')
    assert.equal(value.record.supersedes, old.id)
    assert.equal(value.record.supersededBy, null)

    const still = svc.getByIds([old.id])[0]!
    assert.equal(still.content, '旧内容', '旧记录内容不被原地修改')
    assert.equal(still.supersedes, undefined)

    const records = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, get(`${ROUTE}/records`), records)
    const oldWire = records.out.body.value.records.find((record) => record.id === old.id)
    assert.equal(oldWire.supersededBy, value.record.id, '旧记录标上被谁修正')
    const newWire = records.out.body.value.records.find((record) => record.id === value.record.id)
    assert.equal(newWire.supersedes, old.id)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /grants:GET 列出会话授权，POST 撤销并写入撤销通知', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-grants-'))
  const svc = makeService(dir)
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  try {
    const agent = { session: { header: { id: 's1', cwd: 'D:/w' } } }
    await svc.save({
      scope: 'handbook',
      kind: 'fact',
      content: '本作用域用于团队约定',
      scopeDescription: '团队约定与流程',
      agent,
      visibilityApproved: true,
    } as never)
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once' })
    const granted = await svc.requestScopeGrants(agent, {
      requests: [{ scope: 'handbook', permissions: ['read'] }],
      reason: '面板授权验收',
    })
    const grantId = granted.grants[0]!.id

    const list = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, get(`${ROUTE}/grants?session=s1`), list)
    assert.equal(list.out.status, 200)
    const value = list.out.body.value
    assert.equal(value.sessionId, 's1')
    assert.equal(value.grants.length, 1)
    assert.equal(value.grants[0].scope, 'handbook')
    assert.deepEqual(value.grants[0].permissions, ['read'])
    assert.equal(value.grants[0].inherited, false)
    assert.equal(value.grants[0].ownerSession, 's1')

    const revoke = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/grants`, { session: 's1', id: grantId }), revoke)
    assert.equal(revoke.out.status, 200)
    assert.equal(revoke.out.body.value.grants.length, 0)

    const notice = svc.takePermissionNotice(agent)
    assert.ok(notice?.changes.some((change) => change.event === 'revoked' && change.scope === 'handbook'))

    const missing = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/grants`, { session: 's1', id: grantId }), missing)
    assert.equal(missing.out.status, 404)

    const bad = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, get(`${ROUTE}/grants`), bad)
    assert.equal(bad.out.status, 400)
    assert.equal(bad.out.body.error.code, 'SESSION_REQUIRED')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /grants:子会话显示父会话授权的 inherited 标记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-grants-'))
  const svc = makeService(dir)
  const parent = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  const child = { id: 'child', header: { id: 'child', parentSession: 's1', cwd: 'D:/w', origin: 'subagent' } }
  try {
    const agent = { session: { header: { id: 's1', cwd: 'D:/w' } } }
    await svc.save({
      scope: 'handbook',
      kind: 'fact',
      content: '本作用域用于团队约定',
      scopeDescription: '团队约定与流程',
      agent,
      visibilityApproved: true,
    } as never)
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once' })
    await svc.requestScopeGrants(agent, { requests: [{ scope: 'handbook', permissions: ['read'] }], reason: '面板授权验收' })
    svc.setSessionLookup((id) => (id === 'child' ? child : undefined))

    const res = fakeRes()
    await handleRequest(ctxWith(svc, child), ROUTE, get(`${ROUTE}/grants?session=child`), res)
    assert.equal(res.out.status, 200)
    const value = res.out.body.value
    assert.equal(value.grants.length, 1)
    assert.equal(value.grants[0].inherited, true)
    assert.equal(value.grants[0].ownerSession, 's1')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
