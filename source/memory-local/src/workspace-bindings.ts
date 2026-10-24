/**
 * 工作区级「绑定作用域」的持久化（0.23.0）。
 *
 * 语义：用户在「记忆范围」面板里可以把若干具体作用域（`global` / 其它项目 /
 * 自定义名）绑定到**当前工作区**。绑定不改变当前会话的显式覆盖，而是让这个
 * 工作区里**没有显式覆盖**的会话，在默认可见范围里额外包含这些作用域。
 *
 * 为什么按工作区分文件：
 *   - storeDir 可能被多个进程共用，单个 map 文件并发写会互相覆盖；
 *   - 一个工作区一份文件，读写都只碰自己那份，和 session-visibility 同款策略。
 *
 * 文件位置：`<storeDir>/bindings/<hash>.json`，内容
 *   `{ version: 1, workspace: 'project:<规范化路径>', scopes: string[], updatedAt }`
 *
 * 容错：读写失败都只退化为「没有绑定」，绝不把异常抛回检索/面板链路。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const WORKSPACE_BINDINGS_VERSION = 1

interface BindingsFile {
  version?: number
  workspace?: unknown
  scopes?: unknown
  updatedAt?: unknown
}

function cleanScopes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const scope = item.trim()
    if (scope === '' || out.includes(scope)) continue
    out.push(scope)
  }
  return out
}

/** 工作区 key 可能包含路径分隔符/中文；用 hash 做文件名，避免平台差异。 */
function fileNameFor(workspace: string): string {
  return `${createHash('sha1').update(workspace).digest('hex').slice(0, 20)}.json`
}

export interface WorkspaceBindingsStoreOptions {
  /** provider 的数据根目录；绑定文件写到 `<root>/bindings/`。 */
  root: string
  warn?: (message: string) => void
}

export class WorkspaceBindingsStore {
  private readonly dir: string
  private readonly warn: (message: string) => void
  /** workspace key -> 绑定集合；undefined = 还没读过。 */
  private readonly cache = new Map<string, string[]>()

  constructor(options: WorkspaceBindingsStoreOptions) {
    this.dir = join(options.root, 'bindings')
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  private fileOf(workspace: string): string {
    return join(this.dir, fileNameFor(workspace))
  }

  /** 某个工作区绑定的作用域（拷贝）。 */
  get(workspace: string): string[] {
    if (typeof workspace !== 'string' || workspace.trim() === '') return []
    const key = workspace.trim()
    const cached = this.cache.get(key)
    if (cached !== undefined) return [...cached]
    let scopes: string[] = []
    try {
      const file = this.fileOf(key)
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as BindingsFile
        // 文件里记录的工作区必须与查询一致：hash 碰撞时宁可当没有，也不串工作区。
        if (typeof parsed?.workspace === 'string' && parsed.workspace === key) {
          scopes = cleanScopes(parsed.scopes)
        }
      }
    } catch (error) {
      this.warn(`[dsh-memory-local] 忽略损坏的工作区绑定 ${this.fileOf(key)}: ${error instanceof Error ? error.message : String(error)}`)
      scopes = []
    }
    this.cache.set(key, scopes)
    return [...scopes]
  }

  /** 写入某个工作区的绑定；空数组 = 清除。返回写入后的值。 */
  set(workspace: string, scopes: readonly string[]): string[] {
    if (typeof workspace !== 'string' || workspace.trim() === '') return []
    const key = workspace.trim()
    const cleaned = cleanScopes([...scopes])
    try {
      const file = this.fileOf(key)
      if (cleaned.length === 0) {
        rmSync(file, { force: true })
        this.cache.set(key, [])
        return []
      }
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, `${JSON.stringify({
        version: WORKSPACE_BINDINGS_VERSION,
        workspace: key,
        scopes: cleaned,
        updatedAt: Date.now(),
      }, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
      this.cache.set(key, cleaned)
      return [...cleaned]
    } catch (error) {
      this.warn(`[dsh-memory-local] 无法写入工作区绑定 ${this.fileOf(key)}: ${error instanceof Error ? error.message : String(error)}`)
      return this.get(key)
    }
  }

  /** 清掉缓存（下一次 get 重新读盘）；测试/维护用。 */
  invalidate(workspace: string): void {
    this.cache.delete(workspace.trim())
  }
}
