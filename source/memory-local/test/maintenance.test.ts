import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maint-'))
  dirs.push(dir)
  return { dir, store: new MemoryStore(dir) }
}

function rec(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    scope: 'project:t',
    kind: 'note',
    content: 'x',
    tags: [],
    source: { origin: 'explicit' as const },
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
    importance: 0.5,
    ...overrides,
  } as Parameters<MemoryStore['save']>[0]
}

test('purgeExpired removes only expired records', () => {
  const { store } = freshStore()
  const scope = 'project:t'
  store.save(rec({ scope, content: '还有效', expiredAt: Date.now() + 86_400_000 }), { importance: 0.5, source: { origin: 'explicit' } })
  store.save(rec({ scope, content: '已过期', expiredAt: Date.now() - 1000 }), { importance: 0.5, source: { origin: 'explicit' } })
  store.save(rec({ scope, content: '无过期时间' }), { importance: 0.5, source: { origin: 'explicit' } })
  const removed = store.purgeExpired()
  assert.equal(removed.length, 1)
  const s = store.scope(scope)
  assert.equal(s.records.size, 2)
  assert.ok([...s.records.values()].every((r) => r.content !== '已过期'))
})

test('enforceLimit evicts lowest rank (old + unimportant first)', () => {
  const { store } = freshStore()
  const scope = 'project:t'
  const now = Date.now()
  // fresh + important → kept
  store.save(rec({ scope, content: '新且重要', updatedAt: now, importance: 0.9 }), { importance: 0.9, source: { origin: 'explicit' } })
  // stale + unimportant → evicted first
  store.save(rec({ scope, content: '旧且次要', updatedAt: now - 90 * 86_400_000, importance: 0.1 }), { importance: 0.1, source: { origin: 'explicit' } })
  // fresh + unimportant → kept before the stale one
  store.save(rec({ scope, content: '新但次要', updatedAt: now, importance: 0.2 }), { importance: 0.2, source: { origin: 'explicit' } })
  const removed = store.enforceLimit(2, now)
  assert.deepEqual(removed.length, 1)
  const s = store.scope(scope)
  assert.equal(s.records.size, 2)
  assert.ok(!s.records.has(removed[0]!))
  const contents = [...s.records.values()].map((r) => r.content)
  assert.ok(contents.includes('新且重要'))
  assert.ok(contents.includes('新但次要'))
})

test('enforceLimit leaves scopes within cap untouched', () => {
  const { store } = freshStore()
  const scope = 'project:t'
  for (let i = 0; i < 5; i++) store.save(rec({ scope, content: `c${i}` }), { importance: 0.5, source: { origin: 'explicit' } })
  assert.equal(store.enforceLimit(10).length, 0)
  assert.equal(store.scope(scope).records.size, 5)
})
