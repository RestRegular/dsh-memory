/**
 * 规则增量(0.9.x):旧会话继续聊之前,把「这个会话还没见过 / 已经被改过」的
 * 硬性规则补一条消息。
 *
 * 为什么光刷新系统提示不够:规则段每步都会按 store 快照重渲染,但那条更新只改
 * 系统提示文本、不产生任何对话消息 —— 模型在旧会话里接着聊时不会主动重读;
 * 而且规则段有 token 预算,新规则还可能被更重要的旧规则挤出常驻段。
 *
 * 去重口径(0.9.2 起按"上一轮开始时的规则快照"而不是"历史里出现过的文本"):
 *  - 每条规则按 id 记住上一轮开始时的渲染行;
 *  - 新增规则 → 提醒;编辑过(同一 id 的行变了)→ 提醒,即使系统提示在这一轮里
 *    已经刷新成新文本(否则"编辑后重新插入"会被系统提示的刷新吞掉);
 *  - 没变化的规则 → 不重复;编辑回旧文本算"变了",也会提醒一次。
 *  - 宿主重启 / 首次见到这个会话时没有快照,用历史(系统提示 + 历史增量块)里
 *    已经出现的规则行做种子 —— 旧会话不会因为重启被整批重提醒。
 *
 * 这里只做"读会话派生历史 + 算差集 + 渲染",宿主差异(拿不到 session / 拿不到
 * listSync)一律降级为不提醒 —— 注入路径抛错会打断整个 agent 循环。
 */
                                              
import {
  latestSystemText,
  renderRulesDeltaBlock,
  ruleLine,
  seenRuleLines,
                          
} from './rules.js'
import { sessionIdOf } from './inject.js'
                                                                              

/** 宿主 Session 上我们用到的那一小部分(派生历史是 surface 节点的缓存投影)。 */
                                       
                            
 

/** provider 在增量侧需要的能力(缺一个就走"不提醒")。 */
                                   
                                             
                                                                                        
 

/** 每个会话最多记多少个规则快照(进程里开过的会话上界,防止 Map 无限长)。 */
const MAX_TRACKED_SESSIONS = 500

/** 会话的模型可见历史;老宿主 / 半个加载失败时返回 undefined。 */
export function derivedHistoryOf(agent         )                                   {
  try {
    const session = (agent                                                  )?.session
    const derive = session?.deriveMessages
    if (typeof derive !== 'function') return undefined
    const history = derive.call(session)
    return Array.isArray(history) ? (history                        ) : undefined
  } catch {
    return undefined
  }
}

/**
 * 规则增量注入器。一个激活一个实例:它要跨轮记住"每条规则上一轮开始时长什么样",
 * 才能在规则被编辑后补一次、在没变时不重复。
 */
export class RulesDeltaInjector {
  /** sessionId -> (规则 id -> 上一轮开始时的渲染行) */
                   baselines = new Map                             ()

  /**
   * 本轮第一步的增量正文;没有新增/变更(或这是会话的第一步)时返回 undefined。
   *
   * 规则范围与系统提示「硬性规则」段一致(`resolveReadScopes`,拿不到就 global),
   * 免得提醒了本来就不该进常驻段的规则。只在一轮的第一步调用:增量消息会持久化,
   * 每一步都算会重复;新会话(还没有系统提示)直接跳过 —— 系统提示这次就带全。
   */
  maybeInject(agent         , memory                  , cfg               )                     {
    const history = derivedHistoryOf(agent)
    if (history === undefined || latestSystemText(history) === undefined) return undefined
    let scopes           = ['global']
    try {
      const resolved = memory.resolveReadScopes?.(agent)
      if (Array.isArray(resolved) && resolved.length > 0) scopes = resolved            
    } catch { scopes = ['global'] }
    let records                
    try {
      records = memory.listSync?.({ scopes, kind: 'rule', limit: 100 }) ?? []
    } catch {
      return undefined
    }

    const sessionId = sessionIdOf(agent)
    const seen = seenRuleLines(history)
    const baseline = (sessionId === undefined ? undefined : this.baselines.get(sessionId)) ?? seedBaseline(records, seen)
    const unseen = records.filter((record) => {
      const line = ruleLine(record)
      const before = baseline.get(record.id)
      // 编辑过(同一 id 的行变了)一定要提醒;新规则只在模型还没在历史里见过时才提醒。
      return before !== undefined ? before !== line : !seen.has(line)
    })

    if (sessionId !== undefined) this.remember(sessionId, records)
    return renderRulesDeltaBlock(unseen, cfg) ?? undefined
  }

          remember(sessionId        , records                         )       {
    const snapshot = new Map                ()
    for (const record of records) snapshot.set(record.id, ruleLine(record))
    this.baselines.delete(sessionId)
    this.baselines.set(sessionId, snapshot)
    if (this.baselines.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.baselines.keys().next()
      if (!oldest.done) this.baselines.delete(oldest.value)
    }
  }
}

/**
 * 没有跨轮快照时的种子:历史里已经出现过的规则行当作"上一轮就是这样"。
 * 拿不到 id → 只能按行回填,规则行一致就不会提醒。
 */
function seedBaseline(records                         , seen                     )                      {
  const baseline = new Map                ()
  for (const record of records) {
    const line = ruleLine(record)
    if (seen.has(line)) baseline.set(record.id, line)
  }
  return baseline
}


//# sourceURL=source/memory-inject/src/rules-delta.ts