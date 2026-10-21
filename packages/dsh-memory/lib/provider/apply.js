/**
 * Cordis wiring for dsh-memory-local. Loaded only inside DSH.
 *
 * Per the official docs:
 *  - registers the service so consumers reach it as `ctx.memory`
 *  - the LLM rerank caller adapts `ctx.llm` (one-shot GenerateOptions with
 *    RequestUserInput) — attached lazily via ctx.get, so the plugin never sits
 *    PENDING just because no LLM adapter is loaded
 */
import { Service,              } from '@deepseek-ai/cordis'
             
            
                  
              
               
                  
              
                   
import { LocalMemoryService,                        } from './index.js'
                                             

export const name = 'dsh-memory-local'

export class CordisMemoryService extends Service {
          impl                    

  constructor(ctx         , config                    = {}) {
    super(ctx, 'memory')
    this.impl = new LocalMemoryService(config)
    // 0.11.1:同一个目录因为 `D:/x` 与 `D:\x` 写法不同而分叉成两个 scope 的历史数据,
    // 在装配期合并一次(每进程一次;失败只影响合并,不影响读写)。
    try {
      this.impl.reconcileScopes()
    } catch {
      // 合并失败:两个 scope 继续并存(读写仍然正常),不阻断插件加载
    }
    ctx.effect(() => () => this.impl.flushSync())
    this.attachRerank(ctx, config)
  }

  /**
   * Wire the rerank stage to ctx.llm when both it and a model are configured.
   * Uses the documented one-shot shape: GenerateOptions + RequestUserInput,
   * consuming `text-delta` chunks until finish.
   */
          attachRerank(ctx         , config                   )       {
    const llmCfg = config.retrieval?.llm
    if (!llmCfg?.enabled || !llmCfg.model) return
    const llm = ctx.get('llm')   
                                                                                         
                 
    if (!llm?.stream) return
    this.impl.setLlmInvoke(async ({ system, prompt, signal }) => {
      const chunks           = []
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

  save(input                 )                        {
    return this.impl.save(input)
  }

  /** Direct store access for server-side consumers (e.g. the memory panel). */
  get store()              {
    return this.impl.store
  }

  /** Embedding-backend lifecycle, exposed for the memory panel's buttons. */
  embedServerStatus()                                                      {
    return this.impl.embedServerStatus()
  }

  startEmbedServerManually()                                                             {
    return this.impl.startEmbedServerManually()
  }

  stopEmbedServerManually()                                                            {
    return this.impl.stopEmbedServerManually()
  }

  /** Panel: download llama.cpp + the GGML model, then adopt and start them. */
  installVectorBackend(override                                                            )       {
    this.impl.installVectorBackend(override ?? {})
  }

  /** Panel: 模型清单 + 硬件探测 + 按硬件推荐(探测有缓存,只在面板问的时候跑)。 */
  modelsReport(force = false)                                                 {
    return this.impl.modelsReport(force)
  }

  /** Panel: abort an in-flight download. */
  cancelVectorInstall()       {
    this.impl.cancelVectorInstall()
  }

  /** Panel: remove the runtime + model we installed (never the memory store). */
  uninstallVectorBackend()                                                           {
    return this.impl.uninstallVectorBackend()
  }

  /** Panel: delete every record in every scope. */
  wipeAllRecords()                                                   {
    return this.impl.wipeAllRecords()
  }

  search(query             )                       {
    return this.impl.search(query)
  }

  forget(input                                                                              )                                              {
    return this.impl.forget(input)
  }

  list(input                  )                          {
    return this.impl.list(input)
  }

  /** memory_get:按 id 批量取记录。 */
  getByIds(ids          )                 {
    return this.impl.getByIds(ids)
  }

  /** 面板新建记忆 / 规则。 */
  createRecord(input                                                   )                        {
    return this.impl.createRecord(input)
  }

  /** 面板导出:纯文本 + 元数据,不含向量。 */
  exportAll()                                              {
    return this.impl.exportAll()
  }

  /** 面板导入:逐条 save(自动重新嵌入),失败不中断。 */
  importRecords(input         )                                                  {
    return this.impl.importRecords(input)
  }

  /** 设置页显示规则条数。 */
  ruleStats()                                              {
    return this.impl.ruleStats()
  }

  /** 同步列记录(系统提示里的规则段用,不能等异步 list)。 */
  listSync(input                                               )                                             {
    return this.impl.listSync(input)
  }

  /** 面板编辑后立即重建这一条的向量。 */
  reindexRecord(scope             , id        )                   {
    return this.impl.reindexRecord(scope, id)
  }

  /** 维护:重建全部向量(作废旧向量并重新嵌入)。 */
  reindexAll()                                               {
    return this.impl.reindexAll()
  }

  /** 维护:作废全部向量并按当前模型后台重嵌。 */
  reindexAll()                                               {
    return this.impl.reindexAll()
  }

  /** 作用域别名(没有则 undefined)。 */
  scopeName(scope             )                     {
    return this.impl.scopeName(scope)
  }

  /** 注入设置(面板「设置」标签页读它)。 */
  injectSettings()                                                   {
    return this.impl.injectSettings()
  }

  /** 面板改设置:落盘后广播,注入半边下一步就能按新设置跑。 */
  updateInjectSettings(patch         )                                                   {
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
  resolveReadScopes(agent         )                {
    return this.impl.resolveReadScopes(agent)
  }

  /** 写路径默认 scope(省略 scope 时落到哪)。 */
  resolveWriteScope(agent         , requested         )              {
    return this.impl.resolveWriteScope(agent, requested)
  }

  /** 当前项目 key(会话 cwd 优先)。工具层解析 `scope:'project'` 时用它,口径与读写一致。 */
  projectKeyFor(agent         )              {
    return this.impl.projectKeyFor(agent)
  }

  /** 作用域清单(名字 + 条数),面板 /status 与 memory_list 共用。 */
  scopeStats()                                               {
    return this.impl.scopeStats()
  }

  /** 作用域清单的一行文字;SCOPE_LIMIT 错误提示里会带上它。 */
  scopeInventory(limit         )         {
    return this.impl.scopeInventory(limit)
  }

  /** 把磁盘上已有的 scope 全部发现并加载(读 "all" / 面板枚举前调用;带 3 秒缓存)。 */
  discoverScopes()                                                   {
    return this.impl.discoverScopes()
  }

  /** 当前进程已知的 scope 键(只读,不触发发现)。 */
  knownScopes()                                                {
    return this.impl.knownScopes()
  }
}

export function apply(ctx         , config                    = {}) {
  class ScopedMemoryService extends CordisMemoryService {
    constructor(ctx2         ) {
      super(ctx2, config)
      // 写路径默认口径来自 tools 小节(defaultScope 缺省 = 会话)。项目键**只在显式配置**
      // 时才固定下来;缺省由每次调用的 `session.header.cwd` 解析(那才是工作区)。
      // 以前这里写成 `?? project:${process.cwd()}`,而 DSH 服务进程的 cwd 是 profile 目录,
      // 等于把"当前项目"钉成了 profile —— 项目级记忆于是跨项目混在一起。
      const tools = (config                                                                                          ).tools
      if (tools?.projectScope !== undefined) this.impl.setProjectScope(tools.projectScope               )
      if (tools?.defaultScope !== undefined) this.impl.setDefaultScope(tools.defaultScope)
    }
  }
  ctx.plugin(ScopedMemoryService)
}


//# sourceURL=source/memory-local/src/apply.ts