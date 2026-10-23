/**
 * 召回注入的 scope 范围测试(0.5.0)。
 *
 * 注入是"无显式 scope 的读取",必须与 memory_search 的默认完全一致:会话 + 项目 +
 * global,再加 inject.extraScopes,fork 时还能把父会话当只读召回源。这些都在
 * apply.ts(宿主侧)里解析 —— 会话 id / cwd 只在 agent/pre-step 的 payload 上。
 *
 * 只测纯函数:apply() 本体 import 了 @deepseek-ai/dsh-llm,单测环境解析不到宿主包。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeExtraScopes, resolveInjectScopes } from '../src/inject.ts'

const memoryWith = (scopes) => ({ search: async () => [], resolveReadScopes: () => scopes })
const agent = (header) => ({ session: { header } })

test('inject: 默认召回范围 = provider 的 session + project + global', () => {
  const scopes = resolveInjectScopes(memoryWith(['session:s1', 'project:/w', 'global']), agent({ id: 's1' }), [], undefined)
  assert.deepEqual(scopes, ['session:s1', 'project:/w', 'global'])
})

test('inject: extraScopes 追加在默认集合之后,非法项与重复项都不进', () => {
  const extra = normalizeExtraScopes(['handbook', '../etc/passwd', 'My  Notes'], () => {})
  assert.deepEqual(extra, ['handbook', 'my notes'])
  const scopes = resolveInjectScopes(memoryWith(['session:s1', 'project:/w', 'global']), agent({ id: 's1' }), extra, undefined)
  assert.deepEqual(scopes, ['session:s1', 'project:/w', 'global', 'handbook', 'my notes'])
  // 与默认集合重复的 extraScope 不会出现两次
  const dedup = resolveInjectScopes(memoryWith(['session:s1', 'project:/w']), agent({ id: 's1' }), ['project:/w', 'x'], undefined)
  assert.deepEqual(dedup, ['session:s1', 'project:/w', 'x'])
})

test('inject: 非法 extraScopes 记一行日志', () => {
  const logged = []
  normalizeExtraScopes(['ok name', 'a/b'], (message) => logged.push(message))
  assert.equal(logged.length, 1)
  assert.match(logged[0], /a\/b/)
})

test('inject: fork 的会话把父会话作为只读召回源;子代理不重复加', () => {
  const parent = { id: 'parent-1' }
  const sessions = { get: (id) => (id === 'parent-1' ? parent : undefined) }
  const fork = resolveInjectScopes(
    memoryWith(['session:fork-1', 'project:/w', 'global']),
    agent({ id: 'fork-1', parentSession: 'parent-1' }),
    [],
    sessions,
  )
  assert.deepEqual(fork, ['session:fork-1', 'project:/w', 'global', 'session:parent-1'])

  const sub = resolveInjectScopes(
    memoryWith(['session:parent-1', 'project:/w', 'global']),
    agent({ id: 'sub-1', origin: 'subagent', parentSession: 'parent-1' }),
    [],
    sessions,
  )
  assert.deepEqual(sub, ['session:parent-1', 'project:/w', 'global'], '子代理已经映射到父会话,不重复加')
})

test('inject: 父会话不在内存里或服务抛错时跳过,不报错', () => {
  const gone = resolveInjectScopes(
    memoryWith(['session:fork-1', 'project:/w']),
    agent({ id: 'fork-1', parentSession: 'gone' }),
    [],
    { get: () => undefined },
  )
  assert.deepEqual(gone, ['session:fork-1', 'project:/w'])
  const hostile = resolveInjectScopes(
    memoryWith(['session:fork-1', 'project:/w']),
    agent({ id: 'fork-1', parentSession: 'parent-1' }),
    [],
    { get: () => { throw new Error('boom') } },
  )
  assert.deepEqual(hostile, ['session:fork-1', 'project:/w'])
})

test('inject: provider 没有 resolveReadScopes / 没有任何 scope 时返回 undefined', () => {
  assert.equal(resolveInjectScopes({ search: async () => [] }, agent({ id: 's1' }), [], undefined), undefined)
  assert.deepEqual(
    resolveInjectScopes({ search: async () => [] }, agent({ id: 's1' }), ['handbook'], undefined),
    ['handbook'],
    '只有 extraScopes 时也照样召回',
  )
  // resolveReadScopes 抛错 → 降级为 extraScopes
  const throwing = { search: async () => [], resolveReadScopes: () => { throw new Error('boom') } }
  assert.deepEqual(resolveInjectScopes(throwing, agent({ id: 's1' }), ['handbook'], undefined), ['handbook'])
})

test('inject: 显式可见范围是白名单,extraScopes 与父会话都不能把它撑大', () => {
  const visible = ['session:s1', 'project:/w']
  const memory = {
    search: async () => [],
    resolveReadScopes: () => ['session:s1', 'project:/w', 'global'],
    visibleScopes: () => visible,
  }
  assert.deepEqual(
    resolveInjectScopes(memory, agent({ id: 's1' }), ['handbook'], undefined),
    ['session:s1', 'project:/w'],
    '显式范围之外不加 extraScopes',
  )
  const sessions = { get: (id) => (id === 'parent-1' ? { id: 'parent-1' } : undefined) }
  assert.deepEqual(
    resolveInjectScopes(memory, agent({ id: 'fork-1', parentSession: 'parent-1' }), [], sessions),
    ['session:s1', 'project:/w'],
    '显式范围之外不加 fork 父会话',
  )
  // 空数组 = 什么都不允许读,也不能被 extraScopes 重新撑开。
  assert.deepEqual(
    resolveInjectScopes({ search: async () => [], visibleScopes: () => [] }, agent({ id: 's1' }), ['handbook'], undefined),
    [],
    '显式空范围保持为空',
  )
})
