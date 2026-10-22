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
 *   - an UNCONFIGURED vector backend offers the model list + 下载并安装, and no dead switch
 *   - only a backend this app manages gets a switch (external / disabled never do)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 合并后客户端 bundle 归单包所有:期望的注册 id 就是那个包的包名。
 * 从包里读而不是写死字符串 —— 写死的那份在改名/合并时会静默过期,
 * 而这类不一致的失败形态正是「面板不出现」。
 */
const PACKAGE_NAME = (
  JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'memory-plugin', 'package.json'), 'utf8')) as { name: string }
).name

type VNode = { type: unknown; props: Record<string, unknown>; children: unknown[] }

/** Minimal React: createElement + useState (with re-render) + collectable useEffect. */
function makeReact() {
  // 每个组件实例一份状态槽:key 由 render 的路径推导(见 render 的 path 参数)。
  // 早先是一个全局数组 + cursor,嵌套组件会把父组件的槽位写坏 —— 只有在"子组件渲染
  // 发生在父组件读完自己的 state 之后"时才侥幸能过,而面板一加嵌套的有状态组件
  // (ModelPicker)就静默把父组件的 embedServer 改成了空字符串。
  const store = new Map<string, unknown[]>()
  const effects: (() => unknown)[] = []
  /** effect 返回的清理函数:resetAll 时统一执行(等价于 React 卸载)。 */
  const cleanups: Array<() => unknown> = []
  let key = 'root'
  let cursor = 0
  let pending: (() => void) | null = null

  const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): VNode => ({
    type,
    props: props ?? {},
    // 保留 null/undefined/false 槽位:React 的身份是**按位置**的,条件渲染时下标不能漂移,
    // 否则兄弟节点一变,嵌套组件的状态就被重置(踩过:chipRow 出现后 ModelPicker 被重挂)。
    children: children.flat(),
  })

  const React = {
    createElement,
    useState(initial: unknown) {
      const slots = store.get(key) ?? []
      const i = cursor++
      if (!(i in slots)) slots[i] = initial
      store.set(key, slots)
      const set = (v: unknown) => {
        slots[i] = typeof v === 'function' ? (v as (prev: unknown) => unknown)(slots[i]) : v
        if (pending) pending()
      }
      return [slots[i], set] as const
    },
    useEffect(fn: () => unknown) { effects.push(fn) },
    useRef(initial: unknown) {
      const slots = store.get(key) ?? []
      const i = cursor++
      if (!(i in slots)) slots[i] = { current: initial }
      store.set(key, slots)
      return slots[i] as { current: unknown }
    },
  }

  return {
    React,
    createElement,
    /** 进入一个组件/元素路径:它拥有自己的一组状态槽。 */
    enter: (next: string) => { key = next; cursor = 0 },
    /** Drop all hook state so each test renders a component from a clean slate. */
    resetAll: () => {
      // 先卸载:effect 的清理函数要跑(否则 setInterval 之类的句柄会留在事件循环里,
      // 测试全绿但进程永不退出)。
      for (const cleanup of cleanups.splice(0)) { try { cleanup() } catch { /* 清理失败不影响测试 */ } }
      store.clear()
      effects.length = 0
      key = 'root'
      cursor = 0
      pending = null
    },
    /** 新一轮渲染提交开始:上一轮没来得及跑的 effect 直接丢弃(见 render 的注释)。 */
    beginPass: () => { effects.length = 0 },
    setRerender: (fn: () => void) => { pending = fn },
    /** Run the effects collected during the last render (mount semantics). */
    runEffects: () => {
      const list = effects.splice(0)
      for (const fn of list) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown)
      }
    },
  }
}

interface RenderNode { tag?: unknown; props?: Record<string, unknown>; text?: string; children?: RenderNode[] }

/**
 * 一次"渲染提交"只保留**这一轮**注册的 effect。
 *
 * 不这么做的话 `effects` 会跨多轮渲染累积:测试里每次 await 都会让 load() 的 setState
 * 触发一轮同步重渲,每轮都重新注册"拉数据"与"自动刷新"effect;下一次 runEffects()
 * 会把**所有历史轮次**的 effect 一起跑掉(每个 load 又触发新一轮渲染),效应量级按
 * 轮数指数增长。0.12.7 之后审计页自动刷新把这条放大到 100MB/测试,整套用例在默认
 * 2GB 堆上直接 OOM。React 里 effect 是按提交轮次执行的,这里只保留最新一轮更贴近
 * 真实语义;跨组件累积则由 resetAll() 清空。
 */
let renderDepth = 0

function render(node: unknown, hooks: ReturnType<typeof makeReact>, path = 'root'): RenderNode | null {
  const outermost = renderDepth === 0
  if (outermost) hooks.beginPass()
  renderDepth += 1
  try {
    return renderNode(node, hooks, path)
  } finally {
    renderDepth -= 1
  }
}

function renderNode(node: unknown, hooks: ReturnType<typeof makeReact>, path = 'root'): RenderNode | null {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) return { children: node.map((n, i) => render(n, hooks, `${path}[${i}]`)).filter(Boolean) as RenderNode[] }
  const vnode = node as VNode
  if (typeof vnode.type === 'function') {
    const component = vnode.type as (p: Record<string, unknown>) => unknown
    const childPath = `${path}/${component.name || 'fn'}`
    hooks.enter(childPath)
    return render(component({ ...vnode.props, children: vnode.children }), hooks, childPath)
  }
  const elementPath = `${path}/${String(vnode.type)}`
  hooks.enter(elementPath)
  return {
    tag: vnode.type,
    props: vnode.props,
    children: vnode.children.map((n, i) => render(n, hooks, `${elementPath}/${i}`)).filter(Boolean) as RenderNode[],
  }
}

function collect(node: RenderNode | null, out: RenderNode[] = []): RenderNode[] {
  if (!node) return out
  out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
}

