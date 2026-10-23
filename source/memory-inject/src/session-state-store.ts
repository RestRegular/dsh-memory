/**
 * 会话级注入去重状态的持久化。
 *
 * 位置:<workspace>/.dsh/dsh-memory/sessions/<session>.jsonl
 *
 * 为什么不是"每次改都重写 JSON":
 *   - 一次召回/摘要会标记多条;全量重写会把 I/O 放大到 O(状态大小)。
 *   - 这里用 JSONL 增量日志:合并窗口(默认 250ms)内多次修改只 append 一行,
 *     写延迟与状态大小无关。
 *   - 行数 / 字节超过阈值时 compact 成一行快照(临时文件 + rename,原子替换),
 *     文件不会无限增长。
 *
 * 行格式(短键,减小体积):
 *   快照 {"v":1,"d":1,"e":[["id",2,version,at],...]}
 *   增量 {"d":1,"e":[...]}
 *   status: 1=hint_injected, 2=content_injected; d=1 表示本会话摘要已做过
 *
 * 只存记录 id / 状态 / 版本 / 时间戳与摘要标记,不落正文,也不落 lastQuery
 * (查询可能含凭据)。
 *
 * 容错:读/写/清理任何一步失败都只退化为内存状态并告警一次,绝不把异常抛回
 * 注入链路。目录不可写时同样退化。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { InjectEntrySnapshot, InjectionStateStore, SessionStateSnapshot } from './state.ts'

const STATUS_CODE: Record<InjectEntrySnapshot['status'], number> = {
  hint_injected: 1,
  content_injected: 2,
}
const STATUS_BY_CODE: Record<number, InjectEntrySnapshot['status']> = {
  1: 'hint_injected',
  2: 'content_injected',
}
const SNAPSHOT_VERSION = 1
const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_MAX_AGE_DAYS = 30
const DEFAULT_MAX_FILES = 1000
const DEFAULT_COMPACT_MIN_LINES = 200
const DEFAULT_COMPACT_MAX_BYTES = 512 * 1024
const DAY_MS = 86_400_000

/** 每个工作区只清理一次;清理是 best-effort,失败不影响读写。 */
const prunedRoots = new Set<string>()

export interface SessionStateStoreOptions {
  /** 本插件在该工作区的根目录,状态写到 <root>/sessions/。 */
  root: string
  sessionId: string
  /** 合并写窗口;默认 250ms。 */
  debounceMs?: number
  /** 会话状态文件保留天数;默认 30。 */
  maxAgeDays?: number
  /** 单工作区最多保留的会话状态文件数;默认 1000。 */
  maxFiles?: number
  /** 测试/调优:触发 compact 的最小行数;默认 200。 */
  compactMinLines?: number
  /** 测试/调优:触发 compact 的最小字节数;默认 512 KiB。 */
  compactMaxBytes?: number
  now?: () => number
  warn?: (message: string) => void
}

export function createSessionStateStore(options: SessionStateStoreOptions): InjectionStateStore {
  return new JsonlSessionStateStore(options)
}

type WireEntry = [string, number, number, number]

interface WireLine {
  v?: number
  d?: number
  e?: WireEntry[]
}

function encodeEntry(entry: InjectEntrySnapshot): WireEntry {
  return [entry.id, STATUS_CODE[entry.status], entry.version, entry.at]
}

function decodeEntry(raw: unknown): InjectEntrySnapshot | undefined {
  if (!Array.isArray(raw) || raw.length < 4) return undefined
  const [id, code, version, at] = raw as unknown[]
  if (typeof id !== 'string' || id === '') return undefined
  const status = typeof code === 'number' ? STATUS_BY_CODE[code] : undefined
  if (status === undefined || typeof version !== 'number' || typeof at !== 'number') return undefined
  return { id, status, version, at }
}

/** 会话 id 通常已是 UUID;异常字符换成 `_`,超长/被改写的再加 8 位 hash 防碰撞。 */
function safeName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  if (cleaned === sessionId && cleaned !== '') return cleaned
  const base = cleaned === '' ? 'session' : cleaned.slice(0, 64)
  return `${base}-${createHash('sha1').update(sessionId).digest('hex').slice(0, 8)}`
}

class JsonlSessionStateStore implements InjectionStateStore {
  private readonly dir: string
  private readonly file: string
  private readonly debounceMs: number
  private readonly maxAgeDays: number
  private readonly maxFiles: number
  private readonly compactMinLines: number
  private readonly compactMaxBytes: number
  private readonly now: () => number
  private readonly warn: (message: string) => void
  /** 权威内存副本:load 出来 + append 合并进来的全部条目。 */
  private readonly entries = new Map<string, InjectEntrySnapshot>()
  /** 待写增量(按 id 合并);flush 后清空。 */
  private readonly pending = new Map<string, InjectEntrySnapshot>()
  private digestDone = false
  private pendingDigestDone = false
  private lines = 0
  private bytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private loaded = false
  private disabled = false
  private warned = false

