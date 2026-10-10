/**
 * Cordis wiring for dsh-tool-memory. Loaded only inside DSH: wraps the pure
 * tool specs with the official defineTool DSL and registers them.
 *
 * inject: ['tools', 'memory'] is REQUIRED:
 *  - 'tools'  → the tool registry must be ready
 *  - 'memory' → this fiber stays PENDING until the provider provides the
 *    service, so `ctx.memory` is guaranteed active when apply runs (accessing
 *    it without declaring made apply throw and the entry silently die)
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  memoryTools,
                          
                   
                        
} from './index.js'

export const name = 'dsh-tool-memory'
export const inject = ['tools', 'memory']

                                   
                                                                                 
                                     
                                                                   
                       
 

export function apply(ctx     , config                   = {}) {
  const memory = ctx.memory                    
  const projectScope = (config.projectScope ?? `project:${process.cwd()}`)               
  const opts                     = {
    getService: () => memory,
    defaultScope: () => (config.defaultScope === 'global' ? 'global' : projectScope),
  }
  const tools = memoryTools(opts)

  ctx.tools.register(defineTool({
    name: tools.memory_save.name,
    description: tools.memory_save.description,
    parameters: tools.memory_save.parameters         ,
    output: {
      schema: { type: 'json' },
      render: (_args         , value                                                 ) => [{
        type: 'text',
        text: value.deduped
          ? `已更新既有记忆（内容相同，去重）：${value.id} @ ${value.scope}`
          : `已保存记忆 ${value.id} @ ${value.scope}`,
      }],
    },
    execute: (args       ) => tools.memory_save.execute(args),
  }))

  ctx.tools.register(defineTool({
    name: tools.memory_search.name,
    description: tools.memory_search.description,
    parameters: tools.memory_search.parameters         ,
    output: {
      schema: { type: 'json' },
      render: (_args         , value                                                                                     ) => [{
        type: 'text',
        text: value.records.length === 0
          ? '没有找到相关记忆。'
          : value.records
            .map((h) => `[${h.score.toFixed(3)}] (${h.scope}/${h.kind}) ${h.content}`)
            .join('\n'),
      }],
    },
    execute: (args       ) => tools.memory_search.execute(args),
  }))

  ctx.tools.register(defineTool({
    name: tools.memory_forget.name,
    description: tools.memory_forget.description,
    parameters: tools.memory_forget.parameters         ,
    output: {
      schema: { type: 'json' },
      render: (_args         , value                     ) => [{
        type: 'text',
        text: value.removed === 0 ? '没有匹配的记忆。' : `已删除 ${value.removed} 条记忆。`,
      }],
    },
    execute: (args       ) => tools.memory_forget.execute(args),
  }))

  ctx.tools.register(defineTool({
    name: tools.memory_list.name,
    description: tools.memory_list.description,
    parameters: tools.memory_list.parameters         ,
    output: {
      schema: { type: 'json' },
      render: (_args         , value                                                                      ) => [{
        type: 'text',
        text: value.records.length === 0
          ? '该作用域还没有记忆。'
          : value.records
            .map((r) => `(${r.scope}/${r.kind}) ${r.content}`)
            .join('\n'),
      }],
    },
    execute: (args       ) => tools.memory_list.execute(args),
  }))
}


//# sourceURL=D:\.deepseek\memory-plugin\packages\tool-memory\src\apply.ts