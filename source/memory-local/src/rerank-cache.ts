/**
 * Rerank cache (design §12): identical (query, candidate set, judge model)
 * repeats — common during iterative agent loops — reuse the previous LLM
 * verdict instead of spending budget again. Entries are invalidated when the
 * candidate set membership changes (id set hash), capped, and TTL-expires.
 */
import { createHash } from 'node:crypto'
import type { RerankOutcome } from './rerank.ts'

interface CacheEntry {
  outcome: RerankOutcome
  at: number
}

export class RerankCache {
  private entries = new Map<string, CacheEntry>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(maxEntries = 256, ttlMs = 30 * 60_000) {
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
  }

  static key(query: string, candidateIds: readonly string[], judgeModel: string): string {
    return createHash('sha256')
      .update(query)
      .update('\u0000')
      .update([...candidateIds].sort().join(','))
      .update('\u0000')
      .update(judgeModel)
      .digest('hex')
  }

  get(key: string, now = Date.now()): RerankOutcome | null {
    const e = this.entries.get(key)
    if (!e) return null
    if (now - e.at > this.ttlMs) {
      this.entries.delete(key)
      return null
    }
    return e.outcome
  }

  set(key: string, outcome: RerankOutcome, now = Date.now()): void {
    // simple FIFO cap; insertion order in Map is stable
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(key, { outcome, at: now })
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
