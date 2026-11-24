/**
 * 子代理「授权上限」(delegation cap)。
 *
 * 背景（0.48.0）：记忆 grant 现在沿 parentSession 链无条件继承，父会话获批的
 * 全部作用域会原样流进每个子会话。新模型要求子代理创建时可以限定自己的记忆
 * 权限范围：默认只能拿父会话有效权限的子集，超出部分需要用户 / 父代理批准。
 *
 * 做法：给子会话写一份 `<storeDir>/grants/<session>.cap.json`，记录它被允许
 * 从父链继承哪些 scope + permission。provider 的 validGrants 在合并父链 grant
 * 时按这份上限过滤；子会话**自己**通过 memory_scopes 拿到的 grant 不受影响。
 * 父会话没有 cap 文件 = 沿用旧的「全部继承」语义（向后兼容）。
 *
 * 与 grants 分文件、按会话分文件的并发取舍跟 grants.ts 一致：原子 rename，
 * 只碰自己那份；cap 丢失 / 损坏时保守回退为「空继承」（不放宽权限）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isWellFormedScopeKey, normalizeScopeKey } from './scope.ts'
import type { GrantPermission } from './grants.ts'

export const DELEGATION_CAP_VERSION = 1

/** 一个作用域允许继承的权限（read / write 独立）。 */
export interface ScopeCapEntry {
  scope: string
  permissions: GrantPermission[]
}

export interface DelegationCap {
  version: number
  sessionId: string
  createdAt: number
  /** 从父链可继承的作用域权限；空数组 = 不继承任何父 grant。 */
  scopes: ScopeCapEntry[]
  /** 谁设的上限：parent-delegation（创建子代理时）或 user / parent-agent（后续批准）。 */
  grantedBy?: string
}

function safeName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  if (cleaned === sessionId && cleaned !== '') return cleaned
  const base = cleaned === '' ? 'session' : cleaned.slice(0, 64)
  return `${base}-${createHash('sha1').update(sessionId).digest('hex').slice(0, 8)}`
}

function cleanPermissions(raw: unknown): GrantPermission[] {
  if (!Array.isArray(raw)) return []
  const out: GrantPermission[] = []
  for (const item of raw) {
    if ((item === 'read' || item === 'write') && !out.includes(item)) out.push(item)
  }
  return out
}

export interface DelegationCapInput {
  sessionId: string
  scopes: ReadonlyArray<{ scope: string; permissions: readonly GrantPermission[] }>
  grantedBy?: string
}

export class DelegationCapStore {
  readonly dir: string

  constructor(options: { root: string }) {
    this.dir = join(options.root, 'grants')
  }

  fileFor(sessionId: string): string {
    return join(this.dir, `${safeName(sessionId)}.cap.json`)
  }

  /** 读取上限；没有文件返回 undefined（= 旧语义：全部继承）。 */
  get(sessionId: string): DelegationCap | undefined {
    let text: string
    try {
      text = readFileSync(this.fileFor(sessionId), 'utf8')
    } catch {
      return undefined
    }
    try {
      const raw = JSON.parse(text) as unknown
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
      const value = raw as Record<string, unknown>
      const entries = Array.isArray(value.scopes) ? value.scopes : []
      const scopes: ScopeCapEntry[] = []
      const seen = new Map<string, GrantPermission[]>()
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const item = entry as Record<string, unknown>
        if (typeof item.scope !== 'string' || item.scope === '') continue
        const scope = normalizeScopeKey(item.scope)
        if (!isWellFormedScopeKey(scope)) continue
        const permissions = cleanPermissions(item.permissions)
        if (permissions.length === 0) continue
        const prev = seen.get(scope)
        if (prev !== undefined) {
          for (const perm of permissions) if (!prev.includes(perm)) prev.push(perm)
        } else {
          seen.set(scope, permissions)
        }
      }
      for (const [scope, permissions] of seen) scopes.push({ scope, permissions })
      return {
        version: DELEGATION_CAP_VERSION,
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : sessionId,
        createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
        scopes,
        ...(typeof value.grantedBy === 'string' ? { grantedBy: value.grantedBy } : {}),
      }
    } catch {
      // 损坏的 cap 保守处理为「空继承」，绝不因为读不出来而放宽权限。
      return { version: DELEGATION_CAP_VERSION, sessionId, createdAt: Date.now(), scopes: [] }
    }
  }

  /** 写入 / 覆盖上限。合并已有权限（只增不减由调用方决定是否重算）。 */
  set(input: DelegationCapInput): DelegationCap {
    const scopes: ScopeCapEntry[] = []
    const seen = new Map<string, GrantPermission[]>()
    for (const entry of input.scopes) {
      const scope = normalizeScopeKey(entry.scope)
      if (!isWellFormedScopeKey(scope)) continue
      const permissions = cleanPermissions(entry.permissions)
      if (permissions.length === 0) continue
      const prev = seen.get(scope)
      if (prev !== undefined) {
        for (const perm of permissions) if (!prev.includes(perm)) prev.push(perm)
      } else {
        seen.set(scope, permissions)
      }
    }
    for (const [scope, permissions] of seen) scopes.push({ scope, permissions })
    const cap: DelegationCap = {
      version: DELEGATION_CAP_VERSION,
      sessionId: input.sessionId,
      createdAt: Date.now(),
      scopes,
      ...(input.grantedBy !== undefined ? { grantedBy: input.grantedBy } : {}),
    }
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(input.sessionId)
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, `${JSON.stringify(cap, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return cap
  }

  /** 在已有上限上追加权限（父代理批准子代理申请时用）。 */
  addPermissions(sessionId: string, scopes: ReadonlyArray<{ scope: string; permissions: readonly GrantPermission[] }>, grantedBy?: string): DelegationCap {
    const existing = this.get(sessionId)
    const merged = new Map<string, GrantPermission[]>()
    for (const entry of existing?.scopes ?? []) merged.set(entry.scope, [...entry.permissions])
    for (const entry of scopes) {
      const scope = normalizeScopeKey(entry.scope)
      if (!isWellFormedScopeKey(scope)) continue
      const permissions = cleanPermissions(entry.permissions)
      const prev = merged.get(scope) ?? []
      for (const perm of permissions) if (!prev.includes(perm)) prev.push(perm)
      merged.set(scope, prev)
    }
    return this.set({
      sessionId,
      scopes: [...merged].map(([scope, permissions]) => ({ scope, permissions })),
      ...(grantedBy !== undefined ? { grantedBy } : existing?.grantedBy !== undefined ? { grantedBy: existing.grantedBy } : {}),
    })
  }

  remove(sessionId: string): void {
    try {
      const file = this.fileFor(sessionId)
      if (existsSync(file)) renameSync(file, `${file}.removed-${randomUUID().slice(0, 8)}`)
    } catch { /* 清理失败不影响主流程 */ }
  }
}
