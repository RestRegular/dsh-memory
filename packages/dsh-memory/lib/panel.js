/**
 * dsh-memory-panel — 服务端(entry)。
 *
 * 架构照抄 dsh-meme 的铁律(2026-10-10 crash 的教训):
 *   - 不导出 inject:一切服务 ctx.get() 被动获取,缺谁就降级跳过,
 *     绝不让 fiber 进入 FAILED(desktop fail-loud,一个 entry 失败=整个应用起不来);
 *   - 路由注册 try/catch:冲突则复用/记日志,不抛;
 *   - apply 整体兜底 catch:任何意外都不允许向外抛。
 *
 * 提供管理员 API(前缀路由 /memory/api):
 *   GET  /status    各 scope 记录数 + 待嵌入数 + 展示标签
 *   GET  /records   ?scope=&q=  枚举/过滤记录
 *   POST /update    {id, content?, kind?, importance?, tags?, supersededBy?}
 *   POST /delete    {id}
 * scope 惰性加载是同步的(store.peek(),**读路径不创建**),无需 ready 门。内容编辑会作废旧
 * 向量并加入 embedPending,由 provider 的回填队列重新嵌入。
 *
 * 安全(每个路由都过 refuseRequest,见下):
 *   注册在裸 webServer 上的路由**既不在宿主的 /api 围栏之后,也不在浏览器登录
 *   之后** —— 宿主的围栏是一个给别的路由主动调用的服务方法(connection.requestRejection),
 *   不是自动套上的中间件(dsh-market #603 的结论:裸 webServer 路由在登录开启时
 *   可被无 session 调用 = 任意代码执行)。这里的读接口能读出全部记忆,写接口能改写、
 *   删除、清空,还能拉起/卸载向量服务,所以必须自己问一次。
 */
// scope 规范化与 provider 共用同一份实现。路径按**源码树位置**写:构建脚本的改写表
// 会把它落成产物里的 `../provider/scope.js`(`lib/panel.js` → `lib/provider/scope.js`),
// 在源码树里同一路径直接命中 source/memory-local/src —— 测试与真实加载都能解析。
import { normalizeScopeInput } from './provider/scope.js'


function writeJson(res, body, status = 200) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  } catch { /* 客户端已断开 */ }
}

/** provider 侧的"调用方输入有问题"错误码 → 400;其余未标注的仍算 500。 */
const CLIENT_ERROR_CODES = new Set([
  'SCOPE_INVALID', 'SCOPE_DISABLED', 'CONTENT_EMPTY', 'CONTENT_TOO_LONG',
  'SECRET_DETECTED', 'IMPORT_INVALID', 'IMPORT_TOO_LARGE', 'KIND_INVALID',
])

