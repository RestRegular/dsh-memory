import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryService } from '../src/index.ts'
import {
  defaultInjectSettings,
  mergeInjectSettings,
  normalizeInjectSettings,
} from '../src/inject-settings.ts'

function fresh(dir, config = {}) {
  return new LocalMemoryService({ storeDir: dir, scopes: { global: true, project: true }, ...config })
}

test('normalizeInjectSettings: 默认值、越界夹紧、脏数据不炸', () => {
  assert.deepEqual(normalizeInjectSettings(undefined), defaultInjectSettings)
  assert.deepEqual(normalizeInjectSettings('nonsense'), defaultInjectSettings)
  const clamped = normalizeInjectSettings({
    recall: { topK: 999, tokenBudget: 1 },
    impression: { chars: 5 },
    rules: { maxItems: 0 },
  })
  assert.equal(clamped.recall.topK, 20)
  assert.equal(clamped.recall.tokenBudget, 50)
  assert.equal(clamped.impression.chars, 40)
  assert.equal(clamped.rules.maxItems, 1)
  // 规则变更提醒默认开:老 settings.json 没有这个字段时不能静默关掉
  assert.equal(clamped.rules.delta, true)
  assert.equal(normalizeInjectSettings({ rules: { delta: false } }).rules.delta, false)
})

test('normalizeInjectSettings: 老的扁平 inject 配置映射到 recall', () => {
  const settings = normalizeInjectSettings({ enabled: false, topK: 3, tokenBudget: 222 })
  assert.equal(settings.recall.enabled, false)
  assert.equal(settings.recall.topK, 3)
  assert.equal(settings.recall.tokenBudget, 222)
  // 摘要 / 规则等新开关保持默认
  assert.equal(settings.digest.enabled, defaultInjectSettings.digest.enabled)
  assert.equal(settings.rules.enabled, defaultInjectSettings.rules.enabled)
})

test('mergeInjectSettings: 只合并已知字段,其余保持原值', () => {
  const merged = mergeInjectSettings(defaultInjectSettings, {
    digest: { enabled: false },
    nope: { enabled: true },
  })
  assert.equal(merged.digest.enabled, false)
  assert.equal(merged.digest.topK, defaultInjectSettings.digest.topK)
  assert.equal(merged.recall.enabled, true)
  assert.equal(Object.hasOwn(merged, 'nope'), false)
})

test('provider: updateInjectSettings 落盘,重启后读回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-settings-'))
  try {
    const svc = fresh(dir)
    const next = svc.updateInjectSettings({ impression: { enabled: false, chars: 88 }, turnEnd: { enabled: true } })
    assert.equal(next.impression.enabled, false)
    assert.equal(next.impression.chars, 88)
    assert.equal(next.turnEnd.enabled, true)
    assert.ok(existsSync(join(dir, 'settings.json')))
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    assert.equal(onDisk.impression.chars, 88)
    svc.flushSync()

    const reopened = fresh(dir)
    assert.equal(reopened.injectSettings().impression.enabled, false)
    assert.equal(reopened.injectSettings().impression.chars, 88)
    assert.equal(reopened.injectSettings().turnEnd.enabled, true)
    reopened.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('provider: listSync 只读已加载的 scope,按 kind 过滤', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-settings-'))
  try {
    const svc = fresh(dir)
    await svc.save({ scope: 'project:x', kind: 'rule', content: '规则甲' })
    await svc.save({ scope: 'project:x', kind: 'note', content: '普通记录' })
    await svc.save({ scope: 'global', kind: 'rule', content: '全局规则' })
    const rules = svc.listSync({ scopes: ['project:x', 'global'], kind: 'rule' })
    assert.deepEqual(rules.map((r) => r.content).sort(), ['全局规则', '规则甲'])
    assert.equal(svc.listSync({ scopes: ['project:x'], kind: 'note' }).length, 1)
    svc.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('sidebar: 默认关闭,面板可把它打开', () => {
  assert.equal(normalizeInjectSettings(undefined).sidebar.enabled, false)
  const merged = mergeInjectSettings(defaultInjectSettings, { sidebar: { enabled: true } })
  assert.equal(merged.sidebar.enabled, true)
})
