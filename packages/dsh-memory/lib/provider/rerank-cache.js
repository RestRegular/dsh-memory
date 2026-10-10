/**
 * Rerank cache (design §12): identical (query, candidate set, judge model)
 * repeats — common during iterative agent loops — reuse the previous LLM
 * verdict instead of spending budget again. Entries are invalidated when the
 * candidate set membership changes (id set hash), capped, and TTL-expires.
 */
import { createHash } from 'node:crypto'
                                                

                      
                        
            
 

export class RerankCache {
          entries = new Map                    ()
                   maxEntries        
                   ttlMs        

  constructor(maxEntries = 256, ttlMs = 30 * 60_000) {
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
  }

  static key(query        , candidateIds                   , judgeModel        )         {
    return createHash('sha256')
      .update(query)
      .update('\u0000')
      .update([...candidateIds].sort().join(','))
      .update('\u0000')
      .update(judgeModel)
      .digest('hex')
  }

  get(key        , now = Date.now())                       {
    const e = this.entries.get(key)
    if (!e) return null
    if (now - e.at > this.ttlMs) {
      this.entries.delete(key)
      return null
    }
    return e.outcome
  }

  set(key        , outcome               , now = Date.now())       {
    // simple FIFO cap; insertion order in Map is stable
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(key, { outcome, at: now })
  }

  get size()         {
    return this.entries.size
  }

  clear()       {
    this.entries.clear()
  }
}


//# sourceURL=D:\.deepseek\memory-plugin\packages\memory-local\src\rerank-cache.ts