function writeError(res, error) {
  const code = typeof error?.code === 'string' ? error.code : 'internal'
  const status = Number(error?.status) || (CLIENT_ERROR_CODES.has(code) ? 400 : code === 'SCOPE_LIMIT' ? 409 : 500)
  writeJson(res, { ok: false, error: { code, message: error?.message || String(error) } }, status)
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 只认本机权威(loopback),没有宿主围栏时的兜底。 */
const LOOPBACK_AUTHORITY = /^(?:127(?:\.\d{1,3}){3}|\[::1\]|::1|localhost)(?::\d+)?$/i

/** 请求头里的 Host,小写归一;缺失返回空串。 */
function hostHeader(req) {
  const value = req?.headers?.host
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** 部署自己声明的权威(宿主 connection 的 trustedHosts);拿不到就空数组。 */
function trustedAuthorities(ctx) {
  try {
    const connection = ctx?.get?.('connection')
    return Array.isArray(connection?.trustedHosts)
      ? connection.trustedHosts.filter((entry) => typeof entry === 'string').map((entry) => entry.toLowerCase())
      : []
  } catch {
    return []
  }
}

/**
 * 该不该拒绝这个请求。
 *
 * 两层,顺序有讲究:
 *  1. 宿主发布了 connection.requestRejection 时**以它为准** —— 它同时含 Host/Origin
 *     围栏(防 DNS rebinding 与跨站调用)与浏览器登录(login-token cookie)。
 *     围栏自己抛错时返回 403:抛错意味着"什么都没放行",此处失败关闭,不能放行。
 *  2. 旧宿主没有这个服务时自己来:Host 必须是 loopback 或宿主声明的权威,
 *     sec-fetch-site 不得是 cross-site,带 Origin 就必须与 Host 相等。
 *     (注意 content-type: text/plain 也能携带合法 JSON 体且不触发预检,
 *      所以"要求 JSON 体"挡不住跨站 —— 承重的是 Host/Origin 这一层。)
 *
 * @returns 需要拒绝时返回状态码(401 未登录 / 403 不受信任),否则 undefined。
 */
export function refuseRequest(ctx, req) {
  let connection
  try { connection = ctx?.get?.('connection') } catch { connection = undefined }
  const gate = connection?.requestRejection
  if (typeof gate === 'function') {
    try {
      const status = gate.call(connection, req)
      return typeof status === 'number' ? status : undefined
    } catch {
      return 403
    }
  }
  const host = hostHeader(req)
  if (host === '') return 403
  if (!LOOPBACK_AUTHORITY.test(host) && !trustedAuthorities(ctx).includes(host)) return 403
  if (String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
  const origin = req?.headers?.origin
  if (origin !== undefined) {
    try {
      if (new URL(String(origin)).host.toLowerCase() !== host) return 403
    } catch {
      return 403
    }
  }
  return undefined
}

/** 拒绝时的响应体:给人话,不说内部概念。 */
function writeRefusal(res, status) {
  writeJson(res, {
    ok: false,
    error: {
      code: status === 401 ? 'LOGIN_REQUIRED' : 'UNTRUSTED_REQUEST',
      message: status === 401
        ? '需要先登录 DSH:请重新打开启动时打印的那个网址。'
        : '这个请求来自不受信任的来源,已拒绝。',
    },
  }, status)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.length > 0 ? JSON.parse(raw) : {}
}

/**
 * scope 键 → **不需要查宿主服务**的展示标签。
 *   global        → 「全局」
 *   project:<cwd> → cwd
 *   session:<id>  → 「会话 <id 前 8 位>」
 *   其他           → 原名(自定义 scope)
 */
function fallbackScopeLabel(scope) {
  if (scope === 'global') return '全局'
  if (scope.startsWith('project:')) return scope.slice('project:'.length)
  if (scope.startsWith('session:')) return `会话 ${scope.slice('session:'.length, 'session:'.length + 8)}`
  return scope
}

/**
 * scope 键 → 展示标签。在 fallback 之上多一步:会话 scope 尽力取会话标题
 * (宿主 `sessionTitle` 服务的 `get(session)` → `{ title }`,见 @deepseek-ai/dsh-session-title)。
 * 所有宿主服务访问都在 try/catch 里:面板绝不能因为拿不到标题而失败。
 */
function scopeLabel(ctx, scope) {
  if (!scope.startsWith('session:')) return fallbackScopeLabel(scope)
  const id = scope.slice('session:'.length)
  const short = id.slice(0, 8)
  try {
    const session = ctx?.get?.('sessions')?.get?.(id)
    if (session !== undefined) {
      const title = ctx.get('sessionTitle')?.get?.(session)?.title
      if (typeof title === 'string' && title.length > 0) return `${title}(${short})`
    }
  } catch { /* 标题是尽力而为 */ }
  return `会话 ${short}`
}

/** 会话 scope 查标题的上限:标题要读会话事件日志,scope 多了它就成了 /status 的大头。 */
const TITLE_LOOKUP_LIMIT = 50
/** discovery(读每个 scope 文件的第一条记录)结果的缓存时长。 */
const DISCOVER_CACHE_MS = 3000
/** 每个 memory 服务的发现缓存。面板看不到进程数,所以按服务实例各存一份。 */
const discoveryCache = new WeakMap()

/**
 * 发现磁盘上的 scope,3 秒内只做一次。
 * 面板每个请求都想要一份完整清单(别的进程写下的 scope 也要看得见),而 discovery 要
 * 读每个文件的第一条记录 —— 没有缓存的话刷新一下就是一次全目录扫描。
 */
function discoverScopes(memory, store) {
  const now = Date.now()
  const cached = discoveryCache.get(memory)
  if (cached !== undefined && now - cached.at < DISCOVER_CACHE_MS) return
  discoveryCache.set(memory, { at: now })
  try {
    if (typeof memory.discoverScopes === 'function') memory.discoverScopes()
    else store.loadDiscovered?.()
  } catch { /* discovery is best-effort */ }
}

function wireRecord(rec, scopeStore, supersededBy = null) {
  return {
    id: rec.id,
    scope: rec.scope,
    kind: rec.kind,
    content: rec.content,
    tags: rec.tags ?? [],
    importance: rec.importance,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    accessCount: rec.accessCount ?? 0,
    supersededBy,
    supersedes: rec.supersedes ?? null,
    embedded: !scopeStore.embedPending.has(rec.id) && scopeStore.vectors.has(rec.id),
  }
}

function collectScope(scopeStore) {
  // supersedes 是"新记录 → 旧记录"的指向;反查一次,给旧记录标上"已被修正"。
  const correctedBy = new Map()
  for (const rec of scopeStore.records.values()) {
    if (rec.supersedes) correctedBy.set(rec.supersedes, rec.id)
  }
  const out = []
  for (const rec of scopeStore.records.values()) out.push(wireRecord(rec, scopeStore, correctedBy.get(rec.id) ?? null))
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function handle(ctx, routePath, req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.local')
  const path = url.pathname.slice(routePath.length) || '/'
  const method = req.method ?? 'GET'
  // 围栏在最前面:任何路由(读也一样)都先过宿主,再谈记忆。
  const refused = refuseRequest(ctx, req)
  if (refused !== undefined) {
    writeRefusal(res, refused)
    return
  }
  try {
    const memory = ctx.get('memory')
    if (!memory?.store) throw new ApiError(503, 'MEMORY_UNAVAILABLE', 'memory provider 未加载')
    const store = memory.store
    // Scopes are created lazily, so a fresh process only knows the ones it has
    // touched. A management view must see everything written on disk (project
    // memories from earlier sessions included) — best-effort discovery, cached.
    discoverScopes(memory, store)

    if (method === 'GET' && path === '/status') {
      const stats = typeof memory.scopeStats === 'function'
        ? memory.scopeStats()
        : store.allScopes().map((s) => ({ scope: s.scope, records: s.records.size, pendingEmbeds: s.embedPending.size }))
      // 会话标题是尽力而为的增强,而且要读会话事件日志:只给最近活跃的前 N 个查,
      // 其余直接用「会话 <id 前 8 位>」。列表本身**始终**完整(不受这个上限影响)。
      const scopes = stats.map((s, index) => ({
        ...s,
        label: s.name ?? (index < TITLE_LOOKUP_LIMIT ? scopeLabel(ctx, s.scope) : fallbackScopeLabel(s.scope)),
      }))
      let embedServer = null
      // older providers have no lifecycle API — the panel simply omits the card
      try { embedServer = (await memory.embedServerStatus?.()) ?? null } catch { embedServer = null }
      let rules = null
      try { rules = typeof memory.ruleStats === 'function' ? memory.ruleStats() : null } catch { rules = null }
      writeJson(res, { ok: true, value: { scopes, embedServer, rules } })
      return
    }
    if (method === 'GET' && path === '/settings') {
      if (typeof memory.injectSettings !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供注入设置接口（请升级 @restregular/dsh-memory）')
      writeJson(res, { ok: true, value: memory.injectSettings() })
      return
    }
    if (method === 'POST' && path === '/settings') {
      if (typeof memory.updateInjectSettings !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供注入设置接口（请升级 @restregular/dsh-memory）')
      const body = await readJsonBody(req)
      writeJson(res, { ok: true, value: memory.updateInjectSettings(body) })
      return
    }
    if (method === 'POST' && path === '/create') {
      if (typeof memory.createRecord !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供新建接口（请升级 @restregular/dsh-memory）')
      const body = await readJsonBody(req)
      const record = await memory.createRecord({
        ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
        ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
        ...(typeof body.content === 'string' ? { content: body.content } : {}),
        ...(Array.isArray(body.tags) ? { tags: body.tags.map(String) } : {}),
        ...(typeof body.importance === 'number' ? { importance: body.importance } : {}),
      })
      console.log(`[dsh-memory-panel] 新建 ${record.kind} @ ${record.scope}: ${record.id}`)
      writeJson(res, { ok: true, value: { record } })
      return
    }
    if (method === 'GET' && path === '/export') {
      if (typeof memory.exportAll !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供导出接口（请升级 @restregular/dsh-memory）')
      writeJson(res, { ok: true, value: memory.exportAll() })
      return
    }
    if (method === 'POST' && path === '/import') {
      if (typeof memory.importRecords !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供导入接口（请升级 @restregular/dsh-memory）')
      const body = await readJsonBody(req)
      const result = await memory.importRecords(body)
      console.log(`[dsh-memory-panel] 导入完成: 新增 ${result.imported} / 跳过 ${result.skipped} / 失败 ${result.rejected}`)
      writeJson(res, { ok: true, value: result })
      return
    }
    if (method === 'GET' && path === '/embed/status') {      if (typeof memory.embedServerStatus !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供向量服务管理接口')
      writeJson(res, { ok: true, value: await memory.embedServerStatus() })
      return
    }
    if (method === 'POST' && path === '/embed/start') {
      if (typeof memory.startEmbedServerManually !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供向量服务管理接口')
      const state = await memory.startEmbedServerManually()
      console.log(`[dsh-memory-panel] 手动启动向量服务 -> ${state}`)
      writeJson(res, { ok: true, value: { state, ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'POST' && path === '/embed/stop') {
      if (typeof memory.stopEmbedServerManually !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供向量服务管理接口')
      const out = memory.stopEmbedServerManually()
      console.log(`[dsh-memory-panel] 手动停止向量服务 -> ${out.reason}`)
      writeJson(res, { ok: true, value: { ...out, ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'GET' && path === '/embed/model') {
      if (typeof memory.modelsReport !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供模型清单接口（请升级 @restregular/dsh-memory）')
      writeJson(res, { ok: true, value: await memory.modelsReport(false) })
      return
    }
    if (method === 'POST' && path === '/embed/model/refresh') {
      if (typeof memory.modelsReport !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供模型清单接口（请升级 @restregular/dsh-memory）')
      // 强制重探硬件:用户点了「重新检测」,缓存必须让路。
      writeJson(res, { ok: true, value: await memory.modelsReport(true) })
      return
    }
    if (method === 'POST' && path === '/embed/install') {
      if (typeof memory.installVectorBackend !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供自动安装接口（请升级 @restregular/dsh-memory）')
      // 面板可以带选择:预设 / 档位 / 风味,或者一个完全自定义的 GGUF。
      const body = await readJsonBody(req)
      const override = {}
      if (typeof body.preset === 'string' && body.preset !== '') override.preset = body.preset
      if (typeof body.variant === 'string' && body.variant !== '') override.variant = body.variant
      if (typeof body.flavor === 'string' && body.flavor !== '') override.flavor = body.flavor
      if (body.custom !== undefined && typeof body.custom === 'object' && body.custom !== null) {
        const url = String(body.custom.url ?? '')
        const dims = Number(body.custom.dims)
        if (url === '' || !Number.isFinite(dims) || dims <= 0) throw new ApiError(400, 'CUSTOM_MODEL_INVALID', '自定义模型需要 url 与 dims')
        override.custom = {
          url,
          dims,
          ...(body.custom.file ? { file: String(body.custom.file) } : {}),
          ...(body.custom.pooling ? { pooling: String(body.custom.pooling) } : {}),
        }
      }
      memory.installVectorBackend(override)
      console.log(`[dsh-memory-panel] 开始下载向量服务 ${JSON.stringify(override)}`)
      writeJson(res, { ok: true, value: { ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'POST' && path === '/embed/install/cancel') {
      if (typeof memory.cancelVectorInstall !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供自动安装接口（请升级 @restregular/dsh-memory）')
      memory.cancelVectorInstall()
      console.log('[dsh-memory-panel] 取消下载本地向量服务')
      writeJson(res, { ok: true, value: { ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'POST' && path === '/embed/uninstall') {
      if (typeof memory.uninstallVectorBackend !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供卸载接口（请升级 @restregular/dsh-memory）')
      const out = memory.uninstallVectorBackend()
      console.log(`[dsh-memory-panel] 卸载向量服务 -> ${out.reason}，释放 ${(out.freedBytes / 1048576).toFixed(1)} MB`)
      writeJson(res, { ok: true, value: { ...out, ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'POST' && path === '/embed/reindex') {
      if (typeof memory.reindexAll !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供向量重建接口（请升级 @restregular/dsh-memory）')
      // 同步部分只作废旧向量 + 排队,真正的重嵌在后台跑,不阻塞请求;进度看 /status 的待嵌入计数。
      const result = memory.reindexAll() ?? {}
      const total = typeof result.total === 'number' ? result.total : 0
      console.log(`[dsh-memory-panel] 开始重建全部向量:${total} 条`)
      writeJson(res, { ok: true, value: { scheduled: true, records: total } })
      return
    }
    if (method === 'POST' && path === '/data/wipe') {
      if (typeof memory.wipeAllRecords !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供数据清理接口（请升级 @restregular/dsh-memory）')
      const body = await readJsonBody(req)
      // Deleting everything is irreversible: require the caller to say so out
      // loud, not just to click a button.
      if (String(body.confirm ?? '') !== 'delete') throw new ApiError(400, 'CONFIRM_REQUIRED', '需要 confirm: "delete" 才执行删除')
      const out = memory.wipeAllRecords()
      console.log(`[dsh-memory-panel] 清空记忆数据 -> ${out.removed} 条 / ${out.scopes.length} 个作用域`)
      writeJson(res, { ok: true, value: { ...out, ...(await memory.embedServerStatus()) } })
      return
    }
    if (method === 'GET' && path === '/records') {
      const rawScope = url.searchParams.get('scope')
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      // scope 先过同一套规范化:非法 → 400(而不是当成一个陌生 scope 去建文件);
      // 合法但不存在的 scope → 空列表。`peek`/`peekScope`,**绝不通过 store.scope() 创建**。
      let scope = null
      if (rawScope !== null && rawScope.trim() !== '') {
        const normalized = normalizeScopeInput(rawScope)
        if (!normalized.ok) throw new ApiError(400, normalized.code, normalized.message)
        if (normalized.kind === 'all') {
          scope = null // 全部
        } else if (normalized.kind === 'current-session' || normalized.kind === 'current-project') {
          // 面板不在某个 agent 里:按 provider 的读取集合解析('project' → 当前项目键);
          // 解析不出会话时就退化为全部,而不是报错。
          const refs = typeof memory.resolveReadScopes === 'function' ? memory.resolveReadScopes(undefined) : []
          scope = refs.length > 0 ? refs : null
        } else {
          scope = normalized.scope ?? null
        }
      } else {
        scope = null
      }
      const stores = scope === null
        ? store.allScopes()
        : (Array.isArray(scope) ? scope : [scope])
            .map((s) => store.peek(s))
            .filter((s) => s !== undefined)
      let records = []
      for (const s of stores) records.push(...collectScope(s))
      if (query) {
        records = records.filter((r) =>
          r.content.toLowerCase().includes(query)
          || r.kind.toLowerCase().includes(query)
          || r.tags.some((t) => t.toLowerCase().includes(query)))
      }
      writeJson(res, { ok: true, value: { records } })
      return
    }
    if (method === 'POST' && path === '/update') {
      const body = await readJsonBody(req)
      const id = String(body.id ?? '')
      let target = null
      for (const s of store.allScopes()) {
        const rec = s.records.get(id)
        if (rec) { target = { s, rec }; break }
      }
      if (!target) throw new ApiError(404, 'RECORD_NOT_FOUND', `no record ${id}`)
      const { s, rec } = target
      let reindex = false
      if (body.content !== undefined) {
        const content = String(body.content)
        if (!content.trim()) throw new ApiError(400, 'CONTENT_EMPTY', 'content 不能为空')
        if (content !== rec.content) {
          rec.content = content
          // 旧向量作废:内存 + 磁盘一起丢掉(vectorsDirty),再排队重建。
          // 只删内存不标 dirty 的话,重启后 load 会看到旧向量、把它当成"已嵌入"。
          s.vectors.delete(id)
          s.vectorsDirty = true
          s.embedPending.add(id)
          reindex = true
        }
      }
      if (body.kind !== undefined) rec.kind = String(body.kind)
      if (body.importance !== undefined) rec.importance = Math.min(1, Math.max(0, Number(body.importance) || 0))
      if (body.tags !== undefined) rec.tags = Array.isArray(body.tags) ? body.tags.map(String) : []
      if (body.supersededBy !== undefined) rec.supersedes = body.supersededBy === null ? undefined : String(body.supersededBy)
      rec.updatedAt = Date.now()
      s.dirty = true
      store.scheduleFlush()
      // 立即重建向量(不等 60s 的定时回填);失败就留在 pending 里由重试兜底。
      if (reindex && typeof memory.reindexRecord === 'function') {
        void memory.reindexRecord(rec.scope, id).catch(() => {})
      }
      writeJson(res, { ok: true, value: { record: wireRecord(rec, s) } })
      return
    }
    if (method === 'POST' && path === '/delete') {
      const body = await readJsonBody(req)
      let removed = false
      for (const s of store.allScopes()) {
        if (s.records.has(String(body.id))) { removed = s.remove(String(body.id)); break }
      }
      if (!removed) throw new ApiError(404, 'RECORD_NOT_FOUND', `no record ${body.id}`)
      store.scheduleFlush()
      writeJson(res, { ok: true, value: { removed: 1 } })
      return
    }
    throw new ApiError(404, 'not_found', `unknown endpoint ${method} ${path}`)
  } catch (error) {
    ctx?.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
    writeError(res, error)
  }
}

export const name = 'dsh-memory-panel'
/** 路由处理器(导出供测试直接调用:围栏、规范化、peek 行为都在这里)。 */
export { handle as handleRequest }
export function apply(ctx, config = {}) {
  const routePath = String(config.route || '/memory/api').replace(/\/$/, '')
  try {
    // 动态注入(cordis ctx.inject):webServer 已就绪则立即回调,否则等它出现,
    // 不阻塞 entry 激活,也绝不让缺服务变成 fiber FAILED(dsh-client-modules 同款)。
    ctx.inject(['webServer'], (svcCtx) => {
      try {
        const webServer = svcCtx.get('webServer')
        if (!webServer || typeof webServer.register !== 'function') {
          console.log('[dsh-memory-panel] webServer 不可用,面板 API 不注册(记忆工具不受影响)')
          return
        }
        webServer.register({
          kind: 'prefix',
          path: routePath,
          // returning the promise is ignored by the http server but makes the
          // handler awaitable in tests/host-sim
          handler: (req, res) => Promise.resolve(handle(ctx, routePath, req, res))
            .catch((error) => writeError(res, error)),
        })
        console.log(`[dsh-memory-panel] 路由已注册 ${routePath}`)
      } catch (error) {
        console.log('[dsh-memory-panel] 路由注册失败(可能已存在,复用):', error?.message)
      }
    })
  } catch (error) {
    // 铁律:面板绝不允许把异常抛回 cordis(desktop fail-loud 会拖垮整个启动)
    console.error('[dsh-memory-panel] apply 意外失败(已吞掉,不影响启动):', error?.message)
  }
}


//# sourceURL=source/memory-panel/lib/index.js