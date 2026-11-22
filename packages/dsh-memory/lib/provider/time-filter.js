/**
 * memory_list 的时间筛选口径（0.43.0）。
 *
 * `since` / `until` 接受 ISO 8601 日期、日期时间或毫秒时间戳；纯 `YYYY-MM-DD`
 * 按**本地时区的整天**解释（since = 当天 00:00:00.000，until = 当天
 * 23:59:59.999），这样"列 2026-11-22 的记忆"在用户所在时区才符合直觉。
 * 完整 ISO 日期时间与数字则精确到毫秒，不做任何取整。
 */

/** 带 code 的错误，便于 toolError 原样保留（而不是退化成 MEMORY_ERROR）。 */
function filterError(code                                              , message        )        {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

                                                     

                             
                
                
                          
 

/** 空值不参与筛选；非法值抛错，让调用方立刻知道日期写错了。 */
export function parseTimeBoundary(value         , endOfDay         )                     {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw filterError('INVALID_TIME_FILTER', `时间戳不是有限数字: ${value}`)
    return value
  }
  if (typeof value !== 'string') throw filterError('INVALID_TIME_FILTER', `日期必须是字符串或毫秒时间戳: ${String(value)}`)
  const text = value.trim()
  if (text === '') return undefined

  // 纯日期 → 本地时区的整天边界（避开 new Date('YYYY-MM-DD') 被当成 UTC 午夜）。
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateOnly) {
    const y = Number(dateOnly[1])
    const m = Number(dateOnly[2])
    const d = Number(dateOnly[3])
    const probe = new Date(y, m - 1, d)
    if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
      throw filterError('INVALID_TIME_FILTER', `不是有效日期: ${text}`)
    }
    return endOfDay
      ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
      : new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
  }

  // 纯数字字符串按毫秒时间戳处理（与 number 入参同口径）。
  if (/^-?\d+$/.test(text)) {
    const n = Number(text)
    if (!Number.isFinite(n)) throw filterError('INVALID_TIME_FILTER', `时间戳不是有限数字: ${text}`)
    return n
  }

  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) throw filterError('INVALID_TIME_FILTER', `无法解析日期: ${text}`)
  return parsed
}

/** timeField 缺省 = updatedAt（与列表排序、上下文去重的版本口径一致）。 */
export function resolveTimeField(value         )                {
  if (value === undefined || value === null || value === '' || value === 'updatedAt') return 'updatedAt'
  if (value === 'createdAt') return 'createdAt'
  throw filterError('INVALID_TIME_FIELD', `timeField 只支持 updatedAt / createdAt，收到: ${String(value)}`)
}

/** 一条记录落在哪个时间戳上（老记录没有 createdAt 时退回 updatedAt）。 */
export function timeOf(record                                            , field               )         {
  const value = field === 'createdAt' ? (record.createdAt ?? record.updatedAt) : record.updatedAt
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
}

/** 组合解析 + 过滤，供 provider 与工具层共用（两边都过滤是幂等的）。 */
export function resolveTimeWindow(input   
                 
                 
                     
 )             {
  return {
    ...(input.since !== undefined ? { since: parseTimeBoundary(input.since, false) } : {}),
    ...(input.until !== undefined ? { until: parseTimeBoundary(input.until, true) } : {}),
    timeField: resolveTimeField(input.timeField),
  }
}

/** 记录是否落在时间窗内；时间字段缺失（NaN）视为不匹配（筛选时不应混入）。 */
export function withinTimeWindow(
  record                                            ,
  window            ,
)          {
  const t = timeOf(record, window.timeField)
  if (Number.isNaN(t)) return false
  if (window.since !== undefined && t < window.since) return false
  if (window.until !== undefined && t > window.until) return false
  return true
}


//# sourceURL=source/memory-local/src/time-filter.ts