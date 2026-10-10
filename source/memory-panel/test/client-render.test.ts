/**
 * Render smoke test for the memory panel client bundle.
 *
 * The panel is hand-written plain JS served through the host's ModuleLoader, so
 * nothing type-checks it and there is no local react-dom to mount it. This test
 * loads the real bundle through the real loader contract (`window.__ModuleLoader__.load`)
 * with a minimal React (useState with re-render, useEffect collected so a test
 * can run it) plus a stubbed `fetch`, then asserts what the user actually sees:
 *   - a record card is COLLAPSED by default (preview only, no full body, no actions)
 *   - expanding it surfaces the full content plus 编辑/删除
 *   - an UNCONFIGURED vector backend offers 下载并配置, and no dead switch
 *   - only a backend this app manages gets a switch (external / disabled never do)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

type VNode = { type: unknown; props: Record<string, unknown>; children: unknown[] }

/** Minimal React: createElement + useState (with re-render) + collectable useEffect. */
function makeReact() {
  const states: unknown[] = []
  const effects: (() => unknown)[] = []
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
    useEffect(fn: () => unknown) { effects.push(fn) },
  }

  return {
    React,
    createElement,
    states,
    reset: () => { cursor = 0 },
    /** Drop all hook state so each test renders a component from a clean slate. */
    resetAll: () => { states.length = 0; effects.length = 0; cursor = 0; pending = null },
    setRerender: (fn: () => void) => { pending = fn },
    /** Run the effects collected during the last render (mount semantics). */
    runEffects: () => { const list = effects.splice(0); for (const fn of list) fn() },
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
  assert.equal(reg.id, '@restregular/dsh-memory-panel', 'ModuleLoader id must equal the package name')
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

/** Stub `fetch` the way the panel's api() uses it and let the mount effect run. */
async function mountPanel(hooks: ReturnType<typeof makeReact>, state: { scopes: unknown[]; embedServer: unknown }) {
  const globals = globalThis as Record<string, unknown>
  globals.fetch = async (url: string) => ({
    status: 200,
    json: async () => (String(url).includes('/status')
      ? { ok: true, value: state }
      : { ok: true, value: { records: [] } }),
  })
  const { exports } = await loadBundle()
  const MemoryPanel = (exports.__test as { MemoryPanel: (p: Record<string, unknown>) => unknown }).MemoryPanel
  const element = () => hooks.React.createElement(MemoryPanel, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  hooks.runEffects()
  for (let i = 0; i < 6; i++) await Promise.resolve()
  return () => current
}

const installIdle = (over: Record<string, unknown> = {}) => ({
  phase: 'idle', message: '', receivedBytes: 0, totalBytes: null, error: null, installed: false, root: 'D:/stack', ...over,
})

test('an unconfigured backend offers 下载并配置 instead of a dead switch', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const tree = await mountPanel(hooks, {
    scopes: [{ scope: 'global', records: 3, pendingEmbeds: 3 }],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      spawnConfigured: false, owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 3,
      install: installIdle(),
    },
  })
  const nodes = collect(tree())
  assert.equal(nodes.filter((n) => n.props?.role === 'switch').length, 0, 'no switch before a backend is configured')
  const text = textOf(tree())
  assert.ok(text.includes('下载并配置'), 'the installer button is the action')
  assert.ok(text.includes('向量未启用'), 'the stats card does not pretend there is an embed backlog')
  // clicking it must POST to the install route
  const calls: string[] = []
  ;(globalThis as Record<string, unknown>).fetch = async (url: string) => {
    calls.push(String(url))
    return { status: 200, json: async () => ({ ok: true, value: { install: installIdle() } }) }
  }
  const button = nodes.find((n) => n.tag === 'button' && (n.children ?? []).some((c) => c.text === '下载并配置'))
  assert.ok(button, 'installer button found')
  ;(button!.props!.onClick as () => void)()
  await Promise.resolve()
  assert.ok(calls.some((u) => u.endsWith('/embed/install')), `expected an install POST, got ${calls.join(', ')}`)
})

