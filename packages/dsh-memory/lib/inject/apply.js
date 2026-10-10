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
                                                  
import { createUserMessage } from '@deepseek-ai/dsh-llm'
                                                  
import { MemoryInjector, defaultInjectConfig,                   } from './inject.js'

                                                                   
                                                                               
                       
 

export const name = 'dsh-memory-inject'

export function apply(ctx         , config                     = {}) {
  const cfg               = {
    enabled: config.enabled ?? defaultInjectConfig.enabled,
    tokenBudget: config.tokenBudget ?? defaultInjectConfig.tokenBudget,
    topK: config.topK ?? defaultInjectConfig.topK,
  }

  // One injector per activation: its repeat-suppression state must live across
  // the steps of a turn (a per-step instance would re-inject every step).
  const injector = new MemoryInjector(
    async (query, signal) => {
      const memory = ctx.get('memory')                                
      if (!memory?.search) return []
      return memory.search({ text: query, signal, topK: cfg.topK })
    },
    cfg,
  )

  ctx.on('agent/pre-step', async (input, next) => {
    // Runs outermost (prepend), so `next()` yields the fully assembled decision.
    const decision = await next()
    // A rejected step must pass through untouched — never rebuild the decision.
    if (!decision || decision.kind === 'reject' || input.signal?.aborted) return decision
    // optional capability: absence (or partial load) → pass through untouched
    if (!ctx.get('memory')) return decision

    const text = await injector.maybeInject(
      { messages: input.messages         , signal: input.signal },
      { messages: decision.messages          },
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
function isWellFormedMessage(message         )          {
  const m = message                                                                                     
  if (!m || typeof m.id !== 'string' || typeof m.role !== 'string') return false
  if (!Array.isArray(m.content) || m.content.length === 0) return false
  if (!m.content.every((block) => typeof (block                      )?.type === 'string' && VALID_BLOCK_TYPES.has((block                    ).type))) return false
  const source = m.source                                  
  return typeof source?.kind === 'string'
}


//# sourceURL=D:\.deepseek\memory-plugin\packages\memory-inject\src\apply.ts