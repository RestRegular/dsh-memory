/**
 * Render smoke test for the memory panel client bundle.
 *
 * The panel is hand-written plain JS served through the host's ModuleLoader, so
 * nothing type-checks it and there is no local react-dom to mount it. This test
 * loads the real bundle through the real loader contract (`window.__ModuleLoader__.load`)
 * with a minimal React that supports useState, then asserts the structure the
 * user actually sees:
 *   - a record card is COLLAPSED by default (preview only, no full body, no actions)
 *   - expanding it surfaces the full content plus 编辑/删除
 *   - the embedding backend is ONE switch (role="switch"), not start/stop buttons
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

type VNode = { type: unknown; props: Record<string, unknown>; children: unknown[] }

/** Minimal React: createElement + useState (with re-render), useEffect ignored. */
function makeReact() {
  const states: unknown[] = []
  let cursor = 0
  let pending: (() => void) | null = null

  const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): VNode => ({
    type,
    props: props ?? {},
    children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
  })

  const React = {
    createElement,
    useState(initial: unknown) {
      const i = cursor++
      if (!(i in states)) states[i] = initial
      const set = (v: unknown) => {
        states[i] = typeof v === 'function' ? (v as (prev: unknown) => unknown)(states[i]) : v
        if (pending) pending()
      }
      return [states[i], set] as const
    },
    useEffect() { /* effects (fetch) are intentionally not run */ },
  }

  return {
    React,
    createElement,
    states,
    reset: () => { cursor = 0 },
    /** Drop all hook state so each test renders a component from a clean slate. */
    resetAll: () => { states.length = 0; cursor = 0; pending = null },
    setRerender: (fn: () => void) => { pending = fn },
  }
}

interface RenderNode { tag?: unknown; props?: Record<string, unknown>; text?: string; children?: RenderNode[] }

function render(node: unknown, hooks: ReturnType<typeof makeReact>): RenderNode | null {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) return { children: node.map((n) => render(n, hooks)).filter(Boolean) as RenderNode[] }
  const vnode = node as VNode
  if (typeof vnode.type === 'function') {
    hooks.reset()
    return render((vnode.type as (p: Record<string, unknown>) => unknown)({ ...vnode.props, children: vnode.children }), hooks)
  }
  return {
    tag: vnode.type,
    props: vnode.props,
    children: vnode.children.map((n) => render(n, hooks)).filter(Boolean) as RenderNode[],
  }
}

function collect(node: RenderNode | null, out: RenderNode[] = []): RenderNode[] {
  if (!node) return out
  out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
}

function textOf(node: RenderNode | null): string {
  const parts: string[] = []
  for (const n of collect(node)) if (n.text !== undefined) parts.push(n.text)
  return parts.join(' ')
}

async function loadBundleImpl() {
  const hooks = makeReact()
  let registration: { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> } | null = null
  const globals = globalThis as Record<string, unknown>
  globals.window = {
    __ModuleLoader__: {
      load(reg: typeof registration) { registration = reg },
    },
  }
  globals.document = {
    createElement: () => ({ set textContent(_v: string) {}, remove() {} }),
    head: { appendChild() {} },
  }
  const requireShim = (name: string) => {
    if (name === 'react') return hooks.React
    throw new Error(`unexpected require("${name}") in the client bundle`)
  }
  await import('../lib/client.js')
  assert.ok(registration, 'bundle must call window.__ModuleLoader__.load')
  const reg = registration as unknown as { id: string; factory: (r: (n: string) => unknown) => Record<string, unknown> }
  assert.equal(reg.id, 'dsh-memory-panel', 'ModuleLoader id must equal the loader entry name')
  const exports = reg.factory(requireShim)
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  return { exports, hooks }
}

