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

  forget(input: { id?: string; query?: string }): Promise<{ removed: number; ids: string[] }> {
    return this.impl.forget(input)
  }

  list(input?: MemoryListInput): Promise<MemoryRecord[]> {
    return this.impl.list(input)
  }
}

export function apply(ctx: Context, config: MemoryLocalConfig = {}) {
  class ScopedMemoryService extends CordisMemoryService {
    constructor(ctx2: Context) {
      super(ctx2, config)
    }
  }
  ctx.plugin(ScopedMemoryService)
}
