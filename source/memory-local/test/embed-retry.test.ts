/**
 * Regression: pending-embed queue must drain once the embed backend recovers.
 *
 * Before the retry timer existed, `save()` queued ids on embed failure but
 * nothing ever called backfillEmbeddings()/backfillAll() — a single outage
 * (llama-server down at save time, or a jar restored without the .vec sidecar)
 * stranded those records forever. The memory panel surfaced it as 待嵌入>0.
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

/** Embedding server that answers OpenAI-compatible /v1/embeddings. */
function startEmbedServer(port = 0, delayMs = 0) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      let inputs: string[] = []
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] | string }
        inputs = Array.isArray(body.input) ? body.input : [body.input ?? '']
      } catch { /* fall through to empty */ }
      const data = inputs.map((_, i) => ({
        embedding: Array.from({ length: DIMS }, (_, k) => (k === i % DIMS ? 1 : 0)),
      }))
      const finish = () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data }))
      }
      // a slow backend models CPU embedding of long contents
      if (delayMs > 0) setTimeout(finish, delayMs)
      else finish()
    })
  })
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as AddressInfo).port
      resolve({
        port: actual,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

/** Reserve a free port, then release it so the backend looks down. */
async function reserveFreePort(): Promise<number> {
  const probe = await startEmbedServer(0)
  await probe.close()
  return probe.port
}

test('retryPendingEmbeds drains the queue after the embed backend comes back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-embed-retry-'))
  const offlinePort = await reserveFreePort()
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true, project: true },
    retrieval: {
      vector: {
        enabled: true,
        endpoint: `http://127.0.0.1:${offlinePort}/v1/embeddings`,
        model: 'test-embed',
        dims: DIMS,
        timeoutMs: 300,
        minScore: 0.5,
        backfillBatchSize: 32,
      },
    },
  })
  svc.setDefaultScope('project:embed-retry')

  try {
    // 1) backend down: the save still succeeds, the vector is queued
    const rec = await svc.save({ scope: 'global', kind: 'fact', content: '后端离线时保存的记录' })
    await new Promise((r) => setTimeout(r, 400)) // let the fire-and-forget embed fail
    assert.equal(svc.pendingEmbedCount, 1, 'failed embed must be queued, not lost')
    assert.equal(svc.store.scope('global').vectors.has(rec.id), false)

    // 2) backend recovers on the SAME port
    const up = await startEmbedServer(offlinePort)
    try {
      // circuit breaker backoff is 1s after the first failure
      await new Promise((r) => setTimeout(r, 1100))
      const done = await svc.retryPendingEmbeds()
      assert.ok(done >= 1, `expected at least one drained embed, got ${done}`)
      assert.equal(svc.pendingEmbedCount, 0, 'queue must be empty after a successful drain')
      assert.equal(svc.store.scope('global').vectors.has(rec.id), true, 'vector stored')
    } finally {
      await up.close()
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retryPendingEmbeds is a no-op with an empty queue (no wasted probe)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-embed-noop-'))
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true } })
  try {
    assert.equal(await svc.retryPendingEmbeds(), 0)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('slow backend: interactive budget is too tight for full contents, backfill budget drains anyway', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-embed-slow-'))
  const offlinePort = await reserveFreePort()
  // interactive budget 150ms; the backend answers in ~400ms (as CPU embedding of
  // long contents does), so only the write/backfill budgets can succeed
  const svc = new LocalMemoryService({
    storeDir: dir,
    scopes: { global: true, project: true },
    retrieval: {
      vector: {
        enabled: true,
        endpoint: `http://127.0.0.1:${offlinePort}/v1/embeddings`,
        model: 'test-embed',
        dims: DIMS,
        timeoutMs: 150,
        writeTimeoutMs: 3_000,
        backfillTimeoutMs: 3_000,
        backfillMaxChars: 8_000,
      },
    },
  })
  try {
    const content = '很长的记忆内容。'.repeat(60) // ~480 chars, like a real record
    const rec = await svc.save({ scope: 'global', kind: 'fact', content })
    await new Promise((r) => setTimeout(r, 400)) // embed + fail while offline
    assert.equal(svc.pendingEmbedCount, 1, 'queued while offline')

    const up = await startEmbedServer(offlinePort, 400)
    try {
      await new Promise((r) => setTimeout(r, 1100)) // circuit-breaker backoff
      const drained = await svc.retryPendingEmbeds()
      assert.ok(drained >= 1, `backfill budget must absorb a slow backend, drained=${drained}`)
      assert.equal(svc.store.scope('global').vectors.has(rec.id), true, 'long record embedded')
      assert.equal(svc.pendingEmbedCount, 0)
    } finally {
      await up.close()
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retryPendingEmbeds discovers scopes created by another process (lazy-load blind spot)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-embed-discover-'))
  const up = await startEmbedServer(0)
  const offlinePort = await reserveFreePort()
  try {
    // "previous session": embeds failed (backend down) in a NON-default scope,
    // so the record sits in that scope's backfill queue on disk
    const writer = new LocalMemoryService({
      storeDir: dir,
      scopes: { global: true, project: true },
      retrieval: { vector: { enabled: true, endpoint: `http://127.0.0.1:${offlinePort}/v1/embeddings`, model: 'test-embed', dims: DIMS, timeoutMs: 300 } },
    })
    writer.setDefaultScope('project')
    writer.setProjectScope('project:other-workspace')
    const rec = await writer.save({ scope: 'project:other-workspace', kind: 'fact', content: '上一个进程写下的项目记忆' })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(writer.store.scope('project:other-workspace').embedPending.size, 1, 'queued while the backend was down')
    writer.flushSync()

    // "fresh session": 启动时只 eager 加载 project + global,而且**不会**为会话 scope
    // 建文件(会话是按会话动态出现的);磁盘上那个 project:other-workspace 起始不在
    // allScopes() 里 —— 它必须靠 discovery 才能进入回填队列。
    const reader = new LocalMemoryService({
      storeDir: dir,
      scopes: { global: true, project: true },
      retrieval: { vector: { enabled: true, endpoint: `http://127.0.0.1:${up.port}/v1/embeddings`, model: 'test-embed', dims: DIMS, timeoutMs: 300 } },
    })
    try {
      assert.deepEqual(reader.store.allScopes(), [], '启动只预载"已存在"的 scope:磁盘上只有 project:other-workspace,所以一个都没加载')
      assert.equal(reader.store.peek('session:not-loaded'), undefined, '不存在的会话 scope 不会被预建')
      const drained = await reader.retryPendingEmbeds()
      assert.ok(drained >= 1, `discovery must expose the on-disk queue, drained=${drained}`)
      assert.equal(reader.store.scope('project:other-workspace').vectors.has(rec.id), true, 'vector written after discovery')
      assert.equal(reader.pendingEmbedCount, 0)
    } finally {
      reader.flushSync()
    }
  } finally {
    await up.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
