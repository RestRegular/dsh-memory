/**
 * Lexical scoring — pure functions, no I/O.
 *
 * Tokenization handles mixed CJK/Latin text: Latin words plus CJK unigrams
 * and bigrams (bigrams matter — single Chinese characters are too ambiguous).
 */

export interface LexicalStats {
  /** document frequency per token across the candidate universe */
  df: Map<string, number>
  /** number of documents in the universe */
  n: number
}

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_+\-.]{1,}/g)) tokens.push(m[0])
  for (const run of lower.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const chars = [...run[0]]
    for (const c of chars) tokens.push(c)
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i]! + chars[i + 1]!)
  }
  return tokens
}

export function buildStats(tokenSets: Iterable<Set<string>>): LexicalStats {
  const df = new Map<string, number>()
  let n = 0
  for (const set of tokenSets) {
    n++
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return { df, n }
}

/** IDF-weighted overlap of query tokens present in the record, normalized to 0..1. */
export function lexicalScore(queryTokens: string[], recordTokens: Set<string>, stats: LexicalStats): number {
  const unique = [...new Set(queryTokens)]
  if (unique.length === 0 || stats.n === 0) return 0
  let hit = 0
  let total = 0
  for (const t of unique) {
    const idf = Math.log(1 + stats.n / (1 + (stats.df.get(t) ?? 0)))
    total += idf
    if (recordTokens.has(t)) hit += idf
  }
  return total === 0 ? 0 : hit / total
}

/**
 * True when the query shares at least one STRONG token with the record —
 * a Latin word or a CJK bigram. Single CJK characters are too ambiguous to
 * stand alone: a query mentioning 完 shouldn't match every record containing
 * 完. Matches carried only by weak tokens must clear a higher score floor
 * (0.25: the measured floor of real hits) instead of the permissive one.
 */
export function hasStrongHit(queryTokens: string[], recordTokens: Set<string>): boolean {
  for (const t of queryTokens) {
    if (t.length >= 2 && recordTokens.has(t)) return true
  }
  return false
}

/** Exponential recency decay with configurable half-life. */
export function recencyFactor(lastAccessedAt: number, now: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, now - lastAccessedAt) / 86_400_000
  return Math.pow(0.5, ageDays / Math.max(halfLifeDays, 0.001))
}

export interface RecordScoreOptions {
  now: number
  halfLifeDays: number
  /** Superseded records stay retrievable but rank lower. */
  superseded: boolean
}

export function recordScore(
  lexical: number,
  importance: number,
  accessCount: number,
  lastAccessedAt: number,
  opts: RecordScoreOptions,
): number {
  const recency = recencyFactor(lastAccessedAt, opts.now, opts.halfLifeDays)
  const importanceFactor = 0.5 + 0.5 * Math.min(1, Math.max(0, importance))
  const accessBoost = 1 + 0.1 * Math.log(1 + accessCount)
  const penalty = opts.superseded ? 0.3 : 1
  return lexical * recency * importanceFactor * accessBoost * penalty
}

/** Cosine similarity for unit vectors == dot product. Normalizes defensively. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Normalize a vector in place; returns it. Zero vectors are left as-is. */
export function normalizeInPlace(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm
  return v
}

/** LRU cache for rerank/embedding dedupe. */
export class LruSet<V> {
  private map = new Map<string, V>()
  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
}
