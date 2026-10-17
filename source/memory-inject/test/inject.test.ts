import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickQueryText,
  renderRecallBlock,
  hasRecallMessage,
  MemoryInjector,
  defaultInjectConfig,
  type MemoryHit,
} from '../src/inject.ts'
import type { MemoryRecord } from 'dsh-memory'

function hit(content: string, score = 0.8, id = content): MemoryHit {
  const record: MemoryRecord = {
    id,
    scope: 'project:t',
    kind: 'note',
    content,
    tags: [],
    source: { origin: 'explicit', at: 0 },
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
    importance: 0.5,
  }
  return { record, score }
}

const msg = (role: string, text: string) => ({ role, content: [{ type: 'text', text }] })

test('pickQueryText takes the last user message text', () => {
  const messages = [
    msg('user', '第一条'),
    msg('assistant', '回复'),
    msg('user', '帮我查 postgres 索引'),
  ]
  assert.equal(pickQueryText(messages), '帮我查 postgres 索引')
  assert.equal(pickQueryText([msg('assistant', 'only assistant')]), '')
  assert.equal(pickQueryText([]), '')
})

test('renderRecallBlock respects token budget and topK', () => {
  const cfg = { ...defaultInjectConfig, tokenBudget: 80, topK: 5 }
  const hits = Array.from({ length: 8 }, (_, i) => hit(`记忆 ${i}：${'内容'.repeat(20)}`, 0.9, `id-${i}`))
  const block = renderRecallBlock(hits, cfg)
  assert.ok(block)
  assert.ok(block!.tokens <= 80, `within budget, got ${block!.tokens}`)
  assert.ok(block!.text.includes('memory_search'))
  // topK cap
  const rich = { ...defaultInjectConfig, tokenBudget: 10_000, topK: 3 }
  const block2 = renderRecallBlock(hits, rich)!
  assert.equal(block2.text.split('\n').length - 1, 3)
  // empty hits → null
  assert.equal(renderRecallBlock([], defaultInjectConfig), null)
  // budget smaller than the header alone → null, not a header-only block
  assert.equal(renderRecallBlock(hits, { ...defaultInjectConfig, tokenBudget: 10 }), null)
})

test('injector returns the recall text for the host to wrap into a real message', async () => {
  const hits = [hit('用户偏好 TypeScript', 0.9)]
  const search = async () => hits
  const injector = new MemoryInjector(search, defaultInjectConfig)
  const input = { messages: [msg('user', '写一个插件')] }
  const decision = { messages: [msg('user', '写一个插件')] }

  const first = await injector.maybeInject(input, decision)
  assert.ok(first, 'first call yields recall text')
  assert.equal(typeof first, 'string')
  assert.ok(first!.includes('用户偏好 TypeScript'))
  // the host builds the message; this layer must never hand back a bare object
  assert.equal(typeof first === 'object', false)

  const second = await injector.maybeInject(input, decision)
  assert.equal(second, undefined, 'identical recall suppressed')

  const changed = { messages: [msg('user', '另一个问题')] }
  const third = await injector.maybeInject(changed, changed)
  // same hits → same rendered block → still suppressed
  assert.equal(third, undefined)
})

test('injector passes through on empty query or search failure', async () => {
  const injector = new MemoryInjector(async () => [hit('x')], defaultInjectConfig)
  assert.equal(await injector.maybeInject({ messages: [] }, { messages: [] }), undefined)
  const failing = new MemoryInjector(async () => { throw new Error('down') }, defaultInjectConfig)
  const input = { messages: [msg('user', 'q')] }
  assert.equal(await failing.maybeInject(input, input), undefined)
})

test('injector respects disabled config and empty hit list', async () => {
  const off = new MemoryInjector(async () => [hit('x')], { ...defaultInjectConfig, enabled: false })
  const input = { messages: [msg('user', 'q')] }
  assert.equal(await off.maybeInject(input, input), undefined)
  const empty = new MemoryInjector(async () => [], defaultInjectConfig)
  assert.equal(await empty.maybeInject(input, input), undefined)
})

test('hasRecallMessage catches a duplicate recall block from a second activation', () => {
  const text = '以下是与此请求可能相关的长期记忆，供参考（可用 memory_search 核实，用 memory_forget 删除）：\n- 一条记忆'
  const sourced = (role: string, body: string, kind?: string) => ({
    role,
    content: [{ type: 'text', text: body }],
    ...(kind === undefined ? {} : { source: { kind } }),
  })
  // 同一段召回块已经在 decision 里 → 第二次注入必须跳过
  assert.equal(hasRecallMessage([sourced('user', '你好'), sourced('user', text, 'memory')], text), true)
  // 普通用户消息不算
  assert.equal(hasRecallMessage([sourced('user', text, 'user')], text), false)
  // 记忆消息但内容不同 / 角色不是 user → 不算
  assert.equal(hasRecallMessage([sourced('user', '别的块', 'memory')], text), false)
  assert.equal(hasRecallMessage([sourced('assistant', text, 'memory')], text), false)
  assert.equal(hasRecallMessage([], text), false)
})
