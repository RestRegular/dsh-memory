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
                                                  
import { createUserMessage } from '@deepseek-ai/dsh-llm'
                                              
import {
  MemoryDigester,
  MemoryInjector,
  hasRecallMessage,
  normalizeExtraScopes,
  pickQueryText,
  resolveInjectScopes,
  sessionIdOf,
                    
                           
                           
                       
} from './inject.js'
import { renderDigest,                  } from './digest.js'
import { renderRules, renderRulesBlock } from './rules.js'
import { RulesDeltaInjector } from './rules-delta.js'
import { POLICY_TEXT } from './policy.js'
import { InjectionState } from './state.js'
import { InjectAuditStore, auditBudget, auditQuery,                            } from './audit.js'
import {
  BehaviorSignalStore,
  assistantVisibleText,
  commandText,
  detectPhase,
  failureSignal,
  goalText,
  highRiskSignal,
  textTagSignal,
  todoText,
  toolCallDescription,
  toolResultFailure,
                      
} from './signals.js'
import { normalizeInjectSettings,                     } from '../provider/inject-settings.js'

                                     
                   
                      
               
                        
                                                                    
                       
 

/** provider 在注入侧能提供的那部分能力(多余的方法都用可选判断)。 */
                                                        
                                                                                                                     
                                   
                                                                       
 

/** 轮末提醒的文案:短、祈使句,不占预算。 */
const NUDGE_TEXT =
  '上一轮若产生了可复用的结论（决策、踩坑、流程、口径），先 memory_save 记一条再继续；' +
  '没有就忽略这条提醒。'

export const name = 'dsh-memory-inject'

