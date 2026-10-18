/**
 * Memory injection logic (M3) — pure functions, no cordis imports.
 *
 * Injection shape follows the official docs: a user-role message whose content
 * is a single `context` block with `contextForm: 'recall'`, prepended to the
 * messages that enter the step via the agent/pre-step waterfall.
 */
                                                         
import { estimateTokens } from '../provider/rerank.js'
import { normalizeScopeInput } from '../provider/scope.js'

                               
                  
                                                    
                     
                                    
              
     
                                          
                                                                     
     
                        
 

export const defaultInjectConfig               = {
  enabled: true,
  tokenBudget: 500,
  topK: 5,
}

/** 召回注入能用到的那部分 provider 能力。 */
                                      
                                              
                                              
 

/** 宿主里"按会话 id 找 live session"的那一小部分能力(拿不到就不做父会话召回)。 */
                                  
                           
 

/**
 * 把 config.extraScopes 规范化成 scope 键列表;非法项忽略并记一行日志
 * (配置写错不该让整个注入半边失效)。
 */
export function normalizeExtraScopes(raw                   , warn                            = console.warn)           {
  const out           = []
  for (const item of raw) {
    const normalized = normalizeScopeInput(item)
    if (!normalized.ok) {
      warn(`[dsh-memory-inject] 忽略非法的 inject.extraScopes 项 ${JSON.stringify(item)}: ${normalized.message}`)
      continue
    }
    if (normalized.scope !== undefined && !out.includes(normalized.scope)) out.push(normalized.scope)
  }
  return out
}

/**
 * 无显式 scope 时的召回范围:当前会话 + 当前项目 + global(provider 解析)
 * + inject.extraScopes + 父会话(fork 时,只读召回)。
 * 任何一步拿不到都只降级,绝不抛(注入路径抛错会打断整个 agent 循环)。
 */
export function resolveInjectScopes(
  memory                     ,
  agent         ,
  extraScopes                   ,
  sessions                             ,
)                       {
  const scopes           = []
  try {
    for (const scope of memory.resolveReadScopes?.(agent) ?? []) {
      if (!scopes.includes(scope)) scopes.push(scope)
    }
  } catch { /* 降级为 extraScopes */ }
  for (const scope of extraScopes) if (!scopes.includes(scope)) scopes.push(scope)
  // fork 出来的会话:父会话的记忆也值得召回(只读)。父会话可能已不在内存里,拿不到就跳过。
  try {
    const header = (agent                                                                                        )?.session?.header
    const parent = typeof header?.parentSession === 'string' ? header.parentSession : undefined
    if (parent !== undefined && header?.origin !== 'subagent') {
      if (sessions?.get?.(parent) !== undefined) {
        const scope = `session:${parent}`
        if (!scopes.includes(scope)) scopes.push(scope)
      }
    }
  } catch { /* 父会话召回是可选增强 */ }
  return scopes.length > 0 ? scopes : undefined
}

/** Minimal structural view of the messages we inspect (role + text blocks). */
                                   
              
                                                         
 

                              
                                       
                      
     
                                                 
                                                                   
                                                         
     
                            
 

                                      
                                       
 

/**
 * Extract the retrieval query: the text of the LAST user message. Synthetic
 * context injections (file notices etc.) are user-role too, so scanning from
 * the end finds the freshest human-visible input; empty text → no injection.
 */
export function pickQueryText(messages                             )         {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] 
    if (m.role !== 'user') continue
    const text = (m.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text )
      .join(' ')
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * 这一步的 messages 里是否已经有一条内容完全相同的召回块。
 *
 * 正常情况下永远不会命中:一个激活只有一个 MemoryInjector,而它自己用 lastText
 * 去重。但只要宿主把这条 entry 应用了两次(热重载/重新启用时旧 fiber 的
 * agent/pre-step 监听没被清掉),两个注入器就会各追加一条逐字相同的消息 ——
 * 表现在会话轨迹里就是同一轮「上下轮」卡片连着出现两次(2026-10-17 实况)。
 * 注入本身是"多一条也无害、少一条也不坏"的提示块,所以这里按内容做一次幂等:
 * 另一个实例已经放进去的同一段,就不要再放。
 */
export function hasRecallMessage(
  messages                                                                  ,
  text        ,
)          {
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (m.source?.kind !== 'memory') continue
    const joined = (m.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text )
      .join('\n')
    if (joined === text) return true
  }
  return false
}

