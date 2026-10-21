/**
 * apply.ts 的审计链路测试。
 *
 * apply.ts 依赖宿主运行时 @deepseek-ai/dsh-llm（createUserMessage）。测试用
 * Node 的 module.registerHooks 把这个包映射成一个最小 stub，从而在不启动 DSH 的
 * 情况下真实跑一遍 pre-step：evaluation → delivery、失败、信号脱敏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { InjectAuditStore } from '../src/audit.ts'
import { defaultInjectSettings } from '../../memory-local/src/inject-settings.ts'

const STUB = 'data:text/javascript,' + encodeURIComponent(`
export function createUserMessage(input) {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    role: 'user',
    content: input.content,
    source: input.source,
  }
}
`)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') {
      return { url: STUB, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { apply } = await import('../src/apply.ts')

function record(id: string, content: string, tags: string[] = []): Record<string, unknown> {
  return {
    id, scope: 'project:D:/repo', kind: 'procedure', content, tags,
    source: { origin: 'explicit', at: 0 }, createdAt: 0, updatedAt: 1,
    lastAccessedAt: 0, accessCount: 0, importance: 0.8,
  }
}

function setup(options: {
  settings?: Record<string, unknown>
  list?: () => Promise<unknown[]>
  search?: (input: unknown) => Promise<unknown[]>
  listSync?: (input: unknown) => unknown[]
} = {}) {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const settings = options.settings ?? defaultInjectSettings
  const memory = {
    injectSettings: () => settings,
    resolveReadScopes: () => ['session:s1', 'project:D:/repo', 'global'],
    supersededIds: () => [],
    search: options.search ?? (async () => []),
    list: options.list ?? (async () => []),
    listSync: options.listSync ?? (() => []),
    attachInjectAudit: (_value: unknown) => {},
  }
  // attachInjectAudit 的真实语义是 provider 保存 sink；这里直接把 sink 暴露给断言。
  const attached = { current: null as InjectAuditStore | null }
  memory.attachInjectAudit = (value: any) => { attached.current = value }
  const sections: any[] = []
  const systemPrompt = { section: (section: unknown) => sections.push(section) }
  const ctx = {
    get: (name: string) => (name === 'memory' ? memory : undefined),
    on: (name: string, fn: (...args: any[]) => unknown) => { handlers.set(name, fn) },
    inject: (_names: string[], callback: (scoped: any) => void) => callback({ systemPrompt }),
  }
  apply(ctx as never, {})
  return { handlers, attached, sections, memory, settings }
}

function input() {
  return {
    agent: { session: { id: 's1', header: { cwd: 'D:/repo' } } },
    step: 1,
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '准备发布' }] }],
  }
}

async function runPreStep(handlers: Map<string, (...args: any[]) => unknown>, decision?: Record<string, unknown>) {
  const handler = handlers.get('agent/pre-step')
  assert.ok(handler)
  return handler!(input(), async () => decision ?? { kind: 'continue', messages: [] })
}

test('pre-step: 评估事件与 delivery 事件分离，未拿到宿主回执记 unknown', async () => {
  const hit = { record: record('mem-1', '发布前先检查 devcred 凭据', ['release']), score: 0.9 }
  const { handlers, attached } = setup({ search: async () => [hit] })
  const decision = await runPreStep(handlers) as { messages: unknown[] }
  assert.equal(decision.messages.length, 1, '真实追加了一条记忆消息')
  const entries = attached.current!.list()
  const delivery = entries.find((entry) => entry.kind === 'delivery')
  assert.ok(delivery)
  assert.equal(delivery!.delivery?.status, 'unknown')
  assert.equal(delivery!.delivery?.appended, null)
  assert.equal(delivery!.reasonCode, 'prepared')
  assert.ok((delivery!.delivery?.textChars ?? 0) > 0)
  const recall = entries.find((entry) => entry.channel === 'recall' && entry.kind === 'evaluation')
  assert.ok(recall)
  assert.ok(recall!.selected!.newlyAddedIds!.includes('mem-1'))
  assert.ok(recall!.scopes!.includes('project:D:/repo'))
  assert.ok(recall!.limits && recall!.limits.topK === 5)
  assert.equal(recall!.retrieval?.ok, true)
})

test('pre-step: 消息被重复保护拦下时 delivery=suppressed/dedup', async () => {
  const hit = { record: record('mem-1', '发布前先检查 devcred 凭据', ['release']), score: 0.9 }
  const first = setup({ search: async () => [hit] })
  const firstDecision = await runPreStep(first.handlers) as { messages: any[] }
  const memoryMessage = firstDecision.messages[0]
  const second = setup({ search: async () => [hit] })
  const decision = await runPreStep(second.handlers, { kind: 'continue', messages: [memoryMessage] }) as { messages: unknown[] }
  assert.equal(decision.messages.length, 1, '没有追加第二条')
  const delivery = second.attached.current!.list().find((entry) => entry.kind === 'delivery')
  assert.equal(delivery!.delivery?.status, 'suppressed')
  assert.equal(delivery!.delivery?.suppressedBy, 'dedup')
})

test('pre-step: digest 加载失败留下稳定错误码，而不是静默消失', async () => {
  const settings = {
    ...defaultInjectSettings,
    recall: { ...defaultInjectSettings.recall, enabled: false },
    digest: { ...defaultInjectSettings.digest, enabled: true },
    rules: { ...defaultInjectSettings.rules, enabled: false },
    policy: { ...defaultInjectSettings.policy, enabled: false },
    turnEnd: { ...defaultInjectSettings.turnEnd, enabled: false },
  }
  const { handlers, attached } = setup({
    settings,
    list: async () => { throw new Error('down') },
  })
  const decision = await runPreStep(handlers) as { messages: unknown[] }
  assert.equal(decision.messages.length, 0)
  const entries = attached.current!.list()
  const digest = entries.find((entry) => entry.channel === 'digest')
  assert.ok(digest)
  assert.equal(digest!.outcome, 'failed')
  assert.equal(digest!.error?.code, 'source_load_failed')
  const delivery = entries.find((entry) => entry.kind === 'delivery')
  assert.equal(delivery!.delivery?.status, 'not_attempted')
})

test('信号观察: query 在写审计前脱敏', async () => {
  const settings = {
    ...defaultInjectSettings,
    autoRecall: { ...defaultInjectSettings.autoRecall, enabled: true, useMemoryTags: false, tags: ['release'] },
    recall: { ...defaultInjectSettings.recall, enabled: false },
  }
  const { handlers, attached } = setup({ settings })
  const onEvent = handlers.get('session/event')
  assert.ok(onEvent)
  onEvent!({ id: 's1' }, {
    type: 'tool/call',
    data: {
      name: 'ops_bash',
      callId: 'c1',
      arguments: JSON.stringify({ description: '发布 token=abcdefgh12345678' }),
    },
  })
  const signal = attached.current!.list().find((entry) => entry.kind === 'signal')
  assert.ok(signal)
  assert.ok(!(signal!.query?.text ?? '').includes('abcdefgh12345678'))
  assert.equal(signal!.query?.redacted, true)
  assert.ok(signal!.query?.text?.includes('[REDACTED:'))
})
