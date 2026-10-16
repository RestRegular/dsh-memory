/**
 * JSONL-backed store. One file per scope, append-on-write semantics with
 * atomic compaction (tmp + rename). Vectors live in memory for M1; the .vec
 * sidecar format arrives in M1.5.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { dirname, join } from 'node:path'
import type { MemoryRecord, MemorySaveInput, MemoryScope } from 'dsh-memory'

export interface ScopeStoreEvents {
  onWarn?(message: string): void
}

/** 文件存在且是普通文件(目录同名时 existsSync 也为 true,这里只认文件)。 */
function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * scope 键 → 文件名。**保持不变**(数据兼容的硬约束):
 *   global        → global.jsonl
 *   其他任意键     → projects/<sha1(key)>.jsonl
 * 哈希文件名的好处是结构上不可能路径穿越、也没有 Windows 保留名问题;代价是不可读,
 * 所以面板用 /status 的 label 字段负责展示(见 memory-panel/lib/index.js)。
 */
export function scopeFileName(scope: MemoryScope): string {  if (scope === 'global') return 'global.jsonl'
  const hash = createHash('sha1').update(scope).digest('hex')
  return join('projects', `${hash}.jsonl`)
}

/** 自定义 scope(既不是 global,也不是 project:/session: 前缀)。 */
export function isCustomScopeKey(scope: MemoryScope): boolean {
  return scope !== 'global' && !scope.startsWith('project:') && !scope.startsWith('session:')
}

/**
 * Read the first well-formed record's scope from a scope file. Project files are
 * named by hash, so this is the only way back to the scope key without the
 * provider having created that scope in this process already.
 */
export function firstScopeInFile(file: string): MemoryScope | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed) as { scope?: unknown }
      if (typeof rec.scope === 'string' && rec.scope) return rec.scope as MemoryScope
    } catch {
      // skip malformed line, keep looking
    }
  }
  return null
}

export function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function contentHash(scope: MemoryScope, content: string): string {
  return createHash('sha1').update(`${scope}::${normalizeContent(content)}`).digest('hex')
}

export function newId(): string {
  return randomUUID()
}

export class ScopeStore {
  readonly scope: MemoryScope
  readonly records = new Map<string, MemoryRecord>()
  readonly vectors = new Map<string, Float32Array>()
  /** ids saved while the embed backend was down; retried opportunistically. */
  readonly embedPending = new Set<string>()
  dirty = false
  /** true once vectors were touched since the last .vec flush. */
  vectorsDirty = false
  /** 数据文件路径(写、以及删空后移除都走它)。 */
  readonly file: string
  private vecFile: string
  private events: ScopeStoreEvents
  /** Embedding identity for sidecar validation; set via setVecIdentity(). */
  private vecIdentity = ''

  constructor(scope: MemoryScope, root: string, events: ScopeStoreEvents = {}) {
    this.scope = scope
    this.file = join(root, scopeFileName(scope))
    this.vecFile = join(root, scopeFileName(scope).replace(/\.jsonl$/, '.vec'))
    this.events = events
  }

  /**
   * Declare which model+dims produced the in-memory vectors. When it differs
   * from the sidecar header on load, the sidecar is discarded and every record
   * re-enters the embed queue — old vectors for a new model are wrong, not
   * merely stale.
   */
  setVecIdentity(model: string, dims: number): void {
    this.vecIdentity = `${model}\t${dims}`
  }

  get size(): number {
    return this.records.size
  }

  insert(record: MemoryRecord): void {
    this.records.set(record.id, record)
    this.dirty = true
  }

  remove(id: string): boolean {
    const had = this.records.delete(id)
    if (had) {
      this.vectors.delete(id)
      this.embedPending.delete(id)
      this.dirty = true
      this.vectorsDirty = true
    }
    return had
  }