/** 召回的两种形态:旧的长文(300 字)与新的"印象"(短摘要 + 指路取全文)。 */
                                      
                                    
                
                   
                      
 

/** Render hits into a recall text block, greedily within the token budget. */
export function renderRecallBlock(
  hits             ,
  cfg              ,
  options                      = {},
)                                          {
  if (hits.length === 0) return null
  const impression = options.impression === true
  const chars = impression ? (options.chars ?? 120) : 300
  const header = impression
    ? '以下是与你这次请求可能相关的记忆摘要：'
    : '以下是与此请求可能相关的长期记忆，供参考（可用 memory_search 核实，用 memory_forget 删除）：'
  let tokens = estimateTokens(header) + 4
  const lines           = []
  for (const h of hits.slice(0, cfg.topK)) {
    const line = `- ${h.record.id.slice(0, 8)} ${h.record.content.replace(/\s+/g, ' ').slice(0, chars)}`
    const cost = estimateTokens(line) + 1
    if (tokens + cost > cfg.tokenBudget) break
    lines.push(line)
    tokens += cost
  }
  if (lines.length === 0) return null
  return { text: `${header}\n${lines.join('\n')}`, tokens }
}

/** The context block we prepend (matches the documented ContextForm 'recall'). */
export function recallText(text        )         {
  return text
}

/**
 * Turn-agnostic injector: searches memory for the step's query and returns the
 * recall text to append. The host middleware (apply.ts) wraps that text into a
 * real message via createUserMessage — a bare {role, content} object is NOT a
 * message and crashes the loop (see the 2026-10-10 incident below).
 *
 * Repeated identical injections are suppressed so a multi-step turn does not
 * repeat the same block before every model call.
 */
/** 配置既可以给静态值,也可以给 getter —— 面板改了设置,下一步就生效。 */
                                    

export class MemoryInjector {
          lastText = ''
                   search                                                                                           
                   cfg                            
                   renderOptions                                   

  constructor(
    search                                                                                           ,
    cfg                            ,
    renderOptions                                    = {},
  ) {
    this.search = search
    this.cfg = cfg
    this.renderOptions = renderOptions
  }

  async maybeInject(
    input             ,
    _decision                     ,
  )                              {
    const cfg = typeof this.cfg === 'function' ? this.cfg() : this.cfg
    if (!cfg.enabled) return undefined
    const query = pickQueryText(input.messages)
    if (!query) return undefined

    let hits             
    try {
      hits = await this.search(query, input.signal, input.scopes)
    } catch {
      return undefined // retrieval failure never breaks the agent loop
    }

    const options = typeof this.renderOptions === 'function' ? this.renderOptions() : this.renderOptions
    const block = renderRecallBlock(hits, cfg, options)
    if (!block || block.text === this.lastText) return undefined
    this.lastText = block.text

    return block.text
  }
}

/** 从 agent 上取会话 id;取不到就没有"每个会话只发一次摘要"的锚点。 */
export function sessionIdOf(agent         )                     {
  const id = (agent                                              )?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** 摘要注入最多记住多少个会话(一个进程里开过的会话上界,防止 Set 无限长)。 */
const MAX_DIGESTED_SESSIONS = 500

/**
 * 会话摘要注入器:一个会话只注入一次"已有哪些记忆"的摘要。
 * 检索失败或结果为空也标记为已完成 —— 摘要不是必需品,不能每步重试。
 */
export class MemoryDigester {
                   done = new Set        ()
                   list                                                                    

  constructor(
    list                                                                    ,
  ) {
    this.list = list
  }

  async maybeDigest(
    sessionId                    ,
    scopes                               ,
    render                                            ,
  )                              {
    if (sessionId === undefined || this.done.has(sessionId)) return undefined
    this.markDone(sessionId)
    let records                
    try {
      records = await this.list(scopes)
    } catch {
      return undefined
    }
    return render(records) ?? undefined
  }

          markDone(sessionId        )       {
    this.done.add(sessionId)
    if (this.done.size > MAX_DIGESTED_SESSIONS) {
      const oldest = this.done.values().next()
      if (!oldest.done) this.done.delete(oldest.value)
    }
  }
}


//# sourceURL=source/memory-inject/src/inject.ts