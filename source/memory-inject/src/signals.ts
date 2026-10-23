/**
 * 行为信号 → 自动召回查询。
 *
 * 只消费宿主**公开**的可观测信号:
 *   - session/event 的 `tool/call`（name + arguments，含工具自带的 description）
 *   - session/event 的 `tool/result`（error / message.isError）
 *   - compaction 事件（上下文重建）
 *
 * “模式”就是一组标签（release / deploy / database / credentials ...），
 * 由设置提供、来自记忆里实际使用的标签；工具名/description/参数命中任一标签
 * 就触发一次定向召回。失败调用始终触发，并优先用 description 作为查询。
 * 不读取隐藏思维链，也不把原始参数写进审计。
 */

export type SignalReason = 'before_high_risk_tool' | 'tool_failure' | 'phase_change' | 'text_tag_match'

export type ToolErrorClass =
  | 'MISSING_CREDENTIAL'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'ABORTED_UNKNOWN'
  | 'TOOL_FAILED'

export interface BehaviorSignal {
  key: string
  reason: SignalReason
  query: string
  phase: string
  tool?: string
  errorClass?: ToolErrorClass
  /** 命中的触发标签。 */
  tag?: string
  /** 触发来源:tool / failure / assistant / todo / command / goal。 */
  source?: string
  /** 触发本次信号的 tool call id（用于把审计条目锚回轨迹中的那一行）。 */
  callId?: string
}

export interface ToolSignalOptions {
  /** 触发标签;空数组 = 不做成功工具触发的召回。 */
  tags?: readonly string[]
  description?: string
  useToolDescription?: boolean
  maxQueryChars?: number
  /** 触发本次信号的 tool call id。 */
  callId?: string
}

export interface FailureOptions {
  description?: string
  maxQueryChars?: number
  /** 触发本次信号的 tool call id。 */
  callId?: string
}

const DEFAULT_MAX_QUERY = 240

const RELEASE_TAGS = new Set(['release', 'publish', 'push', '发布', '推送'])
const DEPLOY_TAGS = new Set([
  'deploy', 'deployment', 'rollback', 'restore', 'backup',
  'database', 'migration', 'migrate', 'schema', 'production', 'prod',
  '部署', '回滚', '恢复', '备份', '数据库', '迁移', '生产',
])
const SPECIFIC_TAGS = new Set([
  'database', 'migration', 'migrate', 'schema', 'credentials', 'credential',
  'auth', 'token', 'secret', 'permission', 'security', 'destructive', 'drop', 'truncate',
  '数据库', '迁移', '凭据', '认证', '权限', '安全', '删除', '清空',
])

