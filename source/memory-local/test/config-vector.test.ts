/**
 * Vector-retrieval is opt-in by CONFIGURATION.
 *
 * The failure this guards against: a fresh `pnpm add` on a machine with nothing
 * listening on the stock localhost endpoint used to attempt embeddings on every
 * save, trip the circuit breaker and fill the log — for a feature that is
 * optional. Also guarded: the panel's one-click installer must be adopted
 * (spawn paths filled in) without any hand-written config.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/index.ts'
import { installPaths } from '../src/embed-install.ts'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-mem-cfg-'))
}

test('no vector configuration → vectors stay off and nothing is attempted', () => {
  const dir = tempDir()
  try {
    const cfg = resolveConfig({ storeDir: join(dir, 'store') })
    assert.equal(cfg.vector.configured, false, 'nothing was configured')
    assert.equal(cfg.vector.enabled, false, 'and therefore retrieval is off')
    assert.equal(cfg.vector.spawnConfigured, false)
    assert.equal(cfg.vector.spawn.enabled, false, 'never spawn a backend nobody asked for')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit endpoint is enough to turn vectors on (cloud / self-hosted)', () => {
  const dir = tempDir()
  try {
    const cfg = resolveConfig({
      storeDir: join(dir, 'store'),
      retrieval: { vector: { endpoint: 'https://example.com/v1/embeddings', model: 'bge-m3', dims: 1024 } },
    })
    assert.equal(cfg.vector.configured, true)
    assert.equal(cfg.vector.enabled, true, 'configuring an endpoint implies intent')
    assert.equal(cfg.vector.spawnConfigured, false, 'no spawn → the panel must not offer a switch')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit enabled:false wins over a configured endpoint', () => {
  const dir = tempDir()
  try {
    const cfg = resolveConfig({
      storeDir: join(dir, 'store'),
      retrieval: { vector: { enabled: false, endpoint: 'https://example.com/v1/embeddings' } },
    })
    assert.equal(cfg.vector.configured, true, 'still configured — the panel explains the switch-off')
    assert.equal(cfg.vector.enabled, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a backend installed at autoInstall.dir is adopted into spawn', () => {
  const dir = tempDir()
  try {
    const paths = installPaths(dir)
    mkdirSync(paths.dir, { recursive: true })
    mkdirSync(join(dir, 'models'), { recursive: true })
    writeFileSync(paths.exe, 'stub')
    writeFileSync(paths.model, 'stub')

    const cfg = resolveConfig({ storeDir: join(dir, 'store'), retrieval: { vector: { autoInstall: { dir } } } })
    assert.equal(cfg.vector.configured, true, 'files on disk count as configured')
    assert.equal(cfg.vector.enabled, true)
    assert.equal(cfg.vector.spawn.enabled, true, 'we manage what we installed')
    assert.equal(cfg.vector.spawn.exe, paths.exe)
    assert.equal(cfg.vector.spawn.model, paths.model)
    assert.equal(cfg.vector.spawn.cwd, paths.cwd)
    assert.equal(cfg.vector.spawn.logFile, paths.logFile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hand-written spawn paths win over an adopted installation', () => {
  const dir = tempDir()
  try {
    const paths = installPaths(dir)
    mkdirSync(paths.dir, { recursive: true })
    mkdirSync(join(dir, 'models'), { recursive: true })
    writeFileSync(paths.exe, 'stub')
    writeFileSync(paths.model, 'stub')

    const cfg = resolveConfig({
      storeDir: join(dir, 'store'),
      retrieval: {
        vector: {
          autoInstall: { dir },
          spawn: { enabled: true, exe: '/custom/llama-server', model: '/custom/model.gguf', cwd: '/custom' },
        },
      },
    })
    assert.equal(cfg.vector.spawn.exe, '/custom/llama-server', 'explicit config is never overwritten')
    assert.equal(cfg.vector.spawn.model, '/custom/model.gguf')
    assert.equal(cfg.vector.spawn.cwd, '/custom')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
