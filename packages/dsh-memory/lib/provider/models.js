/**
 * 可安装的 embedding 模型清单(数据层,零 I/O)。
 *
 * 硬约束:清单里每个 URL 都是**实测可达**的(HTTP 200 + 已知字节数),不写猜测的仓库 ——
 * 一个死链会让"一键安装"变成一条看不懂的失败信息,而这正是要消灭的体验。
 * 想加模型:先 `curl -I`(或 HEAD)确认 URL 与 content-length,再往这里加一条。
 *
 * 每个模型必须声明三件与运行强相关的事实,它们会一起写回配置:
 *   - dims:    服务端输出维度。客户端会校验(见 embed.ts),写错会让检索**静默降级**为词法。
 *   - pooling: llama.cpp 的 `--pooling`。BGE 系用 cls,Qwen3-Embedding 用 last,
 *              nomic 用 mean;'auto' 表示不传该参数、由 GGUF 元数据决定。
 *   - prefixes:有些模型要靠前缀区分查询与文档(e5 的 "query:/passage:"、nomic 的
 *              "search_query:/search_document:"),不带前缀质量会明显下降。
 */

/** llama.cpp 的池化方式;'auto' = 不传 --pooling,由 GGUF 元数据决定。 */
                                                          

/** 一个量化档位(落盘文件名 + 已知体积 + 多源回退列表)。 */
                               
            
               
                                                       
              
               
                                 
                   
                           
                     
 

                                 
            
               
                        
              
              
                      
                                 
                       
                                         
                                          
                 
                             
               
                      
                         
                          
 

const HF = 'https://hf-mirror.com'
const HF_OFFICIAL = 'https://huggingface.co'
/** ModelScope 只对已核实过的仓库列出(它的路径是 /resolve/master/ 而不是 /main/)。 */
const MS = 'https://modelscope.cn/models'

function hfSources(repo        , file        )           {
  return [`${HF}/${repo}/resolve/main/${file}`, `${HF_OFFICIAL}/${repo}/resolve/main/${file}`]
}

