import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sep } from 'node:path'
import { tokenize, buildStats, lexicalScore, recordScore, recencyFactor, cosine, normalizeInPlace, LruSet } from '../src/scoring.ts'
import { contentHash, normalizeContent, scopeFileName } from '../src/store.ts'

test('tokenize handles mixed CJK/Latin', () => {
  const tokens = tokenize('使用 TypeScript 部署向量服务')
  assert.ok(tokens.includes('typescript'))
  assert.ok(tokens.includes('部署'), 'CJK unigrams present')
  assert.ok(tokens.includes('向量'), 'CJK bigrams present')
})

test('lexicalScore ranks matching content above non-matching', () => {
  const docs = [
    new Set(tokenize('用户偏好 TypeScript 编写插件')),
    new Set(tokenize('今天天气很好适合出门散步')),
  ]
  const stats = buildStats(docs)
  const q = tokenize('TypeScript 插件')
  const hit = lexicalScore(q, docs[0]!, stats)
  const miss = lexicalScore(q, docs[1]!, stats)
  assert.ok(hit > 0.5, `expected strong hit, got ${hit}`)
  assert.equal(miss, 0)
})

test('recencyFactor halves at half-life', () => {
  const now = Date.now()
  assert.equal(recencyFactor(now, now, 30), 1)
  const half = recencyFactor(now - 30 * 86_400_000, now, 30)
  assert.ok(Math.abs(half - 0.5) < 1e-9, `expected 0.5, got ${half}`)
})

test('recordScore applies superseded penalty', () => {
  const now = Date.now()
  const base = recordScore(1, 0.8, 0, now, { now, halfLifeDays: 30, superseded: false })
  const penalized = recordScore(1, 0.8, 0, now, { now, halfLifeDays: 30, superseded: true })
  assert.ok(Math.abs(penalized - base * 0.3) < 1e-9)
})

test('cosine of parallel vectors is 1, orthogonal 0', () => {
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([2, 0])), 1)
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([0, 3])), 0)
})

test('normalizeInPlace yields unit norm', () => {
  const v = normalizeInPlace(new Float32Array([3, 4]))
  const norm = Math.hypot(v[0]!, v[1]!)
  assert.ok(Math.abs(norm - 1) < 1e-6, `expected ~1, got ${norm}`) // float32 precision
})

test('LruSet evicts oldest', () => {
  const lru = new LruSet<number>(2)
  lru.set('a', 1)
  lru.set('b', 2)
  lru.get('a') // refresh
  lru.set('c', 3)
  assert.equal(lru.get('b'), undefined)
  assert.equal(lru.get('a'), 1)
  assert.equal(lru.get('c'), 3)
})

test('content hash ignores whitespace/case, respects scope', () => {
  assert.equal(contentHash('global', 'Hello  World'), contentHash('global', 'hello world'))
  assert.notEqual(contentHash('global', 'x'), contentHash('project:/a', 'x'))
})

test('scopeFileName hashes project scopes into projects dir', () => {
  assert.equal(scopeFileName('global'), 'global.jsonl')
  const name = scopeFileName('project:/a/b')
  assert.ok(name.startsWith(`projects${sep}`) || name.includes('projects'))
  assert.ok(name.endsWith('.jsonl'))
  assert.ok(normalizeContent('  A  B ') === 'a b')
})