function truncate(value: string, max: number | undefined): string {
  const limit = Math.max(20, max ?? DEFAULT_MAX_QUERY)
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** 中英标签的最小同义词表:记忆标签常是英文,Agent 文本常是中文。 */
const TAG_ALIASES: Record<string, readonly string[]> = {
  release: ['发布'],
  publish: ['发布', '推送'],
  deploy: ['部署'],
  deployment: ['部署'],
  database: ['数据库'],
  migration: ['迁移'],
  migrate: ['迁移'],
  schema: ['结构', '迁移'],
  credentials: ['凭据'],
  credential: ['凭据'],
  auth: ['认证'],
  permission: ['权限'],
  security: ['安全'],
  destructive: ['删除', '清空'],
  delete: ['删除'],
  drop: ['删除'],
  truncate: ['清空'],
  backup: ['备份'],
  restore: ['恢复'],
  rollback: ['回滚'],
  install: ['安装'],
  upgrade: ['升级'],
  production: ['生产'],
  server: ['服务器'],
  network: ['网络'],
}

/** 标签及其同义词(双向:英文标签匹配中文文本,中文标签也匹配英文文本)。 */
function aliasesFor(tag: string): string[] {
  const needle = tag.trim().toLowerCase()
  const out = new Set<string>([needle])
  for (const alias of TAG_ALIASES[needle] ?? []) out.add(alias.toLowerCase())
  for (const [key, aliases] of Object.entries(TAG_ALIASES)) {
    if (aliases.some((alias) => alias.toLowerCase() === needle)) out.add(key)
  }
  return [...out]
}

/** 标签是否出现在文本里。ASCII 标签按词边界匹配并容忍复数 s;中文按子串。 */
export function textHasTag(text: string, tag: string): boolean {
  const haystack = text.toLowerCase()
  for (const needle of aliasesFor(tag)) {
    if (needle === '') continue
    if (/^[a-z0-9][a-z0-9_-]*$/.test(needle)) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(^|[^a-z0-9_])${escaped}s?(?=$|[^a-z0-9_])`).test(haystack)) return true
    } else if (haystack.includes(needle)) {
      return true
    }
  }
  return false
}

/**
 * 工具参数里的 description。很多工具(ops_bash / workflow / run_code 等)要求
 * 模型写一句 "这个命令在干什么",它比命令本身更适合做记忆检索查询。
 * 解析失败或没有该字段时返回 undefined。
 */
export function toolCallDescription(argumentsText: unknown): string | undefined {
  let value: unknown = argumentsText
  if (typeof argumentsText === 'string') {
    const text = argumentsText.trim()
    if (text === '') return undefined
    try { value = JSON.parse(text) } catch { return undefined }
  }
  if (!value || typeof value !== 'object') return undefined
  const description = (value as { description?: unknown }).description
  if (typeof description !== 'string') return undefined
  const trimmed = description.replace(/\s+/g, ' ').trim()
  return trimmed === '' ? undefined : trimmed
}

/** 稳定短 hash:让不同失败描述各自触发一次召回,又不在状态里保存原文。 */
function hashKey(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** 从用户可见文本推断任务阶段;不确定就返回 unknown,不伪造。 */
export function detectPhase(text: string | undefined): string {
  const value = String(text ?? '').toLowerCase()
  if (/(?:npm|pnpm|yarn)\s+(?:publish|stage)|git\s+push|\brelease\b|\bpublish\b|发布|推送/.test(value)) return 'release'
  if (/(?:deploy|rollout|kubectl|terraform\s+apply|部署)/.test(value)) return 'deploy'
  if (/(?:implement|refactor|fix|add)\b|开发|实现|修复|新增|重构|添加/.test(value)) return 'development'
  return 'unknown'
}

function phaseForTag(tag: string, fallback: string): string {
  const value = tag.toLowerCase()
  if (RELEASE_TAGS.has(value)) return 'release'
  if (DEPLOY_TAGS.has(value)) return 'deploy'
  return fallback
}

/** 同一段文本命中多个标签时,优先保留更具体的语义(release > database > deploy > 普通)。 */
function tagPriority(tag: string): number {
  const value = tag.toLowerCase()
  if (RELEASE_TAGS.has(value)) return 4
  if (SPECIFIC_TAGS.has(value)) return 3
  if (DEPLOY_TAGS.has(value)) return 2
  return 1
}

/**
 * 工具名 + description + 参数是否命中某个可配置触发标签。
 * 命中后用 description(若开启)或标签本身作为检索查询。
 */
export function highRiskSignal(tool: string, argumentsText: string, options: ToolSignalOptions = {}): BehaviorSignal | undefined {
  const tags = options.tags ?? []
  const description = options.useToolDescription === false ? undefined : options.description
  const haystack = `${tool} ${description ?? ''} ${argumentsText}`
  const ordered = [...tags]
    .map((tag, index) => ({ tag, index, priority: tagPriority(tag) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
  for (const { tag } of ordered) {
    if (!textHasTag(haystack, tag)) continue
    return {
      key: `auto-tag:${tag.toLowerCase()}`,
      reason: 'before_high_risk_tool',
      query: truncate(description ?? tag, options.maxQueryChars),
      phase: phaseForTag(tag, 'unknown'),
      tool,
      tag,
      source: 'tool',
      ...(options.callId !== undefined ? { callId: options.callId } : {}),
    }
  }
  return undefined
}

/**
 * 任意可见文本(assistant 输出、todo、命令、goal)命中记忆标签时的召回信号。
 * 查询 = 标签 + 命中位置附近的一小段文本,既保留标签的精确性,也给检索一点上下文。
 */
export function textTagSignal(
  text: string,
  options: ToolSignalOptions & { source?: string } = {},
): BehaviorSignal | undefined {
  const tags = options.tags ?? []
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (body === '') return undefined
  const ordered = [...tags]
    .map((tag, index) => ({ tag, index, priority: tagPriority(tag) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
  for (const { tag } of ordered) {
    if (!textHasTag(body, tag)) continue
    const lower = body.toLowerCase()
    const at = lower.indexOf(tag.toLowerCase())
    const start = Math.max(0, at - 80)
    const snippet = body.slice(start, Math.min(body.length, at + tag.length + 120))
    const source = options.source ?? 'text'
    return {
      key: `text-tag:${source}:${tag.toLowerCase()}`,
      reason: 'text_tag_match',
      query: truncate(`${tag} ${snippet}`, options.maxQueryChars),
      phase: phaseForTag(tag, 'unknown'),
      tag,
      source,
    }
  }
  return undefined
}

/** 从 assistant message 的 content 里取**可见文本**块;不读 reasoning / 隐藏 CoT。 */
export function visibleTextContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('\n')
    .trim()
}

/** `assistant/message` 的可见文本。 */
export function assistantVisibleText(event: unknown): string | undefined {
  const data = (event as { data?: Record<string, unknown> } | undefined)?.data
  const message = data?.message as { content?: unknown } | undefined
  const text = visibleTextContent(message?.content)
  return text === '' ? undefined : text
}

/** `todo/write` 的任务清单文本。 */
export function todoText(event: unknown): string | undefined {
  const data = (event as { data?: Record<string, unknown> } | undefined)?.data
  const todos = data?.todos
  if (!Array.isArray(todos)) return undefined
  const text = todos
    .map((todo) => (todo && typeof todo === 'object' ? (todo as { content?: unknown }).content : undefined))
    .filter((content): content is string => typeof content === 'string' && content.trim() !== '')
    .join('\n')
    .trim()
  return text === '' ? undefined : text
}

/** `command/run` 的命令名与参数。 */
export function commandText(event: unknown): string | undefined {
  const data = (event as { data?: Record<string, unknown> } | undefined)?.data
  const name = typeof data?.name === 'string' ? data.name : ''
  const args = typeof data?.args === 'string' ? data.args : ''
  const text = `${name} ${args}`.trim()
  return text === '' ? undefined : text
}

/** `goal/change` 的目标文本(只取明确的 objective/title/description)。 */
export function goalText(event: unknown): string | undefined {
  const data = (event as { data?: Record<string, unknown> } | undefined)?.data
  const goal = data?.goal as Record<string, unknown> | undefined
  if (!goal || typeof goal !== 'object') return undefined
  const values = [goal.objective, goal.title, goal.description]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
  return values.length > 0 ? values.join('\n') : undefined
}

/**
 * 工具失败分类。失败时**优先用工具调用自己的 description** 做检索查询;
 * 没有 description 才退回错误类别关键词。只根据 code/消息里的类别词判断,
 * 不保存原始消息。
 */
export function failureSignal(
  tool: string | undefined,
  code: string | undefined,
  message: string | undefined,
  options: FailureOptions = {},
): BehaviorSignal {
  const haystack = `${code ?? ''} ${message ?? ''}`.toLowerCase()
  let errorClass: ToolErrorClass = 'TOOL_FAILED'
  let fallbackQuery = `failure diagnostics ${tool ?? 'tool'}`
  let phase = 'unknown'
  if (/credential|missing.*token|no.*token|unauthori[sz]ed|e401|401|auth(?:entication)?\s+required/.test(haystack)) {
    errorClass = 'MISSING_CREDENTIAL'
    fallbackQuery = 'credentials npm publish devcred token missing'
    phase = 'release'
  } else if (/permission|denied|forbidden|e403|403|eacces|eperm/.test(haystack)) {
    errorClass = 'PERMISSION_DENIED'
    fallbackQuery = 'permission denied sandbox approval credentials'
  } else if (/timeout|timed\s*out|etimedout/.test(haystack)) {
    errorClass = 'TIMEOUT'
    fallbackQuery = 'timeout retry long running command'
  } else if (/abort|cancel|interrupt/.test(haystack)) {
    errorClass = 'ABORTED_UNKNOWN'
    fallbackQuery = 'aborted command diagnosis retry'
  }

  const description = options.description?.replace(/\s+/g, ' ').trim()
  const extra = errorClass === 'MISSING_CREDENTIAL' ? 'credentials token auth'
    : errorClass === 'PERMISSION_DENIED' ? 'permission sandbox approval'
      : errorClass === 'TIMEOUT' ? 'timeout retry'
        : errorClass === 'ABORTED_UNKNOWN' ? 'aborted retry diagnosis'
          : 'failure diagnostics'
  const query = truncate(description !== undefined && description !== ''
    ? `${description} ${extra}`
    : fallbackQuery, options.maxQueryChars)
  const key = `tool-failure:${tool ?? 'unknown'}:${errorClass}:${hashKey(description ?? message ?? '')}`
  return {
    key,
    reason: 'tool_failure',
    query,
    phase,
    ...(tool !== undefined ? { tool } : {}),
    errorClass,
    source: 'failure',
    ...(options.callId !== undefined ? { callId: options.callId } : {}),
  }
}

/** 从一个 tool/result 事件里取错误信息（已做防御性读取）。 */
export function toolResultFailure(event: unknown): { code?: string; message?: string; isError: boolean } {
  const data = (event as { data?: Record<string, unknown> } | undefined)?.data
  const error = data?.error as { code?: unknown; name?: unknown; reason?: unknown } | undefined
  const message = data?.message as { isError?: unknown; content?: Array<{ type?: string; text?: string }> } | undefined
  const text = Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text as string).join(' ')
    : ''
  const code = typeof error?.code === 'string'
    ? error.code
    : typeof error?.name === 'string' ? error.name : undefined
  return {
    ...(code !== undefined ? { code } : {}),
    ...(text !== '' ? { message: text.slice(0, 240) } : {}),
    isError: message?.isError === true || error !== undefined,
  }
}

/**
 * `memory_get` 的这次调用是否会把正文放进上下文。
 *
 * 与工具默认值同一口径：`fields` 省略 = 默认含 `content`；显式给了 fields 时，
 * 只有包含 `content` 才算。只取 summary / tags / 元数据不是正文，不参与正文去重。
 */
export function memoryGetRequestsContent(args: unknown): boolean {
  let parsed: unknown = args
  if (typeof args === 'string') {
    try { parsed = JSON.parse(args) } catch { return false }
  }
  if (parsed === null || typeof parsed !== 'object') return false
  const fields = (parsed as { fields?: unknown }).fields
  if (fields === undefined || fields === null) return true
  const items = Array.isArray(fields)
    ? fields
    : typeof fields === 'string' ? fields.split(/[,\s]+/) : []
  return items.some((item) => String(item).trim().toLowerCase() === 'content')
}

/**
 * 从 `memory_get` 的 tool/result 里取记录 id。
 *
 * 正常路径是渲染后的文本，每条以 `[<id>]` 开头；这里只认十六进制/横线组成的
 * id，避免把正文里普通的方括号文本（如 `[提示]`）误当成记录。若宿主把结构化
 * 结果直接放进文本块（JSON），也兼容 `records[].id`。真正的存在性还会由调用方
 * 用 `getByIds` 再校验一次，前缀也能解析。
 */
export function memoryGetResultIds(event: unknown): string[] {
  const data = (event as { data?: Record<string, unknown> } | undefined)?.data
  const message = data?.message as { content?: Array<{ type?: string; text?: string }> } | undefined
  const text = Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text as string).join('\n')
    : ''
  if (text === '') return []
  const seen = new Set<string>()
  const ids: string[] = []
  const push = (value: unknown): void => {
    if (typeof value !== 'string' || value === '' || seen.has(value)) return
    seen.add(value)
    ids.push(value)
  }
  // 兼容结构化输出：{"records":[{"id":"..."}], ...}
  try {
    const parsed = JSON.parse(text) as { records?: unknown }
    if (Array.isArray(parsed?.records)) {
      for (const record of parsed.records) push((record as { id?: unknown } | undefined)?.id)
      if (ids.length > 0) return ids.slice(0, 50)
    }
  } catch { /* 不是 JSON，按渲染文本解析 */ }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[([0-9a-f][0-9a-f-]{7,})\]/i.exec(line)
    if (match !== null) push(match[1]!)
  }
  return ids.slice(0, 50)
}

/** 记录 id 的形态:`newId()` 生成 randomUUID,这里只认完整 UUID。 */
const RECORD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/**
 * 从 `memory_save` 的 tool/result 里取这次写入 / 去重命中的记录 id。
 *
 * 工具结果的渲染只有两种形态:「已保存记忆 <id> @ <scope>」与
 * 「已更新既有记忆(内容相同,去重):<id> @ <scope>」,id 是 randomUUID。
 * 这里**不按文案匹配**(本地化/措辞改动不该让去重失效),只按 UUID 形态取候选;
 * 调用方还会用 `getByIds` 校验一次存在性,所以 scope 名字里的偶然片段不会误伤。
 */
export function memorySaveResultIds(event: unknown): string[] {
  const data = (event as { data?: Record<string, unknown> } | undefined)?.data
  const message = data?.message as { content?: Array<{ type?: string; text?: string }> } | undefined
  const text = Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text as string).join('\n')
    : ''
  if (text === '') return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const match of text.matchAll(RECORD_ID_PATTERN)) {
    const id = match[0]
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= 10) break
  }
  return ids
}

/**
 * 每个会话只保留**最新一条未消费**的信号;相同 key 不重复排队。
 * `take()` 消费后保留 lastKey,同一失败不会因为重复事件反复搜索。
 */
export class BehaviorSignalStore {
  private readonly bySession = new Map<string, { pending?: BehaviorSignal; lastKey: string }>()

  note(sessionId: string | undefined, signal: BehaviorSignal): boolean {
    if (sessionId === undefined) return false
    const key = sessionId
    const state = this.bySession.get(key) ?? { lastKey: '' }
    if (signal.key === state.lastKey) return false
    state.pending = signal
    state.lastKey = signal.key
    this.bySession.set(key, state)
    if (this.bySession.size > 500) {
      const oldest = this.bySession.keys().next()
      if (!oldest.done) this.bySession.delete(oldest.value)
    }
    return true
  }

  take(sessionId: string | undefined): BehaviorSignal | undefined {
    if (sessionId === undefined) return undefined
    const state = this.bySession.get(sessionId)
    if (state?.pending === undefined) return undefined
    const signal = state.pending
    state.pending = undefined
    return signal
  }

  clear(sessionId: string | undefined): void {
    if (sessionId === undefined) return
    this.bySession.delete(sessionId)
  }
}
