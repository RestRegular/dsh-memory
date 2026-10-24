import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import { ScopeMetaStore } from '../src/scope-meta.ts'
import { memoryScopesTool } from '../../tool-memory/src/index.ts'

function makeService(): { svc: LocalMemoryService; dir: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-grants-'))
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

const agent = (id = 's1', extra: Record<string, unknown> = {}) => ({
  session: { header: { id, cwd: 'D:/w', ...extra } },
})

/** 预置一个带用途的自定义作用域（Agent 路径需要 scopeDescription）。 */
async function seedScope(svc: LocalMemoryService): Promise<void> {
  await svc.save({
    scope: 'handbook',
    content: '本作用域用于团队约定',
    kind: 'fact',
    scopeDescription: '团队约定与流程',
    agent: agent(),
    visibilityApproved: true,
  } as never)
}

test('正常限制：申请只读 → 落盘会话 grant；写仍需单独授权', async () => {
  const { svc, dir, done } = makeService()
  try {
    await seedScope(svc)
    let asked = 0
    svc.requestOutOfScope = async () => {
      asked += 1
      return { outcome: 'allowed-once' }
    }
    const result = await svc.requestScopeGrants(agent(), {
      requests: [{ scope: 'handbook', permissions: ['read'] }],
      reason: '需要团队约定',
    })
    assert.deepEqual(result.results, [{ scope: 'handbook', permission: 'read', status: 'granted' }])
    assert.equal(asked, 1)
    assert.equal(result.grants.length, 1)

    const grants = svc.grantList(agent())
    assert.equal(grants.length, 1)
    assert.deepEqual(grants[0]!.permissions, ['read'])

    const read = svc.authorize(agent(), { scope: 'handbook', action: 'read' })
    assert.equal(read.allowed, true)
    assert.equal(read.source, 'grant')

    // 目录也如实反映“已授权只读”，不再把范围外一律标成不可读。
    const catalog = svc.scopeCatalog(agent()).find((item) => item.scope === 'handbook')!
    assert.equal(catalog.inScope, false)
    assert.equal(catalog.readable, true)
    assert.equal(catalog.writable, false)
    assert.equal(catalog.canRequestRead, false)
    assert.equal(catalog.accessStatus, 'read-only')

    const write = svc.authorize(agent(), { scope: 'handbook', action: 'write' })
    assert.equal(write.allowed, false)
    assert.equal(write.requestable, true, '写权限可以单独申请')

    // 再申请写：审批只勾 write 这一条。
    svc.requestScopeGrants = svc.requestScopeGrants.bind(svc)
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once', allowedIds: ['grant:handbook:write'] })
    const writeResult = await svc.requestScopeGrants(agent(), {
      requests: [{ scope: 'handbook', permissions: ['write'] }],
      reason: '需要写入',
    })
    assert.deepEqual(writeResult.results, [{ scope: 'handbook', permission: 'write', status: 'granted' }])
    assert.equal(svc.authorize(agent(), { scope: 'handbook', action: 'write' }).allowed, true)
    assert.equal(svc.grantList(agent()).length, 1, '同作用域合并成一条 grant')
  } finally {
    done()
  }
})

test('absolute：申请不弹审批，直接 not-requestable', async () => {
  const { svc, done } = makeService()
  try {
    await seedScope(svc)
    svc.setSessionVisibility('s1', { level: 'absolute', scopes: [{ scope: 'global' }] })
    let asked = 0
    svc.requestOutOfScope = async () => {
      asked += 1
      return { outcome: 'allowed-once' }
    }
    const result = await svc.requestScopeGrants(agent(), {
      requests: [{ scope: 'handbook', permissions: ['read', 'write'] }],
    })
    assert.deepEqual(result.results, [
      { scope: 'handbook', permission: 'read', status: 'not-requestable', reason: 'ABSOLUTE_ISOLATION' },
      { scope: 'handbook', permission: 'write', status: 'not-requestable', reason: 'ABSOLUTE_ISOLATION' },
    ])
    assert.equal(asked, 0)
    assert.equal(svc.grantList(agent()).length, 0)
  } finally {
    done()
  }
})

test('已允许 / 已有授权不会重复弹审批', async () => {
  const { svc, done } = makeService()
  try {
    await seedScope(svc)
    // 已在可见范围内：already-allowed。
    svc.setSessionVisibility('s1', { level: 'normal', scopes: [{ scope: 'global' }, { scope: 'handbook' }] })
    let asked = 0
    svc.requestOutOfScope = async () => {
      asked += 1
      return { outcome: 'allowed-once' }
    }
    const allowed = await svc.requestScopeGrants(agent(), { requests: [{ scope: 'handbook', permissions: ['read'] }] })
    assert.deepEqual(allowed.results, [{ scope: 'handbook', permission: 'read', status: 'already-allowed' }])
    assert.equal(asked, 0)

    // 范围外 + 已有 grant：already-granted。
    svc.setSessionVisibility('s1', { level: 'normal', scopes: [{ scope: 'global' }] })
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once' })
    await svc.requestScopeGrants(agent(), { requests: [{ scope: 'handbook', permissions: ['read'] }] })
    assert.equal(svc.grantList(agent()).length, 1)
    const again = await svc.requestScopeGrants(agent(), { requests: [{ scope: 'handbook', permissions: ['read'] }] })
    assert.deepEqual(again.results, [{ scope: 'handbook', permission: 'read', status: 'already-granted' }])
  } finally {
    done()
  }
})

test('用户拒绝：不写 grant，状态是 denied', async () => {
  const { svc, done } = makeService()
  try {
    await seedScope(svc)
    svc.requestOutOfScope = async () => ({ outcome: 'rejected' })
    const result = await svc.requestScopeGrants(agent(), { requests: [{ scope: 'handbook', permissions: ['read'] }] })
    assert.deepEqual(result.results, [{ scope: 'handbook', permission: 'read', status: 'denied' }])
    assert.equal(svc.grantList(agent()).length, 0)
  } finally {
    done()
  }
})

test('子 Agent 沿 parentSession 链继承父会话的 grant', async () => {
  const { svc, done } = makeService()
  try {
    await seedScope(svc)
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once' })
    await svc.requestScopeGrants(agent('parent'), { requests: [{ scope: 'handbook', permissions: ['read'] }] })

    svc.setSessionLookup((id) => (id === 'child'
      ? { header: { id: 'child', parentSession: 'parent', origin: 'subagent' } }
      : undefined))
    const child = agent('child', { parentSession: 'parent', origin: 'subagent' })
    assert.equal(svc.grantList(child).length, 1)
    assert.equal(svc.authorize(child, { scope: 'handbook', action: 'read' }).allowed, true)
  } finally {
    done()
  }
})

test('作用域重建（generation 变化）后旧 grant 失效', async () => {
  const { svc, dir, done } = makeService()
  try {
    await seedScope(svc)
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once' })
    await svc.requestScopeGrants(agent(), { requests: [{ scope: 'handbook', permissions: ['read'] }] })
    assert.equal(svc.grantList(agent()).length, 1)

    const meta = new ScopeMetaStore({ root: dir })
    const before = meta.get('handbook')!
    // 模拟“删除作用域后同名重建”：代次必须换。
    meta.remove('handbook')
    meta.put('handbook', { description: before.description, createdBy: 'user' })
    assert.notEqual(meta.get('handbook')!.generation, before.generation)

    assert.equal(svc.grantList(agent()).length, 0, '代次不匹配的 grant 不再生效')
    assert.equal(svc.authorize(agent(), { scope: 'handbook', action: 'read' }).allowed, false)
  } finally {
    done()
  }
})

test('撤销 grant 后读权限立即失效', async () => {
  const { svc, done } = makeService()
  try {
    await seedScope(svc)
    svc.requestOutOfScope = async () => ({ outcome: 'allowed-once' })
    const result = await svc.requestScopeGrants(agent(), { requests: [{ scope: 'handbook', permissions: ['read'] }] })
    const grantId = result.grants[0]!.id
    assert.equal(svc.revokeGrant('s1', grantId), true)
    assert.equal(svc.grantList(agent()).length, 0)
    assert.equal(svc.authorize(agent(), { scope: 'handbook', action: 'read' }).allowed, false)
  } finally {
    done()
  }
})

test('工具端到端：memory_scopes request 走审批并写入 grant', async () => {
  const { svc, done } = makeService()
  try {
    await seedScope(svc)
    let mode: string | undefined
    svc.requestOutOfScope = async (_agent, input) => {
      mode = input.mode
      return { outcome: 'allowed-once' }
    }
    const tool = memoryScopesTool({ getService: () => svc as never })
    const result = await tool.execute({
      action: 'request',
      scopes: ['handbook'],
      reason: '需要团队约定',
      description: '申请手册',
    } as never, { agent: agent() })
    assert.equal(mode, 'grant')
    assert.deepEqual((result as { results: unknown }).results, [
      { scope: 'handbook', permission: 'read', status: 'granted' },
    ])
    assert.equal(svc.authorize(agent(), { scope: 'handbook', action: 'read' }).allowed, true)
  } finally {
    done()
  }
})

test('审批审计：requested / approved / granted / revoked，且不写正文', async () => {
  const { svc, dir, done } = makeService()
  try {
    await seedScope(svc)
    // 真实流程：先挂起审批，再由面板回答，审计走 requestOutOfScope + answerVisibilityApproval。
    const pendingRequest = svc.requestScopeGrants(agent(), {
      requests: [{ scope: 'handbook', permissions: ['read'] }],
      reason: '需要团队约定',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const pending = svc.pendingVisibilityApprovals('s1')
    assert.equal(pending.length, 1)
    assert.equal(pending[0]!.mode, 'grant')
    assert.equal(svc.answerVisibilityApproval(pending[0]!.id, 'allowed-once', ['grant:handbook:read']), true)
    const result = await pendingRequest
    const grantId = result.grants[0]!.id
    assert.equal(svc.revokeGrant('s1', grantId), true)

    const events = svc.approvalAuditList(50)
    assert.ok(events.some((event) => event.event === 'requested' && event.mode === 'grant'))
    assert.ok(events.some((event) => event.event === 'approved'))
    assert.ok(events.some((event) => event.event === 'granted' && event.scopes?.[0] === 'handbook'))
    assert.ok(events.some((event) => event.event === 'revoked' && event.id === grantId))
    const raw = readFileSync(join(dir, 'approvals.jsonl'), 'utf8')
    assert.equal(raw.includes('本作用域用于团队约定'), false, '审计不落记忆正文')
  } finally {
    done()
  }
})
