/**
 * Memory injection logic (M3) — pure functions, no cordis imports.
 *
 * Injection shape follows the official docs: a user-role message whose content
 * is a single `context` block with `contextForm: 'recall'`, prepended to the
 * messages that enter the step via the agent/pre-step waterfall.
 */
import type { MemoryHit } from 'dsh-memory'
import { estimateTokens } from '../../memory-local/src/rerank.ts'

export interface InjectConfig {
  enabled: boolean
  /** Token budget for the injected recall block. */
  tokenBudget: number
  /** Max memories per injection. */
  topK: number
}

export const defaultInjectConfig: InjectConfig = {
  enabled: true,
  tokenBudget: 500,
  topK: 5,
}

/** Minimal structural view of the messages we inspect (role + text blocks). */
export interface InputMessageView {
  role: string
  content: ReadonlyArray<{ type: string; text?: string }>
}

export interface PreStepView {
  messages: readonly InputMessageView[]
  signal?: AbortSignal
}

export interface PreStepDecisionView {
  messages: readonly InputMessageView[]
}

/**
 * Extract the retrieval query: the text of the LAST user message. Synthetic
 * context injections (file notices etc.) are user-role too, so scanning from
 * the end finds the freshest human-visible input; empty text → no injection.
 */
export function pickQueryText(messages: readonly InputMessageView[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    const text = (m.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join(' ')
      .trim()
    if (text) return text
  }
  return ''
}

/** Render hits into a recall text block, greedily within the token budget. */
export function renderRecallBlock(hits: MemoryHit[], cfg: InjectConfig): { text: string; tokens: number } | null {
  if (hits.length === 0) return null
  const header = '以下是与此请求可能相关的长期记忆，供参考（可用 memory_search 核实，用 memory_forget 删除）：'
  let tokens = estimateTokens(header) + 4
  const lines: string[] = []
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
export function recallText(text: string): string {
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
  private lastText = ''
  private readonly search: (query: string, signal?: AbortSignal) => Promise<MemoryHit[]>
  private readonly cfg: InjectConfig

  constructor(
    search: (query: string, signal?: AbortSignal) => Promise<MemoryHit[]>,
    cfg: InjectConfig,
  ) {
    this.search = search
    this.cfg = cfg
  }

  async maybeInject(
    input: PreStepView,
    _decision: PreStepDecisionView,
  ): Promise<string | undefined> {
    if (!this.cfg.enabled) return undefined
    const query = pickQueryText(input.messages)
    if (!query) return undefined

    let hits: MemoryHit[]
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
