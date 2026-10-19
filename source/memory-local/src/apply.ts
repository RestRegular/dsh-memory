/**
 * Cordis wiring for dsh-memory-local. Loaded only inside DSH.
 *
 * Per the official docs:
 *  - registers the service so consumers reach it as `ctx.memory`
 *  - the LLM rerank caller adapts `ctx.llm` (one-shot GenerateOptions with
 *    RequestUserInput) — attached lazily via ctx.get, so the plugin never sits
 *    PENDING just because no LLM adapter is loaded
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  MemoryHit,
  MemoryListInput,
  MemoryQuery,
  MemoryRecord,
  MemorySaveInput,
  MemoryScope,
} from 'dsh-memory'
import { LocalMemoryService, type MemoryLocalConfig } from './index.ts'
import type { MemoryStore } from './store.ts'

export const name = 'dsh-memory-local'

export class CordisMemoryService extends Service {
  private impl: LocalMemoryService

  constructor(ctx: Context, config: MemoryLocalConfig = {}) {
    super(ctx, 'memory')
    this.impl = new LocalMemoryService(config)
    ctx.effect(() => () => this.impl.flushSync())
    this.attachRerank(ctx, config)
  }

  /**
   * Wire the rerank stage to ctx.llm when both it and a model are configured.
   * Uses the documented one-shot shape: GenerateOptions + RequestUserInput,
   * consuming `text-delta` chunks until finish.
   */
  private attachRerank(ctx: Context, config: MemoryLocalConfig): void {
    const llmCfg = config.retrieval?.llm
    if (!llmCfg?.enabled || !llmCfg.model) return
    const llm = ctx.get('llm') as
      | { stream(options: unknown): AsyncIterable<{ type: string; textDelta?: string }> }
      | undefined
    if (!llm?.stream) return
    this.impl.setLlmInvoke(async ({ system, prompt, signal }) => {
      const chunks: string[] = []
      const stream = llm.stream({
        provider: llmCfg.provider || 'deepseek',
        model: llmCfg.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 300,
        temperature: 0,
        signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && typeof chunk.textDelta === 'string') chunks.push(chunk.textDelta)
      }
      return chunks.join('')
    })
  }

  save(input: MemorySaveInput): Promise<MemoryRecord> {
    return this.impl.save(input)
  }

  /** Direct store access for server-side consumers (e.g. the memory panel). */
  get store(): MemoryStore {
    return this.impl.store
  }

  /** Embedding-backend lifecycle, exposed for the memory panel's buttons. */
  embedServerStatus(): ReturnType<LocalMemoryService['embedServerStatus']> {
    return this.impl.embedServerStatus()
  }

  startEmbedServerManually(): ReturnType<LocalMemoryService['startEmbedServerManually']> {
    return this.impl.startEmbedServerManually()
  }

  stopEmbedServerManually(): ReturnType<LocalMemoryService['stopEmbedServerManually']> {
    return this.impl.stopEmbedServerManually()
  }

  /** Panel: download llama.cpp + the GGML model, then adopt and start them. */
  installVectorBackend(override?: Parameters<LocalMemoryService['installVectorBackend']>[0]): void {
    this.impl.installVectorBackend(override ?? {})
  }

  /** Panel: 模型清单 + 硬件探测 + 按硬件推荐(探测有缓存,只在面板问的时候跑)。 */
  modelsReport(force = false): ReturnType<LocalMemoryService['modelsReport']> {
    return this.impl.modelsReport(force)
  }

  /** Panel: abort an in-flight download. */
  cancelVectorInstall(): void {
    this.impl.cancelVectorInstall()
  }

  /** Panel: remove the runtime + model we installed (never the memory store). */
  uninstallVectorBackend(): ReturnType<LocalMemoryService['uninstallVectorBackend']> {
    return this.impl.uninstallVectorBackend()
  }

  /** Panel: delete every record in every scope. */
  wipeAllRecords(): ReturnType<LocalMemoryService['wipeAllRecords']> {
    return this.impl.wipeAllRecords()
  }

  search(query: MemoryQuery): Promise<MemoryHit[]> {
    return this.impl.search(query)
  }

  forget(input: { id?: string; query?: string; scope?: MemoryScope; scopes?: MemoryScope[] }): Promise<{ removed: number; ids: string[] }> {
    return this.impl.forget(input)
  }

  list(input?: MemoryListInput): Promise<MemoryRecord[]> {
    return this.impl.list(input)
  }

  /** memory_get:按 id 批量取记录。 */
  getByIds(ids: string[]): MemoryRecord[] {
    return this.impl.getByIds(ids)
  }

  /** 面板新建记忆 / 规则。 */
  createRecord(input: Parameters<LocalMemoryService['createRecord']>[0]): Promise<MemoryRecord> {
    return this.impl.createRecord(input)
  }

  /** 面板导出:纯文本 + 元数据,不含向量。 */
  exportAll(): ReturnType<LocalMemoryService['exportAll']> {
    return this.impl.exportAll()
  }

  /** 面板导入:逐条 save(自动重新嵌入),失败不中断。 */
  importRecords(input: unknown): ReturnType<LocalMemoryService['importRecords']> {
    return this.impl.importRecords(input)
  }

  /** 设置页显示规则条数。 */
  ruleStats(): ReturnType<LocalMemoryService['ruleStats']> {
    return this.impl.ruleStats()
  }

  /** 同步列记录(系统提示里的规则段用,不能等异步 list)。 */
  listSync(input: Parameters<LocalMemoryService['listSync']>[0]): ReturnType<LocalMemoryService['listSync']> {
    return this.impl.listSync(input)
  }

  /** 面板编辑后立即重建这一条的向量。 */
  reindexRecord(scope: MemoryScope, id: string): Promise<boolean> {
    return this.impl.reindexRecord(scope, id)
  }

  /** 作用域别名(没有则 undefined)。 */
  scopeName(scope: MemoryScope): string | undefined {
    return this.impl.scopeName(scope)
  }

  /** 注入设置(面板「设置」标签页读它)。 */
  injectSettings(): ReturnType<LocalMemoryService['injectSettings']> {
    return this.impl.injectSettings()
  }

  /** 面板改设置:落盘后广播,注入半边下一步就能按新设置跑。 */
  updateInjectSettings(patch: unknown): ReturnType<LocalMemoryService['injectSettings']> {
    const next = this.impl.updateInjectSettings(patch)
    try {
      this.ctx.emit('memory/inject-settings', next)
    } catch { /* 广播失败不影响设置本身 */ }
    return next
  }

  /**
   * 当前 agent 上下文 → 默认合并读取范围(会话 + 项目 + global,按开关与 key 去重)。
   * 工具与召回注入都走它,保证与 `resolveWriteScope` 是同一套口径。
   */
  resolveReadScopes(agent: unknown): MemoryScope[] {
    return this.impl.resolveReadScopes(agent)
  }

  /** 写路径默认 scope(省略 scope 时落到哪)。 */
  resolveWriteScope(agent: unknown, requested?: string): MemoryScope {
    return this.impl.resolveWriteScope(agent, requested)
  }

  /** 当前项目 key(会话 cwd 优先)。工具层解析 `scope:'project'` 时用它,口径与读写一致。 */
  projectKeyFor(agent: unknown): MemoryScope {
    return this.impl.projectKeyFor(agent)
  }

  /** 作用域清单(名字 + 条数),面板 /status 与 memory_list 共用。 */
  scopeStats(): ReturnType<LocalMemoryService['scopeStats']> {
    return this.impl.scopeStats()
  }

  /** 作用域清单的一行文字;SCOPE_LIMIT 错误提示里会带上它。 */
  scopeInventory(limit?: number): string {
    return this.impl.scopeInventory(limit)
  }

  /** 把磁盘上已有的 scope 全部发现并加载(读 "all" / 面板枚举前调用;带 3 秒缓存)。 */
  discoverScopes(): ReturnType<LocalMemoryService['discoverScopes']> {
    return this.impl.discoverScopes()
  }

  /** 当前进程已知的 scope 键(只读,不触发发现)。 */
  knownScopes(): ReturnType<LocalMemoryService['knownScopes']> {
    return this.impl.knownScopes()
  }
}

export function apply(ctx: Context, config: MemoryLocalConfig = {}) {
  class ScopedMemoryService extends CordisMemoryService {
    constructor(ctx2: Context) {
      super(ctx2, config)
      // 写路径默认口径来自 tools 小节(defaultScope 缺省 = 会话)。项目键**只在显式配置**
      // 时才固定下来;缺省由每次调用的 `session.header.cwd` 解析(那才是工作区)。
      // 以前这里写成 `?? project:${process.cwd()}`,而 DSH 服务进程的 cwd 是 profile 目录,
      // 等于把"当前项目"钉成了 profile —— 项目级记忆于是跨项目混在一起。
      const tools = (config as { tools?: { defaultScope?: 'session' | 'project' | 'global'; projectScope?: string } }).tools
      if (tools?.projectScope !== undefined) this.impl.setProjectScope(tools.projectScope as MemoryScope)
      if (tools?.defaultScope !== undefined) this.impl.setDefaultScope(tools.defaultScope)
    }
  }
  ctx.plugin(ScopedMemoryService)
}
