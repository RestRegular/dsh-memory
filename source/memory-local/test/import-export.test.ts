import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'

function fresh(dir) {
  return new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true, session: true } })
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-import-'))
  const svc = fresh(dir)
  return fn(svc, dir).finally(() => { try { svc.flushSync() } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }) })
}

test('createRecord: 只接受明确的 scope,面板不猜 project/session', async () => {
  await withDir(async (svc) => {
    const rec = await svc.createRecord({ scope: 'project:C:/w', kind: 'rule', content: '改 lib 必须同时改 source' })
    assert.equal(rec.kind, 'rule')
    assert.equal(rec.scope, 'project:C:/w')
    const custom = await svc.createRecord({ scope: 'handbook', content: '自定义作用域里的一条' })
    assert.equal(custom.scope, 'handbook')
    await assert.rejects(() => svc.createRecord({ scope: 'project', content: 'x' }), /SCOPE_INVALID/)
    await assert.rejects(() => svc.createRecord({ scope: 'session', content: 'x' }), /SCOPE_INVALID/)
    await assert.rejects(() => svc.createRecord({ scope: 'global', content: '   ' }), /CONTENT_EMPTY/)
  })
})

test('exportAll: 纯文本 + 元数据,不含向量', async () => {
  await withDir(async (svc) => {
    await svc.save({ scope: 'global', kind: 'fact', content: '全局事实' })
    await svc.save({ scope: 'project:C:/w', kind: 'rule', content: '项目规则' })
    const doc = svc.exportAll()
    assert.equal(doc.version, 1)
    assert.equal(typeof doc.exportedAt, 'number')
    assert.equal(doc.records.length, 2)
    for (const r of doc.records) {
      assert.deepEqual(Object.keys(r).sort(), ['content', 'createdAt', 'importance', 'kind', 'scope', 'tags', 'updatedAt'])
    }
    assert.deepEqual(doc.records.map((r) => r.scope).sort(), ['global', 'project:C:/w'])
  })
})

test('importRecords: 往返导入 + 重复按内容跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-import-'))
  const other = mkdtempSync(join(tmpdir(), 'dsh-memory-import-'))
  const a = fresh(dir)
  const b = fresh(other)
  try {
    await a.save({ scope: 'global', kind: 'decision', content: '选择 JSONL 作为存储' })
    await a.save({ scope: 'project:C:/w', kind: 'rule', content: '发布前必须跑 npm test' })
    const doc = a.exportAll()

    const first = await b.importRecords(doc)
    assert.deepEqual({ imported: first.imported, skipped: first.skipped, rejected: first.rejected }, { imported: 2, skipped: 0, rejected: 0 })
    const kinds = new Set(b.listSync({ scopes: ['global', 'project:C:/w'] }).map((r) => r.kind))
    assert.ok(kinds.has('rule') && kinds.has('decision'))

    const again = await b.importRecords(doc)
    assert.deepEqual({ imported: again.imported, skipped: again.skipped, rejected: again.rejected }, { imported: 0, skipped: 2, rejected: 0 })
  } finally {
    a.flushSync(); b.flushSync()
    rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true })
  }
})

test('importRecords: 坏条目计入 rejected,不中断其余条目', async () => {
  await withDir(async (svc) => {
    const result = await svc.importRecords({
      records: [
        { scope: 'global', content: '' },
        { scope: '../escape', content: '坏作用域' },
        { scope: 'global', kind: 'rule', content: '合法的一条' },
      ],
    })
    assert.equal(result.imported, 1)
    assert.equal(result.rejected, 2)
    assert.equal(result.errors.length, 2)
    assert.equal(svc.listSync({ scopes: ['global'], kind: 'rule' }).length, 1)
  })
})

test('importRecords: 拒绝非文档格式与超量导入', async () => {
  await withDir(async (svc) => {
    await assert.rejects(() => svc.importRecords({ nope: true }), /IMPORT_INVALID/)
    await assert.rejects(() => svc.importRecords(Array.from({ length: 5001 }, () => ({ scope: 'global', content: 'x' }))), /IMPORT_TOO_LARGE/)
  })
})