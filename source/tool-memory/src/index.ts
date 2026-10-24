/**
 * Tool implementations as plain data + functions. Keeping them free of both
 * cordis and dsh-tools imports lets us unit-test the exact argument/response
 * contracts standalone; the DSH entry (apply.ts) wraps them with defineTool.
 *
 * scope 语义(0.5.0 起):
 *   - 省略 scope:写 → 当前会话;读 → 会话 + 项目 + global 三路合并(provider 决定具体键);
 *   - 'global' / 'project' / 任意自定义名 / 'session:<id>' / 'project:<path>' 都是显式 pin;
 *   - 'all'(或 '*')只对读路径有效,写路径报 SCOPE_NOT_WRITABLE。
 * 解析全部交给 `memory-local/scope.ts` 的 normalizeScopeInput + provider 的
 * resolveReadScopes/resolveWriteScope —— 这里**不再**有任何"smoothing over"式的静默回退。
 */
import type { MemoryScope } from 'dsh-memory'
import { isAbsolute, resolve } from 'node:path'
import { canonicalWorkspacePath, normalizeScopeInput, resolveScopeRef } from '../../memory-local/src/scope.ts'

/** Shape each tool shares: JSON-schema parameters + canonical output value. */
export interface ToolSpec<A, O> {
  name: string
  description: string
  parameters: unknown
  execute(args: A, exec?: unknown): Promise<O>
}

/** provider 的 getByIds 返回的记录形状（工具层只读这些字段）。 */
export interface GetSourceRecord {
  id: string
  scope: string
  kind: string
  content: string
  tags: string[]
  importance: number
  createdAt: number
  updatedAt: number
  expiredAt?: number
  supersedes?: string
  triggers?: string[]
}

/** 范围外访问的处理方式(与 provider 的会话可见域一致)。 */
export type VisibilityLevel = 'absolute' | 'normal' | 'none'

/** 一次范围外审批的结局:允许一次 / 用户拒绝 / 超时未答 / 当前版本不支持审批。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'timeout' | 'unavailable'

/**
 * 一次范围外审批的结论(0.21.0)。
 *
 * `allowed-once` 默认 = 本次请求**全部**允许;用户在审批卡里逐条勾选时，可带
 * `allowedIds` 只允许其中一部分。老 provider 可能仍直接返回字符串，工具层兼容。
 */
export interface ApprovalDecision {
  outcome: ApprovalOutcome
  /** 只允许这些条目 id;省略 = allowed-once 覆盖本次请求的全部条目。 */
  allowedIds?: string[]
}

/** provider 的 requestOutOfScope 可以返回裸字符串(旧口径)或带 allowedIds 的对象。 */
export type ApprovalAnswer = ApprovalOutcome | ApprovalDecision

/**
 * 被可见域挡住、没有返回给模型的原因(absolute 模式不会出现:一律视为不存在)。
 * `partial` = 用户只允许了其中几条，其余按拒绝处理。
 */
export type WithheldReason = 'rejected' | 'timeout' | 'unavailable' | 'partial'

export interface VisibilityRuleView {
  scope: string
  /** 省略/空 = 该作用域全部类型可见。 */
  kinds?: string[]
}

/**
 * provider 解析出的生效可见域。0.20.0 起 provider 永远返回一份策略:
 * 没有显式覆盖时是「会话 + 项目 + global」+ 普通限制,`source === 'default'`。
 * 老 provider 仍可能返回 undefined(视为不限制)。
 */
export interface VisibilityPolicyView {
  level: VisibilityLevel
  scopes: VisibilityRuleView[]
  /** 这份策略的来源:显式保存 / 继承父会话 / 默认策略。 */
  source?: 'explicit' | 'inherited' | 'default'
}

/** 一条范围外命中,交给审批浮层展示。 */
export interface VisibilityApprovalItem {
  id: string
  scope: string
  kind: string
  content: string
  tags: string[]
  importance: number
  updatedAt: number
  reason: 'scope' | 'kind'
}

/**
 * 一个会话的上下文去重视图(0.21.0)。由入口从注入半边提供的
 * `memoryContextDedup` 服务接进来；没有时工具保持老行为(每次都带摘要)。
 *
 * 为什么要它：memory_search / memory_list 的摘要在同一会话里重复命中时
 * 会把同样的内容反复塞回上下文。工具层只问“这条是否已经以同版本出现过”，
 * 具体状态(摘要/正文/版本)由注入半边的 InjectionState 统一维护。
 */
export interface ContextDedupView {
  /** 这批记录里哪些已经以同版本进入过上下文。 */
  seen(records: ReadonlyArray<{ id: string; updatedAt: number }>): Set<string>
  /** memory_search 返回了摘要。 */
  markSummary(records: ReadonlyArray<{ id: string; updatedAt: number }>): void
  /** memory_list 返回了正文。 */
  markContent(records: ReadonlyArray<{ id: string; updatedAt: number }>): void
}

/** 只有这一层需要的能力子集(provider 在宿主里提供,测试里可以 mock)。 */
export interface MemoryToolService {
  save(input: unknown): Promise<{ id: string; scope: string }>
  search(input: unknown): Promise<Array<{ record: { id: string; scope: string; kind: string; updatedAt: number; content: string; tags?: string[]; importance?: number }; score: number }>>
  forget(input: unknown): Promise<{ removed: number; ids: string[] }>
  list(input?: unknown): Promise<Array<{ id: string; scope: string; kind: string; updatedAt: number; content: string; tags?: string[]; importance?: number }>>
  /** 读 "all" 前把所有磁盘上的 scope 发现出来。 */
  discoverScopes?(): MemoryScope[]
  /** 作用域清单(scope + 记录数),用于 memory_list 的尾部摘要与错误提示。 */
  scopeStats?(): Array<{ scope: string; records: number; pendingEmbeds: number }>
  /** 无显式 scope 时的合并读取集合(会话 + 项目 + global)。 */
  resolveReadScopes?(agent: unknown): MemoryScope[]
  /**
   * 显式「可见范围」覆盖(undefined = 未设置)。设置后工具必须把它当作白名单:
   * 显式 scope / `all` / memory_get 都不能绕过。
   */
  visibleScopes?(agent: unknown): MemoryScope[]
  /** 完整可见域(等级 + 每个 scope 的类型白名单);老 provider 可能返回 undefined。 */
  visibilityPolicy?(agent: unknown): VisibilityPolicyView | undefined
  /**
   * 某个 scope 是否可读**且可写**(可见范围 = 可操作范围)。provider 的权威口径;
   * 旧 provider 没有时工具层用 visibilityPolicy 自己判断。
   */
  isScopeOperable?(agent: unknown, scope: string): boolean
  /**
   * 普通限制:向用户发起一次范围外访问审批(等待面板回答)。
   * 结局必须区分「拒绝 / 超时 / 不支持审批」—— 模型要看到真实原因。
   * 0.21.0 起可返回 `{ outcome, allowedIds }` 支持逐条允许。
   * `description` 是模型为这次调用写的用途说明,审批弹窗会展示给用户(0.22.0)。
   */
  requestOutOfScope?(agent: unknown, input: { tool: string; action?: 'read' | 'write' | 'delete'; query: string; description?: string; items: VisibilityApprovalItem[]; signal?: AbortSignal }): Promise<ApprovalAnswer>
  /** 按 id 批量取记录(召回摘要里带了 id,模型可直接取全文)。 */
  getByIds?(ids: string[]): GetSourceRecord[]
  /** 写路径默认 scope(省略 scope 时落到哪)。 */
  resolveWriteScope?(agent: unknown, requested?: string): MemoryScope
  /**
   * 当前项目 key(会话 cwd 优先)。工具层解析 `scope:'project'` 时**必须**用它,
   * 否则工具层与服务端会各自算一个项目键(0.5.5 及以前就是这么错的)。
   */
  projectKeyFor?(agent: unknown): MemoryScope
}

