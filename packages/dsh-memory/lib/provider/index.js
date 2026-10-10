/**
 * dsh-memory-local — local JSONL provider for the DSH memory service.
 *
 * This entry is intentionally cordis-free so unit tests and standalone tools
 * run without the harness. The Cordis wiring (Service subclass, effects,
 * plugin apply) lives in ./apply.ts and is only loaded inside DSH.
 */
             
            
                  
              
               
                  
              
                   
                   
import { MemoryStore,                 } from './store.js'
import { buildStats, lexicalScore, recordScore, tokenize, cosine, normalizeInPlace, hasStrongHit } from './scoring.js'
import { EmbedClient } from './embed.js'
import { DailyBudget, blendScores, rerank,                                   } from './rerank.js'
import { RerankCache } from './rerank-cache.js'
import { scanSecrets, redactSecrets } from './secrets.js'
import { EmbedServerManager,                                               } from './embed-server.js'

                                    
                                                  
                   
                                                  
               
                 
                    
                                                     
                            
                                                                                    
                             
                                
              
                       
                       
                    
                   
                                                            
                        
                                                               
                             
                                                                               
                                
                                                                             
                               
                       
                                
                                                                                      
                               
     
                               
   
                                                                   
                                                                           
                                                             
 

                                 
                  
                        
                         
              
                 
                         
                          
                      
           
                    
                    
                 
                
                     
                          
                             
                            
                    
                             
                            
   
                   
                            
                        
                                                          
 

export function resolveConfig(config                    = {})                 {
  const v = config.retrieval?.vector ?? {}
  return {
    storeDir: config.storeDir ?? '.dsh-memory',
    globalEnabled: config.scopes?.global ?? true,
    projectEnabled: config.scopes?.project ?? true,
    topK: config.retrieval?.topK ?? 5,
    recallN: config.retrieval?.recallN ?? 30,
    globalThreshold: config.retrieval?.globalThreshold ?? 0.12,
    projectThreshold: config.retrieval?.projectThreshold ?? 0.1,
    halfLifeDays: config.retrieval?.recencyHalfLifeDays ?? 30,
    vector: {
      enabled: v.enabled ?? true,
      endpoint: v.endpoint ?? 'http://127.0.0.1:8078/v1/embeddings',
      model: v.model ?? 'bge-m3',
      dims: v.dims ?? 1024,
      timeoutMs: v.timeoutMs ?? 300,
      // Full contents are orders of magnitude slower than a short query on CPU
      // (measured 3143ms for three ~600-char records), so write/backfill paths
      // get their own generous budgets instead of the interactive 300ms.
      writeTimeoutMs: v.writeTimeoutMs ?? 10_000,
      backfillTimeoutMs: v.backfillTimeoutMs ?? 30_000,
      backfillMaxChars: v.backfillMaxChars ?? 8_000,
      // BGE CLS baseline noise floor measured ~0.42 on unrelated pairs
      minScore: v.minScore ?? 0.5,
      backfillBatchSize: v.backfillBatchSize ?? 32,
      // Port defaults to the one in the embeddings endpoint so the two can never
      // drift apart; opt-in (enabled:false) keeps dev/test runs from spawning.
      spawn: {
        ...(v.spawn ?? {}),
        enabled: v.spawn?.enabled ?? false,
        port: v.spawn?.port ?? portOf(v.endpoint ?? 'http://127.0.0.1:8078/v1/embeddings') ?? 8078,
      },
    },
    llm: {
      enabled: config.retrieval?.llm?.enabled ?? false,
      provider: config.retrieval?.llm?.provider ?? '',
      model: config.retrieval?.llm?.model ?? '',
      timeoutMs: config.retrieval?.llm?.timeoutMs ?? 1500,
      dailyBudgetTokens: config.retrieval?.llm?.dailyBudgetTokens ?? 200_000,
      weight: config.retrieval?.llm?.weight ?? 0.6,
      topN: config.retrieval?.llm?.topN ?? 10,
    },
    maxRecordsPerScope: config.limits?.maxRecordsPerScope ?? 2000,
    maxRecordChars: config.limits?.maxRecordChars ?? 4000,
    secrets: {
      enabled: config.secrets?.enabled ?? true,
      mode: config.secrets?.mode ?? 'refuse',
    },
  }
}

export class LocalMemoryService                             {
           cfg                
           store             
           embed             
          rerankBudget             
          rerankCache = new RerankCache()
  /** Host-provided one-shot LLM call; null = rerank disabled (recall order). */
          llmInvoke                   = null
  /** Where saves land when the caller does not pin a scope. */
          defaultScope              = 'global'

