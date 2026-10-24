import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorize, type AccessContext, type AccessRequest } from '../src/authorize.ts'
import type { VisibilityRule } from '../src/session-visibility.ts'

function context(level: AccessContext['level'], scopes: VisibilityRule[], custom = true): AccessContext {
  return {
    level,
    scopes,
    enabled: { global: true, project: true, session: true, custom },
    originOf: (scope) => (scope === 'global' ? 'global'
      : scope.startsWith('project:') ? 'project'
        : scope.startsWith('session:') ? 'session'
          : 'custom'),
  }
}

const req = (action: AccessRequest['action'], scope = 'handbook', kind?: string): AccessRequest => ({ action, scope, ...(kind !== undefined ? { kind } : {}) })

test('none：所有动作放行，scopes 只是偏好', () => {
  const ctx = context('none', [])
  for (const action of ['discover', 'read', 'write', 'delete'] as const) {
    const decision = authorize(req(action), ctx)
    assert.equal(decision.allowed, true, action)
  }
})

test('absolute：目录可见，正文读写删一律拒绝且不可申请', () => {
  const ctx = context('absolute', [{ scope: 'global' }])
  assert.equal(authorize(req('discover'), ctx).allowed, true, '名字/用途可见')
  for (const action of ['read', 'write', 'delete'] as const) {
    const decision = authorize(req(action), ctx)
    assert.equal(decision.allowed, false, action)
    assert.equal(decision.reason, 'ABSOLUTE_ISOLATION', action)
    assert.equal(decision.requestable, false, 'absolute 不存在审批放行路径')
  }
})

test('normal：范围外可申请；范围内但 read/write 关闭不可申请', () => {
  const outside = authorize(req('read'), context('normal', [{ scope: 'global' }]))
  assert.equal(outside.allowed, false)
  assert.equal(outside.reason, 'SCOPE_NOT_IN_RANGE')
  assert.equal(outside.requestable, true)

  const readOnly = authorize(req('read'), context('normal', [{ scope: 'handbook', read: true, write: false }]))
  assert.equal(readOnly.allowed, true)

  const readDisabled = authorize(req('read'), context('normal', [{ scope: 'handbook', read: false }]))
  assert.equal(readDisabled.allowed, false)
  assert.equal(readDisabled.reason, 'READ_DISABLED')
  assert.equal(readDisabled.requestable, false, '显式不可读不通过审批放行')

  const writeDisabled = authorize(req('write'), context('normal', [{ scope: 'handbook', write: false }]))
  assert.equal(writeDisabled.allowed, false)
  assert.equal(writeDisabled.reason, 'WRITE_DISABLED')
  assert.equal(writeDisabled.requestable, false)
})

test('作用域类型关闭：连 discover 都拒绝（自定义 / global 同理）', () => {
  const customOff = context('normal', [], false)
  const discover = authorize(req('discover'), customOff)
  assert.equal(discover.allowed, false)
  assert.equal(discover.reason, 'SCOPE_DISABLED')

  const globalOff: AccessContext = {
    ...context('normal', [{ scope: 'global' }]),
    enabled: { global: false, project: true, session: true, custom: true },
  }
  assert.equal(authorize(req('read', 'global'), globalOff).reason, 'SCOPE_DISABLED')
})

test('旧 kinds 白名单仍然生效；不匹配时不可申请', () => {
  const ctx = context('normal', [{ scope: 'handbook', kinds: ['rule'] }])
  assert.equal(authorize(req('read', 'handbook', 'rule'), ctx).allowed, true)
  const denied = authorize(req('read', 'handbook', 'fact'), ctx)
  assert.equal(denied.allowed, false)
  assert.equal(denied.reason, 'KIND_NOT_ALLOWED')
  assert.equal(denied.requestable, false)
})
