/**
 * 会话级作用域授权（grants）。
 *
 * 与「可见域」分开存储是刻意的：`visibility/<session>.json` 是**用户对会话策略**的
 * 显式声明（可整份重置），而 grant 是 Agent 申请、用户批准出来的**例外**，需要
 * grantId、主体、能力、到期、撤销与审计。混在一份文件里时，面板保存 / 恢复默认 /
 * 撤销授权会互相误伤。
 *
 * 位置：`<storeDir>/grants/<safeName(session)>.json`，每个会话一个文件（与
 * `visibility/` 同款并发取舍：按会话分文件，写入只碰自己那份，原子 rename）。
 *
 * 语义（0.24.0 / D3）：
 *   - 只有 `duration: 'session'` 会落盘；`once` 继续走现有 allowed-once 审批，不持久化；
 *   - 只读 / 可写分开授权，互不推导；
 *   - 子 Agent 沿 parentSession 链继承（provider 负责解析链，本文件只管单会话）；
 *   - `absolute` 下 grant **不生效**（硬隔离），由 authorize 负责判断，存储层不解释等级；
 *   - 作用域键被删除重建后，`scopeGeneration` 对不上即失效（S6）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const GRANTS_VERSION = 1

export type GrantPermission = 'read' | 'write'
export const GRANT_PERMISSIONS: readonly GrantPermission[] = ['read', 'write']

export interface ScopeGrant {
  id: string
  scope: string
  permissions: GrantPermission[]
  /** 0.24 只落 session；workspace / global 留给后续版本。 */
  duration: 'session'
  sessionId: string
  grantedBy: string
  grantedAt: number
  expiresAt?: number
  revokedAt?: number
  /** 授权时作用域的创建代次；作用域重建后代次变化，旧 grant 失效。 */
  scopeGeneration?: string
}

interface GrantFile {
  version: number
  sessionId: string
  grants: ScopeGrant[]
}

/** 会话 id 通常已经是 UUID；异常字符换成 `_`，改写过的再加 8 位 hash 防碰撞。 */
function safeName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  if (cleaned === sessionId && cleaned !== '') return cleaned
  const base = cleaned === '' ? 'session' : cleaned.slice(0, 64)
  return `${base}-${createHash('sha1').update(sessionId).digest('hex').slice(0, 8)}`
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function cleanPermissions(raw: unknown): GrantPermission[] {
  if (!Array.isArray(raw)) return []
  const out: GrantPermission[] = []
  for (const item of raw) {
    if ((item === 'read' || item === 'write') && !out.includes(item)) out.push(item)
  }
  return out
}

function parseGrant(raw: unknown, sessionId: string): ScopeGrant | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const scope = asString(value.scope)
  const id = asString(value.id)
  if (scope === undefined || id === undefined) return undefined
  const permissions = cleanPermissions(value.permissions)
  if (permissions.length === 0) return undefined
  return {
    id,
    scope,
    permissions,
    duration: 'session',
    sessionId: asString(value.sessionId) ?? sessionId,
    grantedBy: asString(value.grantedBy) ?? 'user',
    grantedAt: typeof value.grantedAt === 'number' && Number.isFinite(value.grantedAt) ? value.grantedAt : Date.now(),
    ...(typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
    ...(typeof value.revokedAt === 'number' && Number.isFinite(value.revokedAt) ? { revokedAt: value.revokedAt } : {}),
    ...(asString(value.scopeGeneration) !== undefined ? { scopeGeneration: asString(value.scopeGeneration) } : {}),
  }
}

export interface SessionGrantsStoreOptions {
  root: string
}

export interface ScopeGrantInput {
  scope: string
  permissions: readonly GrantPermission[]
  grantedBy?: string
  expiresAt?: number
  scopeGeneration?: string
}

export class SessionGrantsStore {
  readonly dir: string

  constructor(options: SessionGrantsStoreOptions) {
    this.dir = join(options.root, 'grants')
  }

  fileFor(sessionId: string): string {
    return join(this.dir, `${safeName(sessionId)}.json`)
  }