  constructor(config                    = {}) {
    this.cfg = resolveConfig(config)
    this.rerankBudget = new DailyBudget(this.cfg.llm.dailyBudgetTokens)
    this.store = new MemoryStore(this.cfg.storeDir, { onWarn: (m) => console.warn(`[dsh-memory-local] ${m}`) })
    this.store.loadAll(this.cfg.projectEnabled && this.cfg.globalEnabled ? [this.defaultScope, 'global'] : [this.defaultScope])
    this.embed = new EmbedClient({
      endpoint: this.cfg.vector.endpoint,
      model: this.cfg.vector.model,
      dims: this.cfg.vector.dims,
      timeoutMs: this.cfg.vector.timeoutMs,
    })
    // sidecar validation: model/dims change discards old vectors on load
    this.store.setVecIdentity(this.cfg.vector.model, this.cfg.vector.dims)
    this.startMaintenance()
    this.startEmbedServer()
  }

  /** Own the embedding backend's lifetime: spawn on activation, stop on dispose. */
          startEmbedServer()       {
    this.embedServer = new EmbedServerManager(this.cfg.vector.spawn)
    // fire-and-forget: activation must never block on a model load
    void this.ensureEmbedServer(60_000).catch(() => { /* lifecycle never breaks activation */ })
  }

  /**
   * Start (or adopt) the embedding backend and arm the exit safety net.
   * Shared by the activation path and the panel's manual start button.
   */
          async ensureEmbedServer(waitMs         )                            {
    const mgr = this.embedServer
    if (!mgr) return 'disabled'
    const state = await mgr.ensureRunning()
    if (state !== 'spawned' && state !== 'adopted-managed') return state
    // hard-exit safety net: cordis disposal covers a clean quit; this covers
    // the host dying without disposing us (the child must not be orphaned)
    if (!this.exitHook) {
      this.exitHook = () => { this.embedServer?.stop() }
      process.once('exit', this.exitHook)
    }
    const ready = await mgr.waitUntilReady(waitMs)
    if (!ready) console.warn('[dsh-memory-local] embed server: 启动超时,检索继续走词法降级')
    return state
  }

  /** Manual start from the memory panel (same semantics as activation). */
  startEmbedServerManually()                            {
    return this.ensureEmbedServer(25_000)
  }

  /**
   * Manual stop from the memory panel. An instance we do not own is left alone
   * (it was started outside the app), so the UI can explain the refusal.
   */
  stopEmbedServerManually()                                                                                {
    const mgr = this.embedServer
    if (!mgr) return { stopped: false, reason: 'NOT_RUNNING' }
    if (!mgr.isOwned) return { stopped: false, reason: 'EXTERNAL_INSTANCE' }
    return { stopped: mgr.stop(), reason: mgr.isOwned ? 'NOT_RUNNING' : 'STOPPED' }
  }

  /** Lifecycle snapshot for the memory panel. */
  async embedServerStatus()           
                    
                  
                      
                   
                      
                         
     {
    const mgr = this.embedServer
    const pendingEmbeds = this.pendingEmbedCount
    if (!mgr) return { enabled: false, owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds }
    const reachable = await mgr.healthCheck()
    return { ...mgr.info(), reachable, pendingEmbeds }
  }

  /**
   * Hourly expired-record purge + capacity eviction. M4 housekeeping; the
   * timer is unref'd so it never holds the process open, and cleared by
   * flushSync()/dispose.
   */
          maintenanceTimer                                        = null

          startMaintenance()       {
    this.maintenanceTimer = setInterval(() => {
      this.store.purgeExpired()
      this.store.enforceLimit(this.cfg.maxRecordsPerScope)
      this.store.scheduleFlush(0)
    }, 3_600_000)
    this.maintenanceTimer.unref?.()
    // Pending-embed drain: the store queues ids whose embed failed (backend
    // down at save time, or vectors restored from a jsonl-only backup). Until
    // this timer existed nothing ever drained that queue — a single outage
    // stranded them forever (observable as 待嵌入>0 in the memory panel).
    this.embedRetryTimer = setInterval(() => {
      void this.retryPendingEmbeds().catch(() => {})
    }, 60_000)
    this.embedRetryTimer.unref?.()
    // First drain shortly after boot, when the backend is usually already up.
    const initial = setTimeout(() => {
      this.initialDrainTimer = null
      void this.retryPendingEmbeds().catch(() => {})
    }, 5_000)
    initial.unref?.()
    this.initialDrainTimer = initial
  }

