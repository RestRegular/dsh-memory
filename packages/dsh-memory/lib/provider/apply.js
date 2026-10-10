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
  installVectorBackend()       {
    this.impl.installVectorBackend()
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

  forget(input                                 )                                              {
    return this.impl.forget(input)
  }

  list(input                  )                          {
    return this.impl.list(input)
  }
}

export function apply(ctx         , config                    = {}) {
  class ScopedMemoryService extends CordisMemoryService {
    constructor(ctx2         ) {
      super(ctx2, config)
    }
  }
  ctx.plugin(ScopedMemoryService)
}


//# sourceURL=D:\.deepseek\memory-plugin\packages\memory-local\src\apply.ts