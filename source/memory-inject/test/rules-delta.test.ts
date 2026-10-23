import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MemoryRecord } from 'dsh-memory'
import {
  RULES_DELTA_HEADER,
  RULES_HEADER,
  extractSection,
  latestSystemText,
  messageText,
  renderRulesBlock,
  renderRulesDeltaBlock,
  ruleLine,
  seenRuleLines,
  type HistoryMessageView,
} from '../src/rules.ts'
import { RulesDeltaInjector, derivedHistoryOf } from '../src/rules-delta.ts'
import { defaultInjectSettings, type RulesSettings } from '../../memory-local/src/inject-settings.ts'

const rulesCfg: RulesSettings = defaultInjectSettings.rules

function rec(content: string, options: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: content,
    scope: 'global',
    kind: 'rule',
    content,
    tags: [],
    source: { origin: 'explicit', at: 0 },
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
    importance: 0.6,
    ...options,
  } as MemoryRecord
}

const systemMessage = (text: string): HistoryMessageView => ({ role: 'system', content: [{ type: 'text', text }] })
const userMessage = (text: string, kind = 'user'): HistoryMessageView => ({
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind },
})

/** 用真实的常驻段渲染结果当"会话里看见过的系统提示",保证两边格式一致。 */
function promptWith(rules: MemoryRecord[], extra = '后续段'): string {
  return `${RULES_HEADER}\n${rules.map(ruleLine).join('\n')}\n\n${extra}`
}

// ---------------------------------------------------------------- 纯函数

test('extractSection 取到段尾就停,没有这一段返回 undefined', () => {
  const text = `前置段\n\n${RULES_HEADER}\n- 规则甲\n- 规则乙\n\n后续段`
  assert.equal(extractSection(text, RULES_HEADER), '\n- 规则甲\n- 规则乙')
  assert.equal(extractSection(text, RULES_DELTA_HEADER), undefined)
  // 段在最后一段时一直取到结尾
  assert.equal(extractSection(`${RULES_HEADER}\n- 只有一条`, RULES_HEADER), '\n- 只有一条')
})

test('latestSystemText 取最后一条非空系统提示', () => {
  const history = [systemMessage('旧的'), systemMessage(''), systemMessage('新的')]
  assert.equal(latestSystemText(history), '新的')
  assert.equal(latestSystemText([userMessage('hi')]), undefined)
  assert.equal(latestSystemText([systemMessage('')]), undefined)
})

test('seenRuleLines 合并系统提示与历史增量块', () => {
  const old = rec('旧规则')
  const added = rec('新规则')
  const history = [
    systemMessage(promptWith([old])),
    userMessage('用户问题'),
    userMessage(`${RULES_DELTA_HEADER}\n${ruleLine(added)}`, 'memory'),
  ]
  const seen = seenRuleLines(history)
  assert.ok(seen.has(ruleLine(old)))
  assert.ok(seen.has(ruleLine(added)))
  assert.equal(seen.size, 2)
})

test('seenRuleLines 只认 memory 来源的增量消息', () => {
  const added = rec('新规则')
  const history = [systemMessage(promptWith([])), userMessage(`${RULES_DELTA_HEADER}\n${ruleLine(added)}`, 'user')]
  assert.equal(seenRuleLines(history).has(ruleLine(added)), false)
})

test('常驻段与增量块用同一种行格式,截断也一致', () => {
  const long = rec(`${'很长'.repeat(200)}`)
  const block = renderRulesBlock([long], { ...rulesCfg, tokenBudget: 4000 })!
  const delta = renderRulesDeltaBlock([long], rulesCfg)!
  assert.equal(block.split('\n')[1], delta.split('\n')[1])
  assert.equal(block.split('\n')[1], ruleLine(long))
  assert.ok(ruleLine(long).includes(`\`${long.id.slice(0, 8)}\``), '规则行必须带 8 位短 ID')
  assert.ok(ruleLine(long).length <= 254)
  assert.ok(block.includes('只注入摘要'), '段头要说明注入的是摘要')
  assert.ok(block.includes('memory_get'), '段头要告诉模型用 memory_get 取全文')
  assert.ok(delta.includes('memory_get'), '增量段头同样要说明取全文的方式')
})

test('renderRulesDeltaBlock 遵守条数上限,空列表返回 null', () => {
  const rules = Array.from({ length: 5 }, (_, i) => rec(`规则 ${i}`, { updatedAt: i }))
  const block = renderRulesDeltaBlock(rules, { ...rulesCfg, maxItems: 2 })!
  assert.equal(block.split('\n').filter((line) => line.startsWith('- ')).length, 2)
  assert.ok(block.includes('另有 3 条规则未展示'), '超限规则必须有可见提示')
  assert.equal(renderRulesDeltaBlock([], rulesCfg), null)
})

test('renderRulesDeltaBlock 的预算比常驻段宽,新的长规则不会被 300 token 直接挤掉', () => {
  const long = rec('规则'.repeat(240)) // 480 字 → 240 token
  const tight = { ...rulesCfg, tokenBudget: 50, maxItems: 10 }
  // 常驻段 50 token 装不下;增量块有自己的下限(600),应当能提醒
  assert.equal(renderRulesBlock([long], tight), null)
  assert.ok(renderRulesDeltaBlock([long], tight))
})

test('messageText 只拼 text 块', () => {
  const msg: HistoryMessageView = {
    role: 'user',
    content: [{ type: 'text', text: '甲' }, { type: 'image' }, { type: 'text', text: '乙' }],
  }
  assert.equal(messageText(msg), '甲\n乙')
})

// ---------------------------------------------------------------- 注入器

let sessionSeq = 0
const agentWith = (history: HistoryMessageView[] | undefined, id = `s${++sessionSeq}`): unknown =>
  history === undefined ? {} : { session: { id, deriveMessages: () => history } }