  /**
   * Delete this scope's data files(.jsonl 与 .vec 边车)。
   *
   * 只在 flush 时、且该 scope **内存里已经没有记录**的情况下调用 —— 也就是"作用域被删空了"。
   * 留一个 0 字节的 .jsonl + 只有一个身份头的 .vec 在磁盘上没有任何价值:数据已经空,
   * 而作用域本身是懒加载的(下次写同一个名字会重新创建)。global 永不适用(调用方 guard)。
   */
  removeFiles(): boolean {
    let removed = false
    for (const file of [this.file, this.vecFile]) {
      try {
        rmSync(file, { force: true })
        removed = true
      } catch (err) {
        // 删不掉不影响正确性(空文件无数据);下一次 flush 还会再试一次
        this.events.onWarn?.(`store: cannot remove ${file}: ${(err as Error).message}`)
      }
    }
    return removed
  }

  setVector(id: string, vec: Float32Array): void {
    this.vectors.set(id, vec)
    this.vectorsDirty = true
  }

  /**
   * Append a record to the sidecar: `<id> \t <base64 dim vec>` per line.
   * Vectors are written immediately on embed (single-line append) and fully
   * rewritten on delete/compact — embeddings are expensive to recompute.
   * A freshly created file starts with the `#model\tdims` identity header.
   */
  appendVector(id: string, vec: Float32Array): void {
    this.setVector(id, vec)
    try {
      mkdirSync(dirname(this.vecFile), { recursive: true })
      if (this.vecIdentity && this.readHeader() !== this.vecIdentity) {
        // missing, legacy, or wrong-model file: rewrite fresh from memory
        this.writeSidecar()
        this.vectorsDirty = false
        return
      }
      appendFileSync(this.vecFile, `${id}\t${encodeVec(vec)}\n`, 'utf8')
      this.vectorsDirty = false
    } catch (err) {
      this.vectorsDirty = true // full rewrite on next flushVectors
      this.events.onWarn?.(`vec: append failed: ${(err as Error).message}`)
    }
  }

  /** First line of the sidecar if it is a header; '' when absent/headerless. */
  private readHeader(): string {
    if (!existsSync(this.vecFile)) return ''
    try {
      const first = readFileSync(this.vecFile, 'utf8').split('\n', 1)[0] ?? ''
      return first.startsWith('#') ? first.slice(1) : ''
    } catch {
      return ''
    }
  }

  /** Atomic full rewrite: identity header + every in-memory vector. */
  private writeSidecar(): void {
    mkdirSync(dirname(this.vecFile), { recursive: true })
    const tmp = `${this.vecFile}.tmp`
    const lines: string[] = this.vecIdentity ? [`#${this.vecIdentity}`] : []
    for (const [id, v] of this.vectors) lines.push(`${id}\t${encodeVec(v)}`)
    writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
    renameSync(tmp, this.vecFile)
  }

  /** Rewrite the whole sidecar (after deletes / compaction / append failures). */
  flushVectors(): void {
    if (!this.vectorsDirty) return
    try {
      this.writeSidecar()
      this.vectorsDirty = false
    } catch (err) {
      this.events.onWarn?.(`vec: flush failed: ${(err as Error).message}`)
    }
  }

