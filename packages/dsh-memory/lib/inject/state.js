/**
 * 注入状态:每条记忆在当前**会话上下文**里的语义状态。
 *
 * 0.9.6 之前只有一个全局 `lastText`:换会话会错误去重,而且无法区分
 * "正文已注入"与"只给了标签"。这里按 sessionId 保存:
 *   - not_seen        → 没有任何记录(默认)
 *   - hint_injected   → 只进过截断标签索引,正文仍未加载
 *   - content_injected→ 正文已进入当前上下文
 *
 * 版本 = record.updatedAt。内容更新后允许重新注入;上下文重建(压缩/新会话)
 * 由调用方 clear(),绝不用"历史上出现过"代替"当前仍在上下文里"。
 */

                                                                    

                                      
            
                           
                 
            
 

                                        
                   
                   
                      
                  
                   
                                
 

                 
                           
                 
            
 

                        
                             
                  
                   
 

const MAX_SESSIONS = 500
const MAX_ENTRIES = 4000

export class InjectionState {
                   sessions = new Map                      ()

          stateOf(sessionId                    )               {
    const key = sessionId ?? '__unknown__'
    let state = this.sessions.get(key)
    if (state === undefined) {
      state = { entries: new Map(), lastText: '', lastQuery: '' }
      this.sessions.set(key, state)
      if (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next()
        if (!oldest.done) this.sessions.delete(oldest.value)
      }
    }
    return state
  }

  /** 记录"只注入了标签"——正文仍未加载。 */
  markHint(sessionId                    , records                                                  )       {
    const state = this.stateOf(sessionId)
    const now = Date.now()
    for (const record of records) {
      const previous = state.entries.get(record.id)
      if (previous?.status === 'content_injected') continue
      state.entries.set(record.id, { status: 'hint_injected', version: record.updatedAt, at: now })
    }
    this.trim(state)
  }

  /** 记录"正文已注入"(hint 状态被正文覆盖)。 */
  markContent(sessionId                    , records                                                  )       {
    const state = this.stateOf(sessionId)
    const now = Date.now()
    for (const record of records) {
      state.entries.set(record.id, { status: 'content_injected', version: record.updatedAt, at: now })
    }
    this.trim(state)
  }

  /**
   * 从检索结果里挑出**还没注入正文**的记录。
   * 已注入且版本没变 → deduplicated;版本变了 → 视为需要重新评估。
   */
  filterNewContent                                             (
    sessionId                    ,
    records              ,
  )                                                            {
    const state = this.stateOf(sessionId)
    const fresh      = []
    const deduplicated           = []
    const updated           = []
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

  /** 同一上下文里是否已经注入过同一段文本(最后一道按内容幂等)。 */
  lastTextOf(sessionId                    )         {
    return this.stateOf(sessionId).lastText
  }

  setLastText(sessionId                    , text        )       {
    this.stateOf(sessionId).lastText = text
  }

  lastQueryOf(sessionId                    )         {
    return this.stateOf(sessionId).lastQuery
  }

  setLastQuery(sessionId                    , query        )       {
    this.stateOf(sessionId).lastQuery = query
  }

  /** 上下文重建(压缩/重置/新会话)时清空,不能沿用错误的去重状态。 */
  clear(sessionId                    )       {
    this.sessions.delete(sessionId ?? '__unknown__')
  }

  statusOf(sessionId                    , id        )                                 {
    return this.stateOf(sessionId).entries.get(id)?.status ?? 'not_seen'
  }

  snapshot(sessionId        )                        {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      return { sessionId, hintCount: 0, contentCount: 0, lastText: '', lastQuery: '', entries: [] }
    }
    const entries = [...state.entries.entries()].map(([id, entry]) => ({ id, ...entry }))
    return {
      sessionId,
      hintCount: entries.filter((entry) => entry.status === 'hint_injected').length,
      contentCount: entries.filter((entry) => entry.status === 'content_injected').length,
      lastText: state.lastText,
      lastQuery: state.lastQuery,
      entries,
    }
  }

          trim(state              )       {
    if (state.entries.size <= MAX_ENTRIES) return
    // Map 保留插入顺序;淘汰最旧的一批即可(状态只用于去重,丢了最多多注入一次)。
    for (const key of state.entries.keys()) {
      state.entries.delete(key)
      if (state.entries.size <= MAX_ENTRIES) break
    }
  }
}


//# sourceURL=source/memory-inject/src/state.ts