export interface MemoryToolsOptions {
  /** Resolves the service lazily so tools fail with a clear message pre-load. */
  getService(): MemoryToolService | undefined
  /** 写路径默认口径(tools.defaultScope),缺省 'session'。 */
  defaultScope?: 'session' | 'project' | 'global'
  /** 当前项目 scope 键(projectScope 配置或 project:<cwd>)。 */
  projectScope?: string
  /**
   * 取当前 exec 对应的会话上下文去重视图(0.21.0)。
   * 入口从注入半边提供的 `memoryContextDedup` 服务接进来;返回 undefined =
   * 没有会话 / 服务不可用 → 不去重，保持老行为。
   */
  contextDedup?(exec: unknown): ContextDedupView | undefined
}

const SCOPE_DESCRIPTION =
  "省略=当前会话；'global'=所有项目共享；'project'=当前工作区；其他任意名称=自定义作用域"
  + "(memory_save 时不存在则自动创建)。读取时可用 'all' 跨所有作用域。"

export class MemoryToolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function svc(opts: MemoryToolsOptions): MemoryToolService {
  const s = opts.getService()
  if (!s) throw new MemoryToolError('SERVICE_UNAVAILABLE', 'memory service is not loaded; check that dsh-memory-local is enabled')
  return s
}

function toolError(error: unknown): MemoryToolError {
  if (error instanceof MemoryToolError) return error
  const code = (error as { code?: unknown } | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  return new MemoryToolError(typeof code === 'string' ? code : 'MEMORY_ERROR', message)
}

/** 供 apply.ts 使用的实例内 agent(宿主 exec.agent)。 */
function agentOf(exec: unknown): unknown {
  return (exec as { agent?: unknown } | undefined)?.agent
}

/**
 * 当前项目 key。优先级:**服务端解析的会话 cwd** → 显式配置 → process.cwd()。
 *
 * 服务端那一步不能省:DSH 服务进程的 process.cwd() 是 profile 目录,只有
 * `session.header.cwd` 才是工作区;而 mock / 旧 provider 没有 `projectKeyFor` 时,
 * 只能退回配置与 process.cwd()(与旧行为一致,不把测试和旧宿主打断)。
 */
function projectKey(opts: MemoryToolsOptions, service?: MemoryToolService, agent?: unknown): MemoryScope {
  const resolved = service?.projectKeyFor?.(agent)
  if (typeof resolved === 'string' && resolved.length > 0) return resolved as MemoryScope
  return (opts.projectScope ?? `project:${process.cwd()}`) as MemoryScope
}

/**
 * 显式「可见范围」白名单;undefined = 本会话没有显式覆盖(注入半边用它判断
 * 要不要关掉 extraScopes,工具层不用它做读限制 —— 那是 visibilityPolicy 的事)。
 * provider 方法抛错时按"没有覆盖"处理:可见范围是防越界,不应该让一个 provider
 * 内部错误把所有读取都锁死。
 */
function visibleScopeList(service: MemoryToolService, agent: unknown): MemoryScope[] | undefined {
  try {
    const explicit = service.visibleScopes?.(agent)
    if (Array.isArray(explicit)) return [...new Set(explicit)]
  } catch { /* 降级为不限制 */ }
  return undefined
}

/**
 * 完整可见域;老 provider / 解析失败时退化为 undefined(不限制)。
 * 0.20 的 provider 永远返回策略:没有显式覆盖时是默认策略(source='default'),
 * 默认范围 = 会话 + 项目 + global,等级 = normal。
 */
function visibilityPolicy(service: MemoryToolService, agent: unknown): VisibilityPolicyView | undefined {
  try {
    const policy = service.visibilityPolicy?.(agent)
    if (policy !== undefined && policy !== null) {
      const level: VisibilityLevel = policy.level === 'absolute' || policy.level === 'none' ? policy.level : 'normal'
      const source = policy.source === 'explicit' || policy.source === 'inherited' || policy.source === 'default'
        ? policy.source
        : undefined
      return {
        level,
        scopes: Array.isArray(policy.scopes) ? policy.scopes : [],
        ...(source !== undefined ? { source } : {}),
      }
    }
  } catch { /* 降级为不限制 */ }
  return undefined
}

/** 是否"用户显式设过的策略"(默认策略不算):决定普通限制下要不要把范围外也搜一遍。 */
function explicitPolicy(policy: VisibilityPolicyView | undefined): boolean {
  return policy !== undefined && policy.source !== 'default'
}

function scopeInPolicy(policy: VisibilityPolicyView | undefined, scope: string): boolean {
  if (policy === undefined || policy.level === 'none') return true
  return policy.scopes.some((rule) => rule.scope === scope)
}

/** 这条记录是否在可见域内(scope 与类型都要满足)。 */
function recordAllowed(policy: VisibilityPolicyView | undefined, scope: string, kind: string): boolean {
  if (policy === undefined || policy.level === 'none') return true
  const rule = policy.scopes.find((item) => item.scope === scope)
  if (rule === undefined) return false
  return rule.kinds === undefined || rule.kinds.length === 0 || rule.kinds.includes(kind)
}

/** 记录在可见域外时,是"整个 scope 不可见"还是"只是类型不允许"。 */
function outsideReason(policy: VisibilityPolicyView | undefined, scope: string): 'scope' | 'kind' {
  return scopeInPolicy(policy, scope) ? 'kind' : 'scope'
}

/** memory_* 的 description 参数说明(模型可见)。 */
const DESCRIPTION_PARAM_DESCRIPTION =
  '本次调用要做什么（一句话，给用户看）。本会话「记忆范围」为普通限制时必填：审批范围外记忆时，弹窗会把它展示给用户。'

/**
 * 把模型的 description 收拾成一行(审批弹窗里展示)。
 * 省略/空白 = undefined(是否合法由 requireDescription 按限制等级判断)。
 */
function descriptionOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.replace(/\s+/g, ' ').trim()
  return value === '' ? undefined : value.slice(0, 500)
}

