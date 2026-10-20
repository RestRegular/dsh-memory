/**
 * 硬性规则段:来自 kind='rule' 的记忆,进系统提示常驻段。
 *
 * 为什么放系统提示而不是每轮消息:规则要"一直在场",但每轮复制会膨胀并稀释
 * 注意力;系统提示是每步都会看见的位置,且文本稳定时可以跟着前缀缓存。
 * 只放"不可机械校验"的规则 —— 能写成检查的规则应该进钩子(代码强制)。
 *
 * 增量提醒(0.9.0):系统提示段每步都会按内存快照重渲染,但"规则是别的会话里
 * 新加的"这件事只改文本、不产生任何对话消息;模型在旧会话里继续聊时未必会
 * 重新读一遍系统提示,而且规则段有 token 预算,新规则可能被旧规则挤出常驻段。
 * 所以 apply.ts 在每轮第一步把「这个会话还没见过的规则行」补成一条消息。
 * 这里只放纯函数:渲染、从系统提示/历史消息里抽取规则行、算差集。
 */
                                              
import { estimateTokens } from '../provider/rerank.js'
                                                                              

export const RULES_HEADER =
  '以下是必须遵守的硬性规则（来自 kind=rule 的长期记忆；除非用户明确要求破例，否则按它做）：'

export const RULES_DELTA_HEADER =
  '以下是新增或变更的硬性规则（来自 kind=rule 的长期记忆；从现在起按它做）：'

/**
 * 一条规则的渲染行。常驻段与增量块共用同一个格式 —— 增量靠"逐行比对"判断
 * 会话是否已经见过某条规则,两边只要有一个字符不同就会重复提醒。
 */
export function ruleLine(record              )         {
  return `- ${record.content.replace(/\s+/g, ' ').slice(0, 240)}`
}

/** 规则排序:重要度优先,其次新的在前,最后按内容稳定排序(两个实例结果一致)。 */
export function orderRules(records                         )                 {
  return [...records].sort(
    (a, b) =>
      b.importance - a.importance ||
      b.updatedAt - a.updatedAt ||
      a.content.localeCompare(b.content),
  )
}

function renderLines(records                         , header        , cfg               , budget        )                {
  let tokens = estimateTokens(header) + 4
  const lines           = []
  for (const record of orderRules(records).slice(0, cfg.maxItems)) {
    const line = ruleLine(record)
    const cost = estimateTokens(line) + 1
    if (tokens + cost > budget) break
    lines.push(line)
    tokens += cost
  }
  if (lines.length === 0) return null
  return `${header}\n${lines.join('\n')}`
}

/** 渲染规则段(系统提示常驻)。重要性优先,新的在前;每条截 240 字,超出预算截断。 */
export function renderRulesBlock(records                         , cfg               )                {
  return renderLines(records, RULES_HEADER, cfg, cfg.tokenBudget)
}

/**
 * 渲染"新增/变更的规则"块。预算比常驻段留宽一点:增量块本来就是常驻段装不下
 * 时才需要的补充,用同一个 300 token 的上限容易把最该提醒的一条又截掉。
 */
export function renderRulesDeltaBlock(records                         , cfg               )                {
  return renderLines(records, RULES_DELTA_HEADER, cfg, Math.max(cfg.tokenBudget, 600))
}

/** 模型可见历史里的一小部分形状(只读;不依赖宿主的 Message 类型)。 */
                                     
              
                                                         
                            
 

/** 一条消息的纯文本(多个 text 块用换行连接)。 */
export function messageText(message                    )         {
  return (message.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text          )
    .join('\n')
}

/**
 * 从一段提示文本里抽出以 `header` 开头的段。段与段之间用一个空行分隔,
 * 段内的行都是单行(渲染时已把空白折叠成空格)。
 */
export function extractSection(text        , header        )                     {
  const at = text.indexOf(header)
  if (at < 0) return undefined
  const rest = text.slice(at + header.length)
  const end = rest.indexOf('\n\n')
  return end < 0 ? rest : rest.slice(0, end)
}

/** 段里的条目行(以 `- ` 开头、已 trim 的行)。 */
export function sectionLines(section                    )           {
  if (!section) return []
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
}

/** 模型可见历史里最新的那条非空系统提示(宿主可能在历史里追加多个系统节点)。 */
export function latestSystemText(history                               )                     {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]
    if (message?.role !== 'system') continue
    const text = messageText(message)
    if (text.length > 0) return text
  }
  return undefined
}

/**
 * 这个会话"已经看见过"的规则行 = 最新系统提示里的规则段
 * ∪ 历史上注入过的增量块(同一条规则只会提醒一次,重启宿主也不会重复)。
 */
export function seenRuleLines(history                               )              {
  const seen = new Set        ()
  const systemText = latestSystemText(history)
  if (systemText !== undefined) {
    for (const line of sectionLines(extractSection(systemText, RULES_HEADER))) seen.add(line)
  }
  for (const message of history) {
    if (message.role !== 'user' || message.source?.kind !== 'memory') continue
    for (const line of sectionLines(extractSection(messageText(message), RULES_DELTA_HEADER))) seen.add(line)
  }
  return seen
}

/** 还没在这个会话里出现过的规则(按常驻段同一套行格式比对)。 */
export function unseenRules(records                         , seen                     )                 {
  return records.filter((record) => !seen.has(ruleLine(record)))
}


//# sourceURL=source/memory-inject/src/rules.ts