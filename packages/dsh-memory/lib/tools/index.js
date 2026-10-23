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
                                             
import { isAbsolute, resolve } from 'node:path'
import { canonicalWorkspacePath, normalizeScopeInput, resolveScopeRef } from '../provider/scope.js'

/** Shape each tool shares: JSON-schema parameters + canonical output value. */
                                 
              
                     
                     
                                              
 

/** provider 的 getByIds 返回的记录形状（工具层只读这些字段）。 */
                                  
            
               
              
                 
                
                    
                   
                   
                    
                     
                     
 

/** 范围外访问的处理方式(与 provider 的会话可见域一致)。 */
                                                            

                                     
               
                           
                  
 

/** provider 解析出的生效可见域;undefined = 没有覆盖(不限制)。 */
                                       
                        
                              
 

/** 一条范围外命中,交给审批浮层展示。 */
                                         
            
               
              
                 
                
                    
                   
                          
 

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

/**
 * 显式「可见范围」白名单;undefined = 没有覆盖(保持旧行为,不限制显式 scope)。
 * provider 方法抛错时按"没有覆盖"处理:可见范围是防越界,不应该让一个 provider
 * 内部错误把所有读取都锁死。
 */
function visibleScopeList(service                   , agent         )                            {
  try {
    const explicit = service.visibleScopes?.(agent)
    if (Array.isArray(explicit)) return [...new Set(explicit)]
  } catch { /* 降级为不限制 */ }
  return undefined
}

/** 完整可见域;老 provider / 解析失败时退化为 undefined(不限制)。 */
function visibilityPolicy(service                   , agent         )                                   {
  try {
    const policy = service.visibilityPolicy?.(agent)
    if (policy !== undefined && policy !== null) {
      const level                  = policy.level === 'absolute' || policy.level === 'none' ? policy.level : 'normal'
      return { level, scopes: Array.isArray(policy.scopes) ? policy.scopes : [] }
    }
  } catch { /* 降级为不限制 */ }
  return undefined
}

function scopeInPolicy(policy                                  , scope        )          {
  if (policy === undefined || policy.level === 'none') return true
  return policy.scopes.some((rule) => rule.scope === scope)
}

/** 这条记录是否在可见域内(scope 与类型都要满足)。 */
function recordAllowed(policy                                  , scope        , kind        )          {
  if (policy === undefined || policy.level === 'none') return true
  const rule = policy.scopes.find((item) => item.scope === scope)
  if (rule === undefined) return false
  return rule.kinds === undefined || rule.kinds.length === 0 || rule.kinds.includes(kind)
}

/** 记录在可见域外时,是"整个 scope 不可见"还是"只是类型不允许"。 */
function outsideReason(policy                                  , scope        )                   {
  return scopeInPolicy(policy, scope) ? 'kind' : 'scope'
}

