/**
 * dsh-memory-local — local JSONL provider for the DSH memory service.
 *
 * This entry is intentionally cordis-free so unit tests and standalone tools
 * run without the harness. The Cordis wiring (Service subclass, effects,
 * plugin apply) lives in ./apply.ts and is only loaded inside DSH.
 */
import type {
  MemoryHit,
  MemoryListInput,
  MemoryQuery,
  MemoryRecord,
  MemorySaveInput,
  MemoryScope,
  MemoryServiceApi,
} from 'dsh-memory'
import { MemoryStore, type ScopeStore } from './store.ts'
import { buildStats, lexicalScore, recordScore, tokenize, cosine, normalizeInPlace, hasStrongHit } from './scoring.ts'
import { EmbedClient } from './embed.ts'
import { DailyBudget, blendScores, rerank, type LlmInvoke, type RerankConfig } from './rerank.ts'
import { RerankCache } from './rerank-cache.ts'
import { scanSecrets, redactSecrets } from './secrets.ts'
import { EmbedServerManager, type EmbedServerConfig, type EmbedServerState } from './embed-server.ts'
import { VectorInstaller, detectInstalled, installPaths, type InstallProgress } from './embed-install.ts'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Recursive byte count; 0 for anything unreadable. */
function pathSize(path: string): number {
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const entry of readdirSync(path)) total += pathSize(join(path, entry))
    return total
  } catch {
    return 0
  }
}

/** True when `child` is `parent` or lives under it (both resolved). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface MemoryLocalConfig {
  /** Store root directory. Created if missing. */
  storeDir?: string
  scopes?: { global?: boolean; project?: boolean }
  retrieval?: {
    topK?: number
    recallN?: number
    /** Lexical floor for global-scope candidates. */
    globalThreshold?: number
    /** Lexical floor for project-scope candidates (more permissive than global). */
    projectThreshold?: number
    recencyHalfLifeDays?: number
    vector?: {
      enabled?: boolean
      endpoint?: string
      model?: string
      dims?: number
      /** Interactive (search-query) budget — keep tight. */
      timeoutMs?: number
      /** Budget for embedding one full record at save time. */
      writeTimeoutMs?: number
      /** Budget for a backfill batch; full record contents are much slower. */
      backfillTimeoutMs?: number
      /** Character ceiling per backfill batch, so one call stays bounded. */
      backfillMaxChars?: number
      minScore?: number
      backfillBatchSize?: number
      /** Manage the llama-server process lifecycle (spawn on start, stop on exit). */
      spawn?: EmbedServerConfig
      /**
       * Where the panel's one-click installer puts llama.cpp + the GGML model.
       * Defaults to the store's parent directory (so the layout is
       * `<root>/llamacpp/llama-server*` + `<root>/models/*.gguf`, matching a
       * hand-made install). Existing files there are adopted automatically —
       * nothing is ever downloaded unless the user clicks the button.
       */
      autoInstall?: {
        dir?: string
        /**
         * Model download URLs tried in order. Defaults to hf-mirror →
         * ModelScope → huggingface.co: the official host is unreachable from
         * mainland China, and the first two serve the identical GGUF.
         */
        modelSources?: string[]
      }
    }
    llm?: Partial<RerankConfig>
  }
  limits?: { maxRecordsPerScope?: number; maxRecordChars?: number }
  /** Secret handling (design §11). Default: refuse obvious credentials. */
  secrets?: { mode?: 'refuse' | 'redact'; enabled?: boolean }
}

export interface ResolvedConfig {
  storeDir: string
  globalEnabled: boolean
  projectEnabled: boolean
  topK: number
  recallN: number
  globalThreshold: number
  projectThreshold: number
  halfLifeDays: number
  vector: {
    enabled: boolean
    /** true when the user actually pointed us at a backend (endpoint and/or spawn) */
    configured: boolean
    endpointConfigured: boolean
    spawnConfigured: boolean
    /** Where the panel's one-click installer puts (or already found) a backend. */
    installRoot: string
    /** Model URLs the installer tries in order (undefined → built-in fallbacks). */
    installModelSources?: string[]
    endpoint: string
    model: string
    dims: number
    timeoutMs: number
    writeTimeoutMs: number
    backfillTimeoutMs: number
    backfillMaxChars: number
    minScore: number
    backfillBatchSize: number
    spawn: EmbedServerConfig
  }
  llm: RerankConfig
  maxRecordsPerScope: number
  maxRecordChars: number
  secrets: { enabled: boolean; mode: 'refuse' | 'redact' }
}

