/**
 * 面板 /memory/api/search(记录页的「语义检索」)。
 *
 * 锁住四件事:
 *   1. 空查询 / 非法 topK → 400,而不是返回一个看起来"没有结果"的 200;
 *   2. provider 提供 searchForPanel 时按它给的顺序与分数返回,并原样带上作用域选择;
 *   3. 旧 provider(只有 search / 只有 store)各有降级路径,响应里始终带 mode/reason,
 *      面板据此如实标注「语义排序」还是「关键词回退」;
 *   4. 读路径不创建 scope、不改访问计数(语义检索是浏览,不是召回)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleRequest } from '../lib/index.js'
import { LocalMemoryService } from '../../memory-local/src/index.ts'

const ROUTE = '/memory/api'
const LOOPBACK = { host: '127.0.0.1:19387' }

function ctxWith(service, extra = {}) {
  return {
    get: (name) => (name === 'memory' ? service : extra[name]),
    logger: { warn() {} },
    ...extra,
  }
}

function fakeRes() {
  const out = { status: null, headers: null, body: null }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(text) { try { out.body = JSON.parse(text) } catch { out.body = text } },
  }
}

function get(url) {
  return { url, method: 'GET', headers: LOOPBACK }
}

function makeService(dir, config = {}) {
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true }, ...config })
  svc.setProjectScope('project:/w')
  return svc
}

async function callSearch(service, url) {
  const res = fakeRes()
  await handleRequest(ctxWith(service), ROUTE, get(`${ROUTE}${url}`), res)
  return res
}

test('面板 /search:空查询与非法 topK 返回 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-search-'))
  const svc = makeService(dir)
  try {
    for (const url of ['/search', '/search?q=', '/search?q=%20%20']) {
      const res = await callSearch(svc, url)
      assert.equal(res.out.status, 400, url)
      assert.equal(res.out.body.error.code, 'QUERY_EMPTY', url)
    }
    for (const topK of ['abc', '0', '51']) {
      const res = await callSearch(svc, `/search?q=alpha&topK=${topK}`)
      assert.equal(res.out.status, 400, topK)
      assert.equal(res.out.body.error.code, 'QUERY_INVALID', topK)
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /search:向量未启用时按词法降级,并如实报告 mode/reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-search-'))
  const svc = makeService(dir)
  try {
    await svc.save({ scope: 'project:/w', kind: 'note', content: '发布流程先检查凭据' })
    await svc.save({ scope: 'project:/w', kind: 'note', content: '完全无关的内容' })
    svc.store.flush()
    const res = await callSearch(svc, '/search?q=发布流程')
    assert.equal(res.out.status, 200)
    const value = res.out.body.value
    assert.equal(value.mode, 'lexical')
    assert.equal(value.reason, 'vector-disabled')
    assert.equal(value.embedded, 0)
    assert.equal(value.total, 2)
    assert.equal(value.hits.length, 1)
    assert.match(value.hits[0].content, /发布流程/)
    assert.equal(typeof value.hits[0].score, 'number', '词法排序分也保留,面板用来显示相关度')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /search:provider 的 searchForPanel 决定顺序/分数,作用域选择原样传入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-search-'))
  const svc = makeService(dir)
  try {
    const old = await svc.save({ scope: 'project:/w', kind: 'note', content: '旧记录' })
    const fresh = await svc.save({ scope: 'project:/w', kind: 'note', content: '新记录', supersedes: old.id })
    await svc.save({ scope: 'session:s1', kind: 'note', content: '会话里的记录' })
    svc.store.flush()
    const calls = []
    svc.searchForPanel = async (input) => {
      calls.push(input)
      return {
        hits: [
          { record: svc.store.peek('project:/w').records.get(fresh.id), score: 0.8123 },
          { record: svc.store.peek('project:/w').records.get(old.id), score: 0.5 },
        ],
        mode: 'vector',
        embedded: 2,
        total: 3,
      }
    }
    const res = await callSearch(svc, '/search?q=anything&scope=project%3A%2Fw')
    assert.equal(res.out.status, 200)
    assert.deepEqual(calls, [{ text: 'anything', scopes: ['project:/w'], topK: 20 }], '作用域与默认 topK 原样传给 provider')
    const value = res.out.body.value
    assert.equal(value.mode, 'vector')
    assert.equal(value.reason, undefined)
    assert.equal(value.embedded, 2)
    assert.equal(value.total, 3)
    assert.deepEqual(value.hits.map((hit) => hit.id), [fresh.id, old.id], '按 provider 给的顺序返回')
    assert.equal(value.hits[0].score, 0.8123)
    assert.equal(value.hits[1].supersededBy, fresh.id, '被修正的记录仍带 supersededBy')
    assert.equal(value.hits[0].supersedes, old.id)

    const all = await callSearch(svc, '/search?q=anything')
    assert.equal(all.out.status, 200)
    assert.equal(calls[1].scopes.length, 2, '不传 scope 时检索全部已发现作用域')
    assert.ok(calls[1].scopes.includes('project:/w') && calls[1].scopes.includes('session:s1'))
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /search:旧 provider 只有 search 时退回通用检索(并说明没有向量)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-search-'))
  const real = makeService(dir)
  try {
    const rec = await real.save({ scope: 'project:/w', kind: 'note', content: '旧 provider 的记录' })
    real.store.flush()
    const legacy = {
      store: real.store,
      search: async (query) => {
        assert.deepEqual(query.scopes, ['project:/w'])
        return [{ record: real.store.peek('project:/w').records.get(rec.id), score: 0.5 }]
      },
    }
    const res = await callSearch(legacy, '/search?q=anything&scope=project%3A%2Fw')
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.value.mode, 'lexical')
    assert.equal(res.out.body.value.reason, 'no-vectors')
    assert.equal(res.out.body.value.hits.length, 1)
  } finally {
    real.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /search:连检索接口都没有时退回关键词过滤,响应仍带 mode/reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-search-'))
  const real = makeService(dir)
  try {
    await real.save({ scope: 'project:/w', kind: 'note', content: '关键词命中这条' })
    await real.save({ scope: 'project:/w', kind: 'note', content: '另一条' })
    real.store.flush()
    const res = await callSearch({ store: real.store }, '/search?q=关键词')
    assert.equal(res.out.status, 200)
    const value = res.out.body.value
    assert.equal(value.mode, 'lexical')
    assert.equal(value.reason, 'provider-lexical')
    assert.equal(value.total, 2)
    assert.equal(value.hits.length, 1)
    assert.match(value.hits[0].content, /关键词/)
  } finally {
    real.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /search:不存在的 scope 返回空结果,且不在磁盘上创建文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-search-'))
  const svc = makeService(dir)
  try {
    const res = await callSearch(svc, '/search?q=anything&scope=my%20notes')
    assert.equal(res.out.status, 200)
    assert.deepEqual(res.out.body.value.hits, [])
    assert.equal(res.out.body.value.total, 0)
    assert.deepEqual(svc.store.allScopes(), [], 'peek 不把不存在的 scope 加进来')
    assert.ok(!existsSync(join(dir, 'projects')) || readdirSync(join(dir, 'projects')).length === 0, '磁盘上不该有文件')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /search:非法 scope 与 /records 同口径返回 400', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-search-'))
  const svc = makeService(dir)
  try {
    const res = await callSearch(svc, '/search?q=anything&scope=..%2Fetc%2Fpasswd')
    assert.equal(res.out.status, 400)
    assert.equal(res.out.body.error.code, 'SCOPE_INVALID')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
