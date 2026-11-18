/**
 * 0.40.0：before-inject 钩子也管**工具结果**。
 *
 * 用户批准的是「注入摘要只取概括句」这条规则的**行为**，不是某个通道。所以同一批
 * before-inject 脚本必须同时改写：
 *   - memory_search 的 summary
 *   - memory_list 的 content
 *   - memory_get 的 summary 字段（fields 里要了 summary 才改）
 *
 * 这里用最小 service stub 断言工具层自己的职责：改哪个字段、传什么 ctx、崩溃/不支持
 * 时怎么退化、以及**绝不改存储里的正文**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  memoryGetTool,
  memoryListTool,
  memorySearchTool,
  type MemoryToolService,
} from '../src/index.ts'

/** 一条「概括句：正文」格式的记忆；脚本应当只留下冒号前的概括句。 */
const LONG = '注入摘要只取概括句：正文很长，这一段绝对不该出现在摘要里。'

const record = (id: string, content = LONG) => ({
  id,
  scope: 'global',
  kind: 'fact',
  content,
  tags: ['t'],
  importance: 0.8,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
})

/** 记录下每次被调用的 ctx，方便断言 tool / target。 */
interface Call {
  items: Array<{ id: string; text: string }>
  options: { tool: string; target?: 'content' | 'summary'; sessionId?: string }
}

function stubService(calls: Call[], overrides: Partial<MemoryToolService> = {}): MemoryToolService {
  return {
    async save(input) { return record('rec-1', String((input as { content?: string }).content ?? '')) },
    async search() { return [record('rec-1'), record('rec-2')].map((r) => ({ record: r, score: 0.9 })) },
    async forget() { return { removed: 0, ids: [] } },
    async list() { return [record('rec-1'), record('rec-2')] },
    getByIds(ids) { return ids.map((id) => record(id)) },
    parseForToolResult(items, options) {
      calls.push({ items: items.map((item) => ({ id: item.id, text: item.text })), options })
      return {
        // 模拟「只取概括句」：截到第一个全角冒号前。
        texts: items.map((item) => {
          const at = item.text.indexOf('：')
          return at < 0 ? item.text : item.text.slice(0, at)
        }),
        changed: [],
        warnings: [],
      }
    },
    ...overrides,
  }
}

const getService = (s: MemoryToolService) => () => s

test('memory_search：摘要返回前先过 before-inject 脚本，并带上 tool/target', async () => {
  const calls: Call[] = []
  const tool = memorySearchTool({ getService: getService(stubService(calls)) })
  const result = await tool.execute({ query: 'x' }, {})
  assert.equal(result.records.length, 2)
  for (const hit of result.records) {
    assert.equal(hit.summary, '注入摘要只取概括句', '摘要被改写为概括句')
  }
  assert.equal(calls.length, 1, '一批记录只调一次')
  assert.equal(calls[0]!.options.tool, 'memory_search')
  assert.equal(calls[0]!.options.target, 'summary', '摘要通道必须自报 target=summary')
})

test('memory_list：正文返回前先过脚本，target=content', async () => {
  const calls: Call[] = []
  const tool = memoryListTool({ getService: getService(stubService(calls)) })
  const result = await tool.execute({}, {})
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0]!.content, '注入摘要只取概括句')
  assert.equal(calls[0]!.options.tool, 'memory_list')
  assert.equal(calls[0]!.options.target, 'content')
})

test('memory_list：脚本 drop 掉的条目不留在结果里', async () => {
  const service = stubService([], {
    parseForToolResult(items) {
      // 丢掉第二条，其余原样保留。
      return {
        texts: items.map((item, index) => (index === 1 ? null : item.text)),
        changed: [],
        warnings: [],
      }
    },
  })
  const tool = memoryListTool({ getService: getService(service) })
  const result = await tool.execute({}, {})
  assert.deepEqual(result.records.map((r) => r.id), ['rec-1'], 'drop 的整条不出现')
})

test('memory_get：只在 fields 含 summary 时改写，content 永远是原文', async () => {
  const calls: Call[] = []
  const service = stubService(calls)
  const tool = memoryGetTool({ getService: getService(service) })

  const onlySummary = await tool.execute({ ids: ['rec-1'], fields: ['summary'] }, {})
  assert.equal(onlySummary.records[0]!.summary, '注入摘要只取概括句')
  assert.equal(onlySummary.records[0]!.content, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.options.tool, 'memory_get')
  assert.equal(calls[0]!.options.target, 'summary')

  // 只要 content 时不该调钩子：取全文是"看原文"的入口，改它等于读不到原文。
  calls.length = 0
  const onlyContent = await tool.execute({ ids: ['rec-1'], fields: ['content'] }, {})
  assert.equal(onlyContent.records[0]!.content, LONG, '正文原样返回')
  assert.equal(calls.length, 0, '没有 summary 字段就不跑钩子')
})

test('老 provider 没有 parseForToolResult：原样返回，不报错', async () => {
  const service = stubService([], { parseForToolResult: undefined })
  const search = await memorySearchTool({ getService: getService(service) }).execute({ query: 'x' }, {})
  assert.match(search.records[0]!.summary, /正文很长/, '没有钩子通道时保持老行为')

  const list = await memoryListTool({ getService: getService(service) }).execute({}, {})
  assert.equal(list.records[0]!.content, LONG)
})

test('钩子通道抛错：工具调用照常成功，返回原文', async () => {
  const service = stubService([], {
    parseForToolResult() { throw new Error('钩子引擎炸了') },
  })
  const result = await memorySearchTool({ getService: getService(service) }).execute({ query: 'x' }, {})
  assert.equal(result.records.length, 2)
  assert.match(result.records[0]!.summary, /正文很长/, '钩子坏了不影响检索')
})

test('改写只动返回副本，不碰存储里的记录对象', async () => {
  const stored = [record('rec-1'), record('rec-2')]
  const service = stubService([], { async search() { return stored.map((r) => ({ record: r, score: 0.9 })) } })
  const result = await memorySearchTool({ getService: getService(service) }).execute({ query: 'x' }, {})
  assert.equal(result.records[0]!.summary, '注入摘要只取概括句')
  assert.equal(stored[0]!.content, LONG, '存储记录一个字节都没变')
})

test('会话 id 随改写请求传给 provider（脚本能按会话分支）', async () => {
  const calls: Call[] = []
  const service = stubService(calls)
  const tool = memorySearchTool({ getService: getService(service) })
  await tool.execute({ query: 'x' }, { agent: { session: { id: 'sess-42' } } })
  assert.equal(calls[0]!.options.sessionId, 'sess-42')
})
