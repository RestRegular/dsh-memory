import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GET_FIELDS,
  memoryGetTool,
  memorySearchTool,
  resolveGetFields,
  summarize,
} from '../src/index.ts'
import { renderGetResult, renderSearchResult } from '../src/render.ts'

const LONG = '长'.repeat(300)

const record = {
  id: 'abcdef12-3456-7890-abcd-ef1234567890',
  scope: 'global',
  kind: 'fact',
  content: LONG,
  tags: ['pnpm', 'toolchain'],
  importance: 0.8,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_086_400_000,
  expiredAt: 1_800_000_000_000,
  supersedes: '12345678-aaaa-bbbb-cccc-ddddeeeeffff',
  triggers: ['npm', 'publish'],
}

const bare = {
  id: '00000000-1111-2222-3333-444444444444',
  scope: 'session:s1',
  kind: 'note',
  content: '只有基本字段的一条',
  tags: [],
  importance: 0.2,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
}

const service = {
  save: async () => ({ id: record.id, scope: record.scope }),
  search: async () => [{ record, score: 0.812 }],
  forget: async () => ({ removed: 0, ids: [] }),
  list: async () => [],
  getByIds: (ids: string[]) => [record, bare].filter((r) => ids.some((id) => r.id === id || r.id.startsWith(id))),
}

const label = (scope: string): string => (scope === 'global' ? '全局' : scope)

test('memory_search 只返回印象：id/作用域/类型/标签/摘要，不带正文', async () => {
  const tool = memorySearchTool({ getService: () => service })
  const result = await tool.execute({ query: 'pnpm' })
  const hit = result.records[0]!
  assert.equal('content' in hit, false, '搜索结果不能带正文')
  assert.equal(hit.id, record.id)
  assert.equal(hit.kind, 'fact')
  assert.deepEqual(hit.tags, ['pnpm', 'toolchain'])
  assert.equal(hit.summary, summarize(LONG), '摘要默认 160 字 + 省略号')
  assert.equal(hit.summary.length, 161)
  assert.ok(hit.summary.endsWith('…'))
})

test('memory_search 的 summaryChars 可调，且有上下界', async () => {
  const tool = memorySearchTool({ getService: () => service })
  assert.equal((await tool.execute({ query: 'pnpm', summaryChars: 20 })).records[0]!.summary, `${'长'.repeat(20)}…`)
  // 低于 20 按 20 处理（少量摘要也不能退化成几个字）
  assert.equal((await tool.execute({ query: 'pnpm', summaryChars: 1 })).records[0]!.summary, `${'长'.repeat(20)}…`)
})

test('memory_get 默认字段与原行为一致：content + scope + kind + tags', async () => {
  const tool = memoryGetTool({ getService: () => service })
  const result = await tool.execute({ ids: [record.id] })
  assert.deepEqual(result.fields, ['content', 'scope', 'kind', 'tags'])
  assert.deepEqual(Object.keys(result.records[0]!).sort(), ['content', 'id', 'kind', 'scope', 'tags'])
  assert.equal(result.records[0]!.content, LONG)
})

test('memory_get 可按需只取摘要 / 标签 / 重要度', async () => {
  const tool = memoryGetTool({ getService: () => service })
  const result = await tool.execute({ ids: [record.id.slice(0, 8)], fields: ['summary', 'tags', 'importance'], summaryChars: 24 })
  assert.deepEqual(result.fields, ['summary', 'tags', 'importance'])
  assert.deepEqual(result.records[0], {
    id: record.id,
    summary: `${'长'.repeat(24)}…`,
    tags: ['pnpm', 'toolchain'],
    importance: 0.8,
  })
})

test('memory_get 元数据字段：时间 / 过期 / 触发词 / 修正链', async () => {
  const tool = memoryGetTool({ getService: () => service })
  const fields = ['createdAt', 'updatedAt', 'expiresAt', 'triggers', 'supersedes'] as const
  const result = await tool.execute({ ids: [record.id], fields: [...fields] })
  assert.deepEqual(result.records[0], {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiredAt,
    triggers: ['npm', 'publish'],
    supersedes: record.supersedes,
  })
  // 没有这些字段的记录不应该凭空补 undefined
  const minimal = await tool.execute({ ids: [bare.id], fields: [...fields] })
  assert.deepEqual(minimal.records[0], { id: bare.id, createdAt: bare.createdAt, updatedAt: bare.updatedAt })
  assert.equal('expiresAt' in minimal.records[0]!, false)
  assert.equal('triggers' in minimal.records[0]!, false)
  assert.equal('supersedes' in minimal.records[0]!, false)
})

