import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryGetRequestsContent, memoryGetResultIds } from '../src/signals.ts'
import { InjectionState } from '../src/state.ts'

const A = 'abcdef12-3456-7890-abcd-ef1234567890'
const B = '12345678-1111-2222-3333-444444444444'

test('memory_get 是否取正文：fields 省略或包含 content 才算', () => {
  assert.equal(memoryGetRequestsContent({ ids: [A] }), true, '省略 fields = 默认含正文')
  assert.equal(memoryGetRequestsContent(JSON.stringify({ ids: [A] })), true, 'arguments 是 JSON 字符串')
  assert.equal(memoryGetRequestsContent({ ids: [A], fields: ['content'] }), true)
  assert.equal(memoryGetRequestsContent({ ids: [A], fields: 'summary, content' }), true)
  assert.equal(memoryGetRequestsContent({ ids: [A], fields: ['summary'] }), false, '只取摘要不是正文')
  assert.equal(memoryGetRequestsContent({ ids: [A], fields: ['tags', 'updatedAt'] }), false)
  assert.equal(memoryGetRequestsContent('not json'), false)
  assert.equal(memoryGetRequestsContent(null), false)
})

test('memory_get 结果文本：只认记录头部的 id，正文里的方括号不算', () => {
  const rendered = [
    `[${A}] (全局/fact · 标签 pnpm)`,
    '正文第一行',
    '[提示] 这一行不是 id',
    '',
    `[${B}] (会话/note)`,
    '另一条正文',
  ].join('\n')
  const event = { data: { message: { content: [{ type: 'text', text: rendered }] } } }
  assert.deepEqual(memoryGetResultIds(event), [A, B])
  // 重复的头部只取一次
  const twice = { data: { message: { content: [{ type: 'text', text: `[${A}]\n[${A}]` }] } } }
  assert.deepEqual(memoryGetResultIds(twice), [A])
  // 没有 tool/result message 时安静返回空
  assert.deepEqual(memoryGetResultIds(undefined), [])
  assert.deepEqual(memoryGetResultIds({ data: { message: { content: [] } } }), [])
})

test('memory_get 结果若是结构化 JSON，也兼容 records[].id', () => {
  const text = JSON.stringify({ records: [{ id: A }, { id: B }], missing: [] })
  const event = { data: { message: { content: [{ type: 'text', text }] } } }
  assert.deepEqual(memoryGetResultIds(event), [A, B])
})

test('memory_get 取正文后写入 content_injected，后续召回不再重复注入同一条', () => {
  const state = new InjectionState()
  const records = [{ id: A, updatedAt: 100 }, { id: B, updatedAt: 200 }]
  assert.equal(state.filterNewContent('s1', records).deduplicated.length, 0)

  state.markContent('s1', records)
  const after = state.filterNewContent('s1', records)
  assert.deepEqual(after.deduplicated, [A, B])
  assert.equal(after.fresh.length, 0)

  // 记录更新后版本变化 → 允许重新评估/注入
  const updated = state.filterNewContent('s1', [{ id: A, updatedAt: 101 }, { id: B, updatedAt: 200 }])
  assert.deepEqual(updated.updated, [A])
  assert.deepEqual(updated.fresh.map((record) => record.id), [A])

  // 只取摘要（没有标记正文）时仍可被召回
  const summaryOnly = new InjectionState()
  const summary = summaryOnly.filterNewContent('s1', records)
  assert.deepEqual(summary.fresh.map((record) => record.id), [A, B])

  // 另一会话不受影响
  assert.deepEqual(state.filterNewContent('s2', records).fresh.map((record) => record.id), [A, B])
})
