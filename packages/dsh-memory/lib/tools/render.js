/**
 * 工具结果的纯文本渲染。刻意不 import cordis / defineTool：apply.ts 只负责把
 * scope 键翻译成人看的标签，其余格式都在这里，单测可以直接断言模型看到的文字。
 *
 * 0.16.0 起 memory_search 只给“印象”（id / 作用域 / 类型 / 标签 / 短摘要），
 * 正文走 memory_get；memory_get 的 fields 决定渲染哪些元数据。
 *
 * 0.20.0：范围外命中被挡住时，把**真实原因**（用户拒绝 / 审批超时 / 无法审批）
 * 写进渲染文本。
 * 0.23.0：绝对限制与「不可读」开关也会被说明（不再假装"不存在"），并提示怎么调整。
 */
                                                                                               

/** 把 scope 键渲染成展示文案（宿主能查到会话标题时用它，否则用短 id）。 */
                                                  

/** 有内容没返回时的原因。 */
                                                                    

/**
 * 上下文去重的提示语(0.21.0)。memory_search / memory_list 里已经出现过的条目
 * 只回 id、不再回摘要/正文；这条提示告诉模型为什么少了东西、以及怎么取全文。
 */
export const DEDUPE_NOTE = '本次请求部分记忆摘要因上下文去重机制被省略，若要获取完整内容请使用 memory_get'

export const shortId = (id        )         => id.slice(0, 8)

const day = (value         )         =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString().slice(0, 10) : ''

const joinList = (value         )         =>
  Array.isArray(value) ? value.map(String).filter((v) => v !== '').join(', ') : ''

/**
 * 范围外内容为什么没返回——给模型看的真实原因。
 * 空字符串 = 没有需要说明的（没有 withheld）。
 */
export function renderWithheldNote(withheld                          )         {
  if (withheld === undefined || withheld.count <= 0) return ''
  const count = withheld.count
  switch (withheld.reason) {
    case 'rejected':
      return `另有 ${count} 条记忆在本会话的可见域外，用户拒绝了本次访问（限制等级：普通限制），未返回。如确实需要，请让用户调整「记忆范围」后重试。`
    case 'timeout':
      return `另有 ${count} 条记忆在本会话的可见域外，审批在 5 分钟内没有得到答复，已按拒绝处理，未返回。如确实需要，请让用户调整「记忆范围」后重试。`
    case 'unavailable':
      return `另有 ${count} 条记忆在本会话的可见域外，当前环境无法发起审批，未返回。`
    case 'partial':
      return `另有 ${count} 条记忆在本会话的可见域外，用户在本次审批中只允许了其余条目（限制等级：普通限制），未返回。如确实需要，请让用户调整「记忆范围」后重试。`
    case 'absolute':
      return `另有 ${count} 条记忆在本会话的可见域外，当前限制等级为「绝对限制」，不会发起审批，未返回。如确实是本次任务需要的内容，请让用户调整「记忆范围」后重试。`
    case 'read-disabled':
      return `另有 ${count} 条记忆所在的作用域在本会话记忆范围里被标记为「不可读」（可读/可写按钮），未返回。如确实需要，请让用户打开该作用域的「可读」状态后重试。`
    default:
      return ''
  }
}

/** 「[得分] id (作用域/类型 · 标签) 摘要」；没有任何一条命中时给明确空结果。 */
export function renderSearchResult(value              , label            )         {
  const note = renderWithheldNote(value.withheld)
  if (value.records.length === 0) {
    if (note === '') return '没有找到相关记忆。'
    return `没有找到可见范围内的相关记忆。\n${note}`
  }
  // 已出现过的条目(上下文去重)只回 id：不带作用域/类型/标签/摘要。
  // 它们单独成块、与带摘要的条目之间空一行 —— 否则一串裸 id 看起来像上一条的
  // 续行,模型分不清哪些条目「这次有摘要」哪些「只是占位 id」(0.22.0)。
  const shown           = []
  const bare           = []
  for (const hit of value.records) {
    if (hit.deduped === true) {
      bare.push(shortId(hit.id))
      continue
    }
    const tags = joinList(hit.tags)
    const meta = `${label(hit.scope)}/${hit.kind}${tags === '' ? '' : ` · ${tags}`}`
    shown.push(`[${hit.score.toFixed(3)}] ${shortId(hit.id)} (${meta}) ${hit.summary}`)
  }
  const body = [shown.join('\n'), bare.join('\n')].filter((part) => part !== '').join('\n\n')
  const tail = [bare.length > 0 ? DEDUPE_NOTE : '', note].filter((part) => part !== '').join('\n\n')
  return tail === '' ? body : `${body}\n\n${tail}`
}

/**
 * memory_list 的渲染：每条「(作用域/类型) 正文」；上下文去重过的条目只给 id。
 * `scopeStats` 的尾部摘要由 apply.ts 追加（那里能查会话标题）。
 */
export function renderListResult(value            , label            )         {
  let omitted = 0
  const body = value.records.length === 0
    ? '该作用域还没有记忆。'
    : value.records.map((record) => {
      if (record.deduped === true) {
        omitted += 1
        return shortId(record.id)
      }
      return `(${label(record.scope)}/${record.kind}) ${record.content}`
    }).join('\n')
  const note = renderWithheldNote(value.withheld)
  const tail = [omitted > 0 ? DEDUPE_NOTE : '', note].filter((part) => part !== '').join('\n\n')
  return tail === '' ? body : `${body}\n\n${tail}`
}

/**
 * memory_get 的渲染：
 *   - 元数据按 fields 拼在首行括号里；
 *   - content 优先于 summary（两者都给时正文已经足够）；
 *   - 只取元数据时不输出正文行。
 */
export function renderGetResult(value           , label            )         {
  const fields = new Set          (value.fields)
  const body = value.records.map((record) => {
    const meta           = []
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
  // 被可见域挡住的那几条:把真实原因(拒绝 / 超时 / 绝对限制 / 不可读)告诉模型。
  const note = renderWithheldNote(value.withheld)
  const tail = [missing, note].filter((part) => part !== '').join('\n\n')
  if (body === '') return tail === '' ? '没有找到记忆。' : tail
  return tail === '' ? body : `${body}\n\n${tail}`
}


//# sourceURL=source/tool-memory/src/render.ts