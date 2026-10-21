/**
 * 回归:多个进程共用同一个 storeDir 时不能互相抹数据(RestRegular/dsh-memory#3)。
 *
 * 老实现的两个设计各自合理、叠加后致命:
 *   1. `loadScope()` 每个 scope 只读盘一次;
 *   2. `flush()` 拿内存快照**整份重写**文件。
 * 于是 A 写的记录不在 B 的内存里,B 下一次 flush 就把它整条覆盖掉 —— 不报错、没日志。
 *
 * 现在的写法:每个 scope 一把锁文件,flush 在锁内**重新读盘**,只把本次的增量
 * (upserts/deletes)合并进去。这个测试同时覆盖:
 *   - 两个实例交错写同一个 scope(单进程内交错,模拟"对方先写过"的顺序);
 *   - 4 个真实子进程并发写同一个 scope(进程级并发,带锁文件);
 *   - 删除不会被对方的旧快照"复活";
 *   - 读路径能看见别的进程刚写的记录(stat 刷新);
 *   - 收尾不留 .lock / .tmp。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MemoryStore } from '../src/store.ts'

const dirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-multi-'))
  dirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function saveContent(store: MemoryStore, scope: string, content: string): string {
  const { record } = store.save(
    { scope, kind: 'note', content } as Parameters<MemoryStore['save']>[0],
    { importance: 0.5, source: { origin: 'explicit' as const } },
  )
  return record.id
}

function jsonlPath(dir: string, scope: string): string {
  // project:xxx 落在 projects/<sha1>.jsonl;这里只用 global,直接拼
  return join(dir, 'global.jsonl')
}

test('two instances interleaved writes keep every record (issue #3 repro)', () => {
  const dir = freshDir()
  const a = new MemoryStore(dir)
  const b = new MemoryStore(dir)

  // A 先写一批并落盘;B 在此之前已经加载过这个 scope(旧快照里没有 A 的记录)
  for (let i = 0; i < 24; i++) saveContent(a, 'global', `A 的第 ${i} 条记忆`)
  a.flush()
  assert.equal(readFileSync(jsonlPath(dir, 'global'), 'utf8').trim().split('\n').length, 24)

  // B 写自己的 12 条,然后 flush。老实现这一步会把 A 的 24 条整份覆盖掉。
  for (let i = 0; i < 12; i++) saveContent(b, 'global', `B 的第 ${i} 条记忆`)
  b.flush()

  const lines = readFileSync(jsonlPath(dir, 'global'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 36, '两侧的写入都必须还在磁盘上')
  const reopened = new MemoryStore(dir, { refreshTtlMs: 0 })
  reopened.loadAll(['global'])
  assert.equal(reopened.scope('global').records.size, 36)
})

test('a flush does not resurrect records another instance deleted', () => {
  const dir = freshDir()
  const a = new MemoryStore(dir)
  const idA = saveContent(a, 'global', 'A 要删的记忆')
  saveContent(a, 'global', 'A 要留的记忆')
  a.flush()

  // B 看到两条,删掉 A 那条;B 自己再删掉自己还没写的一条(模拟交错顺序)
  const b = new MemoryStore(dir, { refreshTtlMs: 1 })
  assert.equal(b.scope('global').records.size, 2, 'B 应看到 A 写过的两条')
  b.scope('global').remove(idA)
  b.flush()

  const reopened = new MemoryStore(dir, { refreshTtlMs: 0 })
  reopened.loadAll(['global'])
  assert.equal(reopened.scope('global').records.size, 1, '被删的那条不能被 A 的旧快照带回来')
  assert.equal([...reopened.scope('global').records.values()][0]!.content, 'A 要留的记忆')
})

test('read path notices records another instance just wrote', async () => {
  const dir = freshDir()
  const a = new MemoryStore(dir, { refreshTtlMs: 1 })
  saveContent(a, 'global', 'A 早期的一条')
  a.flush()
  assert.equal(a.scope('global').records.size, 1, 'precondition')

  const b = new MemoryStore(dir, { refreshTtlMs: 0 })
  saveContent(b, 'global', 'B 后写的一条')
  b.flush()

  await new Promise((resolve) => setTimeout(resolve, 5)) // 让 A 的 stat 限流窗口过去
  assert.equal(a.scope('global').records.size, 2, 'A 不重启也要看见 B 写的记录')

  // 而且 A 后续的写不会因此丢东西
  saveContent(a, 'global', 'A 又写的一条')
  a.flush()
  const reopened = new MemoryStore(dir, { refreshTtlMs: 0 })
  reopened.loadAll(['global'])
  assert.equal(reopened.scope('global').records.size, 3)
})

test('four real child processes writing one scope lose nothing', () => {
  const dir = freshDir()
  const here = dirname(fileURLToPath(import.meta.url))
  const storeUrl = pathToFileURL(join(here, '..', 'src', 'store.ts')).href
  const writer = join(dir, 'writer.mjs')
  writeFileSync(
    writer,
    `import { MemoryStore } from ${JSON.stringify(storeUrl)}\n` +
    `const [, , dir, tag, count] = process.argv\n` +
    `const store = new MemoryStore(dir)\n` +
    `for (let i = 0; i < Number(count); i++) {\n` +
    `  store.save({ scope: 'global', kind: 'note', content: tag + ' 的第 ' + i + ' 条' }, { importance: 0.5, source: { origin: 'explicit' } })\n` +
    `}\n` +
    `store.close()\n` +
    `process.exit(0)\n`,
    'utf8',
  )

  const children = 4
  const perChild = 20
  const runs = Array.from({ length: children }, (_, i) => spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', writer, dir, `child${i}`, String(perChild)],
    { encoding: 'utf8', timeout: 60_000 },
  ))
  for (const [i, run] of runs.entries()) {
    assert.equal(run.status, 0, `child ${i} failed: ${run.stderr}`)
  }

  const reopened = new MemoryStore(dir, { refreshTtlMs: 0 })
  reopened.loadAll(['global'])
  assert.equal(reopened.scope('global').records.size, children * perChild, '真并发下一条都不许丢')

  const leftovers = readdirSync(dir).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'flush 完不该留锁文件或 tmp')
  assert.equal(existsSync(join(dir, 'global.jsonl.tmp')), false)
})