export function apply(ctx         , config                     = {}) {
  // 配置只作为兜底;provider 的 settings.json(面板可改)优先。
  const fallback = normalizeInjectSettings(config)
  const enabled = config.enabled !== false

  const settingsOf = ()                 => {
    const memory = ctx.get('memory')                                
    try {
      const live = memory?.injectSettings?.()
      if (live) return live
    } catch { /* 拿不到就用配置里的 */ }
    return fallback
  }

  const recallCfg = ()               => {
    const settings = settingsOf().recall
    return { enabled: enabled && settings.enabled, topK: settings.topK, tokenBudget: settings.tokenBudget }
  }
  const impressionCfg = ()                      => {
    const settings = settingsOf().impression
    return { impression: settings.enabled, chars: settings.chars }
  }

  const extraScopes = normalizeExtraScopes(config.extraScopes ?? [])
  const readScopesFor = (memory                     , agent         )                       =>
    resolveInjectScopes(memory, agent, extraScopes, ctx.get?.('sessions')                               )

  /** 会话级注入状态(正文/标签/版本)与审计。 */
  const injectionState = new InjectionState()
  const audit = new InjectAuditStore()
  const signals = new BehaviorSignalStore()
  const callMeta = new Map                                                ()
  const sessionScopes = new Map                  ()
  const tagCache = new Map                                        ()
  let attachedMemory          = null

  const attachAudit = (memory         )       => {
    const target = memory                                
    if (!target || target === attachedMemory || typeof target.attachInjectAudit !== 'function') return
    try {
      target.attachInjectAudit(audit)
      attachedMemory = target
    } catch { /* 审计是可选增强 */ }
  }

  const recordAudit = (entry                                   )       => {
    audit.record({ at: Date.now(), ...entry })
  }

  const rememberCallMeta = (callId         , name        , description         )       => {
    if (typeof callId !== 'string' || callId === '') return
    callMeta.set(callId, { name, ...(description !== undefined ? { description } : {}) })
    if (callMeta.size > 500) {
      const oldest = callMeta.keys().next()
      if (!oldest.done) callMeta.delete(oldest.value)
    }
  }

  const excludedIds = (memory                     , scopes                               )                      => {
    try {
      return new Set(memory.supersededIds?.(scopes === undefined ? undefined : [...scopes]) ?? [])
    } catch {
      return new Set()
    }
  }

  // One injector per activation: its repeat-suppression state must live across
  // the steps of a turn (a per-step instance would re-inject every step).
  const scopesForSession = (sessionId        , memory                     , session         )           => {
    const known = sessionScopes.get(sessionId)
    if (known !== undefined) return known
    try {
      const resolved = memory.resolveReadScopes?.({ session })                        
      if (Array.isArray(resolved)) {
        sessionScopes.set(sessionId, resolved)
        return resolved
      }
    } catch { /* 拿不到就用空集合;下次 pre-step 会补 */ }
    return []
  }

  /**
   * 触发词 = 设置里的额外标签 ∪ 当前记忆库里已有的标签(可关)。
   * 后者让“记忆标签”本身成为触发词,不需要用户把每个标签抄进设置。
   * listSync 只读内存快照;30 秒缓存避免每条 assistant 消息都扫一遍。
   */
  const triggerTags = (
    memory                                 ,
    sessionId        ,
    scopes                   ,
    auto                              ,
  )           => {
    const configured = auto.tags
    if (!auto.useMemoryTags || !memory?.listSync) return configured
    const cacheKey = `${sessionId}|${scopes.join('|')}`
    const now = Date.now()
    const cached = tagCache.get(cacheKey)
    if (cached !== undefined && now - cached.at < 30_000) return cached.tags
    const tags           = []
    const seen = new Set        ()
    const add = (tag        )       => {
      const value = tag.trim()
      const key = value.toLowerCase()
      if (value === '' || seen.has(key)) return
      seen.add(key)
      tags.push(value)
    }
    for (const tag of configured) add(tag)
    try {
      const records = memory.listSync({ scopes: [...scopes], limit: 1000 })
      for (const record of records) for (const tag of record.tags ?? []) add(String(tag))
    } catch { /* 读不到记忆标签就只用配置标签 */ }
    const limited = tags.slice(0, 200)
    tagCache.set(cacheKey, { at: now, tags: limited })
    if (tagCache.size > 200) {
      const oldest = tagCache.keys().next()
      if (!oldest.done) tagCache.delete(oldest.value)
    }
    return limited
  }

  const observeSignal = (sessionId        , signal                            )       => {
    if (!signal || !signals.note(sessionId, signal)) return
    recordAudit({
      sessionId,
      trigger: signal.reason,
      phase: signal.phase,
      query: signal.query,
      candidates: 0, contentIds: [], hintIds: [], omitted: [], dedupSkipped: 0, budgets: {},
      retrieval: { ok: true, count: 0 },
      signal: {
        reason: signal.reason,
        ...(signal.errorClass ? { errorClass: signal.errorClass } : {}),
        ...(signal.tool ? { tool: signal.tool } : {}),
        ...(signal.tag ? { tag: signal.tag } : {}),
        ...(signal.source ? { source: signal.source } : {}),
      },
    })
  }

  const injector = new MemoryInjector(
    async (query, signal, scopes) => {
      const memory = ctx.get('memory')                                
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
    const memory = ctx.get('memory')                                
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
    ctx.on('session/event', (session         , event         ) => {
      try {
        const sessionId = (session                                )?.id
        if (typeof sessionId !== 'string' || sessionId === '') return
        const type = (event                                  )?.type
        const data = (event                                                  )?.data ?? {}
        const memory = ctx.get('memory')                                
        if (memory) attachAudit(memory)

        if (type === 'compaction/start' || type === 'compaction/end') {
          // 上下文重建:旧去重状态不再可信,允许摘要/正文重新进入。
          injectionState.clear(sessionId)
          signals.clear(sessionId)
          digester.reset(sessionId)
          sessionScopes.delete(sessionId)
          for (const key of tagCache.keys()) if (key.startsWith(`${sessionId}|`)) tagCache.delete(key)
          callMeta.clear()
          return
        }
        const settings = enabled ? settingsOf() : undefined
        const auto = settings?.autoRecall
        if (!auto?.enabled) return
        const scopes = scopesForSession(sessionId, memory                       , session)
        const tags = triggerTags(memory                                   , sessionId, scopes, auto)

        if (type === 'tool/call') {
          const tool = typeof data.name === 'string' ? data.name : 'tool'
          const args = typeof data.arguments === 'string'
            ? data.arguments
            : (() => { try { return JSON.stringify(data.arguments ?? '') } catch { return '' } })()
          const description = auto.useToolDescription ? toolCallDescription(data.arguments) : undefined
          rememberCallMeta(data.callId, tool, description)
          observeSignal(sessionId, highRiskSignal(tool, args, {
            tags,
            ...(description !== undefined ? { description } : {}),
            useToolDescription: auto.useToolDescription,
            maxQueryChars: auto.maxQueryChars,
          }))
          return
        }
        if (type === 'tool/result') {
          const failure = toolResultFailure(event)
          if (!failure.isError) return
          const message = data.message                                                 
          const callId = message?.source?.callId
          const meta = typeof callId === 'string' ? callMeta.get(callId) : undefined
          const description = auto.useToolDescription ? meta?.description : undefined
          observeSignal(sessionId, failureSignal(meta?.name, failure.code, failure.message, {
            ...(description !== undefined ? { description } : {}),
            maxQueryChars: auto.maxQueryChars,
          }))
          return
        }
        // 可见 assistant 输出 / 任务清单 / 命令 / goal:命中记忆标签就排队一次召回。
        // 只读 text 块,不读 reasoning/隐藏思维链。
        if (type === 'assistant/message' || type === 'todo/write' || type === 'command/run' || type === 'goal/change') {
          const text = type === 'assistant/message' ? assistantVisibleText(event)
            : type === 'todo/write' ? todoText(event)
              : type === 'command/run' ? commandText(event)
                : goalText(event)
          const source = type === 'assistant/message' ? 'assistant'
            : type === 'todo/write' ? 'todo'
              : type === 'command/run' ? 'command' : 'goal'
          observeSignal(sessionId, text === undefined ? undefined : textTagSignal(text, {
            tags,
            source,
            maxQueryChars: auto.maxQueryChars,
          }))
          return
        }
      } catch { /* 观察者失败绝不影响会话事件发布 */ }
    })
  } catch { /* 老宿主没有 session/event:行为召回自动缺席 */ }

  // 系统提示:记忆使用策略(常驻) + 硬性规则(kind='rule')。
  // 两者都用函数形式,面板开关/规则改动下一步就生效;文本稳定时可随前缀缓存。
  ctx.inject(['systemPrompt'], (scoped         ) => {
    const systemPrompt = (scoped                                                             ).systemPrompt
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
        text: (context                     ) => {
          if (!enabled || !settingsOf().rules.enabled) return ''
          const memory = ctx.get('memory')                                
          if (!memory?.listSync) return ''
          let scopes           = ['global']
          try {
            scopes = (memory.resolveReadScopes?.(context?.agent)                        ) ?? ['global']
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
    const memory = ctx.get('memory')                                
    if (!memory) return decision
    attachAudit(memory)

    const agent = (input                       ).agent
    const step = (input                     ).step ?? 1
    if (step === 1) maxStep = 0
    maxStep = Math.max(maxStep, step)

    const sessionId = sessionIdOf(agent)
    const scopes = readScopesFor(memory, agent)
    if (sessionId !== undefined && scopes !== undefined) sessionScopes.set(sessionId, [...scopes])
    const exclude = excludedIds(memory, scopes)
    const signal = sessionId === undefined ? undefined : signals.take(sessionId)
    const userQuery = pickQueryText(input.messages         )

    // 摘要(每个会话一次)、召回(每轮有新内容时)、轮末提醒(下一轮首步)合成
    // 同一条消息:内容没变就什么都不加,避免一步两张卡片。
    const settings = enabled ? settingsOf() : undefined
    const parts           = []
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
        let digestStats                         
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
          { messages: input.messages         , signal: input.signal, ...(scopes !== undefined ? { scopes } : {}), ...(sessionId !== undefined ? { sessionId } : {}) },
          { messages: decision.messages          },
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
    if (hasRecallMessage(decision.messages         , text)) return decision
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


//# sourceURL=source/memory-inject/src/apply.ts