export const EMBEDDING_MODELS                            = [
  {
    id: 'bge-m3',
    label: 'BGE-M3',
    note: '多语言、8192 上下文,中英混排的稳妥默认值',
    dims: 1024,
    pooling: 'cls',
    contextTokens: 8192,
    languages: 'multilingual',
    quality: 4,
    speed: 3,
    variants: [
      {
        id: 'q4_k_m', label: 'Q4_K_M', file: 'bge-m3-Q4_K_M.gguf', bytes: 437_778_496, isDefault: true,
        sources: [
          `${HF}/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q4_K_M.gguf`,
          `${MS}/gpustack/bge-m3-GGUF/resolve/master/bge-m3-Q4_K_M.gguf`,
          `${HF_OFFICIAL}/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q4_K_M.gguf`,
        ],
      },
      {
        id: 'q8_0', label: 'Q8_0', file: 'bge-m3-Q8_0.gguf', bytes: 634_567_104,
        sources: [
          `${HF}/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf`,
          `${MS}/gpustack/bge-m3-GGUF/resolve/master/bge-m3-Q8_0.gguf`,
          `${HF_OFFICIAL}/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf`,
        ],
      },
    ],
  },
  {
    id: 'qwen3-embedding-0.6b',
    label: 'Qwen3-Embedding-0.6B',
    note: '同体积下检索质量明显更强,推荐优先试它',
    dims: 1024,
    pooling: 'last',
    contextTokens: 32768,
    languages: 'multilingual',
    quality: 5,
    speed: 3,
    variants: [
      {
        id: 'q8_0', label: 'Q8_0', file: 'Qwen3-Embedding-0.6B-Q8_0.gguf', bytes: 639_171_584, isDefault: true,
        sources: hfSources('Qwen/Qwen3-Embedding-0.6B-GGUF', 'Qwen3-Embedding-0.6B-Q8_0.gguf'),
      },
    ],
  },
  {
    id: 'qwen3-embedding-4b',
    label: 'Qwen3-Embedding-4B',
    note: '质量更强、体积也更大;CPU 上每次检索会明显变慢,有显卡再选',
    dims: 2560,
    pooling: 'last',
    contextTokens: 32768,
    languages: 'multilingual',
    quality: 6,
    speed: 1,
    variants: [
      {
        id: 'q4_k_m', label: 'Q4_K_M', file: 'Qwen3-Embedding-4B-Q4_K_M.gguf', bytes: 2_496_737_280, isDefault: true,
        sources: hfSources('Qwen/Qwen3-Embedding-4B-GGUF', 'Qwen3-Embedding-4B-Q4_K_M.gguf'),
      },
    ],
  },
  {
    id: 'qwen3-embedding-8b',
    label: 'Qwen3-Embedding-8B',
    note: '最强档,约 4.5GB;只建议有大显存或 32GB 以上内存的机器',
    dims: 4096,
    pooling: 'last',
    contextTokens: 32768,
    languages: 'multilingual',
    quality: 7,
    speed: 1,
    variants: [
      {
        id: 'q4_k_m', label: 'Q4_K_M', file: 'Qwen3-Embedding-8B-Q4_K_M.gguf', bytes: 4_676_403_200, isDefault: true,
        sources: hfSources('Qwen/Qwen3-Embedding-8B-GGUF', 'Qwen3-Embedding-8B-Q4_K_M.gguf'),
      },
    ],
  },
  {
    id: 'nomic-embed-text-v1.5',
    label: 'Nomic Embed v1.5',
    note: '英文为主、体积最小;必须带 query/document 前缀,已内置',
    dims: 768,
    pooling: 'mean',
    contextTokens: 8192,
    languages: 'en',
    quality: 3,
    speed: 5,
    queryPrefix: 'search_query: ',
    documentPrefix: 'search_document: ',
    variants: [
      {
        id: 'q4_k_m', label: 'Q4_K_M', file: 'nomic-embed-text-v1.5.Q4_K_M.gguf', bytes: 84_099_072, isDefault: true,
        sources: hfSources('nomic-ai/nomic-embed-text-v1.5-GGUF', 'nomic-embed-text-v1.5.Q4_K_M.gguf'),
      },
      {
        id: 'f16', label: 'F16', file: 'nomic-embed-text-v1.5.f16.gguf', bytes: 274_313_216,
        sources: hfSources('nomic-ai/nomic-embed-text-v1.5-GGUF', 'nomic-embed-text-v1.5.f16.gguf'),
      },
    ],
  },
  {
    id: 'bge-small-zh-v1.5',
    label: 'BGE Small 中文',
    note: '中文轻量档,约 46MB,老机器也能秒检索',
    dims: 512,
    pooling: 'cls',
    contextTokens: 512,
    languages: 'zh',
    quality: 3,
    speed: 5,
    variants: [
      {
        id: 'f16', label: 'F16', file: 'bge-small-zh-v1.5-f16.gguf', bytes: 47_919_104, isDefault: true,
        sources: hfSources('CompendiumLabs/bge-small-zh-v1.5-gguf', 'bge-small-zh-v1.5-f16.gguf'),
      },
    ],
  },
  {
    id: 'bge-base-zh-v1.5',
    label: 'BGE Base 中文',
    note: '中文中等档,768 维,约 195MB',
    dims: 768,
    pooling: 'cls',
    contextTokens: 512,
    languages: 'zh',
    quality: 4,
    speed: 4,
    variants: [
      {
        id: 'f16', label: 'F16', file: 'bge-base-zh-v1.5-f16.gguf', bytes: 204_052_480, isDefault: true,
        sources: hfSources('CompendiumLabs/bge-base-zh-v1.5-gguf', 'bge-base-zh-v1.5-f16.gguf'),
      },
    ],
  },
  {
    id: 'bge-large-zh-v1.5',
    label: 'BGE Large 中文',
    note: '中文强档,1024 维,约 620MB',
    dims: 1024,
    pooling: 'cls',
    contextTokens: 512,
    languages: 'zh',
    quality: 5,
    speed: 3,
    variants: [
      {
        id: 'f16', label: 'F16', file: 'bge-large-zh-v1.5-f16.gguf', bytes: 650_117_120, isDefault: true,
        sources: hfSources('CompendiumLabs/bge-large-zh-v1.5-gguf', 'bge-large-zh-v1.5-f16.gguf'),
      },
    ],
  },
]

/** 不做任何配置时的模型 —— 与合并前的老行为完全一致(Q4_K_M 的 BGE-M3)。 */
export const DEFAULT_MODEL_ID = 'bge-m3'

export function findModel(id                    )                             {
  if (id === undefined) return undefined
  return EMBEDDING_MODELS.find((m) => m.id === id)
}

export function defaultVariant(model                )               {
  return model.variants.find((v) => v.isDefault) ?? model.variants[0] 
}

export function findVariant(model                , variantId                    )               {
  if (variantId === undefined) return defaultVariant(model)
  return model.variants.find((v) => v.id === variantId) ?? defaultVariant(model)
}

/** 所有模型的档位展开成一张扁平表(面板的"模型 / 档位"下拉用)。 */
export function variantOptions()                                                                                                                {
  const out = []
  for (const model of EMBEDDING_MODELS) {
    for (const variant of model.variants) {
      out.push({
        modelId: model.id,
        modelLabel: model.label,
        variantId: variant.id,
        label: `${model.label} · ${variant.label}`,
        bytes: variant.bytes,
        dims: model.dims,
      })
    }
  }
  return out
}


//# sourceURL=source/memory-local/src/models.ts