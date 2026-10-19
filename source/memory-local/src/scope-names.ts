/**
 * 作用域别名（重命名）。
 *
 * 语义（0.7.0 起）：
 *   - 项目作用域的身份始终是 `project:<绝对路径>`，别名只影响显示与引用；
 *   - `memory_save({ path, scope })` 里的 `scope` 是这次写入的**别名**，
 *     不给就用路径本身当名字；
 *   - 同一路径复用同名是幂等的；**不同路径抢同一个名字**直接拒绝（SCOPE_NAME_TAKEN）；
 *   - 别名文件是 `<storeDir>/scopes.json`，与记忆数据同目录。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeScopeName } from './scope.ts'

export interface ScopeNameEntry {
  name: string
  updatedAt: number
}

export class ScopeNames {
  private readonly file: string
  private map: Record<string, ScopeNameEntry>

  constructor(file: string) {
    this.file = file
    this.map = this.load()
  }

  private load(): Record<string, ScopeNameEntry> {
    try {
      if (!existsSync(this.file)) return {}
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const out: Record<string, ScopeNameEntry> = {}
      for (const [scope, value] of Object.entries(raw as Record<string, unknown>)) {
        const name = (value as { name?: unknown } | null)?.name
        if (typeof name === 'string' && name.length > 0) {
          out[scope] = { name, updatedAt: Number((value as { updatedAt?: unknown }).updatedAt) || 0 }
        }
      }
      return out
    } catch {
      return {}
    }
  }

  /** 该 scope 的别名（没有则 undefined，调用方回退到路径/键本身）。 */
  nameOf(scope: string): string | undefined {
    return this.map[scope]?.name
  }

  /** 名字 → scope 键（读路径可以把名字当 scope 用）。 */
  scopeOf(name: string): string | undefined {
    const wanted = normalizeScopeName(name)
    if (!wanted.ok) return undefined
    for (const [scope, entry] of Object.entries(this.map)) {
      if (entry.name === wanted.name) return scope
    }
    return undefined
  }

  /**
   * 给 scope 登记别名。同名同 scope → 幂等；不同 scope 同名 → SCOPE_NAME_TAKEN。
   * 名字规则复用自定义作用域名（小写折叠、1~64 码点、禁止路径分隔符等）。
   */
  claim(scope: string, rawName: string, now = Date.now()): string {
    const normalized = normalizeScopeName(rawName)
    if (!normalized.ok) throw nameError('SCOPE_NAME_INVALID', normalized.message)
    const name = normalized.name
    const holder = this.scopeOf(name)
    if (holder !== undefined && holder !== scope) {
      throw nameError('SCOPE_NAME_TAKEN', `作用域名「${name}」已被 ${holder} 使用；换一个名字，或直接用路径作用域`)
    }
    const existing = this.map[scope]
    if (existing?.name === name) return name
    this.map[scope] = { name, updatedAt: now }
    this.persist()
    return name
  }

  /** 删除某个 scope 的别名（给未来的“取消重命名”用）。 */
  release(scope: string): void {
    if (!(scope in this.map)) return
    delete this.map[scope]
    this.persist()
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify(this.map, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.warn(`[dsh-memory-local] 无法写入作用域别名 ${this.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function nameError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}
