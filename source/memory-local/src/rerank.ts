/**
 * LLM-as-judge rerank stage (M2). Pure logic: the caller injects a one-shot
 * LLM invoke function, so unit tests run against a fake and the cordis wiring
 * (apply.ts) adapts `ctx.llm` into it. Every failure path degrades to "no
 * rerank" — retrieval must never depend on this stage succeeding.
 */
import type { MemoryRecord } from 'dsh-memory'

export interface RerankConfig {
  enabled: boolean
  provider: string
  model: string
  timeoutMs: number
  /** Daily token budget for rerank calls; exhausted → skip until next day. */
  dailyBudgetTokens: number
  /** Final score = (1 - weight) * recallScore + weight * llmScore. */
  weight: number
  /** Max candidates sent to the LLM (they are the top-N of recall shaping). */
  topN: number
}

export const defaultRerankConfig: RerankConfig = {
  enabled: true,
  provider: '',
  model: '',
  timeoutMs: 1500,
  dailyBudgetTokens: 200_000,
  weight: 0.6,
  topN: 10,
}

/** One-shot LLM invocation the host provides (adapter sees GenerateOptions). */
export type LlmInvoke = (req: { system: string; prompt: string; signal: AbortSignal }) => Promise<string>

export interface RerankCandidate {
  id: string
  content: string
  recallScore: number
}

export interface RerankOutcome {
  /** id -> llm score (0..1) for candidates the judge scored. */
  scores: Map<string, number>
  /** ~tokens charged to the daily budget for this call. */
  tokensSpent: number
}

/** Rough token estimate; CJK-heavy text runs ~1.5-2 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

/** Daily budget bucket keyed by local date; resets when the date rolls over. */
export class DailyBudget {
  private day = ''
  private used = 0
  readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  /** Try to reserve n tokens; returns false when the day's budget is spent. */
  trySpend(n: number): boolean {
    this.rollIfNeeded()
    if (this.used + n > this.limit) return false
    this.used += n
    return true
  }

  get usedToday(): number {
    this.rollIfNeeded()
    return this.used
  }

  private rollIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10)
    if (today !== this.day) {
      this.day = today
      this.used = 0
    }
  }
}

export function buildRerankPrompt(query: string, candidates: RerankCandidate[]): { system: string; prompt: string } {
  const lines = candidates.map((c, i) => `${i + 1}. [${c.id}] ${c.content.slice(0, 500)}`)
  return {
    system: '你是检索重排序器。根据与查询的相关性给每个候选记忆打分。只输出 JSON 数组，格式 [[id, 分数], ...]，分数为 0 到 1 的小数。不要输出其他内容。',
    prompt: `查询：${query}\n\n候选记忆：\n${lines.join('\n')}`,
  }
}

/** Parse `[[id, score], ...]` out of the model output; tolerates prose around it. */
export function parseRerankOutput(text: string, validIds: Set<string>): Map<string, number> {
  const out = new Map<string, number>()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return out
  }
  if (!Array.isArray(parsed)) return out
  for (const pair of parsed) {
    if (!Array.isArray(pair) || pair.length < 2) continue
    const [id, score] = pair as [unknown, unknown]
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
export async function rerank(opts: {
  invoke: LlmInvoke | null
  cfg: RerankConfig
  query: string
  candidates: RerankCandidate[]
  budget: DailyBudget
  signal?: AbortSignal
}): Promise<RerankOutcome | null> {
  const { invoke, cfg, query, candidates, budget } = opts
  if (!cfg.enabled || !invoke) return null
  if (candidates.length < 2) return null // not worth a model call

  const batch = candidates.slice(0, cfg.topN)
  const { system, prompt } = buildRerankPrompt(query, batch)

  const est = estimateTokens(system) + estimateTokens(prompt) + 100
  if (!budget.trySpend(est)) return null // budget exhausted → recall order stands

  const timeout = AbortSignal.timeout(cfg.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let text: string
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
  candidates: RerankCandidate[],
  outcome: RerankOutcome,
  weight: number,
): Array<{ id: string; score: number }> {
  const w = Math.min(1, Math.max(0, weight))
  return candidates.map((c) => {
    const llm = outcome.scores.get(c.id)
    const score = llm === undefined ? c.recallScore : (1 - w) * c.recallScore + w * llm
    return { id: c.id, score }
  })
}
