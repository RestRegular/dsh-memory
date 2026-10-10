/**
 * Regression: a fresh process must be able to enumerate scopes that only exist
 * on disk. Scopes are created lazily, so before loadDiscovered() the memory
 * panel (and any management view) silently missed project memories written by
 * earlier sessions — the file is named by scope hash, so the store cannot know
 * about it without reading a record back.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'

test('loadDiscovered finds scopes written by a previous process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-discover-'))
  const scopeA = 'project:workspace-alpha'
  const scopeB = 'project:workspace-beta'
  try {
    const first = new MemoryStore(dir)
    first.save({ scope: 'global', kind: 'note', content: 'global note' }, { importance: 0.5, source: { origin: 'explicit' } })
    first.save({ scope: scopeA, kind: 'note', content: 'alpha note' }, { importance: 0.5, source: { origin: 'explicit' } })
    first.save({ scope: scopeB, kind: 'note', content: 'beta note' }, { importance: 0.5, source: { origin: 'explicit' } })
    first.close()

    // fresh process: nothing loaded yet
    const second = new MemoryStore(dir)
    assert.deepEqual(second.allScopes(), [], 'lazy store starts empty')

    const found = second.loadDiscovered()
    assert.deepEqual([...found].sort(), ['global', scopeA, scopeB].sort())

    const loaded = second.allScopes().map((s) => s.scope).sort()
    assert.deepEqual(loaded, ['global', scopeA, scopeB].sort())
    assert.equal(second.scope(scopeA).records.size, 1)
    assert.equal(second.scope(scopeB).records.size, 1)
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadDiscovered tolerates an empty store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-discover-empty-'))
  try {
    const store = new MemoryStore(dir)
    assert.deepEqual(store.loadDiscovered(), [])
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
