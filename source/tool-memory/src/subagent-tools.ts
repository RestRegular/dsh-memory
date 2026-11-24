/**
 * 子代理工具 shadow + 记忆权限范围（0.48.0）。
 *
 * 宿主的 subagent / subagent_fork 是全局工具，schema 固定；插件不能直接给它加参数。
 * 这里在每个 agent 自己的 scope 上注册同名工具去 shadow 它：复用宿主定义的 execute
 * （保持 provider / 模型路由 / 深度 / delivery 原样），只在调用前多一步「记忆权限范围」
 * 处理：
 *   - 有 memory_scopes 参数：按父会话有效权限拆成子集 / 超出；超出部分走 grant 审批卡，
 *     批准后父会话保留新权限，随后把子会话的授权上限（cap）落盘。
 *   - 缺省 memory_scopes：沿用旧语义（子代理继承父会话全部有效权限）。
 *
 * childId 的取得：宿主 execute 只回 {kind, name}，不带 childId；真正的子会话 id 来自
 * `subagent/start` 事件（info.id + parentSessionId，且在首次工具调用前同步发出）。
 * shadow 在调用宿主 execute 前把「本次授权计划」压进 parentSessionId 对应的队列，
 * start 事件里出队并写 cap。
 *
 * 任何一环缺失都不注册 shadow（退化成宿主原工具），绝不因为增强功能让子代理不可用。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

type Perm = 'read' | 'write'
interface ScopeGrantItem { scope: string; permissions: Perm[] }
interface DelegationMemory {
  planSubagentGrants?(agent: unknown, requested?: ReadonlyArray<ScopeGrantItem>): {
    parentPermissions: ScopeGrantItem[]
    within: ScopeGrantItem[]
    beyond: ScopeGrantItem[]
  }
  commitSubagentGrants?(agent: unknown, childSessionId: string, grants: ReadonlyArray<ScopeGrantItem>, options?: { retainInParent?: boolean; grantedBy?: string }): unknown
  requestOutOfScope?(agent: unknown, input: Record<string, unknown>): Promise<{ outcome: string; allowedIds?: string[] } | string>
}

interface HostToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

const MEMORY_SCOPES_PARAM = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scope: { type: 'string', description: '作用域键（memory_scopes list 里显示的那个）' },
      permissions: {
        type: 'array',
        items: { type: 'string', enum: ['read', 'write'] },
        description: '授予子代理的权限，省略 = 只读；写权限需显式列出',
      },
    },
  },
  description: '子代理允许使用的记忆权限范围。省略 = 继承父会话当前全部有效权限；'
    + '只允许父已有权限的子集，超出部分会向用户弹审批卡（批准后父会话也保留新权限）。',
}

function agentOf(exec: unknown): any {
  return (exec as { agent?: unknown } | undefined)?.agent
}

function normalizeRequested(raw: unknown): ScopeGrantItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ScopeGrantItem[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const value = item as Record<string, unknown>
    if (typeof value.scope !== 'string' || value.scope.trim() === '') continue
    const scope = value.scope.trim().replace(/^custom:/, '')
    const perms = Array.isArray(value.permissions)
      ? value.permissions.filter((p): p is Perm => p === 'read' || p === 'write')
      : []
    out.push({ scope, permissions: perms.length > 0 ? [...new Set(perms)] : ['read'] })
  }
  return out.length > 0 ? out : undefined
}

function permLabel(permission: Perm): string {
  return permission === 'write' ? '写入 / 删除' : '只读访问'
}

interface PendingPlan {
  grants: ScopeGrantItem[]
  retainInParent: boolean
}

/**
 * 安装子代理工具 shadow。幂等：每个 agent 只装一次，随 agent 生命周期回收。
 */
