/**
 * Cordis wiring for dsh-memory-inject. Loaded only inside DSH: hooks the
 * documented agent/pre-step waterfall and appends a user-role recall message
 * carrying the retrieved memories.
 *
 * Message construction MUST go through createUserMessage: the loop reads
 * `decision.kind` and downstream consumers read `message.source.kind`, so a
 * hand-rolled `{ role, content }` object aborts the turn with
 * "Cannot read properties of undefined (reading 'kind')" (incident 2026-10-10).
 * The reference implementation is the official dsh-time-context plugin.
 *
 * Memory is an OPTIONAL dependency (ctx.get) by design — this plugin must not
 * sit PENDING when no provider is loaded; it just stays passive.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  MemoryInjector,
  defaultInjectConfig,
  normalizeExtraScopes,
  resolveInjectScopes,
  type InjectConfig,
  type InjectMemoryService,
  type SessionRegistry,
} from './inject.ts'

export interface MemoryInjectConfig extends Partial<InjectConfig> {
  /** @deprecated 用 provider 的项目键(默认 project:<会话 cwd>);保留仅为兼容旧配置。 */
  projectScope?: string
}

export const name = 'dsh-memory-inject'

export function apply(ctx: Context, config: MemoryInjectConfig = {}) {
  const cfg: InjectConfig = {
    enabled: config.enabled ?? defaultInjectConfig.enabled,
    tokenBudget: config.tokenBudget ?? defaultInjectConfig.tokenBudget,
    topK: config.topK ?? defaultInjectConfig.topK,
  }
  const extraScopes = normalizeExtraScopes(config.extraScopes ?? [])
  const readScopesFor = (memory: InjectMemoryService, agent: unknown): string[] | undefined =>
    resolveInjectScopes(memory, agent, extraScopes, ctx.get?.('sessions') as SessionRegistry | undefined)

  // One injector per activation: its repeat-suppression state must live across
  // the steps of a turn (a per-step instance would re-inject every step).
  const injector = new MemoryInjector(
    async (query, signal, scopes) => {
      const memory = ctx.get('memory') as InjectMemoryService | undefined
      if (!memory?.search) return []
      return memory.search({
        text: query,
        signal,
        topK: cfg.topK,
        ...(scopes !== undefined ? { scopes: [...scopes] } : {}),
      })
    },
    cfg,
  )

  ctx.on('agent/pre-step', async (input, next) => {
    // Runs outermost (prepend), so `next()` yields the fully assembled decision.
    const decision = await next()
    // A rejected step must pass through untouched — never rebuild the decision.
    if (!decision || decision.kind === 'reject' || input.signal?.aborted) return decision
    // optional capability: absence (or partial load) → pass through untouched
    const memory = ctx.get('memory') as InjectMemoryService | undefined
    if (!memory) return decision

    // 会话上下文只在 pre-step 里拿得到:交给 search 的 `scopes`,与 memory_search 的
    // 默认合并集合用同一套解析(provider 的 resolveReadScopes)。
    const scopes = readScopesFor(memory, (input as { agent?: unknown }).agent)
    const text = await injector.maybeInject(
      { messages: input.messages as never, signal: input.signal, ...(scopes !== undefined ? { scopes } : {}) },
      { messages: decision.messages as never },
    )
    if (!text) return decision
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'memory', form: 'recall' },
    })
    // Last-resort guard: a malformed message aborts the whole turn downstream
    // (consumers read message.source.kind), so never publish one.
    if (!isWellFormedMessage(message)) return decision
    return { ...decision, messages: [...decision.messages, message] }
  }, { prepend: true })
}

const VALID_BLOCK_TYPES = new Set(['text', 'reasoning', 'image', 'file', 'tool-call', 'tool-addition', 'tool-removal'])

/** Structural check against the host Message contract (id/role/content/source.kind). */
function isWellFormedMessage(message: unknown): boolean {
  const m = message as { id?: unknown; role?: unknown; content?: unknown; source?: unknown } | undefined
  if (!m || typeof m.id !== 'string' || typeof m.role !== 'string') return false
  if (!Array.isArray(m.content) || m.content.length === 0) return false
  if (!m.content.every((block) => typeof (block as { type?: unknown })?.type === 'string' && VALID_BLOCK_TYPES.has((block as { type: string }).type))) return false
  const source = m.source as { kind?: unknown } | undefined
  return typeof source?.kind === 'string'
}
