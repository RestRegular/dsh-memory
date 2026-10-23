/**
 * Cordis wiring for dsh-tool-memory. Loaded only inside DSH: wraps the pure
 * tool specs with the official defineTool DSL and registers them.
 *
 * inject: ['tools', 'memory'] is REQUIRED:
 *  - 'tools'  → the tool registry must be ready
 *  - 'memory' → this fiber stays PENDING until the provider provides the
 *    service, so `ctx.memory` is guaranteed active when apply runs (accessing
 *    it without declaring made apply throw and the entry silently die)
 *
 * 0.5.0 起 scope 的默认值是**当前会话**:handler 必须把宿主的 `exec` 透传给工具实现
 * (会话 id / cwd 全在 `exec.agent.session.header` 上),这里同时负责把 scope 键渲染成
 * 人看得懂的标签(会话标题只有这一层能拿到)。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  memoryTools,
  type MemoryToolService,
  type MemoryToolsOptions,
  type ToolSpec,
} from './index.ts'
import { renderGetResult, renderSearchResult, renderWithheldNote } from './render.ts'
import { resolveCurrentScopes, scopeKind, type ScopeKey } from '../../memory-local/src/scope.ts'

export const name = 'dsh-tool-memory'
export const inject = ['tools', 'memory']

export interface ToolMemoryConfig {
  /** 省略 scope 时写到哪个作用域:'session'(默认,拿不到会话回退项目)/ 'project' / 'global'。 */
  defaultScope?: 'session' | 'project' | 'global'
  /** 固定项目 scope 键;不给则用会话 header.cwd(退回 DSH 启动目录)。 */
  projectScope?: string
}

export function apply(ctx: any, config: ToolMemoryConfig = {}) {
  const memory = ctx.memory as MemoryToolService
  /** 调用时的项目键:显式配置 > 会话 cwd > 进程 cwd。 */
  const projectScopeFor = (exec: unknown): string => {
    if (config.projectScope !== undefined) return config.projectScope
    return resolveCurrentScopes((exec as { agent?: unknown } | undefined)?.agent).project
  }
  const opts: MemoryToolsOptions = {
    getService: () => memory,
    defaultScope: config.defaultScope ?? 'session',
    projectScope: config.projectScope,
  }
  const tools = memoryTools(opts)

  /**
   * scope 键 → 展示标签。会话标题只有宿主服务能给:`ctx.get('sessionTitle')` 的 `get(session)`
   * 返回 `{ title }`(见 @deepseek-ai/dsh-session-title)。整套访问都在 try/catch 里 ——
   * 旧宿主没有这个服务、会话已经不在内存里,都不能影响工具结果,回退成"会话 <id 前 8 位>"。
   */
  const labelFor = (scope: ScopeKey, agent: unknown): string => {
    if (scope === 'global') return '全局'
    if (scope.startsWith('project:')) return scope.slice('project:'.length)
    if (scope.startsWith('session:')) {
      const id = scope.slice('session:'.length)
      const short = id.slice(0, 8)
      try {
        const session = (agent as { session?: { id?: string } } | undefined)?.session
        if (session?.id === id) {
          const titles = ctx.get?.('sessionTitle')
          const snapshot = titles?.get?.(session)
          const title = snapshot?.title
          if (typeof title === 'string' && title.length > 0) return `${title}(${short})`
        }
      } catch { /* 拿不到标题就用短 id */ }
      return `会话 ${short}`
    }
    return scope
  }

  const renderScope = (scope: ScopeKey, agent: unknown): string =>
    scopeKind(scope) === 'custom' ? `自定义「${scope}」` : labelFor(scope, agent)

  /** 作用域清单文案(名字 + 条数);最多 20 个,其余写"…另有 N 个"。 */
  const scopeSummary = (value: { scopeStats?: Array<{ scope: string; records: number }> }, agent: unknown): string => {
    const stats = value.scopeStats ?? []
    if (stats.length === 0) return ''
    const lines = stats.slice(0, 20).map((s) => `${renderScope(s.scope, agent)}(${s.records})`)
    const rest = stats.length - lines.length
    return `作用域：${lines.join('、')}${rest > 0 ? `，…另有 ${rest} 个` : ''}`
  }

  const register = <A, O>(spec: ToolSpec<A, O>, render: (value: O, args: A, exec: unknown) => string): void => {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters as never,
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: O, exec?: unknown) => [{ type: 'text', text: render(value, _args as A, exec) }],
      },
      execute: (args: A, exec: never) => spec.execute(args, exec),
    }))
  }

  register(tools.memory_save, (value, _args, exec) => {
    const agent = (exec as { agent?: unknown } | undefined)?.agent
    return value.deduped
      ? `已更新既有记忆（内容相同，去重）：${value.id} @ ${renderScope(value.scope, agent)}`
      : `已保存记忆 ${value.id} @ ${renderScope(value.scope, agent)}`
  })

  register(tools.memory_search, (value, _args, exec) => {
    const agent = (exec as { agent?: unknown } | undefined)?.agent
    return renderSearchResult(value, (scope) => renderScope(scope, agent))
  })

  register(tools.memory_forget, (value) => (value.removed === 0 ? '没有匹配的记忆。' : `已删除 ${value.removed} 条记忆。`))

  register(tools.memory_list, (value, _args, exec) => {
    const agent = (exec as { agent?: unknown } | undefined)?.agent
    const body = value.records.length === 0
      ? '该作用域还没有记忆。'
      : value.records.map((r) => `(${renderScope(r.scope, agent)}/${r.kind}) ${r.content}`).join('\n')
    const summary = scopeSummary(value, agent)
    const note = renderWithheldNote(value.withheld)
    return [body, summary, note].filter((part) => part !== '').join('\n')
  })

  register(tools.memory_get, (value, _args, exec) => {
    const agent = (exec as { agent?: unknown } | undefined)?.agent
    return renderGetResult(value, (scope) => renderScope(scope, agent))
  })
}
