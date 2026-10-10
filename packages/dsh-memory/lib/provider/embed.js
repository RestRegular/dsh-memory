/**
 * Minimal OpenAI-compatible /v1/embeddings client for a local llama-server.
 * Fails soft: every failure resolves to `null` so callers can degrade.
 */

                                     
                  
               
              
                   
 

export class EmbedClient {
          healthy = true
          lastProbe = 0
          backoffMs = 1000
          opts                    

  constructor(opts                    ) {
    this.opts = opts
  }

  /** Cheap circuit breaker: skip the network while marked unhealthy. */
          get usable()          {
    const now = Date.now()
    if (this.healthy) return true
    if (now - this.lastProbe >= this.backoffMs) {
      // allow a retry; double the backoff on continued failure
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
      return true
    }
    return false
  }

  markDown()       {
    this.healthy = false
    this.lastProbe = Date.now()
  }

  markUp()       {
    this.healthy = true
    this.backoffMs = 1000
  }

  get isHealthy()          {
    return this.healthy
  }

  /**
   * Embed texts.
   *
   * `opts.timeoutMs` overrides the configured budget per call: the default
   * (interactive) budget is tuned for short search queries, while writing or
   * backfilling FULL record contents on CPU can take seconds. Using the
   * interactive budget there silently failed every long record and poisoned the
   * circuit breaker (measured 3143ms for three ~600-char records on 2026-10-10).
   */
  async embed(texts          , signal              , opts                         )                                 {
    if (texts.length === 0) return []
    if (!this.usable) return null
    const timeout = AbortSignal.timeout(opts?.timeoutMs ?? this.opts.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const res = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: texts, model: this.opts.model }),
        signal: combined,
      })
      if (!res.ok) {
        this.markDown()
        return null
      }
      const json = (await res.json())                                              
      const data = json.data
      if (!Array.isArray(data) || data.length !== texts.length) {
        this.markDown()
        return null
      }
      const out                 = []
      for (const item of data) {
        const arr = item.embedding
        if (!Array.isArray(arr) || arr.length !== this.opts.dims) {
          this.markDown()
          return null
        }
        const v = new Float32Array(arr)
        // llama-server returns L2-normalized vectors; normalize defensively anyway
        let norm = 0
        for (let i = 0; i < v.length; i++) norm += v[i]  * v[i] 
        const n = Math.sqrt(norm)
        if (n > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]  / n
        out.push(v)
      }
      this.markUp()
      return out
    } catch {
      this.markDown()
      return null
    }
  }
}


//# sourceURL=D:\.deepseek\memory-plugin\packages\memory-local\src\embed.ts