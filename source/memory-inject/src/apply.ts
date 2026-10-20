/**
 * Cordis wiring for dsh-memory-inject. Loaded only inside DSH.
 *
 * 注入分四层,全部可以在面板「记忆 → 设置」里单独开关:
 *  1. recall     —— 每轮按查询召回(可有可无;内容没变就不重复注入)
 *  2. digest     —— 会话第一步给一次"已有记忆"的摘要
 *  3. policy     —— 系统提示里的「记忆使用策略」常驻段
 *  4. rules      —— 系统提示里的「硬性规则」段(kind='rule' 的记忆)
 * 另有 rulesDelta —— 旧会话在下一轮补一条新增/变更的规则(0.9.0;随 rules 开关)
 * 另有 turnEnd —— 轮末提醒(下一轮开头提示"上一轮若有结论就记一条"),默认关。
 *
 * Message construction MUST go through createUserMessage: the loop reads
 * `decision.kind` and downstream consumers read `message.source.kind`, so a
 * hand-rolled `{ role, content }` object aborts the turn with
 * "Cannot read properties of undefined (reading 'kind')" (incident 2026-10-10).
 *
 * Memory is an OPTIONAL dependency (ctx.get) by design — this plugin must not
 * sit PENDING when no provider is loaded; it just stays passive.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryRecord } from 'dsh-memory'
import {
  MemoryDigester,
  MemoryInjector,
  hasRecallMessage,
  normalizeExtraScopes,
  resolveInjectScopes,
  sessionIdOf,
  type InjectConfig,
  type InjectMemoryService,
  type RecallRenderOptions,
  type SessionRegistry,
} from './inject.ts'
import { renderDigestBlock } from './digest.ts'
import { renderRulesBlock } from './rules.ts'
import { ruleDeltaText } from './rules-delta.ts'
import { POLICY_TEXT } from './policy.ts'
import { normalizeInjectSettings, type InjectSettings } from '../../memory-local/src/inject-settings.ts'

export interface MemoryInjectConfig {
  enabled?: boolean
  tokenBudget?: number
  topK?: number
  extraScopes?: string[]
  /** @deprecated 用 provider 的项目键(默认 project:<会话 cwd>);保留仅为兼容旧配置。 */
  projectScope?: string
}

/** provider 在注入侧能提供的那部分能力(多余的方法都用可选判断)。 */
interface MemoryWithInject extends InjectMemoryService {
  listSync?(input: { scopes?: string[]; kind?: string; limit?: number }): MemoryRecord[]
  injectSettings?(): InjectSettings
}

/** 轮末提醒的文案:短、祈使句,不占预算。 */
const NUDGE_TEXT =
  '上一轮若产生了可复用的结论（决策、踩坑、流程、口径），先 memory_save 记一条再继续；' +
  '没有就忽略这条提醒。'

export const name = 'dsh-memory-inject'

