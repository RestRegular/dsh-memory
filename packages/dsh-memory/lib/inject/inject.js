/**
 * Memory injection logic (M3) — pure functions, no cordis imports.
 *
 * Injection shape follows the official docs: a user-role message whose content
 * is a single `context` block with `contextForm: 'recall'`, prepended to the
 * messages that enter the step via the agent/pre-step waterfall.
 */
                                           
import { estimateTokens } from '../provider/rerank.js'

                               
                  
                                                    
                     
                                    
              
 

export const defaultInjectConfig               = {
  enabled: true,
  tokenBudget: 500,
  topK: 5,
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

/** Render hits into a recall text block, greedily within the token budget. */
export function renderRecallBlock(hits             , cfg              )                                          {
  if (hits.length === 0) return null
  const header = '以下是与此请求可能相关的长期记忆，供参考（可用 memory_search 核实，用 memory_forget 删除）：'
  let tokens = estimateTokens(header) + 4
  const lines           = []
  for (const h of hits.slice(0, cfg.topK)) {
    const line = `- ${h.record.content.replace(/\s+/g, ' ').slice(0, 300)}`
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
export class MemoryInjector {
          lastText = ''
                   search                                                               
                   cfg              

  constructor(
    search                                                               ,
    cfg              ,
  ) {
    this.search = search
    this.cfg = cfg
  }

  async maybeInject(
    input             ,
    _decision                     ,
  )                              {
    if (!this.cfg.enabled) return undefined
    const query = pickQueryText(input.messages)
    if (!query) return undefined

    let hits             
    try {
      hits = await this.search(query, input.signal)
    } catch {
      return undefined // retrieval failure never breaks the agent loop
    }

    const block = renderRecallBlock(hits, this.cfg)
    if (!block || block.text === this.lastText) return undefined
    this.lastText = block.text

    return block.text
  }
}


//# sourceURL=D:\.deepseek\memory-plugin\packages\memory-inject\src\inject.ts