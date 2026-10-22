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

/** 只有这一层需要的能力子集(provider 在宿主里提供,测试里可以 mock)。 */
export interface MemoryToolService {
  save(input: unknown): Promise<{ id: string; scope: string }>
  search(input: unknown): Promise<Array<{ record: { id: string; scope: string; kind: string; updatedAt: number; content: string; tags?: string[] }; score: number }>>
  forget(input: unknown): Promise<{ removed: number; ids: string[] }>
  list(input?: unknown): Promise<Array<{ id: string; scope: string; kind: string; updatedAt: number; content: string }>>
  /** 读 "all" 前把所有磁盘上的 scope 发现出来。 */
  discoverScopes?(): MemoryScope[]
  /** 作用域清单(scope + 记录数),用于 memory_list 的尾部摘要与错误提示。 */
  scopeStats?(): Array<{ scope: string; records: number; pendingEmbeds: number }>
  /** 无显式 scope 时的合并读取集合(会话 + 项目 + global)。 */
  resolveReadScopes?(agent: unknown): MemoryScope[]
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

/** 该服务/配置下"当前会话 + 当前项目 + global"的合并读取集合(去重)。 */
function readScopes(opts: MemoryToolsOptions, service: MemoryToolService, agent: unknown): MemoryScope[] {
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
    },
    async execute(args: SaveArgs, exec?: unknown): Promise<SaveResult> {
      const service = svc(opts)
      if (typeof args.content !== 'string' || args.content.trim().length === 0) {
        throw new MemoryToolError('CONTENT_EMPTY', 'content must be a non-empty string')
      }
      if (args.importance !== undefined && (args.importance < 0 || args.importance > 1)) {
        throw new MemoryToolError('IMPORTANCE_RANGE', 'importance must be between 0 and 1')
      }
      // 写路径:省略 scope → provider 按 tools.defaultScope(缺省 session,拿不到会话回退
      // project)。默认值的最终权威是 provider 的 `save` —— 省略时干脆不带 scope 字段,
      // 但要把会话上下文(exec.agent)带过去,否则它没法知道"当前会话"是谁。
      const requested = args.scope?.trim()
      const agent = agentOf(exec)
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

      try {
        const record = await service.save({
          ...(explicit !== undefined ? { scope: explicit } : {}),
          ...(alias !== undefined ? { name: alias } : {}),
          ...(agent !== undefined ? { agent } : {}),
          kind: args.kind ?? 'note',
          content: args.content.trim(),
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

export interface SearchArgs {
  query: string
  scope?: string
  topK?: number
  /** 默认 false:已被 supersede 的旧版本不返回;历史核对时显式打开。 */
  includeSuperseded?: boolean
  /** 每条摘要的字数上限；默认 160。 */
  summaryChars?: number
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
}

export interface SearchResult {
  records: SearchHit[]
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
    },
    async execute(args: SearchArgs, exec?: unknown): Promise<SearchResult> {
      const service = svc(opts)
      if (typeof args.query !== 'string' || args.query.trim().length === 0) {
        throw new MemoryToolError('QUERY_EMPTY', 'query must be a non-empty string')
      }
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      let scopes: MemoryScope[] | undefined
      if (resolved.all) {
        // 'all' = 所有已发现作用域;scopeStats() 自身会先做 discovery(带限流)。
        scopes = (service.scopeStats?.() ?? []).map((s) => s.scope)
        service.discoverScopes?.()
      } else if (resolved.scope === undefined) {
        // 省略 scope:三路合并(会话 + 项目 + global)
        scopes = readScopes(opts, service, agentOf(exec))
      }
      const chars = resolveSummaryChars(args.summaryChars)
      try {
        const hits = await service.search({
          text: args.query,
          ...(resolved.scope !== undefined ? { scope: resolved.scope } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          ...(args.topK !== undefined ? { topK: args.topK } : {}),
          ...(args.includeSuperseded === true ? { includeSuperseded: true } : {}),
        })
        return {
          records: hits.map((h) => ({
            id: h.record.id,
            score: h.score,
            scope: h.record.scope,
            kind: h.record.kind,
            tags: Array.isArray(h.record.tags) ? h.record.tags : [],
            updatedAt: h.record.updatedAt,
            summary: summarize(h.record.content, chars),
          })),
        }
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
    },
    async execute(args: ForgetArgs, exec?: unknown): Promise<ForgetResult> {
      const service = svc(opts)
      if (!args.id && !args.query) throw new MemoryToolError('TARGET_REQUIRED', 'provide id or query')
      if (args.id && args.query) throw new MemoryToolError('TARGET_AMBIGUOUS', 'provide id or query, not both')
      // id 路径本来就跨 scope(精确 id 不会误删),不解析 scope。
      if (args.id) {
        try {
          return await service.forget({ id: args.id })
        } catch (error) {
          throw toolError(error)
        }
      }
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      if (resolved.all) {
        throw new MemoryToolError('SCOPE_NOT_WRITABLE', "scope 'all' cannot be combined with query; name the scope you mean")
      }
      const scope = resolved.scope ?? readScopes(opts, service, agentOf(exec))[0]
      try {
        return await service.forget({ query: args.query, ...(scope !== undefined ? { scope } : {}) })
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
}

export interface ListResult {
  records: Array<{ id: string; scope: string; kind: string; updatedAt: number; content: string }>
  /** 作用域清单(名字 + 条数);文案由 apply.ts 统一渲染(那里能查会话标题)。 */
  scopeStats?: Array<{ scope: string; records: number; pendingEmbeds: number }>
}

export function memoryListTool(opts: MemoryToolsOptions): ToolSpec<ListArgs, ListResult> {
  return {
    name: 'memory_list',
    description: 'List saved memories, most recently updated first.',
    parameters: {
      scope: { type: 'string', description: "省略=当前会话；'all'=所有作用域；其他值只列该作用域。" },
      kind: { type: 'string' },
      limit: { type: 'number', description: '1~200' },
    },
    async execute(args: ListArgs, exec?: unknown): Promise<ListResult> {
      const service = svc(opts)
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      let scopes: MemoryScope[] | undefined
      if (resolved.all) {
        scopes = (service.scopeStats?.() ?? []).map((s) => s.scope)
        service.discoverScopes?.()
      } else if (resolved.scope === undefined) {
        // 省略 scope:默认**只列当前会话**(按需求;读全部请显式 'all')
        scopes = readScopes(opts, service, agentOf(exec)).slice(0, 1)
      }
      let records: ListResult['records']
      try {
        const raw = await service.list({
          ...(resolved.scope !== undefined ? { scope: resolved.scope } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        })
        records = raw.map((r) => ({
          id: r.id,
          scope: r.scope,
          kind: r.kind,
          updatedAt: r.updatedAt,
          content: r.content,
        }))
      } catch (error) {
        throw toolError(error)
      }
      const stats = service.scopeStats?.()
      return stats !== undefined ? { records, scopeStats: stats } : { records }
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
}

export type GetRecord = { id: string } & Partial<Record<GetField, unknown>>

export interface GetResult {
  records: GetRecord[]
  /** 本次实际生效的字段（渲染与调用方都不必再猜默认值）。 */
  fields: GetField[]
  missing: string[]
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
    },
    async execute(args: GetArgs): Promise<GetResult> {
      const service = svc(opts)
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
        const found = service.getByIds(ids)
        return {
          records: found.map((r) => pickGetFields(r, fields, chars)),
          fields,
          missing: ids.filter((token) => !found.some((r) => r.id === token || r.id.startsWith(token))),
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