  /**
   * Load vectors from the sidecar. The first line must be a `#model\tdims`
   * header when an identity is configured — mismatch or a legacy headerless
   * file discards the whole sidecar (re-embed). Unknown ids are skipped.
   */
  loadVectors(): void {
    if (!existsSync(this.vecFile)) return
    try {
      const text = readFileSync(this.vecFile, 'utf8')
      let sawHeader = false
      let sawData = false
      const discard = (why: string) => {
        this.events.onWarn?.(`vec: ${why}; discarding sidecar for re-embed`)
        this.vectors.clear()
        this.vectorsDirty = true
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith('#')) {
          if (this.vecIdentity && trimmed.slice(1) !== this.vecIdentity) {
            discard(`identity mismatch (${trimmed.slice(1)} != ${this.vecIdentity})`)
            return
          }
          // Loading before the identity is declared means NO validation happens
          // (the guards below are all identity-gated). That ordering bug shipped
          // once — see RestRegular/dsh-memory#1 — so make any recurrence visible.
          if (!this.vecIdentity) {
            this.events.onWarn?.(`${this.scope}: loading a vector sidecar before setVecIdentity(); its ${trimmed.slice(1)} vectors are accepted unvalidated`)
          }
          sawHeader = true
          continue
        }
        if (!sawData) {
          sawData = true
          if (this.vecIdentity && !sawHeader) {
            discard('legacy sidecar without identity header')
            return
          }
        }
        const tab = trimmed.indexOf('\t')
        if (tab <= 0) continue
        const id = trimmed.slice(0, tab)
        if (!this.records.has(id)) continue // stale vector for a deleted record
        const vec = decodeVec(trimmed.slice(tab + 1))
        if (vec) this.vectors.set(id, vec)
      }
    } catch (err) {
      this.events.onWarn?.(`vec: load failed: ${(err as Error).message}`)
    }
  }
}

// --- base64 vector codec (4 bytes per float, bit-exact) ---

function encodeVec(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')
}

function decodeVec(text: string): Float32Array | null {
  try {
    const buf = Buffer.from(text, 'base64')
    if (buf.length === 0 || buf.length % 4 !== 0) return null
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
  } catch {
    return null
  }
}

export interface MemoryStoreEvents {
  onWarn?(message: string): void
}

export class MemoryStore {
  readonly root: string
  private scopes = new Map<string, ScopeStore>()
  /** scopes whose jsonl has been loaded from disk (lazy, once per scope). */
  private loaded = new Set<string>()
  /** scope -> its jsonl filename, so reload can map files back to scopes. */
  private fileNames = new Map<MemoryScope, string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private events: MemoryStoreEvents
  /** `model\tdims` handed to every ScopeStore for sidecar validation. */
  private vecIdentity = ''

  constructor(root: string, events: MemoryStoreEvents = {}) {
    this.root = root
    this.events = events
    mkdirSync(join(root, 'projects'), { recursive: true })
  }

  /** Declare the embedding identity; applies to existing and future scopes. */
  setVecIdentity(model: string, dims: number): void {
    this.vecIdentity = `${model}\t${dims}`
    for (const s of this.scopes.values()) s.setVecIdentity(model, dims)
  }

  /** Preload specific scopes eagerly (e.g. defaults); others load on first access. */
  loadAll(wanted: MemoryScope[]): void {
    for (const scope of wanted) this.scope(scope)
  }