  /** 某会话自己的 grant（不含已撤销 / 已过期；子 Agent 链由 provider 负责）。 */
  list(sessionId: string): ScopeGrant[] {
    const file = this.fileFor(sessionId)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return []
    }
    let raw: unknown
    try {
      raw = JSON.parse(text) as unknown
    } catch {
      return []
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
    const grants = (raw as { grants?: unknown }).grants
    if (!Array.isArray(grants)) return []
    const now = Date.now()
    const out: ScopeGrant[] = []
    for (const item of grants) {
      const grant = parseGrant(item, sessionId)
      if (grant === undefined) continue
      if (grant.revokedAt !== undefined) continue
      if (grant.expiresAt !== undefined && grant.expiresAt <= now) continue
      out.push(grant)
    }
    return out
  }

  /** 所有会话的 grant 文件（面板审计 / 清理用）。 */
  listAll(): ScopeGrant[] {
    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return []
    }
    const out: ScopeGrant[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const sessionId = entry.slice(0, -'.json'.length)
      // 文件名可能被 safeName 改写；grant 自身带 sessionId，优先用它。
      for (const grant of this.list(sessionId)) out.push(grant)
    }
    return out
  }

  /**
   * 新增或合并授权：同一作用域已有有效 grant 时合并权限（read / write 独立），
   * 不重复造条目；`scopeGeneration` 变化视为新代次，旧条目先撤销再新增。
   */
  add(sessionId: string, input: ScopeGrantInput): ScopeGrant {
    const permissions = cleanPermissions(input.permissions)
    if (permissions.length === 0) throw new Error('grant requires at least one permission')
    const all = this.readAll(sessionId)
    const now = Date.now()
    const existing = all.grants.find((grant) => grant.scope === input.scope
      && grant.revokedAt === undefined
      && (grant.expiresAt === undefined || grant.expiresAt > now)
      && (grant.scopeGeneration === input.scopeGeneration))
    if (existing !== undefined) {
      const merged = [...new Set([...existing.permissions, ...permissions])] as GrantPermission[]
      existing.permissions = merged
      existing.grantedAt = now
      if (input.expiresAt !== undefined) existing.expiresAt = input.expiresAt
      this.write(sessionId, all)
      return existing
    }
    // 同作用域但代次不同：旧代次的 grant 明确作废，避免“同名重建复活旧授权”。
    for (const grant of all.grants) {
      if (grant.scope === input.scope && grant.revokedAt === undefined && grant.scopeGeneration !== input.scopeGeneration) {
        grant.revokedAt = now
      }
    }
    const grant: ScopeGrant = {
      id: randomUUID(),
      scope: input.scope,
      permissions,
      duration: 'session',
      sessionId,
      grantedBy: input.grantedBy ?? 'user',
      grantedAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.scopeGeneration !== undefined ? { scopeGeneration: input.scopeGeneration } : {}),
    }
    all.grants.push(grant)
    this.write(sessionId, all)
    return grant
  }

  /** 撤销一条授权；返回是否找到。 */
  revoke(sessionId: string, id: string): boolean {
    const all = this.readAll(sessionId)
    const grant = all.grants.find((item) => item.id === id)
    if (grant === undefined) return false
    grant.revokedAt = Date.now()
    this.write(sessionId, all)
    return true
  }

  private readAll(sessionId: string): { version: number; sessionId: string; grants: ScopeGrant[] } {
    const file = this.fileFor(sessionId)
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const grants = (raw as { grants?: unknown }).grants
        if (Array.isArray(grants)) {
          return {
            version: GRANTS_VERSION,
            sessionId,
            grants: grants.map((item) => parseGrant(item, sessionId)).filter((item): item is ScopeGrant => item !== undefined),
          }
        }
      }
    } catch { /* 没有 / 坏文件 → 空 */ }
    return { version: GRANTS_VERSION, sessionId, grants: [] }
  }

  private write(sessionId: string, all: { version: number; sessionId: string; grants: ScopeGrant[] }): void {
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(sessionId)
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    const payload: GrantFile = { version: GRANTS_VERSION, sessionId, grants: all.grants }
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  }
}