function toggledText(node: RenderNode | null): string {
  return (node?.children ?? []).map((child) => textOf(child)).join(' ')
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
  assert.equal(reg.id, PACKAGE_NAME, 'ModuleLoader id must equal the package name')
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

/** 面板里的「模型与硬件」会用到的报告(探测结果用假数据,理由文本断言用不到它)。 */
const modelReport = () => ({
  catalog: [
    {
      id: 'bge-m3', label: 'BGE-M3', note: '', dims: 1024, pooling: 'cls', languages: 'multilingual',
      contextTokens: 8192, sizeBytes: 437778496, installed: false,
      variants: [{ id: 'q4_k_m', label: 'Q4_K_M', bytes: 437778496, file: 'bge-m3-Q4_K_M.gguf', installed: false }],
    },
    {
      id: 'qwen3-embedding-0.6b', label: 'Qwen3-Embedding-0.6B', note: '', dims: 1024, pooling: 'last', languages: 'multilingual',
      contextTokens: 32768, sizeBytes: 639171584, installed: false,
      variants: [{ id: 'q8_0', label: 'Q8_0', bytes: 639171584, file: 'Qwen3-Embedding-0.6B-Q8_0.gguf', installed: false }],
    },
  ],
  current: {
    presetId: 'bge-m3', variantId: 'q4_k_m', modelLabel: 'BGE-M3 · Q4_K_M', file: 'bge-m3-Q4_K_M.gguf',
    dims: 1024, pooling: 'cls', flavor: 'cpu', model: 'bge-m3',
  },
  hardware: {
    platform: 'win32', arch: 'x64', cpuCount: 12, totalRamMb: 14336, freeDiskMb: 9553,
    diskPath: 'C:/x', gpu: null, flavors: ['cpu'], notes: [],
  },
  recommendation: {
    modelId: 'qwen3-embedding-0.6b', variantId: 'q8_0', flavor: 'cpu',
    reason: ['这台机器:12 核 · 14GB 内存'], warnings: [], alternatives: [], candidates: [],
  },
  locale: 'zh-CN',
  records: 3,
})

/** Stub `fetch` the way the panel's api() uses it and let the mount effect run. */
async function mountPanel(
  hooks: ReturnType<typeof makeReact>,
  state: { scopes: unknown[]; embedServer: unknown },
  report = modelReport(),
  tab = 'data',
) {
  const globals = globalThis as Record<string, unknown>
  globals.fetch = async (url: string) => ({
    status: 200,
    json: async () => (String(url).includes('/embed/model')
      ? { ok: true, value: report }
      : String(url).includes('/status')
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
  // 第二轮:清单/状态请求回来后,才会把选择抛给面板(「当前」那行由它驱动)
  hooks.runEffects()
  for (let i = 0; i < 4; i++) await Promise.resolve()
  if (tab !== 'data') {
    const label = ({ records: '服务', data: '记录', tree: '记忆树', settings: '设置' } as Record<string, string>)[tab] ?? tab
    const button = collect(current).find((n) => n.tag === 'button' && textOf(n).trim() === label)
    assert.ok(button, `找不到「${label}」标签`)
    ;(button!.props!.onClick as () => void)()
    hooks.runEffects()
    for (let i = 0; i < 8; i++) await Promise.resolve()
    hooks.runEffects()
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }
  return () => current
}

/**
 * 切到指定标签。默认标签是「数据」(记忆列表),概览(统计/向量服务/维护)
 * 在「记录」里,所以涉及服务卡片/安装器的断言先调这个。
 */
async function switchTab(
  current: () => RenderNode | null,
  hooks: ReturnType<typeof makeReact>,
  label: string,
) {
  const tab = collect(current()).find((n) => n.tag === 'button' && textOf(n).trim() === label)
  assert.ok(tab, `找不到「${label}」标签`)
  ;(tab!.props!.onClick as () => void)()
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

/** 树里所有标签气泡的文字(按出现顺序)。 */
function chipTexts(tree: RenderNode | null): string[] {
  return collect(tree)
    // 精确匹配 class 'chip':容器叫 'chips',用 includes 会把它也算进来
    .filter((n) => String(n.props?.className ?? '').split(/\s+/).includes('chip'))
    .map((n) => (n.children ?? []).map((c) => c.text).join(''))
}

const installIdle = (over: Record<string, unknown> = {}) => ({
  phase: 'idle', message: '', receivedBytes: 0, totalBytes: null, error: null, installed: false, root: 'D:/stack', ...over,
})

test('审计标签页:独立入口、真实空状态、不伪造数据', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const tree = await mountPanel(hooks, {
    scopes: [{ scope: 'session:sess-12345678', records: 1, pendingEmbeds: 0, label: '会话标题' }],
    embedServer: null,
  }, undefined, '审计')
  const text = textOf(tree())
  assert.ok(!text.includes('记忆审计'), '按需求移除顶部标题')
  assert.ok(!text.includes('追踪记忆注入'), '按需求移除解释文本')
  assert.ok(text.includes('自动刷新'), '自动刷新开关可见')
  assert.ok(text.includes('内存模式'), '如实显示内存模式')
  assert.ok(text.includes('当前筛选没有审计事件'), '无事件时显示真实空状态')
  assert.ok(!text.includes('已投递 42'), '不补造统计')
  hooks.resetAll()
})

test('审计标签页:真实事件渲染为事件流与详情,评估不等于投递', async () => {
  const { hooks, exports } = await loadBundle()
  hooks.resetAll()
  const entries = [
    {
      schemaVersion: 2, id: 's1:2', seq: 2, at: Date.now(), sessionId: 's1', step: 1,
      kind: 'delivery', channel: 'lifecycle', stage: 'delivery_prepared', outcome: 'unknown',
      reasonCode: 'prepared', channels: ['recall'], delivery: { status: 'unknown', appended: null, textChars: 42, textHash: 'fnv1a:abc' },
    },
    {
      schemaVersion: 2, id: 's1:1', seq: 1, at: Date.now(), sessionId: 's1', step: 1,
      kind: 'evaluation', channel: 'recall', stage: 'searched', outcome: 'success', reasonCode: 'injected',
      trigger: 'before_high_risk_tool', phase: 'release', scopes: ['session:s1', 'project:D:/repo', 'global'],
      limits: { topK: 5 }, candidates: 12, filter: { rawHits: 15, tagFiltered: 2, supersededExcluded: 1, candidates: 12 },
      selected: { contentIds: ['mem-1'], hintIds: [], newlyAddedIds: ['mem-1'], count: 1 },
      omitted: [{ id: 'mem-2', reason: 'top_k', tags: ['release'] }],
      dedup: { skipped: 3, updated: 0, lastTextSame: false, ids: ['mem-3'] },
      budgets: { recall: { budget: 500, used: 321, remaining: 179, over: false } },
      retrieval: { ok: true, count: 15 }, query: { text: '发布 token=[REDACTED:key-assignment]', chars: 32, redacted: true, hash: 'fnv1a:def' },
    },
  ]
  ;(globalThis as Record<string, unknown>).fetch = async () => ({
    status: 200,
    json: async () => ({ ok: true, value: { entries, total: 2, stats: { entries: 2, capacity: 2000, perSessionCapacity: 200, dropped: 0, writeErrors: 0, persistence: 'memory' } } }),
  })
  const AuditTab = (exports.__test as { AuditTab: (p: Record<string, unknown>) => unknown }).AuditTab
  const opened: { record?: { id: string; scope?: string }; session?: string } = {}
  const records = [{
    id: 'mem-1', scope: 'project:D:/repo', kind: 'procedure',
    content: '发布前先检查 devcred 凭据，并确认版本号与工作区状态。',
    tags: ['release', 'publish'], importance: 0.8, updatedAt: Date.now(),
  }]
  const element = () => hooks.React.createElement(AuditTab, {
    scopes: [{ scope: 'session:s1', label: '测试会话' }],
    records,
    openRecord: (id: string, scope?: string) => { opened.record = { id, scope } },
    openSession: (id: string) => { opened.session = id },
    sessionInfo: () => ({ title: '测试会话', cwd: 'D:/repo', updatedAt: Date.now(), running: true }),
  })
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  hooks.runEffects()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  const text = textOf(current)
  assert.ok(!text.includes('记忆审计'))
  assert.ok(text.includes('召回'), '通道名渲染')
  assert.ok(text.includes('已准备（投递未确认）'), 'unknown 投递不冒充已投递')
  assert.ok(text.includes('发布 token=[REDACTED:key-assignment]') === false, '列表不直接展示 query 原文')
  const nodes = collect(current)
  assert.ok(nodes.some((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-list')), '事件放在独立滚动容器里')
  assert.ok(nodes.some((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-table-head')), '列表有表头')
  assert.ok(nodes.some((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-budget-compact')), '行内预算使用紧凑条')
  assert.ok(text.includes('候选 / 选中 / 省略'), '表头列名可见')
  assert.ok(nodes.some((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-filter-row')), '筛选分两行布局')
  const nativeInputs = nodes.filter((n) => n.tag === 'input').map((n) => String(n.props?.type ?? ''))
  assert.ok(!nativeInputs.includes('date') && !nativeInputs.includes('checkbox'), '筛选使用自绘控件，不用原生 date/checkbox')
  const row = collect(current)
    .filter((n) => String(n.props?.className ?? '').startsWith('audit-row'))
    .find((n) => textOf(n).includes('召回'))
  assert.ok(row, '召回事件行存在')
  ;(row!.props!.onClick as () => void)()
  for (let i = 0; i < 2; i++) await Promise.resolve()
  const detail = textOf(current)
  assert.ok(detail.includes('检索与过滤'))
  assert.ok(detail.includes('原始命中'))
  assert.ok(detail.includes('省略 · 条数上限'))
  assert.ok(detail.includes('选中正文'))
  assert.ok(detail.includes('候选中的可枚举 ID'))
  assert.ok(detail.includes('fnv1a:def'), '详情展示已脱敏 query 的 hash')

  // 记忆 ID hover 显示原文浮窗，点击跳转到记录页。
  const recordChip = collect(current)
    .filter((n) => n.tag === 'button' && String(n.props?.className ?? '').split(/\s+/).includes('audit-id'))
    .find((n) => textOf(n).includes('mem-1'))
  assert.ok(recordChip, '选中记忆 ID 是按钮')
  ;(recordChip!.props!.onMouseEnter as (e: unknown) => void)({ clientX: 120, clientY: 120 })
  await new Promise((resolve) => setTimeout(resolve, 420))
  assert.ok(textOf(current).includes('发布前先检查 devcred 凭据'), 'hover 显示记忆原文')
  assert.ok(textOf(current).includes('mem-1'), '浮窗显示完整 ID')
  const tipNode = collect(current).find((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-tip'))
  assert.ok(tipNode, '浮窗已显示')
  ;(tipNode!.props!.onClick as () => void)()
  for (let i = 0; i < 2; i++) await Promise.resolve()
  assert.deepEqual(opened.record, { id: 'mem-1', scope: 'project:D:/repo' }, '点击浮窗也跳转')
  opened.record = undefined
  ;(recordChip!.props!.onClick as () => void)()
  for (let i = 0; i < 2; i++) await Promise.resolve()
  assert.deepEqual(opened.record, { id: 'mem-1', scope: 'project:D:/repo' })

  // 会话 ID hover 显示会话信息，点击打开会话。
  const sessionChip = collect(current)
    .filter((n) => n.tag === 'button' && String(n.props?.className ?? '').split(/\s+/).includes('audit-id'))
    .find((n) => textOf(n) === 's1')
  assert.ok(sessionChip, '会话 ID 是按钮')
  ;(sessionChip!.props!.onMouseEnter as (e: unknown) => void)({ clientX: 130, clientY: 130 })
  await new Promise((resolve) => setTimeout(resolve, 420))
  assert.ok(textOf(current).includes('测试会话'), 'hover 显示会话标题')
  assert.ok(textOf(current).includes('ID s1'), '浮窗显示完整会话 ID')
  ;(sessionChip!.props!.onClick as () => void)()
  for (let i = 0; i < 2; i++) await Promise.resolve()
  assert.equal(opened.session, 's1')
  hooks.resetAll()
})

test('作用域下拉用服务端给的 label(会话标题 / project 的 cwd)', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const tree = await mountPanel(hooks, {
    scopes: [
      { scope: 'global', records: 1, pendingEmbeds: 0, label: '全局' },
      { scope: 'project:C:/demo', records: 1, pendingEmbeds: 0, label: 'C:/demo' },
      { scope: 'session:sess-12345678', records: 1, pendingEmbeds: 0, label: '重构记忆作用域(sess-123)' },
      { scope: 'handbook', records: 1, pendingEmbeds: 0, label: 'handbook' },
    ],
    embedServer: null,
  })
  // 统计卡与作用域下拉都在「记录」页(默认标签)
  assert.ok(textOf(tree()).includes('4'), '作用域数来自 /status 的动态枚举')
  // 打开作用域下拉(结构里第二个 aria-haspopup=listbox;第一个是模型/运行时下拉),
  // 选项文字必须用 label(而不是原始 scope 键)
  const dropdowns = collect(tree()).filter((n) => n.props?.['aria-haspopup'] === 'listbox')
  assert.ok(dropdowns.length >= 1, '找到自绘下拉')
  const scopeDropdown = dropdowns[dropdowns.length - 1]!
  ;(scopeDropdown.props!.onClick as () => void)()
  hooks.runEffects()
  const optionTexts = collect(tree())
    .filter((n) => n.props?.role === 'option')
    .map((n) => textOf(n))
  assert.ok(optionTexts.includes('重构记忆作用域(sess-123)'), `下拉里显示会话标题(实际:${JSON.stringify(optionTexts)})`)
  assert.ok(optionTexts.includes('C:/demo'), 'project scope 显示 cwd')
  assert.ok(!optionTexts.includes('session:sess-12345678'), '不再回退成裸 scope 键')
})

test('未配置的后端:展开「模型与硬件」给出模型列表与安装按钮,而不是一个死开关', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const state = {
    scopes: [{ scope: 'global', records: 3, pendingEmbeds: 3 }],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      spawnConfigured: false, owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 3,
      install: installIdle(),
    },
  }
  // 统计卡在「记录」页:没有向量后端时不能假装有嵌入积压
  const dataTree = await mountPanel(hooks, state, undefined, '记录')
  assert.ok(textOf(dataTree()).includes('向量未启用'), 'the stats card does not pretend there is an embed backlog')
  hooks.resetAll()

  const tree = await mountPanel(hooks, state, undefined, '服务')
  const nodes = collect(tree())
  assert.equal(nodes.filter((n) => n.props?.role === 'switch').length, 0, 'no switch before a backend is configured')
  assert.ok(textOf(tree()).includes('向量检索为可选功能'), '可选说明紧跟在「模型与硬件」旁边')

  // 展开「模型与硬件」→ 才会去拉清单(硬件探测要等这一次请求)
  const details = nodes.find((n) => n.tag === 'details')
  assert.ok(details, '「模型与硬件」是折叠区块')
  ;(details!.props!.onToggle as (e: unknown) => void)({ target: { open: true } })
  // 展开触发重渲染,新收集到的 effect 要显式跑一次(测试脚手架的 mount 语义)
  hooks.runEffects()
  for (let i = 0; i < 8; i++) await Promise.resolve()

  const text = textOf(tree())
  assert.ok(chipTexts(tree()).includes('推荐'), `推荐项在列表里带「推荐」气泡(实际:${JSON.stringify(chipTexts(tree()))})`)
  assert.ok(!text.includes('这台机器'), '不再显示推荐理由')
  assert.ok(text.includes('下载并安装'), '安装按钮在模型区块里')

  // 点它必须 POST 到安装接口,并带上选中的模型(默认就是推荐项)
  const calls: Array<{ url: string; body: string | undefined }> = []
  ;(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body })
    return { status: 200, json: async () => ({ ok: true, value: { install: installIdle() } }) }
  }
  const button = collect(tree()).find((n) => n.tag === 'button' && (n.children ?? []).some((c) => c.text === '下载并安装'))
  assert.ok(button, 'installer button found')
  ;(button!.props!.onClick as () => void)()
  await Promise.resolve()
  const install = calls.find((c) => c.url.endsWith('/embed/install'))
  assert.ok(install, `expected an install POST, got ${calls.map((c) => c.url).join(', ')}`)
  assert.match(String(install!.body), /qwen3-embedding-0\.6b/, '安装请求带上推荐(默认选中)的模型')
})

test('「本机配置」「当前模型」两行:都带标题、都横向滚动,安装按钮在当前模型行右边', async () => {
  const { hooks, exports } = await loadBundle()
  hooks.resetAll()
  // 未配置:挂载后立刻就有内容(不等展开),当前模型 = 默认选中的推荐项
  const tree = await mountPanel(hooks, {
    scopes: [{ scope: 'global', records: 0, pendingEmbeds: 0 }],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      spawnConfigured: false, owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0, install: installIdle(),
    },
  }, undefined, 'records')
  const all = chipTexts(tree())
  // 本机配置在上面一行,当前模型在下面一行
  assert.deepEqual(all.slice(0, 4), ['12 核', '14GB 内存', '无独立显卡', '磁盘剩余 9GB'], `本机配置气泡:${JSON.stringify(all.slice(0, 4))}`)
  assert.deepEqual(all.slice(4, 9), ['Qwen3-Embedding-0.6B', 'Q8_0', '1024 维', 'last', 'cpu'], `当前模型气泡:${JSON.stringify(all.slice(4, 9))}`)

  const text = textOf(tree())
  assert.ok(text.includes('本机配置：'), '本机配置行有标题')
  assert.ok(text.includes('当前模型：'), '当前模型行有标题')
  assert.ok(text.includes('▸') && text.includes('模型与硬件'), '折叠标题左边有展开标志')

  // 两行结构:[标题][气泡(横向滚动)][动作按钮(居右)]
  const lines = collect(tree()).filter((n) => String(n.props?.className ?? '') === 'chipline')
  assert.equal(lines.length, 2, '两行:本机配置 / 当前模型')
  const row1 = lines[0]!.children ?? []
  const row2 = lines[1]!.children ?? []
  assert.deepEqual(row1[0]!.children!.map((c) => c.text), ['本机配置：'])
  assert.equal(String(row1[1]!.props?.className), 'chips')
  assert.deepEqual(row1[2]!.children!.map((c) => c.text), ['重新检测硬件'], '重新检测硬件在本机配置行最右边')
  assert.deepEqual(row2[0]!.children!.map((c) => c.text), ['当前模型：'])
  assert.equal(String(row2[1]!.props?.className), 'chips')
  assert.ok(String(row2[2]!.props?.className).includes('install'), '安装按钮在当前模型行、居右')
  assert.ok(text.includes('下载并安装'))

  // 两行都用同一套"不换行 + 横向滚动"的样式(CSS 契约)
  const css = (exports.__test as { CSS: string }).CSS
  const chipsRule = /\.memp \.chips\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(chipsRule, /flex-wrap:nowrap/, `气泡行不换行:${chipsRule}`)
  assert.match(chipsRule, /overflow-x:auto/, `气泡行横向滚动:${chipsRule}`)
  assert.match(chipsRule, /scrollbar-width:none/, `气泡行不显示滚动条:${chipsRule}`)
  assert.match(css, /\.memp \.chips::-webkit-scrollbar\{display:none/, 'Chromium 下也藏掉滚动条')
  assert.match(css, /button:hover\{[^}]*brand-primary/, '按钮统一有 hover 反馈')

  // 已配置:显示实际配置(不受列表里的默认选择影响)
  hooks.resetAll()
  const configuredTree = await mountPanel(hooks, {
    scopes: [{ scope: 'global', records: 0, pendingEmbeds: 0 }],
    embedServer: {
      enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      modelLabel: 'BGE-M3 · Q4_K_M', presetId: 'bge-m3', variantId: 'q4_k_m', dims: 1024, pooling: 'cls', flavor: 'cpu',
      spawnConfigured: true, owned: true, pid: 7, baseUrl: 'http://127.0.0.1:8078', reachable: true, pendingEmbeds: 0, install: installIdle({ installed: true }),
    },
  }, undefined, 'records')
  const configured = chipTexts(configuredTree())
  assert.deepEqual(configured.slice(4, 9), ['BGE-M3', 'Q4_K_M', '1024 维', 'cls', 'cpu'], `已配置时的当前模型:${JSON.stringify(configured)}`)

  // 自绘下拉:服务页是模型 / 运行时,作用域下拉在记录页;全站没有原生 select
  const nodes = collect(configuredTree())
  assert.equal(nodes.filter((n) => n.tag === 'select').length, 0, '不再使用原生 select')
  assert.equal(nodes.filter((n) => n.props?.['aria-haspopup'] === 'listbox').length, 2, '服务页有模型 / 运行时两个自绘下拉')
  await switchTab(configuredTree, hooks, '记录')
  assert.equal(collect(configuredTree()).filter((n) => n.props?.['aria-haspopup'] === 'listbox').length, 1, '记录页有作用域下拉')
  await switchTab(configuredTree, hooks, '服务')

  // 已装好的那一档:按钮显示「已安装」且不可点(点它只会重复下载)
  const installBtn = nodes.find((n) => String(n.props?.className ?? '') === 'install')
  assert.ok(installBtn, '安装按钮存在')
  assert.equal((installBtn!.children ?? []).map((c) => c.text).join(''), '已安装', '已装好的档位按钮文案')
  assert.equal(installBtn!.props?.disabled, true, '已装好的档位按钮不可点')

  // 换一个还没装的档 → 已经装了 bge-m3,所以这里必须要求先卸载,而不是直接再装一个
  // (第一个 listbox 触发器就是模型下拉:它在树里排在运行时/作用域前面)
  const trigger = collect(configuredTree()).find((n) => n.props?.['aria-haspopup'] === 'listbox')!
  ;(trigger.props!.onClick as () => void)()          // 展开
  const option = collect(configuredTree()).find((n) => n.props?.role === 'option' && textOf(n).includes('Qwen3-Embedding-0.6B'))!
  assert.ok(option, '下拉里能找到未安装的那一档')
  ;(option.props!.onClick as () => void)()           // 选中 qwen3(未安装)
  const after = collect(configuredTree()).find((n) => String(n.props?.className ?? '') === 'install')
  assert.equal((after!.children ?? []).map((c) => c.text).join(''), '需先卸载', '已装过模型时不许再装第二个')
  assert.equal(after!.props?.disabled, true, '必须先卸载才能换模型')
})

test('已经装了模型就不许再装:必须先卸载;卸载后按钮恢复可点', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()

  // 起点:装着 bge-m3(后端快照 + 清单都标已装),面板处于托管态
  const report = modelReport()
  report.catalog[0]!.installed = true
  report.catalog[0]!.variants[0]!.installed = true
  const state: { scopes: unknown[]; embedServer: Record<string, unknown> } = {
    scopes: [{ scope: 'global', records: 0, pendingEmbeds: 0 }],
    embedServer: {
      enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      modelLabel: 'BGE-M3 · Q4_K_M', presetId: 'bge-m3', variantId: 'q4_k_m', dims: 1024, pooling: 'cls', flavor: 'cpu',
      spawnConfigured: true, owned: true, pid: 7, baseUrl: 'http://127.0.0.1:8078', reachable: true, pendingEmbeds: 0,
      install: installIdle({ installed: true }),
    },
  }
  const tree = await mountPanel(hooks, state, report, 'records')
  const installBtn = () => collect(tree()).find((n) => String(n.props?.className ?? '') === 'install')
  const label = () => (installBtn()!.children ?? []).map((c) => c.text).join('')
  assert.equal(label(), '已安装', '装好的那一档显示已安装')
  assert.equal(installBtn()!.props?.disabled, true, '已安装不可点')

  // 选一个没装的档:不许直接再装一个 → 「需先卸载」
  const trigger = collect(tree()).find((n) => n.props?.['aria-haspopup'] === 'listbox')!
  ;(trigger.props!.onClick as () => void)()
  const option = collect(tree()).find((n) => n.props?.role === 'option' && textOf(n).includes('Qwen3-Embedding-0.6B'))!
  assert.ok(option, '下拉里能找到未安装的那一档')
  ;(option.props!.onClick as () => void)()
  assert.equal(label(), '需先卸载', '已装过模型时不许再装第二个')
  assert.equal(installBtn()!.props?.disabled, true, '必须先卸载')

  // 卸载:后端快照与清单都不再有已装档 → 点「刷新」重新取状态,按钮应当恢复
  report.catalog[0]!.installed = false
  report.catalog[0]!.variants[0]!.installed = false
  state.embedServer = {
    enabled: false, configured: false, mode: 'off', endpoint: '', model: 'bge-m3', spawnConfigured: false,
    owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0, install: installIdle({ installed: false }),
    maintenance: { usageBytes: 0, records: 0, storeDir: 'D:/stack/store' },
  }
  await switchTab(tree, hooks, '记录')
  const refresh = collect(tree()).find((n) => n.tag === 'button' && textOf(n).includes('刷新'))!
  assert.ok(refresh, '刷新按钮在数据页工具栏')
  ;(refresh.props!.onClick as () => void)()
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 6; i++) await Promise.resolve()
    hooks.runEffects()
  }
  await switchTab(tree, hooks, '服务')
  assert.equal(label(), '下载并安装', '卸载之后按钮回到「下载并安装」')
  assert.notEqual(installBtn()!.props?.disabled, true, '卸载之后可以装了')
})

test('记录卡编辑态的类型下拉也是自绘的(全站没有原生 select)', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const RecordCard = (exports.__test as { RecordCard: (p: Record<string, unknown>) => unknown }).RecordCard
  let tree: RenderNode | null = null
  const element = () => hooks.React.createElement(RecordCard, { rec: makeRecord({ kind: 'note' }), onSaved: () => {}, onDeleted: () => {} })
  hooks.setRerender(() => { tree = render(element(), hooks) })
  tree = render(element(), hooks)
  const head = collect(tree).find((n) => String(n.props?.className ?? '').startsWith('rec-head'))
  assert.ok(head, '卡片头存在')
  ;(head!.props!.onClick as () => void)()
  const edit = collect(tree).find((n) => n.tag === 'button' && (n.children ?? []).some((c) => c.text === '编辑'))
  assert.ok(edit, '展开后能看到编辑按钮')
  ;(edit!.props!.onClick as () => void)()
  assert.equal(collect(tree).filter((n) => n.tag === 'select').length, 0, '编辑态没有原生 select')
  const dropdowns = collect(tree).filter((n) => n.props?.['aria-haspopup'] === 'listbox')
  assert.equal(dropdowns.length, 1, '类型是一个自绘下拉')
  // 打开后能选到别的类型
  ;(dropdowns[0]!.props!.onClick as () => void)()
  const options = collect(tree).filter((n) => n.props?.role === 'option').map((n) => textOf(n))
  assert.ok(options.includes('decision') && options.includes('note'), `类型选项:${JSON.stringify(options)}`)
})

test('空状态:还没有记忆,居中一行', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const tree = await mountPanel(hooks, {
    scopes: [], embedServer: null,
  })
  const empty = collect(tree()).find((n) => String(n.props?.className ?? '') === 'empty')
  assert.ok(empty, '空状态节点存在')
  assert.equal((empty!.children ?? []).map((c) => c.text).join(''), '还没有记忆')
})

test('下拉列表:点选项选中,点列表外面(或 Esc)关闭', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  // 脚手架里的 document 只有 createElement/head —— 补一个记录监听器的最小实现
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  const doc = (globalThis as Record<string, unknown>).document as Record<string, unknown>
  doc.addEventListener = (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn) }
  doc.removeEventListener = (type: string, fn: (e: unknown) => void) => {
    listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)
  }

  const tree = await mountPanel(hooks, {
    scopes: [{ scope: 'global', records: 0, pendingEmbeds: 0 }],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      spawnConfigured: false, owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0, install: installIdle(),
    },
  })
  const openList = () => {
    const btn = collect(tree()).find((n) => n.props?.['aria-haspopup'] === 'listbox')!
    ;(btn.props!.onClick as () => void)()
    hooks.runEffects()
  }
  const options = () => collect(tree()).filter((n) => n.props?.role === 'option')

  assert.equal(options().length, 0, '默认不展开')
  openList()
  assert.ok(options().length >= 2, '点开后列出所有档位')
  assert.equal((listeners.click ?? []).length, 1, '打开时挂了外部点击监听')

  // 点在列表里面:不关
  for (const fn of listeners.click ?? []) fn({ target: { closest: () => ({}) } })
  assert.ok(options().length >= 2, '点列表内部不关')

  // 点在列表外面:关
  for (const fn of listeners.click ?? []) fn({ target: { closest: () => null } })
  assert.equal(options().length, 0, '点列表外面关闭')

  // Esc 也能关
  openList()
  for (const fn of listeners.keydown ?? []) fn({ key: 'Escape' })
  assert.equal(options().length, 0, 'Esc 关闭')
})

test('only a managed backend renders a switch; external and config-disabled do not', async () => {
  const { hooks } = await loadBundle()

  const managed = {
    enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
    spawnConfigured: true, owned: true, pid: 42, baseUrl: 'http://127.0.0.1:8078', reachable: true, pendingEmbeds: 0,
    install: installIdle({ installed: true }),
  }

  hooks.resetAll()
  const managedTree = await mountPanel(hooks, { scopes: [], embedServer: managed }, undefined, 'records')
  const switches = collect(managedTree()).filter((n) => n.props?.role === 'switch')
  assert.equal(switches.length, 1, 'exactly one switch when this app owns the process')
  assert.ok(String(switches[0]!.props?.className).includes('toggle'), 'switch uses the toggle styling')
  assert.equal(switches[0]!.props?.['aria-checked'], true, 'on while reachable')
  assert.ok(textOf(managedTree()).includes('由本应用托管'), 'explains who owns the process')

  hooks.resetAll()
  const externalTree = await mountPanel(hooks, {
    scopes: [],
    embedServer: { ...managed, mode: 'external', spawnConfigured: false, owned: false, pid: null, install: installIdle() },
  }, undefined, 'records')
  assert.equal(collect(externalTree()).filter((n) => n.props?.role === 'switch').length, 0, 'no switch for an external service')
  assert.ok(textOf(externalTree()).includes('外部服务'), 'labels the service as external')

  hooks.resetAll()
  const offTree = await mountPanel(hooks, { scopes: [], embedServer: { ...managed, enabled: false } }, undefined, 'records')
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
  const tree = await mountPanel(hooks, state, undefined, 'records')

  const text = textOf(tree())
  assert.ok(text.includes('维护'), 'maintenance section is rendered')
  assert.ok(text.includes('卸载插件不会移除已配置的向量服务与记忆文件'), '说明卸载不会删文件')
  assert.ok(!text.includes('卸载插件不会删除这里的文件'), '旧的那句已经移除')
  assert.ok(text.includes('向量服务：484.0 MB'), `shows the size an uninstall would free (got: ${text.slice(0, 200)})`)
  assert.ok(text.includes('记忆数据：4 条'), 'shows how much data a wipe would remove')
  assert.ok(text.includes('重建全部向量'), '维护区有重建全部向量按钮')

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
  }, undefined, 'records')
  const runningText = textOf(runningTree())
  assert.ok(runningText.includes('正在下载 bge-m3 模型'), 'shows the installer message')
  assert.ok(/\d+%/.test(runningText), 'shows a percentage')
  assert.ok(runningText.includes('取消'), 'offers cancel while running')
  // 下载中「下载并安装」必须不可用(否则能反复点,重复发起下载)
  const installBtn = collect(runningTree()).find((n) => String(n.props?.className ?? '').includes('install'))
  assert.ok(installBtn, '安装按钮在树上')
  assert.equal(installBtn!.props?.disabled, true, '下载中安装按钮不可用')
  assert.equal((installBtn!.children ?? []).map((c) => c.text).join(''), '下载中…', '按钮文案变成「下载中…」')

  hooks.resetAll()
  const failedTree = await mountPanel(hooks, {
    scopes: [],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: '', model: 'bge-m3', spawnConfigured: false,
      owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0,
      install: installIdle({ phase: 'error', message: 'GitHub API 限流', error: 'GitHub API 限流', installed: false }),
    },
  }, undefined, 'records')
  const failedText = textOf(failedTree())
  assert.ok(failedText.includes('GitHub API 限流'), 'surfaces the failure reason')
  assert.ok(failedText.includes('重试下载'), 'offers a retry')
})

test('设置标签页:读取注入设置、渲染各组开关并能保存', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const settingsValue = {
    recall: { enabled: true, topK: 5, tokenBudget: 500 },
    digest: { enabled: true, topK: 8, tokenBudget: 400 },
    impression: { enabled: true, chars: 120 },
    policy: { enabled: true },
    rules: { enabled: true, maxItems: 10, tokenBudget: 300, delta: true },
    turnEnd: { enabled: false },
  }
  const calls: Array<{ url: string; method?: string; body?: string }> = []
  let posted: Record<string, unknown> | null = null
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method, body: init?.body })
    if (u.includes('/settings')) {
      if (init?.method === 'POST') {
        posted = JSON.parse(String(init.body))
        return { status: 200, json: async () => ({ ok: true, value: posted }) }
      }
      return { status: 200, json: async () => ({ ok: true, value: settingsValue }) }
    }
    if (u.includes('/status')) return { status: 200, json: async () => ({ ok: true, value: { scopes: [], embedServer: null } }) }
    if (u.includes('/embed/model')) return { status: 200, json: async () => ({ ok: true, value: modelReport() }) }
    return { status: 200, json: async () => ({ ok: true, value: { records: [] } }) }
  }

  const MemoryPanel = (exports.__test as { MemoryPanel: (p: Record<string, unknown>) => unknown }).MemoryPanel
  const element = () => hooks.React.createElement(MemoryPanel, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()

  const tab = collect(current).find((n) => n.tag === 'button' && textOf(n).trim() === '设置')
  assert.ok(tab, '面板里有「设置」标签')
  ;(tab!.props!.onClick as () => void)()
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()

  const text = textOf(current)
  for (const label of ['每轮召回', '印象形态', '会话摘要', '记忆使用策略', '硬性规则', '轮末提醒']) {
    assert.ok(text.includes(label), `设置页应显示「${label}」`)
  }

  // 没有「保存设置」按钮:拨动第一个开关(recall.enabled)后自动 POST
  assert.equal(collect(current).some((n) => n.tag === 'button' && textOf(n).trim() === '保存设置'), false)
  const firstSwitch = collect(current).find((n) => n.tag === 'button' && n.props?.role === 'switch')
  assert.ok(firstSwitch, '设置页用开关按钮')
  ;(firstSwitch!.props!.onClick as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.ok(posted, '改动即自动保存')
  assert.equal((posted as Record<string, unknown>).recall && ((posted as Record<string, unknown>).recall as { enabled?: boolean }).enabled, false)
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.includes('/settings')))

  // 每个开关必须有可见的 label 与状态，不能只靠 tooltip。
  const groupSwitches = collect(current).filter((n) => String(n.props?.className ?? '') === 'setcard-enable')
  assert.ok(groupSwitches.length >= 5, `卡片头应有显式启用开关，实际 ${groupSwitches.length}`)
  for (const node of groupSwitches) {
    const label = textOf(node)
    assert.ok(label.includes('启用'), `卡片开关缺少可见「启用」: ${label}`)
    assert.ok(label.includes('已开启') || label.includes('已关闭'), `卡片开关缺少状态文案: ${label}`)
  }
  const fieldSwitches = collect(current)
    .filter((n) => String(n.props?.className ?? '') === 'setfield')
    .filter((n) => collect(n).some((child) => child.props?.role === 'switch'))
  assert.ok(fieldSwitches.length >= 2, '字段级开关也应存在')
  for (const field of fieldSwitches) {
    const label = collect(field).find((n) => String(n.props?.className ?? '') === 'setfield-label')
    assert.ok(label && textOf(label).trim().length > 0, '字段级开关缺少 label')
    assert.ok(collect(field).some((n) => String(n.props?.className ?? '') === 'setfield-hint'), '字段级开关缺少 hint')
    const text = textOf(field)
    assert.ok(text.includes('已开启') || text.includes('已关闭'), `字段级开关缺少状态文案: ${text}`)
  }
})

