import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

function makeService(config: Record<string, unknown> = {}): { svc: LocalMemoryService; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-access-'))
  const svc = new LocalMemoryService({ storeDir: dir, ...config })
  return {
    svc,
    done: () => {
      try { svc.flushSync() } catch { /* 已 flush */ }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const agent = { session: { header: { id: 's1', cwd: 'D:/w' } } }

test('provider authorize：absolute 下目录可发现、正文读写不可、且不可申请', async () => {
  const { svc, done } = makeService()
  try {
    await svc.save({
      scope: 'handbook', content: '一条内容', kind: 'fact',
      scopeDescription: '测试作用域', agent, visibilityApproved: true,
    } as never)
    svc.setSessionVisibility('s1', { level: 'absolute', scopes: [{ scope: 'global' }] })

    const discover = svc.authorize(agent, { scope: 'handbook', action: 'discover' })
    assert.equal(discover.allowed, true, '名字/用途可见')

    for (const action of ['read', 'write', 'delete'] as const) {
      const decision = svc.authorize(agent, { scope: 'handbook', action })
      assert.equal(decision.allowed, false, action)
      assert.equal(decision.reason, 'ABSOLUTE_ISOLATION', action)
      assert.equal(decision.requestable, false, `${action} 不可申请`)
    }

    assert.equal(svc.isScopeReadable(agent, 'handbook'), false)
    assert.equal(svc.isScopeWritable(agent, 'handbook'), false)
    assert.equal(svc.isRecordVisible(agent, 'handbook', 'fact'), false)
  } finally {
    done()
  }
})

test('provider accessEvaluator：normal 范围外 requestable=true，范围内放行', async () => {
  const { svc, done } = makeService()
  try {
    const evaluate = svc.accessEvaluator(agent)
    const outsideRead = evaluate({ scope: 'handbook', action: 'read' })
    assert.equal(outsideRead.allowed, false)
    assert.equal(outsideRead.reason, 'SCOPE_NOT_IN_RANGE')
    assert.equal(outsideRead.requestable, true)

    svc.setSessionVisibility('s1', {
      level: 'normal',
      scopes: [{ scope: 'global', write: false }, { scope: 'session:s1' }],
    })
    const evaluator = svc.accessEvaluator(agent)
    assert.equal(evaluator({ scope: 'global', action: 'read' }).allowed, true)
    const write = evaluator({ scope: 'global', action: 'write' })
    assert.equal(write.allowed, false)
    assert.equal(write.reason, 'WRITE_DISABLED')
    assert.equal(write.requestable, false)
  } finally {
    done()
  }
})

test('provider：关闭自定义作用域时 discover 也拒绝', () => {
  const { svc, done } = makeService({
    scopes: { global: true, project: true, session: true, custom: { enabled: false } },
  })
  try {
    const decision = svc.authorize(agent, { scope: 'handbook', action: 'discover' })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'SCOPE_DISABLED')
    assert.equal(decision.requestable, false)
  } finally {
    done()
  }
})

test('provider 读取过滤与授权同口径：absolute 下注入侧的 listSync 只回范围内记录', async () => {
  const { svc, done } = makeService()
  try {
    await svc.save({
      scope: 'handbook', content: '范围外的独特内容 zzqx', kind: 'fact',
      scopeDescription: '测试作用域', agent, visibilityApproved: true,
    } as never)
    await svc.save({
      scope: 'global', content: '范围内的独特内容 zzqx', kind: 'fact',
      agent, visibilityApproved: true,
    } as never)
    svc.setSessionVisibility('s1', { level: 'absolute', scopes: [{ scope: 'global' }] })
    // 工具层故意不传 agent（它要看见范围外命中才能发起审批）；注入侧传 agent，
    // 由 provider 的 visibilityFilterFor（现在统一走 authorize）过滤。
    const filtered = svc.listSync({ scopes: ['global', 'handbook'], agent })
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0]!.scope, 'global')
  } finally {
    done()
  }
})
