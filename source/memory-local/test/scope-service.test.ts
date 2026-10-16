/**
 * 会话作用域 / 自定义作用域 / 多 scope 合并 的服务层与工具层测试(0.5.0)。
 *
 * 覆盖的是 0.5.0 的核心承诺:
 *   - 写入默认落"当前会话",拿不到会话回退项目 scope(绝不报错);
 *   - 自定义 scope 首次写入才落盘,读路径绝不创建文件;
 *   - scopes.custom.max 只管自定义 scope,会话/project/global 不受限;
 *   - 默认检索 = 会话 + 项目 + global 合并去重;'all' 跨全部;
 *   - 旧文件(projects/<sha1>.jsonl + project:<cwd>)照常读写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { memoryTools } from '../../tool-memory/src/index.ts'

const PROJECT = 'project:/w'
const SESSION = 'session:sess-1'
const SESSION2 = 'session:sess-2'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-scopes-'))
}

function newService(dir, extra = {}) {
  const svc = new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true }, ...extra })
  svc.setDefaultScope('session')
  svc.setProjectScope(PROJECT)
  return svc
}

/** agent 上下文的最小形态(宿主里就是 agent.session.header)。 */
const agent = (id, extra = {}) => ({ session: { header: { id, ...extra } } })

function toolsFor(svc) {
  return memoryTools({ getService: () => svc as never, defaultScope: 'session', projectScope: PROJECT })
}

function projectFiles(dir) {
  const p = join(dir, 'projects')
  return existsSync(p) ? readdirSync(p) : []
}

// ------------------------------------------------------------------ 写入默认 / 回退

