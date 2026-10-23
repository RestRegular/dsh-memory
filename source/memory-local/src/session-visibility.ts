/**
 * 会话级「记忆可见范围」的持久化。
 *
 * 位置:`<storeDir>/visibility/<session>.json`(与记忆数据同目录,便于一起备份/清理)。
 *
 * 为什么放在 provider 而不是注入半边:
 *   resolveReadScopes / memory_search / memory_get 都以 provider 为**唯一口径**;
 *   如果把覆盖范围放在注入半边,工具与注入就会各读一份,模型能看到的范围页面
 *   和工具实际能读到的范围可能不一致。provider 落盘、注入与工具都通过它解析。
 *
 * 为什么一个会话一个文件,而不是一个 JSON map:
 *   同一个 storeDir 可能被多个进程共用(见 store.ts 的 issue #3)。单文件 map 在并发
 *   写入时会互相覆盖;按会话分文件后,一个会话的写入不影响另一个会话。
 *
 * 语义:
 *   - 文件存在且 scopes 非空 = 该会话显式指定了可见范围;
 *   - 文件不存在 = 没有覆盖,继续用默认的三路集合(会话 + 项目 + global);
 *   - scopes 为空数组视为"无覆盖"(面板在保存时也会拒绝空选择),不会把会话锁死。
 *
 * 容错:读写失败都只退化为"没有覆盖",绝不把异常抛回检索/注入链路。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const VERSION = 1

export interface SessionVisibilityStoreOptions {
  /** provider 的数据根目录;范围文件写到 `<root>/visibility/`。 */
  root: string
  warn?: (message: string) => void
}

interface VisibilityFile {
  version?: number
  scopes?: unknown
  updatedAt?: unknown
}

/** 会话 id 通常已经是 UUID;异常字符换成 `_`,改写过的再加 8 位 hash 防碰撞。 */
function safeName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  if (cleaned === sessionId && cleaned !== '') return cleaned
  const base = cleaned === '' ? 'session' : cleaned.slice(0, 64)
  return `${base}-${createHash('sha1').update(sessionId).digest('hex').slice(0, 8)}`
}

/** 只保留非空字符串并去重(顺序即用户勾选顺序);空数组返回 undefined。 */
function cleanScopes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (value === '' || out.includes(value)) continue
    out.push(value)
  }
  return out.length > 0 ? out : undefined
}

export class SessionVisibilityStore {
  private readonly dir: string
  private readonly warn: (message: string) => void
  /** sessionId -> 显式范围;null = 已确认没有文件(避免反复 stat)。 */
  private readonly cache = new Map<string, string[] | null>()

  constructor(options: SessionVisibilityStoreOptions) {
    this.dir = join(options.root, 'visibility')
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  private fileOf(sessionId: string): string {
    return join(this.dir, `${safeName(sessionId)}.json`)
  }

  /** 显式可见范围;undefined = 没有覆盖(用默认集合)。 */
  get(sessionId: string): string[] | undefined {
    if (sessionId === '') return undefined
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return cached ?? undefined
    let scopes: string[] | undefined
    try {
      const file = this.fileOf(sessionId)
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as VisibilityFile
        scopes = cleanScopes(parsed?.scopes)
        if (parsed?.version !== undefined && parsed.version !== VERSION) {
          // 未知版本:读得出来就继续用,读不出来就按"无覆盖"处理。
          scopes = scopes ?? undefined
        }
      }
    } catch (error) {
      // 损坏文件不应该让会话失去默认可见范围;只告警一次(缓存 null)。
      this.warn(`[dsh-memory-local] 忽略损坏的会话可见范围 ${this.fileOf(sessionId)}: ${error instanceof Error ? error.message : String(error)}`)
      scopes = undefined
    }
    this.cache.set(sessionId, scopes ?? null)
    return scopes
  }

  /** 写入/清除显式范围。null 或空数组 = 清除(恢复默认)。返回写入后的值。 */
  set(sessionId: string, scopes: readonly string[] | null): string[] | null {
    if (sessionId === '') return null
    const cleaned = scopes === null ? undefined : cleanScopes(scopes)
    try {
      const file = this.fileOf(sessionId)
      if (cleaned === undefined) {
        rmSync(file, { force: true })
        this.cache.set(sessionId, null)
        return null
      }
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ version: VERSION, scopes: cleaned, updatedAt: Date.now() }, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
      this.cache.set(sessionId, cleaned)
      return [...cleaned]
    } catch (error) {
      // 写盘失败:内存里的旧值不清空,但也不能假装成功。调用方会看到旧值。
      this.warn(`[dsh-memory-local] 无法写入会话可见范围 ${this.fileOf(sessionId)}: ${error instanceof Error ? error.message : String(error)}`)
      return this.cache.get(sessionId) ?? null
    }
  }

  /** 把缓存里这个会话的值清掉(下一次 get 重新读盘);维护/测试用。 */
  invalidate(sessionId: string): void {
    this.cache.delete(sessionId)
  }
}
