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
  unseenRules,
  type HistoryMessageView,
} from '../src/rules.ts'
import { defaultInjectSettings, type RulesSettings } from '../../memory-local/src/inject-settings.ts'
import { derivedHistoryOf, ruleDeltaText } from '../src/rules-delta.ts'

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

test('unseenRules + renderRulesDeltaBlock 只提醒这个会话没见过的规则', () => {
  const old = rec('旧规则', { id: 'old', importance: 0.9 })
  const added = rec('新规则', { id: 'new', importance: 0.4 })
  const history = [systemMessage(promptWith([old]))]
  const added2 = unseenRules([old, added], seenRuleLines(history))
  assert.deepEqual(added2.map((r) => r.id), ['new'])

  const block = renderRulesDeltaBlock(added2, rulesCfg)!
  assert.ok(block.startsWith(RULES_DELTA_HEADER))
  assert.ok(block.includes('新规则'))
  assert.ok(!block.includes('旧规则'))

  // 增量块本身也算"看见过" —— 下一轮不再重复
  const nextSeen = seenRuleLines([...history, userMessage(block, 'memory')])
  assert.deepEqual(unseenRules([old, added], nextSeen).map((r) => r.id), [])
})

test('常驻段与增量块用同一种行格式,截断也一致', () => {
  const long = rec(`${'很长'.repeat(200)}`)
  const block = renderRulesBlock([long], { ...rulesCfg, tokenBudget: 4000 })!
  const delta = renderRulesDeltaBlock([long], rulesCfg)!
  assert.equal(block.split('\n')[1], delta.split('\n')[1])
  assert.equal(block.split('\n')[1], ruleLine(long))
  assert.ok(ruleLine(long).length <= 242)
})

test('renderRulesDeltaBlock 遵守条数上限,空列表返回 null', () => {
  const rules = Array.from({ length: 5 }, (_, i) => rec(`规则 ${i}`, { updatedAt: i }))
  const block = renderRulesDeltaBlock(rules, { ...rulesCfg, maxItems: 2 })!
  assert.equal(block.split('\n').length - 1, 2)
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

// ---------------------------------------------------------------- 宿主胶水

const agentWith = (history: HistoryMessageView[] | undefined): unknown =>
  history === undefined ? {} : { session: { deriveMessages: () => history } }

const memoryWith = (records: MemoryRecord[], scopes: string[] = ['global']) => ({
  resolveReadScopes: () => scopes,
  listSync: (input: { scopes?: string[]; kind?: string }) =>
    records.filter((r) => input.kind === undefined || r.kind === input.kind),
})

test('ruleDeltaText:旧会话只补系统提示里还没有的规则', () => {
  const old = rec('旧规则', { id: 'old' })
  const added = rec('新规则', { id: 'new' })
  const history = [systemMessage(promptWith([old])), userMessage('继续')]
  const delta = ruleDeltaText(agentWith(history), memoryWith([old, added]), rulesCfg)!
  assert.ok(delta.includes('新规则'))
  assert.ok(!delta.includes('旧规则'))
})

test('ruleDeltaText:新会话(还没有系统提示)不补,系统提示会带上全部规则', () => {
  const added = rec('新规则')
  assert.equal(ruleDeltaText(agentWith([]), memoryWith([added]), rulesCfg), undefined)
})

test('ruleDeltaText:同一批规则补过一次就不重复', () => {
  const old = rec('旧规则', { id: 'old' })
  const added = rec('新规则', { id: 'new' })
  const first = ruleDeltaText(agentWith([systemMessage(promptWith([old]))]), memoryWith([old, added]), rulesCfg)!
  const history = [systemMessage(promptWith([old])), userMessage(first, 'memory')]
  assert.equal(ruleDeltaText(agentWith(history), memoryWith([old, added]), rulesCfg), undefined)
})

test('ruleDeltaText:规则已经进了系统提示之后不再提醒', () => {
  const added = rec('新规则')
  const history = [systemMessage(promptWith([added]))]
  assert.equal(ruleDeltaText(agentWith(history), memoryWith([added]), rulesCfg), undefined)
})

test('ruleDeltaText:拿不到派生历史 / 会话 / listSync 时静默跳过', () => {
  const added = rec('新规则')
  assert.equal(derivedHistoryOf({}), undefined)
  assert.equal(derivedHistoryOf({ session: { deriveMessages: () => 'nope' } }), undefined)
  assert.equal(derivedHistoryOf({ session: { deriveMessages: () => { throw new Error('boom') } } }), undefined)
  assert.equal(ruleDeltaText({}, memoryWith([added]), rulesCfg), undefined)
  assert.equal(ruleDeltaText(agentWith([systemMessage(promptWith([]))]), {}, rulesCfg), undefined)
  const throwing = {
    resolveReadScopes: () => { throw new Error('boom') },
    listSync: () => { throw new Error('boom') },
  }
  assert.equal(ruleDeltaText(agentWith([systemMessage(promptWith([]))]), throwing, rulesCfg), undefined)
})

test('ruleDeltaText:读取范围用 provider 的解析结果', () => {
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
  const delta = ruleDeltaText(agentWith(history), memory, rulesCfg)!
  assert.deepEqual(asked, ['project:x', 'global'])
  assert.ok(delta.includes('项目规则'))
  assert.ok(delta.includes('全局规则'))
})
