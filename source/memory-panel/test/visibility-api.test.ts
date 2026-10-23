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

test('面板 /visibility:GET 返回自己的覆盖、生效范围与可选目录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-visibility-'))
  const svc = makeService(dir)
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  try {
    const res = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, get(`${ROUTE}/visibility?session=s1`), res)
    assert.equal(res.out.status, 200)
    const value = res.out.body.value
    assert.equal(value.sessionId, 's1')
    assert.equal(value.override, null)
    assert.equal(value.inherited, false)
    assert.deepEqual(value.effective, ['session:s1', 'project:D:\\w', 'global'])
    const scopes = value.scopes.map((s) => s.scope)
    assert.deepEqual(scopes.slice(0, 3), ['session:s1', 'project:D:\\w', 'global'], '当前会话/项目/global 在最前')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /visibility:POST 设置与恢复默认;空选择返回 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-visibility-'))
  const svc = makeService(dir)
  const session = { id: 's1', header: { id: 's1', cwd: 'D:/w' } }
  try {
    const set = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/visibility`, {
      session: 's1',
      scopes: ['project:D:/w', 'global'],
    }), set)
    assert.equal(set.out.status, 200)
    assert.deepEqual(set.out.body.value.override, ['project:D:/w', 'global'])
    assert.deepEqual(set.out.body.value.effective, ['project:D:\\w', 'global'])
    assert.deepEqual(svc.sessionVisibility('s1'), ['project:D:/w', 'global'])

    const empty = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/visibility`, { session: 's1', scopes: [] }), empty)
    assert.equal(empty.out.status, 400)
    assert.equal(empty.out.body.error.code, 'SCOPE_EMPTY')

    const reset = fakeRes()
    await handleRequest(ctxWith(svc, session), ROUTE, post(`${ROUTE}/visibility`, { session: 's1', scopes: null }), reset)
    assert.equal(reset.out.status, 200)
    assert.equal(reset.out.body.value.override, null)
    assert.deepEqual(reset.out.body.value.effective, ['session:s1', 'project:D:\\w', 'global'])
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
