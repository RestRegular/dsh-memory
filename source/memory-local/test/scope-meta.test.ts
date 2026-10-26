import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

/** 每个用例一个独立 storeDir：作用域元数据是落盘状态，不能互相污染。 */
function makeService(config: Record<string, unknown> = {}): {
  svc: LocalMemoryService
  dir: string
  done(): void
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-scope-meta-'))
  const svc = new LocalMemoryService({ storeDir: dir, ...config })
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

test('新建自定义作用域：Agent 必须给用途，初始化写入初始事实与初始规则', async () => {
  const { svc, done } = makeService()
  try {
    const a = agent()
    await assert.rejects(
      svc.save({ scope: 'handbook', content: '本作用域用于测试', agent: a, visibilityApproved: true } as never),
      (error: Error & { code?: string }) => error.code === 'SCOPE_DESCRIPTION_REQUIRED',
    )

    const record = await svc.save({
      scope: 'handbook',
      content: '本作用域用于测试',
      kind: 'fact',
      scopeDescription: '测试用作用域',
      scopeRule: '只记录与测试有关的内容',
      agent: a,
      visibilityApproved: true,
    } as never)
    assert.equal((record as { initial?: boolean }).initial, true, '初始事实带 initial 标记')

    const meta = svc.scopeMeta('handbook')
    assert.equal(meta?.description, '测试用作用域')
    assert.equal(meta?.status, 'ready')
    assert.equal(meta?.origin, 'custom')
    assert.match(meta?.generation ?? '', /^[0-9a-f-]{36}$/)

    const records = svc.listSync({ scopes: ['handbook'] })
    const rule = records.find((item) => item.kind === 'rule')
    assert.ok(rule, '初始规则也被写入')
    assert.equal((rule as { initial?: boolean }).initial, true)
    assert.match(rule!.content, /只记录与测试有关的内容/)
  } finally {
    done()
  }
})

test('已有作用域带 scopeDescription = 更新用途，不写初始记忆', async () => {
  const { svc, done } = makeService()
  try {
    const a = agent()
    await svc.save({
      scope: 'handbook', content: '第一条', kind: 'fact',
      scopeDescription: '旧用途', agent: a, visibilityApproved: true,
    } as never)
    const second = await svc.save({
      scope: 'handbook', content: '第二条', kind: 'note',
      scopeDescription: '新用途', agent: a, visibilityApproved: true,
    } as never)
    assert.equal((second as { initial?: boolean }).initial, undefined, '普通写入不带 initial')
    assert.equal(svc.scopeMeta('handbook')?.description, '新用途')
    assert.equal(svc.listSync({ scopes: ['handbook'] }).filter((item) => item.kind === 'rule').length, 0, '不重复写规则')
  } finally {
    done()
  }
})

test('目录：范围外可发现但不可读；absolute 下可发现但不可申请且无正文', async () => {
  const { svc, done } = makeService()
  try {
    const a = agent()
    await svc.save({
      scope: 'handbook', content: '一条内容', kind: 'fact',
      scopeDescription: '测试用作用域', agent: a, visibilityApproved: true,
    } as never)

    let items = svc.scopeCatalog(a)
    const handbook = items.find((item) => item.scope === 'handbook')
    assert.ok(handbook, '范围外作用域也出现在目录里')
    assert.equal(handbook!.description, '测试用作用域')
    assert.equal(handbook!.inScope, false)
    assert.equal(handbook!.readable, false)
    assert.equal(handbook!.canRequestRead, true, '普通限制下可申请')
    assert.equal(handbook!.records, undefined, '范围外不泄露记录数')
    assert.equal(handbook!.accessStatus, 'restricted')

    const global = items.find((item) => item.scope === 'global')
    assert.ok(global)
    assert.equal(global!.inScope, true)
    assert.equal(global!.readable, true)

    svc.setSessionVisibility('s1', { level: 'absolute', scopes: [{ scope: 'global' }] })
    items = svc.scopeCatalog(a)
    const isolated = items.find((item) => item.scope === 'handbook')
    assert.ok(isolated, 'absolute 下名字/用途仍可发现')
    assert.equal(isolated!.readable, false)
    assert.equal(isolated!.writable, false)
    assert.equal(isolated!.canRequestRead, false, 'absolute 没有任何审批放行路径')
    assert.equal(isolated!.canRequestWrite, false)
  } finally {
    done()
  }
})

test('删除最后一条记忆不删除作用域元数据，目录仍能看到它', async () => {
  const { svc, done } = makeService()
  try {
    const a = agent()
    await svc.save({
      scope: 'handbook', content: '会被删掉的内容', kind: 'fact',
      scopeDescription: '留着的作用域', agent: a, visibilityApproved: true,
    } as never)
    await svc.forget({ scope: 'handbook', query: '会被删掉的内容' })
    // 让作用域落进可见范围，才能看到“记录数为 0”而不是范围外的 undefined。
    svc.setSessionVisibility('s1', { level: 'normal', scopes: [{ scope: 'global' }, { scope: 'handbook' }] })
    const items = svc.scopeCatalog(a)
    const handbook = items.find((item) => item.scope === 'handbook')
    assert.ok(handbook, '记录删光后作用域仍在目录里')
    assert.equal(handbook!.description, '留着的作用域')
    assert.equal(handbook!.records, 0)
  } finally {
    done()
  }
})

test('0.27.0 默认描述：scope-meta 没写用途时，目录按作用域类型给一句话说明', async () => {
  const { svc, done } = makeService()
  try {
    const a = agent('s1', 'D:/w')
    const items = svc.scopeCatalog(a)
    const globalItem = items.find((item) => item.scope === 'global')
    assert.ok(globalItem?.description?.includes('跨项目共享'), 'global 有默认描述')
    const project = items.find((item) => item.scope.startsWith('project:'))
    assert.ok(project?.description?.includes('绑定当前工作区'), 'project 有默认描述')
    const session = items.find((item) => item.scope === 'session:s1')
    assert.ok(session?.description?.includes('仅本会话可见'), 'session 有默认描述')

    // Agent 写过的 description 永远优先于默认描述。
    await svc.save({
      scope: 'handbook', content: '内容', kind: 'fact',
      scopeDescription: '手写用途', agent: a, visibilityApproved: true,
    } as never)
    const after = svc.scopeCatalog(a)
    assert.equal(after.find((item) => item.scope === 'handbook')!.description, '手写用途')
    assert.ok(after.find((item) => item.scope === 'global')!.description!.includes('跨项目共享'), '默认描述不落盘,不影响 meta')
  } finally {
    done()
  }
})

test('关闭自定义作用域：目录里不出现自定义条目；元数据文件保留', async () => {
  const first = makeService()
  try {
    await first.svc.save({
      scope: 'handbook', content: '内容', kind: 'fact',
      scopeDescription: '测试作用域', agent: agent(), visibilityApproved: true,
    } as never)
    first.svc.flushSync()

    const svc = new LocalMemoryService({
      storeDir: first.dir,
      scopes: { global: true, project: true, session: true, custom: { enabled: false } },
    })
    const items = svc.scopeCatalog(agent())
    assert.equal(items.some((item) => item.scope === 'handbook'), false, '关闭后不展示名字/用途')
    assert.ok(svc.scopeMeta('handbook') !== undefined, '元数据本身没有被删除')
  } finally {
    first.done()
  }
})

test('initial 正文：normal 下随目录可见，absolute 下不返回', async () => {
  const { svc, done } = makeService()
  try {
    const a = agent()
    await svc.save({
      scope: 'handbook', content: '本作用域用于团队约定', kind: 'fact',
      scopeDescription: '团队约定与流程', scopeRule: '只记录团队协作相关内容',
      agent: a, visibilityApproved: true,
    } as never)

    let items = svc.scopeCatalog(a)
    const normal = items.find((item) => item.scope === 'handbook')!
    assert.equal(normal.initialRecords?.length, 2, 'normal 下 initial fact + rule 正文可见')
    assert.deepEqual(normal.initialRecords?.map((record) => record.kind).sort(), ['fact', 'rule'])
    assert.ok(normal.initialRecords?.some((record) => record.content.includes('团队约定')))

    svc.setSessionVisibility('s1', { level: 'absolute', scopes: [{ scope: 'global' }] })
    items = svc.scopeCatalog(a)
    const absolute = items.find((item) => item.scope === 'handbook')!
    assert.equal(absolute.description, '团队约定与流程', 'absolute 下用途仍可发现')
    assert.equal(absolute.initialRecords, undefined, 'absolute 下 initial 正文也不返回')
  } finally {
    done()
  }
})

test('describeScope：校验空描述并更新用途', () => {
  const { svc, done } = makeService()
  try {
    assert.throws(
      () => svc.describeScope('handbook', '   ', 'user'),
      (error: Error & { code?: string }) => error.code === 'SCOPE_DESCRIPTION_EMPTY',
    )
    svc.describeScope('handbook', '手工补写的用途', 'user')
    assert.equal(svc.scopeMeta('handbook')?.description, '手工补写的用途')
    assert.equal(svc.scopeMeta('handbook')?.origin, 'custom')
  } finally {
    done()
  }
})

test('initial 标记可被 memory_get 读取，并在导出/导入后保留', async () => {
  const { svc, done } = makeService()
  try {
    const a = agent()
    const record = await svc.save({
      scope: 'handbook', content: '本作用域用于测试', kind: 'fact',
      scopeDescription: '测试用作用域', agent: a, visibilityApproved: true,
    } as never)

    const { memoryGetTool } = await import('../../tool-memory/src/index.ts')
    const get = memoryGetTool({ getService: () => svc as never })
    // level=none 让这条记录在工具层不被可见域挡住（这里只验证 initial 字段契约）。
    svc.setSessionVisibility('s1', { level: 'none', scopes: [{ scope: 'global' }] })
    const got = await get.execute({ ids: [record.id], fields: ['content', 'initial'] }, { agent: a })
    assert.equal(got.records[0]?.initial, true)

    const exported = svc.exportAll()
    assert.equal(exported.records[0]?.initial, true, '导出保留 initial')

    const target = makeService()
    try {
      await target.svc.importRecords(exported)
      const imported = target.svc.listSync({ scopes: ['handbook'] })
      assert.equal(imported.length, 1)
      assert.equal((imported[0] as { initial?: boolean }).initial, true, '导入保留 initial')
    } finally {
      target.done()
    }
  } finally {
    done()
  }
})
