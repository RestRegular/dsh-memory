/**
 * 面板 /memory/api 的 scope 行为测试(0.5.0)。
 *
 * 锁住三件事:
 *   1. 非法 scope → 400(SCOPE_INVALID),而不是被当成一个陌生 scope 去建文件;
 *   2. 合法但不存在的 scope → 空列表,而且**不创建**任何文件、不进作用域枚举;
 *   3. /status 每项都带展示 label(会话 scope 回退成「会话 <id 前 16 位>」)。
 * 顺带守着读路径无副作用这条:面板是"只看一眼"的界面,点开不该改磁盘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleRequest } from '../lib/index.js'
import { LocalMemoryService } from '../../memory-local/src/index.ts'

const ROUTE = '/memory/api'
const LOOPBACK = { host: '127.0.0.1:19387' }

/** 最小 ctx:memory 服务 + 没有宿主围栏(loopback 会被自建兜底放行)。 */
function ctxWith(service, extra = {}) {
  return {
    get: (name) => (name === 'memory' ? service : extra[name]),
    logger: { warn() {} },
    ...extra,
  }
}

/** 假 res:收集状态码与 JSON 体。 */
function fakeRes() {
  const out = { status: null, headers: null, body: null }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(text) { try { out.body = JSON.parse(text) } catch { out.body = text } },
  }
}

function get(url) {
  return { url, method: 'GET', headers: LOOPBACK }
}

/** POST + JSON body：面板的写接口只认这一种形状。 */
function post(url, body) {
  return {
    url,
    method: 'POST',
    headers: LOOPBACK,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
}

function makeService(dir, config = {}) {
  return new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true }, ...config })
}

