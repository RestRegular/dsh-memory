/**
 * Memory injection logic (M3) — pure functions, no cordis imports.
 *
 * Injection shape follows the official docs: a user-role message whose content
 * is a single `context` block with `contextForm: 'recall'`, prepended to the
 * messages that enter the step via the agent/pre-step waterfall.
 */
import type { MemoryHit } from 'dsh-memory'
import { estimateTokens } from '../../memory-local/src/rerank.ts'
import { normalizeScopeInput } from '../../memory-local/src/scope.ts'

export interface InjectConfig {
  enabled: boolean
  /** Token budget for the injected recall block. */
  tokenBudget: number
  /** Max memories per injection. */
  topK: number
  /**
   * 额外参与召回的 scope 名(走同一套规范化);非法项忽略并记一行日志。
   * 默认集合是 provider 给的 [当前会话, 当前项目, global] —— 与 memory_search 的默认一致。
   */
  extraScopes?: string[]
}

export const defaultInjectConfig: InjectConfig = {
  enabled: true,
  tokenBudget: 500,
  topK: 5,
}

/** 召回注入能用到的那部分 provider 能力。 */
export interface InjectMemoryService {
  search(input: unknown): Promise<MemoryHit[]>
  resolveReadScopes?(agent: unknown): string[]
}

/** 宿主里"按会话 id 找 live session"的那一小部分能力(拿不到就不做父会话召回)。 */
export interface SessionRegistry {
  get?(id: string): unknown
}

/**
 * 把 config.extraScopes 规范化成 scope 键列表;非法项忽略并记一行日志
 * (配置写错不该让整个注入半边失效)。
 */
export function normalizeExtraScopes(raw: readonly string[], warn: (message: string) => void = console.warn): string[] {
  const out: string[] = []
  for (const item of raw) {
    const normalized = normalizeScopeInput(item)
    if (!normalized.ok) {
      warn(`[dsh-memory-inject] 忽略非法的 inject.extraScopes 项 ${JSON.stringify(item)}: ${normalized.message}`)
      continue
    }
    if (normalized.scope !== undefined && !out.includes(normalized.scope)) out.push(normalized.scope)
  }
  return out
}

/**
 * 无显式 scope 时的召回范围:当前会话 + 当前项目 + global(provider 解析)
 * + inject.extraScopes + 父会话(fork 时,只读召回)。
 * 任何一步拿不到都只降级,绝不抛(注入路径抛错会打断整个 agent 循环)。
 */
export function resolveInjectScopes(
  memory: InjectMemoryService,
  agent: unknown,
  extraScopes: readonly string[],
  sessions: SessionRegistry | undefined,
): string[] | undefined {
  const scopes: string[] = []
  try {
    for (const scope of memory.resolveReadScopes?.(agent) ?? []) {
      if (!scopes.includes(scope)) scopes.push(scope)
    }
  } catch { /* 降级为 extraScopes */ }
  for (const scope of extraScopes) if (!scopes.includes(scope)) scopes.push(scope)
  // fork 出来的会话:父会话的记忆也值得召回(只读)。父会话可能已不在内存里,拿不到就跳过。
  try {
    const header = (agent as { session?: { header?: { parentSession?: unknown; origin?: unknown } } } | undefined)?.session?.header
    const parent = typeof header?.parentSession === 'string' ? header.parentSession : undefined
    if (parent !== undefined && header?.origin !== 'subagent') {
      if (sessions?.get?.(parent) !== undefined) {
        const scope = `session:${parent}`
        if (!scopes.includes(scope)) scopes.push(scope)
      }
    }
  } catch { /* 父会话召回是可选增强 */ }
  return scopes.length > 0 ? scopes : undefined
}

/** Minimal structural view of the messages we inspect (role + text blocks). */
export interface InputMessageView {
  role: string
  content: ReadonlyArray<{ type: string; text?: string }>
}

