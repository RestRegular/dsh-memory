/**
 * 0.45.0：注入提示词可改 —— 每条通道的渲染器都必须用**设置里的那份**，
 * 而不是内置常量；留空 / 空白回退内置默认（注入路径不能因为清空文本框就少一段上下文）。
 *
 * 这里逐个通道验证三件事：
 *   1. 默认设置渲染出来 = 内置默认文案（老 settings.json 行为不变）；
 *   2. 改设置后渲染结果跟着变（文案真的来自设置）；
 *   3. 设置里放空串 / 纯空白时回退默认，不会渲染出空表头。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MemoryRecord } from 'dsh-memory'
import { defaultInjectSettings, normalizeInjectSettings } from '../../memory-local/src/inject-settings.ts'
import {
  DEFAULT_DIGEST_HINT_FOOTER,
  DEFAULT_DIGEST_HINT_PROMPT,
  DEFAULT_DIGEST_PROMPT,
  DEFAULT_IMPRESSION_PROMPT,
  DEFAULT_POLICY_PROMPT,
  DEFAULT_PROCEDURES_PROMPT,
  DEFAULT_RECALL_PROMPT,
  DEFAULT_RULES_DELTA_PROMPT,
  DEFAULT_RULES_PROMPT,
  DEFAULT_TURN_END_PROMPT,
  resolvePrompt,
} from '../../memory-local/src/inject-prompts.ts'
import { renderDigest } from '../src/digest.ts'
import { renderRecallBlock } from '../src/inject.ts'
import { renderProcedureIndex } from '../src/procedures.ts'
import { renderRules, renderRulesDelta } from '../src/rules.ts'
import { POLICY_TEXT } from '../src/policy.ts'

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'abcdef12-0000-4000-8000-000000000000',
    scope: 'project:D:/repo',
    kind: 'fact',
    content: '发布前先检查凭据',
    tags: ['release'],
    source: { origin: 'explicit', at: 0 },
    createdAt: 0,
    updatedAt: 1_000,
    lastAccessedAt: 0,
    accessCount: 0,
    importance: 0.9,
    ...overrides,
  } as MemoryRecord
}

test('resolvePrompt: 空串 / 纯空白 / 非字符串回退默认,非空原样返回', () => {
  assert.equal(resolvePrompt('自定义', '默认'), '自定义')
  assert.equal(resolvePrompt('', '默认'), '默认')
  assert.equal(resolvePrompt('  \n\t ', '默认'), '默认')
  assert.equal(resolvePrompt(undefined, '默认'), '默认')
  assert.equal(resolvePrompt(null, '默认'), '默认')
  assert.equal(resolvePrompt(42, '默认'), '默认')
  // 前导/尾随空白不清洗：用户可能故意用空行排版。
  assert.equal(resolvePrompt('  自定义\n', '默认'), '  自定义\n')
})

test('策略段:POLICY_TEXT 就是默认值,设置可整段替换', () => {
  assert.equal(POLICY_TEXT, DEFAULT_POLICY_PROMPT)
  const custom = normalizeInjectSettings({ policy: { prompt: '## 我的策略\n先查记忆。' } })
  assert.equal(custom.policy.prompt, '## 我的策略\n先查记忆。')
  // 清空回退：策略段是模型知道有哪些工具的唯一常驻入口，不能变空。
  assert.equal(normalizeInjectSettings({ policy: { prompt: '' } }).policy.prompt, DEFAULT_POLICY_PROMPT)
})

test('召回块:默认用内置表头,改设置后表头跟着变', () => {
  const hit = { record: record(), score: 0.9 }
  const plain = renderRecallBlock([hit], defaultInjectSettings.recall)
  assert.ok(plain)
  assert.ok(plain!.text.startsWith(DEFAULT_RECALL_PROMPT))

  const custom = renderRecallBlock([hit], { ...defaultInjectSettings.recall, prompt: '召回-自定义表头：' })
  assert.ok(custom!.text.startsWith('召回-自定义表头：'))
  assert.ok(!custom!.text.includes(DEFAULT_RECALL_PROMPT))

  // 印象形态有自己的表头（口径不同，不能共用）。
  const impression = renderRecallBlock([hit], { ...defaultInjectSettings.recall, prompt: '不该用这条' }, { impression: true })
  assert.ok(impression!.text.startsWith(DEFAULT_IMPRESSION_PROMPT))
  const impressionCustom = renderRecallBlock(
    [hit],
    { ...defaultInjectSettings.recall, prompt: '不该用这条' },
    { impression: true, prompt: '印象-自定义表头：' },
  )
  assert.ok(impressionCustom!.text.startsWith('印象-自定义表头：'))
})

test('摘要:正文表头、索引表头、索引结尾都可改,默认仍是内置文案', () => {
  const records = [record({ id: 'a'.repeat(8) + '-0000-4000-8000-000000000000' })]
  const plain = renderDigest(records, defaultInjectSettings.digest)
  assert.ok(plain)
  assert.ok(plain!.text.startsWith(DEFAULT_DIGEST_PROMPT))

  const custom = renderDigest(records, {
    ...defaultInjectSettings.digest,
    prompt: '摘要-自定义表头：',
    hintPrompt: '索引-自定义表头：',
    hintFooter: '索引-自定义结尾。',
  })
  assert.ok(custom!.text.startsWith('摘要-自定义表头：'))

  // 触发索引：topK=1 + 两条记录 → 第二条被省略进标签索引。
  const withHint = renderDigest(
    [record({ id: 'a'.repeat(8) + '-0000-4000-8000-000000000000' }), record({ id: 'b'.repeat(8) + '-0000-4000-8000-000000000000', content: '另一条' })],
    { ...defaultInjectSettings.digest, topK: 1, prompt: '摘要-自定义表头：', hintPrompt: '索引-自定义表头：', hintFooter: '索引-自定义结尾。' },
  )
  assert.ok(withHint!.text.includes('索引-自定义表头：'), '索引表头应来自设置')
  assert.ok(withHint!.text.includes('索引-自定义结尾。'), '索引结尾应来自设置')
  assert.ok(!withHint!.text.includes(DEFAULT_DIGEST_HINT_PROMPT))
  assert.ok(!withHint!.text.includes(DEFAULT_DIGEST_HINT_FOOTER))
})

test('规则段与增量块:表头可改,默认仍是内置文案', () => {
  const rule = record({ kind: 'rule', content: '发布前先查记忆' })
  assert.ok(renderRules([rule], defaultInjectSettings.rules).text.startsWith(DEFAULT_RULES_PROMPT))
  assert.ok(renderRulesDelta([rule], defaultInjectSettings.rules).text.startsWith(DEFAULT_RULES_DELTA_PROMPT))

  const custom = { ...defaultInjectSettings.rules, prompt: '规则-自定义表头：', deltaPrompt: '增量-自定义表头：' }
  assert.ok(renderRules([rule], custom).text.startsWith('规则-自定义表头：'))
  assert.ok(renderRulesDelta([rule], custom).text.startsWith('增量-自定义表头：'))
  // 增量块预算比常驻段宽这条老行为不能被提示词改动带坏。
  assert.ok(renderRulesDelta([rule], custom).tokens > 0)
})

test('流程索引:表头可改,默认仍是内置文案', () => {
  const procedure = record({ kind: 'procedure', scope: 'project:D:/repo', triggers: ['发布'] })
  const plain = renderProcedureIndex([procedure], defaultInjectSettings.procedures, { projectScopes: ['project:D:/repo'] })
  assert.ok(plain)
  assert.ok(plain!.text.startsWith(DEFAULT_PROCEDURES_PROMPT))

  const custom = renderProcedureIndex(
    [procedure],
    { ...defaultInjectSettings.procedures, prompt: '流程-自定义表头：' },
    { projectScopes: ['project:D:/repo'] },
  )
  assert.ok(custom!.text.startsWith('流程-自定义表头：'))
  assert.ok(!custom!.text.includes(DEFAULT_PROCEDURES_PROMPT))
})

test('提示词默认值导出与设置里的默认值一致', () => {
  // 两处若漂移，注入路径的"留空回退"就会和面板显示不一致。
  assert.equal(defaultInjectSettings.recall.prompt, DEFAULT_RECALL_PROMPT)
  assert.equal(defaultInjectSettings.impression.prompt, DEFAULT_IMPRESSION_PROMPT)
  assert.equal(defaultInjectSettings.digest.prompt, DEFAULT_DIGEST_PROMPT)
  assert.equal(defaultInjectSettings.digest.hintPrompt, DEFAULT_DIGEST_HINT_PROMPT)
  assert.equal(defaultInjectSettings.digest.hintFooter, DEFAULT_DIGEST_HINT_FOOTER)
  assert.equal(defaultInjectSettings.policy.prompt, DEFAULT_POLICY_PROMPT)
  assert.equal(defaultInjectSettings.rules.prompt, DEFAULT_RULES_PROMPT)
  assert.equal(defaultInjectSettings.rules.deltaPrompt, DEFAULT_RULES_DELTA_PROMPT)
  assert.equal(defaultInjectSettings.procedures.prompt, DEFAULT_PROCEDURES_PROMPT)
  assert.equal(defaultInjectSettings.turnEnd.prompt, DEFAULT_TURN_END_PROMPT)
})
