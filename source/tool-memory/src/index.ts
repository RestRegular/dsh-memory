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
import { normalizeScopeInput, resolveScopeRef } from '../../memory-local/src/scope.ts'

/** Shape each tool shares: JSON-schema parameters + canonical output value. */
export interface ToolSpec<A, O> {
  name: string
  description: string
  parameters: unknown
  execute(args: A, exec?: unknown): Promise<O>
}

/** 只有这一层需要的能力子集(provider 在宿主里提供,测试里可以 mock)。 */
export interface MemoryToolService {
  save(input: unknown): Promise<{ id: string; scope: string }>
  search(input: unknown): Promise<Array<{ record: { id: string; scope: string; kind: string; updatedAt: number; content: string }; score: number }>>
  forget(input: unknown): Promise<{ removed: number; ids: string[] }>
  list(input?: unknown): Promise<Array<{ id: string; scope: string; kind: string; updatedAt: number; content: string }>>
  /** 读 "all" 前把所有磁盘上的 scope 发现出来。 */
  discoverScopes?(): MemoryScope[]
  /** 作用域清单(scope + 记录数),用于 memory_list 的尾部摘要与错误提示。 */
  scopeStats?(): Array<{ scope: string; records: number; pendingEmbeds: number }>
  /** 无显式 scope 时的合并读取集合(会话 + 项目 + global)。 */
  resolveReadScopes?(agent: unknown): MemoryScope[]
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
  kind?: string
  tags?: string[]
  importance?: number
  supersedes?: string
}

export interface SaveResult {
  id: string
  scope: string
  deduped: boolean
}

export function memorySaveTool(opts: MemoryToolsOptions): ToolSpec<SaveArgs, SaveResult> {
  return {
    name: 'memory_save',
    description: 'Save a durable memory (fact, decision, preference, procedure) for future sessions.',
    parameters: {
      content: { type: 'string', description: 'Self-contained declarative sentence, readable without context', required: true },
      scope: { type: 'string', description: SCOPE_DESCRIPTION },
      kind: { type: 'string', enum: ['fact', 'decision', 'preference', 'procedure', 'note'] },
      tags: { type: 'array', items: { type: 'string' } },
      importance: { type: 'number', description: '0~1, higher = more important' },
      supersedes: { type: 'string', description: 'Record id this corrects/replaces' },
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
      const explicit = requested === undefined || requested === ''
        ? undefined
        : resolveScope(opts, service, exec, requested, 'write').scope
      if (requested !== undefined && requested !== '' && explicit === undefined) {
        throw new MemoryToolError('SCOPE_INVALID', 'scope could not be resolved')
      }
      const agent = agentOf(exec)
      try {
        const record = await service.save({
          ...(explicit !== undefined ? { scope: explicit } : {}),
          ...(agent !== undefined ? { agent } : {}),
          kind: args.kind ?? 'note',
          content: args.content.trim(),
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.importance !== undefined ? { importance: args.importance } : {}),
          ...(args.supersedes ? { supersedes: args.supersedes } : {}),
          source: { origin: 'explicit' },
        })
        return { id: record.id, scope: record.scope, deduped: false }
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

export interface SearchArgs {
  query: string
  scope?: string
  topK?: number
}

export interface SearchHit {
  id: string
  score: number
  scope: string
  kind: string
  updatedAt: number
  content: string
}

export interface SearchResult {
  records: SearchHit[]
}

export function memorySearchTool(opts: MemoryToolsOptions): ToolSpec<SearchArgs, SearchResult> {
  return {
    name: 'memory_search',
    description: 'Search saved memories by keyword or meaning (lexical + local vector recall).',
    parameters: {
      query: { type: 'string', required: true },
      scope: { type: 'string', description: SCOPE_DESCRIPTION },
      topK: { type: 'number', description: '1~20' },
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
      try {
        const hits = await service.search({
          text: args.query,
          ...(resolved.scope !== undefined ? { scope: resolved.scope } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          ...(args.topK !== undefined ? { topK: args.topK } : {}),
        })
        return {
          records: hits.map((h) => ({
            id: h.record.id,
            score: h.score,
            scope: h.record.scope,
            kind: h.record.kind,
            updatedAt: h.record.updatedAt,
            content: h.record.content,
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

export function memoryTools(opts: MemoryToolsOptions) {
  return {
    memory_save: memorySaveTool(opts),
    memory_search: memorySearchTool(opts),
    memory_forget: memoryForgetTool(opts),
    memory_list: memoryListTool(opts),
  }
}