export function resolveConfig(config: MemoryLocalConfig = {}): ResolvedConfig {
  const v = config.retrieval?.vector ?? {}
  // Do not touch an embedding backend the user never asked for: pointing at the
  // stock localhost endpoint on a machine that has nothing listening means
  // failed embeds, a tripped breaker and scary log lines for a feature that is
  // optional. Vector retrieval is therefore opt-in by CONFIGURATION — writing
  // `endpoint` (any OpenAI-compatible service), configuring `spawn`, or having
  // the panel's installer put a backend on disk implies intent; an explicit
  // `enabled` always wins.
  const storeDir = config.storeDir ?? '.dsh-memory'
  // Installer target: explicit config → that directory; explicit storeDir →
  // its parent (so a hand-made `<root>/llamacpp` + `<root>/models` layout is
  // recognised as-is); otherwise a stable per-user directory under ~/.dsh.
  const installRoot = v.autoInstall?.dir
    ?? (config.storeDir !== undefined ? dirname(resolve(storeDir)) : join(homedir(), '.dsh', 'memory-vector'))
  const installed = detectInstalled(installRoot)
  const endpointConfigured = v.endpoint !== undefined
  // A configured spawn path that no longer exists (plugin uninstalled the
  // backend, or the user moved it) must not count as configured: that would
  // leave the panel showing a managed server that can never start, instead of
  // offering the download button again.
  const spawnExe = v.spawn?.exe
  const spawnExeUsable = spawnExe === undefined || spawnExe === '' || existsSync(spawnExe)
  const spawnConfigured = ((v.spawn?.enabled === true || (spawnExe ?? '') !== '') && spawnExeUsable) || installed !== null
  const configured = endpointConfigured || spawnConfigured
  const vectorEnabled = v.enabled ?? configured
  return {
    storeDir,
    globalEnabled: config.scopes?.global ?? true,
    projectEnabled: config.scopes?.project ?? true,
    topK: config.retrieval?.topK ?? 5,
    recallN: config.retrieval?.recallN ?? 30,
    globalThreshold: config.retrieval?.globalThreshold ?? 0.12,
    projectThreshold: config.retrieval?.projectThreshold ?? 0.1,
    halfLifeDays: config.retrieval?.recencyHalfLifeDays ?? 30,
    vector: {
      enabled: vectorEnabled,
      configured,
      endpointConfigured,
      spawnConfigured,
      installRoot,
      ...(v.autoInstall?.modelSources ? { installModelSources: v.autoInstall.modelSources } : {}),
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
      // A backend the panel installed (or a hand-made one at installRoot) is
      // adopted as the spawn target when the user configured no explicit paths.
      spawn: {
        ...(v.spawn ?? {}),
        enabled: v.spawn?.enabled ?? installed !== null,
        ...(installed
          ? {
              exe: v.spawn?.exe ?? installed.exe,
              model: v.spawn?.model ?? installed.model,
              cwd: v.spawn?.cwd ?? installed.cwd,
              logFile: v.spawn?.logFile ?? installed.logFile,
            }
          : {}),
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

export class LocalMemoryService implements MemoryServiceApi {
  readonly cfg: ResolvedConfig
  readonly store: MemoryStore
  readonly embed: EmbedClient
  private rerankBudget: DailyBudget
  private rerankCache = new RerankCache()
  /** Host-provided one-shot LLM call; null = rerank disabled (recall order). */
  private llmInvoke: LlmInvoke | null = null
  /** Where saves land when the caller does not pin a scope. */
  private defaultScope: MemoryScope = 'global'

  constructor(config: MemoryLocalConfig = {}) {
    this.cfg = resolveConfig(config)
    this.rerankBudget = new DailyBudget(this.cfg.llm.dailyBudgetTokens)
    this.store = new MemoryStore(this.cfg.storeDir, { onWarn: (m) => console.warn(`[dsh-memory-local] ${m}`) })
    // Identity BEFORE the eager load (issue #1): ScopeStore skips its sidecar
    // validation entirely while the identity is unset (`if (this.vecIdentity && …)`),
    // so loading first would accept vectors from a previous embedding model
    // whenever the dimensions matched — and the next flush would then rewrite the
    // header as the new model, making the mismatch permanent.
    this.store.setVecIdentity(this.cfg.vector.model, this.cfg.vector.dims)
    this.store.loadAll(this.cfg.projectEnabled && this.cfg.globalEnabled ? [this.defaultScope, 'global'] : [this.defaultScope])
    this.embed = new EmbedClient({
      endpoint: this.cfg.vector.endpoint,
      model: this.cfg.vector.model,
      dims: this.cfg.vector.dims,
      timeoutMs: this.cfg.vector.timeoutMs,
    })
    this.startMaintenance()
    this.startEmbedServer()
  }

  /** Own the embedding backend's lifetime: spawn on activation, stop on dispose. */
  private startEmbedServer(): void {
    // Nothing configured and retrieval switched off → do not even build the
    // manager, so no probe, no spawn attempt, no misleading panel state.
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return
    this.embedServer = new EmbedServerManager(this.cfg.vector.spawn)
    // fire-and-forget: activation must never block on a model load
    void this.ensureEmbedServer(60_000).catch(() => { /* lifecycle never breaks activation */ })
  }

  /**
   * Start (or adopt) the embedding backend and arm the exit safety net.
   * Shared by the activation path and the panel's manual start button.
   */
  private async ensureEmbedServer(waitMs?: number): Promise<EmbedServerState> {
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
  startEmbedServerManually(): Promise<EmbedServerState> {
    return this.ensureEmbedServer(25_000)
  }

  /**
   * Manual stop from the memory panel. An instance we do not own is left alone
   * (it was started outside the app), so the UI can explain the refusal.
   */
  stopEmbedServerManually(): { stopped: boolean; reason: 'STOPPED' | 'EXTERNAL_INSTANCE' | 'NOT_RUNNING' } {
    const mgr = this.embedServer
    if (!mgr) return { stopped: false, reason: 'NOT_RUNNING' }
    if (!mgr.isOwned) return { stopped: false, reason: 'EXTERNAL_INSTANCE' }
    return { stopped: mgr.stop(), reason: mgr.isOwned ? 'NOT_RUNNING' : 'STOPPED' }
  }

  /**
   * Lifecycle snapshot for the memory panel.
   *
   * `mode` is what the panel needs to decide whether a start/stop switch even
   * makes sense:
   *   - 'off'      nothing configured → no switch, show how to opt in
   *   - 'external' we only know an endpoint (cloud or a server the user runs)
   *                → no switch, we must not claim ownership of that process
   *   - 'managed'  spawn is configured → the switch toggles OUR child process
   * `enabled` is the retrieval switch from config; when it is false while a
   * backend IS configured the panel explains the config instead of showing a
   * switch that cannot turn retrieval on.
   */
  async embedServerStatus(): Promise<{
    enabled: boolean
    configured: boolean
    mode: 'off' | 'external' | 'managed'
    endpoint: string
    model: string
    spawnConfigured: boolean
    owned: boolean
    pid: number | null
    baseUrl: string
    reachable: boolean
    pendingEmbeds: number
    install: InstallProgress & { installed: boolean; root: string }
    /** What an uninstall would free, and how much data a wipe would remove. */
    maintenance: { usageBytes: number; paths: string[]; storeDir: string; records: number }
  }> {
    const mgr = this.embedServer
    const cfg = this.cfg.vector
    const pendingEmbeds = this.pendingEmbedCount
    const mode = !cfg.configured ? 'off' : cfg.spawnConfigured ? 'managed' : 'external'
    const usage = this.vectorInstallUsage()
    const base = {
      enabled: cfg.enabled,
      configured: cfg.configured,
      mode,
      endpoint: cfg.endpoint,
      model: cfg.model,
      spawnConfigured: cfg.spawnConfigured,
      pendingEmbeds,
      install: this.installSnapshot(),
      maintenance: {
        usageBytes: usage.bytes,
        paths: usage.paths,
        // NOTE: `cfg` is the VECTOR config here, not the whole config — reading
        // cfg.storeDir would silently yield undefined (and JSON drops it).
        storeDir: this.cfg.storeDir,
        records: this.store.allScopes().reduce((n, s) => n + s.records.size, 0),
      },
    } as const
    if (!mgr) return { ...base, owned: false, pid: null, baseUrl: '', reachable: false }
    const reachable = await mgr.healthCheck()
    return { ...base, ...mgr.info(), reachable, pendingEmbeds }
  }

  /** Installer state for the panel (idle when nothing was ever requested). */
  private installSnapshot(): InstallProgress & { installed: boolean; root: string } {
    const root = this.cfg.vector.installRoot
    const installed = detectInstalled(root) !== null
    const progress = this.installer?.progress ?? {
      phase: 'idle' as const,
      message: '',
      receivedBytes: 0,
      totalBytes: null,
      error: null,
      paths: installed ? installPaths(root) : null,
    }
    return { ...progress, installed, root }
  }

  /**
   * Panel action: download llama.cpp + the GGML model into installRoot, then
   * adopt them (start the managed server). Never runs on its own — a fresh
   * install downloads nothing until the user asks.
   */
  installVectorBackend(): void {
    if (detectInstalled(this.cfg.vector.installRoot)) {
      this.adoptInstalledBackend()
      return
    }
    if (!this.installer) {
      this.installer = new VectorInstaller({
        root: this.cfg.vector.installRoot,
        ...(this.cfg.vector.installModelSources ? { modelSources: this.cfg.vector.installModelSources } : {}),
        onProgress: (progress) => {
          if (progress.phase === 'done') this.adoptInstalledBackend()
        },
      })
    }
    this.installer.start()
  }

  /** Panel action: abort an in-flight download. */
  cancelVectorInstall(): void {
    this.installer?.cancel()
  }

  /**
   * What the installer put on disk, so the panel can say "释放 xxx MB" before
   * offering to remove it. Counts only our own layout (runtime dir, models dir,
   * log + pid), never the memory store.
   */
  vectorInstallUsage(): { bytes: number; paths: string[] } {
    const paths = installPaths(this.cfg.vector.installRoot)
    const roots = [paths.dir, join(this.cfg.vector.installRoot, 'models')]
    const files = [paths.logFile, `${paths.logFile}.pid`, `${paths.logFile}.err`]
    let bytes = 0
    const seen: string[] = []
    for (const p of [...roots, ...files]) {
      if (!existsSync(p)) continue
      seen.push(p)
      bytes += pathSize(p)
    }
    return { bytes, paths: seen }
  }

  /**
   * Remove the vector backend we installed (runtime + model + logs).
   *
   * Refuses when the configured backend lives outside installRoot: that is a
   * server the user installed and manages, and deleting it would be destroying
   * something we never created. The memory store is never touched — it lives
   * beside the runtime, not inside it.
   */
  uninstallVectorBackend(): {
    removed: boolean
    reason: 'REMOVED' | 'NOT_INSTALLED' | 'EXTERNAL_BACKEND'
    freedBytes: number
    paths: string[]
  } {
    const root = this.cfg.vector.installRoot
    const configuredExe = this.cfg.vector.spawn.exe
    if (configuredExe && !isInside(root, configuredExe)) {
      return { removed: false, reason: 'EXTERNAL_BACKEND', freedBytes: 0, paths: [] }
    }
    const usage = this.vectorInstallUsage()
    if (usage.paths.length === 0) {
      return { removed: false, reason: 'NOT_INSTALLED', freedBytes: 0, paths: [] }
    }
    // Stop our child first: on Windows the executable and its DLLs are locked
    // while it runs, so removal would fail with EBUSY/EPERM.
    try { this.embedServer?.stop() } catch { /* best effort */ }
    const removedPaths: string[] = []
    for (const p of usage.paths) {
      // Belt and braces: never step outside the install root, and never delete
      // the memory store even if someone pointed storeDir inside it.
      if (!isInside(root, p)) continue
      if (isInside(p, this.cfg.storeDir) || resolve(p) === resolve(this.cfg.storeDir)) continue
      try {
        rmSync(p, { recursive: true, force: true })
        removedPaths.push(p)
      } catch { /* leave it; the panel reports what went */ }
    }
    this.cfg.vector.configured = false
    this.cfg.vector.spawnConfigured = false
    this.cfg.vector.enabled = false
    this.embedServer = null
    return { removed: true, reason: 'REMOVED', freedBytes: usage.bytes, paths: removedPaths }
  }

  /**
   * Delete every memory record in every scope (the panel's "delete all data"
   * action, used when someone wants the plugin gone without leaving notes
   * behind). Goes through the store so the JSONL + vector sidecars stay
   * consistent instead of ripping files out from under a live store.
   */
  wipeAllRecords(): { removed: number; scopes: string[] } {
    let removed = 0
    const scopes: string[] = []
    for (const scope of this.store.allScopes()) {
      const ids = [...scope.records.keys()]
      if (ids.length === 0) continue
      let local = 0
      for (const id of ids) if (scope.remove(id)) local += 1
      removed += local
      scopes.push(scope.scope)
    }
    try { this.store.flushSync() } catch { /* scheduled flush covers it */ }
    return { removed, scopes }
  }

  /**
   * Switch the provider over to a backend that is now on disk: fill the spawn
   * config from the installed layout and start it. Idempotent.
   */
  private adoptInstalledBackend(): void {
    const paths = detectInstalled(this.cfg.vector.installRoot)
    if (!paths) return
    this.cfg.vector.configured = true
    this.cfg.vector.spawnConfigured = true
    this.cfg.vector.enabled = true
    this.cfg.vector.spawn = {
      ...this.cfg.vector.spawn,
      enabled: true,
      exe: this.cfg.vector.spawn.exe ?? paths.exe,
      model: this.cfg.vector.spawn.model ?? paths.model,
      cwd: this.cfg.vector.spawn.cwd ?? paths.cwd,
      logFile: this.cfg.vector.spawn.logFile ?? paths.logFile,
      port: this.cfg.vector.spawn.port,
    }
    if (!this.embedServer) {
      this.startEmbedServer()
      return
    }
    void this.ensureEmbedServer(60_000).catch(() => { /* panel shows the outcome */ })
  }

  /**
   * Hourly expired-record purge + capacity eviction. M4 housekeeping; the
   * timer is unref'd so it never holds the process open, and cleared by
   * flushSync()/dispose.
   */
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null

  private startMaintenance(): void {
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

  private embedRetryTimer: ReturnType<typeof setInterval> | null = null
  private initialDrainTimer: ReturnType<typeof setTimeout> | null = null
  /** Owns the llama-server child process when vector.spawn.enabled. */
  private embedServer: EmbedServerManager | null = null
  /** Lazily created by the panel's "download and configure" action. */
  private installer: VectorInstaller | null = null
  private exitHook: (() => void) | null = null

  /**
   * Drain the pending-embed queue, probing through the circuit breaker first so
   * a backend that came back online is noticed (backfillEmbeddings itself
   * refuses to touch the network while marked unhealthy, and embed() is the
   * only path that can flip that flag back to healthy).
   */
  async retryPendingEmbeds(): Promise<number> {
    // Vector retrieval opt-in: with no configured backend there is nothing to
    // retry, and probing would only produce failed requests in the log.
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return 0
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

  setDefaultScope(scope: MemoryScope): void {
    this.defaultScope = scope
  }

  /**
   * Provide the one-shot LLM caller used by the rerank stage. Passing null
   * (or never calling) keeps retrieval on recall-order only. The cordis
   * wiring adapts `ctx.llm` into this; it is optional by design — the service
   * must never sit PENDING just because no LLM adapter is loaded.
   */
  setLlmInvoke(invoke: LlmInvoke | null): void {
    this.llmInvoke = invoke
  }

  get activeDefaultScope(): MemoryScope {
    return this.defaultScope
  }

  private assertScopeAllowed(scope: MemoryScope): void {
    if (scope === 'global' && !this.cfg.globalEnabled) {
      throw memoryError('SCOPE_DISABLED', 'global scope is disabled by configuration')
    }
    if (scope.startsWith('project:') && !this.cfg.projectEnabled) {
      throw memoryError('SCOPE_DISABLED', 'project scope is disabled by configuration')
    }
  }

  async save(input: MemorySaveInput): Promise<MemoryRecord> {
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

  private async embedRecord(record: MemoryRecord): Promise<void> {
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return
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
  async backfillEmbeddings(): Promise<number> {
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return 0
    if (!this.embed.isHealthy) return 0
    let done = 0
    for (const s of this.store.allScopes()) {
      if (s.embedPending.size === 0) continue
      const texts: string[] = []
      const valid: string[] = []
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
        if (s.records.has(valid[i]!) && vecs[i]) s.appendVector(valid[i]!, normalizeInPlace(vecs[i]!))
        s.embedPending.delete(valid[i]!)
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
  async backfillAll(opts: { signal?: AbortSignal; throttleMs?: number } = {}): Promise<number> {
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

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const topK = query.topK ?? this.cfg.topK
    const recallN = query.recallN ?? this.cfg.recallN
    const now = Date.now()
    const queryTokens = [...new Set(tokenize(query.text))]

    // candidate scopes: pinned, else project + global
    const stores: { store: ScopeStore; isGlobal: boolean }[] = []
    if (query.scope) {
      stores.push({ store: this.store.scope(query.scope), isGlobal: query.scope === 'global' })
    } else {
      if (this.cfg.projectEnabled) stores.push({ store: this.store.scope(this.defaultScope), isGlobal: this.defaultScope === 'global' })
      if (this.cfg.globalEnabled) stores.push({ store: this.store.scope('global'), isGlobal: true })
    }

    // --- channel 1: lexical recall, scored per scope with local IDF ---
    type Cand = { record: MemoryRecord; recallScore: number; isGlobal: boolean }
    const candidates = new Map<string, Cand>()
    for (const { store, isGlobal } of stores) {
      const all = [...store.records.values()]
      const tokenSets = all.map((r) => new Set(tokenize(r.content)))
      const stats = buildStats(tokenSets)
      for (let i = 0; i < all.length; i++) {
        const rec = all[i]!
        if (rec.expiredAt && rec.expiredAt < now) continue
        const lex = lexicalScore(queryTokens, tokenSets[i]!, stats)
        if (lex <= 0) continue
        // Weak-only overlap (no shared word/bigram) must clear the "real hit"
        // floor, not the permissive threshold — kills single-char collisions.
        const floor = isGlobal ? this.cfg.globalThreshold : this.cfg.projectThreshold
        const effective = hasStrongHit(queryTokens, tokenSets[i]!) ? floor : Math.max(floor, REAL_HIT_FLOOR)
        if (lex < effective) continue
        candidates.set(rec.id, { record: rec, recallScore: lex, isGlobal })
      }
    }

    // --- channel 2: vector recall over embedded records ---
    // Skipped entirely when no backend is configured (lexical recall above
    // already produced the candidates; a request here would just fail).
    const qvec = this.cfg.vector.enabled && this.cfg.vector.configured
      ? await this.embed.embed([query.text], query.signal).catch(() => null)
      : null
    if (qvec?.[0]) {
      const vectorScores = new Map<string, number>()
      for (const { store } of stores) {
        for (const [id, vec] of store.vectors) {
          if (!store.records.has(id)) continue
          const sim = cosine(qvec[0]!, vec)
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
    const supersededIds = new Set<string>()
    for (const { store } of stores) {
      for (const r of store.records.values()) if (r.supersedes) supersededIds.add(r.supersedes)
    }
    const shape = (c: Cand): number =>
      recordScore(c.recallScore, c.record.importance, c.record.accessCount, c.record.lastAccessedAt, {
        now,
        halfLifeDays: this.cfg.halfLifeDays,
        superseded: supersededIds.has(c.record.id),
      })

    const ranked = [...candidates.values()].sort((a, b) => shape(b) - shape(a)).slice(0, recallN)

    // --- channel 3: LLM rerank (optional; any skip/failure keeps recall order) ---
    const finalScores = new Map<string, number>(ranked.map((c) => [c.id, shape(c)]))
    if (this.cfg.llm.enabled && this.llmInvoke && ranked.length >= 2) {
      const asCands = ranked.map((c) => ({ id: c.id, content: c.record.content, recallScore: finalScores.get(c.id)! }))
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

    const hits: MemoryHit[] = ranked.map((c) => ({ record: touch(c.record), score: round4(finalScores.get(c.id)!) }))

    this.store.scheduleFlush()
    return hits.slice(0, topK)
  }

  private findById(id: string): MemoryRecord | undefined {
    for (const s of this.store.allScopes()) {
      const r = s.records.get(id)
      if (r) return r
    }
    return undefined
  }

  async forget(input: { id?: string; query?: string; scope?: MemoryScope }): Promise<{ removed: number; ids: string[] }> {
    const ids: string[] = []
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

  async list(input: MemoryListInput = {}): Promise<MemoryRecord[]> {
    const scope = input.scope ?? this.defaultScope
    let records = [...this.store.scope(scope).records.values()]
    if (input.kind) records = records.filter((r) => r.kind === input.kind)
    records.sort((a, b) => b.updatedAt - a.updatedAt)
    return records.slice(0, input.limit ?? 50)
  }

  /** Force a synchronous flush (dispose/HMR path). */
  flushSync(): void {
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

  get pendingEmbedCount(): number {
    return this.store.allScopes().reduce((n, s) => n + s.embedPending.size, 0)
  }
}

function touch(record: MemoryRecord): MemoryRecord {
  record.lastAccessedAt = Date.now()
  record.accessCount += 1
  return record
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

/** Port of an http(s) endpoint, or null when it cannot be parsed. */
function portOf(endpoint: string): number | null {
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

function memoryError(code: string, message: string): Error & { code: string } {
  const err = new Error(`[memory:${code}] ${message}`) as Error & { code: string }
  err.code = code
  return err
}

export function createMemoryService(config: MemoryLocalConfig = {}): LocalMemoryService {
  return new LocalMemoryService(config)
}