          embedRetryTimer                                        = null
          initialDrainTimer                                       = null
  /** Owns the llama-server child process when vector.spawn.enabled. */
          embedServer                            = null
          exitHook                      = null

  /**
   * Drain the pending-embed queue, probing through the circuit breaker first so
   * a backend that came back online is noticed (backfillEmbeddings itself
   * refuses to touch the network while marked unhealthy, and embed() is the
   * only path that can flip that flag back to healthy).
   */
  async retryPendingEmbeds()                  {
    // Scopes load lazily, so without discovery the queue of an untouched scope
    // (e.g. a project store written by a previous session) is invisible here and
    // would never drain — exactly the 待嵌入>0 the panel showed on 2026-10-10.
    try { this.store.loadDiscovered() } catch { /* discovery is best-effort */ }
    if (this.pendingEmbedCount === 0) return 0
    if (!this.embed.isHealthy) {
      const probe = await this.embed.embed(['ping'], undefined, { timeoutMs: this.cfg.vector.writeTimeoutMs }).catch(() => null)
      if (!probe) return 0
    }
    return this.backfillAll({ throttleMs: 100 })
  }

  setDefaultScope(scope             )       {
    this.defaultScope = scope
  }

  /**
   * Provide the one-shot LLM caller used by the rerank stage. Passing null
   * (or never calling) keeps retrieval on recall-order only. The cordis
   * wiring adapts `ctx.llm` into this; it is optional by design — the service
   * must never sit PENDING just because no LLM adapter is loaded.
   */
  setLlmInvoke(invoke                  )       {
    this.llmInvoke = invoke
  }

  get activeDefaultScope()              {
    return this.defaultScope
  }

          assertScopeAllowed(scope             )       {
    if (scope === 'global' && !this.cfg.globalEnabled) {
      throw memoryError('SCOPE_DISABLED', 'global scope is disabled by configuration')
    }
    if (scope.startsWith('project:') && !this.cfg.projectEnabled) {
      throw memoryError('SCOPE_DISABLED', 'project scope is disabled by configuration')
    }
  }

  async save(input                 )                        {
    const scope = input.scope ?? this.defaultScope
    this.assertScopeAllowed(scope)
    let content = input.content?.trim()
    if (!content) throw memoryError('CONTENT_EMPTY', 'content must be a non-empty string')
    if (content.length > this.cfg.maxRecordChars) {
      throw memoryError('CONTENT_TOO_LONG', `content exceeds ${this.cfg.maxRecordChars} chars`)
    }
    if (input.supersedes && !this.store.scope(scope).records.get(input.supersedes)) {
      throw memoryError('SUPERSEDES_UNKNOWN', `supersedes target ${input.supersedes} not found in ${scope}`)
    }
    // design §11: keep credentials out of the plaintext store and the embedder
    if (this.cfg.secrets.enabled) {
      const findings = scanSecrets(content)
      if (findings.length > 0) {
        if (this.cfg.secrets.mode === 'refuse') {
          throw memoryError('SECRET_DETECTED', `content matches credential denylist: ${[...new Set(findings.map((f) => f.kind))].join(', ')}`)
        }
        content = redactSecrets(content)
      }
    }
    const { record } = this.store.save(
      { ...input, scope, content },
      { importance: input.source?.origin === 'auto' ? 0.4 : 0.8, source: { origin: 'explicit' } },
    )
    void this.embedRecord(record).catch(() => {})
    this.store.scheduleFlush()
    return record
  }

          async embedRecord(record              )                {
    const s = this.store.scope(record.scope)
    // save-time budget: one full record, much slower than a search query
    const vec = await this.embed.embed([record.content], undefined, { timeoutMs: this.cfg.vector.writeTimeoutMs }).catch(() => null)
    if (vec?.[0]) s.appendVector(record.id, normalizeInPlace(vec[0]))
    else s.embedPending.add(record.id) // backfill queue; the retry timer drains it
  }

  /**
   * Retry pending embeddings in batches; returns number embedded.
   * Batches are bounded by count AND total characters, and use the backfill
   * budget: full record contents on CPU take seconds per batch, so the
   * interactive timeout would abort every attempt.
   */
  async backfillEmbeddings()                  {
    if (!this.embed.isHealthy) return 0
    let done = 0
    for (const s of this.store.allScopes()) {
      if (s.embedPending.size === 0) continue
      const texts           = []
      const valid           = []
      let chars = 0
      for (const id of s.embedPending) {
        if (valid.length >= this.cfg.vector.backfillBatchSize) break
        const t = s.records.get(id)?.content
        if (!t) continue
        if (valid.length > 0 && chars + t.length > this.cfg.vector.backfillMaxChars) break
        texts.push(t)
        valid.push(id)
        chars += t.length
      }
      if (texts.length === 0) continue
      const vecs = await this.embed.embed(texts, undefined, { timeoutMs: this.cfg.vector.backfillTimeoutMs }).catch(() => null)
      if (!vecs) return done
      for (let i = 0; i < valid.length; i++) {
        if (s.records.has(valid[i] ) && vecs[i]) s.appendVector(valid[i] , normalizeInPlace(vecs[i] ))
        s.embedPending.delete(valid[i] )
        done++
      }
    }
    return done
  }

