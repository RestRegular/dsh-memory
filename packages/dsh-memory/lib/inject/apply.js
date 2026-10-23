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
                                              
import { join } from 'node:path'
import {
  MemoryDigester,
  MemoryInjector,
  autoRecallScopes,
  hasRecallMessage,
  normalizeExtraScopes,
  pickQueryText,
  resolveInjectScopes,
  sessionIdOf,
                    
                           
                           
                       
} from './inject.js'
import { renderDigest,                  } from './digest.js'
import { renderProcedureIndex } from './procedures.js'
import { renderRules,                  } from './rules.js'
import { RulesDeltaInjector } from './rules-delta.js'
import { POLICY_TEXT } from './policy.js'
import { InjectionState } from './state.js'
import { createSessionStateStore } from './session-state-store.js'
import {
  InjectAuditStore,
  auditBudget,
  hashAuditText,
  sanitizeAuditTags,
  sanitizeAuditText,
                    
                  
                 
} from './audit.js'
import {
  BehaviorSignalStore,
  assistantVisibleText,
  commandText,
  detectPhase,
  failureSignal,
  goalText,
  highRiskSignal,
  memoryGetRequestsContent,
  memoryGetResultIds,
  textTagSignal,
  todoText,
  toolCallDescription,
  toolResultFailure,
                      
} from './signals.js'
import { normalizeInjectSettings,                     } from '../provider/inject-settings.js'
import { canonicalWorkspacePath } from '../provider/scope.js'

                                     
                   
                      
               
                        
                                                                    
                       
     
                 
                                                              
     
                  
                     
                                                            
                
                            
                       
                            
                       
                                    
                     
   
 

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
  /** memory_get 调用 → 这次是否取正文；tool/result 到达后用来写 content_injected。 */
  const memoryGetCalls = new Map                 ()
  const sessionScopes = new Map                  ()
  const sessionAutoScopes = new Map                  ()
  /** 本轮已经发生过的 signal 驱动召回:每轮最多一次,同 tag/query 也跳过。 */
  const signalRecallTurn = new Map                                                                    ()
  const tagCache = new Map                                        ()
  /** 系统提示 rules 段的同源渲染缓存：pre-step 算一次，section 回调复用。 */
  const rulesCache = new Map                                                               ()
  /** 流程索引的匹配上下文:最近一次用户消息 + 最近调用过的工具名。 */
  const procedureQuery = new Map                ()
  const procedureTools = new Map                  ()
  const rulesStepStart = new Map                ()
  let systemPromptReady = false
  let attachedMemory          = null

  // ---- 去重状态持久化:<workspace>/.dsh/dsh-memory/sessions/<session>.jsonl ----
  const stateConfig = config.sessionState ?? {}
  const stateEnabled = stateConfig.enabled !== false
  let stateWarned = false
  /** attach 之后同步给摘要器补「已做过」标记（digester 在更后面创建）。 */
  let onStateAttached                                           

  /** pre-step 的 agent / session/event 的 session 都能取到 header.cwd。 */
  const workspaceOf = (value         )                     => {
    const nested = (value                                                            )?.session?.header?.cwd
    if (typeof nested === 'string' && nested.trim() !== '') return nested
    const direct = (value                                              )?.header?.cwd
    return typeof direct === 'string' && direct.trim() !== '' ? direct : undefined
  }

  /** 第一次接触某个会话时挂上它的持久化 store;拿不到 cwd 就只走内存。 */
  const attachSessionState = (sessionId                    , workspace                    )       => {
    if (sessionId === undefined || !stateEnabled || injectionState.hasStore(sessionId)) return
    let root = ''
    try {
      root = stateConfig.dir !== undefined && stateConfig.dir !== ''
        ? stateConfig.dir
        : workspace !== undefined ? join(canonicalWorkspacePath(workspace), '.dsh', 'dsh-memory') : ''
    } catch { root = '' }
    if (root === '') return
    try {
      injectionState.attach(sessionId, createSessionStateStore({
        root,
        sessionId,
        ...(stateConfig.debounceMs !== undefined ? { debounceMs: stateConfig.debounceMs } : {}),
        ...(stateConfig.maxAgeDays !== undefined ? { maxAgeDays: stateConfig.maxAgeDays } : {}),
        ...(stateConfig.maxFiles !== undefined ? { maxFiles: stateConfig.maxFiles } : {}),
      }))
      onStateAttached?.(sessionId)
    } catch (error) {
      if (stateWarned) return
      stateWarned = true
      console.warn(`[dsh-memory] 初始化会话去重状态失败: ${error instanceof Error ? error.message : String(error)}；本次退化为内存去重`)
    }
  }

  const attachAudit = (memory         )       => {
    const target = memory                                
    if (!target || target === attachedMemory || typeof target.attachInjectAudit !== 'function') return
    try {
      target.attachInjectAudit(audit)
      attachedMemory = target
    } catch { /* 审计是可选增强 */ }
  }

  // 插件半边卸载时解绑并释放内存；provider 若已切换到新实例，detachInjectAudit
  // 会按 sink 身份判断，不会误清掉后来者的 sink。
  try {
    ctx.effect(() => () => {
      const memory = ctx.get('memory')                                
      try {
        if (typeof memory?.detachInjectAudit === 'function') memory.detachInjectAudit(audit)
        else memory?.attachInjectAudit?.(null)
      } catch { /* 解绑失败不影响卸载 */ }
      attachedMemory = null
      audit.dispose()
      // 卸载前把会话去重状态的待写增量刷掉；失败只告警，不影响卸载。
      injectionState.dispose()
    }, 'dsh-memory: audit sink')
  } catch { /* 老宿主没有 ctx.effect */ }

  const recordAudit = (entry            )       => {
    audit.record(entry)
  }

  /** 系统提示 rules 段实际使用的 scope（与 section 回调保持同一口径）。 */
  const promptScopesFor = (memory                  , agent         )           => {
    try {
      const resolved = memory.resolveReadScopes?.(agent)                        
      if (Array.isArray(resolved) && resolved.length > 0) return resolved
    } catch { /* fallthrough */ }
    return ['global']
  }

  const sameScopes = (a                   , b                   )          =>
    a.length === b.length && a.every((scope, index) => scope === b[index])

  const renderRulesFor = (
    memory                  ,
    scopes                   ,
    cfg                         ,
  )                                                                       => {
    try {
      return { ok: true, render: renderRules(memory.listSync?.({ scopes: [...scopes], kind: 'rule', limit: 100 }) ?? [], cfg) }
    } catch {
      return { ok: false, errorCode: 'source_load_failed' }
    }
  }

  const rememberCallMeta = (callId         , name        , description         )       => {
    if (typeof callId !== 'string' || callId === '') return
    callMeta.set(callId, { name, ...(description !== undefined ? { description } : {}) })
    if (callMeta.size > 500) {
      const oldest = callMeta.keys().next()
      if (!oldest.done) callMeta.delete(oldest.value)
    }
  }

  /** 记住这次 memory_get 是否取正文；结果到达后无论 autoRecall 开关都会用到。 */
  const rememberMemoryGetCall = (callId         , content         )       => {
    if (typeof callId !== 'string' || callId === '') return
    memoryGetCalls.set(callId, content)
    if (memoryGetCalls.size > 500) {
      const oldest = memoryGetCalls.keys().next()
      if (!oldest.done) memoryGetCalls.delete(oldest.value)
    }
  }

  /**
   * memory_get 已把正文放进当前上下文 → 记为 content_injected，后续 recall/digest
   * 的同一条记忆会被会话级去重跳过。只取 summary / tags / 元数据时不标记。
   */
  const markMemoryGetContent = (sessionId        , memory                  , event         )       => {
    try {
      const ids = memoryGetResultIds(event)
      if (ids.length === 0 || typeof memory.getByIds !== 'function') return
      const found = memory.getByIds(ids)
      if (found.length === 0) return
      injectionState.markContent(sessionId, found.map((record) => ({ id: record.id, updatedAt: record.updatedAt })))
    } catch { /* 去重状态是尽力而为，不能影响工具结果 */ }
  }

  /** 记录本会话最近用过的工具名,给流程索引做触发词匹配。 */
  const rememberProcedureTool = (sessionId        , tool        )       => {
    const recent = procedureTools.get(sessionId) ?? []
    if (recent[recent.length - 1] === tool) return
    recent.push(tool)
    if (recent.length > 12) recent.shift()
    procedureTools.set(sessionId, recent)
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

  /** 自动召回专用范围:只保留 global + 当前会话 + 当前工作区。 */
  const autoScopesForSession = (
    sessionId        ,
    memory                                 ,
    session         ,
    fallback                   ,
  )                       => {
    const known = sessionAutoScopes.get(sessionId)
    if (known !== undefined) return known
    let resolved                      
    try {
      resolved = memory?.resolveReadScopes?.({ session })                        
    } catch { resolved = undefined }
    const scopes = autoRecallScopes(resolved ?? fallback)
    if (scopes !== undefined) sessionAutoScopes.set(sessionId, scopes)
    return scopes
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

  const observeSignal = (
    sessionId        ,
    signal                            ,
    context                                   = {},
  )       => {
    if (!signal || !signals.note(sessionId, signal)) return
    const query = sanitizeAuditText(signal.query)
    recordAudit({
      kind: 'signal',
      channel: 'signal',
      stage: 'signal_queued',
      outcome: 'success',
      reasonCode: 'queued',
      sessionId,
      trigger: signal.reason,
      phase: signal.phase,
      ...(context.turn !== undefined ? { turn: context.turn } : {}),
      ...(context.step !== undefined ? { step: context.step } : {}),
      ...(signal.callId !== undefined ? { operationId: signal.callId } : {}),
      ...(query !== undefined ? { query } : {}),
      signal: {
        key: signal.key,
        reason: signal.reason,
        ...(signal.errorClass ? { errorClass: signal.errorClass } : {}),
        ...(signal.tool ? { tool: signal.tool } : {}),
        ...(signal.tag ? { tag: signal.tag } : {}),
        ...(signal.source ? { source: signal.source } : {}),
        ...(signal.callId !== undefined ? { callId: signal.callId } : {}),
      },
    })
  }

  /** 记忆工具自身的调用:不属于注入评估,但它是审计里最有用的轨迹锚点。 */
  const MEMORY_TOOL_NAMES = new Set(['memory_save', 'memory_search', 'memory_forget', 'memory_list', 'memory_get'])
  const rememberMemoryToolCall = (
    sessionId        ,
    data                         ,
  )       => {
    const callId = typeof data.callId === 'string' ? data.callId : undefined
    const tool = typeof data.name === 'string' ? data.name : undefined
    if (callId === undefined || tool === undefined || !MEMORY_TOOL_NAMES.has(tool)) return
    const turn = typeof data.turn === 'number' ? data.turn : undefined
    const step = typeof data.step === 'number' ? data.step : undefined
    recordAudit({
      kind: 'signal',
      channel: 'signal',
      stage: 'tool_call',
      outcome: 'success',
      reasonCode: 'memory_tool',
      trigger: 'memory_tool',
      sessionId,
      operationId: callId,
      ...(turn !== undefined ? { turn } : {}),
      ...(step !== undefined ? { step } : {}),
      signal: { key: callId, reason: 'memory_tool', tool, source: 'tool', callId },
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
  // 持久化状态恢复后，把「摘要已做过」同步给摘要器，避免插件重载后重复注入。
  onStateAttached = (sessionId) => {
    if (injectionState.digestDoneOf(sessionId)) digester.seedDone(sessionId)
  }

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
        // 先挂持久化 store：compaction 的 clear 要能删到对应文件。
        attachSessionState(sessionId, workspaceOf(session))

        // 记忆工具调用先落一条锚点审计：即使自动召回关闭、或该工具没有命中
        // 任何触发标签，用户也能从审计面板/记忆视图精确跳回轨迹里的那一次调用。
        if (type === 'tool/call') rememberMemoryToolCall(sessionId, data)

        if (type === 'compaction/start' || type === 'compaction/end') {
          // 上下文重建:旧去重状态不再可信,允许摘要/正文重新进入。
          // 审计也要留下分界，否则压缩前后的记录会被误读成同一段上下文。
          recordAudit({
            kind: 'lifecycle', channel: 'lifecycle', stage: 'compaction',
            outcome: 'success', reasonCode: 'context_compacted', sessionId,
          })
          injectionState.clear(sessionId)
          signals.clear(sessionId)
          signalRecallTurn.delete(sessionId)
          digester.reset(sessionId)
          sessionScopes.delete(sessionId)
          sessionAutoScopes.delete(sessionId)
          rulesCache.delete(sessionId)
          rulesStepStart.delete(sessionId)
          procedureQuery.delete(sessionId)
          procedureTools.delete(sessionId)
          for (const key of tagCache.keys()) if (key.startsWith(`${sessionId}|`)) tagCache.delete(key)
          callMeta.clear()
          memoryGetCalls.clear()
          return
        }

        // memory_get 的正文去重必须独立于 autoRecall 开关：哪怕行为信号召回关着，
        // 普通每轮召回 / 摘要仍会注入同一段正文。这里在 autoRecall 闸门前记录。
        if (type === 'tool/call' && data.name === 'memory_get') {
          rememberMemoryGetCall(data.callId, memoryGetRequestsContent(data.arguments))
        } else if (type === 'tool/result') {
          const callId = (data.message                                                 )?.source?.callId
          if (typeof callId === 'string') {
            const takesContent = memoryGetCalls.get(callId)
            memoryGetCalls.delete(callId)
            if (takesContent === true && memory !== undefined && !toolResultFailure(event).isError) {
              markMemoryGetContent(sessionId, memory, event)
            }
          }
        }
        const settings = enabled ? settingsOf() : undefined
        const auto = settings?.autoRecall
        if (!auto?.enabled) return
        const allScopes = scopesForSession(sessionId, memory                       , session)
        const scopes = autoScopesForSession(sessionId, memory, session, allScopes)
        if (scopes === undefined) return
        const tags = triggerTags(memory                                   , sessionId, scopes, auto)

        if (type === 'tool/call') {
          const tool = typeof data.name === 'string' ? data.name : 'tool'
          rememberProcedureTool(sessionId, tool)
          const callId = typeof data.callId === 'string' ? data.callId : undefined
          const args = typeof data.arguments === 'string'
            ? data.arguments
            : (() => { try { return JSON.stringify(data.arguments ?? '') } catch { return '' } })()
          // 工具调用必须有显式的 description 才允许触发高风险召回：
          // 没有 description 的工具（memory_search、memory_*、以及其它不带该字段的
          // 工具）不应该因为参数/工具名里恰好出现标签就再注入一次记忆——尤其
          // memory_search 本身就是取记忆，再触发一次会把摘要/正文重复塞进上下文。
          const rawDescription = toolCallDescription(data.arguments)
          const description = auto.useToolDescription ? rawDescription : undefined
          rememberCallMeta(data.callId, tool, description)
          const turn = typeof data.turn === 'number' ? data.turn : undefined
          const step = typeof data.step === 'number' ? data.step : undefined
          if (!MEMORY_TOOL_NAMES.has(tool) && rawDescription !== undefined && rawDescription !== '') {
            observeSignal(sessionId, highRiskSignal(tool, args, {
              tags,
              ...(description !== undefined ? { description } : {}),
              ...(callId !== undefined ? { callId } : {}),
              useToolDescription: auto.useToolDescription,
              maxQueryChars: auto.maxQueryChars,
            }), {
              ...(turn !== undefined ? { turn } : {}),
              ...(step !== undefined ? { step } : {}),
            })
          }
          return
        }
        if (type === 'tool/result') {
          const failure = toolResultFailure(event)
          if (!failure.isError) return
          const message = data.message                                                 
          const callId = message?.source?.callId
          const meta = typeof callId === 'string' ? callMeta.get(callId) : undefined
          const description = auto.useToolDescription ? meta?.description : undefined
          const turn = typeof data.turn === 'number' ? data.turn : undefined
          const step = typeof data.step === 'number' ? data.step : undefined
          observeSignal(sessionId, failureSignal(meta?.name, failure.code, failure.message, {
            ...(description !== undefined ? { description } : {}),
            ...(typeof callId === 'string' ? { callId } : {}),
            maxQueryChars: auto.maxQueryChars,
          }), {
            ...(turn !== undefined ? { turn } : {}),
            ...(step !== undefined ? { step } : {}),
          })
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
          const scopes = promptScopesFor(memory, context?.agent)
          const sessionId = sessionIdOf(context?.agent)
          const started = sessionId === undefined ? undefined : rulesStepStart.get(sessionId)
          const cached = sessionId === undefined ? undefined : rulesCache.get(sessionId)
          // pre-step 已经算过同一份渲染时直接复用：审计与系统提示必须是同一份文本。
          if (cached !== undefined && started !== undefined && cached.at >= started && sameScopes(cached.scopes, scopes)) {
            return cached.render.text
          }
          const rendered = renderRulesFor(memory, scopes, settingsOf().rules)
          if (!rendered.ok) return ''
          if (sessionId !== undefined) rulesCache.set(sessionId, { at: Date.now(), scopes, render: rendered.render })
          return rendered.render.text
        },
      })
      systemPrompt.section({
        name: 'memory:procedures',
        order: 655,
        text: (context                     ) => {
          if (!enabled || !settingsOf().procedures.enabled) return ''
          const memory = ctx.get('memory')                                
          if (!memory?.listSync) return ''
          const scopes = promptScopesFor(memory, context?.agent)
          const sessionId = sessionIdOf(context?.agent)
          let records                 = []
          try {
            records = memory.listSync({ scopes: [...scopes], kind: 'procedure', limit: 200 })
          } catch {
            return ''
          }
          const rendered = renderProcedureIndex(records, settingsOf().procedures, {
            ...(sessionId !== undefined && procedureQuery.has(sessionId) ? { query: procedureQuery.get(sessionId) } : {}),
            ...(sessionId !== undefined && procedureTools.has(sessionId) ? { tools: procedureTools.get(sessionId) } : {}),
            projectScopes: scopes.filter((scope) => scope.startsWith('project:')),
          })
          return rendered?.text ?? ''
        },
      })
      systemPromptReady = true
    } catch {
      /* 重复注册或老宿主没有 section 契约:规则段缺席不影响注入 */
      systemPromptReady = false
    }
  })

  // 轮末提醒:本轮跑过多步(不是闲聊),下一轮第一步附带一句提醒。
  let maxStep = 0
  let pendingNudge = false
  ctx.on('agent/turn-stopping', () => {
    // 轮末把待写的去重增量刷掉：即使下一轮开始前进程退出，状态也只丢一个窗口。
    injectionState.flushAll()
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
    const turnValue = (input                      ).turn
    const turn = typeof turnValue === 'number' && Number.isFinite(turnValue) ? turnValue : undefined
    const stepStartedAt = Date.now()
    if (step === 1) maxStep = 0
    maxStep = Math.max(maxStep, step)

    const sessionId = sessionIdOf(agent)
    // 第一步接触会话时恢复持久化去重状态（读盘只发生一次）。
    attachSessionState(sessionId, workspaceOf(agent))
    if (sessionId !== undefined) rulesStepStart.set(sessionId, stepStartedAt)
    const scopes = readScopesFor(memory, agent)
    if (sessionId !== undefined && scopes !== undefined) sessionScopes.set(sessionId, [...scopes])
    let autoScopes                      
    try { autoScopes = autoRecallScopes(memory.resolveReadScopes?.(agent)                        ) } catch { autoScopes = undefined }
    if (autoScopes === undefined) autoScopes = autoRecallScopes(scopes)
    if (sessionId !== undefined && autoScopes !== undefined) sessionAutoScopes.set(sessionId, [...autoScopes])
    const exclude = excludedIds(memory, scopes)
    const excludeAuto = excludedIds(memory, autoScopes)
    const signal = sessionId === undefined ? undefined : signals.take(sessionId)
    let usableSignal = autoScopes === undefined ? undefined : signal
    const turnKey = turn ?? step
    const userQuery = pickQueryText(input.messages         )
    if (sessionId !== undefined && userQuery !== '') procedureQuery.set(sessionId, userQuery)
    const phase = detectPhase(userQuery)
    const userQueryField = sanitizeAuditText(userQuery)
    const auditBase = (channel              , extra            )             => ({
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(turn !== undefined ? { turn } : {}),
      ...(step !== undefined ? { step } : {}),
      phase,
      channel,
      ...extra,
    })

    if (!enabled) {
      if (step === 1) {
        recordAudit(auditBase('lifecycle', {
          kind: 'lifecycle', stage: 'disabled', outcome: 'skipped', reasonCode: 'injection_disabled',
        }))
      }
      return decision
    }
    const settings = settingsOf()

    // 每轮最多一次 signal 驱动召回:一轮里的第二个信号不再强制检索。
    // 同 tag / 同 query 的重复信号单独给出更精确的审计原因。
    let signalDropReason                    
    if (usableSignal !== undefined && sessionId !== undefined) {
      const used = signalRecallTurn.get(sessionId)
      if (used !== undefined && used.turn === turnKey) {
        signalDropReason = used.tag !== undefined && usableSignal.tag !== undefined && used.tag === usableSignal.tag
          ? 'same_tag'
          : used.query === usableSignal.query ? 'same_query' : 'turn_capped'
        usableSignal = undefined
      }
    }

    // 本步的评估先收集，等最终消息组装/校验完成后再统一写 evaluation + delivery。
    // 这样可以准确表达“评估选中了 X”与“消息真的追加了吗”两件不同的事。
    const staged               = []
    const parts           = []
    const messageChannels = new Set              ()
    const stage = (entry            )       => { staged.push(entry) }

    if (signal !== undefined && usableSignal === undefined) {
      recordAudit(auditBase('signal', {
        kind: 'signal', stage: 'signal_dropped', outcome: 'skipped',
        reasonCode: signalDropReason ?? 'auto_scope_unavailable',
        trigger: signal.reason, phase: signal.phase,
        ...(signal.callId !== undefined ? { operationId: signal.callId } : {}),
        signal: {
          key: signal.key,
          reason: signal.reason,
          ...(signal.tag ? { tag: signal.tag } : {}),
          ...(signal.tool ? { tool: signal.tool } : {}),
          ...(signal.callId !== undefined ? { callId: signal.callId } : {}),
        },
      }))
    }
    if (usableSignal !== undefined) {
      recordAudit(auditBase('signal', {
        kind: 'signal', stage: 'signal_consumed', outcome: 'success', reasonCode: 'consumed',
        trigger: usableSignal.reason, phase: usableSignal.phase,
        ...(usableSignal.callId !== undefined ? { operationId: usableSignal.callId } : {}),
        signal: {
          key: usableSignal.key,
          reason: usableSignal.reason,
          ...(usableSignal.tag ? { tag: usableSignal.tag } : {}),
          ...(usableSignal.tool ? { tool: usableSignal.tool } : {}),
          ...(usableSignal.errorClass ? { errorClass: usableSignal.errorClass } : {}),
          ...(usableSignal.source ? { source: usableSignal.source } : {}),
          ...(usableSignal.callId !== undefined ? { callId: usableSignal.callId } : {}),
        },
      }))
    }

    // 规则增量:别的会话新加/改过的规则,在本轮第一步给旧会话补一次。
    // `delta !== false` 而不是 `=== true`:老 provider 的 settings 快照没有这个
    // 字段时要按"开"处理,否则升级当天等于静默关掉。
    if (step === 1 && settings.rules.enabled) {
      if (settings.rules.delta === false) {
        stage(auditBase('rules_delta', {
          kind: 'evaluation', stage: 'skipped', outcome: 'skipped', reasonCode: 'disabled',
        }))
      } else {
        const delta = rulesDelta.maybeInjectDetailed(agent, memory, settings.rules)
        if (delta.text !== undefined) {
          parts.push(delta.text)
          messageChannels.add('rules_delta')
          if (sessionId !== undefined && delta.injectedEntries !== undefined) {
            injectionState.markContent(sessionId, delta.injectedEntries)
          }
          stage(auditBase('rules_delta', {
            kind: 'evaluation', stage: 'rendered', outcome: 'success', reasonCode: 'delta_rendered',
            selected: { contentIds: delta.changes.map((change) => change.id), hintIds: [], count: delta.records.length },
            budgets: { rules_delta: auditBudget(Math.max(settings.rules.tokenBudget, 600), delta.tokens ?? 0) },
            limits: { maxItems: settings.rules.maxItems, budgets: { rules: settings.rules.tokenBudget } },
          }))
        } else {
          stage(auditBase('rules_delta', {
            kind: 'evaluation', stage: 'skipped', outcome: 'skipped',
            reasonCode: delta.changes.length === 0 ? 'no_changes' : 'nothing_to_render',
          }))
        }
      }
    }

    // 轮末提醒:下一轮第一步附带一句提醒。
    if (step === 1) {
      if (!settings.turnEnd.enabled) {
        stage(auditBase('nudge', { kind: 'evaluation', stage: 'skipped', outcome: 'skipped', reasonCode: 'disabled' }))
      } else if (pendingNudge) {
        pendingNudge = false
        parts.push(NUDGE_TEXT)
        messageChannels.add('nudge')
        stage(auditBase('nudge', {
          kind: 'evaluation', stage: 'rendered', outcome: 'success', reasonCode: 'turn_end',
          delivery: { status: 'unknown', appended: null, textChars: NUDGE_TEXT.length, textHash: hashAuditText(NUDGE_TEXT) },
        }))
      } else {
        stage(auditBase('nudge', { kind: 'evaluation', stage: 'skipped', outcome: 'skipped', reasonCode: 'not_due' }))
      }
    }

    // 摘要（每个会话一次）。
    if (settings.digest.enabled) {
      let digestStats                         
      const outcome = await digester.maybeDigestOutcome(sessionId, scopes, (records) => {
        const rendered = renderDigest(records, settings.digest)
        digestStats = rendered?.stats
        return rendered
      })
      // 失败也记 done（与内存行为一致：摘要不逐轮重试）；落盘后重载不再重复发。
      if (sessionId !== undefined && outcome.status !== 'skipped') injectionState.markDigestDone(sessionId)
      if (outcome.status === 'failed') {
        stage(auditBase('digest', {
          kind: 'evaluation', stage: 'source_load', outcome: 'failed', reasonCode: outcome.errorCode,
          trigger: 'turn_start',
          sourceLoad: { ok: false, errorCode: outcome.errorCode },
          error: { stage: 'source_load', code: outcome.errorCode },
        }))
      } else if (outcome.status === 'ok' && outcome.empty) {
        stage(auditBase('digest', {
          kind: 'evaluation', stage: 'source_load', outcome: 'skipped', reasonCode: 'no_candidates',
          trigger: 'turn_start',
          candidates: outcome.candidates,
          sourceLoad: { ok: true, count: outcome.candidates },
          limits: { topK: settings.digest.topK, budgets: { digest: settings.digest.tokenBudget, hints: settings.digest.hintBudget } },
        }))
      } else if (outcome.status === 'ok' && outcome.value !== undefined && digestStats !== undefined) {
        if (sessionId !== undefined) {
          injectionState.markContent(sessionId, digestStats.bodyEntries)
          injectionState.markHint(sessionId, digestStats.hintEntries)
        }
        parts.push(outcome.value.text)
        messageChannels.add('digest')
        stage(auditBase('digest', {
          kind: 'evaluation', stage: 'rendered', outcome: digestStats.omitted.length > 0 ? 'partial' : 'success',
          reasonCode: digestStats.omitted.length > 0 ? 'rendered_partial' : 'rendered',
          trigger: 'turn_start',
          candidates: digestStats.candidates,
          selected: {
            contentIds: digestStats.bodyIds,
            hintIds: digestStats.hintIds,
            count: digestStats.bodyIds.length,
          },
          omitted: digestStats.omitted.map((entry) => ({
            id: entry.id,
            reason: entry.reason,
            ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
            ...(entry.tags !== undefined ? { tags: sanitizeAuditTags(entry.tags) } : {}),
          })),
          budgets: {
            digest: auditBudget(settings.digest.tokenBudget, outcome.value.tokens),
            hints: auditBudget(settings.digest.hintBudget, digestStats.hint.tokens),
          },
          sourceLoad: { ok: true, count: digestStats.candidates },
          limits: { topK: settings.digest.topK, budgets: { digest: settings.digest.tokenBudget, hints: settings.digest.hintBudget } },
          scopes: scopes !== undefined ? [...scopes] : undefined,
        }))
      }
    } else if (step === 1) {
      stage(auditBase('digest', { kind: 'evaluation', stage: 'skipped', outcome: 'skipped', reasonCode: 'disabled' }))
    }

    // 规则段：只做一次渲染，并把同一份结果交给系统提示（若宿主先跑 pre-step 再 assemble）。
    if (step === 1) {
      if (!settings.rules.enabled) {
        stage(auditBase('rules', { kind: 'evaluation', stage: 'skipped', outcome: 'skipped', reasonCode: 'disabled' }))
      } else if (!systemPromptReady) {
        stage(auditBase('rules', { kind: 'evaluation', stage: 'skipped', outcome: 'skipped', reasonCode: 'system_prompt_unavailable' }))
      } else {
        const promptScopes = promptScopesFor(memory, agent)
        const rendered = renderRulesFor(memory, promptScopes, settings.rules)
        if (!rendered.ok) {
          stage(auditBase('rules', {
            kind: 'evaluation', stage: 'source_load', outcome: 'failed', reasonCode: rendered.errorCode,
            scopes: promptScopes,
            error: { stage: 'source_load', code: rendered.errorCode },
          }))
        } else {
          if (sessionId !== undefined) rulesCache.set(sessionId, { at: Date.now(), scopes: promptScopes, render: rendered.render })
          // 规则正文已经进入系统提示常驻段；写进会话注入状态后,recall 不会再
          // 把同一条规则当"新记忆"重复塞进对话消息。
          if (sessionId !== undefined && rendered.render.stats.injectedEntries.length > 0) {
            injectionState.markContent(sessionId, rendered.render.stats.injectedEntries)
          }
          const rulesStats = rendered.render.stats
          const rulesOutcome = rulesStats.candidates === 0 ? 'skipped' : rulesStats.injected === 0 ? 'partial' : 'success'
          const rulesReason = rulesStats.candidates === 0 ? 'no_candidates' : rulesStats.injected === 0 ? 'all_omitted' : 'system_prompt_shared_render'
          stage(auditBase('rules', {
            kind: 'evaluation', stage: 'rendered', outcome: rulesOutcome, reasonCode: rulesReason,
            scopes: promptScopes,
            candidates: rulesStats.candidates,
            selected: {
              contentIds: rulesStats.injectedIds,
              hintIds: [],
              count: rulesStats.injected,
            },
            omitted: rulesStats.omitted.map((entry) => ({ id: entry.id, reason: entry.reason })),
            budgets: { rules: auditBudget(settings.rules.tokenBudget, rendered.render.tokens) },
            limits: { maxItems: settings.rules.maxItems, budgets: { rules: settings.rules.tokenBudget } },
            rules: {
              active: rulesStats.active,
              injected: rulesStats.injected,
              mandatory: rulesStats.mandatory,
              mandatoryInjected: rulesStats.mandatoryInjected,
              mandatoryOmitted: rulesStats.mandatoryOmitted,
              injectedIds: rulesStats.injectedIds,
              omittedIds: rulesStats.omittedIds,
            },
            delivery: { status: 'unknown', appended: null, textChars: rendered.render.text.length, textHash: hashAuditText(rendered.render.text) },
          }))
        }
      }
    }

    // 策略段是常量系统提示；只记录它存在，不声称“模型读了”。
    if (step === 1) {
      if (settings.policy.enabled) {
        stage(auditBase('policy', {
          kind: 'evaluation', stage: 'system_prompt', outcome: 'success', reasonCode: 'constant_text',
          delivery: { status: 'unknown', appended: null, textChars: POLICY_TEXT.length, textHash: hashAuditText(POLICY_TEXT) },
        }))
      } else {
        stage(auditBase('policy', { kind: 'evaluation', stage: 'skipped', outcome: 'skipped', reasonCode: 'disabled' }))
      }
    }

    // 行为信号优先:发布/推送/失败事件触发定向查询;没有信号才走普通用户消息召回。
    // 同一轮普通 query 已处理过时跳过重复检索(去重状态仍会兜底)。
    const skipNormalRecall = usableSignal === undefined && step > 1 && sessionId !== undefined
      && userQuery !== '' && injectionState.lastQueryOf(sessionId) === userQuery
    if (!settings.recall.enabled) {
      if (step === 1) {
        stage(auditBase('recall', {
          kind: 'evaluation', stage: 'skipped', outcome: 'skipped', reasonCode: 'disabled',
          ...(userQueryField !== undefined ? { query: userQueryField } : {}),
        }))
      }
    } else if (usableSignal === undefined && userQuery === '') {
      stage(auditBase('recall', {
        kind: 'evaluation', stage: 'skipped', outcome: 'skipped', reasonCode: 'no_query',
      }))
    } else if (skipNormalRecall) {
      stage(auditBase('recall', {
        kind: 'evaluation', stage: 'skipped', outcome: 'skipped', reasonCode: 'same_query_dedup',
        ...(userQueryField !== undefined ? { query: userQueryField } : {}),
      }))
    } else {
      const recallScopes = usableSignal === undefined ? scopes : autoScopes
      const recallExclude = usableSignal === undefined ? exclude : excludeAuto
      if (usableSignal !== undefined && sessionId !== undefined) {
        signalRecallTurn.set(sessionId, {
          turn: turnKey,
          key: usableSignal.key,
          ...(usableSignal.tag !== undefined ? { tag: usableSignal.tag } : {}),
          query: usableSignal.query,
        })
      }
      const recall = await injector.maybeInjectDetailed(
        { messages: input.messages         , signal: input.signal, ...(recallScopes !== undefined ? { scopes: recallScopes } : {}), ...(sessionId !== undefined ? { sessionId } : {}) },
        { messages: decision.messages          },
        {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(usableSignal !== undefined ? { query: usableSignal.query, trigger: usableSignal.reason, force: true } : { trigger: 'turn_start' }),
          ...(usableSignal?.tag ? { tag: usableSignal.tag, requireTag: true } : {}),
          excludeIds: recallExclude,
        },
      )
      if (recall?.text) {
        parts.push(recall.text)
        messageChannels.add('recall')
      }
      if (recall !== undefined) {
        const queryField = sanitizeAuditText(recall.query)
        const omitted = recall.omitted.map((entry) => ({ id: entry.id, reason: entry.reason }))
        const failed = !recall.retrieval.ok
        const outcome = failed ? 'failed'
          : recall.text !== undefined ? (omitted.length > 0 ? 'partial' : 'success')
            : omitted.length > 0 ? 'partial' : 'skipped'
        const reasonCode = failed ? 'retrieval_failed'
          : recall.text !== undefined ? (omitted.length > 0 ? 'injected_partial' : 'injected')
            : omitted.length > 0 ? 'all_omitted'
              : recall.dedupSkipped > 0 ? 'deduped'
                : 'no_candidates'
        stage(auditBase('recall', {
          kind: 'evaluation', stage: 'searched', outcome, reasonCode,
          trigger: usableSignal?.reason ?? 'turn_start',
          ...(usableSignal !== undefined ? { phase: usableSignal.phase } : {}),
          ...(usableSignal?.callId !== undefined ? { operationId: usableSignal.callId } : {}),
          ...(queryField !== undefined ? { query: queryField } : {}),
          candidates: recall.candidates,
          filter: {
            rawHits: recall.rawHits ?? recall.retrieval.count,
            tagFiltered: recall.tagFiltered ?? 0,
            supersededExcluded: recall.supersededExcluded ?? 0,
            candidates: recall.candidates,
          },
          selected: {
            contentIds: recall.ids,
            hintIds: [],
            newlyAddedIds: recall.newlyAddedIds ?? [],
            count: recall.ids.length,
          },
          omitted,
          dedup: {
            skipped: recall.dedupSkipped,
            updated: recall.updated.length,
            lastTextSame: recall.lastTextSame === true,
            ...(recall.dedupIds !== undefined ? { ids: recall.dedupIds } : {}),
          },
          budgets: { recall: auditBudget(settings.recall.tokenBudget, recall.tokens) },
          retrieval: {
            ok: recall.retrieval.ok,
            count: recall.retrieval.count,
            ...(recall.retrieval.errorCode !== undefined ? { errorCode: recall.retrieval.errorCode } : {}),
          },
          ...(recallScopes !== undefined ? { scopes: [...recallScopes] } : {}),
          limits: { topK: settings.recall.topK, maxQueryChars: settings.autoRecall.maxQueryChars },
          ...(usableSignal !== undefined
            ? { signal: { key: usableSignal.key, reason: usableSignal.reason, ...(usableSignal.errorClass ? { errorClass: usableSignal.errorClass } : {}), ...(usableSignal.tool ? { tool: usableSignal.tool } : {}), ...(usableSignal.tag ? { tag: usableSignal.tag } : {}), ...(usableSignal.source ? { source: usableSignal.source } : {}), ...(usableSignal.callId ? { callId: usableSignal.callId } : {}) } }
            : {}),
        }))
      }
    }

    const text = parts.join('\n\n')
    const channels = [...messageChannels]
    const writeDelivery = (status                                                                      , appended                , suppressedBy                                  )       => {
      for (const entry of staged) audit.record(entry)
      if (staged.length === 0 && text === '') return
      const outcome = status === 'appended' ? 'success'
        : status === 'rejected' ? 'failed'
          : status === 'unknown' ? 'unknown' : 'skipped'
      recordAudit({
        ...(sessionId !== undefined ? { sessionId } : {}),
        step,
        kind: 'delivery',
        channel: 'lifecycle',
        stage: status === 'unknown' ? 'delivery_prepared' : 'delivery',
        outcome,
        reasonCode: status === 'appended' ? 'appended'
          : status === 'suppressed' ? 'duplicate_message'
            : status === 'rejected' ? 'malformed_message'
              : status === 'unknown' ? 'prepared' : 'empty',
        ...(channels.length > 0 ? { channels } : {}),
        delivery: {
          status,
          appended,
          ...(suppressedBy !== undefined ? { suppressedBy } : {}),
          ...(text !== '' ? { textChars: text.length, textHash: hashAuditText(text) } : {}),
        },
      })
    }

    if (!text) {
      writeDelivery('not_attempted', false, 'empty')
      return decision
    }
    // 幂等:同一段内容已经在 decision 里(另一个激活实例放进去的),不再追加。
    // 宿主把 entry 应用两次时,两个注入器会各自注入一条逐字相同的消息。
    if (hasRecallMessage(decision.messages         , text)) {
      writeDelivery('suppressed', false, 'dedup')
      return decision
    }
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'memory', form: 'recall' },
    })
    // Last-resort guard: a malformed message aborts the whole turn downstream
    // (consumers read message.source.kind), so never publish one.
    if (!isWellFormedMessage(message)) {
      writeDelivery('rejected', false, 'malformed')
      return decision
    }
    // 宿主没有向 middleware 回执“消息已被接受”：这里只能证明已通过本地保护并
    // 放进 decision，不能证明宿主最终采纳。按方案口径记 unknown，不乐观推断 appended。
    writeDelivery('unknown', null)
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