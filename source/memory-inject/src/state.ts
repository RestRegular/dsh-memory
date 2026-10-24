/**
 * 注入状态:每条记忆在当前**会话上下文**里的语义状态。
 *
 * 0.9.6 之前只有一个全局 `lastText`:换会话会错误去重,而且无法区分
 * "正文已注入"与"只给了标签"。这里按 sessionId 保存:
 *   - not_seen        → 没有任何记录(默认)
 *   - hint_injected   → 只进过截断标签索引,正文仍未加载
 *   - summary_injected→ 记忆摘要（memory_search / memory_list 的短摘要）已进入上下文
 *   - content_injected→ 正文已进入当前上下文
 *
 * 版本 = record.updatedAt。内容更新后允许重新注入;上下文重建(压缩/新会话)
 * 由调用方 clear(),绝不用"历史上出现过"代替"当前仍在上下文里"。
 *
 * 0.21.0 加 summary_injected：memory_search / memory_list 返回过的摘要也算
 * "条目已出现"，再次命中同版本时只回 id（见 memoryContextDedup 服务）。
 *
 * 0.17.0 起可挂一个按会话的持久化 store(见 session-state-store.ts):状态在
 * 插件重载 / 宿主重启后仍能恢复;读盘只在第一次接触该会话时发生,写入由 store
 * 自己做合并与阈值 compact。
 */

export type InjectEntryStatus = 'hint_injected' | 'summary_injected' | 'content_injected'

export interface InjectEntrySnapshot {
  id: string
  status: InjectEntryStatus
  version: number
  at: number
}

export interface SessionInjectSnapshot {
  sessionId: string
  hintCount: number
  summaryCount: number
  contentCount: number
  lastText: string
  lastQuery: string
  entries: InjectEntrySnapshot[]
}

/** 一个会话的可持久化状态:只存去重条目与会话摘要是否做过(不落正文、不落查询)。 */
export interface SessionStateSnapshot {
  entries: InjectEntrySnapshot[]
  /** 本会话的「已注入一次摘要」标记。 */
  digestDone: boolean
}

/**
 * 会话状态存储的最小接口。实现必须容错:读失败/写失败只能退化为内存状态,
 * 绝不能把异常抛回注入链路。
 */
export interface InjectionStateStore {
  /** 首次加载;没有文件或文件损坏时返回 undefined。 */
  load(): SessionStateSnapshot | undefined
  /** 合并一批增量条目。 */
  append(entries: readonly InjectEntrySnapshot[]): void
  /** 标记本会话的摘要已经做过(每个会话只做一次)。 */
  markDigestDone(): void
  /** 内存侧淘汰了条目(容量上限),持久化侧也要同步删掉。 */
  evict(ids: readonly string[]): void
  /** 把待写增量立即落盘(合并窗口未到也写)。 */
  flush(): void
  /** 上下文重建 / 会话清空:删掉持久化文件。 */
  remove(): void
  /** 插件卸载:flush 并释放定时器。 */
  dispose(): void
}

interface Entry {
  status: InjectEntryStatus
  version: number
  at: number
}

interface SessionState {
  entries: Map<string, Entry>
  lastText: string
  lastQuery: string
}

const MAX_SESSIONS = 500
const MAX_ENTRIES = 4000

export class InjectionState {
  private readonly sessions = new Map<string, SessionState>()
  private readonly stores = new Map<string, InjectionStateStore>()
  /** 摘要每个会话只注入一次;这个标记也持久化,插件重载后不重复发。 */
  private readonly digestDone = new Set<string>()

  /** 挂上按会话的持久化 store;重复 attach 是 no-op。 */
  attach(sessionId: string | undefined, store: InjectionStateStore): void {
    if (sessionId === undefined || this.stores.has(sessionId)) return
    const state = this.stateOf(sessionId)
    this.stores.set(sessionId, store)
    let snapshot: SessionStateSnapshot | undefined
    try {
      snapshot = store.load()
    } catch { /* store 自己应容错;这里再兜一层 */ }
    if (snapshot !== undefined) {
      for (const entry of snapshot.entries) {
        const previous = state.entries.get(entry.id)
        if (previous === undefined || entry.at >= previous.at) {
          state.entries.set(entry.id, { status: entry.status, version: entry.version, at: entry.at })
        }
      }
      this.trim(state, sessionId)
    }
    if (snapshot?.digestDone === true) this.markDigest(sessionId)
  }