test('记录页:点「新建」出现表单,可选 rule 类型;设置页有导入/导出', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
    const u = String(url)
    if (u.includes('/status')) return { status: 200, json: async () => ({ ok: true, value: { scopes: [], embedServer: null, rules: { total: 0, scopes: 0 } } }) }
    if (u.includes('/embed/model')) return { status: 200, json: async () => ({ ok: true, value: modelReport() }) }
    if (u.includes('/settings')) return { status: 200, json: async () => ({ ok: true, value: {
      recall: { enabled: true, topK: 5, tokenBudget: 500 },
      digest: { enabled: true, topK: 8, tokenBudget: 400 },
      impression: { enabled: true, chars: 120 },
      policy: { enabled: true },
      rules: { enabled: true, maxItems: 10, tokenBudget: 300, delta: true },
      turnEnd: { enabled: false },
    } }) }
    return { status: 200, json: async () => ({ ok: true, value: { records: [] } }) }
  }

  const MemoryPanel = (exports.__test as { MemoryPanel: (p: Record<string, unknown>) => unknown }).MemoryPanel
  const element = () => hooks.React.createElement(MemoryPanel, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()

  const createBtn = collect(current).find((n) => n.tag === 'button' && textOf(n).trim() === '新建')
  assert.ok(createBtn, '记录页有「新建」按钮')
  ;(createBtn!.props!.onClick as () => void)()
  hooks.runEffects(); await flush()
  const afterOpen = textOf(current)
  assert.ok(afterOpen.includes('保存'), '表单有保存按钮')
  assert.ok(afterOpen.includes('取消'), '表单有取消按钮')

  // 切到设置页,确认数据区在
  const settingsTab = collect(current).find((n) => n.tag === 'button' && textOf(n).trim() === '设置')
  assert.ok(settingsTab)
  ;(settingsTab!.props!.onClick as () => void)()
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()
  const text = textOf(current)
  assert.ok(text.includes('导出全部'), '设置页有导出按钮')
  assert.ok(text.includes('导入文件'), '设置页有导入入口')
  assert.ok(text.includes('0 条规则'), '设置页显示规则条数')
})

