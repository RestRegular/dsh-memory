import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTimeBoundary,
  resolveTimeField,
  resolveTimeWindow,
  timeOf,
  withinTimeWindow,
} from '../src/time-filter.ts'

test('parseTimeBoundary: 纯日期按本地时区整天边界，不含末日被当 UTC 午夜的坑', () => {
  const start = parseTimeBoundary('2026-11-22', false)!
  const end = parseTimeBoundary('2026-11-22', true)!
  const d = new Date(2026, 10, 22)
  assert.equal(start, new Date(2026, 10, 22, 0, 0, 0, 0).getTime())
  assert.equal(end, new Date(2026, 10, 22, 23, 59, 59, 999).getTime())
  assert.equal(start, d.getTime())
  assert.ok(end - start >= 86_399_000, '整天区间约 24 小时')
})

test('parseTimeBoundary: 完整 ISO 日期时间与数字时间戳精确到毫秒，不被取整', () => {
  const iso = '2026-11-22T10:11:12.345Z'
  assert.equal(parseTimeBoundary(iso, false), Date.parse(iso))
  assert.equal(parseTimeBoundary(1_700_000_000_123, false), 1_700_000_000_123)
  assert.equal(parseTimeBoundary('1700000000123', false), 1_700_000_000_123)
  // endOfDay 只对纯日期生效；完整时间戳原样返回
  assert.equal(parseTimeBoundary(iso, true), Date.parse(iso))
})

test('parseTimeBoundary: 非法日期/NaN/空串明确报错或不参与筛选', () => {
  assert.equal(parseTimeBoundary(undefined, false), undefined)
  assert.equal(parseTimeBoundary('', false), undefined)
  assert.throws(() => parseTimeBoundary('2026-13-40', false), /INVALID_TIME_FILTER/)
  assert.throws(() => parseTimeBoundary('not-a-date', false), /INVALID_TIME_FILTER/)
  assert.throws(() => parseTimeBoundary(Number.NaN, false), /INVALID_TIME_FILTER/)
  assert.throws(() => parseTimeBoundary({}, false), /INVALID_TIME_FILTER/)
})

test('resolveTimeField: 缺省 updatedAt，非法值报错', () => {
  assert.equal(resolveTimeField(undefined), 'updatedAt')
  assert.equal(resolveTimeField('createdAt'), 'createdAt')
  assert.throws(() => resolveTimeField('lastAccessedAt'), /INVALID_TIME_FIELD/)
})

test('timeOf: createdAt 缺失时退回 updatedAt', () => {
  assert.equal(timeOf({ updatedAt: 5, createdAt: 3 }, 'createdAt'), 3)
  assert.equal(timeOf({ updatedAt: 5 }, 'createdAt'), 5)
  assert.equal(timeOf({ createdAt: 3 }, 'updatedAt'), Number.NaN)
})

test('withinTimeWindow: 闭区间 [since, until]，边界包含', () => {
  const win = resolveTimeWindow({ since: 100, until: 200, timeField: 'updatedAt' })
  assert.equal(withinTimeWindow({ updatedAt: 99 }, win), false)
  assert.equal(withinTimeWindow({ updatedAt: 100 }, win), true)
  assert.equal(withinTimeWindow({ updatedAt: 150 }, win), true)
  assert.equal(withinTimeWindow({ updatedAt: 200 }, win), true)
  assert.equal(withinTimeWindow({ updatedAt: 201 }, win), false)
  assert.equal(withinTimeWindow({}, win), false, '无时间戳的记录不混入筛选结果')
})

test('resolveTimeWindow: since>until 不自动交换（不静默改用户意图）', () => {
  const win = resolveTimeWindow({ since: 200, until: 100 })
  assert.equal(withinTimeWindow({ updatedAt: 150 }, win), false)
})
