/**
 * 规则增量(0.9.0):旧会话继续聊之前,把「这个会话还没见过的硬性规则」补一条消息。
 *
 * 为什么光刷新系统提示不够:规则段每步都会按 store 快照重渲染,但那条更新只改
 * 系统提示文本、不产生任何对话消息 —— 模型在旧会话里接着聊时不会主动重读;
 * 而且规则段有 token 预算,新规则还可能被更重要的旧规则挤出常驻段。
 *
 * 这里只做"读会话派生历史 + 算差集 + 渲染",宿主差异(拿不到 session / 拿不到
 * listSync)一律降级为不提醒 —— 注入路径抛错会打断整个 agent 循环。
 */
                                              
import {
  latestSystemText,
  renderRulesDeltaBlock,
  seenRuleLines,
  unseenRules,
                          
} from './rules.js'
                                                                              

/** 宿主 Session 上我们用到的那一小部分(派生历史是 surface 节点的缓存投影)。 */
                                       
                            
 

/** provider 在增量侧需要的能力(缺一个就走"不提醒")。 */
                                   
                                             
                                                                                        
 

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
 * 增量块的正文;没有新增/变更(或这是会话的第一步)时返回 undefined。
 *
 * 规则范围与系统提示「硬性规则」段一致(`resolveReadScopes`,拿不到就 global),
 * 免得提醒了本来就不该进常驻段的规则。只在一轮的第一步调用:增量消息会持久化,
 * 每一步都算会重复;新会话(还没有系统提示)直接跳过 —— 系统提示这次就带全。
 */
export function ruleDeltaText(agent         , memory                  , cfg               )                     {
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
  return renderRulesDeltaBlock(unseenRules(records, seenRuleLines(history)), cfg) ?? undefined
}


//# sourceURL=source/memory-inject/src/rules-delta.ts