test('only a managed backend renders a switch; external and config-disabled do not', async () => {
  const { hooks } = await loadBundle()

  const managed = {
    enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
    spawnConfigured: true, owned: true, pid: 42, baseUrl: 'http://127.0.0.1:8078', reachable: true, pendingEmbeds: 0,
    install: installIdle({ installed: true }),
  }

  hooks.resetAll()
  const managedTree = await mountPanel(hooks, { scopes: [], embedServer: managed })
  const switches = collect(managedTree()).filter((n) => n.props?.role === 'switch')
  assert.equal(switches.length, 1, 'exactly one switch when this app owns the process')
  assert.ok(String(switches[0]!.props?.className).includes('toggle'), 'switch uses the toggle styling')
  assert.equal(switches[0]!.props?.['aria-checked'], true, 'on while reachable')
  assert.ok(textOf(managedTree()).includes('由本应用托管'), 'explains who owns the process')

  hooks.resetAll()
  const externalTree = await mountPanel(hooks, {
    scopes: [],
    embedServer: { ...managed, mode: 'external', spawnConfigured: false, owned: false, pid: null, install: installIdle() },
  })
  assert.equal(collect(externalTree()).filter((n) => n.props?.role === 'switch').length, 0, 'no switch for an external service')
  assert.ok(textOf(externalTree()).includes('外部服务'), 'labels the service as external')

  hooks.resetAll()
  const offTree = await mountPanel(hooks, { scopes: [], embedServer: { ...managed, enabled: false } })
  assert.equal(collect(offTree()).filter((n) => n.props?.role === 'switch').length, 0, 'no switch when the config disables vectors')
  assert.ok(textOf(offTree()).includes('已在配置里关闭'), 'says the config disabled it')
})

test('clicking install keeps polling even while the provider still reports idle', async () => {
  const { exports } = await loadBundle()
  const shouldPoll = (exports.__test as { shouldPollInstall: (phase: string, requested: boolean) => boolean }).shouldPollInstall
  assert.equal(shouldPoll('idle', false), false, 'nothing to poll before anything is running')
  // The regression this pins: POST /embed/install returns before the provider
  // flips the phase, so the very next status can still be 'idle' — polling must
  // already be on, otherwise the panel never shows a single progress update.
  assert.equal(shouldPoll('idle', true), true, 'a requested install polls even at idle')
  assert.equal(shouldPoll('downloading-runtime', false), true)
  assert.equal(shouldPoll('extracting', false), true)
  assert.equal(shouldPoll('done', true), false, 'stop polling once it settled')
  assert.equal(shouldPoll('error', true), false, 'stop polling after a failure')
})