  hasStore(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.stores.has(sessionId)
  }

  /** 摘要是否已经做过(含持久化恢复的标记)。 */
  digestDoneOf(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.digestDone.has(sessionId)
  }

  /** 摘要实际做过一次后调用:标记并尽快落盘。 */
  markDigestDone(sessionId: string | undefined): void {
    if (sessionId === undefined || this.digestDone.has(sessionId)) return
    this.markDigest(sessionId)
    this.storeOf(sessionId)?.markDigestDone()
  }

  private markDigest(sessionId: string): void {
    this.digestDone.add(sessionId)
    if (this.digestDone.size <= MAX_SESSIONS) return
    const oldest = this.digestDone.values().next()
    if (!oldest.done) this.digestDone.delete(oldest.value)
  }

  private stateOf(sessionId: string | undefined): SessionState {
    const key = sessionId ?? '__unknown__'
    let state = this.sessions.get(key)
    if (state === undefined) {
      state = { entries: new Map(), lastText: '', lastQuery: '' }
      this.sessions.set(key, state)
      if (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next()
        if (!oldest.done) {
          // 状态被容量淘汰时，先把该会话的待写增量刷掉，再释放 store；文件保留给下次加载。
          const store = this.stores.get(oldest.value)
          if (store !== undefined) {
            try { store.dispose() } catch { /* best effort */ }
            this.stores.delete(oldest.value)
          }
          this.digestDone.delete(oldest.value)
          this.sessions.delete(oldest.value)
        }
      }
    }
    return state
  }

  private storeOf(sessionId: string | undefined): InjectionStateStore | undefined {
    return sessionId === undefined ? undefined : this.stores.get(sessionId)
  }

  /** 记录"只注入了标签"——正文仍未加载。 */
  markHint(sessionId: string | undefined, records: ReadonlyArray<{ id: string; updatedAt: number }>): void {
    const state = this.stateOf(sessionId)
    const now = Date.now()
    const changed: InjectEntrySnapshot[] = []
    for (const record of records) {
      const previous = state.entries.get(record.id)
      // 标签是比摘要/正文更弱的证据:已经进过摘要或正文时不能往回降级。
      if (previous?.status === 'content_injected' || previous?.status === 'summary_injected') continue
      const entry = { status: 'hint_injected' as const, version: record.updatedAt, at: now }
      state.entries.set(record.id, entry)
      changed.push({ id: record.id, ...entry })
    }
    if (changed.length > 0) this.storeOf(sessionId)?.append(changed)
    this.trim(state, sessionId)
  }

  /**
   * 记录"摘要已进入上下文"(memory_search / memory_list 返回过的条目)。
   * 同版本的正文已注入时不降级:正文比摘要更强。
   */
  markSummary(sessionId: string | undefined, records: ReadonlyArray<{ id: string; updatedAt: number }>): void {
    const state = this.stateOf(sessionId)
    const now = Date.now()
    const changed: InjectEntrySnapshot[] = []
    for (const record of records) {
      const previous = state.entries.get(record.id)
      if (previous?.status === 'content_injected' && previous.version === record.updatedAt) continue
      if (previous?.status === 'summary_injected' && previous.version === record.updatedAt) continue
      const entry = { status: 'summary_injected' as const, version: record.updatedAt, at: now }
      state.entries.set(record.id, entry)
      changed.push({ id: record.id, ...entry })
    }
    if (changed.length > 0) this.storeOf(sessionId)?.append(changed)
    this.trim(state, sessionId)
  }

  /** 记录"正文已注入"(hint 状态被正文覆盖)。 */
  markContent(sessionId: string | undefined, records: ReadonlyArray<{ id: string; updatedAt: number }>): void {
    const state = this.stateOf(sessionId)
    const now = Date.now()
    const changed: InjectEntrySnapshot[] = []
    for (const record of records) {
      const entry = { status: 'content_injected' as const, version: record.updatedAt, at: now }
      state.entries.set(record.id, entry)
      changed.push({ id: record.id, ...entry })
    }
    if (changed.length > 0) this.storeOf(sessionId)?.append(changed)
    this.trim(state, sessionId)
  }