/**
 * 「记忆范围」为普通限制时,memory_* 必须写 description:审批弹窗要把 Agent 的
 * 意图展示给用户,只有工具名 + 查询词不够判断该不该放行。
 *
 * 拿不到会话(老宿主 / 测试 mock / 面板直调)时不强制 —— 没有会话就没有审批弹窗;
 * absolute / none 也不强制(前者范围外一律视为不存在,后者不需要审批)。
 */
function requireDescription(service: MemoryToolService, agent: unknown, raw: unknown): void {
  if (agent === undefined) return
  const policy = visibilityPolicy(service, agent)
  if (policy === undefined || policy.level !== 'normal') return
  if (descriptionOf(raw) !== undefined) return
  throw new MemoryToolError(
    'DESCRIPTION_REQUIRED',
    '本会话「记忆范围」为普通限制：调用 memory_* 工具时必须提供 description 字段，用一句话说明这次调用要做什么（审批范围外记忆时弹窗会展示给用户）。',
  )
}

function recordsToApprovalItems(
  policy: VisibilityPolicyView | undefined,
  records: readonly { id: string; scope: string; kind: string; content: string; tags?: string[]; importance?: number; updatedAt: number }[],
): VisibilityApprovalItem[] {
  return records.map((record) => ({
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    content: record.content,
    tags: Array.isArray(record.tags) ? record.tags : [],
    importance: typeof record.importance === 'number' ? record.importance : 0,
    updatedAt: record.updatedAt,
    reason: outsideReason(policy, record.scope),
  }))
}

/**
 * 普通限制:把范围外访问交给用户审批一次。
 * 结局必须可区分:允许一次 / 用户拒绝 / 超时 / 旧 provider 不支持审批。
 * `agent` 省略 = 不审批(工具层在拿不到会话时退回 provider 的护栏)。
 * 允许写/删时要带 `approvedItems` 之类的合成条目,浮层才显示得出来。
 *
 * 0.21.0:允许的条目可以是"全部"(allowedIds 省略)或用户在审批卡里逐条勾选的
 * 一部分;后者通过 `allowedIds` 返回,调用方只放行这些 id。
 */
interface ApprovalVerdict {
  outcome: ApprovalOutcome
  /** undefined = allowed-once 覆盖本次请求的全部条目。 */
  allowedIds?: Set<string>
}

async function askOutOfScope(
  service: MemoryToolService,
  agent: unknown,
  policy: VisibilityPolicyView | undefined,
  tool: string,
  query: string,
  records: readonly { id: string; scope: string; kind: string; content: string; tags?: string[]; importance?: number; updatedAt: number }[],
  action: 'read' | 'write' | 'delete',
  signal?: AbortSignal,
  description?: string,
): Promise<ApprovalVerdict> {
  if (records.length === 0) return { outcome: 'allowed-once' }
  if (typeof service.requestOutOfScope !== 'function') return { outcome: 'unavailable' }
  if (signal?.aborted) return { outcome: 'rejected' }
  try {
    const answer = await service.requestOutOfScope(agent, {
      tool,
      action,
      query,
      ...(description !== undefined ? { description } : {}),
      items: recordsToApprovalItems(policy, records),
      ...(signal !== undefined ? { signal } : {}),
    })
    // 老 provider 直接返回字符串;新 provider 返回 { outcome, allowedIds }。
    const decision: ApprovalDecision = typeof answer === 'string' ? { outcome: answer } : answer ?? { outcome: 'unavailable' }
    const outcome: ApprovalOutcome = decision.outcome === 'allowed-once' || decision.outcome === 'timeout' || decision.outcome === 'unavailable'
      ? decision.outcome
      : 'rejected'
    const ids = outcome === 'allowed-once' && Array.isArray(decision.allowedIds)
      ? new Set(decision.allowedIds.map(String))
      : undefined
    // 逐条勾选但一条都没选中 = 用户拒绝了这次访问。
    if (ids !== undefined && ids.size === 0) return { outcome: 'rejected' }
    return { outcome, ...(ids !== undefined ? { allowedIds: ids } : {}) }
  } catch {
    return { outcome: 'unavailable' }
  }
}

/** 这次审批是否允许这一条(没有 allowedIds = 全部允许)。 */
function verdictAllows(verdict: ApprovalVerdict, id: string): boolean {
  if (verdict.outcome !== 'allowed-once') return false
  return verdict.allowedIds === undefined || verdict.allowedIds.has(id)
}

/** 审批没通过时给模型的真实原因(写/删路径直接抛这个错误)。 */
function visibilityError(outcome: WithheldReason, action: 'write' | 'delete', scope: string): MemoryToolError {
  const verb = action === 'write' ? '写入' : '删除'
  if (outcome === 'rejected') {
    return new MemoryToolError(
      'VISIBILITY_REJECTED',
      `用户拒绝了本次${verb}请求（作用域 ${scope}，当前限制等级：普通限制），没有执行。如需${verb}，请让用户调整「记忆范围」后重试。`,
    )
  }
  if (outcome === 'timeout') {
    return new MemoryToolError(
      'VISIBILITY_TIMEOUT',
      `等待用户审批超时（5 分钟没有答复），本次${verb}没有执行（作用域 ${scope}，当前限制等级：普通限制）。`,
    )
  }
  return new MemoryToolError(
    'VISIBILITY_UNAVAILABLE',
    `当前环境无法就范围外访问发起审批，本次${verb}没有执行（作用域 ${scope}）。`,
  )
}

/** 写入/删除前判断一个 scope 是否可操作(可见范围 = 可操作范围)。 */
function scopeOperable(service: MemoryToolService, agent: unknown, policy: VisibilityPolicyView | undefined, scope: string): boolean {
  if (policy === undefined || policy.level === 'none') return true
  try {
    const verdict = service.isScopeOperable?.(agent, scope)
    if (typeof verdict === 'boolean') return verdict
  } catch { /* 退回本地判断 */ }
  return scopeInPolicy(policy, scope)
}

/** 规范里所有已知 scope(用来在普通限制下把范围外也搜一遍,看看有没有可审批的命中)。 */
function allKnownScopes(service: MemoryToolService): MemoryScope[] {
  try {
    service.discoverScopes?.()
    return [...new Set((service.scopeStats?.() ?? []).map((item) => item.scope))]
  } catch {
    return []
  }
}

/** 该服务/配置下"当前会话 + 当前项目 + global"的合并读取集合(去重)。 */
function readScopes(opts: MemoryToolsOptions, service: MemoryToolService, agent: unknown): MemoryScope[] {
  // 显式可见范围优先,空数组也要原样返回(表示什么都不允许读)。
  const explicit = visibleScopeList(service, agent)
  if (explicit !== undefined) return explicit
  const provided = service.resolveReadScopes?.(agent)
  if (Array.isArray(provided) && provided.length > 0) return [...new Set(provided)]
  // 服务没提供(测试 mock / 旧 provider):退回 defaultScope 口径
  const fallback = opts.defaultScope === 'global' ? 'global' : projectKey(opts, service, agent)
  return [...new Set([fallback, 'global'])]
}

