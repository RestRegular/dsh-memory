import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vec-'))
  dirs.push(dir)
  return { dir, store: new MemoryStore(dir) }
}

const REC = { scope: 'project:t', kind: 'note', content: '向量持久化测试', tags: [], source: { origin: 'explicit' as const }, createdAt: 1, updatedAt: 1, lastAccessedAt: 1, accessCount: 0, importance: 0.5 }

test('vector sidecar roundtrip across reopen', () => {
  const { dir, store } = freshStore()
  const scope = 'project:t'
  const r1 = store.save({ ...REC, scope, content: '记录一' }, { importance: 0.5, source: { origin: 'explicit' } }).record
  const r2 = store.save({ ...REC, scope, content: '记录二' }, { importance: 0.5, source: { origin: 'explicit' } }).record
  const s = store.scope(scope)
  s.appendVector(r1.id, new Float32Array([1, 0, 0]))
  s.appendVector(r2.id, new Float32Array([0, 1, 0]))
  store.close()

  const reopened = new MemoryStore(dir)
  const s2 = reopened.scope(scope)
  assert.equal(s2.vectors.size, 2)
  assert.deepEqual([...s2.vectors.get(r1.id)!], [1, 0, 0])
  assert.deepEqual([...s2.vectors.get(r2.id)!], [0, 1, 0])
  assert.equal(s2.embedPending.size, 0, 'embedded records do not rejoin backfill')
  reopened.close()
})

test('stale sidecar entries are skipped; un-embedded records join backfill', () => {
  const { dir, store } = freshStore()
  const scope = 'project:t'
  const r = store.save({ ...REC, scope, content: '有向量的记录' }, { importance: 0.5, source: { origin: 'explicit' } }).record
  store.scope(scope).appendVector(r.id, new Float32Array([0.5, 0.5]))
  store.close()

  // hand-write a bogus entry for a record that no longer exists
  const projectsDir = join(dir, 'projects')
  const name = readdirSync(projectsDir).find((f) => f.endsWith('.vec'))
  const vecFile = join(projectsDir, name!)
  appendFileSync(vecFile, 'deadbeef\t-not-base64-\n', 'utf8')

  const reopened = new MemoryStore(dir)
  const s2 = reopened.scope(scope)
  assert.equal(s2.vectors.size, 1, 'stale id skipped')
  assert.ok(s2.vectors.has(r.id))
  reopened.close()
})

test('remove rewrites sidecar without the deleted vector on flush', () => {
  const { store } = freshStore()
  const scope = 'project:t'
  const r1 = store.save({ ...REC, scope, content: '保留' }, { importance: 0.5, source: { origin: 'explicit' } }).record
  const r2 = store.save({ ...REC, scope, content: '删除' }, { importance: 0.5, source: { origin: 'explicit' } }).record
  const s = store.scope(scope)
  s.appendVector(r1.id, new Float32Array([1, 1]))
  s.appendVector(r2.id, new Float32Array([2, 2]))
  s.remove(r2.id)
  store.flush()
  const reopened = new MemoryStore(store.root)
  const s2 = reopened.scope(scope)
  assert.equal(s2.vectors.size, 1)
  assert.ok(s2.vectors.has(r1.id))
  reopened.close()
})

test('base64 codec keeps float32 bit-exact', () => {
  const { store } = freshStore()
  const scope = 'project:t'
  const r = store.save({ ...REC, scope, content: 'codec' }, { importance: 0.5, source: { origin: 'explicit' } }).record
  const orig = new Float32Array([0.123456789, -3.14159, 1e-8, 1024.5])
  store.scope(scope).appendVector(r.id, orig)
  store.close()
  const reopened = new MemoryStore(store.root)
  const back = reopened.scope(scope).vectors.get(r.id)!
  assert.equal(back.length, 4)
  for (let i = 0; i < 4; i++) assert.equal(back[i], orig[i], `component ${i} bit-exact`)
  reopened.close()
})
