import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateTokens,
  DailyBudget,
  buildRerankPrompt,
  parseRerankOutput,
  rerank,
  blendScores,
  defaultRerankConfig,
  type RerankCandidate,
} from '../src/rerank.ts'

test('estimateTokens is a positive char-based estimate', () => {
  assert.ok(estimateTokens('') === 0)
  assert.ok(estimateTokens('abcd') >= 2)
})

test('DailyBudget spends within limit and resets next day', () => {
  const b = new DailyBudget(100)
  assert.equal(b.trySpend(60), true)
  assert.equal(b.trySpend(60), false) // would exceed
  assert.equal(b.trySpend(40), true)
  assert.equal(b.usedToday, 100)
})

test('buildRerankPrompt includes ids and truncated content', () => {
  const { system, prompt } = buildRerankPrompt('q', [{ id: 'a', content: 'x'.repeat(600), recallScore: 1 }])
  assert.ok(system.includes('JSON'))
  assert.ok(prompt.includes('[a]'))
  assert.ok(prompt.length < 1000, 'content truncated to 500 chars')
})

test('parseRerankOutput accepts JSON array, filters junk and unknown ids', () => {
  const valid = new Set(['a', 'b'])
  const out = parseRerankOutput(`好的：[[\"a\", 0.9], [\"b\", \"0.4\"], [\"zzz\", 1], [\"a\", \"oops\"], [\"c\", 0.5]]`, valid)
  assert.equal(out.get('a'), 0.9)
  assert.equal(out.get('b'), 0.4) // numeric string coerced
  assert.equal(out.has('zzz'), false) // unknown id
  assert.equal(out.has('c'), false)
  // prose around the array is tolerated; garbage returns empty
  assert.equal(parseRerankOutput('完全不是 JSON', valid).size, 0)
  assert.equal(parseRerankOutput('[1, 2, 3]', valid).size, 0)
})

const cands: RerankCandidate[] = [
  { id: 'a', content: 'alpha', recallScore: 0.8 },
  { id: 'b', content: 'beta', recallScore: 0.6 },
]

test('rerank degrades to null on disabled / no invoke / tiny candidate set', async () => {
  const budget = new DailyBudget(10_000)
  const cfg = { ...defaultRerankConfig }
  assert.equal(await rerank({ invoke: null, cfg, query: 'q', candidates: cands, budget }), null)
  assert.equal(await rerank({ invoke: async () => '[]', cfg: { ...cfg, enabled: false }, query: 'q', candidates: cands, budget }), null)
  assert.equal(await rerank({ invoke: async () => '[]', cfg, query: 'q', candidates: [cands[0]!], budget }), null)
})

test('rerank returns null when budget is exhausted', async () => {
  const budget = new DailyBudget(1)
  const outcome = await rerank({ invoke: async () => '[[\"a\",1]]', cfg: defaultRerankConfig, query: 'q', candidates: cands, budget })
  assert.equal(outcome, null)
})

test('rerank returns null on invoke failure or unparseable output', async () => {
  const budget = new DailyBudget(1_000_000)
  assert.equal(
    await rerank({ invoke: async () => { throw new Error('boom') }, cfg: defaultRerankConfig, query: 'q', candidates: cands, budget }),
    null,
  )
  assert.equal(
    await rerank({ invoke: async () => '我不会输出 JSON', cfg: defaultRerankConfig, query: 'q', candidates: cands, budget }),
    null,
  )
})

test('rerank happy path scores valid ids and charges tokens', async () => {
  const budget = new DailyBudget(1_000_000)
  const outcome = await rerank({ invoke: async () => '[[\"a\", 1.5], [\"b\", 0]]', cfg: defaultRerankConfig, query: 'q', candidates: cands, budget })
  assert.ok(outcome)
  assert.equal(outcome!.scores.get('a'), 1) // clamped
  assert.equal(outcome!.scores.get('b'), 0)
  assert.ok(outcome!.tokensSpent > 0)
})

test('blendScores mixes weighted; unscored keep recall', () => {
  const outcome = { scores: new Map([['a', 0.2]]), tokensSpent: 0 }
  const blended = blendScores(cands, outcome, 0.6)
  const a = blended.find((x) => x.id === 'a')!
  const b = blended.find((x) => x.id === 'b')!
  assert.ok(Math.abs(a.score - (0.4 * 0.8 + 0.6 * 0.2)) < 1e-9)
  assert.equal(b.score, 0.6) // not scored by the judge
})
