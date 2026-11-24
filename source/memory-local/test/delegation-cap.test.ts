import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { DelegationCapStore } from '../src/delegation-cap.ts'

function makeService(): { svc: LocalMemoryService; dir: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-cap-'))
  const svc = new LocalMemoryService({ storeDir: dir })
  return {
    svc,
    dir,
    done: () => {
      try { svc.flushSync() } catch { /* 已 flush */ }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const agent = (id: string, parentSession?: string) => ({
  session: { header: { id, cwd: 'D:/w', ...(parentSession !== undefined ? { parentSession, origin: 'subagent' } : {}) } },
})

function wire(svc: LocalMemoryService, sessions: Map<string, ReturnType<typeof agent>>): void {
  svc.setSessionLookup((id) => (sessions.get(id) as unknown as { session: unknown })?.session)
}

async function seedScope(svc: LocalMemoryService): Promise<void> {
  await svc.save({
    scope: 'handbook',
    content: '本作用域用于团队约定',
    kind: 'fact',
    scopeDescription: '团队约定与流程',
    agent: agent('parent'),
    visibilityApproved: true,
  } as never)
}

test('delegation cap：无 cap 时子会话继承父会话全部 grant（旧语义）', async () => {
  const { svc, done } = makeService()
  try {
    await seedScope(svc)
    const parent = agent('parent')
    const child = agent('child', 'parent')
    wire(svc, new Map([['parent', parent], ['child', child]]))
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once' })
    await svc.requestScopeGrants(parent, { requests: [{ scope: 'handbook', permissions: ['read', 'write'] }] })
    const grants = svc.grantList(child)
    assert.ok(grants.some((grant) => grant.scope === 'handbook' && grant.permissions.includes('read')))
  } finally {
    done()
  }
})

test('delegation cap：cap 收窄继承，子会话只拿到 cap 内的权限', async () => {
  const { svc, dir, done } = makeService()
  try {
    await seedScope(svc)
    const parent = agent('parent')
    const child = agent('child', 'parent')
    wire(svc, new Map([['parent', parent], ['child', child]]))
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once' })
    await svc.requestScopeGrants(parent, { requests: [{ scope: 'handbook', permissions: ['read', 'write'] }] })
    const caps = new DelegationCapStore({ root: dir })
    caps.set({ sessionId: 'child', scopes: [{ scope: 'handbook', permissions: ['read'] }] })
    const grants = svc.grantList(child)
    const handbook = grants.filter((grant) => grant.scope === 'handbook')
    assert.ok(handbook.length > 0)
    assert.ok(handbook.every((grant) => grant.permissions.every((permission) => permission === 'read')),
      'cap 只允许 read，写权限不应被继承')
  } finally {
    done()
  }
})

test('delegation cap：commitSubagentGrants 收窄子会话继承并在父会话保留新权限', async () => {
  const { svc, dir, done } = makeService()
  try {
    const parent = agent('parent')
    const child = agent('child', 'parent')
    wire(svc, new Map([['parent', parent], ['child', child]]))
    const result = svc.commitSubagentGrants(parent, 'child', [{ scope: 'handbook', permissions: ['read', 'write'] }], {
      retainInParent: true,
    })
    assert.equal(result.parentGrants.length, 2, '父会话保留 read + write 两条授权')
    assert.ok(result.childGrants.length >= 2)
    assert.equal(svc.delegationCap('child')?.scopes.length, 1)
    const parentGrants = svc.grantList(parent)
    assert.ok(parentGrants.some((grant) => grant.scope === 'handbook' && grant.permissions.includes('write')))
  } finally {
    done()
  }
})

test('delegation cap：planSubagentGrants 拆分子集与超出部分', async () => {
  const { svc, done } = makeService()
  try {
    await seedScope(svc)
    const parent = agent('parent')
    wire(svc, new Map([['parent', parent]]))
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once' })
    await svc.requestScopeGrants(parent, { requests: [{ scope: 'handbook', permissions: ['read'] }] })
    const plan = svc.planSubagentGrants(parent, [
      { scope: 'handbook', permissions: ['read'] },
      { scope: 'handbook', permissions: ['write'] },
      { scope: 'secrets', permissions: ['read'] },
    ])
    assert.deepEqual(plan.within, [{ scope: 'handbook', permissions: ['read'] }])
    assert.ok(plan.beyond.some((item) => item.scope === 'handbook' && item.permissions.includes('write')))
    assert.ok(plan.beyond.some((item) => item.scope === 'secrets'))
  } finally {
    done()
  }
})

test('delegation cap：子会话自己的 grant 不受 cap 限制', async () => {
  const { svc, dir, done } = makeService()
  try {
    await seedScope(svc)
    const parent = agent('parent')
    const child = agent('child', 'parent')
    wire(svc, new Map([['parent', parent], ['child', child]]))
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once' })
    await svc.requestScopeGrants(parent, { requests: [{ scope: 'handbook', permissions: ['read', 'write'] }] })
    const caps = new DelegationCapStore({ root: dir })
    caps.set({ sessionId: 'child', scopes: [] }) // 不继承任何父 grant
    // 子会话自己申请 write
    await svc.requestScopeGrants(child, { requests: [{ scope: 'handbook', permissions: ['write'] }] })
    const grants = svc.grantList(child)
    assert.ok(grants.some((grant) => grant.scope === 'handbook' && grant.permissions.includes('write')),
      '子会话自己的 grant 应生效，不受空 cap 限制')
  } finally {
    done()
  }
})
