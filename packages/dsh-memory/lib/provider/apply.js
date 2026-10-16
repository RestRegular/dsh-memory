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
      // 写路径默认口径来自 tools 小节(defaultScope 缺省 = 会话);项目键缺省
      // project:<cwd>,即 DSH 进程的启动目录 = 这个 profile 目录。
      const tools = (config                                                                                          ).tools
      this.impl.setProjectScope((tools?.projectScope ?? `project:${process.cwd()}`)               )
      if (tools?.defaultScope !== undefined) this.impl.setDefaultScope(tools.defaultScope)
    }
  }
  ctx.plugin(ScopedMemoryService)
}


//# sourceURL=source/memory-local/src/apply.ts