  /**
   * First-fill: embed the ENTIRE backlog (unlike backfillEmbeddings' single
   * batch per scope), in throttled batches so a big import does not hammer
   * llama-server or block the caller. Yields to the event loop between
   * batches and stops early on abort/unhealthy embedder.
   */
  async backfillAll(opts                                                = {})                  {
    const throttle = opts.throttleMs ?? 50
    let done = 0
    while (!opts.signal?.aborted) {
      const n = await this.backfillEmbeddings()
      done += n
      if (n === 0) break // per-scope batch was empty → backlog drained
      if (!this.embed.isHealthy) break
      await new Promise((r) => setTimeout(r, throttle))
    }
    return done
  }

  async search(query             )                       {
    const topK = query.topK ?? this.cfg.topK
    const recallN = query.recallN ?? this.cfg.recallN
    const now = Date.now()
    const queryTokens = [...new Set(tokenize(query.text))]

    // candidate scopes: pinned, else project + global
    const stores                                             = []
    if (query.scope) {
      stores.push({ store: this.store.scope(query.scope), isGlobal: query.scope === 'global' })
    } else {
      if (this.cfg.projectEnabled) stores.push({ store: this.store.scope(this.defaultScope), isGlobal: this.defaultScope === 'global' })
      if (this.cfg.globalEnabled) stores.push({ store: this.store.scope('global'), isGlobal: true })
    }

    // --- channel 1: lexical recall, scored per scope with local IDF ---
                                                                                
    const candidates = new Map              ()
    for (const { store, isGlobal } of stores) {
      const all = [...store.records.values()]
      const tokenSets = all.map((r) => new Set(tokenize(r.content)))
      const stats = buildStats(tokenSets)
      for (let i = 0; i < all.length; i++) {
        const rec = all[i] 
        if (rec.expiredAt && rec.expiredAt < now) continue
        const lex = lexicalScore(queryTokens, tokenSets[i] , stats)
        if (lex <= 0) continue
        // Weak-only overlap (no shared word/bigram) must clear the "real hit"
        // floor, not the permissive threshold — kills single-char collisions.
        const floor = isGlobal ? this.cfg.globalThreshold : this.cfg.projectThreshold
        const effective = hasStrongHit(queryTokens, tokenSets[i] ) ? floor : Math.max(floor, REAL_HIT_FLOOR)
        if (lex < effective) continue
        candidates.set(rec.id, { record: rec, recallScore: lex, isGlobal })
      }
    }

    // --- channel 2: vector recall over embedded records ---
    const qvec = await this.embed.embed([query.text], query.signal).catch(() => null)
    if (qvec?.[0]) {
      const vectorScores = new Map                ()
      for (const { store } of stores) {
        for (const [id, vec] of store.vectors) {
          if (!store.records.has(id)) continue
          const sim = cosine(qvec[0] , vec)
          if (sim >= this.cfg.vector.minScore) vectorScores.set(id, sim)
        }
      }
      for (const [id, sim] of vectorScores) {
        const existing = candidates.get(id)
        if (existing) {
          existing.recallScore = Math.max(existing.recallScore, sim) // best channel wins
        } else {
          const rec = this.findById(id)
          if (rec && !(rec.expiredAt && rec.expiredAt < now)) {
            if (!(rec.scope === 'global' && sim < this.cfg.globalThreshold)) {
              candidates.set(id, { record: rec, recallScore: sim, isGlobal: rec.scope === 'global' })
            }
          }
        }
      }
    }

    // shape with recency/importance, sort, cut
    const supersededIds = new Set        ()
    for (const { store } of stores) {
      for (const r of store.records.values()) if (r.supersedes) supersededIds.add(r.supersedes)
    }
    const shape = (c      )         =>
      recordScore(c.recallScore, c.record.importance, c.record.accessCount, c.record.lastAccessedAt, {
        now,
        halfLifeDays: this.cfg.halfLifeDays,
        superseded: supersededIds.has(c.record.id),
      })

    const ranked = [...candidates.values()].sort((a, b) => shape(b) - shape(a)).slice(0, recallN)

    // --- channel 3: LLM rerank (optional; any skip/failure keeps recall order) ---
    const finalScores = new Map                (ranked.map((c) => [c.id, shape(c)]))
    if (this.cfg.llm.enabled && this.llmInvoke && ranked.length >= 2) {
      const asCands = ranked.map((c) => ({ id: c.id, content: c.record.content, recallScore: finalScores.get(c.id)  }))
      const cacheKey = RerankCache.key(query.text, ranked.map((c) => c.id), this.cfg.llm.model)
      let outcome = this.rerankCache.get(cacheKey)
      if (!outcome) {
        outcome = await rerank({
          invoke: this.llmInvoke,
          cfg: this.cfg.llm,
          query: query.text,
          candidates: asCands,
          budget: this.rerankBudget,
          signal: query.signal,
        })
        if (outcome) this.rerankCache.set(cacheKey, outcome)
      }
      if (outcome) {
        for (const { id, score } of blendScores(asCands, outcome, this.cfg.llm.weight)) {
          finalScores.set(id, score)
        }
      }
    }

    const hits              = ranked.map((c) => ({ record: touch(c.record), score: round4(finalScores.get(c.id) ) }))

    this.store.scheduleFlush()
    return hits.slice(0, topK)
  }