test('save 默认落当前会话;拿不到会话时回退项目 scope 且不抛错', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    const tools = toolsFor(svc)
    const inSession = await tools.memory_save.execute({ content: '会话内的一条' }, { agent: agent('sess-1') })
    assert.equal(inSession.scope, SESSION)
    const noAgent = await tools.memory_save.execute({ content: '没有 agent 上下文的一条' })
    assert.equal(noAgent.scope, PROJECT, '拿不到会话 → project')
    const brokenAgent = await tools.memory_save.execute({ content: 'agent 形态意外' }, { agent: { session: {} } })
    assert.equal(brokenAgent.scope, PROJECT)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scopes.session=false 时写回退项目 scope', async () => {
  const dir = tempDir()
  const svc = newService(dir, { scopes: { global: true, project: true, session: false } })
  try {
    const tools = toolsFor(svc)
    const saved = await tools.memory_save.execute({ content: '会话被关掉' }, { agent: agent('sess-1') })
    assert.equal(saved.scope, PROJECT)
    // 显式写一个会话 scope 才报 SCOPE_DISABLED(省略/裸 'session' 是回退,不是报错)
    await assert.rejects(
      () => svc.save({ scope: SESSION, kind: 'note', content: '显式写会话' }),
      (e: Error & { code?: string }) => e.code === 'SCOPE_DISABLED',
    )
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('子代理会话映射到父会话 key(共享父会话的记忆)', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    const tools = toolsFor(svc)
    const sub = await tools.memory_save.execute(
      { content: '子代理记的东西' },
      { agent: agent('sub-9', { origin: 'subagent', parentSession: 'parent-3' }) },
    )
    assert.equal(sub.scope, 'session:parent-3')
    const hits = await svc.search({ text: '子代理记的东西', scopes: ['session:parent-3', PROJECT, 'global'] })
    assert.equal(hits.length, 1)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 自定义 scope

test('自定义 scope:首次写入落盘,重启后能被 peek 读到', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    svc.store.flush()
    const before = projectFiles(dir).length
    await svc.save({ scope: 'my notes', kind: 'note', content: '自定义作用域里的一条' })
    svc.store.flush()
    assert.equal(projectFiles(dir).length, before + 1, '首次写入才创建文件')

    const reopened = newService(dir)
    try {
      assert.equal(reopened.store.peek('my notes')?.records.size, 1, 'peek 能从磁盘读回自定义 scope')
      const records = await reopened.list({ scope: 'my notes' })
      assert.equal(records.length, 1)
      assert.equal(records[0]!.content, '自定义作用域里的一条')
    } finally {
      reopened.flushSync()
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读不存在的 scope 不创建文件、不进 allScopes、返回空', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    svc.store.flush()
    const filesBefore = projectFiles(dir).length
    assert.deepEqual(await svc.list({ scope: 'nope' }), [])
    assert.deepEqual(await svc.search({ text: 'anything', scope: 'nope' }), [])
    assert.deepEqual(svc.store.allScopes(), [], 'peek 不该把不存在的 scope 加进来')
    assert.equal(svc.store.peek('session:sess-x'), undefined)
    assert.equal(projectFiles(dir).length, filesBefore, '磁盘上不该出现新文件')
    await assert.rejects(
      () => svc.forget({ query: 'anything', scope: 'nope' }),
      (e: Error & { code?: string }) => e.code === 'RECORD_NOT_FOUND',
    )
    assert.equal(projectFiles(dir).length, filesBefore, 'forget 读路径也不创建')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scopes.custom.max:达到上限后拒绝新建,但仍可写已存在的;会话 scope 不受限', async () => {
  const dir = tempDir()
  const svc = newService(dir, { scopes: { global: true, project: true, custom: { enabled: true, max: 2 } } })
  try {
    await svc.save({ scope: 'one', kind: 'note', content: 'a' })
    await svc.save({ scope: 'two', kind: 'note', content: 'b' })
    // 已存在的自定义 scope 继续写,不受限
    await svc.save({ scope: 'one', kind: 'note', content: 'a2' })
    await assert.rejects(
      () => svc.save({ scope: 'three', kind: 'note', content: 'c' }),
      (e: Error & { code?: string }) => e.code === 'SCOPE_LIMIT',
    )
    // 会话与项目 scope 既不计入也不受限
    await svc.save({ scope: SESSION, kind: 'note', content: 'session ok' })
    await svc.save({ scope: SESSION2, kind: 'note', content: 'session2 ok' })
    await svc.save({ scope: PROJECT, kind: 'note', content: 'project ok' })
    await svc.save({ scope: 'global', kind: 'note', content: 'global ok' })
    assert.equal(svc.store.customScopeCount(), 2)

    // 重启后计数依然来自磁盘(不能只数内存)
    svc.store.flush()
    const reopened = newService(dir, { scopes: { global: true, project: true, custom: { enabled: true, max: 2 } } })
    try {
      await assert.rejects(
        () => reopened.save({ scope: 'four', kind: 'note', content: 'd' }),
        (e: Error & { code?: string }) => e.code === 'SCOPE_LIMIT',
      )
    } finally {
      reopened.flushSync()
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scopes.custom.enabled=false 时自定义 scope 写被拒(旧配置布尔简写也认)', async () => {
  const dir = tempDir()
  const svc = newService(dir, { scopes: { global: true, project: true, custom: false } })
  const svc2 = newService(dir, { scopes: { global: true, project: true, custom: { enabled: false } } })
  try {
    for (const s of [svc, svc2]) {
      await assert.rejects(
        () => s.save({ scope: 'blocked', kind: 'note', content: 'x' }),
        (e: Error & { code?: string }) => e.code === 'SCOPE_DISABLED',
      )
    }
  } finally {
    svc.flushSync()
    svc2.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 检索 / 列表 / 遗忘

test('默认检索合并会话 + 项目 + global,并按 record id 去重', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    svc.store.flush()
    await svc.save({ scope: SESSION, kind: 'note', content: 'postgres 索引优化 会话版' })
    await svc.save({ scope: PROJECT, kind: 'note', content: 'postgres 索引优化 项目版' })
    await svc.save({ scope: 'global', kind: 'note', content: 'postgres 索引优化 全局版' })
    await svc.save({ scope: 'other', kind: 'note', content: 'postgres 索引优化 别的作用域' })
    const tools = toolsFor(svc)
    const res = await tools.memory_search.execute({ query: 'postgres 索引优化', topK: 20 }, { agent: agent('sess-1') })
    const scopes = res.records.map((r) => r.scope).sort()
    assert.deepEqual(scopes, [PROJECT, SESSION, 'global'].sort(), '默认三路合并,不含其它自定义 scope')
    assert.equal(new Set(res.records.map((r) => r.id)).size, res.records.length, '不重复')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scope:all 跨全部已发现 scope;显式 scope 只查那一个', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    svc.store.flush()
    await svc.save({ scope: SESSION, kind: 'note', content: 'sqlite 迁移 会话' })
    await svc.save({ scope: 'handbook', kind: 'note', content: 'sqlite 迁移 手册' })
    const tools = toolsFor(svc)
    const all = await tools.memory_search.execute({ query: 'sqlite 迁移', scope: 'all' }, { agent: agent('sess-1') })
    assert.deepEqual(all.records.map((r) => r.scope).sort(), [SESSION, 'handbook'].sort())
    const pinned = await tools.memory_search.execute({ query: 'sqlite 迁移', scope: 'handbook' }, { agent: agent('sess-1') })
    assert.deepEqual(pinned.records.map((r) => r.scope), ['handbook'])
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同分时稳定 tie-break:session 优先于 global', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    svc.store.flush()
    await svc.save({ scope: 'global', kind: 'note', content: '索引设计原则' })
    await svc.save({ scope: SESSION, kind: 'note', content: '索引设计原则' })
    const hits = await svc.search({ text: '索引设计原则', scopes: [SESSION, 'global'] })
    assert.equal(hits.length, 2)
    assert.equal(hits[0]!.record.scope, SESSION, '同分时会话排前面')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('forget({query}) 默认只作用于当前会话;"all"+query 被拒', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    await svc.save({ scope: SESSION, kind: 'note', content: '临时凭据 会话' })
    await svc.save({ scope: PROJECT, kind: 'note', content: '临时凭据 项目' })
    const tools = toolsFor(svc)
    const out = await tools.memory_forget.execute({ query: '临时凭据' }, { agent: agent('sess-1') })
    assert.equal(out.removed, 1, '只删会话里那条')
    assert.equal((await svc.list({ scope: PROJECT })).length, 1, '项目那条必须还在')
    await assert.rejects(
      () => tools.memory_forget.execute({ query: '临时凭据', scope: 'all' }, { agent: agent('sess-1') }),
      (e: Error & { code?: string }) => e.code === 'SCOPE_NOT_WRITABLE',
    )
    // 显式 scope 才跨出会话
    const out2 = await tools.memory_forget.execute({ query: '临时凭据', scope: 'project' }, { agent: agent('sess-1') })
    assert.equal(out2.removed, 1)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory_list 默认只列当前会话,并带上作用域清单', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    await svc.save({ scope: SESSION, kind: 'note', content: '会话里的' })
    await svc.save({ scope: PROJECT, kind: 'note', content: '项目里的' })
    const tools = toolsFor(svc)
    const res = await tools.memory_list.execute({}, { agent: agent('sess-1') })
    assert.deepEqual(res.records.map((r) => r.scope), [SESSION], '默认只列当前会话')
    assert.ok(Array.isArray(res.scopeStats) && res.scopeStats.length >= 2, '带作用域清单')
    const all = await tools.memory_list.execute({ scope: 'all' }, { agent: agent('sess-1') })
    assert.deepEqual(all.records.map((r) => r.scope).sort(), [PROJECT, SESSION].sort())
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store.save 绝不把 agent 上下文写进记录(落盘 JSONL 与返回的 record 都没有 agent)', async () => {
  const dir = tempDir()
  const svc = newService(dir)
  try {
    // 工具层会把宿主 exec.agent 随 input 透给 provider(默认 scope 要靠它解析),
    // 所以这里锁住"store 自己构造 record"这条契约:多出来的字段不能跟着落盘。
    const { record } = svc.store.save(
      { scope: SESSION, kind: 'note', content: '带 agent 上下文保存的一条', agent: agent('sess-1') },
      { importance: 0.5, source: { origin: 'explicit' } },
    )
    assert.equal('agent' in record, false, '返回的 record 不能带 agent')
    assert.equal(JSON.stringify(record).includes('"agent"'), false)
    svc.store.flush()
    const file = join(dir, 'projects', `${createHash('sha1').update(SESSION).digest('hex')}.jsonl`)
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    assert.equal(lines.length, 1)
    const onDisk = JSON.parse(lines[0]!)
    assert.equal(onDisk.agent, undefined, '落盘的行不能带 agent')
    assert.equal(lines[0]!.includes('"agent"'), false)
    assert.equal(onDisk.content, '带 agent 上下文保存的一条', '其余字段照常')
    assert.equal(onDisk.scope, SESSION)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('作用域清单来自磁盘(别的进程写下的 scope 也能列出来)', async () => {
  const dir = tempDir()
  const writer = newService(dir)
  try {
    await writer.save({ scope: 'handbook', kind: 'note', content: '别的进程写的' })
    await writer.save({ scope: SESSION, kind: 'note', content: '别的进程写的会话记忆' })
    writer.flushSync()
  } finally {
    writer.flushSync()
  }
  // 全新进程:store 是懒加载的,清单必须先 discovery 才不会漏
  const fresh = newService(dir)
  try {
    assert.deepEqual(fresh.store.allScopes(), [], '起始什么都没加载')
    const stats = fresh.scopeStats()
    assert.deepEqual(stats.map((s) => s.scope).sort(), [SESSION, 'handbook'].sort())
    assert.deepEqual(fresh.store.allScopes().map((s) => s.scope).sort(), [SESSION, 'handbook'].sort(), '发现后可以被 peek 到')
    // discovery 有 3 秒缓存:紧接着再来几次不该再读目录
    const original = fresh.store.loadDiscovered.bind(fresh.store)
    let scans = 0
    fresh.store.loadDiscovered = () => { scans += 1; return original() }
    for (let i = 0; i < 4; i++) fresh.scopeStats()
    assert.equal(scans, 0, '缓存窗口内不再扫目录')
    assert.deepEqual(fresh.scopeStats().map((s) => s.scope).sort(), [SESSION, 'handbook'].sort(), '缓存期内清单仍然完整')
    assert.deepEqual(fresh.discoverScopes().sort(), [SESSION, 'handbook'].sort(), 'discoverScopes 同样受缓存约束且返回完整清单')
    assert.equal(scans, 0)
  } finally {
    fresh.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 旧数据兼容

test('旧文件兼容:已存在的 projects/<sha1>.jsonl(project:<cwd>)仍可读写并出现在默认检索里', async () => {
  const dir = tempDir()
  const legacyScope = PROJECT
  const file = join(dir, 'projects', `${createHash('sha1').update(legacyScope).digest('hex')}.jsonl`)
  const record = {
    id: 'legacy-1',
    scope: legacyScope,
    kind: 'fact',
    content: '旧版本写下的项目记忆',
    tags: [],
    source: { origin: 'explicit' },
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
    importance: 0.5,
  }
  const svc = newService(dir)
  try {
    writeFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    const tools = toolsFor(svc)
    // 默认检索要能命中旧文件(它是 project 作用域)
    const hits = await tools.memory_search.execute({ query: '旧版本写下的项目记忆', topK: 5 }, { agent: agent('sess-fresh') })
    assert.equal(hits.records.length, 1)
    assert.equal(hits.records[0]!.id, 'legacy-1')
    assert.equal(hits.records[0]!.scope, legacyScope)
    // 旧文件仍可写:同一 scope 再存一条,文件里应有两行
    await svc.save({ scope: legacyScope, kind: 'note', content: '新写的一条项目记忆' })
    svc.store.flush()
    assert.equal((await svc.list({ scope: legacyScope })).length, 2)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scope 数上限只影响自定义 scope:会话 scope 数量增长不受限', async () => {
  const dir = tempDir()
  const svc = newService(dir, { scopes: { global: true, project: true, custom: { enabled: true, max: 1 } } })
  try {
    await svc.save({ scope: 'only-custom', kind: 'note', content: 'x' })
    for (let i = 0; i < 30; i++) {
      await svc.save({ scope: `session:s${i}`, kind: 'note', content: `会话 ${i}` })
    }
    assert.equal(svc.store.customScopeCount(), 1)
    assert.equal(svc.store.allScopes().filter((s) => s.scope.startsWith('session:')).length, 30)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