test('memory_get fields 接受逗号分隔字符串，未知字段/空列表明确报错', async () => {
  const tool = memoryGetTool({ getService: () => service })
  const parsed = await tool.execute({ ids: [record.id], fields: 'summary, tags' })
  assert.deepEqual(parsed.fields, ['summary', 'tags'])
  assert.deepEqual(resolveGetFields(undefined), ['content', 'scope', 'kind', 'tags'])
  assert.deepEqual(resolveGetFields([...GET_FIELDS]), [...GET_FIELDS])
  assert.throws(() => resolveGetFields(['nope']), /unknown field/i)
  assert.throws(() => resolveGetFields([]), /不能为空/)
  assert.throws(() => resolveGetFields([123]), /unknown field/i)
})

test('memory_get 找不到的 id 进 missing', async () => {
  const tool = memoryGetTool({ getService: () => service })
  const result = await tool.execute({ ids: ['deadbeef'] })
  assert.equal(result.records.length, 0)
  assert.deepEqual(result.missing, ['deadbeef'])
})

test('renderSearchResult：一行一条，含分数/短 id/标签/摘要，不含全文', () => {
  const text = renderSearchResult(
    {
      records: [{
        id: record.id,
        score: 0.812,
        scope: 'global',
        kind: 'fact',
        tags: ['pnpm'],
        updatedAt: record.updatedAt,
        summary: '短摘要',
      }],
    },
    label,
  )
  assert.equal(text, '[0.812] abcdef12 (全局/fact · pnpm) 短摘要')
  assert.equal(renderSearchResult({ records: [] }, label), '没有找到相关记忆。')
})

test('renderGetResult：默认正文 + 基本元数据；只取字段时不输出正文行', () => {
  const full = renderGetResult(
    {
      records: [{ id: record.id, content: LONG, scope: 'global', kind: 'fact', tags: ['pnpm', 'toolchain'] }],
      fields: ['content', 'scope', 'kind', 'tags'],
      missing: [],
    },
    label,
  )
  assert.equal(full, `[${record.id}] (全局/fact · 标签 pnpm, toolchain)\n${LONG}`)

  const summary = renderGetResult(
    {
      records: [{ id: record.id, summary: '短摘要', tags: ['pnpm'] }],
      fields: ['summary', 'tags'],
      missing: [],
    },
    label,
  )
  assert.equal(summary, `[${record.id}] (标签 pnpm)\n摘要：短摘要`)

  const onlyTags = renderGetResult(
    { records: [{ id: record.id, tags: ['pnpm'] }], fields: ['tags'], missing: [] },
    label,
  )
  assert.equal(onlyTags, `[${record.id}] (标签 pnpm)`)

  const missing = renderGetResult({ records: [], fields: ['content'], missing: ['deadbeef'] }, label)
  assert.equal(missing, '未找到：deadbeef')
  assert.equal(renderGetResult({ records: [], fields: ['content'], missing: [] }, label), '没有找到记忆。')
})

test('被可见域挡住时渲染真实原因:拒绝/超时/无法审批;绝对限制不出现 withheld', () => {
  const rejected = renderSearchResult({ records: [], withheld: { count: 3, reason: 'rejected' } }, label)
  assert.match(rejected, /没有找到可见范围内的相关记忆/)
  assert.match(rejected, /另有 3 条记忆/)
  assert.match(rejected, /用户拒绝了本次访问/)
  assert.match(rejected, /调整「记忆范围」/)

  const timeout = renderGetResult(
    { records: [], fields: ['content'], missing: ['deadbeef'], withheld: { count: 1, reason: 'timeout' } },
    label,
  )
  assert.match(timeout, /未找到：deadbeef/)
  assert.match(timeout, /5 分钟内没有得到答复/)
  assert.match(timeout, /按拒绝处理/)

  const unavailable = renderSearchResult({ records: [], withheld: { count: 2, reason: 'unavailable' } }, label)
  assert.match(unavailable, /无法发起审批/)

  // 有命中也有 withheld:正文照常渲染,原因跟在后面。
  const mixed = renderSearchResult({
    records: [{
      id: record.id,
      score: 0.5,
      scope: 'global',
      kind: 'fact',
      tags: [],
      updatedAt: record.updatedAt,
      summary: '短摘要',
    }],
    withheld: { count: 1, reason: 'rejected' },
  }, label)
  assert.match(mixed, /\[0\.500\] abcdef12 \(全局\/fact\) 短摘要/)
  assert.match(mixed, /用户拒绝了本次访问/)
})
