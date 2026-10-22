/**
 * 面板「语义检索」的 provider 半边(0.13.0)。
 *
 * 面板和模型工具共用同一套召回排序,但面板是**浏览**:它不能写访问计数(那会把
 * memory_search 的后续排序带偏),而且必须如实报告向量通道有没有真的跑起来 ——
 * 否则「语义检索」会把纯词法结果冒充成语义结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { LocalMemoryService } from '../src/index.ts'

const DIMS = 4

/** OpenAI 兼容的假嵌入服务:每条输入 → 一个确定的单位向量。 */
function startEmbedServer() {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      let inputs: unknown[] = []
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: unknown }
        inputs = Array.isArray(body.input) ? body.input : [body.input]
      } catch { /* 解析失败按空输入处理 */ }
      const data = inputs.map((_, i) => ({
        embedding: Array.from({ length: DIMS }, (_, k) => (k === i % DIMS ? 1 : 0)),
      }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data }))
    })
  })
  return new Promise<{ endpoint: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        endpoint: `http://127.0.0.1:${port}/v1/embeddings`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

function makeService(dir: string, vector: Record<string, unknown> | null) {
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true, project: true },
    ...(vector === null ? {} : { retrieval: { vector } }),
  })
  svc.setProjectScope('project:/w')
  return svc
}

const SCOPE = 'project:/w'

test('searchForPanel:向量 + 词法排序,但绝不写访问计数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-search-'))
  const server = await startEmbedServer()
  const svc = makeService(dir, { enabled: true, endpoint: server.endpoint, model: 'test-embed', dims: DIMS })
  try {
    const a = await svc.save({ scope: SCOPE, kind: 'note', content: '发布前先检查 devcred 凭据' })
    const b = await svc.save({ scope: SCOPE, kind: 'note', content: '面板的语义检索是只读浏览' })
    // 等两条记录的向量落位(保存时的嵌入是 fire-and-forget)
    assert.equal(await svc.reindexRecord(SCOPE, a.id), true)
    assert.equal(await svc.reindexRecord(SCOPE, b.id), true)
    const before = [...svc.store.peek(SCOPE)!.records.values()].map((r) => ({ id: r.id, accessCount: r.accessCount, lastAccessedAt: r.lastAccessedAt }))

    const out = await svc.searchForPanel({ text: '语义检索 只读', scopes: [SCOPE], topK: 5 })

    assert.equal(out.mode, 'vector', '有向量且嵌入服务健康时向量通道参与排序')
    assert.equal(out.reason, undefined)
    assert.equal(out.total, 2)
    assert.equal(out.embedded, 2)
    assert.equal(out.hits.length, 2)
    assert.ok(out.hits.every((hit) => typeof hit.score === 'number' && hit.score > 0), '每个命中都带排序分')

    const after = [...svc.store.peek(SCOPE)!.records.values()].map((r) => ({ id: r.id, accessCount: r.accessCount, lastAccessedAt: r.lastAccessedAt }))
    assert.deepEqual(after, before, '面板检索不改访问计数 / 最近访问时间')
  } finally {
    svc.flushSync()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('searchForPanel:向量关闭时退回词法,并说明原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-search-'))
  const svc = makeService(dir, null)
  try {
    await svc.save({ scope: SCOPE, kind: 'note', content: '发布流程写在全局规则里' })
    await svc.save({ scope: SCOPE, kind: 'note', content: '无关记录' })
    const out = await svc.searchForPanel({ text: '发布流程', scopes: [SCOPE] })
    assert.equal(out.mode, 'lexical')
    assert.equal(out.reason, 'vector-disabled')
    assert.equal(out.total, 2)
    assert.equal(out.embedded, 0)
    assert.equal(out.hits.length, 1)
    assert.match(out.hits[0]!.record.content, /发布流程/)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('searchForPanel:有记录但没有向量时报告 no-vectors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-search-'))
  const server = await startEmbedServer()
  // 配了后端但标记 enabled=false:记录能正常写,只是不会嵌入
  const svc = makeService(dir, { enabled: false, endpoint: server.endpoint, model: 'test-embed', dims: DIMS })
  try {
    await svc.save({ scope: SCOPE, kind: 'note', content: '还没有向量的记录' })
    const out = await svc.searchForPanel({ text: '还没有向量', scopes: [SCOPE] })
    assert.equal(out.mode, 'lexical')
    assert.equal(out.reason, 'vector-disabled')
    assert.equal(out.embedded, 0)
    assert.equal(out.total, 1)
  } finally {
    svc.flushSync()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('searchForPanel:向量存在但嵌入服务已经不可用时报告 embed-failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-search-'))
  const server = await startEmbedServer()
  const svc = makeService(dir, { enabled: true, endpoint: server.endpoint, model: 'test-embed', dims: DIMS })
  try {
    const rec = await svc.save({ scope: SCOPE, kind: 'note', content: '先嵌入,再让服务下线' })
    assert.equal(await svc.reindexRecord(SCOPE, rec.id), true)
    await server.close() // 后端消失:query 的嵌入请求会失败并触发熔断
    const out = await svc.searchForPanel({ text: '服务下线之后', scopes: [SCOPE] })
    assert.equal(out.mode, 'lexical')
    assert.equal(out.reason, 'embed-failed')
    assert.equal(out.embedded, 1, '向量还在磁盘上,只是这次用不了')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