  /**
   * 从检索结果里挑出**还没注入正文**的记录。
   * 已注入且版本没变 → deduplicated;版本变了 → 视为需要重新评估。
   */
  filterNewContent<T extends { id: string; updatedAt: number }>(
    sessionId: string | undefined,
    records: readonly T[],
  ): { fresh: T[]; deduplicated: string[]; updated: string[] } {
    const state = this.stateOf(sessionId)
    const fresh: T[] = []
    const deduplicated: string[] = []
    const updated: string[] = []
    for (const record of records) {
      const entry = state.entries.get(record.id)
      if (entry?.status === 'content_injected' && entry.version === record.updatedAt) {
        deduplicated.push(record.id)
        continue
      }
      if (entry?.status === 'content_injected' && entry.version !== record.updatedAt) updated.push(record.id)
      fresh.push(record)
    }
    return { fresh, deduplicated, updated }
  }

  /**
   * 从工具结果去重的角度：这批记录里哪些已经以同版本进入过上下文。
   *
   * 只认摘要 / 正文（content_injected、summary_injected）——标签索引只给了
   * id + tags，不包含摘要，所以 hint_injected 不算“摘要已出现”。
   * 版本（updatedAt）变了等于内容变了，允许重新返回摘要。
   */
  seenInContext(
    sessionId: string | undefined,
    records: ReadonlyArray<{ id: string; updatedAt: number }>,
  ): Set<string> {
    const state = this.stateOf(sessionId)
    const seen = new Set<string>()
    for (const record of records) {
      const entry = state.entries.get(record.id)
      if (entry === undefined || entry.version !== record.updatedAt) continue
      if (entry.status === 'content_injected' || entry.status === 'summary_injected') seen.add(record.id)
    }
    return seen
  }

  /** 同一上下文里是否已经注入过同一段文本(最后一道按内容幂等)。 */
  lastTextOf(sessionId: string | undefined): string {
    return this.stateOf(sessionId).lastText
  }

  setLastText(sessionId: string | undefined, text: string): void {
    this.stateOf(sessionId).lastText = text
  }

  lastQueryOf(sessionId: string | undefined): string {
    return this.stateOf(sessionId).lastQuery
  }

  setLastQuery(sessionId: string | undefined, query: string): void {
    // lastQuery 只用于同一进程内的重复检索保护；不落盘（查询可能含凭据）。
    this.stateOf(sessionId).lastQuery = query
  }

  /** 上下文重建(压缩/重置/新会话)时清空,不能沿用错误的去重状态。 */
  clear(sessionId: string | undefined): void {
    const key = sessionId ?? '__unknown__'
    const store = this.stores.get(key)
    if (store !== undefined) {
      try { store.remove() } catch { /* 删文件失败不影响内存清空 */ }
      this.stores.delete(key)
    }
    this.sessions.delete(key)
    this.digestDone.delete(key)
  }

  /** 插件卸载 / 轮末:把每个会话的待写增量都刷掉。 */
  flushAll(): void {
    for (const store of this.stores.values()) {
      try { store.flush() } catch { /* 持久化失败只记在 store 里 */ }
    }
  }

  dispose(): void {
    for (const store of this.stores.values()) {
      try { store.dispose() } catch { /* 持久化失败不影响卸载 */ }
    }
    this.stores.clear()
    this.sessions.clear()
    this.digestDone.clear()
  }

  statusOf(sessionId: string | undefined, id: string): InjectEntryStatus | 'not_seen' {
    return this.stateOf(sessionId).entries.get(id)?.status ?? 'not_seen'
  }

  snapshot(sessionId: string): SessionInjectSnapshot {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      return { sessionId, hintCount: 0, summaryCount: 0, contentCount: 0, lastText: '', lastQuery: '', entries: [] }
    }
    const entries = [...state.entries.entries()].map(([id, entry]) => ({ id, ...entry }))
    return {
      sessionId,
      hintCount: entries.filter((entry) => entry.status === 'hint_injected').length,
      summaryCount: entries.filter((entry) => entry.status === 'summary_injected').length,
      contentCount: entries.filter((entry) => entry.status === 'content_injected').length,
      lastText: state.lastText,
      lastQuery: state.lastQuery,
      entries,
    }
  }

  private trim(state: SessionState, sessionId: string | undefined): void {
    if (state.entries.size <= MAX_ENTRIES) return
    // Map 保留插入顺序;淘汰最旧的一批即可(状态只用于去重,丢了最多多注入一次)。
    const evicted: string[] = []
    for (const key of state.entries.keys()) {
      state.entries.delete(key)
      evicted.push(key)
      if (state.entries.size <= MAX_ENTRIES) break
    }
    if (evicted.length > 0) this.storeOf(sessionId)?.evict(evicted)
  }
}
