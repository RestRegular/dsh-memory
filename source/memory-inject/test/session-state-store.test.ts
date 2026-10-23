import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStateStore } from '../src/session-state-store.ts'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-state-'))
}

function fileOf(root: string, sessionId: string): string {
  return join(root, 'sessions', `${sessionId}.jsonl`)
}

test('会话状态:append → dispose → 新 store 能读回条目', () => {
  const root = tempRoot()
  try {
    const a = createSessionStateStore({ root, sessionId: 's1', debounceMs: 5 })
    a.append([
      { id: 'm1', status: 'content_injected', version: 2, at: 10 },
      { id: 'm2', status: 'hint_injected', version: 3, at: 11 },
    ])
    a.dispose()

    const b = createSessionStateStore({ root, sessionId: 's1' })
    const snap = b.load()
    assert.deepEqual(snap?.entries, [
      { id: 'm1', status: 'content_injected', version: 2, at: 10 },
      { id: 'm2', status: 'hint_injected', version: 3, at: 11 },
    ])
    b.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('会话状态:合并窗口内的多次修改只写一行增量', () => {
  const root = tempRoot()
  try {
    const store = createSessionStateStore({ root, sessionId: 's1', debounceMs: 1000 })
    store.append([{ id: 'm1', status: 'hint_injected', version: 1, at: 1 }])
    store.append([{ id: 'm1', status: 'content_injected', version: 2, at: 2 }])
    store.append([{ id: 'm2', status: 'content_injected', version: 3, at: 3 }])
    store.flush()

    const lines = readFileSync(fileOf(root, 's1'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1, '多次 append 合并成一行')
    const wire = JSON.parse(lines[0]!)
    assert.equal(wire.e.length, 2, '同一 id 只保留最后一次状态')
    store.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('会话状态:行数超过阈值时 compact 成一行快照，读回内容不变', () => {
  const root = tempRoot()
  try {
    const store = createSessionStateStore({ root, sessionId: 's1', compactMinLines: 10 })
    for (let i = 0; i < 20; i += 1) {
      store.append([{ id: 'm1', status: 'content_injected', version: i, at: i }])
      store.flush()
    }
    const lines = readFileSync(fileOf(root, 's1'), 'utf8').trim().split('\n')
    assert.ok(lines.length < 20, `发生过 compact，实际 ${lines.length} 行`)
    const wire = JSON.parse(lines[0]!)
    assert.equal(wire.v, 1, '第一行是快照基线')
    assert.equal(wire.e.length, 1)

    const reopened = createSessionStateStore({ root, sessionId: 's1' })
    assert.deepEqual(reopened.load()?.entries, [{ id: 'm1', status: 'content_injected', version: 19, at: 19 }])
    reopened.dispose()
    store.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('会话状态:evict 后的条目不会再被 compact 写回', () => {
  const root = tempRoot()
  try {
    const store = createSessionStateStore({ root, sessionId: 's1' })
    store.append([
      { id: 'keep', status: 'content_injected', version: 1, at: 1 },
      { id: 'drop', status: 'content_injected', version: 1, at: 1 },
    ])
    store.evict(['drop'])
    store.dispose()

    const reopened = createSessionStateStore({ root, sessionId: 's1' })
    assert.deepEqual(reopened.load()?.entries.map((entry) => entry.id), ['keep'])
    reopened.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('会话状态:remove 删除文件；读坏行不中断后续行', () => {
  const root = tempRoot()
  try {
    const path = fileOf(root, 's1')
    const store = createSessionStateStore({ root, sessionId: 's1' })
    store.append([{ id: 'm1', status: 'content_injected', version: 1, at: 1 }])
    store.dispose()
    assert.equal(existsSync(path), true)
    store.remove()
    assert.equal(existsSync(path), false)

    writeFileSync(path, [
      'not json',
      JSON.stringify({ e: [['m2', 2, 5, 6]] }),
      '',
    ].join('\n'), 'utf8')
    const reopened = createSessionStateStore({ root, sessionId: 's1' })
    assert.deepEqual(reopened.load()?.entries, [{ id: 'm2', status: 'content_injected', version: 5, at: 6 }])
    reopened.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('会话状态:超过保留天数的旧会话文件会被清理', () => {
  const root = tempRoot()
  try {
    const sessions = join(root, 'sessions')
    mkdirSync(sessions, { recursive: true })
    const oldFile = fileOf(root, 'old')
    writeFileSync(oldFile, `${JSON.stringify({ e: [['m1', 2, 1, 1]] })}\n`, 'utf8')
    const ancient = new Date(Date.now() - 40 * 86_400_000)
    utimesSync(oldFile, ancient, ancient)

    // 第一个 store 的 load 触发 prune（每个 root 每进程只跑一次）
    const fresh = createSessionStateStore({ root, sessionId: 'fresh', maxAgeDays: 30 })
    fresh.load()
    fresh.dispose()
    assert.equal(existsSync(oldFile), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('会话状态:digestDone 标记持久化，remove 后一起清掉', () => {
  const root = tempRoot()
  try {
    const a = createSessionStateStore({ root, sessionId: 's1' })
    a.markDigestDone()
    a.append([{ id: 'm1', status: 'content_injected', version: 1, at: 1 }])
    a.dispose()

    const b = createSessionStateStore({ root, sessionId: 's1' })
    const snap = b.load()
    assert.equal(snap?.digestDone, true)
    assert.equal(snap?.entries.length, 1)
    b.remove()
    assert.equal(b.load(), undefined)

    const c = createSessionStateStore({ root, sessionId: 's1' })
    assert.equal(c.load(), undefined)
    c.dispose()
    a.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('会话状态:异常 sessionId 落到安全文件名', () => {
  const root = tempRoot()
  try {
    const store = createSessionStateStore({ root, sessionId: '../session/with spaces', debounceMs: 1 })
    store.append([{ id: 'm1', status: 'content_injected', version: 1, at: 1 }])
    store.dispose()
    const sessions = join(root, 'sessions')
    const names = readdirSync(sessions)
    assert.equal(names.length, 1)
    assert.ok(!names[0]!.includes('/') && names[0] !== '..' && names[0] !== '.')
    assert.ok(readFileSync(join(sessions, names[0]!), 'utf8').includes('m1'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
