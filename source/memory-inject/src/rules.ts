/**
 * 硬性规则段:来自 kind='rule' 的记忆,进系统提示常驻段。
 *
 * 为什么放系统提示而不是每轮消息:规则要"一直在场",但每轮复制会膨胀并稀释
 * 注意力;系统提示是每步都会看见的位置,且文本稳定时可以跟着前缀缓存。
 * 只放"不可机械校验"的规则 —— 能写成检查的规则应该进钩子(代码强制)。
 */
import type { MemoryRecord } from 'dsh-memory'
import { estimateTokens } from '../../memory-local/src/rerank.ts'
import type { RulesSettings } from '../../memory-local/src/inject-settings.ts'

const HEADER = '以下是必须遵守的硬性规则（来自 kind=rule 的长期记忆；除非用户明确要求破例，否则按它做）：'

/** 渲染规则段。重要性优先,其次新的在前;每条截 240 字,超出预算截断。 */
export function renderRulesBlock(records: readonly MemoryRecord[], cfg: RulesSettings): string | null {
  if (records.length === 0) return null
  const ordered = [...records].sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt || a.content.localeCompare(b.content))
  let tokens = estimateTokens(HEADER) + 4
  const lines: string[] = []
  for (const record of ordered.slice(0, cfg.maxItems)) {
    const line = `- ${record.content.replace(/\s+/g, ' ').slice(0, 240)}`
    const cost = estimateTokens(line) + 1
    if (tokens + cost > cfg.tokenBudget) break
    lines.push(line)
    tokens += cost
  }
  if (lines.length === 0) return null
  return `${HEADER}\n${lines.join('\n')}`
}