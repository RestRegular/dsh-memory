/**
 * Regression: the sidecar identity check must run BEFORE the eager load.
 *
 * Reported as RestRegular/dsh-memory#1 by @baipiaowrx. ScopeStore skips its
 * "wrong model → discard" validation entirely while `vecIdentity` is empty
 * (`if (this.vecIdentity && …)`), and the service constructor used to call
 * `loadAll()` first and `setVecIdentity()` after it. Consequences:
 *   1. a scope loaded at startup accepted vectors from a PREVIOUS embedding
 *      model whenever the dimensions happened to match (1024 stays 1024 for the
 *      bge-m3 family), so retrieval silently used meaningless similarities;
 *   2. the next flush rewrote the sidecar header as the NEW model, erasing the
 *      mismatch — the corruption became sticky instead of self-healing.
 *
 * The store-level test (vec-identity.test.ts) calls setVecIdentity explicitly
 * before loading, which is exactly why it never caught this.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-mem-vecorder-'))
}

/** Service with vectors switched off, so save() never tries to reach a backend. */
function open(storeDir: string, model: string, dims: number) {
  return new LocalMemoryService({
    storeDir,
    scopes: { global: true, project: true },
    retrieval: { vector: { enabled: false, model, dims, autoInstall: { dir: join(storeDir, '..', 'vector-root') } } },
  })
}

test('a startup load must not keep vectors from a previous embedding model', async () => {
  const dir = tempDir()
  try {
    const first = open(dir, 'model-a', 4)
    const record = await first.save({ content: '换模型前存的一条记忆', scope: 'global' })
    // Pretend model-a embedded it (no backend in this test).
    first.store.scope('global').appendVector(record.id, new Float32Array([1, 0, 0, 0]))
    first.flushSync()
    assert.equal(first.store.scope('global').vectors.size, 1, 'precondition: one vector on disk')

    // Same dims, DIFFERENT model — the case the old ordering got wrong.
    const second = open(dir, 'model-b', 4)
    const scope = second.store.scope('global')
    assert.equal(scope.vectors.size, 0, 'vectors from model-a must be discarded at startup')
    assert.ok(scope.embedPending.has(record.id), 'the record must be queued for re-embedding')
    second.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reopening with the same model keeps the vectors', async () => {
  const dir = tempDir()
  try {
    const first = open(dir, 'model-a', 4)
    const record = await first.save({ content: '同模型重开应保留向量', scope: 'global' })
    first.store.scope('global').appendVector(record.id, new Float32Array([0, 1, 0, 0]))
    first.flushSync()

    const second = open(dir, 'model-a', 4)
    const scope = second.store.scope('global')
    assert.equal(scope.vectors.size, 1, 'same identity keeps vectors (no pointless re-embedding)')
    assert.equal(scope.embedPending.size, 0)
    second.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dimension changes are discarded too', async () => {
  const dir = tempDir()
  try {
    const first = open(dir, 'model-a', 4)
    const record = await first.save({ content: '维度变化应作废向量', scope: 'global' })
    first.store.scope('global').appendVector(record.id, new Float32Array([1, 1, 0, 0]))
    first.flushSync()

    const second = open(dir, 'model-a', 8)
    const scope = second.store.scope('global')
    assert.equal(scope.vectors.size, 0, 'a different dims count invalidates the sidecar')
    assert.ok(scope.embedPending.has(record.id))
    second.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
