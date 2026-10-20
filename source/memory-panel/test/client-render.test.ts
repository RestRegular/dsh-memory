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

function render(node: unknown, hooks: ReturnType<typeof makeReact>, path = 'root'): RenderNode | null {
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
    const label = ({ records: '服务', data: '记录', settings: '设置' } as Record<string, string>)[tab] ?? tab
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
