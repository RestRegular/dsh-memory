/**
 * 工具结果的纯文本渲染。刻意不 import cordis / defineTool：apply.ts 只负责把
 * scope 键翻译成人看的标签，其余格式都在这里，单测可以直接断言模型看到的文字。
 *
 * 0.16.0 起 memory_search 只给“印象”（id / 作用域 / 类型 / 标签 / 短摘要），
 * 正文走 memory_get；memory_get 的 fields 决定渲染哪些元数据。
 */
import type { GetField, GetResult, SearchResult } from './index.ts'

/** 把 scope 键渲染成展示文案（宿主能查到会话标题时用它，否则用短 id）。 */
export type ScopeLabel = (scope: string) => string

const shortId = (id: string): string => id.slice(0, 8)

const day = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString().slice(0, 10) : ''

const joinList = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).filter((v) => v !== '').join(', ') : ''

/** 「[得分] id (作用域/类型 · 标签) 摘要」；没有任何一条命中时给明确空结果。 */
export function renderSearchResult(value: SearchResult, label: ScopeLabel): string {
  if (value.records.length === 0) return '没有找到相关记忆。'
  return value.records.map((hit) => {
    const tags = joinList(hit.tags)
    const meta = `${label(hit.scope)}/${hit.kind}${tags === '' ? '' : ` · ${tags}`}`
    return `[${hit.score.toFixed(3)}] ${shortId(hit.id)} (${meta}) ${hit.summary}`
  }).join('\n')
}

/**
 * memory_get 的渲染：
 *   - 元数据按 fields 拼在首行括号里；
 *   - content 优先于 summary（两者都给时正文已经足够）；
 *   - 只取元数据时不输出正文行。
 */
export function renderGetResult(value: GetResult, label: ScopeLabel): string {
  const fields = new Set<GetField>(value.fields)
  const body = value.records.map((record) => {
    const meta: string[] = []
    const scope = typeof record.scope === 'string' ? record.scope : ''
    const kind = typeof record.kind === 'string' ? record.kind : ''
    if (fields.has('scope') && fields.has('kind')) meta.push(`${label(scope)}/${kind}`)
    else if (fields.has('scope')) meta.push(label(scope))
    else if (fields.has('kind')) meta.push(kind)
    if (fields.has('tags')) {
      const tags = joinList(record.tags)
      if (tags !== '') meta.push(`标签 ${tags}`)
    }
    if (fields.has('importance') && typeof record.importance === 'number') meta.push(`重要度 ${record.importance}`)
    if (fields.has('createdAt')) {
      const created = day(record.createdAt)
      if (created !== '') meta.push(`创建 ${created}`)
    }
    if (fields.has('updatedAt')) {
      const updated = day(record.updatedAt)
      if (updated !== '') meta.push(`更新 ${updated}`)
    }
    if (fields.has('expiresAt')) {
      const expires = day(record.expiresAt)
      if (expires !== '') meta.push(`过期 ${expires}`)
    }
    if (fields.has('triggers')) {
      const triggers = joinList(record.triggers)
      if (triggers !== '') meta.push(`触发词 ${triggers}`)
    }
    if (fields.has('supersedes') && typeof record.supersedes === 'string' && record.supersedes !== '') {
      meta.push(`修正 ${shortId(record.supersedes)}`)
    }
    const head = `[${record.id}]${meta.length > 0 ? ` (${meta.join(' · ')})` : ''}`
    const content = typeof record.content === 'string' ? record.content : undefined
    const summary = typeof record.summary === 'string' ? record.summary : undefined
    const text = content ?? (summary === undefined ? '' : `摘要：${summary}`)
    return text === '' ? head : `${head}\n${text}`
  }).join('\n\n')
  const missing = value.missing.length > 0 ? `未找到：${value.missing.join(', ')}` : ''
  if (body === '') return missing || '没有找到记忆。'
  return missing === '' ? body : `${body}\n\n${missing}`
}
