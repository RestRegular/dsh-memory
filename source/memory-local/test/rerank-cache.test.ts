import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RerankCache } from '../src/rerank-cache.ts'

const outcome = (offset: number) => ({ scores: new Map([['a', offset]]), tokensSpent: 1 })

test('cache key depends on query, candidate ids (order-insensitive), and model', () => {
  const k1 = RerankCache.key('q', ['a', 'b'], 'm')
  const k2 = RerankCache.key('q', ['b', 'a'], 'm')
  const k3 = RerankCache.key('q2', ['a', 'b'], 'm')
  const k4 = RerankCache.key('q', ['a', 'b'], 'm2')
  assert.equal(k1, k2, 'id order does not matter')
  assert.notEqual(k1, k3)
  assert.notEqual(k1, k4)
})

test('set/get roundtrip, FIFO cap, and clear', () => {
  const c = new RerankCache(2)
  c.set('k1', outcome(1))
  c.set('k2', outcome(2))
  assert.ok(c.get('k1'))
  c.set('k3', outcome(3)) // evicts k1 (oldest)
  assert.equal(c.get('k1'), null)
  assert.ok(c.get('k2'))
  assert.ok(c.get('k3'))
  assert.equal(c.size, 2)
  c.clear()
  assert.equal(c.size, 0)
})

test('TTL expiry', () => {
  const c = new RerankCache(10, 1000)
  c.set('k', outcome(1), 0)
  assert.ok(c.get('k', 500))
  assert.equal(c.get('k', 1500), null, 'expired after ttl')
})