test('记录页语义检索:开关、/search 请求、结果说明与相关度徽标', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const state = {
    scopes: [{ scope: 'project:C:/demo', records: 2, pendingEmbeds: 0, label: 'C:/demo' }],
    embedServer: {
      enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      modelLabel: 'BGE-M3 · Q4_K_M', presetId: 'bge-m3', variantId: 'q4_k_m', dims: 1024, pooling: 'cls', flavor: 'cpu',
      spawnConfigured: true, owned: true, pid: 7, baseUrl: 'http://127.0.0.1:8078', reachable: true, pendingEmbeds: 0,
      install: installIdle({ installed: true }),
    },
  }
  const hits = [{ ...makeRecord({ id: 'mem-1', scope: 'project:C:/demo', content: '发布前检查 devcred 凭据' }), score: 0.8 }]
  const calls: string[] = []
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/search')) return { status: 200, json: async () => ({ ok: true, value: { hits, mode: 'vector', embedded: 2, total: 2 } }) }
    if (u.includes('/status')) return { status: 200, json: async () => ({ ok: true, value: state }) }
    return { status: 200, json: async () => ({ ok: true, value: { records: [] } }) }
  }

  const MemoryPanel = (exports.__test as { MemoryPanel: (p: Record<string, unknown>) => unknown }).MemoryPanel
  const element = () => hooks.React.createElement(MemoryPanel, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()

  /** 语义检索控件是一个真正的 toggle(轨道 + 圆点 + 可见状态),不是普通按钮。 */
  const findSemanticToggle = () => collect(current)
    .find((n) => n.tag === 'button' && n.props?.role === 'switch' && textOf(n).includes('语义检索'))

  // 输入查询词(不回车),再打开语义检索 → 有查询词时应立即按新模式重跑
  const input = collect(current).find((n) => n.tag === 'input')
  assert.ok(input, '记录页有搜索框')
  ;(input!.props!.onChange as (e: unknown) => void)({ target: { value: '发布凭据' } })
  await flush()
  calls.length = 0
  const toggle = findSemanticToggle()
  assert.ok(toggle, '搜索框旁有「语义检索」开关')
  assert.equal(toggle!.props?.role, 'switch', '控件是 switch,不是普通按钮')
  assert.equal(toggle!.props?.['aria-checked'], false, '默认关闭(关键词过滤)')
  assert.ok(String(toggle!.props?.className).split(/\s+/).includes('toggle'), '沿用向量服务的 toggle 造型')
  const toggleClassNames = collect(toggle).map((n) => String(n.props?.className ?? ''))
  assert.ok(toggleClassNames.includes('toggle-track'), '有轨道')
  assert.ok(toggleClassNames.includes('toggle-knob'), '有圆点')
  assert.ok(toggledText(toggle).includes('已关闭'), '关闭态有可见状态文案')
  ;(toggle!.props!.onClick as () => void)()
  // 不跑 runEffects:测试脚手架的 mount effect 每次 runEffects 都会重放,
  // 会把搜索词清空后的 /records 结果覆盖回来(真实 React 里 mount effect 只跑一次)。
  await flush()

  const searchCall = calls.find((u) => u.includes('/search?'))
  assert.ok(searchCall, `开启后应请求 /search(实际:${JSON.stringify(calls)})`)
  assert.ok(searchCall!.includes('q='), '查询词随请求发出')
  assert.equal(calls.some((u) => u.includes('/records?') || u.endsWith('/records')), false, '语义模式不再走关键词过滤')

  const text = textOf(current)
  assert.ok(text.includes('语义排序'), `结果说明标出向量参与了排序(${text.slice(0, 200)})`)
  assert.ok(text.includes('命中 1 条'), '结果条数')
  assert.ok(text.includes('向量覆盖 2/2 条'), '向量覆盖率')
  assert.ok(text.includes('得分 0.80'), '结果卡显示检索得分')
  assert.match(text, /发布前检查 devcred 凭据/, '命中内容来自 /search')
  const pressed = findSemanticToggle()
  assert.equal(pressed!.props?.['aria-checked'], true, '开关状态跟随')
  assert.ok(String(pressed!.props?.className).split(/\s+/).includes('on'), '开启态加上 .on(轨道变品牌色)')
  assert.ok(toggledText(pressed).includes('已开启'), '开启态有可见状态文案')
  // 深色模式:颜色全部来自宿主 token,不能写死色值
  const css = (exports.__test as { CSS: string }).CSS
  const stateRule = /\.memp \.toolbar \.semantic-state\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const stateOnRule = /\.memp \.toolbar \.semantic\.on \.semantic-state\{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(stateRule, /var\(--dsw-alias-label-secondary\)/, `关闭态状态文字用次要标题色:${stateRule}`)
  assert.match(stateOnRule, /var\(--dsw-alias-brand-primary\)/, `开启态状态文字用品牌色:${stateOnRule}`)
  assert.doesNotMatch(stateRule + stateOnRule, /#[0-9a-f]{3,8}/i, '语义开关的状态文字不能写死颜色')
  hooks.resetAll()
})

test('记录页语义检索:向量不可用时开关禁用;服务端回退时说明原因', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()

  // 没有配置向量后端:开关可见但不可点(点了也只会给词法结果,容易误解)
  const offState = {
    scopes: [{ scope: 'global', records: 1, pendingEmbeds: 0 }],
    embedServer: {
      enabled: false, configured: false, mode: 'off', endpoint: '', model: 'bge-m3', spawnConfigured: false,
      owned: false, pid: null, baseUrl: '', reachable: false, pendingEmbeds: 0, install: installIdle(),
    },
  }
  let current = await mountPanel(hooks, offState)
  const offToggle = collect(current()).find((n) => n.tag === 'button' && n.props?.role === 'switch' && textOf(n).includes('语义检索'))
  assert.ok(offToggle, '未配置向量时开关仍然可见')
  assert.equal(offToggle!.props?.disabled, true, '未配置向量时不可开启')
  assert.equal(offToggle!.props?.['aria-checked'], false, '禁用时仍如实报告关闭')
  hooks.resetAll()

  // 已配置但这次嵌入失败:服务端返回 lexical + embed-failed,面板要写明回退原因
  const state = {
    scopes: [{ scope: 'project:C:/demo', records: 2, pendingEmbeds: 0, label: 'C:/demo' }],
    embedServer: {
      enabled: true, configured: true, mode: 'managed', endpoint: 'http://127.0.0.1:8078/v1/embeddings', model: 'bge-m3',
      spawnConfigured: true, owned: true, pid: 7, baseUrl: 'http://127.0.0.1:8078', reachable: false, pendingEmbeds: 0,
      install: installIdle({ installed: true }),
    },
  }
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
    const u = String(url)
    if (u.includes('/search')) {
      return {
        status: 200,
        json: async () => ({ ok: true, value: { hits: [], mode: 'lexical', reason: 'embed-failed', embedded: 2, total: 2 } }),
      }
    }
    if (u.includes('/status')) return { status: 200, json: async () => ({ ok: true, value: state }) }
    return { status: 200, json: async () => ({ ok: true, value: { records: [] } }) }
  }
  const MemoryPanel = (exports.__test as { MemoryPanel: (p: Record<string, unknown>) => unknown }).MemoryPanel
  const element = () => hooks.React.createElement(MemoryPanel, {})
  current = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  hooks.runEffects(); await flush(); hooks.runEffects(); await flush()

  const input = collect(current).find((n) => n.tag === 'input')!
  ;(input.props!.onChange as (e: unknown) => void)({ target: { value: '任何查询' } })
  await flush()
  const toggle = collect(current).find((n) => n.tag === 'button' && n.props?.role === 'switch' && textOf(n).includes('语义检索'))!
  ;(toggle.props!.onClick as () => void)()
  await flush()

  const text = textOf(current)
  assert.ok(text.includes('关键词回退'), `回退结果要有明确标注(${text.slice(0, 200)})`)
  assert.ok(text.includes('向量服务没有响应'), '说明回退原因是向量服务不可用')
  assert.ok(text.includes('没有语义相关的记忆'), '零命中时给出语义空状态')
  hooks.resetAll()
})

