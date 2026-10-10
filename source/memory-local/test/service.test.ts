import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { memoryTools } from '../../tool-memory/src/index.ts'
import type { MemoryScope } from 'dsh-memory'

const DIR = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
const PROJECT: MemoryScope = 'project:test-workspace'

/** LocalMemoryService defaults to embedding at 127.0.0.1:8078 (llama-server);
 * in CI/offline runs the circuit breaker degrades gracefully. */
let svc: LocalMemoryService

beforeEach(() => {
  svc = new LocalMemoryService({ storeDir: DIR, scopes: { global: true, project: true } })
  svc.setDefaultScope(PROJECT)
})

after(() => {
  svc.flushSync()
  rmSync(DIR, { recursive: true, force: true })
})

test('save + list roundtrip, project and global separated', async () => {
  const saved = await svc.save({ scope: PROJECT, kind: 'preference', content: '用户偏好 TypeScript' })
  const g = await svc.save({ scope: 'global', kind: 'preference', content: '回答尽量简短' })
  assert.ok(saved.id && g.id)
  const proj = await svc.list({ scope: PROJECT })
  const glob = await svc.list({ scope: 'global' })
  assert.equal(proj.length, 1)
  assert.equal(glob.length, 1)
  assert.equal(proj[0]!.content, '用户偏好 TypeScript')
})

test('dedupe: same normalized content refreshes instead of duplicating', async () => {
  await svc.save({ scope: PROJECT, kind: 'note', content: 'Deploy  before migrate' })
  const again = await svc.save({ scope: PROJECT, kind: 'note', content: 'deploy before MIGRATE' })
  assert.equal(again.content, 'Deploy  before migrate')
  assert.equal((await svc.list({ scope: PROJECT })).length, 1)
})

test('scope gate rejects disabled scopes with coded error', async () => {
  const gated = new LocalMemoryService({ storeDir: DIR, scopes: { global: false, project: true } })
  await assert.rejects(
    () => gated.save({ scope: 'global', kind: 'note', content: 'x' }),
    (err: Error & { code?: string }) => err.code === 'SCOPE_DISABLED',
  )
})

test('content validation', async () => {
  await assert.rejects(() => svc.save({ scope: PROJECT, kind: 'note', content: '   ' }), /CONTENT_EMPTY/)
  await assert.rejects(() => svc.save({ scope: PROJECT, kind: 'note', content: 'x'.repeat(5000) }), /CONTENT_TOO_LONG/)
})

test('supersedes validation and penalty wiring', async () => {
  const r1 = await svc.save({ scope: PROJECT, kind: 'fact', content: 'API 端口是 3000' })
  await assert.rejects(
    () => svc.save({ scope: PROJECT, kind: 'fact', content: 'API 端口是 4000', supersedes: 'no-such-id' }),
    (err: Error & { code?: string }) => err.code === 'SUPERSEDES_UNKNOWN',
  )
  const r2 = await svc.save({ scope: PROJECT, kind: 'fact', content: 'API 端口改为 4000', supersedes: r1.id })
  assert.equal(r2.supersedes, r1.id)
  // superseded record still retrievable but should rank below the correction
  const hits = await svc.search({ text: 'API 端口', scope: PROJECT })
  if (hits.length >= 2) {
    const ids = hits.map((h) => h.record.id)
    assert.ok(ids.indexOf(r2.id) < ids.indexOf(r1.id), 'correction outranks superseded record')
  }
})

test('forget by id and by query', async () => {
  const a = await svc.save({ scope: PROJECT, kind: 'note', content: '临时凭据存放在 vault' })
  const b = await svc.save({ scope: PROJECT, kind: 'note', content: '临时凭据的轮换周期是 90 天' })
  const byId = await svc.forget({ id: a.id })
  assert.deepEqual(byId.ids, [a.id])
  const byQuery = await svc.forget({ query: '临时凭据', scope: PROJECT })
  assert.deepEqual([...byQuery.ids].sort(), [b.id])
  await assert.rejects(() => svc.forget({ query: '临时凭据', scope: PROJECT }), /RECORD_NOT_FOUND/)
  await assert.rejects(() => svc.forget({}), /forget requires/)
})

