/**
 * Cordis wiring for dsh-memory-inject. Loaded only inside DSH.
 *
 * 注入分四层,全部可以在面板「记忆 → 设置」里单独开关:
 *  1. recall     —— 每轮按查询召回(可有可无;内容没变就不重复注入)
 *  2. digest     —— 会话第一步给一次"已有记忆"的摘要 + 截断标签索引
 *  3. policy     —— 系统提示里的「记忆使用策略」常驻段
 *  4. rules      —— 系统提示里的「硬性规则」段(kind='rule' 的记忆)
 * 另有 rulesDelta —— 旧会话在下一轮补一条新增/变更的规则(0.9.0;随 rules 开关)
 * 另有 turnEnd —— 轮末提醒(下一轮开头提示"上一轮若有结论就记一条"),默认关。
 *
 * 0.9.6 起多了两条可验证的路径:
 *   - digest 的正文/标签/省略统计会写进 `InjectAuditStore`;
 *   - `session/event` 的 tool/call、tool/result、compaction 事件会生成行为信号,
 *     在下一个 pre-step 做一次增量自动召回(已注入正文按会话 + 记忆 id/版本去重)。
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
  pickQueryText,
  resolveInjectScopes,
  sessionIdOf,
  type InjectConfig,
  type InjectMemoryService,
  type RecallRenderOptions,
  type SessionRegistry,
} from './inject.ts'
import { renderDigest, type DigestStats } from './digest.ts'
import { renderRules, renderRulesBlock } from './rules.ts'
import { RulesDeltaInjector } from './rules-delta.ts'
import { POLICY_TEXT } from './policy.ts'
import { InjectionState } from './state.ts'
import { InjectAuditStore, auditBudget, auditQuery, type InjectAuditEvaluation } from './audit.ts'
import {
  BehaviorSignalStore,
  detectPhase,
  failureSignal,
  highRiskSignal,
  toolResultFailure,
  type BehaviorSignal,
} from './signals.ts'
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
  listSync?(input: { scopes?: string[]; kind?: string; limit?: number; includeSuperseded?: boolean }): MemoryRecord[]
  injectSettings?(): InjectSettings
  attachInjectAudit?(sink: { list(sessionId?: string): unknown }): void
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

  /** 会话级注入状态(正文/标签/版本)与审计。 */
  const injectionState = new InjectionState()
  const audit = new InjectAuditStore()
  const signals = new BehaviorSignalStore()
  const callNames = new Map<string, string>()
  let attachedMemory: unknown = null

  const attachAudit = (memory: unknown): void => {
    const target = memory as MemoryWithInject | undefined
    if (!target || target === attachedMemory || typeof target.attachInjectAudit !== 'function') return
    try {
      target.attachInjectAudit(audit)
      attachedMemory = target
    } catch { /* 审计是可选增强 */ }
  }

  const recordAudit = (entry: Omit<InjectAuditEvaluation, 'at'>): void => {
    audit.record({ at: Date.now(), ...entry })
  }

  const rememberCallName = (callId: unknown, name: string): void => {
    if (typeof callId !== 'string' || callId === '') return
    callNames.set(callId, name)
    if (callNames.size > 500) {
      const oldest = callNames.keys().next()
      if (!oldest.done) callNames.delete(oldest.value)
    }
  }

  const excludedIds = (memory: InjectMemoryService, scopes: readonly string[] | undefined): ReadonlySet<string> => {
    try {
      return new Set(memory.supersededIds?.(scopes === undefined ? undefined : [...scopes]) ?? [])
    } catch {
      return new Set()
    }
  }

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
    injectionState,
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

  // 规则增量:一个激活一个实例,跨轮记住每条规则上一轮的样子(编辑后才补提醒)。
  const rulesDelta = new RulesDeltaInjector()

  /**
   * 可观测行为信号 → 下一次 pre-step 的定向召回。
   * 只消费宿主公开的 session/event;不读取隐藏思维链,不记录工具原始参数。
   */
  try {
    ctx.on('session/event', (session: unknown, event: unknown) => {
      try {
        const sessionId = (session as { id?: unknown } | undefined)?.id
        if (typeof sessionId !== 'string' || sessionId === '') return
        const type = (event as { type?: unknown } | undefined)?.type
        const data = (event as { data?: Record<string, unknown> } | undefined)?.data ?? {}
        const memory = ctx.get('memory') as MemoryWithInject | undefined
        if (memory) attachAudit(memory)

        if (type === 'compaction/start' || type === 'compaction/end') {
          // 上下文重建:旧去重状态不再可信,允许摘要/正文重新进入。
          injectionState.clear(sessionId)
          signals.clear(sessionId)
          digester.reset(sessionId)
          callNames.clear()
          return
        }
        if (type === 'tool/call') {
          const tool = typeof data.name === 'string' ? data.name : 'tool'
          const args = typeof data.arguments === 'string' ? data.arguments : ''
          rememberCallName(data.callId, tool)
          const signal = highRiskSignal(tool, args)
          if (signal && signals.note(sessionId, signal)) {
            recordAudit({
              sessionId, trigger: signal.reason, phase: signal.phase, query: signal.query,
              candidates: 0, contentIds: [], hintIds: [], omitted: [], dedupSkipped: 0, budgets: {},
              retrieval: { ok: true, count: 0 }, signal: { reason: signal.reason, tool: signal.tool },
            })
          }
          return
        }
        if (type === 'tool/result') {
          const failure = toolResultFailure(event)
          if (!failure.isError) return
          const message = data.message as { source?: { callId?: unknown } } | undefined
          const callId = message?.source?.callId
          const tool = typeof callId === 'string' ? callNames.get(callId) : undefined
          const signal = failureSignal(tool, failure.code, failure.message)
          if (signals.note(sessionId, signal)) {
            recordAudit({
              sessionId, trigger: signal.reason, phase: signal.phase, query: signal.query,
              candidates: 0, contentIds: [], hintIds: [], omitted: [], dedupSkipped: 0, budgets: {},
              retrieval: { ok: true, count: 0 },
              signal: { reason: signal.reason, ...(signal.errorClass ? { errorClass: signal.errorClass } : {}), ...(signal.tool ? { tool: signal.tool } : {}) },
            })
          }
          return
        }
      } catch { /* 观察者失败绝不影响会话事件发布 */ }
    })
  } catch { /* 老宿主没有 session/event:行为召回自动缺席 */ }

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
    attachAudit(memory)

    const agent = (input as { agent?: unknown }).agent
    const step = (input as { step?: number }).step ?? 1
    if (step === 1) maxStep = 0
    maxStep = Math.max(maxStep, step)

    const sessionId = sessionIdOf(agent)
    const scopes = readScopesFor(memory, agent)
    const exclude = excludedIds(memory, scopes)
    const signal = sessionId === undefined ? undefined : signals.take(sessionId)
    const userQuery = pickQueryText(input.messages as never)

    // 摘要(每个会话一次)、召回(每轮有新内容时)、轮末提醒(下一轮首步)合成
    // 同一条消息:内容没变就什么都不加,避免一步两张卡片。
    const settings = enabled ? settingsOf() : undefined
    const parts: string[] = []
    // 规则增量:别的会话新加/改过的规则,在本轮第一步给旧会话补一次。
    // `delta !== false` 而不是 `=== true`:老 provider 的 settings 快照没有这个
    // 字段时要按"开"处理,否则升级当天等于静默关掉。
    if (settings && step === 1 && settings.rules.enabled && settings.rules.delta !== false) {
      const delta = rulesDelta.maybeInject(agent, memory, settings.rules)
      if (delta) parts.push(delta)
    }
    if (pendingNudge && step === 1) {
      pendingNudge = false
      parts.push(NUDGE_TEXT)
    }
    if (settings) {
      if (settings.digest.enabled) {
        let digestStats: DigestStats | undefined
        const digest = await digester.maybeDigestDetailed(sessionId, scopes, (records) => {
          const rendered = renderDigest(records, settings.digest)
          digestStats = rendered?.stats
          return rendered
        })
        if (digest) {
          if (sessionId !== undefined && digestStats !== undefined) {
            injectionState.markContent(sessionId, digestStats.bodyEntries)
            injectionState.markHint(sessionId, digestStats.hintEntries)
          }
          parts.push(digest.text)
          if (digestStats !== undefined) {
            recordAudit({
              ...(sessionId !== undefined ? { sessionId } : {}),
              trigger: 'turn_start', phase: 'unknown',
              candidates: digestStats.candidates,
              contentIds: digestStats.bodyIds,
              hintIds: digestStats.hintIds,
              omitted: digestStats.omitted.map((entry) => ({ id: entry.id, reason: entry.reason })),
              dedupSkipped: 0,
              budgets: {
                digest: auditBudget(settings.digest.tokenBudget, digest.tokens),
                hints: auditBudget(settings.digest.hintBudget, digestStats.hint.tokens),
              },
              retrieval: { ok: true, count: digestStats.candidates },
            })
          }
        }
      }

      // 规则段每步都会在系统提示里重渲染;只在第一步记录一次审计,避免 200 条缓冲被刷爆。
      if (step === 1 && settings.rules.enabled) {
        try {
          const rendered = renderRules(memory.listSync?.({ scopes, kind: 'rule', limit: 100 }) ?? [], settings.rules)
          if (rendered) {
            recordAudit({
              ...(sessionId !== undefined ? { sessionId } : {}),
              trigger: 'rules', phase: 'unknown',
              candidates: rendered.stats.candidates,
              contentIds: [], hintIds: [], omitted: [], dedupSkipped: 0,
              budgets: { rules: auditBudget(settings.rules.tokenBudget, rendered.tokens) },
              retrieval: { ok: true, count: rendered.stats.candidates },
              rules: {
                injected: rendered.stats.injected,
                omittedTopK: rendered.stats.omittedTopK,
                omittedBudget: rendered.stats.omittedBudget,
                omittedSuperseded: rendered.stats.omittedSuperseded,
                mandatory: rendered.stats.mandatory,
                mandatoryOmitted: rendered.stats.mandatoryOmitted,
              },
            })
          }
        } catch { /* 审计不是注入的前置条件 */ }
      }

      // 行为信号优先:发布/推送/失败事件触发定向查询;没有信号才走普通用户消息召回。
      // 同一轮普通 query 已处理过时跳过重复检索(去重状态仍会兜底)。
      const skipNormalRecall = signal === undefined && step > 1 && sessionId !== undefined
        && userQuery !== '' && injectionState.lastQueryOf(sessionId) === userQuery
      if (!skipNormalRecall) {
        const recall = await injector.maybeInjectDetailed(
          { messages: input.messages as never, signal: input.signal, ...(scopes !== undefined ? { scopes } : {}), ...(sessionId !== undefined ? { sessionId } : {}) },
          { messages: decision.messages as never },
          {
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(signal !== undefined ? { query: signal.query, trigger: signal.reason, force: true } : { trigger: 'turn_start' }),
            excludeIds: exclude,
          },
        )
        if (recall?.text) parts.push(recall.text)
        if (recall) {
          recordAudit({
            ...(sessionId !== undefined ? { sessionId } : {}),
            trigger: signal?.reason ?? 'turn_start',
            phase: signal?.phase ?? detectPhase(userQuery),
            ...(auditQuery(recall.query) !== undefined ? { query: auditQuery(recall.query) } : {}),
            candidates: recall.candidates,
            contentIds: recall.ids,
            hintIds: [],
            omitted: recall.omitted.map((entry) => ({ id: entry.id, reason: entry.reason })),
            dedupSkipped: recall.dedupSkipped,
            budgets: { recall: auditBudget(settings.recall.tokenBudget, recall.tokens) },
            retrieval: recall.retrieval,
            ...(signal !== undefined
              ? { signal: { reason: signal.reason, ...(signal.errorClass ? { errorClass: signal.errorClass } : {}), ...(signal.tool ? { tool: signal.tool } : {}) } }
              : {}),
          })
        }
      }
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
