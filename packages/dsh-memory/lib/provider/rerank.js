/**
 * LLM-as-judge rerank stage (M2). Pure logic: the caller injects a one-shot
 * LLM invoke function, so unit tests run against a fake and the cordis wiring
 * (apply.ts) adapts `ctx.llm` into it. Every failure path degrades to "no
 * rerank" — retrieval must never depend on this stage succeeding.
 */
                                              

                               
                  
                  
               
                   
                                                                              
                           
                                                                      
                
                                                                               
              
 

export const defaultRerankConfig               = {
  enabled: true,
  provider: '',
  model: '',
  timeoutMs: 1500,
  dailyBudgetTokens: 200_000,
  weight: 0.6,
  topN: 10,
}

/** One-shot LLM invocation the host provides (adapter sees GenerateOptions). */
                                                                                                         

                                  
            
                 
                     
 

                                
                                                                
                             
                                                           
                     
 

/** Rough token estimate; CJK-heavy text runs ~1.5-2 chars per token. */
export function estimateTokens(text        )         {
  return Math.ceil(text.length / 2)
}

/** Daily budget bucket keyed by local date; resets when the date rolls over. */
export class DailyBudget {
          day = ''
          used = 0
           limit        

  constructor(limit        ) {
    this.limit = limit
  }

  /** Try to reserve n tokens; returns false when the day's budget is spent. */
  trySpend(n        )          {
    this.rollIfNeeded()
    if (this.used + n > this.limit) return false
    this.used += n
    return true
  }

  get usedToday()         {
    this.rollIfNeeded()
    return this.used
  }

          rollIfNeeded()       {
    const today = new Date().toISOString().slice(0, 10)
    if (today !== this.day) {
      this.day = today
      this.used = 0
    }
  }
}

export function buildRerankPrompt(query        , candidates                   )                                     {
  const lines = candidates.map((c, i) => `${i + 1}. [${c.id}] ${c.content.slice(0, 500)}`)
  return {
    system: '你是检索重排序器。根据与查询的相关性给每个候选记忆打分。只输出 JSON 数组，格式 [[id, 分数], ...]，分数为 0 到 1 的小数。不要输出其他内容。',
    prompt: `查询：${query}\n\n候选记忆：\n${lines.join('\n')}`,
  }
}

/** Parse `[[id, score], ...]` out of the model output; tolerates prose around it. */
export function parseRerankOutput(text        , validIds             )                      {
  const out = new Map                ()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return out
  let parsed         
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return out
  }
  if (!Array.isArray(parsed)) return out
  for (const pair of parsed) {
    if (!Array.isArray(pair) || pair.length < 2) continue
    const [id, score] = pair                      
    if (typeof id !== 'string' || !validIds.has(id)) continue
    const n = typeof score === 'number' ? score : Number(score)
    if (!Number.isFinite(n)) continue
    out.set(id, Math.min(1, Math.max(0, n)))
  }
  return out
}

/**
 * Run the rerank stage. Returns null on any skip/failure — callers fall back
 * to the recall order untouched.
 */
export async function rerank(opts   
                          
                   
               
                               
                     
                      
 )                                {
  const { invoke, cfg, query, candidates, budget } = opts
  if (!cfg.enabled || !invoke) return null
  if (candidates.length < 2) return null // not worth a model call

  const batch = candidates.slice(0, cfg.topN)
  const { system, prompt } = buildRerankPrompt(query, batch)

  const est = estimateTokens(system) + estimateTokens(prompt) + 100
  if (!budget.trySpend(est)) return null // budget exhausted → recall order stands

  const timeout = AbortSignal.timeout(cfg.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let text        
  try {
    text = await invoke({ system, prompt, signal })
  } catch {
    return null // timeout / transport / adapter error → graceful degradation
  }

  const validIds = new Set(batch.map((c) => c.id))
  const scores = parseRerankOutput(text, validIds)
  if (scores.size === 0) return null // unusable output → recall order stands
  return { scores, tokensSpent: est + estimateTokens(text) }
}

/** Blend judge scores into recall scores. Unscored candidates keep recall. */
export function blendScores(
  candidates                   ,
  outcome               ,
  weight        ,
)                                       {
  const w = Math.min(1, Math.max(0, weight))
  return candidates.map((c) => {
    const llm = outcome.scores.get(c.id)
    const score = llm === undefined ? c.recallScore : (1 - w) * c.recallScore + w * llm
    return { id: c.id, score }
  })
}


//# sourceURL=source/memory-local/src/rerank.ts