/** 写路径默认口径;provider 不支持时退回 project。 */
function writeDefault(opts: MemoryToolsOptions): 'session' | 'project' | 'global' {
  return opts.defaultScope ?? 'session'
}

/** 规范化 + 落到具体 key(或 all)。 */
function resolveScope(
  opts: MemoryToolsOptions,
  service: MemoryToolService,
  exec: unknown,
  raw: string | undefined,
  mode: 'read' | 'write',
): { all?: boolean; scope?: MemoryScope } {
  const normalized = normalizeScopeInput(raw)
  if (!normalized.ok) throw new MemoryToolError('SCOPE_INVALID', normalized.message)
  if (normalized.kind === 'global') return { scope: 'global' }
  const agent = agentOf(exec)
  const project = projectKey(opts, service, agent)
  // 当前会话 key 由 provider 解析(只有它知道 scopes.session 开关与子代理共享父会话的规则);
  // provider 不在(测试 mock / 旧版本)时不给 session —— 写路径会回退 project,读路径回到合并集合。
  const session = service.resolveReadScopes?.(agent)?.find((s) => s.startsWith('session:'))
  const refs = { project, ...(session !== undefined ? { session } : {}) }
  const resolved = resolveScopeRef(normalized, refs, {
    mode,
    defaultScope: writeDefault(opts),
    // provider 的合并集合里没有会话 scope ⇒ scopes.session 关着(或拿不到会话);此时
    // 省略 scope 要干净地回退项目 scope,而不是撞 SCOPE_DISABLED。provider 根本没提供
    // 合并集合(测试 mock / 只实现 save 的旧 provider)时不带这一项:交给它的 save 兜底。
    ...(service.resolveReadScopes !== undefined ? { sessionEnabled: session !== undefined } : {}),
  })
  if (!resolved.ok) throw new MemoryToolError(resolved.code, resolved.message)
  if (resolved.all) return { all: true }
  return resolved.scope !== undefined ? { scope: resolved.scope } : {}
}

export interface SaveArgs {
  content: string
  scope?: string
  /** 工作区目录路径；给出后写入 project:<路径>，此时 scope 用作该作用域的显示名。 */
  path?: string
  kind?: string
  tags?: string[]
  importance?: number
  supersedes?: string
  /** 过期时间（毫秒时间戳）；kind='state' 不传时按设置里的默认 TTL。 */
  expiresAt?: number
  /** 相对有效期（毫秒）；与 expiresAt 二选一，显式值优先。 */
  ttlMs?: number
  /** 流程触发词(kind=procedure)。系统提示里的流程索引按它匹配任务/工具名。 */
  triggers?: string[]
  /** 本次调用的用途(给用户看);普通限制下必填,审批弹窗展示。 */
  description?: string
}

export interface SaveResult {
  id: string
  scope: string
  /** 作用域别名（这次写入顺带登记的名字）。 */
  scopeName?: string
  deduped: boolean
}

/**
 * `path` → 绝对工作区路径。相对路径按会话 cwd 解析（拿不到就按进程 cwd），
 * 再走 `canonicalWorkspacePath` 统一写法 —— 同一个目录必须只有一种 scope 键，
 * 否则 `project:<路径>` 会分叉（`D:/x` 与 `D:\x` 曾是两个 scope，见 0.11.1）。
 */
function resolveWorkspacePath(raw: string, agent: unknown): string {
  const value = raw.trim()
  if (value === '') throw new MemoryToolError('PATH_INVALID', 'path 不能为空')
  const cwd = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  return canonicalWorkspacePath(isAbsolute(value) ? value : resolve(base, value))
}

