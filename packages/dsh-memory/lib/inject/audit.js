/**
 * 注入审计 v2：进程内有界存储 + 类型化查询 + 统一脱敏。
 *
 * 定位（见 docs/audit-implementation-review.md）：这是“可观测、可查询、可核对”
 * 的注入诊断系统，不是法律意义上的防篡改审计。存储默认在内存，重启即失；
 * 但必须如实暴露 capacity/dropped/writeErrors/persistence。
 *
 * 安全边界：
 *   - 所有自由文本在写入前必须经过 `sanitizeAuditText` / `auditQuery`；
 *   - 先限制扫描长度（默认 4000 字符），再跑凭据正则，最后截到 200 字；
 *   - 不保存正文、原始工具参数、异常堆栈；错误只保存稳定 code。
 *
 * 记录失败绝不能影响 Agent 主链路：`record()` 内部吞掉异常并累加 writeErrors。
 */

import { redactSecrets } from '../provider/secrets.js'
             
              
               
             
               
            
                 
                  
               
            
                  
                  
            
                         

             
              
               
                      
             
               
                   
            
                 
                  
                
               
            
                  
                  
            
                    
                         

export const AUDIT_SCHEMA_VERSION = 2
export const DEFAULT_AUDIT_CAPACITY = 2000
export const DEFAULT_AUDIT_PER_SESSION = 200
export const DEFAULT_AUDIT_LIMIT = 50
export const MAX_AUDIT_LIMIT = 200

/** 查询参数错误：面板应把这个 code 映射成 400。 */
export class AuditQueryError extends Error {
           code        
  constructor(code        , message        ) {
    super(message)
    this.name = 'AuditQueryError'
    this.code = code
  }
}

const MAX_SANITIZE_SCAN = 4000

