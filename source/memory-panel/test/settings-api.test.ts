import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleRequest } from '../lib/index.js'
import { LocalMemoryService } from '../../memory-local/src/index.ts'

const ROUTE = '/memory/api'
const LOOPBACK = { host: '127.0.0.1:19387' }

function ctxWith(service) {
  return { get: (name) => (name === 'memory' ? service : undefined), logger: { warn() {} } }
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

test('面板 /settings:GET 返回默认设置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-settings-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/settings`), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.ok, true)
    assert.equal(res.out.body.value.recall.enabled, true)
    assert.equal(res.out.body.value.turnEnd.enabled, false)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /settings:POST 合并补丁、夹紧越界值,并持久化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-settings-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/settings`, { digest: { enabled: false, topK: 3 }, rules: { maxItems: 999 } }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.value.digest.enabled, false)
    assert.equal(res.out.body.value.digest.topK, 3)
    assert.equal(res.out.body.value.rules.maxItems, 40)

    const again = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/settings`), again)
    assert.equal(again.out.body.value.digest.enabled, false)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})