const memoryWith = (records: MemoryRecord[], scopes: string[] = ['global']) => ({
  resolveReadScopes: () => scopes,
  listSync: (input: { scopes?: string[]; kind?: string }) =>
    records.filter((r) => input.kind === undefined || r.kind === input.kind),
})

test('新会话(还没有系统提示)不补,系统提示会带上全部规则', () => {
  const injector = new RulesDeltaInjector()
  assert.equal(injector.maybeInject(agentWith([]), memoryWith([rec('新规则')]), rulesCfg), undefined)
})

test('新增规则补一次,下一轮没变就不再补', () => {
  const injector = new RulesDeltaInjector()
  const old = rec('旧规则', { id: 'old' })
  const added = rec('新规则', { id: 'new' })
  const id = 'add-session'
  const delta = injector.maybeInject(agentWith([systemMessage(promptWith([old]))], id), memoryWith([old, added]), rulesCfg)!
  assert.ok(delta.includes('新规则'))
  assert.ok(!delta.includes('旧规则'))
  // 宿主把系统提示刷新成新的之后,同一批规则不再提醒
  const after = [systemMessage(promptWith([old, added]))]
  assert.equal(injector.maybeInject(agentWith(after, id), memoryWith([old, added]), rulesCfg), undefined)
})

test('编辑规则:即使系统提示已经刷新成新文本,也要补一次', () => {
  const injector = new RulesDeltaInjector()
  const agentId = 'edit-session'
  const old = rec('旧文本', { id: 'r1' })
  // 第一轮:快照里是旧文本
  assert.equal(injector.maybeInject(agentWith([systemMessage(promptWith([old]))], agentId), memoryWith([old]), rulesCfg), undefined)
  // 用户在会话运行中改了规则 → 系统提示在同一步里刷新成新文本
  const edited = rec('新文本', { id: 'r1' })
  const delta = injector.maybeInject(
    agentWith([systemMessage(promptWith([edited]))], agentId),
    memoryWith([edited]),
    rulesCfg,
  )!
  assert.ok(delta.includes('新文本'))
  assert.ok(!delta.includes('旧文本'))
  // 下一轮已经是新文本,不再重复
  assert.equal(
    injector.maybeInject(agentWith([systemMessage(promptWith([edited]))], agentId), memoryWith([edited]), rulesCfg),
    undefined,
  )
})

test('编辑规则:空闲时改(系统提示还是旧文本)同样补一次', () => {
  const injector = new RulesDeltaInjector()
  const old = rec('旧文本', { id: 'r1' })
  const edited = rec('新文本', { id: 'r1' })
  const delta = injector.maybeInject(agentWith([systemMessage(promptWith([old]))]), memoryWith([edited]), rulesCfg)!
  assert.ok(delta.includes('新文本'))
})

test('会话运行中新加的规则(系统提示已经带上)不重复提醒', () => {
  const injector = new RulesDeltaInjector()
  const id = 'midturn-session'
  const old = rec('旧规则', { id: 'old' })
  injector.maybeInject(agentWith([systemMessage(promptWith([old]))], id), memoryWith([old]), rulesCfg)
  // 规则是 agent 自己在当前这一步里加的 → 系统提示同一步已刷新,模型已经看见
  const added = rec('新规则', { id: 'new' })
  assert.equal(
    injector.maybeInject(agentWith([systemMessage(promptWith([old, added]))], id), memoryWith([old, added]), rulesCfg),
    undefined,
  )
})

test('宿主重启后不会整批重提醒,只补历史里没有的', () => {
  const injector = new RulesDeltaInjector()
  const a = rec('规则甲', { id: 'a' })
  const b = rec('规则乙', { id: 'b' })
  const c = rec('规则丙', { id: 'c' })
  const history = [systemMessage(promptWith([a, b]))]
  const delta = injector.maybeInject(agentWith(history), memoryWith([a, b, c]), rulesCfg)!
  assert.ok(delta.includes('规则丙'))
  assert.ok(!delta.includes('规则甲'))
  assert.ok(!delta.includes('规则乙'))
})

test('拿不到派生历史 / 会话 / listSync 时静默跳过', () => {
  const injector = new RulesDeltaInjector()
  const added = rec('新规则')
  assert.equal(derivedHistoryOf({}), undefined)
  assert.equal(derivedHistoryOf({ session: { deriveMessages: () => 'nope' } }), undefined)
  assert.equal(derivedHistoryOf({ session: { deriveMessages: () => { throw new Error('boom') } } }), undefined)
  assert.equal(injector.maybeInject({}, memoryWith([added]), rulesCfg), undefined)
  assert.equal(injector.maybeInject(agentWith([systemMessage(promptWith([]))]), {}, rulesCfg), undefined)
  const throwing = {
    resolveReadScopes: () => { throw new Error('boom') },
    listSync: () => { throw new Error('boom') },
  }
  assert.equal(injector.maybeInject(agentWith([systemMessage(promptWith([]))]), throwing, rulesCfg), undefined)
})

test('读取范围用 provider 的解析结果', () => {
  const global = rec('全局规则', { id: 'g' })
  const project = rec('项目规则', { id: 'p' })
  const history = [systemMessage(promptWith([]))]
  let asked: string[] = []
  const memory = {
    resolveReadScopes: () => ['project:x', 'global'],
    listSync: (input: { scopes?: string[] }) => {
      asked = input.scopes ?? []
      return [global, project]
    },
  }
  const delta = new RulesDeltaInjector().maybeInject(agentWith(history), memory, rulesCfg)!
  assert.deepEqual(asked, ['project:x', 'global'])
  assert.ok(delta.includes('项目规则'))
  assert.ok(delta.includes('全局规则'))
})
