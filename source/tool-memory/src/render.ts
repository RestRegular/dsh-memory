/**
 * 工具结果的纯文本渲染。刻意不 import cordis / defineTool：apply.ts 只负责把
 * scope 键翻译成人看的标签，其余格式都在这里，单测可以直接断言模型看到的文字。
 *
 * 0.16.0 起 memory_search 只给“印象”（id / 作用域 / 类型 / 标签 / 短摘要），
 * 正文走 memory_get；memory_get 的 fields 决定渲染哪些元数据。
 *
 * 0.20.0：范围外命中被挡住时，把**真实原因**（用户拒绝 / 审批超时 / 无法审批）
 * 写进渲染文本。绝对限制下工具根本不会带 withheld（视为不存在），所以这里
 * 不需要也不应该提"被挡住"。
 */
import type { GetResult, GetField, SearchResult, WithheldReason } from './index.ts'

/** 把 scope 键渲染成展示文案（宿主能查到会话标题时用它，否则用短 id）。 */
export type ScopeLabel = (scope: string) => string

/** 有内容没返回时的原因（absolute 模式不会走到这里）。 */
export type WithheldInfo = { count: number; reason: WithheldReason }

const shortId = (id: string): string => id.slice(0, 8)

const day = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString().slice(0, 10) : ''

const joinList = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).filter((v) => v !== '').join(', ') : ''

/**
 * 范围外内容为什么没返回——给模型看的真实原因。
 * 空字符串 = 没有需要说明的（没有 withheld，或 absolute 模式下不告知）。
 */
export function renderWithheldNote(withheld: WithheldInfo | undefined): string {
  if (withheld === undefined || withheld.count <= 0) return ''
  const count = withheld.count
  switch (withheld.reason) {
    case 'rejected':
      return `另有 ${count} 条记忆在本会话的可见域外，用户拒绝了本次访问（限制等级：普通限制），未返回。如确实需要，请让用户调整「记忆范围」后重试。`
    case 'timeout':
      return `另有 ${count} 条记忆在本会话的可见域外，审批在 5 分钟内没有得到答复，已按拒绝处理，未返回。如确实需要，请让用户调整「记忆范围」后重试。`
    case 'unavailable':
      return `另有 ${count} 条记忆在本会话的可见域外，当前环境无法发起审批，未返回。`
    default:
      return ''
  }
}

/** 「[得分] id (作用域/类型 · 标签) 摘要」；没有任何一条命中时给明确空结果。 */
export function renderSearchResult(value: SearchResult, label: ScopeLabel): string {
  const note = renderWithheldNote(value.withheld)
  if (value.records.length === 0) {
    if (note === '') return '没有找到相关记忆。'
    return `没有找到可见范围内的相关记忆。\n${note}`
  }
  const body = value.records.map((hit) => {
    const tags = joinList(hit.tags)
    const meta = `${label(hit.scope)}/${hit.kind}${tags === '' ? '' : ` · ${tags}`}`
    return `[${hit.score.toFixed(3)}] ${shortId(hit.id)} (${meta}) ${hit.summary}`
  }).join('\n')
  return note === '' ? body : `${body}\n\n${note}`
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
  // 被可见域挡住的那几条:absolute 模式下 provider 不会给 withheld(视为不存在),
  // 其余情况把真实原因(拒绝 / 超时 / 无法审批)告诉模型。
  const note = renderWithheldNote(value.withheld)
  const tail = [missing, note].filter((part) => part !== '').join('\n\n')
  if (body === '') return tail === '' ? '没有找到记忆。' : tail
  return tail === '' ? body : `${body}\n\n${tail}`
}
