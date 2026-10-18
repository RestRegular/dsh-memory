/**
 * 会话摘要(L1):会话第一步给一次"这个项目/全局已经记了什么"的全景。
 *
 * 与逐轮召回的分工:召回按这一轮的问题找;摘要不按问题,按重要度 × 新鲜度
 * 挑几条,让模型一开始就知道有哪些旧结论可复用,而不是先搜一遍。
 */
                                              
import { estimateTokens } from '../provider/rerank.js'
                                                                               

const HEADER =
  '以下是本项目 / 全局已有的长期记忆摘要（按重要度挑出的前几条；' +
  '需要原文用 memory_search，删除用 memory_forget）：'

/** scope 的中文标签:global/项目/会话/自定义。 */
export function digestScopeLabel(scope        )         {
  if (scope === 'global') return '全局'
  if (scope === 'project' || scope.startsWith('project:')) return '项目'
  if (scope === 'session' || scope.startsWith('session:')) return '会话'
  return scope
}

/**
 * 摘要排序:与淘汰规则同一套"新鲜度(30 天半衰期)× 重要度",并列时按作用域
 * 优先级(会话 > 项目 > 自定义 > 全局),最后按内容稳定排序 —— 同样的输入必须
 * 给出同样的摘要,否则两个注入实例的内容会对不上。
 */
export function rankForDigest(records                         , now = Date.now())                 {
  const weight = (scope        )         => {
    if (scope.startsWith('session:')) return 3
    if (scope.startsWith('project:')) return 2
    if (scope === 'global') return 0
    return 1
  }
  return [...records].sort((a, b) => {
    const ra = Math.pow(0.5, Math.max(0, now - a.updatedAt) / 86_400_000 / 30) * (0.1 + a.importance)
    const rb = Math.pow(0.5, Math.max(0, now - b.updatedAt) / 86_400_000 / 30) * (0.1 + b.importance)
    if (rb !== ra) return rb - ra
    const wa = weight(a.scope)
    const wb = weight(b.scope)
    if (wa !== wb) return wb - wa
    return a.content.localeCompare(b.content)
  })
}

/** 渲染摘要块;没有记录返回 null,每条截 160 字,在预算内贪心填充。 */
export function renderDigestBlock(
  records                         ,
  cfg                ,
)                                                         {
  if (records.length === 0) return null
  let tokens = estimateTokens(HEADER) + 4
  const lines           = []
  for (const record of rankForDigest(records).slice(0, cfg.topK)) {
    const line = `- ${record.id.slice(0, 8)} [${digestScopeLabel(record.scope)}/${record.kind}] ${record.content.replace(/\s+/g, ' ').slice(0, 160)}`
    const cost = estimateTokens(line) + 1
    if (tokens + cost > cfg.tokenBudget) break
    lines.push(line)
    tokens += cost
  }
  if (lines.length === 0) return null
  return { text: `${HEADER}\n${lines.join('\n')}`, tokens, count: lines.length }
}

//# sourceURL=source/memory-inject/src/digest.ts