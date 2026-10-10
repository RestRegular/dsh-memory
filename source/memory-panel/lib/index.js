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
    if (method === 'POST' && path === '/embed/install') {
      if (typeof memory.installVectorBackend !== 'function') throw new ApiError(501, 'NOT_SUPPORTED', 'provider 未提供自动安装接口（请升级 @restregular/dsh-memory）')
      memory.installVectorBackend()
      console.log('[dsh-memory-panel] 开始下载本地向量服务')
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