// ESM caches the bundle, so it can only be evaluated once per process.
let cached: Promise<{ exports: Record<string, unknown>; hooks: ReturnType<typeof makeReact> }> | null = null
function loadBundle() {
  if (!cached) cached = loadBundleImpl()
  return cached
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  const content = '这是一条用于渲染冒烟测试的记忆内容,它足够长以便检查折叠预览是否生效。'.repeat(3)
  return {
    id: 'rec-1',
    scope: 'project:C:/demo',
    kind: 'fact',
    content,
    tags: ['demo'],
    importance: 0.6,
    createdAt: 1,
    updatedAt: 1,
    accessCount: 0,
    supersededBy: null,
    supersedes: null,
    embedded: true,
    ...overrides,
  }
}

test('record cards render collapsed by default (preview only, no actions)', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const RecordCard = (exports.__test as { RecordCard: (p: Record<string, unknown>) => unknown }).RecordCard
  const rec = makeRecord()
  // go through createElement so the renderer resets the hook cursor for us
  const tree = render(hooks.React.createElement(RecordCard, { rec, onSaved: () => {}, onDeleted: () => {} }), hooks)

  const nodes = collect(tree)
  const classNames = nodes.map((n) => String(n.props?.className ?? ''))
  assert.ok(classNames.includes('rec'), 'card wrapper')
  assert.ok(classNames.includes('preview'), 'collapsed card shows the one-line preview')
  assert.ok(!classNames.includes('content'), 'collapsed card must NOT render the full body')

  const text = textOf(tree)
  assert.ok(text.includes('fact'), 'meta stays visible when collapsed')
  assert.ok(!text.includes('编辑'), 'edit action is hidden until expanded')
  assert.ok(!text.includes('删除'), 'delete action is hidden until expanded')
  assert.ok(text.includes(rec.content.slice(0, 20)), 'preview text present')

  // the header is the toggle affordance
  const head = nodes.find((n) => String(n.props?.className ?? '').startsWith('rec-head'))
  assert.ok(head, 'header exists')
  assert.equal(head!.props?.['aria-expanded'], false, 'collapsed by default')
  assert.equal(head!.props?.role, 'button')
})

test('expanding a card reveals the full content and the actions', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const RecordCard = (exports.__test as { RecordCard: (p: Record<string, unknown>) => unknown }).RecordCard
  const rec = makeRecord()
  const element = () => hooks.React.createElement(RecordCard, { rec, onSaved: () => {}, onDeleted: () => {} })

  // wire setState → re-render so the toggle actually flips
  let current: RenderNode | null = null
  hooks.setRerender(() => { current = render(element(), hooks) })
  current = render(element(), hooks)

  const head = collect(current).find((n) => String(n.props?.className ?? '').startsWith('rec-head'))
  assert.ok(head, 'header exists')
  ;(head!.props!.onClick as () => void)()

  const nodes = collect(current)
  const classNames = nodes.map((n) => String(n.props?.className ?? ''))
  assert.ok(classNames.includes('content'), 'expanded card renders the full body')
  assert.ok(!classNames.includes('preview'), 'preview is replaced when expanded')
  const text = textOf(current)
  assert.ok(text.includes('编辑') && text.includes('删除'), 'actions available once expanded')
})

test('the embedding backend is a single switch, not start/stop buttons', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const MemoryPanel = (exports.__test as { MemoryPanel: (p: Record<string, unknown>) => unknown }).MemoryPanel
  const tree = render(hooks.React.createElement(MemoryPanel, {}), hooks)
  const nodes = collect(tree)

  const switches = nodes.filter((n) => n.props?.role === 'switch')
  assert.equal(switches.length, 1, 'exactly one switch controls the server')
  assert.ok(String(switches[0]!.props?.className).includes('toggle'), 'switch uses the toggle styling')
  assert.equal(switches[0]!.props?.['aria-checked'], false, 'off while no status has loaded')

  const text = textOf(tree)
  assert.ok(!text.includes('启动服务') && !text.includes('停止服务'), 'old start/stop buttons are gone')
  assert.ok(text.includes('向量服务'), 'server card present')
})
