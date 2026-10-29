import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

/**
 * 0.30.0：会话作用域 ↔ 宿主会话生命周期。
 *
 * 覆盖三件事：
 *   1. 会话创建时 `ensureSessionScope()` 自动建立会话作用域（只写用途元数据）；
 *   2. 归档期间该作用域**不参与任何检索**（search / list / getByIds / 授权），
 *      但数据文件保留、过期的冻结由 housekeeping 负责（单独断言）；
 *   3. 恢复（宿主归档集合里移除）后所有读路径立刻复原，不需要任何重建动作。
 */
function makeService(): { svc: LocalMemoryService; dir: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-session-archive-'))
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

const agent = (id = 's1', cwd = 'D:/w') => ({ session: { header: { id, cwd } } })

/** 会话作用域落盘文件名与 store 一致：projects/<sha1(scope)>.jsonl。 */
function sessionFile(dir: string, sessionId: string): string {
  return join(dir, 'projects', `${createHash('sha1').update(`session:${sessionId}`).digest('hex')}.jsonl`)
}

test('ensureSessionScope：系统自动建立会话作用域，幂等、不写记忆记录', () => {
  const { svc, dir, done } = makeService()
  try {
    assert.equal(svc.ensureSessionScope('sess-1'), true)
    const meta = svc.scopeMeta('session:sess-1')
    assert.ok(meta, '元数据已落盘')
    assert.equal(meta!.origin, 'session')
    assert.equal(meta!.createdBy, 'system')
    assert.equal(meta!.status, 'ready')
    assert.match(meta!.description, /随会话归档与恢复/)
    assert.equal(svc.listSync({ scopes: ['session:sess-1'] }).length, 0, '自动创建不写任何记忆')
    assert.equal(svc.ensureSessionScope('sess-1'), false, '已有元数据不覆盖')
    assert.equal(svc.ensureSessionScope(''), false, '空 id 不建')
  } finally {
    done()
  }
})

test('归档冻结检索与授权，恢复后立刻复原（记忆原样保留）', async () => {
  const { svc, dir, done } = makeService()
  const archived: string[] = []
  svc.setArchivedSessionLookup(() => archived)
  try {
    const a = agent('s1')
    const saved = await svc.save({
      scope: 'session:s1',
      content: '归档冻结测试：这条记忆在归档期间不能被检索到',
      kind: 'fact',
      agent: a,
      visibilityApproved: true,
    } as never)

    // 归档前：正常可见可检索。
    assert.equal((await svc.search({ text: '归档冻结测试', scopes: ['session:s1'] })).length, 1)
    assert.equal(svc.listSync({ scopes: ['session:s1'] }).length, 1)
    assert.equal(svc.getByIds([saved.id]).length, 1)

    // 归档：宿主归档集合里出现该会话。
    archived.push('s1')
    assert.equal((await svc.search({ text: '归档冻结测试', scopes: ['session:s1'] })).length, 0, '归档后不可检索')
    assert.equal(svc.listSync({ scopes: ['session:s1'] }).length, 0, '归档后不可枚举')
    assert.equal(svc.getByIds([saved.id]).length, 0, '归档后按 id 也取不到')

    const read = svc.authorize(a, { scope: 'session:s1', action: 'read' })
    assert.equal(read.allowed, false)
    assert.equal(read.reason, 'SCOPE_ARCHIVED')
    assert.equal(read.requestable, false, '归档不是审批能放行的权限问题')

    const write = svc.authorize(a, { scope: 'session:s1', action: 'write' })
    assert.equal(write.allowed, false)
    assert.equal(write.reason, 'SCOPE_ARCHIVED')

    // 目录保留条目并标明归档（名字/用途仍可发现，正文不可读）。
    const catalog = svc.scopeCatalog(a).find((item) => item.scope === 'session:s1')
    assert.ok(catalog, '归档作用域仍出现在目录里')
    assert.equal(catalog!.archived, true)
    assert.equal(catalog!.accessStatus, 'archived')
    assert.equal(catalog!.readable, false)
    assert.equal(catalog!.writable, false)
    assert.equal(catalog!.canRequestRead, false)
    assert.equal(catalog!.canRequestWrite, false)

    // 归档期间写入被明确拒绝。
    await assert.rejects(
      svc.save({ scope: 'session:s1', content: '归档期间不能再写', agent: a } as never),
      (error: Error & { code?: string }) => error.code === 'SCOPE_ARCHIVED',
    )

    // 数据文件与记忆都保留（归档 ≠ 删除）。
    svc.flushSync()
    assert.ok(existsSync(sessionFile(dir, 's1')), '归档不删数据文件')

    // 恢复：宿主归档集合移除该会话。
    archived.length = 0
    assert.equal((await svc.search({ text: '归档冻结测试', scopes: ['session:s1'] })).length, 1, '恢复后立刻可检索')
    assert.equal(svc.listSync({ scopes: ['session:s1'] }).length, 1)
    assert.equal(svc.getByIds([saved.id]).length, 1, '恢复后按 id 可取')
    assert.equal(svc.authorize(a, { scope: 'session:s1', action: 'read' }).allowed, true)
    const restored = svc.scopeCatalog(a).find((item) => item.scope === 'session:s1')
    assert.equal(restored!.archived, undefined, '恢复后不再标记归档')
  } finally {
    done()
  }
})

test('归档期间过期清理与容量淘汰不碰该作用域（冻结）', async () => {
  const { svc, done } = makeService()
  const archived: string[] = []
  svc.setArchivedSessionLookup(() => archived)
  try {
    const a = agent('s1')
    const expired = Date.now() - 60_000
    const record = await svc.save({
      scope: 'session:s1',
      content: '会在归档期间过期的记忆',
      kind: 'state',
      expiresAt: expired,
      agent: a,
      visibilityApproved: true,
    } as never)
    archived.push('s1')
    // 归档期间 housekeeping 跑一次：过期记录不能被清掉。
    const frozenRun = svc.runHousekeeping()
    assert.equal(frozenRun.purged.length, 0, '归档期间不清理过期记录')
    svc.flushSync()
    archived.length = 0
    // 恢复后记录仍在（包括过期记录，list 的 includeExpired 能看到）。
    const all = svc.listSync({ scopes: ['session:s1'], includeExpired: true })
    assert.equal(all.length, 1)
    assert.equal(all[0]!.id, record.id)
    // 恢复后 housekeeping 恢复原规则：过期记录会被清掉。
    const restoredRun = svc.runHousekeeping()
    assert.ok(restoredRun.purged.includes(record.id), '恢复后过期清理照常生效')
  } finally {
    done()
  }
})