test('记录卡:标签渲染成气泡,修正关系两个方向都有明确徽标', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const RecordCard = (exports.__test as { RecordCard: (p: Record<string, unknown>) => unknown }).RecordCard

  let tree: RenderNode | null = null
  let current: Record<string, unknown> = makeRecord({ tags: ['pnpm', '工具链'], supersedes: 'abcdef1234567890' })
  const element = () => hooks.React.createElement(RecordCard, { rec: current, onSaved: () => {}, onDeleted: () => {} })
  hooks.setRerender(() => { tree = render(element(), hooks) })
  tree = render(element(), hooks)

  // 折叠时不显示标签(避免列表变吵)
  assert.ok(!textOf(tree).includes('pnpm'), '折叠状态不显示标签')
  // 展开后:内容、完整 id、标签一起出现
  const head = collect(tree).find((n) => String(n.props?.className ?? '') === 'rec-head')
  assert.ok(head, '卡片头存在')
  ;(head!.props!.onClick as () => void)()
  const text = textOf(tree)
  assert.ok(text.includes('pnpm') && text.includes('工具链'), `标签在展开区(${text})`)
  assert.ok(text.includes('rec-1'), '展开后显示记录 id')
  assert.ok(text.includes('修正自 abcdef12'), '修正版徽标带旧记录 id 前缀')

  current = makeRecord({ tags: [], supersededBy: 'ffff000011112222' })
  tree = render(element(), hooks)
  assert.ok(textOf(tree).includes('已被修正'), '被修正的记录有「已被修正」徽标')
})

