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
test('面板 /create:新建规则;非法 scope 返回 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-create-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const ok = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/create`, {
      scope: 'global', kind: 'rule', content: '发布前必须跑 npm test', importance: 0.9,
    }), ok)
    assert.equal(ok.out.status, 200)
    assert.equal(ok.out.body.value.record.kind, 'rule')
    assert.equal(svc.listSync({ scopes: ['global'], kind: 'rule' }).length, 1)

    const bad = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/create`, { scope: 'project', content: 'x' }), bad)
    assert.equal(bad.out.status, 400)
    assert.equal(bad.out.body.error.code, 'SCOPE_INVALID')
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /export + /import:文本往返,重复导入跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-io-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    await svc.save({ scope: 'global', kind: 'fact', content: '导出用的一条' })
    const exported = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/export`), exported)
    assert.equal(exported.out.status, 200)
    assert.equal(exported.out.body.value.version, 1)
    assert.equal(exported.out.body.value.records.length, 1)
    assert.equal(exported.out.body.value.records[0].content, '导出用的一条')
    assert.equal('vector' in exported.out.body.value.records[0], false)

    const imported = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/import`, exported.out.body.value), imported)
    assert.equal(imported.out.status, 200)
    assert.equal(imported.out.body.value.imported, 0)
    assert.equal(imported.out.body.value.skipped, 1)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