  constructor(options: SessionStateStoreOptions) {
    this.dir = join(options.root, 'sessions')
    this.file = join(this.dir, `${safeName(options.sessionId)}.jsonl`)
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    this.maxAgeDays = Math.max(1, options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS)
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
    this.compactMinLines = Math.max(10, options.compactMinLines ?? DEFAULT_COMPACT_MIN_LINES)
    this.compactMaxBytes = Math.max(4096, options.compactMaxBytes ?? DEFAULT_COMPACT_MAX_BYTES)
    this.now = options.now ?? Date.now
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  load(): SessionStateSnapshot | undefined {
    if (this.loaded) return this.snapshot()
    this.loaded = true
    this.prune()
    try {
      if (!existsSync(this.file)) return undefined
      const text = readFileSync(this.file, 'utf8')
      if (text.trim() === '') return undefined
      const entries = new Map<string, InjectEntrySnapshot>()
      let lines = 0
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        lines += 1
        let wire: WireLine
        try { wire = JSON.parse(trimmed) as WireLine } catch { continue }
        if (wire.v === SNAPSHOT_VERSION) {
          entries.clear()
          this.digestDone = wire.d === 1
        } else if (wire.d === 1) {
          this.digestDone = true
        }
        if (Array.isArray(wire.e)) {
          for (const raw of wire.e) {
            const entry = decodeEntry(raw)
            if (entry !== undefined) entries.set(entry.id, entry)
          }
        }
      }
      for (const [id, entry] of entries) this.entries.set(id, entry)
      this.lines = lines
      this.bytes = Buffer.byteLength(text)
      return this.snapshot()
    } catch (error) {
      this.disable('读取会话去重状态失败', error)
      return undefined
    }
  }

  append(entries: readonly InjectEntrySnapshot[]): void {
    if (this.disabled) return
    this.load()
    for (const entry of entries) {
      this.entries.set(entry.id, entry)
      this.pending.set(entry.id, entry)
    }
    if (this.pending.size === 0) return
    this.schedule()
  }

  markDigestDone(): void {
    if (this.disabled) return
    this.load()
    if (this.digestDone && !this.pendingDigestDone) return
    this.digestDone = true
    this.pendingDigestDone = true
    this.schedule()
  }

  evict(ids: readonly string[]): void {
    for (const id of ids) {
      this.entries.delete(id)
      this.pending.delete(id)
    }
  }

  flush(): void {
    this.stopTimer()
    if (this.disabled) return
    if (this.pending.size === 0 && !this.pendingDigestDone) return
    try {
      this.ensureDir()
      // 第一次写(或文件被清空)直接写一行快照,保证 load 时一定有基线。
      if (!existsSync(this.file) || this.lines === 0) {
        this.compact()
        return
      }
      const line: WireLine = {
        ...(this.pendingDigestDone ? { d: 1 } : {}),
        ...(this.pending.size > 0 ? { e: [...this.pending.values()].map(encodeEntry) } : {}),
      }
      const text = `${JSON.stringify(line)}\n`
      appendFileSync(this.file, text, 'utf8')
      this.lines += 1
      this.bytes += Buffer.byteLength(text)
      this.clearPending()
      if (this.needCompact()) this.compact()
    } catch (error) {
      this.disable('写入会话去重状态失败', error)
    }
  }

  remove(): void {
    this.stopTimer()
    this.pending.clear()
    this.pendingDigestDone = false
    this.digestDone = false
    this.entries.clear()
    this.lines = 0
    this.bytes = 0
    this.loaded = false
    try {
      rmSync(this.file, { force: true })
      rmSync(`${this.file}.tmp`, { force: true })
    } catch { /* best effort */ }
  }

  dispose(): void {
    this.flush()
    this.stopTimer()
  }

  private snapshot(): SessionStateSnapshot {
    return { entries: [...this.entries.values()], digestDone: this.digestDone }
  }

  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.debounceMs)
    // 不要让一个待写状态把进程/测试挂住。
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private stopTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private clearPending(): void {
    this.pending.clear()
    this.pendingDigestDone = false
  }

  private needCompact(): boolean {
    const lineLimit = Math.max(this.compactMinLines, this.entries.size * 2)
    return this.lines >= lineLimit || this.bytes >= this.compactMaxBytes
  }

  private compact(): void {
    this.ensureDir()
    const line: WireLine = {
      v: SNAPSHOT_VERSION,
      ...(this.digestDone ? { d: 1 } : {}),
      e: [...this.entries.values()].map(encodeEntry),
    }
    const text = `${JSON.stringify(line)}\n`
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, this.file)
    this.clearPending()
    this.lines = 1
    this.bytes = Buffer.byteLength(text)
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  private prune(): void {
    if (prunedRoots.has(this.dir)) return
    prunedRoots.add(this.dir)
    if (!existsSync(this.dir)) return
    try {
      const cutoff = this.now() - this.maxAgeDays * DAY_MS
      const current = this.file.slice(this.dir.length + 1)
      const kept: Array<{ path: string; mtime: number }> = []
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.jsonl') || name === current) continue
        const path = join(this.dir, name)
        let mtime = 0
        try { mtime = statSync(path).mtimeMs } catch { continue }
        if (mtime < cutoff) rmSync(path, { force: true })
        else kept.push({ path, mtime })
      }
      // 当前会话也占一个名额;超出上限时删最旧的。
      const over = kept.length - (this.maxFiles - 1)
      if (over > 0) {
        kept.sort((a, b) => a.mtime - b.mtime)
        for (const item of kept.slice(0, over)) rmSync(item.path, { force: true })
      }
    } catch (error) {
      this.disable('清理旧会话去重状态失败', error)
    }
  }

  private disable(what: string, error: unknown): void {
    this.disabled = true
    if (this.warned) return
    this.warned = true
    this.warn(`[dsh-memory] ${what}: ${error instanceof Error ? error.message : String(error)}；本次退化为内存去重`)
  }
}
