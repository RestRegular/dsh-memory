/**
 * Tool implementations as plain data + functions. Keeping them free of both
 * cordis and dsh-tools imports lets us unit-test the exact argument/response
 * contracts standalone; the DSH entry (apply.ts) wraps them with defineTool.
 */
import type { MemoryScope, MemoryServiceApi } from 'dsh-memory'

/** Shape each tool shares: JSON-schema parameters + canonical output value. */
export interface ToolSpec<A, O> {
  name: string
  description: string
  parameters: unknown
  execute(args: A): Promise<O>
}

export interface MemoryToolsOptions {
  /** Resolves the service lazily so tools fail with a clear message pre-load. */
  getService(): MemoryServiceApi | undefined
  /** Default scope for saves/list/forget when the model omits one. */
  defaultScope(): MemoryScope
}

export class MemoryToolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function svc(opts: MemoryToolsOptions): MemoryServiceApi {
  const s = opts.getService()
  if (!s) throw new MemoryToolError('SERVICE_UNAVAILABLE', 'memory service is not loaded; check that dsh-memory-local is enabled')
  return s
}

function scopeOr(opts: MemoryToolsOptions, scope?: string): MemoryScope {
  if (scope === 'global') return 'global'
  if (typeof scope === 'string' && scope.startsWith('project:')) return scope as MemoryScope
  if (scope === 'project') return opts.defaultScope()
  return opts.defaultScope()
}

export interface SaveArgs {
  content: string
  scope?: 'global' | 'project' | `project:${string}`
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
      scope: { type: 'string', enum: ['global', 'project'], description: 'global = all projects; project = current workspace' },
      kind: { type: 'string', enum: ['fact', 'decision', 'preference', 'procedure', 'note'] },
      tags: { type: 'array', items: { type: 'string' } },
      importance: { type: 'number', description: '0~1, higher = more important' },
      supersedes: { type: 'string', description: 'Record id this corrects/replaces' },
    },
    async execute(args: SaveArgs): Promise<SaveResult> {
      if (typeof args.content !== 'string' || args.content.trim().length === 0) {
        throw new MemoryToolError('CONTENT_EMPTY', 'content must be a non-empty string')
      }
      if (args.importance !== undefined && (args.importance < 0 || args.importance > 1)) {
        throw new MemoryToolError('IMPORTANCE_RANGE', 'importance must be between 0 and 1')
      }
      const record = await svc(opts).save({
        scope: scopeOr(opts, args.scope),
        kind: args.kind ?? 'note',
        content: args.content.trim(),
        ...(args.tags ? { tags: args.tags } : {}),
        ...(args.importance !== undefined ? { importance: args.importance } : {}),
        ...(args.supersedes ? { supersedes: args.supersedes } : {}),
        source: { origin: 'explicit' },
      })
      return { id: record.id, scope: record.scope, deduped: false }
    },
  }
}

export interface SearchArgs {
  query: string
  scope?: 'global' | 'project' | `project:${string}`
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
      scope: { type: 'string', enum: ['global', 'project'] },
      topK: { type: 'number', description: '1~20' },
    },
    async execute(args: SearchArgs): Promise<SearchResult> {
      if (typeof args.query !== 'string' || args.query.trim().length === 0) {
        throw new MemoryToolError('QUERY_EMPTY', 'query must be a non-empty string')
      }
      const hits = await svc(opts).search({
        text: args.query,
        ...(args.scope ? { scope: scopeOr(opts, args.scope) } : {}),
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
    },
  }
}

export interface ForgetArgs {
  id?: string
  query?: string
  scope?: 'global' | 'project' | `project:${string}`
}

export interface ForgetResult {
  removed: number
  ids: string[]
}

export function memoryForgetTool(opts: MemoryToolsOptions): ToolSpec<ForgetArgs, ForgetResult> {
  return {
    name: 'memory_forget',
    description: 'Delete a memory by id, or all memories matching a query in one scope.',
    parameters: {
      id: { type: 'string', description: 'Exact record id' },
      query: { type: 'string', description: 'Substring match within one scope' },
      scope: { type: 'string', enum: ['global', 'project'] },
    },
    async execute(args: ForgetArgs): Promise<ForgetResult> {
      if (!args.id && !args.query) throw new MemoryToolError('TARGET_REQUIRED', 'provide id or query')
      if (args.id && args.query) throw new MemoryToolError('TARGET_AMBIGUOUS', 'provide id or query, not both')
      return svc(opts).forget({
        ...(args.id ? { id: args.id } : {}),
        ...(args.query ? { query: args.query } : {}),
        ...(args.scope ? { scope: scopeOr(opts, args.scope) } : {}),
      })
    },
  }
}

export interface ListArgs {
  scope?: 'global' | 'project' | `project:${string}`
  kind?: string
  limit?: number
}

export interface ListResult {
  records: Array<{ id: string; scope: string; kind: string; updatedAt: number; content: string }>
}

export function memoryListTool(opts: MemoryToolsOptions): ToolSpec<ListArgs, ListResult> {
  return {
    name: 'memory_list',
    description: 'List saved memories, most recently updated first.',
    parameters: {
      scope: { type: 'string', enum: ['global', 'project'] },
      kind: { type: 'string' },
      limit: { type: 'number', description: '1~200' },
    },
    async execute(args: ListArgs): Promise<ListResult> {
      const records = await svc(opts).list({
        ...(args.scope ? { scope: scopeOr(opts, args.scope) } : {}),
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      })
      return {
        records: records.map((r) => ({
          id: r.id,
          scope: r.scope,
          kind: r.kind,
          updatedAt: r.updatedAt,
          content: r.content,
        })),
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
  }
}