export interface PreStepView {
  messages: readonly InputMessageView[]
  signal?: AbortSignal
  /**
   * 召回范围(scope 键列表:当前会话 + 当前项目 + global + 额外配置)。
   * 由宿主侧 apply.ts 解析 —— 会话 id / cwd 只在 agent/pre-step 的 payload 里,
   * 这里是纯函数层,拿不到也不该去猜。缺省(undefined)时由 provider 用它自己的默认集合。
   */
  scopes?: readonly string[]
}

export interface PreStepDecisionView {
  messages: readonly InputMessageView[]
}

/**
 * Extract the retrieval query: the text of the LAST user message. Synthetic
 * context injections (file notices etc.) are user-role too, so scanning from
 * the end finds the freshest human-visible input; empty text → no injection.
 */
export function pickQueryText(messages: readonly InputMessageView[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    const text = (m.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join(' ')
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * 这一步的 messages 里是否已经有一条内容完全相同的召回块。
 *
 * 正常情况下永远不会命中:一个激活只有一个 MemoryInjector,而它自己用 lastText
 * 去重。但只要宿主把这条 entry 应用了两次(热重载/重新启用时旧 fiber 的
 * agent/pre-step 监听没被清掉),两个注入器就会各追加一条逐字相同的消息 ——
 * 表现在会话轨迹里就是同一轮「上下轮」卡片连着出现两次(2026-10-17 实况)。
 * 注入本身是"多一条也无害、少一条也不坏"的提示块,所以这里按内容做一次幂等:
 * 另一个实例已经放进去的同一段,就不要再放。
 */
export function hasRecallMessage(
  messages: ReadonlyArray<InputMessageView & { source?: { kind?: string } }>,
  text: string,
): boolean {
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (m.source?.kind !== 'memory') continue
    const joined = (m.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n')
    if (joined === text) return true
  }
  return false
}

/** Render hits into a recall text block, greedily within the token budget. */
export function renderRecallBlock(hits: MemoryHit[], cfg: InjectConfig): { text: string; tokens: number } | null {
  if (hits.length === 0) return null
  const header = '以下是与此请求可能相关的长期记忆，供参考（可用 memory_search 核实，用 memory_forget 删除）：'
  let tokens = estimateTokens(header) + 4
  const lines: string[] = []
  for (const h of hits.slice(0, cfg.topK)) {
    const line = `- ${h.record.content.replace(/\s+/g, ' ').slice(0, 300)}`
    const cost = estimateTokens(line) + 1
    if (tokens + cost > cfg.tokenBudget) break
    lines.push(line)
    tokens += cost
  }
  if (lines.length === 0) return null
  return { text: `${header}\n${lines.join('\n')}`, tokens }
}

/** The context block we prepend (matches the documented ContextForm 'recall'). */
export function recallText(text: string): string {
  return text
}

/**
 * Turn-agnostic injector: searches memory for the step's query and returns the
 * recall text to append. The host middleware (apply.ts) wraps that text into a
 * real message via createUserMessage — a bare {role, content} object is NOT a
 * message and crashes the loop (see the 2026-10-10 incident below).
 *
 * Repeated identical injections are suppressed so a multi-step turn does not
 * repeat the same block before every model call.
 */
export class MemoryInjector {
  private lastText = ''
  private readonly search: (query: string, signal?: AbortSignal, scopes?: readonly string[]) => Promise<MemoryHit[]>
  private readonly cfg: InjectConfig

  constructor(
    search: (query: string, signal?: AbortSignal, scopes?: readonly string[]) => Promise<MemoryHit[]>,
    cfg: InjectConfig,
  ) {
    this.search = search
    this.cfg = cfg
  }

  async maybeInject(
    input: PreStepView,
    _decision: PreStepDecisionView,
  ): Promise<string | undefined> {
    if (!this.cfg.enabled) return undefined
    const query = pickQueryText(input.messages)
    if (!query) return undefined

    let hits: MemoryHit[]
    try {
      hits = await this.search(query, input.signal, input.scopes)
    } catch {
      return undefined // retrieval failure never breaks the agent loop
    }

    const block = renderRecallBlock(hits, this.cfg)
    if (!block || block.text === this.lastText) return undefined
    this.lastText = block.text

    return block.text
  }
}