test('面板 /records:非法 scope → 400 且不创建任何文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  try {
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/records?scope=../etc/passwd`), res)
    assert.equal(res.out.status, 400)
    assert.equal(res.out.body.ok, false)
    assert.equal(res.out.body.error.code, 'SCOPE_INVALID')
    assert.deepEqual(svc.store.allScopes(), [], '非法 scope 不该触发任何加载/创建')
    assert.ok(!existsSync(join(dir, 'projects')) || readdirSync(join(dir, 'projects')).length === 0, '磁盘上不该有文件')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /records:合法但不存在 → 空列表,不创建、不进作用域枚举', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  try {
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/records?scope=my%20notes`), res)
    assert.equal(res.out.status, 200)
    assert.deepEqual(res.out.body.value.records, [])
    assert.deepEqual(svc.store.allScopes(), [], 'peek 不该把不存在的 scope 加进 allScopes')
    assert.ok(!existsSync(join(dir, 'projects')) || readdirSync(join(dir, 'projects')).length === 0)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /records:scope=all 与不传 scope 都列出全部已发现记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  try {
    await svc.save({ scope: 'project:/w', kind: 'note', content: '项目记忆' })
    await svc.save({ scope: 'session:s1', kind: 'note', content: '会话记忆' })
    svc.store.flush()
    for (const url of [`${ROUTE}/records`, `${ROUTE}/records?scope=all`]) {
      const res = fakeRes()
      await handleRequest(ctxWith(svc), ROUTE, get(url), res)
      assert.equal(res.out.status, 200)
      const contents = res.out.body.value.records.map((r) => r.content).sort()
      assert.deepEqual(contents, ['会话记忆', '项目记忆'].sort(), url)
    }
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /status:每项 label 都带类型前缀(global: / project: / session: / custom:)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-'))
  const svc = makeService(dir)
  const cwd = process.cwd()
  svc.setProjectScope(`project:${cwd}`)
  try {
    await svc.save({ scope: 'global', kind: 'note', content: 'g' })
    await svc.save({ scope: `project:${cwd}`, kind: 'note', content: 'p' })
    await svc.save({ scope: 'session:sess-12345678', kind: 'note', content: 's' })
    await svc.save({ scope: 'my notes', kind: 'note', content: 'c' })
    svc.store.flush()
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/status`), res)
    assert.equal(res.out.status, 200)
    const labels = Object.fromEntries(res.out.body.value.scopes.map((s) => [s.scope, s.label]))
    assert.equal(labels['global'], 'global:全局', 'global 的键没有前缀,靠类型补')
    assert.equal(labels[`project:${cwd}`], `project:${cwd}`)
    assert.equal(labels['session:sess-12345678'], 'session:sess-12345678', '拿不到会话标题 → 前 16 位(这里是整个 id)')
    assert.equal(labels['my notes'], 'custom:my notes', '自定义 scope 的键没有前缀,靠类型补 custom:')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /status:带作用域用途(scope-meta 手写优先,没写过按类型给默认描述)', async () => {
  // 0.28.0:面板「记录 → 作用域」子标签页要展示用途,与 memory_scopes 目录同源。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  try {
    await svc.save({ scope: 'handbook', kind: 'note', content: 'x', scopeDescription: '团队约定与发布流程' })
    await svc.save({ scope: 'global', kind: 'note', content: 'g' })
    svc.store.flush()
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/status`), res)
    assert.equal(res.out.status, 200)
    const byScope = Object.fromEntries(res.out.body.value.scopes.map((s) => [s.scope, s]))
    assert.equal(byScope.handbook.description, '团队约定与发布流程', '手写的用途原样返回')
    assert.match(byScope.global.description, /全局作用域/, '没写过用途的作用域按类型给默认描述')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /status:删光记录但写过用途的作用域仍然列出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  try {
    const saved = await svc.save({ scope: 'empty-域', kind: 'note', content: '临时', scopeDescription: '只留用途的空作用域' })
    svc.store.flush()
    for (const store of svc.store.allScopes()) store.records.delete(saved.id)
    svc.store.flush()
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/status`), res)
    assert.equal(res.out.status, 200)
    const row = res.out.body.value.scopes.find((s) => s.scope === 'empty-域')
    assert.ok(row, '没有记录、但有元数据的作用域也在清单里')
    assert.equal(row.description, '只留用途的空作用域')
    assert.equal(row.records, 0)
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /scope-meta:用户编辑作用域用途与别名(0.29.0)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-meta-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  try {
    await svc.save({ scope: 'handbook', kind: 'note', content: 'x', scopeDescription: '旧用途' })
    svc.store.flush()

    // 只改用途
    let res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/scope-meta`, { scope: 'handbook', description: '团队约定与发布流程' }), res)
    assert.equal(res.out.status, 200)
    assert.deepEqual(res.out.body.value, { scope: 'handbook', description: '团队约定与发布流程' })
    assert.equal(svc.scopeMeta('handbook')?.description, '团队约定与发布流程')

    // 只改别名
    res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/scope-meta`, { scope: 'handbook', name: '工作手册' }), res)
    assert.equal(res.out.status, 200)
    assert.deepEqual(res.out.body.value, { scope: 'handbook', name: '工作手册' })
    assert.equal(svc.scopeName('handbook'), '工作手册')

    // 空串 = 移除别名
    res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/scope-meta`, { scope: 'handbook', name: '' }), res)
    assert.equal(res.out.status, 200)
    assert.deepEqual(res.out.body.value, { scope: 'handbook', name: '' })
    assert.equal(svc.scopeName('handbook'), undefined)

    // 保存后 /status 能看到新用途（面板编辑后重新拉列表就是这个口径）
    res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/status`), res)
    const row = res.out.body.value.scopes.find((item) => item.scope === 'handbook')
    assert.equal(row.description, '团队约定与发布流程')
    assert.equal(row.descriptionSource, 'custom')
    // 没写过用途的作用域标成默认描述，编辑框据此不预填
    await svc.save({ scope: 'global', kind: 'note', content: 'g' })
    svc.store.flush()
    res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/status`), res)
    const globalRow = res.out.body.value.scopes.find((item) => item.scope === 'global')
    assert.equal(globalRow.descriptionSource, 'default')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /scope-meta:不存在的 scope / 什么都没改 / 非法别名都明确拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-meta-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  try {
    await svc.save({ scope: 'handbook', kind: 'note', content: 'x', scopeDescription: '旧用途' })
    svc.store.flush()
    const request = async (body) => {
      const res = fakeRes()
      await handleRequest(ctxWith(svc), ROUTE, post(`${ROUTE}/scope-meta`, body), res)
      return res
    }
    assert.equal((await request({ scope: 'no-such-scope', description: 'x' })).out.status, 404, '目录里没有的 scope 不写元数据')
    assert.equal((await request({ scope: 'handbook' })).out.status, 400, '两个字段都没给')
    assert.equal((await request({ scope: '', description: 'x' })).out.status, 400)
    const invalid = await request({ scope: 'handbook', name: 'a/b' })
    assert.equal(invalid.out.status, 400)
    assert.equal(invalid.out.body.error.code, 'SCOPE_NAME_INVALID')
    assert.equal(svc.scopeName('handbook'), undefined, '非法别名不落盘')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /scope-meta:旧 provider 没有编辑接口时 501', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-meta-'))
  const svc = makeService(dir)
  try {
    const res = fakeRes()
    // 只实现只读能力的最小 provider
    const old = {
      scopeStats: () => [],
      scopeCatalog: () => [],
      store: svc.store,
    }
    await handleRequest(ctxWith(old), ROUTE, post(`${ROUTE}/scope-meta`, { scope: 'global', description: 'x' }), res)
    assert.equal(res.out.status, 501)
    assert.equal(res.out.body.error.code, 'NOT_SUPPORTED')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /status:会话 id 以 session- 开头时,回退标签取 16 位而不是被前缀占满', async () => {
  // 真机上的会话 id 形如 `session-1a2b3c4d-…`:前 8 位恒为 `session-`。
  // 只取 8 位会让每个会话作用域都显示成同一个名字,0.25.9 起取 16 位。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  try {
    await svc.save({ scope: 'session:session-1a2b3c4d-0000-4000-8000-000000000001', kind: 'note', content: 'a' })
    await svc.save({ scope: 'session:session-99887766-0000-4000-8000-000000000002', kind: 'note', content: 'b' })
    svc.store.flush()
    const res = fakeRes()
    await handleRequest(ctxWith(svc), ROUTE, get(`${ROUTE}/status`), res)
    assert.equal(res.out.status, 200)
    const labels = Object.fromEntries(res.out.body.value.scopes.map((s) => [s.scope, s.label]))
    assert.equal(labels['session:session-1a2b3c4d-0000-4000-8000-000000000001'], 'session:session-1a2b3c4d')
    assert.equal(labels['session:session-99887766-0000-4000-8000-000000000002'], 'session:session-99887766')
    const values = Object.values(labels)
    assert.equal(new Set(values.filter((label) => label.startsWith('session:session-'))).size, 2, '两个会话的作用域名不同')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /status:宿主提供 sessionTitle/sessions 时用会话标题', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  try {
    await svc.save({ scope: 'session:sess-abc12345', kind: 'note', content: 's' })
    svc.store.flush()
    const session = { id: 'sess-abc12345' }
    const ctx = ctxWith(svc, {
      sessions: { get: (id) => (id === 'sess-abc12345' ? session : undefined) },
      sessionTitle: { get: (s) => (s === session ? { title: '重构记忆作用域' } : undefined) },
    })
    const res = fakeRes()
    await handleRequest(ctx, ROUTE, get(`${ROUTE}/status`), res)
    const labels = Object.fromEntries(res.out.body.value.scopes.map((s) => [s.scope, s.label]))
    assert.equal(labels['session:sess-abc12345'], 'session:重构记忆作用域(sess-abc12345)', '标题也带 session: 前缀')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /status:会话标题服务抛错时回退,不影响响应', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  try {
    await svc.save({ scope: 'session:sess-zzz99999', kind: 'note', content: 's' })
    svc.store.flush()
    const ctx = ctxWith(svc, {
      sessions: { get: () => { throw new Error('boom') } },
    })
    const res = fakeRes()
    await handleRequest(ctx, ROUTE, get(`${ROUTE}/status`), res)
    assert.equal(res.out.status, 200)
    const labels = Object.fromEntries(res.out.body.value.scopes.map((s) => [s.scope, s.label]))
    assert.equal(labels['session:sess-zzz99999'], 'session:sess-zzz99999')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /status:超过 50 个会话 scope 时列表仍然完整,标题只查最近活跃的前 50 个', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  const TOTAL = 60
  const TITLED = 5
  try {
    for (let i = 0; i < TOTAL; i++) {
      const id = `s${String(i).padStart(2, '0')}sess`
      await svc.save({ scope: `session:${id}`, kind: 'note', content: `会话 ${i}` })
      // 最近活跃的排最前:前 5 个拿很大的 updatedAt,其余递减
      const rec = [...svc.store.peek(`session:${id}`)!.records.values()][0]!
      rec.updatedAt = i < TITLED ? 2_000_000_000_000 + i : 1_000_000_000_000 - i
    }
    svc.store.flush()

    const seen = []
    // id 形如 s00sess(7 个字符,短于展示用的 16 位,所以整段都是短 id)
    const shortOf = (n) => `s${String(n).padStart(2, '0')}sess`
    const scopesOf = (n) => `session:${shortOf(n)}`
    const liveIds = new Set(Array.from({ length: TITLED }, (_, i) => shortOf(i)))
    const ctx = ctxWith(svc, {
      sessions: {
        get(id) {
          seen.push(id)
          return liveIds.has(id) ? { id } : undefined
        },
      },
      sessionTitle: { get: (session) => ({ title: `标题-${session.id.slice(1, 3)}` }) },
    })
    const res = fakeRes()
    await handleRequest(ctx, ROUTE, get(`${ROUTE}/status`), res)
    assert.equal(res.out.status, 200)
    const scopes = res.out.body.value.scopes
    assert.equal(scopes.length, TOTAL, '完整返回所有作用域')
    const labels = Object.fromEntries(scopes.map((s) => [s.scope, s.label]))
    // 前 5 个(最近活跃)拿到标题
    for (let i = 0; i < TITLED; i++) {
      assert.equal(labels[scopesOf(i)], `session:标题-${String(i).padStart(2, '0')}(` + shortOf(i) + ')')
    }
    // 其余 55 个一律回退标签(一个都不缺)
    for (let i = TITLED; i < TOTAL; i++) {
      assert.equal(labels[scopesOf(i)], 'session:' + shortOf(i), `第 ${i} 个会话回退标签`)
    }
    assert.ok(seen.length <= 50, `标题查询次数受 50 上限约束,实际 ${seen.length}`)
    assert.equal(seen.length, 50, '50 个活跃会话都查了标题')
    assert.ok(!seen.includes('59sess'), '最后 10 个会话不查标题')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板 /status:discovery 结果有缓存,同一进程内不重复扫目录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-scope-'))
  const svc = makeService(dir)
  svc.setProjectScope('project:/w')
  try {
    await svc.save({ scope: 'handbook', kind: 'note', content: 'x' })
    svc.store.flush()
    // 计在 MemoryStore.loadDiscovered 上:不管从 /status 的哪条路径(面板自己的发现、
    // provider 的 scopeStats),真正的"读 projects/ 目录"都只会在缓存过期时发生一次。
    const original = svc.store.loadDiscovered.bind(svc.store)
    let scans = 0
    svc.store.loadDiscovered = () => { scans += 1; return original() }

    const ctx = ctxWith(svc)
    const request = async () => {
      const res = fakeRes()
      await handleRequest(ctx, ROUTE, get(`${ROUTE}/status`), res)
      assert.equal(res.out.status, 200)
      return res
    }
    const first = await request()
    assert.equal(scans, 1, '第一次请求做一次 discovery')
    assert.equal(first.out.body.value.scopes.length, 1, '第一次就拿到完整清单')
    for (let i = 0; i < 3; i++) await request()
    assert.equal(scans, 1, '3 秒缓存内的后续请求不再扫目录')
    assert.equal(svc.store.allScopes().length, 1, '清单仍然完整')
  } finally {
    svc.flushSync()
    rmSync(dir, { recursive: true, force: true })
  }
})
