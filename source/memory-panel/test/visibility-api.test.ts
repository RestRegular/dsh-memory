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
    assert.equal(list.out.body.value.approvals[0].items[0].content, '范围外规则正文')
    const id = list.out.body.value.approvals[0].id

    const answer = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/approvals`, { id, outcome: 'allowed-once' }), answer)
    assert.equal(answer.out.status, 200)
    assert.equal(answer.out.body.value.answered, true)
    assert.equal(await verdict, 'allowed-once')

    const again = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/approvals`, { id, outcome: 'rejected' }), again)
    assert.equal(again.out.body.value.answered, false, '已经回答过的审批不能重复消费')
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