export function installSubagentToolShadows(ctx: Context): () => void {
  const disposers: Array<() => void> = []
  const plansByParent = new Map<string, PendingPlan[]>()
  let stopped = false

  const memory = (): DelegationMemory | undefined => ctx.get('memory') as DelegationMemory | undefined

  // subagent/start 在首次工具调用前同步发出：这里把排队的授权计划落到子会话。
  const offStart = ctx.on('subagent/start', (info: { id?: string; parentSessionId?: string } | unknown) => {
    try {
      const data = info as { id?: string; parentSessionId?: string }
      if (typeof data?.id !== 'string' || typeof data.parentSessionId !== 'string') return
      const queue = plansByParent.get(data.parentSessionId)
      const plan = queue?.shift()
      if (plan === undefined || plan.grants.length === 0) return
      const parentAgent = (ctx.get('agents') as { get?(id: string): unknown } | undefined)?.get?.(data.parentSessionId)
      memory()?.commitSubagentGrants?.(parentAgent, data.id, plan.grants, {
        retainInParent: plan.retainInParent,
        grantedBy: 'parent-delegation',
      })
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-memory] 子代理授权上限写入失败: ${String(error)}`)
    }
  })

  const install = (agent: any): void => {
    if (stopped || agent === undefined) return
    const agentCtx = agent.ctx as Context | undefined
    if (agentCtx === undefined || typeof agentCtx.tools?.register !== 'function') return
    const toolsApi = ctx.tools as { get?(name: string, scope?: unknown): unknown }
    if (typeof toolsApi.get !== 'function') return
    const mem = memory()
    if (mem === undefined || typeof mem.planSubagentGrants !== 'function' || typeof mem.commitSubagentGrants !== 'function') return

    for (const toolName of ['subagent', 'subagent_fork']) {
      // ScopeKey 就是 agent 本身（tools.resolve 用 this.view(agent)）。
      const hostDef = toolsApi.get(toolName, agent) as HostToolDefinition | undefined
      if (hostDef === undefined || typeof hostDef.execute !== 'function') continue

      const shadow = {
        name: toolName,
        async execute(args: Record<string, unknown>, exec: unknown) {
          const requested = normalizeRequested(args.memory_scopes)
          const { memory_scopes: _scopes, ...hostArgs } = args
          if (requested === undefined) return hostDef.execute(hostArgs, exec)

          const parentAgent = agentOf(exec) ?? agent
          const plan = mem.planSubagentGrants!(parentAgent, requested)
          const grants: ScopeGrantItem[] = [...plan.within]
          let retainInParent = false

          if (plan.beyond.length > 0 && typeof mem.requestOutOfScope === 'function') {
            const description = typeof args.description === 'string' ? args.description : ''
            const all = [...plan.within, ...plan.beyond]
            const answer = await mem.requestOutOfScope(parentAgent, {
              tool: toolName,
              action: 'write',
              query: `子代理申请记忆权限：${all.map((item) => `${item.scope}(${item.permissions.map(permLabel).join('/')})`).join('、')}`,
              ...(description !== '' ? { description } : {}),
              mode: 'grant',
              items: plan.beyond.flatMap((item) => item.permissions.map((permission) => ({
                id: `grant:${item.scope}:${permission}`,
                scope: item.scope,
                kind: 'grant',
                content: permLabel(permission),
                tags: ['subagent'],
                importance: 0,
                updatedAt: Date.now(),
                reason: 'scope',
                grantPermission: permission,
              }))),
            })
            const decision = typeof answer === 'string' ? { outcome: answer } : (answer ?? { outcome: 'rejected' })
            if (decision.outcome !== 'allowed-once') {
              throw new Error(`子代理创建已取消：申请的记忆权限未获批准（${decision.outcome}）`)
            }
            const allowed = decision.allowedIds === undefined ? undefined : new Set(decision.allowedIds)
            for (const item of plan.beyond) {
              const perms = item.permissions.filter((permission) => allowed === undefined || allowed.has(`grant:${item.scope}:${permission}`))
              if (perms.length > 0) { grants.push({ scope: item.scope, permissions: perms }); retainInParent = true }
            }
          }

          // 排队授权计划（subagent/start 出队写 cap），再调用宿主实现创建子代理。
          const parentId = (parentAgent?.session?.header?.id ?? parentAgent?.session?.id) as string | undefined
          if (typeof parentId === 'string' && parentId !== '') {
            const queue = plansByParent.get(parentId) ?? []
            queue.push({ grants, retainInParent })
            plansByParent.set(parentId, queue)
          }
          return hostDef.execute(hostArgs, exec)
        },
      }

      try {
        const dispose = agentCtx.tools.register(defineTool({
          name: shadow.name,
          description: hostDef.description,
          parameters: { ...(hostDef.parameters ?? {}), memory_scopes: MEMORY_SCOPES_PARAM } as never,
          output: hostDef.output as never,
          execute: (a: unknown, e: never) => shadow.execute(a as Record<string, unknown>, e),
        }))
        disposers.push(dispose)
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-memory] 子代理工具 ${toolName} shadow 注册失败: ${String(error)}`)
      }
    }
  }

  const offCreated = ctx.on('agent/created', (payload: { agent?: unknown } | unknown) => {
    try { install((payload as { agent?: unknown })?.agent) } catch { /* 增强失败不影响 agent */ }
  })
  try {
    const agents = ctx.get('agents') as { list?(): unknown[] } | undefined
    for (const agent of agents?.list?.() ?? []) install(agent)
  } catch { /* 未就绪时忽略 */ }

  return () => {
    stopped = true
    offStart()
    offCreated()
    for (const dispose of disposers) { try { dispose() } catch { /* 卸载容错 */ } }
  }
}