export function memorySaveTool(opts: MemoryToolsOptions): ToolSpec<SaveArgs, SaveResult> {
  return {
    name: 'memory_save',
    description: 'Save a durable memory (fact, decision, preference, procedure, rule, state) for future sessions.',
    parameters: {
      content: { type: 'string', description: 'Self-contained declarative sentence, readable without context', required: true },
      scope: { type: 'string', description: `${SCOPE_DESCRIPTION};配合 path 时表示该工作区作用域的显示名（别名）` },
      path: { type: 'string', description: '工作区目录路径；给出后写入 project:<路径>，此时 scope 用作该作用域的显示名（别名，可省略 = 用路径本身）' },
      kind: { type: 'string', enum: ['fact', 'decision', 'preference', 'procedure', 'note', 'rule', 'state'] },
      tags: { type: 'array', items: { type: 'string' } },
      importance: { type: 'number', description: '0~1, higher = more important' },
      supersedes: { type: 'string', description: 'Record id this corrects/replaces' },
      expiresAt: { type: 'number', description: '过期时间(毫秒时间戳)。kind=state 不传时按设置里的默认 TTL(7 天)' },
      ttlMs: { type: 'number', description: '相对有效期(毫秒)。与 expiresAt 二选一，expiresAt 优先' },
      triggers: { type: 'array', items: { type: 'string' }, description: '流程触发词(kind=procedure)：工具名/关键词/路径；缺省用 tags' },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args: SaveArgs, exec?: unknown): Promise<SaveResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      if (typeof args.content !== 'string' || args.content.trim().length === 0) {
        throw new MemoryToolError('CONTENT_EMPTY', 'content must be a non-empty string')
      }
      if (args.importance !== undefined && (args.importance < 0 || args.importance > 1)) {
        throw new MemoryToolError('IMPORTANCE_RANGE', 'importance must be between 0 and 1')
      }
      const content = args.content.trim()
      // 写路径:省略 scope → provider 按 tools.defaultScope(缺省 session,拿不到会话回退
      // project)。默认值的最终权威是 provider 的 `save` —— 省略时干脆不带 scope 字段,
      // 但要把会话上下文(exec.agent)带过去,否则它没法知道"当前会话"是谁。
      const requested = args.scope?.trim()
      const pathArg = typeof args.path === 'string' ? args.path.trim() : ''

      let explicit: string | undefined
      let alias: string | undefined
      if (pathArg !== '') {
        // path 给出 = 项目作用域;scope 此时是它的显示名,不再当 scope 选择器用。
        if (requested !== undefined && requested !== '' && requested !== 'project') {
          if (requested === 'global' || requested === 'session' || requested === 'all') {
            throw new MemoryToolError('PATH_SCOPE_CONFLICT', `path 只能配合项目作用域使用,不能再指定 scope="${requested}"`)
          }
          alias = requested
        }
        explicit = `project:${resolveWorkspacePath(pathArg, agent)}`
      } else {
        const resolved = requested === undefined || requested === ''
          ? undefined
          : resolveScope(opts, service, exec, requested, 'write').scope
        if (requested !== undefined && requested !== '' && resolved === undefined) {
          throw new MemoryToolError('SCOPE_INVALID', 'scope could not be resolved')
        }
        explicit = resolved
      }

      // 写入护栏(0.20.0):可见范围 = 可操作范围。范围外写入:
      //   - absolute → 按"作用域不存在/不可写"处理,不暴露可见域配置;
      //   - normal   → 先向用户审批一次,拒绝/超时把真实原因抛给模型;
      //   - none     → 不限制。
      // 拿不到会话(老宿主 / 无 exec)时不判断:没有会话就没有"本会话的可见域"。
      const policy = agent === undefined ? undefined : visibilityPolicy(service, agent)
      const level = policy?.level ?? 'none'
      const target = explicit ?? (typeof service.resolveWriteScope === 'function' ? service.resolveWriteScope(agent) : undefined)
      let approved = false
      if (level !== 'none' && target !== undefined && !scopeOperable(service, agent, policy, target)) {
        if (level === 'absolute') {
          throw new MemoryToolError('SCOPE_NOT_WRITABLE', `作用域 ${target} 不存在或不可写`)
        }
        const draft = {
          id: 'new-record',
          scope: target,
          kind: args.kind ?? 'note',
          content: content,
          tags: Array.isArray(args.tags) ? args.tags : [],
          importance: typeof args.importance === 'number' ? args.importance : 0,
          updatedAt: Date.now(),
        }
        const verdict = await askOutOfScope(
          service,
          agent,
          policy,
          'memory_save',
          summarize(content, 80),
          [draft],
          'write',
          (exec as { signal?: AbortSignal } | undefined)?.signal,
          descriptionOf(args.description),
        )
        if (!verdictAllows(verdict, draft.id)) {
          throw visibilityError(verdict.outcome === 'allowed-once' ? 'rejected' : verdict.outcome, 'write', target)
        }
        approved = true
      }

      try {
        const record = await service.save({
          ...(explicit !== undefined ? { scope: explicit } : {}),
          ...(alias !== undefined ? { name: alias } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(approved ? { visibilityApproved: true } : {}),
          kind: args.kind ?? 'note',
          content: content,
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.importance !== undefined ? { importance: args.importance } : {}),
          ...(args.supersedes ? { supersedes: args.supersedes } : {}),
          ...(typeof args.expiresAt === 'number' ? { expiresAt: args.expiresAt } : {}),
          ...(typeof args.ttlMs === 'number' ? { ttlMs: args.ttlMs } : {}),
          ...(Array.isArray(args.triggers) ? { triggers: args.triggers.map(String) } : {}),
          source: { origin: 'explicit' },
        })
        return { id: record.id, scope: record.scope, ...(alias !== undefined ? { scopeName: alias } : {}), deduped: false }
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

/** memory_search / memory_get(summary) 的默认摘要长度（字符）。 */
export const DEFAULT_SUMMARY_CHARS = 160

/** 摘要字数上限：默认 160，允许调用方在 20~2000 之间调整。 */
export function resolveSummaryChars(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SUMMARY_CHARS
  return Math.min(2000, Math.max(20, Math.round(n)))
}

/** 空白折叠 + 截断。memory_search 的“少量摘要”和 memory_get 的 summary 字段共用。 */
export function summarize(content: string, chars: number = DEFAULT_SUMMARY_CHARS): string {
  const flat = String(content).replace(/\s+/g, ' ').trim()
  return flat.length <= chars ? flat : `${flat.slice(0, chars)}…`
}

/**
 * memory_search 的上下文去重(0.21.0):
 *   - 同一条记忆、同一个 updatedAt 版本已经出现在上下文里 → 摘要置空并标 deduped;
 *   - 没出现过的（含内容更新后的新版本）→ 照常带摘要，并记为“摘要已出现”。
 * 注入半边不在时 `contextDedup` 返回 undefined，保持老行为。
 */
function applySummaryDedupe(opts: MemoryToolsOptions, exec: unknown, records: SearchHit[]): void {
  if (records.length === 0) return
  const dedup = opts.contextDedup?.(exec)
  if (dedup === undefined) return
  const seen = dedup.seen(records)
  const newlyShown: SearchHit[] = []
  for (const record of records) {
    if (seen.has(record.id)) {
      record.summary = ''
      record.deduped = true
    } else {
      newlyShown.push(record)
    }
  }
  // 只把这次真的带摘要返回的条目记为已出现;被省略的本来就是已出现。
  if (newlyShown.length > 0) dedup.markSummary(newlyShown)
}

export interface SearchArgs {
  query: string
  scope?: string
  topK?: number
  /** 默认 false:已被 supersede 的旧版本不返回;历史核对时显式打开。 */
  includeSuperseded?: boolean
  /** 每条摘要的字数上限；默认 160。 */
  summaryChars?: number
  /** 本次调用的用途(给用户看);普通限制下必填,审批弹窗展示。 */
  description?: string
}

export interface SearchHit {
  id: string
  score: number
  scope: string
  kind: string
  tags: string[]
  updatedAt: number
  /** 只给开头一段（默认 160 字），正文用 memory_get 取。 */
  summary: string
  /**
   * true = 这一条已经以同版本出现在本会话上下文中，摘要被省略，
   * 渲染只给 id（0.21.0 上下文去重）。
   */
  deduped?: boolean
}

export interface SearchResult {
  records: SearchHit[]
  /**
   * 有命中被可见域挡住、没有返回时告知模型数量与真实原因(不泄露正文)。
   * absolute 模式**不会**出现这个字段:范围外一律视为不存在。
   */
  withheld?: { count: number; reason: WithheldReason }
}

export function memorySearchTool(opts: MemoryToolsOptions): ToolSpec<SearchArgs, SearchResult> {
  return {
    name: 'memory_search',
    description: 'Search saved memories by keyword or meaning (lexical + local vector recall). Returns id/scope/kind/tags and a short summary; use memory_get for full content.',
    parameters: {
      query: { type: 'string', required: true },
      scope: { type: 'string', description: SCOPE_DESCRIPTION },
      topK: { type: 'number', description: '1~20' },
      includeSuperseded: { type: 'boolean', description: '默认 false；true 时把已被 supersede 的旧版本也返回（历史核对）' },
      summaryChars: { type: 'number', description: `每条摘要的字数上限（默认 ${DEFAULT_SUMMARY_CHARS}，20~2000）` },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args: SearchArgs, exec?: unknown): Promise<SearchResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      if (typeof args.query !== 'string' || args.query.trim().length === 0) {
        throw new MemoryToolError('QUERY_EMPTY', 'query must be a non-empty string')
      }
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      const policy = visibilityPolicy(service, agent)
      const level = policy?.level ?? 'none'
      // level=none 时策略里的 scopes 只是偏好,不参与限制(等价于没有可见域)。
      const visible = policy !== undefined && policy.level !== 'none' ? policy.scopes.map((rule) => rule.scope) : undefined
      // 只有"用户显式设过"的普通限制才把磁盘上其它 scope 也搜一遍(才有范围外命中
      // 可以审批)。默认策略下普通检索就只搜默认的三路集合,避免每次都弹审批。
      const expand = level === 'normal' && explicitPolicy(policy)
      let scopes: MemoryScope[] | undefined
      if (resolved.all) {
        if (visible !== undefined) {
          // 'all' 在有可见范围限制时只等于"所有可见范围",不是磁盘上的全部 scope。
          // 普通限制额外把磁盘上其它 scope 也搜一遍,才有"范围外命中"可审批。
          scopes = level === 'normal' ? [...new Set([...visible, ...allKnownScopes(service)])] : visible
        } else {
          scopes = allKnownScopes(service)
        }
      } else if (resolved.scope === undefined) {
        // 省略 scope:三路合并(会话 + 项目 + global),或显式可见范围。
        const merged = readScopes(opts, service, agent)
        scopes = expand ? [...new Set([...merged, ...allKnownScopes(service)])] : merged
      }
      const chars = resolveSummaryChars(args.summaryChars)
      try {
        const wantedTopK = args.topK !== undefined ? Math.min(20, Math.max(1, args.topK)) : undefined
        const hits = await service.search({
          text: args.query,
          ...(resolved.scope !== undefined ? { scope: resolved.scope } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          // 多取一些候选,避免范围外命中挤掉范围内的结果。
          topK: Math.min(60, Math.max(10, (wantedTopK ?? 10) * 3)),
          ...(args.includeSuperseded === true ? { includeSuperseded: true } : {}),
        })
        const inside = hits.filter((hit) => recordAllowed(policy, hit.record.scope, hit.record.kind))
        const outside = hits.filter((hit) => !recordAllowed(policy, hit.record.scope, hit.record.kind))
        // undefined = 没有范围外命中 / 绝对限制(不审批);只有普通限制会真的问一次。
        let verdict: ApprovalVerdict | undefined
        if (outside.length > 0 && level === 'normal') {
          verdict = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_search',
            args.query,
            outside.map((hit) => hit.record),
            'read',
            (exec as { signal?: AbortSignal } | undefined)?.signal,
            descriptionOf(args.description),
          )
        }
        // verdict 为空 = 没有发起审批(绝对限制 / 没有范围外命中):范围外一律不放行。
        const approvedOutside = verdict === undefined
          ? []
          : verdict.outcome !== 'allowed-once'
            ? []
            : verdict.allowedIds === undefined
              ? outside
              : outside.filter((hit) => verdict!.allowedIds!.has(hit.record.id))
        const insideIds = new Set(inside.map((hit) => hit.record.id))
        const approvedOutsideIds = new Set(approvedOutside.map((hit) => hit.record.id))
        const selected = hits.filter((hit) => insideIds.has(hit.record.id) || approvedOutsideIds.has(hit.record.id))
        const result: SearchResult = {
          records: selected.map((h) => ({
            id: h.record.id,
            score: h.score,
            scope: h.record.scope,
            kind: h.record.kind,
            tags: Array.isArray(h.record.tags) ? h.record.tags : [],
            updatedAt: h.record.updatedAt,
            summary: summarize(h.record.content, chars),
          })),
        }
        // absolute:范围外视为不存在,连"被挡住"都不告诉模型。
        if (verdict !== undefined) {
          const denied = outside.length - approvedOutside.length
          if (denied > 0) result.withheld = { count: denied, reason: verdict.outcome === 'allowed-once' ? 'partial' : verdict.outcome }
        }
        if (wantedTopK !== undefined) result.records = result.records.slice(0, wantedTopK)
        // 上下文去重:同一条记忆同版本已经出现过 → 只回 id,摘要让 memory_get 按需取。
        applySummaryDedupe(opts, exec, result.records)
        return result
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

export interface ForgetArgs {
  id?: string
  query?: string
  scope?: string
  /** 本次调用的用途(给用户看);普通限制下必填,审批弹窗展示。 */
  description?: string
}

export interface ForgetResult {
  removed: number
  ids: string[]
}

export function memoryForgetTool(opts: MemoryToolsOptions): ToolSpec<ForgetArgs, ForgetResult> {
  return {
    name: 'memory_forget',
    description: 'Delete a memory by id (any scope), or all memories matching a query in one scope (default: current session).',
    parameters: {
      id: { type: 'string', description: 'Exact record id' },
      query: { type: 'string', description: 'Substring match; by default only the current session scope' },
      scope: { type: 'string', description: "省略=当前会话；显式指定只删那一个作用域。'all' 不能与 query 同用(防批量误删)。" },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args: ForgetArgs, exec?: unknown): Promise<ForgetResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      if (!args.id && !args.query) throw new MemoryToolError('TARGET_REQUIRED', 'provide id or query')
      if (args.id && args.query) throw new MemoryToolError('TARGET_AMBIGUOUS', 'provide id or query, not both')
      // 没有会话就不判断可见域:护栏只对"本会话的 Agent"生效(与 provider 一致)。
      const policy = agent === undefined ? undefined : visibilityPolicy(service, agent)
      const level = policy?.level ?? 'none'
      const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
      // ---- 按 id 删除:先查出这条记录在哪个 scope,再按可操作范围判断 ----
      if (args.id) {
        const matches = (service.getByIds?.([args.id]) ?? []).filter((record) => record.id === args.id)
        const blocked = matches.filter((record) => !recordAllowed(policy, record.scope, record.kind))
        let approved = false
        if (blocked.length > 0) {
          if (level === 'absolute') {
            // 绝对限制:范围外的记录"视为不存在",与真的没有这条 id 完全一样。
            throw new MemoryToolError('RECORD_NOT_FOUND', `id ${args.id} not found`)
          }
          if (level === 'normal') {
            const verdict = await askOutOfScope(
              service,
              agent,
              policy,
              'memory_forget',
              args.id,
              blocked,
              'delete',
              signal,
              descriptionOf(args.description),
            )
            if (!verdictAllows(verdict, args.id)) {
              throw visibilityError(verdict.outcome === 'allowed-once' ? 'rejected' : verdict.outcome, 'delete', blocked[0]!.scope)
            }
            approved = true
          }
        }
        try {
          return await service.forget({
            id: args.id,
            ...(agent !== undefined ? { agent } : {}),
            ...(approved ? { visibilityApproved: true } : {}),
          })
        } catch (error) {
          throw toolError(error)
        }
      }
      // ---- 按 query 删除:目标 scope 必须在可操作范围内 ----
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      if (resolved.all) {
        throw new MemoryToolError('SCOPE_NOT_WRITABLE', "scope 'all' cannot be combined with query; name the scope you mean")
      }
      const scope = resolved.scope ?? readScopes(opts, service, agent)[0]
      let approved = false
      if (level !== 'none' && scope !== undefined && !scopeOperable(service, agent, policy, scope)) {
        if (level === 'absolute') {
          // 绝对限制:这个作用域"不存在",按一条都没匹配处理(不删、也不泄露原因)。
          return { removed: 0, ids: [] }
        }
        const verdict = await askOutOfScope(
          service,
          agent,
          policy,
          'memory_forget',
          `删除 ${scope} 中匹配「${args.query}」的记忆`,
          [{
            id: `query:${scope}`,
            scope,
            kind: 'note',
            content: `按关键词「${args.query}」删除该作用域中匹配的记忆`,
            tags: [],
            importance: 0,
            updatedAt: Date.now(),
          }],
          'delete',
          signal,
          descriptionOf(args.description),
        )
        if (!verdictAllows(verdict, `query:${scope}`)) {
          throw visibilityError(verdict.outcome === 'allowed-once' ? 'rejected' : verdict.outcome, 'delete', scope)
        }
        approved = true
      }
      try {
        return await service.forget({
          query: args.query,
          ...(scope !== undefined ? { scope } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(approved ? { visibilityApproved: true } : {}),
        })
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

export interface ListArgs {
  scope?: string
  kind?: string
  limit?: number
  /** 本次调用的用途(给用户看);普通限制下必填,审批弹窗展示。 */
  description?: string
}

export interface ListResult {
  records: Array<{ id: string; scope: string; kind: string; updatedAt: number; content: string; deduped?: boolean }>
  /** 作用域清单(名字 + 条数);文案由 apply.ts 统一渲染(那里能查会话标题)。 */
  scopeStats?: Array<{ scope: string; records: number; pendingEmbeds: number }>
  /**
   * 有记录被可见域挡住时告知模型数量与真实原因(不泄露正文)。
   * absolute 模式不会出现:范围外一律视为不存在。
   */
  withheld?: { count: number; reason: WithheldReason }
}

export function memoryListTool(opts: MemoryToolsOptions): ToolSpec<ListArgs, ListResult> {
  return {
    name: 'memory_list',
    description: 'List saved memories, most recently updated first.',
    parameters: {
      scope: { type: 'string', description: "省略=当前会话；'all'=所有作用域；其他值只列该作用域。" },
      kind: { type: 'string' },
      limit: { type: 'number', description: '1~200' },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args: ListArgs, exec?: unknown): Promise<ListResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      const policy = visibilityPolicy(service, agent)
      const level = policy?.level ?? 'none'
      // level=none 时策略里的 scopes 只是偏好,不参与限制(等价于没有可见域)。
      const visible = policy !== undefined && policy.level !== 'none' ? policy.scopes.map((rule) => rule.scope) : undefined
      let scopes: MemoryScope[] | undefined
      if (resolved.all) {
        if (visible !== undefined) {
          scopes = level === 'normal' ? [...new Set([...visible, ...allKnownScopes(service)])] : visible
        } else {
          scopes = allKnownScopes(service)
        }
      } else if (resolved.scope === undefined) {
        // 省略 scope:默认**只列当前会话**(按需求;读全部请显式 'all')。
        // 这是有意为之的窄口径,不因为"普通限制"就去列范围外的东西。
        scopes = readScopes(opts, service, agent).slice(0, 1)
      }
      let records: ListResult['records']
      let withheld: ListResult['withheld']
      try {
        const limit = args.limit !== undefined ? Math.min(200, Math.max(1, args.limit)) : 50
        const raw = await service.list({
          ...(resolved.scope !== undefined ? { scope: resolved.scope } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          ...(args.kind ? { kind: args.kind } : {}),
          // 多取一些候选,避免范围外记录挤掉范围内结果。
          limit: Math.min(200, Math.max(limit, limit * 2)),
        })
        const inside = raw.filter((record) => recordAllowed(policy, record.scope, record.kind))
        const outside = raw.filter((record) => !recordAllowed(policy, record.scope, record.kind))
        // undefined = 没有范围外命中 / 绝对限制(不审批);只有普通限制会真的问一次。
        let verdict: ApprovalVerdict | undefined
        if (outside.length > 0 && level === 'normal') {
          verdict = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_list',
            resolved.scope ?? args.scope ?? 'all',
            outside,
            'read',
            (exec as { signal?: AbortSignal } | undefined)?.signal,
            descriptionOf(args.description),
          )
        }
        const approvedOutside = verdict === undefined
          ? []
          : verdict.outcome !== 'allowed-once'
            ? []
            : verdict.allowedIds === undefined
              ? outside
              : outside.filter((record) => verdict!.allowedIds!.has(record.id))
        const insideIds = new Set(inside.map((record) => record.id))
        const approvedOutsideIds = new Set(approvedOutside.map((record) => record.id))
        const selected = raw
          .filter((record) => insideIds.has(record.id) || approvedOutsideIds.has(record.id))
          .slice(0, limit)
        records = selected.map((r) => ({
          id: r.id,
          scope: r.scope,
          kind: r.kind,
          updatedAt: r.updatedAt,
          content: r.content,
        }))
        if (verdict !== undefined) {
          const denied = outside.length - approvedOutside.length
          if (denied > 0) withheld = { count: denied, reason: verdict.outcome === 'allowed-once' ? 'partial' : verdict.outcome }
        }
        // 上下文去重:同版本已经出现过 → 只回 id,正文让 memory_get 按需取。
        const dedup = opts.contextDedup?.(exec)
        if (dedup !== undefined && records.length > 0) {
          const seen = dedup.seen(records)
          const newlyShown: ListResult['records'] = []
          records = records.map((record) => {
            if (!seen.has(record.id)) {
              newlyShown.push(record)
              return record
            }
            return { ...record, content: '', deduped: true }
          })
          // 这次真的把正文放进上下文的条目,后续检索/召回都按"已出现"处理。
          if (newlyShown.length > 0) dedup.markContent(newlyShown)
        }
      } catch (error) {
        throw toolError(error)
      }
      const statsAll = service.scopeStats?.()
      const stats = statsAll !== undefined && visible !== undefined
        ? statsAll.filter((s) => visible.includes(s.scope))
        : statsAll
      return {
        records,
        ...(stats !== undefined ? { scopeStats: stats } : {}),
        ...(withheld !== undefined ? { withheld } : {}),
      }
    },
  }
}

/** memory_get 可按需取得的字段。id 始终返回，不在此列。 */
export const GET_FIELDS = [
  'content',
  'summary',
  'scope',
  'kind',
  'tags',
  'importance',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'triggers',
  'supersedes',
] as const

export type GetField = (typeof GET_FIELDS)[number]

/** 省略 fields 时的默认视图：与旧版 memory_get 看到的内容一致。 */
export const DEFAULT_GET_FIELDS: GetField[] = ['content', 'scope', 'kind', 'tags']

export interface GetArgs {
  ids: string[]
  /** 只取这些字段；省略 = content + scope + kind + tags。 */
  fields?: GetField[] | string
  /** summary 字段的字数上限；默认 160。 */
  summaryChars?: number
  /** 本次调用的用途(给用户看);普通限制下必填,审批弹窗展示。 */
  description?: string
}

export type GetRecord = { id: string } & Partial<Record<GetField, unknown>>

export interface GetResult {
  records: GetRecord[]
  /** 本次实际生效的字段（渲染与调用方都不必再猜默认值）。 */
  fields: GetField[]
  missing: string[]
  /**
   * 有 id 命中但被可见域挡住时告知模型数量与真实原因(不泄露正文)。
   * absolute 模式不会出现:范围外一律视为不存在。
   */
  withheld?: { count: number; reason: WithheldReason }
}

const FIELD_BY_LOWER = new Map<string, GetField>(GET_FIELDS.map((field) => [field.toLowerCase(), field]))

/** 解析并校验 fields：接受数组，也接受逗号/空格分隔的字符串。 */
export function resolveGetFields(raw: GetArgs['fields']): GetField[] {
  if (raw === undefined || raw === null) return [...DEFAULT_GET_FIELDS]
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : null
  if (items === null) {
    throw new MemoryToolError('FIELDS_INVALID', `fields must be an array or a comma-separated string; allowed: ${GET_FIELDS.join(', ')}`)
  }
  const fields: GetField[] = []
  const invalid: string[] = []
  for (const item of items) {
    const key = String(item).trim().toLowerCase()
    if (key === '') continue
    const field = FIELD_BY_LOWER.get(key)
    if (field !== undefined) {
      if (!fields.includes(field)) fields.push(field)
    } else if (!invalid.includes(key)) {
      invalid.push(key)
    }
  }
  if (invalid.length > 0) {
    throw new MemoryToolError('FIELDS_INVALID', `unknown field(s): ${invalid.join(', ')}; allowed: ${GET_FIELDS.join(', ')}`)
  }
  if (fields.length === 0) {
    throw new MemoryToolError('FIELDS_EMPTY', `fields 不能为空；可用：${GET_FIELDS.join(', ')}`)
  }
  return fields
}

function pickGetFields(
  record: GetSourceRecord,
  fields: GetField[],
  summaryChars: number,
): GetRecord {
  const out: GetRecord = { id: record.id }
  for (const field of fields) {
    switch (field) {
      case 'content': out.content = record.content; break
      case 'summary': out.summary = summarize(record.content, summaryChars); break
      case 'scope': out.scope = record.scope; break
      case 'kind': out.kind = record.kind; break
      case 'tags': out.tags = Array.isArray(record.tags) ? record.tags : []; break
      case 'importance': out.importance = record.importance; break
      case 'createdAt': out.createdAt = record.createdAt; break
      case 'updatedAt': out.updatedAt = record.updatedAt; break
      case 'expiresAt': if (record.expiredAt !== undefined) out.expiresAt = record.expiredAt; break
      case 'triggers': if (Array.isArray(record.triggers)) out.triggers = record.triggers; break
      case 'supersedes': if (record.supersedes !== undefined && record.supersedes !== '') out.supersedes = record.supersedes; break
    }
  }
  return out
}

export function memoryGetTool(opts: MemoryToolsOptions): ToolSpec<GetArgs, GetResult> {
  return {
    name: 'memory_get',
    description: 'Fetch memories by id or by the 8-char id prefix shown in search/recall/digest output. Default fields: content + scope + kind + tags; pass fields to fetch only what you need (e.g. ["summary"], ["tags"], ["updatedAt"]).',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: '记忆 id 或摘要开头的 8 位前缀,1~50 个', required: true },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: `只取这些字段，省略=${DEFAULT_GET_FIELDS.join('+')}；可选：${GET_FIELDS.join(' / ')}（id 始终返回）`,
      },
      summaryChars: { type: 'number', description: `summary 字段的字数上限（默认 ${DEFAULT_SUMMARY_CHARS}，20~2000）` },
      description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    },
    async execute(args: GetArgs, exec?: unknown): Promise<GetResult> {
      const service = svc(opts)
      const agent = agentOf(exec)
      requireDescription(service, agent, args.description)
      const ids = Array.isArray(args.ids)
        ? [...new Set(args.ids.map(String).filter((id) => id.trim() !== ''))].slice(0, 50)
        : []
      if (ids.length === 0) throw toolError(new Error('ids 不能为空'))
      if (typeof service.getByIds !== 'function') {
        throw toolError(new Error('当前 provider 不支持 memory_get（请升级 @restregular/dsh-memory）'))
      }
      const fields = resolveGetFields(args.fields)
      const chars = resolveSummaryChars(args.summaryChars)
      try {
        const all = service.getByIds(ids)
        // 可见域是白名单:即使知道 id,也不能直接读别的范围/别的类型的正文。
        const policy = visibilityPolicy(service, agent)
        const level = policy?.level ?? 'none'
        const inside = all.filter((record) => recordAllowed(policy, record.scope, record.kind))
        const outside = all.filter((record) => !recordAllowed(policy, record.scope, record.kind))
        // undefined = 没有范围外命中 / 绝对限制(不审批);只有普通限制会真的问一次。
        let verdict: ApprovalVerdict | undefined
        if (outside.length > 0 && level === 'normal') {
          verdict = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_get',
            ids.join(' '),
            outside,
            'read',
            (exec as { signal?: AbortSignal } | undefined)?.signal,
            descriptionOf(args.description),
          )
        }
        // verdict 为空 = 没有发起审批(绝对限制):范围外一律按不存在处理。
        const approvedOutside = verdict === undefined
          ? []
          : verdict.outcome !== 'allowed-once'
            ? []
            : verdict.allowedIds === undefined
              ? outside
              : outside.filter((record) => verdict!.allowedIds!.has(record.id))
        const insideIds = new Set(inside.map((record) => record.id))
        const approvedIds = new Set(approvedOutside.map((record) => record.id))
        const found = all.filter((record) => insideIds.has(record.id) || approvedIds.has(record.id))
        const denied = outside.length - approvedOutside.length
        return {
          records: found.map((r) => pickGetFields(r, fields, chars)),
          fields,
          missing: ids.filter((token) => !found.some((r) => r.id === token || r.id.startsWith(token))),
          ...(verdict !== undefined && denied > 0
            ? { withheld: { count: denied, reason: verdict.outcome === 'allowed-once' ? 'partial' : verdict.outcome } }
            : {}),
        }
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

export function memoryTools(opts: MemoryToolsOptions) {
  return {
    memory_save: memorySaveTool(opts),
    memory_search: memorySearchTool(opts),
    memory_forget: memoryForgetTool(opts),
    memory_list: memoryListTool(opts),
    memory_get: memoryGetTool(opts),
  }
}