  private loadScope(scope: MemoryScope): void {
    const file = this.fileFor(scope)
    if (!fileExists(file)) return
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      this.events.onWarn?.(`store: cannot read ${file}: ${(err as Error).message}`)
      return
    }
    const store = this.scope(scope)
    let lineNo = 0
    for (const line of text.split('\n')) {
      lineNo++
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const rec = JSON.parse(trimmed) as MemoryRecord
        if (!rec || typeof rec.id !== 'string' || typeof rec.content !== 'string' || typeof rec.scope !== 'string') {
          throw new Error('bad shape')
        }
        if (rec.scope !== scope) continue // file/scope mismatch: ignore, will be rewritten on flush
        store.records.set(rec.id, rec)
      } catch {
        this.events.onWarn?.(`store: skipping malformed ${file}:${lineNo}`)
      }
    }
    // sidecar vectors second; anything still un-embedded joins the backfill queue
    store.loadVectors()
    for (const id of store.records.keys()) {
      if (!store.vectors.has(id)) store.embedPending.add(id)
    }
    store.dirty = false
  }

  scope(scope: MemoryScope): ScopeStore {
    let s = this.scopes.get(scope)
    if (!s) {
      s = new ScopeStore(scope, this.root, this.events)
      if (this.vecIdentity) s.setVecIdentity(...(this.vecIdentity.split('\t') as [string, string]))
      this.scopes.set(scope, s)
      this.fileNames.set(scope, scopeFileName(scope))
    }
    if (!this.loaded.has(scope)) {
      this.loaded.add(scope)
      this.loadScope(scope)
    }
    return s
  }

  /**
   * 读路径的 scope 访问:已加载就返回;**磁盘上有数据**就加载并返回;都没有则 `undefined`。
   *
   * 与 `scope()` 的区别是这里绝不创建:早先 `search`/`list`/`forget`/面板 /records 都走
   * `scope()`,于是"查一个不存在的 scope"会在内存里造出一个空 store,`allScopes()` 立刻把它
   * 算进"作用域数",后续任何一次 flush 还会给它落一个空文件。读路径必须无副作用。
   */
  peek(scope: MemoryScope): ScopeStore | undefined {
    const existing = this.scopes.get(scope)
    if (existing) return existing
    const file = join(this.root, scopeFileName(scope))
    if (!fileExists(file)) return undefined
    return this.scope(scope)
  }

  /** 自定义 scope 数(去重后);用于 scopes.custom.max 限额,会话/项目/global 不计入。 */
  customScopeCount(): number {
    const seen = new Set<MemoryScope>()
    for (const s of this.scopes.values()) {
      if (isCustomScopeKey(s.scope)) seen.add(s.scope)
    }
    const projDir = join(this.root, 'projects')
    if (existsSync(projDir)) {
      for (const file of readdirSync(projDir)) {
        if (!file.endsWith('.jsonl')) continue
        const scope = firstScopeInFile(join(projDir, file))
        if (scope !== null && isCustomScopeKey(scope)) seen.add(scope)
      }
    }
    return seen.size
  }

  allScopes(): ScopeStore[] {
    return [...this.scopes.values()]
  }

  /**
   * Eagerly load every scope that has data on disk and return the scope keys.
   *
   * Scopes are otherwise created lazily, so a long-lived process only knows the
   * scopes it has already touched — a management UI (the memory panel) would
   * silently miss project memories written in earlier sessions. Project files
   * are named by scope hash, so the scope key is recovered from the first
   * record inside each file.
   */
  loadDiscovered(): MemoryScope[] {
    const discovered: MemoryScope[] = []
    if (existsSync(join(this.root, 'global.jsonl'))) discovered.push('global')
    const projDir = join(this.root, 'projects')
    if (existsSync(projDir)) {
      for (const file of readdirSync(projDir)) {
        if (!file.endsWith('.jsonl')) continue
        const scope = firstScopeInFile(join(projDir, file))
        if (scope) discovered.push(scope)
      }
    }
    for (const scope of discovered) this.scope(scope) // triggers lazy disk load
    return discovered
  }

  private fileFor(scope: MemoryScope): string {
    return join(this.root, this.fileNames.get(scope) ?? scopeFileName(scope))
  }

  /**
   * 这个 scope 删空后能不能把文件删掉。
   * 只有 `global` 例外:它是唯一一个"永远存在"的保留作用域(所有人共享),文件不该被
   * 任何一次清空动作从磁盘上抹掉 —— 即使将来某条路径把它删空了,也只写一个空文件。
   */
  private isRemovable(scope: MemoryScope): boolean {
    return scope !== 'global'
  }

  anyDirty(): boolean {
    for (const s of this.scopes.values()) if (s.dirty) return true
    return false
  }

  scheduleFlush(delayMs = 500): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, delayMs)
    // a debounced flush must not hold the event loop open
    this.flushTimer.unref?.()
  }

  /**
   * Write dirty scopes atomically (tmp + rename).
   *
   * 一个被删空的 scope(内存里 0 条记录)**不再落一个 0 字节文件**,而是把它的 .jsonl 与
   * .vec 一起删掉:空文件没有任何信息,反而在面板里留下一条 `(0)` 的作用域、在磁盘上长期堆积。
   * 作用域是懒加载的,下次往同一个名字写入时会重新创建。`global` 永不自动删除(见 isRemovable)。
   */
  flush(): void {
    for (const s of this.scopes.values()) {
      if (!s.dirty) continue
      if (s.records.size === 0 && this.isRemovable(s.scope)) {
        s.removeFiles()
        s.dirty = false
        s.vectorsDirty = false
        continue
      }
      const file = this.fileFor(s.scope)
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      const lines = [...s.records.values()].map((r) => JSON.stringify(r))
      writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
      renameSync(tmp, file)
      s.dirty = false
    }
    // vectors flush too: they are the expensive-to-recompute half
    for (const s of this.scopes.values()) s.flushVectors()
  }

  /** Synchronous final flush — call on dispose. */
  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
  }

  /**
   * Dedupe-aware save: identical normalized content in the scope refreshes the
   * existing record instead of duplicating it.
   */
  save(
    input: MemorySaveInput,
    defaults: { importance: number; source: MemoryRecord['source'] },
  ): { record: MemoryRecord; deduped: boolean } {
    const s = this.scope(input.scope)
    const hash = contentHash(input.scope, input.content)
    for (const rec of s.records.values()) {
      if (contentHash(rec.scope, rec.content) === hash) {
        rec.updatedAt = Date.now()
        rec.accessCount += 1
        rec.importance = Math.max(rec.importance, input.importance ?? defaults.importance)
        if (input.supersedes) rec.supersedes = input.supersedes
        s.dirty = true
        return { record: rec, deduped: true }
      }
    }
    const now = Date.now()
    const record: MemoryRecord = {
      id: newId(),
      scope: input.scope,
      kind: input.kind,
      content: input.content,
      tags: input.tags ?? [],
      source: { ...defaults.source, ...input.source },
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      importance: input.importance ?? defaults.importance,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      ...(input.expiredAt ? { expiredAt: input.expiredAt } : {}),
    }
    s.insert(record)
    return { record, deduped: false }
  }

  /** Substring match over normalized content, used by forget-by-query. */
  findIdsByQuery(scope: MemoryScope, query: string): string[] {
    // 读/删路径:用 peek,不存在的 scope 返回空,绝不创建。
    const s = this.peek(scope)
    if (!s) return []
    const needle = normalizeContent(query)
    if (!needle) return []
    const ids: string[] = []
    for (const rec of s.records.values()) {
      if (normalizeContent(rec.content).includes(needle)) ids.push(rec.id)
    }
    return ids
  }

  /** Remove every expired record across scopes; returns removed ids. */
  purgeExpired(now = Date.now()): string[] {
    const removed: string[] = []
    for (const s of this.scopes.values()) {
      for (const rec of [...s.records.values()]) {
        if (rec.expiredAt !== undefined && rec.expiredAt < now) {
          s.remove(rec.id)
          removed.push(rec.id)
        }
      }
    }
    return removed
  }

  /**
   * Evict lowest-ranked records until each scope is within its cap. Ranking:
   * recency (30d half-life) × importance — keep what retrieval would favor.
   */
  enforceLimit(maxPerScope: number, now = Date.now()): string[] {
    const removed: string[] = []
    for (const s of this.scopes.values()) {
      if (s.records.size <= maxPerScope) continue
      const ranked = [...s.records.values()]
        .map((r) => ({
          id: r.id,
          rank: Math.pow(0.5, Math.max(0, now - r.updatedAt) / 86_400_000 / 30) * (0.1 + r.importance),
        }))
        .sort((a, b) => b.rank - a.rank)
      for (const r of ranked.slice(maxPerScope)) {
        s.remove(r.id)
        removed.push(r.id)
      }
    }
    return removed
  }
}
