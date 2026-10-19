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

test('面板 /records:旧记录带上 supersededBy,新记录带 supersedes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-supersede-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const old = await svc.save({ scope: 'global', kind: 'fact', content: '端口是 3000' })
    const fixed = await svc.save({ scope: 'global', kind: 'fact', content: '端口改为 4000', supersedes: old.id })
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/records?scope=global`), res)
    const records = res.out.body.value.records
    assert.equal(records.find((r) => r.id === fixed.id).supersedes, old.id)
    assert.equal(records.find((r) => r.id === old.id).supersededBy, fixed.id)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /update:编辑内容后作废旧向量并立即请求重建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-update-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    const rec = await svc.save({ scope: 'global', kind: 'fact', content: '旧内容' })
    const scopeStore = svc.store.peek('global')!
    scopeStore.vectors.set(rec.id, new Float32Array([1, 0, 0, 0]))
    const calls: Array<[string, string]> = []
    const memory = {
      store: svc.store,
      scopeStats: () => svc.scopeStats(),
      reindexRecord: (scope: string, id: string) => { calls.push([scope, id]); return Promise.resolve(true) },
    }
    const ctx = { get: (name: string) => (name === 'memory' ? memory : undefined), logger: { warn() {} } }
    const res = fakeRes()
    await handleRequest(ctx, ROUTE, post(`${ROUTE}/update`, { id: rec.id, content: '新内容' }), res)
    assert.equal(res.out.status, 200)
    assert.equal(scopeStore.vectors.has(rec.id), false, '旧向量从内存删掉')
    assert.equal(scopeStore.vectorsDirty, true, '旧向量要从磁盘作废')
    for (let i = 0; i < 4; i++) await Promise.resolve()
    assert.deepEqual(calls, [['global', rec.id]], '立即请求重建这一条')
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