test('search respects topK and scope pinning', async () => {
  for (let i = 0; i < 8; i++) {
    await svc.save({ scope: PROJECT, kind: 'note', content: `第 ${i} 条关于 postgres 索引优化的记录 ${'x'.repeat(i)}` })
  }
  const hits = await svc.search({ text: 'postgres 索引优化', scope: PROJECT, topK: 3 })
  assert.ok(hits.length <= 3)
  const none = await svc.search({ text: 'postgres 索引优化', scope: 'global' })
  assert.equal(none.length, 0)
})

test('persistence: records survive reopen from disk', async () => {
  const r = await svc.save({ scope: PROJECT, kind: 'decision', content: '选择 JSONL 而非 sqlite 作为 M1 存储' })
  svc.flushSync()
  const reopened = new LocalMemoryService({ storeDir: DIR, scopes: { global: true, project: true } })
  reopened.setDefaultScope(PROJECT)
  const records = await reopened.list({ scope: PROJECT })
  assert.ok(records.some((x) => x.id === r.id))
  reopened.flushSync()
})

test('store writes valid JSONL atomically (no .tmp leftovers)', async () => {
  await svc.save({ scope: PROJECT, kind: 'note', content: '检查无 tmp 残留' })
  svc.flushSync()
  const files = readdirSync(DIR)
  assert.ok(!files.some((f) => f.endsWith('.tmp')), `no tmp files expected, got ${files}`)
  assert.ok(existsSync(join(DIR, 'projects')))
  const projFile = readdirSync(join(DIR, 'projects')).find((f) => f.endsWith('.jsonl'))
  assert.ok(projFile, 'project jsonl exists')
  const text = readFileSync(join(DIR, 'projects', projFile!), 'utf8')
  for (const line of text.split('\n').filter((l) => l.trim())) JSON.parse(line) // every line valid JSON
})

// ---- tool layer contract tests (mock-backed, no I/O) ----

function toolOptsWith(mock: Record<string, Function>) {
  return {
    getService: () => mock as never,
    defaultScope: () => PROJECT,
  }
}

test('tools: save validates and forwards scope resolution', async () => {
  const calls: unknown[] = []
  const opts = toolOptsWith({
    save: async (input: unknown) => {
      calls.push(input)
      return { id: 'id-1', scope: 'project:test-workspace', content: 'x' }
    },
  })
  const tools = memoryTools(opts)
  const res = await tools.memory_save.execute({ content: '记住这件事', scope: 'project' })
  assert.equal(res.id, 'id-1')
  assert.deepEqual(calls[0], { scope: PROJECT, kind: 'note', content: '记住这件事', source: { origin: 'explicit' } })
  await assert.rejects(() => tools.memory_save.execute({ content: '' }), (e: Error & { code?: string }) => e.code === 'CONTENT_EMPTY')
  await assert.rejects(() => tools.memory_save.execute({ content: 'x', importance: 2 }), /importance/)
})

test('tools: forget enforces xor(id, query)', async () => {
  const opts = toolOptsWith({ forget: async () => ({ removed: 1, ids: ['a'] }) })
  const tools = memoryTools(opts)
  await assert.rejects(() => tools.memory_forget.execute({}), /provide id or query/i)
  await assert.rejects(() => tools.memory_forget.execute({ id: 'a', query: 'b' }), /not both/i)
  const res = await tools.memory_forget.execute({ id: 'a' })
  assert.equal(res.removed, 1)
})

test('tools: unavailable service fails with clear code', async () => {
  const tools = memoryTools({ getService: () => undefined, defaultScope: () => PROJECT })
  await assert.rejects(() => tools.memory_search.execute({ query: 'x' }), /not loaded/)
})