test('服务页底部:Star 与 issue 链接', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const tree = await mountPanel(hooks, { scopes: [], embedServer: null }, undefined, 'records')
  const text = textOf(tree())
  assert.ok(text.includes('去 GitHub 点个 Star'), `底部有 Star 文案(${text.slice(-80)})`)
  assert.ok(text.includes('反馈建议 / 提 issue'), '底部有 issue 文案')
  const links = collect(tree()).filter((n) => n.tag === 'a').map((n) => String(n.props?.href))
  assert.ok(links.includes('https://github.com/RestRegular/dsh-memory'), `Star 链接正确(${JSON.stringify(links)})`)
  assert.ok(links.includes('https://github.com/RestRegular/dsh-memory/issues/new'), 'issue 链接正确')
})

test('侧栏图标是单色线稿:16 网格、1.3 描边、currentColor,不带渐变', async () => {
  // 这条断言守的是"侧栏里冒出一块彩色瓦片"的回归:插件列表用彩色 icon.svg,但
  // 左侧栏 / 设置侧栏那一列全是单色线稿,记号必须用 currentColor 画。
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  type DomNode = { tag: string; attrs: Record<string, string | number>; children?: DomNode[] }
  const { NavLineIcon, NAV_DOM } = exports.__test as {
    NavLineIcon: (p: Record<string, unknown>) => unknown
    NAV_DOM: DomNode[]
  }

  const tree = render(hooks.createElement(NavLineIcon, { size: 16 }), hooks)
  assert.ok(tree, 'NavLineIcon 应渲染出 SVG')
  assert.equal(tree!.tag, 'svg')
  assert.equal(tree!.props!.viewBox, '0 0 16 16', '与宿主侧栏图标共用 16 网格')
  assert.equal(tree!.props!.fill, 'none')

  const nodes = collect(tree)
  const shapes = nodes.filter((n) => n.tag === 'rect' || n.tag === 'path')
  assert.equal(shapes.length, 2, '线稿只有瓦片轮廓 + 年轮螺旋两条图形')
  for (const shape of shapes) {
    assert.equal(String(shape.props?.fill), 'none', `${String(shape.tag)} 必须是描边,不能填色`)
    assert.equal(String(shape.props?.stroke), 'currentColor', `${String(shape.tag)} 必须跟随文字色`)
    assert.equal(Number(shape.props?.strokeWidth), 1.3, `${String(shape.tag)} 线宽必须与宿主图标一致(1.3)`)
  }
  const spiral = nodes.find((n) => n.tag === 'path')
  assert.ok(String(spiral?.props?.d).includes('A'), '年轮用圆弧画,不是折线')
  assert.ok(!nodes.some((n) => n.tag === 'linearGradient' || n.tag === 'stop'), '侧栏图标不能带渐变')

  // 设置侧栏走 DOM 那条路:两条图形必须与 React 侧完全一致
  assert.equal(NAV_DOM.length, 2)
  assert.equal(NAV_DOM.find((n) => n.tag === 'path')?.attrs.d, spiral?.props?.d)
  for (const shape of NAV_DOM) {
    assert.equal(String(shape.attrs.fill), 'none')
    assert.equal(String(shape.attrs.stroke), 'currentColor')
    assert.equal(String(shape.attrs['stroke-width']), '1.3')
  }
})

test('记忆树布局:按作用域 / 类型分层,并连出修正与被修正的关系', async () => {
  const { exports } = await loadBundle()
  const build = (exports.__test as {
    buildMemoryTree: (records: unknown[], options?: Record<string, unknown>) => {
      nodes: Array<Record<string, unknown>>
      edges: Array<Record<string, unknown>>
      corrections: Array<Record<string, unknown>>
      counts: Record<string, number>
      width: number
      height: number
    }
  }).buildMemoryTree

  const records = [
    makeRecord({ id: 'old', scope: 'project:/w', kind: 'fact', content: '旧事实', updatedAt: 1, supersedes: null, supersededBy: 'new' }),
    makeRecord({ id: 'new', scope: 'project:/w', kind: 'fact', content: '新事实', updatedAt: 2, supersedes: 'old', supersededBy: null }),
    makeRecord({ id: 'rule', scope: 'global', kind: 'rule', content: '硬性规则', updatedAt: 3, supersedes: null, supersededBy: null }),
  ]

  const layout = build(records, { labels: { 'project:/w': '演示项目', global: '全局' } })
  assert.equal(layout.counts.records, 3)
  assert.equal(layout.counts.scopes, 2)
  assert.equal(layout.counts.kinds, 2)
  assert.equal(layout.corrections.length, 1, '新记录 supersedes 旧记录 → 一条修正连线')

  const scopes = layout.nodes.filter((n) => n.type === 'scope')
  assert.deepEqual(scopes.map((n) => n.scope), ['global', 'project:/w'], 'global 排在最前')
  assert.equal(scopes.find((n) => n.scope === 'global')?.label, '全局')
  assert.equal(scopes.find((n) => n.scope === 'project:/w')?.label, '演示项目')

  const kinds = layout.nodes.filter((n) => n.type === 'kind')
  assert.deepEqual(
    kinds.filter((n) => n.scope === 'project:/w').map((n) => n.kind),
    ['fact'],
    '同一作用域下按固定类型顺序分组',
  )

  const correction = layout.corrections[0]!
  assert.equal(correction.fromId, 'new')
  assert.equal(correction.toId, 'old')
  assert.equal(layout.nodes.find((n) => n.key === correction.fromKey)?.type, 'record')
  assert.equal(layout.nodes.find((n) => n.key === correction.toKey)?.type, 'record')

  // 父节点在自己子树高度里居中:作用域节点的中心应落在它所含记录块的中心
  const scope = scopes.find((n) => n.scope === 'project:/w')!
  const recordNodes = layout.nodes.filter((n) => n.type === 'record' && n.scope === 'project:/w')
  const minY = Math.min(...recordNodes.map((n) => Number(n.y)))
  const maxY = Math.max(...recordNodes.map((n) => Number(n.y) + Number(n.h)))
  assert.ok(Math.abs((Number(scope.y) + Number(scope.h) / 2) - (minY + maxY) / 2) < 0.01, '作用域节点垂直居中')
  assert.ok(layout.width > 0 && layout.height > 0)
})

