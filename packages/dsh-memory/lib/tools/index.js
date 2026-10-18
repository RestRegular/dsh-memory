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
                                             
import { normalizeScopeInput, resolveScopeRef } from '../provider/scope.js'

/** Shape each tool shares: JSON-schema parameters + canonical output value. */
                                 
              
                     
                     
                                              
 

/** 只有这一层需要的能力子集(provider 在宿主里提供,测试里可以 mock)。 */
                                    
                                                              
                                                                                                                                                    
                                                                     
                                                                                                                        
                                     
                                  
                                                      
                                                                                 
                                              
                                                   
                                    
                                                                     
     
                                                           
                                         
     
                                             
 

                                     
                                                                                 
                                             
                                                  
                                                 
                                                      
                       
 

const SCOPE_DESCRIPTION =
  "省略=当前会话；'global'=所有项目共享；'project'=当前工作区；其他任意名称=自定义作用域"
  + "(memory_save 时不存在则自动创建)。读取时可用 'all' 跨所有作用域。"

export class MemoryToolError extends Error {
           code        

  constructor(code        , message        ) {
    super(message)
    this.code = code
  }
}

function svc(opts                    )                    {
  const s = opts.getService()
  if (!s) throw new MemoryToolError('SERVICE_UNAVAILABLE', 'memory service is not loaded; check that dsh-memory-local is enabled')
  return s
}

function toolError(error         )                  {
  if (error instanceof MemoryToolError) return error
  const code = (error                                  )?.code
  const message = error instanceof Error ? error.message : String(error)
  return new MemoryToolError(typeof code === 'string' ? code : 'MEMORY_ERROR', message)
}

/** 供 apply.ts 使用的实例内 agent(宿主 exec.agent)。 */
function agentOf(exec         )          {
  return (exec                                   )?.agent
}

/**
 * 当前项目 key。优先级:**服务端解析的会话 cwd** → 显式配置 → process.cwd()。
 *
 * 服务端那一步不能省:DSH 服务进程的 process.cwd() 是 profile 目录,只有
 * `session.header.cwd` 才是工作区;而 mock / 旧 provider 没有 `projectKeyFor` 时,
 * 只能退回配置与 process.cwd()(与旧行为一致,不把测试和旧宿主打断)。
 */
function projectKey(opts                    , service                    , agent          )              {
  const resolved = service?.projectKeyFor?.(agent)
  if (typeof resolved === 'string' && resolved.length > 0) return resolved               
  return (opts.projectScope ?? `project:${process.cwd()}`)               
}

/** 该服务/配置下"当前会话 + 当前项目 + global"的合并读取集合(去重)。 */
function readScopes(opts                    , service                   , agent         )                {
  const provided = service.resolveReadScopes?.(agent)
  if (Array.isArray(provided) && provided.length > 0) return [...new Set(provided)]
  // 服务没提供(测试 mock / 旧 provider):退回 defaultScope 口径
  const fallback = opts.defaultScope === 'global' ? 'global' : projectKey(opts, service, agent)
  return [...new Set([fallback, 'global'])]
}

/** 写路径默认口径;provider 不支持时退回 project。 */
function writeDefault(opts                    )                                   {
  return opts.defaultScope ?? 'session'
}

/** 规范化 + 落到具体 key(或 all)。 */
function resolveScope(
  opts                    ,
  service                   ,
  exec         ,
  raw                    ,
  mode                  ,
)                                         {
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

                           
                 
                
               
                 
                     
                     
 

                             
            
               
                  
 

export function memorySaveTool(opts                    )                                 {
  return {
    name: 'memory_save',
    description: 'Save a durable memory (fact, decision, preference, procedure, rule) for future sessions.',
    parameters: {
      content: { type: 'string', description: 'Self-contained declarative sentence, readable without context', required: true },
      scope: { type: 'string', description: SCOPE_DESCRIPTION },
      kind: { type: 'string', enum: ['fact', 'decision', 'preference', 'procedure', 'note', 'rule'] },
      tags: { type: 'array', items: { type: 'string' } },
      importance: { type: 'number', description: '0~1, higher = more important' },
      supersedes: { type: 'string', description: 'Record id this corrects/replaces' },
    },
    async execute(args          , exec          )                      {
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

                             
               
                
               
 

                            
            
               
               
              
                   
                 
 

                               
                      
 

export function memorySearchTool(opts                    )                                     {
  return {
    name: 'memory_search',
    description: 'Search saved memories by keyword or meaning (lexical + local vector recall).',
    parameters: {
      query: { type: 'string', required: true },
      scope: { type: 'string', description: SCOPE_DESCRIPTION },
      topK: { type: 'number', description: '1~20' },
    },
    async execute(args            , exec          )                        {
      const service = svc(opts)
      if (typeof args.query !== 'string' || args.query.trim().length === 0) {
        throw new MemoryToolError('QUERY_EMPTY', 'query must be a non-empty string')
      }
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      let scopes                           
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

                             
             
                
                
 

                               
                 
               
 

export function memoryForgetTool(opts                    )                                     {
  return {
    name: 'memory_forget',
    description: 'Delete a memory by id (any scope), or all memories matching a query in one scope (default: current session).',
    parameters: {
      id: { type: 'string', description: 'Exact record id' },
      query: { type: 'string', description: 'Substring match; by default only the current session scope' },
      scope: { type: 'string', description: "省略=当前会话；显式指定只删那一个作用域。'all' 不能与 query 同用(防批量误删)。" },
    },
    async execute(args            , exec          )                        {
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

                           
                
               
                
 

                             
                                                                                                 
                                                    
                                                                               
 

export function memoryListTool(opts                    )                                 {
  return {
    name: 'memory_list',
    description: 'List saved memories, most recently updated first.',
    parameters: {
      scope: { type: 'string', description: "省略=当前会话；'all'=所有作用域；其他值只列该作用域。" },
      kind: { type: 'string' },
      limit: { type: 'number', description: '1~200' },
    },
    async execute(args          , exec          )                      {
      const service = svc(opts)
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      let scopes                           
      if (resolved.all) {
        scopes = (service.scopeStats?.() ?? []).map((s) => s.scope)
        service.discoverScopes?.()
      } else if (resolved.scope === undefined) {
        // 省略 scope:默认**只列当前会话**(按需求;读全部请显式 'all')
        scopes = readScopes(opts, service, agentOf(exec)).slice(0, 1)
      }
      let records                       
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

export function memoryTools(opts                    ) {
  return {
    memory_save: memorySaveTool(opts),
    memory_search: memorySearchTool(opts),
    memory_forget: memoryForgetTool(opts),
    memory_list: memoryListTool(opts),
  }
}


//# sourceURL=source/tool-memory/src/index.ts