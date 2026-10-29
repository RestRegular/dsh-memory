/**
 * 统一的访问判定（0.24.0 / D2）。
 *
 * 目标：**所有入口只解释一套规则**。此前可见域判定散落在工具层（`recordAllowed` /
 * `scopeWritable`）、provider（`visibilityFilterFor` / `isScopeReadable` /
 * `isScopeWritable` / `assertOperable`）和注入层（`autoRecallScopes` /
 * `visibleKinds`），同一份策略在不同入口可能给出不同答案。
 *
 * 这里的语义是产品决策，不是实现细节：
 *   - `absolute`：**没有审批放行路径**。范围外一律拒绝，`requestable` 恒为 false；
 *   - `normal`：范围外可被拒绝但可审批（`requestable=true`）；用户显式关掉
 *     `read` / `write` 的作用域不可审批，必须先由用户打开开关；
 *   - `none`：不限制（策略里的 scopes 只是偏好）；
 *   - `discover` 只受作用域类型开关约束：`absolute` 下名字/用途仍可发现，
 *     这正是“目录可见、正文不可读”的边界；
 *   - 作用域类型被配置关闭（如 `customEnabled=false`）时，连 discover 都拒绝。
 *
 * 纯函数、无 I/O；provider 负责把 agent 上下文解析成 `AccessContext`。
 */
import type { VisibilityLevel, VisibilityRule } from './session-visibility.ts'
import type { ScopeKind } from './scope.ts'

export type MemoryAction = 'discover' | 'read' | 'write' | 'delete'

export interface AccessRequest {
  /** 已规范化的作用域键（provider 负责 canonicalScope）。 */
  scope: string
  action: MemoryAction
  /** 记录类型；只为兼容旧的 `kinds` 白名单，缺省不按类型收窄。 */
  kind?: string
}

export type AccessDenyReason =
  | 'SCOPE_DISABLED'
  | 'SCOPE_NOT_IN_RANGE'
  | 'READ_DISABLED'
  | 'WRITE_DISABLED'
  | 'KIND_NOT_ALLOWED'
  | 'ABSOLUTE_ISOLATION'
  /** 0.30.0：宿主里该会话已归档 —— 作用域与记忆被冻结，恢复会话后自动恢复。 */
  | 'SCOPE_ARCHIVED'

export interface AccessDecision {
  allowed: boolean
  reason?: AccessDenyReason
  /** 这次拒绝能否通过用户审批解决。absolute 永远 false。 */
  requestable: boolean
  source?: 'unrestricted' | 'in-range' | 'directory' | 'grant'
  /** 命中的作用域规则（范围外 / 关闭时没有）。 */
  rule?: VisibilityRule
}

/** 会话授权（0.24.0 / D3）；只有 normal 等级、且作用域在范围外时才参与判定。 */
export interface GrantView {
  scope: string
  permissions: readonly ('read' | 'write')[]
}

export interface AccessContext {
  level: VisibilityLevel
  /** 已规范化、已剔除禁用项的作用域规则。 */
  scopes: readonly VisibilityRule[]
  /** 四类作用域的产品开关。 */
  enabled: Record<ScopeKind, boolean>
  /** 作用域键 → 类型（provider 的 scopeKind）。 */
  originOf(scope: string): ScopeKind
  /** 当前会话（含父会话继承）的有效 grant；absolute 下忽略。 */
  grants?: readonly GrantView[]
  /**
   * 0.30.0：宿主里已归档的**会话作用域键**（`session:<id>`）。归档只冻结
   * 读/写/删除，不阻止目录发现 —— 名字与用途仍然可见，正文不可读。
   */
  archivedScopes?: ReadonlySet<string>
}

function outsideDecision(level: VisibilityLevel): AccessDecision {
  return level === 'absolute'
    ? { allowed: false, reason: 'ABSOLUTE_ISOLATION', requestable: false }
    : { allowed: false, reason: 'SCOPE_NOT_IN_RANGE', requestable: level === 'normal' }
}

export function authorize(request: AccessRequest, context: AccessContext): AccessDecision {
  if (!context.enabled[context.originOf(request.scope)]) {
    return { allowed: false, reason: 'SCOPE_DISABLED', requestable: false }
  }
  // 归档是宿主生命周期事实，不是可见域策略：没有审批放行路径，也**不允许**申请。
  // discover 仍然允许（目录/面板要能看出「这个作用域已归档」），正文一律不可读。
  if (context.archivedScopes?.has(request.scope) === true) {
    if (request.action === 'discover') return { allowed: true, source: 'directory' }
    return { allowed: false, reason: 'SCOPE_ARCHIVED', requestable: false }
  }
  if (request.action === 'discover') {
    return { allowed: true, source: 'directory' }
  }
  if (context.level === 'none') {
    return { allowed: true, source: 'unrestricted' }
  }
  const rule = context.scopes.find((item) => item.scope === request.scope)
  /** 范围外时先看会话 grant；**只在 normal 下**，absolute 没有任何例外。 */
  const granted = (permission: 'read' | 'write'): boolean =>
    context.level === 'normal' && context.grants?.some((grant) =>
      grant.scope === request.scope && grant.permissions.includes(permission)) === true
  if (request.action === 'read') {
    if (rule === undefined) {
      return granted('read')
        ? { allowed: true, source: 'grant' }
        : outsideDecision(context.level)
    }
    if (rule.read === false) return { allowed: false, reason: 'READ_DISABLED', requestable: false, rule }
    if (rule.kinds !== undefined && rule.kinds.length > 0
      && (request.kind === undefined || !rule.kinds.includes(request.kind))) {
      return { allowed: false, reason: 'KIND_NOT_ALLOWED', requestable: false, rule }
    }
    return { allowed: true, source: 'in-range', rule }
  }
  // write / delete：0.24 起删除仍归在 write；独立 delete 权限留给后续版本。
  if (rule === undefined) {
    return granted('write')
      ? { allowed: true, source: 'grant' }
      : outsideDecision(context.level)
  }
  if (rule.write === false) return { allowed: false, reason: 'WRITE_DISABLED', requestable: false, rule }
  return { allowed: true, source: 'in-range', rule }
}