test('记忆树布局:折叠作用域 / 按类型筛选都会重排,并丢掉不可见的修正边', async () => {
  const { exports } = await loadBundle()
  const build = (exports.__test as {
    buildMemoryTree: (records: unknown[], options?: Record<string, unknown>) => {
      nodes: Array<Record<string, unknown>>
      corrections: unknown[]
      counts: Record<string, number>
    }
  }).buildMemoryTree

  const records = [
    makeRecord({ id: 'old', scope: 'project:/w', kind: 'fact', content: '旧事实', updatedAt: 1, supersedes: null, supersededBy: 'new' }),
    makeRecord({ id: 'new', scope: 'project:/w', kind: 'fact', content: '新事实', updatedAt: 2, supersedes: 'old', supersededBy: null }),
    makeRecord({ id: 'rule', scope: 'global', kind: 'rule', content: '硬性规则', updatedAt: 3 }),
  ]

  const collapsed = build(records, { collapsed: new Set(['scope:project:/w']) })
  assert.equal(collapsed.nodes.filter((n) => n.type === 'scope').length, 2)
  assert.equal(collapsed.nodes.filter((n) => n.type === 'record').length, 1, '折叠的作用域下不渲染记录')
  assert.equal(collapsed.corrections.length, 0, '被折叠的记录不能留下悬空修正边')

  const onlyRule = build(records, { activeKinds: new Set(['rule']) })
  assert.deepEqual(onlyRule.nodes.filter((n) => n.type === 'record').map((n) => n.rec?.id), ['rule'])
  assert.equal(onlyRule.counts.scopes, 1)

  // 修正边只有在**两端都可见**时才存在:只留 fact 时 old/new 都可见,只留 rule 时两端都不可见
  const onlyFact = build(records, { activeKinds: new Set(['fact']) })
  assert.equal(onlyFact.corrections.length, 1)
})

test('记忆树标签页:从面板能切过去,空数据也有统计、类型图例与空状态', async () => {
  const { hooks } = await loadBundle()
  hooks.resetAll()
  const tree = await mountPanel(hooks, {
    scopes: [{ scope: 'global', records: 0, pendingEmbeds: 0, label: '全局' }],
    embedServer: null,
  }, undefined, 'tree')

  const text = textOf(tree())
  assert.ok(text.includes('记忆树'), '标签栏里有「记忆树」')
  assert.ok(text.includes('条记忆'), '统计卡显示记忆总数')
  assert.ok(text.includes('个作用域'), '统计卡显示作用域数')
  assert.ok(text.includes('种类型'), '统计卡显示类型数')
  assert.ok(text.includes('处修正'), '统计卡显示修正关系数')
  assert.ok(text.includes('类型'), '类型图例存在')
  assert.ok(text.includes('还没有记忆'), '没有记录时给出空状态引导')

  const classNames = collect(tree()).map((n) => String(n.props?.className ?? ''))
  assert.ok(classNames.includes('tree-tab'), '渲染的是记忆树标签页')
  assert.ok(classNames.includes('tree-wrap'), '树画布存在')
  assert.ok(classNames.includes('tree-stats'), '统计区存在')
})

test('两个开关的配色跟随宿主 switch token,深色主题下轨道和圆点都能看清', async () => {
  const { exports } = await loadBundle()
  const css = (exports.__test as { CSS: string }).CSS
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(escaped + '\\{([^}]*)\\}').exec(css)?.[1] ?? ''
  }

  // 宿主 switch 的配色(--dsw-alias-*):关闭态轨道 border-l3、圆点 switch-thumb;
  // 开启态轨道 brand-primary、圆点 label-primary-foreground。深色主题的 brand-primary
  // 是近白色,所以圆点不能写死 #fff,关闭态轨道也不能用几乎透明的 border-l1(#ffffff0f)。
  const pairs = [
    { name: '设置开关', track: '.memp .switch', on: '.memp .switch.on', knob: '.memp .switch .knob', knobOn: '.memp .switch.on .knob' },
    { name: '向量服务开关', track: '.memp .toggle-track', on: '.memp .toggle.on .toggle-track', knob: '.memp .toggle-knob', knobOn: '.memp .toggle.on .toggle-knob' },
  ]
  for (const p of pairs) {
    const track = rule(p.track)
    assert.match(track, /background:var\(--dsw-alias-border-l3\)/, `${p.name}:关闭态轨道用 border-l3:${track}`)
    assert.doesNotMatch(track, /border-l1/, `${p.name}:关闭态轨道不能再用几乎透明的 border-l1`)
    assert.match(rule(p.on), /background:var\(--dsw-alias-brand-primary\)/, `${p.name}:开启态轨道用品牌色`)
    const knob = rule(p.knob)
    assert.match(knob, /background:var\(--dsw-alias-switch-thumb\)/, `${p.name}:关闭态圆点用 switch-thumb:${knob}`)
    assert.doesNotMatch(knob, /#fff/i, `${p.name}:圆点不能写死白色`)
    assert.match(rule(p.knobOn), /background:var\(--dsw-alias-label-primary-foreground\)/, `${p.name}:开启态圆点用 label-primary-foreground`)
  }
})

test('审计条目的轨迹锚点解析：operationId 优先，其次 signal.callId', async () => {
  const { exports } = await loadBundle()
  const testApi = exports.__test as {
    auditEntryCallId: (entry: unknown) => string | undefined
    trajectoryRowCallId: (row: unknown) => string | undefined
    requestAuditFocus: (target: unknown) => void
    takeAuditFocus: (audience?: string) => { sessionId?: string; callId?: string; audience?: string } | null
  }
  assert.equal(testApi.auditEntryCallId({ operationId: 'call-1' }), 'call-1')
  assert.equal(testApi.auditEntryCallId({ operationId: '', signal: { callId: 'call-2' } }), 'call-2')
  assert.equal(testApi.auditEntryCallId({ signal: { callId: 'call-3' } }), 'call-3')
  assert.equal(testApi.auditEntryCallId({}), undefined)

  // Trajectory 的行 key：kind\0call\0<callId>，但 DOM 属性经过 encodeURIComponent。
  assert.equal(testApi.trajectoryRowCallId({
    getAttribute: (name: string) => name === 'data-trajectory-row-key' ? 'tool%00call%00call-9' : null,
  }), 'call-9')
  assert.equal(testApi.trajectoryRowCallId({
    getAttribute: (name: string) => name === 'data-trajectory-row-key' ? 'tool\u0000call\u0000call-9' : null,
  }), 'call-9', '未编码的旧格式也认')
  assert.equal(testApi.trajectoryRowCallId({
    getAttribute: () => 'tool%00call%00call-9%00summary%00turn',
  }), 'call-9', 'collapsed summary 后缀不影响 callId')
  assert.equal(testApi.trajectoryRowCallId({ getAttribute: () => 'message%00abc' }), undefined)
  assert.equal(testApi.trajectoryRowCallId(null), undefined)

  // 焦点总线只把目标交给匹配的受众（主面板 vs 会话内视图）。
  testApi.requestAuditFocus({ audience: 'view', sessionId: 's1', callId: 'call-9' })
  assert.equal(testApi.takeAuditFocus('panel'), null, '面板不能抢走给会话视图的焦点')
  const taken = testApi.takeAuditFocus('view')
  assert.equal(taken?.sessionId, 's1')
  assert.equal(taken?.callId, 'call-9')
  assert.equal(testApi.takeAuditFocus('view'), null, '取过一次就清掉')
})

test('主面板通过 conversation.session 的 store 调 openView 跳轨迹', async () => {
  const { exports } = await loadBundle()
  const testApi = exports.__test as {
    setClientCtx: (ctx: unknown) => void
    conversationStoreFor: (sessionId: string) => { actions?: Record<string, unknown> } | undefined
    setConversationView: (sessionId: string, view: string, focus?: string) => boolean
  }
  const handle = { kind: 'conversation-store' }
  const seen: [string, string | undefined][] = []
  const store = {
    actions: {
      openView: (view: string, focus?: string) => { seen.push([view, focus]) },
      setView: (view: string) => { seen.push([view, undefined]) },
    },
  }
  const slots = {
    entries: (key: string) => key === 'conversation.session' ? [{ store: handle }] : [],
    _stores: new Map([[handle, { instances: new Map([['s1', store]]) }]]),
  }
  testApi.setClientCtx({ get: (name: string) => name === 'slots' ? slots : undefined })
  assert.equal(testApi.conversationStoreFor('s1'), store)
  assert.equal(testApi.setConversationView('s1', 'trajectory', 'call-9'), true)
  assert.deepEqual(seen, [['trajectory', 'call-9']])
  testApi.setClientCtx(null)
})

