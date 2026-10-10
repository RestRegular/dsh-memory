/**
 * Maintenance actions: removing the installed vector backend, wiping memory
 * data, and the config rules that keep both honest.
 *
 * The two ways this could hurt someone, both pinned here:
 *   - deleting a llama.cpp install the USER made (outside our install root)
 *   - deleting the memory store while "removing the vector server"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService, resolveConfig } from '../src/index.ts'
import { installPaths } from '../src/embed-install.ts'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-mem-maint-'))
}

/** Materialise the layout the panel's installer would have produced. */
function fakeInstall(root: string, { bytes = 4096 } = {}) {
  const paths = installPaths(root)
  mkdirSync(paths.dir, { recursive: true })
  mkdirSync(join(root, 'models'), { recursive: true })
  writeFileSync(paths.exe, Buffer.alloc(bytes, 1))
  writeFileSync(paths.model, Buffer.alloc(bytes * 2, 2))
  writeFileSync(paths.logFile, 'log line\n')
  return paths
}

test('uninstall removes the runtime, model and logs but never the memory store', () => {
  const root = tempDir()
  try {
    const paths = fakeInstall(root)
    const storeDir = join(root, 'store')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'global.jsonl'), '{"id":"keep-me","scope":"global","kind":"fact","content":"survives","tags":[],"importance":0.5,"createdAt":1,"updatedAt":1,"accessCount":0}\n')

    const svc = new LocalMemoryService({
      storeDir,
      retrieval: { vector: { enabled: false, autoInstall: { dir: root } } },
    })

    const usage = svc.vectorInstallUsage()
    assert.ok(usage.bytes >= 4096 * 3, `usage should count runtime + model + log, got ${usage.bytes}`)
    assert.ok(!usage.paths.some((p) => p.startsWith(storeDir)), 'the store must never be part of the usage set')

    const out = svc.uninstallVectorBackend()
    assert.equal(out.reason, 'REMOVED')
    assert.equal(out.removed, true)
    assert.ok(out.freedBytes >= 4096 * 3)
    assert.equal(existsSync(paths.dir), false, 'runtime dir gone')
    assert.equal(existsSync(join(root, 'models')), false, 'models dir gone')
    assert.equal(existsSync(paths.logFile), false, 'log gone')
    assert.equal(existsSync(join(storeDir, 'global.jsonl')), true, 'memory data survives')
    svc.flushSync()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('uninstall refuses a backend the user installed elsewhere', () => {
  const root = tempDir()
  const outside = tempDir()
  try {
    // Config points at a hand-made llama.cpp outside our install root: it is
    // the user's, so removing it would be destroying something we never made.
    const external = join(outside, 'llama-server.exe')
    writeFileSync(external, 'user-owned')
    fakeInstall(root)
    const svc = new LocalMemoryService({
      storeDir: join(root, 'store'),
      retrieval: { vector: { enabled: false, autoInstall: { dir: root }, spawn: { enabled: true, exe: external } } },
    })
    const out = svc.uninstallVectorBackend()
    assert.equal(out.reason, 'EXTERNAL_BACKEND')
    assert.equal(out.removed, false)
    assert.equal(existsSync(join(root, 'models')), true, 'nothing was deleted')
    assert.equal(existsSync(external), true, 'the user’s own binary is untouched')
    svc.flushSync()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('uninstall on a machine with no local backend is a no-op', () => {
  const root = tempDir()
  try {
    const svc = new LocalMemoryService({
      storeDir: join(root, 'store'),
      retrieval: { vector: { enabled: false, autoInstall: { dir: root } } },
    })
    const out = svc.uninstallVectorBackend()
    assert.equal(out.reason, 'NOT_INSTALLED')
    assert.equal(out.freedBytes, 0)
    svc.flushSync()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('wiping memory data empties every scope and persists it', async () => {
  const root = tempDir()
  try {
    const storeDir = join(root, 'store')
    const svc = new LocalMemoryService({ storeDir, scopes: { global: true, project: true } })
    await svc.save({ content: '全局记忆一', scope: 'global' })
    await svc.save({ content: '全局记忆二', scope: 'global' })
    await svc.save({ content: '项目记忆', scope: 'project:demo' })
    assert.ok(svc.store.allScopes().reduce((n, s) => n + s.records.size, 0) === 3, 'three records saved')

    const out = svc.wipeAllRecords()
    assert.equal(out.removed, 3)
    assert.deepEqual(out.scopes.sort(), ['global', 'project:demo'])
    svc.flushSync()

    // Reopen from disk: the wipe must be durable, not just in-memory.
    const reopened = new LocalMemoryService({ storeDir, scopes: { global: true, project: true } })
    assert.equal(reopened.store.allScopes().reduce((n, s) => n + s.records.size, 0), 0, 'nothing came back')
    reopened.flushSync()
    const files = readdirSync(storeDir).filter((f) => f.endsWith('.jsonl'))
    assert.ok(files.length > 0, 'store files still exist (empty, not half-deleted)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a spawn path that no longer exists stops counting as configured', () => {
  const root = tempDir()
  try {
    const missing = join(root, 'gone', 'llama-server.exe')
    const gone = resolveConfig({
      storeDir: join(root, 'store'),
      retrieval: { vector: { spawn: { enabled: true, exe: missing } } },
    })
    // Otherwise the panel would show a managed server that can never start,
    // instead of offering the download button again after an uninstall.
    assert.equal(gone.vector.configured, false)
    assert.equal(gone.vector.enabled, false)

    const real = join(root, 'llama-server.exe')
    writeFileSync(real, 'stub')
    const present = resolveConfig({
      storeDir: join(root, 'store'),
      retrieval: { vector: { spawn: { enabled: true, exe: real } } },
    })
    assert.equal(present.vector.configured, true)
    assert.equal(present.vector.enabled, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