function recordsToApprovalItems(
  policy                                  ,
  records                                                                                                                                  ,
)                           {
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
 * 普通限制:把范围外命中交给用户审批一次。
 * provider 不支持审批(旧版本)时按拒绝处理 —— 不能静默把范围外记忆放出去。
 */
async function askOutOfScope(
  service                   ,
  agent         ,
  policy                                  ,
  tool        ,
  query        ,
  records                                                                                                                                  ,
  signal              ,
)                   {
  if (records.length === 0) return true
  if (typeof service.requestOutOfScope !== 'function') return false
  if (signal?.aborted) return false
  try {
    const outcome = await service.requestOutOfScope(agent, {
      tool,
      query,
      items: recordsToApprovalItems(policy, records),
      ...(signal !== undefined ? { signal } : {}),
    })
    return outcome === 'allowed-once'
  } catch {
    return false
  }
}

/** 显式询问一个不在可见范围内的 scope 时给出明确错误,而不是返回空结果。 */
function assertScopeVisible(service                   , agent         , scope             )       {
  const policy = visibilityPolicy(service, agent)
  if (policy === undefined || policy.level === 'none' || scopeInPolicy(policy, scope)) return
  const visible = policy.scopes.map((rule) => rule.scope)
  throw new MemoryToolError(
    'SCOPE_NOT_VISIBLE',
    `当前会话的「记忆可见域」不包含 ${scope};只能读取: ${visible.length > 0 ? visible.join(', ') : '(无)'}`,
  )
}

/** 规范里所有已知 scope(用来在普通限制下把范围外也搜一遍,看看有没有可审批的命中)。 */
function allKnownScopes(service                   )                {
  try {
    service.discoverScopes?.()
    return [...new Set((service.scopeStats?.() ?? []).map((item) => item.scope))]
  } catch {
    return []
  }
}

/** 该服务/配置下"当前会话 + 当前项目 + global"的合并读取集合(去重)。 */
function readScopes(opts                    , service                   , agent         )                {
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

                           
                 
                
                                                        
               
               
                 
                     
                     
                                                 
                    
                                         
                
                                                    
                     
 

                             
            
               
                            
                    
                  
 

/**
 * `path` → 绝对工作区路径。相对路径按会话 cwd 解析（拿不到就按进程 cwd），
 * 再走 `canonicalWorkspacePath` 统一写法 —— 同一个目录必须只有一种 scope 键，
 * 否则 `project:<路径>` 会分叉（`D:/x` 与 `D:\x` 曾是两个 scope，见 0.11.1）。
 */
function resolveWorkspacePath(raw        , agent         )         {
  const value = raw.trim()
  if (value === '') throw new MemoryToolError('PATH_INVALID', 'path 不能为空')
  const cwd = (agent                                                            )?.session?.header?.cwd
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  return canonicalWorkspacePath(isAbsolute(value) ? value : resolve(base, value))
}

export function memorySaveTool(opts                    )                                 {
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
      const agent = agentOf(exec)
      const pathArg = typeof args.path === 'string' ? args.path.trim() : ''

      let explicit                    
      let alias                    
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
export function resolveSummaryChars(value         )         {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SUMMARY_CHARS
  return Math.min(2000, Math.max(20, Math.round(n)))
}

/** 空白折叠 + 截断。memory_search 的“少量摘要”和 memory_get 的 summary 字段共用。 */
export function summarize(content        , chars         = DEFAULT_SUMMARY_CHARS)         {
  const flat = String(content).replace(/\s+/g, ' ').trim()
  return flat.length <= chars ? flat : `${flat.slice(0, chars)}…`
}

                             
               
                
               
                                                 
                             
                          
                       
 

                            
            
               
               
              
                
                   
                                           
                 
 

                               
                      
                                    
                                                               
 

export function memorySearchTool(opts                    )                                     {
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
    async execute(args            , exec          )                        {
      const service = svc(opts)
      if (typeof args.query !== 'string' || args.query.trim().length === 0) {
        throw new MemoryToolError('QUERY_EMPTY', 'query must be a non-empty string')
      }
      const resolved = resolveScope(opts, service, exec, args.scope, 'read')
      const agent = agentOf(exec)
      const policy = visibilityPolicy(service, agent)
      const level = policy?.level
      const visible = policy !== undefined && level !== 'none'
        ? policy.scopes.map((rule) => rule.scope)
        : visibleScopeList(service, agent)
      let scopes                           
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
        scopes = level === 'normal' ? [...new Set([...merged, ...allKnownScopes(service)])] : merged
      } else if (level === 'absolute') {
        assertScopeVisible(service, agent, resolved.scope)
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
        let granted = false
        if (outside.length > 0 && level === 'normal') {
          granted = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_search',
            args.query,
            outside.map((hit) => hit.record),
            (exec                                        )?.signal,
          )
        }
        const selected = granted ? hits : inside
        const result               = {
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
        if (!granted && outside.length > 0) {
          result.withheld = { count: outside.length, reason: level === 'normal' ? 'rejected' : 'absolute' }
        }
        if (wantedTopK !== undefined) result.records = result.records.slice(0, wantedTopK)
        return result
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
      const agent = agentOf(exec)
      const policy = visibilityPolicy(service, agent)
      const level = policy?.level
      const visible = policy !== undefined && level !== 'none'
        ? policy.scopes.map((rule) => rule.scope)
        : visibleScopeList(service, agent)
      let scopes                           
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
      } else if (level === 'absolute') {
        assertScopeVisible(service, agent, resolved.scope)
      }
      let records                       
      let withheld                        
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
        let granted = false
        if (outside.length > 0 && level === 'normal') {
          granted = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_list',
            resolved.scope ?? args.scope ?? 'all',
            outside,
            (exec                                        )?.signal,
          )
        }
        const selected = (granted ? raw : inside).slice(0, limit)
        records = selected.map((r) => ({
          id: r.id,
          scope: r.scope,
          kind: r.kind,
          updatedAt: r.updatedAt,
          content: r.content,
        }))
        if (!granted && outside.length > 0) {
          withheld = { count: outside.length, reason: level === 'normal' ? 'rejected' : 'absolute' }
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
]         

                                                  

/** 省略 fields 时的默认视图：与旧版 memory_get 看到的内容一致。 */
export const DEFAULT_GET_FIELDS             = ['content', 'scope', 'kind', 'tags']

                          
               
                                                   
                              
                                
                       
 

                                                                           

                            
                      
                                   
                    
                   
                                         
                                                               
 

const FIELD_BY_LOWER = new Map                  (GET_FIELDS.map((field) => [field.toLowerCase(), field]))

/** 解析并校验 fields：接受数组，也接受逗号/空格分隔的字符串。 */
export function resolveGetFields(raw                   )             {
  if (raw === undefined || raw === null) return [...DEFAULT_GET_FIELDS]
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : null
  if (items === null) {
    throw new MemoryToolError('FIELDS_INVALID', `fields must be an array or a comma-separated string; allowed: ${GET_FIELDS.join(', ')}`)
  }
  const fields             = []
  const invalid           = []
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
  record                 ,
  fields            ,
  summaryChars        ,
)            {
  const out            = { id: record.id }
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

export function memoryGetTool(opts                    )                               {
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
    async execute(args         , exec          )                     {
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
        const all = service.getByIds(ids)
        // 可见域是白名单:即使知道 id,也不能直接读别的范围/别的类型的正文。
        const agent = agentOf(exec)
        const policy = visibilityPolicy(service, agent)
        const level = policy?.level
        const inside = all.filter((record) => recordAllowed(policy, record.scope, record.kind))
        const outside = all.filter((record) => !recordAllowed(policy, record.scope, record.kind))
        let granted = false
        if (outside.length > 0 && level === 'normal') {
          granted = await askOutOfScope(
            service,
            agent,
            policy,
            'memory_get',
            ids.join(' '),
            outside,
            (exec                                        )?.signal,
          )
        }
        const found = granted ? all : inside
        return {
          records: found.map((r) => pickGetFields(r, fields, chars)),
          fields,
          missing: ids.filter((token) => !found.some((r) => r.id === token || r.id.startsWith(token))),
          ...(!granted && outside.length > 0
            ? { withheld: { count: outside.length, reason: level === 'normal' ? 'rejected' : 'absolute' } }
            : {}),
        }
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

export function memoryTools(opts                    ) {
  return {
    memory_save: memorySaveTool(opts),
    memory_search: memorySearchTool(opts),
    memory_forget: memoryForgetTool(opts),
    memory_list: memoryListTool(opts),
    memory_get: memoryGetTool(opts),
  }
}


//# sourceURL=source/tool-memory/src/index.ts