test('client apply 注册记忆视图、轨迹徽标与详情页签', async () => {
  const { exports } = await loadBundle()
  const registered: { spec: Record<string, unknown>; component: unknown }[] = []
  const injected: string[] = []
  const slots = {
    entries: () => [],
    inject(key: string, callback: () => unknown) {
      injected.push(key)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(spec: Record<string, unknown>, component: unknown) {
      registered.push({ spec, component })
      return () => {}
    },
  }
  const ctx = {
    get: (name: string) => name === 'slots' ? slots : undefined,
    effect: (fn: () => unknown) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  const globals = globalThis as Record<string, unknown>
  const saved = {
    window: globals.window,
    document: globals.document,
    MutationObserver: globals.MutationObserver,
    fetch: globals.fetch,
  }
  const errors: string[] = []
  const originalError = console.error
  globals.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    location: { hash: '' },
  }
  globals.document = {
    createElement: () => ({ set textContent(_v: string) {}, remove() {} }),
    head: { appendChild() {} },
    body: {},
    querySelectorAll: () => [],
  }
  globals.MutationObserver = class { observe() {} disconnect() {} }
  globals.fetch = async () => ({ status: 200, json: async () => ({ ok: true, value: { sidebar: { enabled: true } } }) })
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try {
    ;(exports.apply as (ctx: unknown) => void)(ctx)
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    globals.window = saved.window
    globals.document = saved.document
    globals.MutationObserver = saved.MutationObserver
    globals.fetch = saved.fetch
    console.error = originalError
    ;(exports.__test as { setClientCtx: (v: unknown) => void }).setClientCtx(null)
  }
  assert.deepEqual(errors, [], '注册过程不应吞掉异常并打 console.error')
  const spec = (name: string) => registered.find((entry) => entry.spec.name === name)?.spec
  assert.equal(spec('settings.section')?.id, 'memory')
  assert.equal(spec('main')?.key, 'memory')
  assert.equal(spec('sidebar.panellist')?.id, 'memory')
  assert.equal(spec('conversation.view')?.id, 'memory', '会话内「记忆」视图已注册')
  assert.ok(!registered.some((entry) => entry.spec.name === 'conversation.session.header.actions'), '会话头部不再注册记忆按钮')
  const overlays = registered.filter((entry) => entry.spec.name === 'shell.overlay').map((entry) => entry.spec.id)
  assert.deepEqual(overlays.sort(), ['memory-audit-badge', 'memory-audit-detail', 'memory-audit-marks'], '轨迹标记/徽标/详情页签浮层已注册')
  assert.ok(injected.includes('conversation.view'))
  assert.ok(!injected.includes('conversation.session.header.actions'))
  assert.ok(injected.includes('shell.overlay'))
})

test('记忆视图用 composer overlay 占满高度，滚动只发生在审计列表里', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const View = (exports.__test as { MemoryAuditView: (p: Record<string, unknown>) => unknown }).MemoryAuditView
  const tree = render(hooks.React.createElement(View, {
    sessionId: 's1',
    openView: () => {},
    sessionInfo: () => ({}),
  }), hooks)
  assert.equal(tree?.props?.['data-conversation-composer-overlay'], '', '声明 composer overlay，让壳层压住外层滚动')
  const css = (exports.__test as { CSS: string }).CSS
  assert.match(css, /\.mem-view\{[^}]*height:100%/, '记忆视图占满 viewArea')
  assert.match(css, /\.mem-view-body\{[^}]*overflow:hidden/, '外层内容不滚动')
  assert.match(css, /\.mem-view \.audit\{height:100%/, '审计页填满剩余高度')
  assert.doesNotMatch(css, /\.mem-head-btn/, '会话头部按钮样式已移除')
})

test('轨迹详情页签展示该 callId 的审计并可打开本会话面板', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const testApi = exports.__test as {
    TrajectoryDetailAudit: (p: Record<string, unknown>) => unknown
    setClientCtx: (ctx: unknown) => void
    requestAuditFocus: (target: unknown) => void
  }
  const rect = (left: number, top: number, width: number, height: number) => ({
    left, top, right: left + width, bottom: top + height, width, height,
  })
  const tabs = { style: {} as Record<string, string>, getBoundingClientRect: () => rect(100, 100, 300, 34) }
  const body = { getBoundingClientRect: () => rect(100, 134, 300, 366) }
  const details = {
    getBoundingClientRect: () => rect(100, 60, 300, 440),
    querySelector: (selector: string) => selector.includes('_detailTabs') ? tabs : selector.includes('_detailBody') ? body : null,
  }
  const row = {
    getAttribute: (name: string) => name === 'data-trajectory-row-key' ? 'tool%00call%00call-9' : null,
    getBoundingClientRect: () => rect(0, 180, 700, 30),
  }
  const fakeDocument = {
    body: {},
    querySelector: (selector: string) => {
      if (selector.includes('tr[data-selected')) return row
      if (selector.includes('_details')) return details
      if (selector.includes('_composerSeat')) return null
      return null
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const globals = globalThis as Record<string, unknown>
  const saved = { window: globals.window, document: globals.document, fetch: globals.fetch }
  globals.window = { innerWidth: 1200, addEventListener() {}, removeEventListener() {} }
  globals.document = fakeDocument
  globals.fetch = async () => ({
    status: 200,
    json: async () => ({
      ok: true,
      value: {
        entries: [{
          id: 'audit-1', seq: 1, at: Date.now(), sessionId: 's1', kind: 'signal',
          channel: 'signal', stage: 'tool_call', trigger: 'memory_tool', outcome: 'success',
          operationId: 'call-9', selected: { contentIds: ['mem-1'], hintIds: [], count: 1 },
        }],
        total: 1,
        stats: { entries: 1, capacity: 2000, perSessionCapacity: 200, dropped: 0, writeErrors: 0, persistence: 'memory' },
      },
    }),
  })
  testApi.setClientCtx({
    get: (name: string) => name === 'uiWorkspace'
      ? { sessions: { list: { getSnapshot: () => ({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }) } } }
      : undefined,
  })
  const Component = testApi.TrajectoryDetailAudit
  const element = () => hooks.React.createElement(Component, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  hooks.runEffects()
  await new Promise((resolve) => setTimeout(resolve, 40))
  for (let i = 0; i < 6; i++) await Promise.resolve()
  const tab = collect(current).find((n) => String(n.props?.className ?? '').split(/\s+/).includes('mem-traj-audit-tab'))
  assert.ok(tab, '详情页签行出现「记忆审计」页签')
  assert.ok(textOf(tab).includes('记忆审计'))
  assert.equal(tabs.style.paddingRight, '96px', '为页签预留右侧空间')
  ;(tab!.props!.onClick as () => void)()
  for (let i = 0; i < 4; i++) await Promise.resolve()
  const pane = collect(current).find((n) => String(n.props?.className ?? '').split(/\s+/).includes('mem-traj-audit-pane'))
  assert.ok(pane, '页签打开后出现审计面板')
  const paneText = textOf(pane)
  assert.ok(paneText.includes('memory_tool'), '展示该 callId 的审计')
  assert.ok(paneText.includes('打开本会话记忆审计'), '提供跳回会话审计面板的按钮')
  ;(testApi.setClientCtx as (v: unknown) => void)(null)
  globals.window = saved.window
  globals.document = saved.document
  globals.fetch = saved.fetch
  hooks.resetAll()
})

test('轨迹列表给有审计的调用加产品线条图标', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const testApi = exports.__test as {
    TrajectoryMemoryMarks: (p: Record<string, unknown>) => unknown
    setClientCtx: (ctx: unknown) => void
  }
  const rect = (left: number, top: number, width: number, height: number) => ({
    left, top, right: left + width, bottom: top + height, width, height,
  })
  const row = (key: string, top: number) => ({
    getAttribute: (name: string) => name === 'data-trajectory-row-key' ? key : null,
    getBoundingClientRect: () => rect(100, top, 700, 30),
  })
  const rows = [row('tool%00call%00call-1', 200), row('tool%00call%00call-2', 240)]
  const globals = globalThis as Record<string, unknown>
  const saved = { window: globals.window, document: globals.document, fetch: globals.fetch }
  globals.window = { innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {} }
  globals.document = {
    body: {},
    querySelectorAll: (selector: string) => selector.includes('tr[data-trajectory-row-key]') ? rows : [],
  }
  globals.fetch = async () => ({
    status: 200,
    json: async () => ({
      ok: true,
      value: {
        entries: [
          { id: 'a1', seq: 1, at: Date.now(), sessionId: 's1', kind: 'signal', channel: 'signal', stage: 'tool_call', outcome: 'success', operationId: 'call-1' },
          { id: 'a2', seq: 2, at: Date.now(), sessionId: 's1', kind: 'signal', channel: 'signal', stage: 'tool_call', outcome: 'success', operationId: 'call-1' },
        ],
        total: 2,
        stats: { entries: 2, capacity: 2000, perSessionCapacity: 200, dropped: 0, writeErrors: 0, persistence: 'memory' },
      },
    }),
  })
  testApi.setClientCtx({
    get: (name: string) => name === 'uiWorkspace'
      ? { sessions: { list: { getSnapshot: () => ({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }) } } }
      : undefined,
  })
  const Component = testApi.TrajectoryMemoryMarks
  const element = () => hooks.React.createElement(Component, {})
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  try {
    hooks.runEffects()
    await new Promise((resolve) => setTimeout(resolve, 160))
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const markNodes = collect(current).filter((n) => String(n.props?.className ?? '').split(/\s+/).includes('mem-traj-mark'))
    assert.equal(markNodes.length, 1, '只有 call-1 有审计，call-2 不标记')
    assert.ok(String(markNodes[0].props?.title ?? '').includes('2 条记忆审计'), '图标 title 带审计条数')
    assert.ok(Number(markNodes[0].props?.style?.top) > 200, '图标跟随行位置')
  } finally {
    ;(testApi.setClientCtx as (v: unknown) => void)(null)
    globals.window = saved.window
    globals.document = saved.document
    globals.fetch = saved.fetch
    hooks.resetAll()
  }
})

test('审计详情能把 operationId 精确送到轨迹视图', async () => {
  const { exports, hooks } = await loadBundle()
  hooks.resetAll()
  const entries = [{
    id: 'audit-1',
    seq: 1,
    at: Date.now(),
    sessionId: 's1',
    turn: 2,
    step: 1,
    kind: 'signal',
    channel: 'signal',
    stage: 'tool_call',
    trigger: 'memory_tool',
    outcome: 'success',
    operationId: 'call-9',
    signal: { key: 'call-9', reason: 'memory_tool', tool: 'memory_search', callId: 'call-9' },
  }]
  ;(globalThis as Record<string, unknown>).fetch = async () => ({
    status: 200,
    json: async () => ({
      ok: true,
      value: {
        entries,
        total: 1,
        stats: { entries: 1, capacity: 2000, perSessionCapacity: 200, dropped: 0, writeErrors: 0, persistence: 'memory' },
      },
    }),
  })
  const AuditTab = (exports.__test as { AuditTab: (p: Record<string, unknown>) => unknown }).AuditTab
  const seen: (string | undefined)[] = []
  const element = () => hooks.React.createElement(AuditTab, {
    scopes: [],
    records: [],
    lockSession: 's1',
    audience: 'view',
    openTrajectory: (focus?: string) => { seen.push(focus) },
  })
  let current: RenderNode | null = render(element(), hooks)
  hooks.setRerender(() => { current = render(element(), hooks) })
  hooks.runEffects()
  for (let i = 0; i < 8; i++) await Promise.resolve()

  const row = collect(current).find((n) => String(n.props?.className ?? '').startsWith('audit-row'))
  assert.ok(row, '审计行存在')
  ;(row!.props!.onClick as () => void)()
  hooks.runEffects()
  for (let i = 0; i < 4; i++) await Promise.resolve()

  const jump = collect(current).find((n) => String(n.props?.className ?? '').split(/\s+/).includes('audit-jump'))
  assert.ok(jump, '详情头部有「在轨迹中定位」')
  await (jump!.props!.onClick as () => Promise<void>)()
  for (let i = 0; i < 4; i++) await Promise.resolve()
  assert.deepEqual(seen, ['call-9'], '把 operationId 原样交给 openView')
  assert.ok(textOf(current).includes('已定位到轨迹'))
  hooks.resetAll()
})