test('maintenance asks before destroying: two-step confirm, and the right request', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const state = {
    scopes: [{ scope: 'global', records: 4, pendingEmbeds: 0 }],
    embedServer: {
      enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      spawnConfigured: true, owned: true, pid: 7, baseUrl: 'http://127.0.0.1:8078', reachable: true, pendingEmbeds: 0,
      install: installIdle({ installed: true }),
      maintenance: { usageBytes: 507510784, paths: ['D:/stack/llamacpp', 'D:/stack/models'], storeDir: 'D:/store', records: 4 },
    },
  }
  const tree = await mountPanel(hooks, state)

  const text = textOf(tree())
  assert.ok(text.includes('维护'), 'maintenance section is rendered')
  assert.ok(text.includes('484.0 MB'), `shows the size an uninstall would free (got: ${text.slice(0, 160)})`)
  assert.ok(text.includes('记忆数据 4 条'), 'shows how much data a wipe would remove')

  // Swap in a capturing stub: the panel's actions go through the global fetch.
  // Status/records keep answering, so the reload that follows an action renders
  // the same panel instead of blanking it.
  const calls: Array<{ url: string; body: unknown }> = []
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { body?: string }) => {
    const target = String(url)
    if (target.includes('/status')) return { status: 200, json: async () => ({ ok: true, value: state }) }
    if (target.includes('/records')) return { status: 200, json: async () => ({ ok: true, value: { records: [] } }) }
    calls.push({ url: target, body: init?.body ? JSON.parse(init.body) : undefined })
    // The real routes answer with the whole spread status, not a fragment.
    return { status: 200, json: async () => ({ ok: true, value: { ...state.embedServer, install: installIdle() } }) }
  }
  // The panel reloads after any action (records + status), so only count the actions themselves.
  const actionCalls = () => calls.filter((c) => /\/embed\/|\/data\//.test(c.url))
  const findButton = (label: string) => collect(tree()).find((n) => n.tag === 'button'
    && (n.children ?? []).some((c) => typeof c.text === 'string' && c.text.includes(label)))

  // Uninstall: the first click only arms the confirmation, the second sends it.
  const uninstall = findButton('卸载向量服务')
  assert.ok(uninstall, 'uninstall button present')
  ;(uninstall!.props!.onClick as () => void)()
  assert.ok(textOf(tree()).includes('确认卸载'), 'first click asks for confirmation')
  assert.equal(actionCalls().length, 0, 'nothing is deleted on the first click')
  ;(findButton('确认卸载')!.props!.onClick as () => void)()
  for (let i = 0; i < 6; i++) await Promise.resolve()
  assert.equal(actionCalls().length, 1, `the confirmed click issues exactly one request (got ${actionCalls().length})`)
  assert.ok(actionCalls()[0]!.url.endsWith('/embed/uninstall'), `uninstall posts to its route (${actionCalls()[0]!.url})`)

  // Wipe: same two-step dance, and the irreversible call carries the token the
  // server demands (a bare click must never be enough).
  const wipe = findButton('清空记忆数据')
  assert.ok(wipe, 'wipe button present')
  ;(wipe!.props!.onClick as () => void)()
  assert.ok(textOf(tree()).includes('确认清空'), 'first click asks for confirmation')
  assert.equal(actionCalls().length, 1, 'nothing is wiped on the first click')
  ;(findButton('确认清空')!.props!.onClick as () => void)()
  for (let i = 0; i < 6; i++) await Promise.resolve()
  assert.equal(actionCalls().length, 2, `the confirmed click issues the wipe (got ${actionCalls().length})`)
  assert.ok(actionCalls()[1]!.url.endsWith('/data/wipe'), `wipe posts to its route (${actionCalls()[1]!.url})`)
  assert.deepEqual(actionCalls()[1]!.body, { confirm: 'delete' }, 'wipe carries the irreversible-action token')
})

test('the installer shows progress while downloading and an error with a retry', async () => {
  const { hooks } = await loadBundle()

  hooks.resetAll()
  const runningTree = await mountPanel(hooks, {
    scopes: [],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: '', model: 'bge-m3', spawnConfigured: false,
      owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0,
      install: installIdle({ phase: 'downloading-model', message: '正在下载 bge-m3 模型', receivedBytes: 104857600, totalBytes: 437780480, installed: false }),
    },
  })
  const runningText = textOf(runningTree())
  assert.ok(runningText.includes('正在下载 bge-m3 模型'), 'shows the installer message')
  assert.ok(/\d+%/.test(runningText), 'shows a percentage')
  assert.ok(runningText.includes('取消'), 'offers cancel while running')

  hooks.resetAll()
  const failedTree = await mountPanel(hooks, {
    scopes: [],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: '', model: 'bge-m3', spawnConfigured: false,
      owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0,
      install: installIdle({ phase: 'error', message: 'GitHub API 限流', error: 'GitHub API 限流', installed: false }),
    },
  })
  const failedText = textOf(failedTree())
  assert.ok(failedText.includes('GitHub API 限流'), 'surfaces the failure reason')
  assert.ok(failedText.includes('重试下载'), 'offers a retry')
})