export function apply(ctx: Context, config: MemoryInjectConfig = {}) {
  // 配置只作为兜底;provider 的 settings.json(面板可改)优先。
  const fallback = normalizeInjectSettings(config)
  const enabled = config.enabled !== false

  const settingsOf = (): InjectSettings => {
    const memory = ctx.get('memory') as MemoryWithInject | undefined
    try {
      const live = memory?.injectSettings?.()
      if (live) return live
    } catch { /* 拿不到就用配置里的 */ }
    return fallback
  }

  const recallCfg = (): InjectConfig => {
    const settings = settingsOf().recall
    return { enabled: enabled && settings.enabled, topK: settings.topK, tokenBudget: settings.tokenBudget }
  }
  const impressionCfg = (): RecallRenderOptions => {
    const settings = settingsOf().impression
    return { impression: settings.enabled, chars: settings.chars }
  }

  const extraScopes = normalizeExtraScopes(config.extraScopes ?? [])
  const readScopesFor = (memory: InjectMemoryService, agent: unknown): string[] | undefined =>
    resolveInjectScopes(memory, agent, extraScopes, ctx.get?.('sessions') as SessionRegistry | undefined)

  // One injector per activation: its repeat-suppression state must live across
  // the steps of a turn (a per-step instance would re-inject every step).
  const injector = new MemoryInjector(
    async (query, signal, scopes) => {
      const memory = ctx.get('memory') as MemoryWithInject | undefined
      if (!memory?.search) return []
      return memory.search({
        text: query,
        signal,
        topK: recallCfg().topK,
        ...(scopes !== undefined ? { scopes: [...scopes] } : {}),
      })
    },
    recallCfg,
    impressionCfg,
  )

  // 摘要:provider 没有 list(旧版/半边加载失败)时自动退化为"不发摘要"。
  const digester = new MemoryDigester(async (scopes) => {
    const memory = ctx.get('memory') as MemoryWithInject | undefined
    if (!memory?.list) return []
    return memory.list({
      ...(scopes !== undefined ? { scopes: [...scopes] } : {}),
      limit: 200,
    })
  })

  // 系统提示:记忆使用策略(常驻) + 硬性规则(kind='rule')。
  // 两者都用函数形式,面板开关/规则改动下一步就生效;文本稳定时可随前缀缓存。
  ctx.inject(['systemPrompt'], (scoped: Context) => {
    const systemPrompt = (scoped as { systemPrompt?: { section(section: unknown): unknown } }).systemPrompt
    if (!systemPrompt?.section) return
    try {
      systemPrompt.section({
        name: 'memory:policy',
        order: 650,
        text: () => (enabled && settingsOf().policy.enabled ? POLICY_TEXT : ''),
      })
      systemPrompt.section({
        name: 'memory:rules',
        order: 660,
        text: (context: { agent?: unknown }) => {
          if (!enabled || !settingsOf().rules.enabled) return ''
          const memory = ctx.get('memory') as MemoryWithInject | undefined
          if (!memory?.listSync) return ''
          let scopes: string[] = ['global']
          try {
            scopes = (memory.resolveReadScopes?.(context?.agent) as string[] | undefined) ?? ['global']
          } catch { scopes = ['global'] }
          try {
            return renderRulesBlock(memory.listSync({ scopes, kind: 'rule', limit: 100 }), settingsOf().rules) ?? ''
          } catch {
            return ''
          }
        },
      })
    } catch {
      /* 重复注册或老宿主没有 section 契约:规则段缺席不影响注入 */
    }
  })

  // 轮末提醒:本轮跑过多步(不是闲聊),下一轮第一步附带一句提醒。
  let maxStep = 0
  let pendingNudge = false
  ctx.on('agent/turn-stopping', () => {
    if (!enabled || !settingsOf().turnEnd.enabled) return
    if (maxStep >= 2) pendingNudge = true
  })

  ctx.on('agent/pre-step', async (input, next) => {
    // Runs outermost (prepend), so `next()` yields the fully assembled decision.
    const decision = await next()
    // A rejected step must pass through untouched — never rebuild the decision.
    if (!decision || decision.kind === 'reject' || input.signal?.aborted) return decision
    // optional capability: absence (or partial load) → pass through untouched
    const memory = ctx.get('memory') as MemoryWithInject | undefined
    if (!memory) return decision

    const agent = (input as { agent?: unknown }).agent
    const step = (input as { step?: number }).step ?? 1
    if (step === 1) maxStep = 0
    maxStep = Math.max(maxStep, step)

    // 会话上下文只在 pre-step 里拿得到:交给 search 的 `scopes`,与 memory_search 的
    // 默认合并集合用同一套解析(provider 的 resolveReadScopes)。
    const scopes = readScopesFor(memory, agent)

    // 摘要(每个会话一次)、召回(每轮有新内容时)、轮末提醒(下一轮首步)合成
    // 同一条消息:内容没变就什么都不加,避免一步两张卡片。
    const settings = enabled ? settingsOf() : undefined
    const parts: string[] = []
    // 规则增量:别的会话新加/改过的规则,在本轮第一步给旧会话补一次。
    // `delta !== false` 而不是 `=== true`:老 provider 的 settings 快照没有这个
    // 字段时要按"开"处理,否则升级当天等于静默关掉。
    if (settings && step === 1 && settings.rules.enabled && settings.rules.delta !== false) {
      const delta = ruleDeltaText(agent, memory, settings.rules)
      if (delta) parts.push(delta)
    }
    if (pendingNudge && step === 1) {
      pendingNudge = false
      parts.push(NUDGE_TEXT)
    }
    if (settings) {
      if (settings.digest.enabled) {
        const digest = await digester.maybeDigest(sessionIdOf(agent), scopes, (records) =>
          renderDigestBlock(records, settings.digest)?.text ?? null)
        if (digest) parts.push(digest)
      }
      const recall = await injector.maybeInject(
        { messages: input.messages as never, signal: input.signal, ...(scopes !== undefined ? { scopes } : {}) },
        { messages: decision.messages as never },
      )
      if (recall) parts.push(recall)
    }

    const text = parts.join('\n\n')
    if (!text) return decision
    // 幂等:同一段内容已经在 decision 里(另一个激活实例放进去的),不再追加。
    // 宿主把 entry 应用两次时,两个注入器会各自注入一条逐字相同的消息。
    if (hasRecallMessage(decision.messages as never, text)) return decision
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