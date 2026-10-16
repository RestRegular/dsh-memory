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
 *   GET  /status    各 scope 记录数 + 待嵌入数
 *   GET  /records   ?scope=&q=  枚举/过滤记录
 *   POST /update    {id, content?, kind?, importance?, tags?, supersededBy?}
 *   POST /delete    {id}
 * scope 惰性加载是同步的(store.scope()),无需 ready 门。内容编辑会作废旧向量
 * 并加入 embedPending,由 provider 的回填队列重新嵌入。
 *
 * 安全(每个路由都过 refuseRequest,见下):
 *   注册在裸 webServer 上的路由**既不在宿主的 /api 围栏之后,也不在浏览器登录
 *   之后** —— 宿主的围栏是一个给别的路由主动调用的服务方法(connection.requestRejection),
 *   不是自动套上的中间件(dsh-market #603 的结论:裸 webServer 路由在登录开启时
 *   可被无 session 调用 = 任意代码执行)。这里的读接口能读出全部记忆,写接口能改写、
 *   删除、清空,还能拉起/卸载向量服务,所以必须自己问一次。
 */

function writeJson(res, body, status = 200) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  } catch { /* 客户端已断开 */ }
}

function writeError(res, error) {
  const status = Number(error?.status) || 500
  writeJson(res, { ok: false, error: { code: error?.code || 'internal', message: error?.message || String(error) } }, status)
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

function wireRecord(rec, scopeStore) {
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
    supersededBy: rec.supersededBy ?? null,
    supersedes: rec.supersedes ?? null,
    embedded: !scopeStore.embedPending.has(rec.id) && scopeStore.vectors.has(rec.id),
  }
}

function collectScope(scopeStore) {
  const out = []
  for (const rec of scopeStore.records.values()) out.push(wireRecord(rec, scopeStore))
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
    // memories from earlier sessions included) — best-effort discovery.
    try { store.loadDiscovered?.() } catch { /* discovery is best-effort */ }

    if (method === 'GET' && path === '/status') {
      const scopes = store.allScopes().map((s) => ({
        scope: s.scope,
        records: s.records.size,
        pendingEmbeds: s.embedPending.size,
      }))
      let embedServer = null
      // older providers have no lifecycle API — the panel simply omits the card
      try { embedServer = (await memory.embedServerStatus?.()) ?? null } catch { embedServer = null }
      writeJson(res, { ok: true, value: { scopes, embedServer } })
      return
    }
    if (method === 'GET' && path === '/embed/status') {
      if (typeof memory.embedServerStatus !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供向量服务管理接口')
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
      const scope = url.searchParams.get('scope')
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const stores = scope ? [store.scope(scope)] : store.allScopes()
      let records = stores.flatMap((s) => collectScope(s))
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
      if (body.content !== undefined) {
        const content = String(body.content)
        if (!content.trim()) throw new ApiError(400, 'CONTENT_EMPTY', 'content 不能为空')
        if (content !== rec.content) {
          rec.content = content
          // 旧向量作废,排队重新嵌入(provider 的维护循环负责回填)
          s.vectors.delete(id)
          s.embedPending.add(id)
        }
      }
      if (body.kind !== undefined) rec.kind = String(body.kind)
      if (body.importance !== undefined) rec.importance = Math.min(1, Math.max(0, Number(body.importance) || 0))
      if (body.tags !== undefined) rec.tags = Array.isArray(body.tags) ? body.tags.map(String) : []
      if (body.supersededBy !== undefined) rec.supersedes = body.supersededBy === null ? undefined : String(body.supersededBy)
      rec.updatedAt = Date.now()
      s.dirty = true
      store.scheduleFlush()
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