          findById(id        )                           {
    for (const s of this.store.allScopes()) {
      const r = s.records.get(id)
      if (r) return r
    }
    return undefined
  }

  async forget(input                                                      )                                              {
    const ids           = []
    if (input.id) {
      for (const s of this.store.allScopes()) {
        if (s.remove(input.id)) ids.push(input.id)
      }
      if (ids.length === 0) throw memoryError('RECORD_NOT_FOUND', `id ${input.id} not found`)
    } else if (input.query) {
      const scope = input.scope ?? this.defaultScope
      ids.push(...this.store.findIdsByQuery(scope, input.query))
      const s = this.store.scope(scope)
      for (const id of ids) s.remove(id)
      if (ids.length === 0) throw memoryError('RECORD_NOT_FOUND', `no record matching query in ${scope}`)
    } else {
      throw memoryError('RECORD_NOT_FOUND', 'forget requires id or query')
    }
    this.store.scheduleFlush()
    return { removed: ids.length, ids }
  }

  async list(input                  = {})                          {
    const scope = input.scope ?? this.defaultScope
    let records = [...this.store.scope(scope).records.values()]
    if (input.kind) records = records.filter((r) => r.kind === input.kind)
    records.sort((a, b) => b.updatedAt - a.updatedAt)
    return records.slice(0, input.limit ?? 50)
  }

  /** Force a synchronous flush (dispose/HMR path). */
  flushSync()       {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer)
      this.maintenanceTimer = null
    }
    if (this.embedRetryTimer) {
      clearInterval(this.embedRetryTimer)
      this.embedRetryTimer = null
    }
    if (this.initialDrainTimer) {
      clearTimeout(this.initialDrainTimer)
      this.initialDrainTimer = null
    }
    if (this.embedServer) this.embedServer.stop()
    if (this.exitHook) {
      process.removeListener('exit', this.exitHook)
      this.exitHook = null
    }
    this.store.purgeExpired()
    this.store.enforceLimit(this.cfg.maxRecordsPerScope)
    this.store.close()
  }

  get pendingEmbedCount()         {
    return this.store.allScopes().reduce((n, s) => n + s.embedPending.size, 0)
  }
}

function touch(record              )               {
  record.lastAccessedAt = Date.now()
  record.accessCount += 1
  return record
}

function round4(n        )         {
  return Math.round(n * 10_000) / 10_000
}

/** Port of an http(s) endpoint, or null when it cannot be parsed. */
function portOf(endpoint        )                {
  try {
    const port = new URL(endpoint).port
    return port ? Number.parseInt(port, 10) : null
  } catch {
    return null
  }
}

/**
 * Measured score floor of genuine lexical hits; below this only single-char
 * coincidences live. Used to gate weak-only overlaps regardless of config.
 */
const REAL_HIT_FLOOR = 0.25

function memoryError(code        , message        )                           {
  const err = new Error(`[memory:${code}] ${message}`)                            
  err.code = code
  return err
}

export function createMemoryService(config                    = {})                     {
  return new LocalMemoryService(config)
}


//# sourceURL=D:\.deepseek\memory-plugin\packages\memory-local\src\index.ts