/** 稳定短 hash（FNV-1a 32）：用于比较文本是否相同，不保存原文。 */
export function hashAuditText(text        )         {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** 统一的自由文本安全处理：限制扫描长度 → 脱敏 → 折叠空白 → 截断。 */
export function sanitizeAuditText(text                    , maxChars = 200)                              {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const source = text.slice(0, MAX_SANITIZE_SCAN)
  const redactedText = redactSecrets(source)
  const redacted = redactedText !== source
  const compact = redactedText.replace(/\s+/g, ' ').trim()
  const clipped = compact.slice(0, Math.max(1, maxChars))
  return {
    ...(clipped === '' ? {} : { text: clipped }),
    chars: text.length,
    redacted,
    hash: hashAuditText(compact),
  }
}

/** 兼容旧调用：只返回脱敏后的文本。 */
export function auditQuery(text                    )                     {
  return sanitizeAuditText(text)?.text
}

/** 标签也可能包含自由文本：逐项脱敏、限长、去重、限量。 */
export function sanitizeAuditTags(tags                               , maxItems = 8)           {
  if (!Array.isArray(tags)) return []
  const out           = []
  const seen = new Set        ()
  for (const tag of tags) {
    const field = sanitizeAuditText(String(tag), 40)
    const value = field?.text
    if (value === undefined || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= maxItems) break
  }
  return out
}

export function auditBudget(budget        , used        )              {
  const remaining = Math.max(0, budget - used)
  return { budget, used, remaining, over: used > budget }
}

/** 结构化克隆；没有 structuredClone 的旧环境退回 JSON（条目都是纯数据）。 */
function cloneEntry(entry              )               {
  try {
    return structuredClone(entry)
  } catch {
    return JSON.parse(JSON.stringify(entry))                
  }
}

function isKeyEntry(entry              )          {
  if (entry.kind === 'delivery' || entry.kind === 'error' || entry.kind === 'lifecycle') return true
  return entry.channel === 'digest' || entry.channel === 'rules' || entry.channel === 'rules_delta'
}

function memoryIdsOf(entry              )           {
  const ids           = []
  const selected = entry.selected
  if (selected !== undefined) {
    ids.push(...(selected.contentIds ?? []), ...(selected.hintIds ?? []), ...(selected.newlyAddedIds ?? []))
  }
  for (const item of entry.omitted ?? []) ids.push(item.id)
  const rules = entry.rules
  if (rules !== undefined) {
    ids.push(...(rules.injectedIds ?? []), ...(rules.omittedIds ?? []))
  }
  ids.push(...(entry.dedup?.ids ?? []))
  return ids
}

function matchesQuery(entry              , query                )          {
  if (query.sessionId !== undefined && entry.sessionId !== query.sessionId) return false
  if (query.traceId !== undefined && entry.traceId !== query.traceId) return false
  if (query.operationId !== undefined && entry.operationId !== query.operationId) return false
  if (query.memoryId !== undefined && !memoryIdsOf(entry).includes(query.memoryId)) return false
  if (query.channel !== undefined && entry.channel !== query.channel) return false
  if (query.trigger !== undefined && entry.trigger !== query.trigger) return false
  if (query.outcome !== undefined && entry.outcome !== query.outcome) return false
  if (query.problem === true && !isProblemEntry(entry)) return false
  if (query.since !== undefined && entry.at < query.since) return false
  if (query.until !== undefined && entry.at > query.until) return false
  return true
}

function isProblemEntry(entry              )          {
  if (entry.outcome === 'failed' || entry.outcome === 'partial') return true
  if ((entry.omitted?.length ?? 0) > 0) return true
  if (entry.error !== undefined) return true
  const delivery = entry.delivery
  if (delivery !== undefined && delivery.status !== 'appended' && delivery.status !== 'unknown') return true
  return false
}

export class InjectAuditStore                      {
          entries                 = []
          seq = 0
          dropped = 0
          writeErrors = 0
          lastRecordedAt                    
                   capacity        
                   perSessionCapacity        

  constructor(options                                                     = {}) {
    this.capacity = Math.max(10, Math.floor(options.capacity ?? DEFAULT_AUDIT_CAPACITY))
    this.perSessionCapacity = Math.max(1, Math.floor(options.perSessionCapacity ?? DEFAULT_AUDIT_PER_SESSION))
  }

  /**
   * 写入一条事件。store 负责生成 schemaVersion/id/seq/at；异常只累加 writeErrors，
   * 绝不向调用方抛出（审计是旁路，不是控制面）。
   */
  record(draft            )       {
    try {
      const seq = ++this.seq
      const at = typeof draft.at === 'number' && Number.isFinite(draft.at) ? draft.at : Date.now()
      const sessionId = draft.sessionId
      const entry               = {
        ...draft,
        schemaVersion: AUDIT_SCHEMA_VERSION,
        id: `${sessionId ?? 'anonymous'}:${seq}`,
        seq,
        at,
      }
      this.entries.push(entry)
      this.lastRecordedAt = at
      this.trimSession(sessionId)
      this.trimGlobal()
    } catch {
      this.writeErrors += 1
    }
  }

  /** 旧接口：最新在前，可按会话过滤。返回副本。 */
  list(sessionId         )                 {
    const list = sessionId === undefined
      ? this.entries
      : this.entries.filter((entry) => entry.sessionId === sessionId)
    return [...list].reverse().map(cloneEntry)
  }

  /** 类型化查询：稳定 seq 倒序、游标分页、返回副本与容量统计。 */
  query(input                 = {})            {
    const limit = this.resolveLimit(input.limit)
    const cursor = this.resolveCursor(input.cursor)
    const filtered = this.entries.filter((entry) => matchesQuery(entry, input))
    const total = filtered.length
    const afterCursor = cursor === undefined ? filtered : filtered.filter((entry) => entry.seq < cursor)
    // entries 天然按 seq 升序写入；显式排序一次，避免未来导入数据打乱。
    afterCursor.sort((a, b) => b.seq - a.seq)
    const page = afterCursor.slice(0, limit)
    const hasMore = afterCursor.length > page.length
    const last = page[page.length - 1]
    return {
      entries: page.map(cloneEntry),
      total,
      ...(hasMore && last !== undefined ? { nextCursor: String(last.seq) } : {}),
      stats: this.stats(),
    }
  }

  stats()                  {
    return {
      entries: this.entries.length,
      capacity: this.capacity,
      perSessionCapacity: this.perSessionCapacity,
      dropped: this.dropped,
      writeErrors: this.writeErrors,
      persistence: 'memory',
      ...(this.lastRecordedAt !== undefined ? { lastRecordedAt: this.lastRecordedAt } : {}),
    }
  }

  /**
   * 只允许清理明确范围：会话或“某时间之前”。没有范围时拒绝，避免一次误触清空全部。
   */
  clear(scope                                         )         {
    if (scope?.sessionId === undefined && scope?.before === undefined) {
      throw new AuditQueryError('AUDIT_QUERY_INVALID', 'clear requires sessionId or before')
    }
    const before = this.entries.length
    this.entries = this.entries.filter((entry) => {
      const sessionMatch = scope.sessionId === undefined || entry.sessionId === scope.sessionId
      const timeMatch = scope.before === undefined || entry.at < scope.before
      return !(sessionMatch && timeMatch)
    })
    return before - this.entries.length
  }

  /** 插件半边卸载时释放内存；provider 负责不再引用。 */
  dispose()       {
    this.entries = []
  }

          resolveLimit(limit                    )         {
    if (limit === undefined) return DEFAULT_AUDIT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_LIMIT) {
      throw new AuditQueryError('AUDIT_QUERY_INVALID', `limit must be an integer between 1 and ${MAX_AUDIT_LIMIT}`)
    }
    return limit
  }

          resolveCursor(cursor                    )                     {
    if (cursor === undefined || cursor === '') return undefined
    if (!/^\d+$/.test(cursor)) throw new AuditQueryError('AUDIT_CURSOR_INVALID', 'cursor must be a seq number')
    const value = Number(cursor)
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AuditQueryError('AUDIT_CURSOR_INVALID', 'cursor must be a positive seq number')
    }
    return value
  }

          trimSession(sessionId                    )       {
    if (sessionId === undefined) return
    let count = 0
    for (const entry of this.entries) if (entry.sessionId === sessionId) count += 1
    while (count > this.perSessionCapacity) {
      const index = this.firstRemovable((entry) => entry.sessionId === sessionId)
      if (index < 0) break
      this.entries.splice(index, 1)
      this.dropped += 1
      count -= 1
    }
  }

          trimGlobal()       {
    while (this.entries.length > this.capacity) {
      const index = this.firstRemovable(() => true)
      if (index < 0) break
      this.entries.splice(index, 1)
      this.dropped += 1
    }
  }

  /** 优先淘汰非关键通道；全是关键通道时退回最早的。 */
          firstRemovable(predicate                                  )         {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i] 
      if (predicate(entry) && !isKeyEntry(entry)) return i
    }
    for (let i = 0; i < this.entries.length; i++) {
      if (predicate(this.entries[i] )) return i
    }
    return -1
  }
}

// 保持旧类型名可导入（外部/旧测试可能引用）；新代码请用 AuditEntryV2。
                                                


//# sourceURL=source/memory-inject/src/audit.ts