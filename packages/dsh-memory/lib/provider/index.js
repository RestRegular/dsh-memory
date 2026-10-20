/**
 * dsh-memory-local — local JSONL provider for the DSH memory service.
 *
 * This entry is intentionally cordis-free so unit tests and standalone tools
 * run without the harness. The Cordis wiring (Service subclass, effects,
 * plugin apply) lives in ./apply.ts and is only loaded inside DSH.
 */
             
            
                  
              
               
                  
              
                   
                   
import { MemoryStore, scopeFileName,                 } from './store.js'
import {
  isCustomScope,
  normalizeScopeInput,
  resolveCurrentScopes,
  scopeKind,
  scopeTier,
  writeScopeForDefault,
                
} from './scope.js'
import { ScopeNames } from './scope-names.js'
import { mergeInjectSettings, normalizeInjectSettings,                     } from './inject-settings.js'
import { buildStats, lexicalScore, recordScore, tokenize, cosine, normalizeInPlace, hasStrongHit } from './scoring.js'
import { EmbedClient } from './embed.js'
import { DailyBudget, blendScores, rerank,                                   } from './rerank.js'
import { RerankCache } from './rerank-cache.js'
import { scanSecrets, redactSecrets } from './secrets.js'
import { EmbedServerManager,                                               } from './embed-server.js'
import { VectorInstaller, detectInstalled, installPaths,                      } from './embed-install.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  DEFAULT_MODEL_ID,
  EMBEDDING_MODELS,
  findModel,
  findVariant,
                   
} from './models.js'
import { probeHardware,                                       } from './hardware.js'
import { pickFlavor, recommendModel } from './recommend.js'

/** Recursive byte count; 0 for anything unreadable. */
function pathSize(path        )         {
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const entry of readdirSync(path)) total += pathSize(join(path, entry))
    return total
  } catch {
    return 0
  }
}

/** True when `child` is `parent` or lives under it (both resolved). */
function isInside(parent        , child        )          {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

                                    
                                                  
                   
     
                                                                    
                                                                
     
            
                    
                     
                     
                                                          
   
               
                 
                    
                                                     
                            
                                                                                    
                             
                                
              
                       
                       
                                                      
                    
                   
         
                                                           
                                 
         
                     
                                                       
                      
                                               
                     
                   
                                  
                     
                    
                             
                      
                                    
                          
       
                                                                    
                           
                                                          
                                     
                                                             
                        
                                                            
                        
                                                               
                             
                                                                               
                                
                                                                             
                               
                       
                                
                                                                                      
                               
         
                                                                               
                                                                   
                                                                             
                                                                             
                                                                      
         
                     
                    
           
                                                                      
                                                                             
                                                                      
           
                               
       
     
                               
   
                                                                   
                                                                           
                                                             
 

                                 
                  
                        
                         
                                                               
                         
                                                     
                        
                                                  
                         
              
                 
                         
                          
                      
           
                    
                                                                                      
                       
                               
                            
                                                                                   
                       
                                                                                    
                                  
                                                              
                                                                      
                                              
                    
                     
                      
                                                     
                        
                                            
                                  
                               
                     
                                           
                        
                           
                    
                 
                
                     
                          
                             
                            
                    
                             
                            
   
                   
                            
                        
                                                          
 

/** vector 配置节的类型别名,给下面的模型解析helpers 用。 */
                                                                                           

/** 面板可以在安装时临时指定的模型选择。 */
                                
                 
                  
                                                                                                                  
                                 
 

/**
 * 「面板选过什么」的记忆,落在安装目录里(<installRoot>/selected-model.json)。
 *
 * 为什么需要它:面板没法改写 profile 配置,而"选了模型 → 重启后配置又指回老模型"
 * 会让装好的模型认不出来。这里是**低于配置**的一层记忆:配置里写了 preset/customModel
 * 就听配置的,没写才用这份。
 */
export const MODEL_STATE_FILE = 'selected-model.json'

                      
                   
                    
                                       
                                 
 

function readModelState(root        )                    {
  try {
    const text = readFileSync(join(root, MODEL_STATE_FILE), 'utf8')
    const parsed = JSON.parse(text)              
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeModelState(root        , state            )       {
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, MODEL_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // 记不住不影响本次安装;下次面板仍会显示配置文件里的选择。
  }
}

/** 系统语言(用来判断"中文优先");拿不到就当英文环境。 */
function safeLocale()         {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  } catch {
    return 'en'
  }
}

/** 该模型某个档位的体积(不指定档位时用默认档),用于清单展示与磁盘校验。 */
function variantBytes(model                                                                         , variantId         )         {
  const variant = variantId !== undefined ? model.variants.find((v) => v.id === variantId) : undefined
  return (variant ?? model.variants.find((v) => v.isDefault) ?? model.variants[0] ).bytes
}

                          
                  
                   
               
              
                
                   
              
                      
                                           
                   
                      
                         
                                 
 

/**
 * 把配置里的模型选择解析成安装器要的形态(文件名 / 体积 / 源 / 维度 / pooling / 前缀)。
 *
 * 优先级:customModel(完全自定义) → preset(清单 id) → 用 `model` 字符串去清单里找
 * → 内置默认(bge-m3 Q4_K_M,与老行为逐字一致)。
 * 认不出的 `model` 字符串**不改身份**(请求与边车仍用它),只是安装器退回默认模型 ——
 * 用户指向云端/自建服务时本来就该只写 endpoint + model + dims。
 */
function resolveModelSelection(v                   , root         )                 {
  const state = root !== undefined ? readModelState(root) : null
  const custom = v.customModel ?? state?.customModel
  if (custom !== undefined) {
    let file = custom.file
    if (file === undefined || file === '') {
      try {
        file = basename(new URL(custom.url).pathname) || 'custom-model.gguf'
      } catch {
        file = 'custom-model.gguf'
      }
    }
    return {
      presetId: 'custom',
      variantId: 'custom',
      label: file,
      file,
      ...(custom.bytes !== undefined ? { bytes: custom.bytes } : {}),
      sources: custom.sources ?? [custom.url],
      dims: custom.dims,
      pooling: custom.pooling ?? 'auto',
      modelName: v.model ?? file.replace(/\.gguf$/i, ''),
      ...(v.flavor ?? state?.flavor ? { flavor: v.flavor ?? state?.flavor } : {}),
    }
  }
  // 配置 > 面板的记忆 > 用 model 字符串去清单里找 > 内置默认。
  const presetId = v.preset
    ?? state?.presetId
    ?? (findModel(v.model) !== undefined ? v.model           : DEFAULT_MODEL_ID)
  const model = findModel(presetId) ?? findModel(DEFAULT_MODEL_ID) 
  const variant = findVariant(model, v.variant ?? state?.variantId)
  return {
    presetId: model.id,
    variantId: variant.id,
    label: `${model.label} · ${variant.label}`,
    file: variant.file,
    bytes: variant.bytes,
    sources: [...variant.sources],
    dims: model.dims,
    pooling: model.pooling,
    modelName: v.model ?? model.id,
    ...(model.queryPrefix !== undefined ? { queryPrefix: model.queryPrefix } : {}),
    ...(model.documentPrefix !== undefined ? { documentPrefix: model.documentPrefix } : {}),
    ...(v.flavor ?? state?.flavor ? { flavor: v.flavor ?? state?.flavor } : {}),
  }
}

/**
 * 接管已装好的后端时,spawn 该用哪个模型文件。
 *
 * 坑:换模型时 `spawn.model` 可能还留着**上一个**模型的路径(显式配置或上次 adopt
 * 写进去的),而 dims/pooling 已经跟着新模型变了 —— 那会启动一个"模型与参数不匹配"
 * 的服务,而且不报错,只是检索质量悄悄变差。所以只有"配置的模型就是当前选中的那个"
 * 才沿用它,否则一律用刚落盘的那份。
 */
export function pickSpawnModel(currentFile        , configuredModel                    , installedModel        )         {
  if (configuredModel !== undefined && basename(configuredModel) === currentFile) return configuredModel
  return installedModel
}

export function resolveConfig(config                    = {})                 {
  const v = config.retrieval?.vector ?? {}
  // Do not touch an embedding backend the user never asked for: pointing at the
  // stock localhost endpoint on a machine that has nothing listening means
  // failed embeds, a tripped breaker and scary log lines for a feature that is
  // optional. Vector retrieval is therefore opt-in by CONFIGURATION — writing
  // `endpoint` (any OpenAI-compatible service), configuring `spawn`, or having
  // the panel's installer put a backend on disk implies intent; an explicit
  // `enabled` always wins.
  const storeDir = config.storeDir ?? '.dsh-memory'
  // Installer target: explicit config → that directory; explicit storeDir →
  // its parent (so a hand-made `<root>/llamacpp` + `<root>/models` layout is
  // recognised as-is); otherwise a stable per-user directory under ~/.dsh.
  const installRoot = v.autoInstall?.dir
    ?? (config.storeDir !== undefined ? dirname(resolve(storeDir)) : join(homedir(), '.dsh', 'memory-vector'))
  // 模型选择:自定义 → 显式 preset → 用 model 字符串去清单里找 → 内置默认。
  // 这一步必须在 detectInstalled 之前:安装判据是「exe + **所选模型的**文件」。
  const selection = resolveModelSelection(v, installRoot)
  const installed = detectInstalled(installRoot, selection.file)
  const endpointConfigured = v.endpoint !== undefined
  // A configured spawn path that no longer exists (plugin uninstalled the
  // backend, or the user moved it) must not count as configured: that would
  // leave the panel showing a managed server that can never start, instead of
  // offering the download button again.
  const spawnExe = v.spawn?.exe
  const spawnExeUsable = spawnExe === undefined || spawnExe === '' || existsSync(spawnExe)
  const spawnConfigured = ((v.spawn?.enabled === true || (spawnExe ?? '') !== '') && spawnExeUsable) || installed !== null
  const configured = endpointConfigured || spawnConfigured
  const vectorEnabled = v.enabled ?? configured
  const flavor = selection.flavor ?? 'cpu'
  // scopes.custom 既可能是布尔(简写)也可能是对象 —— 两种都要认,旧配置(只有
  // global/project 两个布尔)当然照常工作。
  const customCfg = config.scopes?.custom
  const customEnabled = typeof customCfg === 'boolean' ? customCfg : (customCfg?.enabled ?? true)
  const customMax = typeof customCfg === 'object' && customCfg !== null && typeof customCfg.max === 'number'
    ? customCfg.max
    : 200
  return {
    storeDir,
    globalEnabled: config.scopes?.global ?? true,
    projectEnabled: config.scopes?.project ?? true,
    sessionEnabled: config.scopes?.session ?? true,
    customEnabled,
    customMaxScopes: customMax,
    topK: config.retrieval?.topK ?? 5,
    recallN: config.retrieval?.recallN ?? 30,
    globalThreshold: config.retrieval?.globalThreshold ?? 0.12,
    projectThreshold: config.retrieval?.projectThreshold ?? 0.1,
    halfLifeDays: config.retrieval?.recencyHalfLifeDays ?? 30,
    vector: {
      enabled: vectorEnabled,
      configured,
      endpointConfigured,
      spawnConfigured,
      installRoot,
      ...(v.autoInstall?.modelSources ? { installModelSources: v.autoInstall.modelSources } : {}),
      installModel: {
        file: selection.file,
        ...(selection.bytes !== undefined ? { bytes: selection.bytes } : {}),
        ...(selection.sources.length > 0 ? { sources: selection.sources } : {}),
      },
      presetId: selection.presetId,
      variantId: selection.variantId,
      modelLabel: selection.label,
      pooling: v.pooling ?? selection.pooling,
      flavor,
      gpuLayers: v.gpuLayers ?? (flavor === 'cpu' || flavor === 'auto' ? 0 : 99),
      ...(selection.queryPrefix !== undefined ? { queryPrefix: selection.queryPrefix } : {}),
      ...(selection.documentPrefix !== undefined ? { documentPrefix: selection.documentPrefix } : {}),
      endpoint: v.endpoint ?? 'http://127.0.0.1:8078/v1/embeddings',
      model: v.model ?? selection.modelName,
      dims: v.dims ?? selection.dims,
      timeoutMs: v.timeoutMs ?? 300,
      // Full contents are orders of magnitude slower than a short query on CPU
      // (measured 3143ms for three ~600-char records), so write/backfill paths
      // get their own generous budgets instead of the interactive 300ms.
      writeTimeoutMs: v.writeTimeoutMs ?? 10_000,
      backfillTimeoutMs: v.backfillTimeoutMs ?? 30_000,
      backfillMaxChars: v.backfillMaxChars ?? 8_000,
      // BGE CLS baseline noise floor measured ~0.42 on unrelated pairs
      minScore: v.minScore ?? 0.5,
      backfillBatchSize: v.backfillBatchSize ?? 32,
      // Port defaults to the one in the embeddings endpoint so the two can never
      // drift apart; opt-in (enabled:false) keeps dev/test runs from spawning.
      // A backend the panel installed (or a hand-made one at installRoot) is
      // adopted as the spawn target when the user configured no explicit paths.
      spawn: {
        ...(v.spawn ?? {}),
        enabled: v.spawn?.enabled ?? installed !== null,
        ...(installed
          ? {
              exe: v.spawn?.exe ?? installed.exe,
              model: v.spawn?.model ?? installed.model,
              cwd: v.spawn?.cwd ?? installed.cwd,
              logFile: v.spawn?.logFile ?? installed.logFile,
            }
          : {}),
        // 模型自带 pooling 与 GPU 层数:llama-server 拿不到就是错的检索结果,
        // 所以跟着所选模型一起传下去(extraArgs 仍在最后,可覆盖)。
        pooling: v.pooling ?? selection.pooling,
        gpuLayers: v.gpuLayers ?? (flavor === 'cpu' || flavor === 'auto' ? 0 : 99),
        port: v.spawn?.port ?? portOf(v.endpoint ?? 'http://127.0.0.1:8078/v1/embeddings') ?? 8078,
      },
    },
    llm: {
      enabled: config.retrieval?.llm?.enabled ?? false,
      provider: config.retrieval?.llm?.provider ?? '',
      model: config.retrieval?.llm?.model ?? '',
      timeoutMs: config.retrieval?.llm?.timeoutMs ?? 1500,
      dailyBudgetTokens: config.retrieval?.llm?.dailyBudgetTokens ?? 200_000,
      weight: config.retrieval?.llm?.weight ?? 0.6,
      topN: config.retrieval?.llm?.topN ?? 10,
    },
    maxRecordsPerScope: config.limits?.maxRecordsPerScope ?? 2000,
    maxRecordChars: config.limits?.maxRecordChars ?? 4000,
    secrets: {
      enabled: config.secrets?.enabled ?? true,
      mode: config.secrets?.mode ?? 'refuse',
    },
  }
}

export class LocalMemoryService                             {
           cfg                
           store             
           embed             
          rerankBudget             
          rerankCache = new RerankCache()
  /** Host-provided one-shot LLM call; null = rerank disabled (recall order). */
          llmInvoke                   = null
  /** 写路径的默认口径(tools.defaultScope);'session' 拿不到会话时回退 project。 */
          defaultWriteScope                                   = 'session'
  /** 显式配置的项目 scope 键(未配置 = undefined,由 resolveCurrentScopes 按会话 cwd 决定)。 */
          projectScope                         
  /** 上次发现磁盘 scope 的时间(限流用;0 = 还没发现过)。 */
          discoveredAt = 0
  /** 作用域别名(project:<路径> → 显示名),落盘 <storeDir>/scopes.json。 */
          names            
  /** 注入设置(面板「设置」标签页可改;落盘在 <storeDir>/settings.json)。 */
          inject                
  /** 注入半边的审计收集器(可选;没有注入半边时保持 null)。 */
          injectAuditSink                                               = null

  constructor(config                    = {}) {
    this.cfg = resolveConfig(config)
    this.inject = this.loadInjectSettings((config                        ).inject)
    this.names = new ScopeNames(join(this.cfg.storeDir, 'scopes.json'))
    this.rerankBudget = new DailyBudget(this.cfg.llm.dailyBudgetTokens)
    this.store = new MemoryStore(this.cfg.storeDir, { onWarn: (m) => console.warn(`[dsh-memory-local] ${m}`) })
    // Identity BEFORE the eager load (issue #1): ScopeStore skips its sidecar
    // validation entirely while the identity is unset (`if (this.vecIdentity && …)`),
    // so loading first would accept vectors from a previous embedding model
    // whenever the dimensions matched — and the next flush would then rewrite the
    // header as the new model, making the mismatch permanent.
    this.store.setVecIdentity(this.cfg.vector.model, this.cfg.vector.dims)
    // 会话 scope 是按会话动态生成的,**不能**在这里 eager 加载(加载谁?);只预载
    // project 与 global 这两个稳定作用域。其余按需 peek/loadDiscovered。
    // eager 只加载"已存在"的 scope(peek),不会为不存在的 scope 建空文件。
    // 项目键此刻还看不到会话(没传 agent),所以这里只能预载"没有显式配置时的兜底键"
    // (= project:<process.cwd()>);真正的项目键在每次调用时按会话 cwd 解析。
    const eager                = []
    if (this.cfg.projectEnabled) eager.push(this.defaultProjectScope)
    if (this.cfg.globalEnabled) eager.push('global')
    for (const scope of eager) this.store.peek(scope)
    this.embed = new EmbedClient({
      endpoint: this.cfg.vector.endpoint,
      model: this.cfg.vector.model,
      dims: this.cfg.vector.dims,
      timeoutMs: this.cfg.vector.timeoutMs,
    })
    this.startMaintenance()
    this.startEmbedServer()
  }

  /** 设置文件:与记忆数据同目录,便于一起备份/清理。 */
  get settingsPath()         {
    return join(this.cfg.storeDir, 'settings.json')
  }

  /** 读取注入设置(归一化后的快照)。 */
  injectSettings()                 {
    return normalizeInjectSettings(this.inject, this.inject)
  }

  /** 注入半边注册审计收集器。重复注册时后一个覆盖前一个(激活重载)。 */
  attachInjectAudit(sink                                       )       {
    this.injectAuditSink = sink
  }

  /** 面板 /memory/api/audit 用:返回注入评估记录(最新在前);没有注入半边时为空。 */
  injectAudit(sessionId         )          {
    try { return this.injectAuditSink?.list(sessionId) ?? [] } catch { return [] }
  }

  /** 面板改设置:合并补丁 → 落盘 → 返回新值。写盘失败只告警,不影响运行中的设置。 */
  updateInjectSettings(patch         )                 {
    this.inject = mergeInjectSettings(this.inject, patch)
    try {
      mkdirSync(this.cfg.storeDir, { recursive: true })
      writeFileSync(this.settingsPath, `${JSON.stringify(this.inject, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.warn(`[dsh-memory-local] 无法写入注入设置 ${this.settingsPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return this.injectSettings()
  }

  /** 配置先给底,磁盘上的 settings.json 覆盖它;坏文件忽略而不是启动失败。 */
          loadInjectSettings(fromConfig         )                 {
    const base = normalizeInjectSettings(fromConfig)
    try {
      if (existsSync(this.settingsPath)) {
        const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8'))           
        const digest = (parsed                                               )?.digest
        // 0.9.5 及以前的默认 digest 预算是 400,且没有 hintBudget 字段。
        // 升级到 0.9.6 时把"旧默认值"迁到新默认 800;显式写过 hintBudget 的配置不动。
        const oldDigestDefault = digest !== undefined && digest !== null
          && typeof digest === 'object' && digest.hintBudget === undefined
          && Number(digest.tokenBudget) === 400
        const merged = mergeInjectSettings(base, parsed)
        if (oldDigestDefault) merged.digest.tokenBudget = base.digest.tokenBudget
        return merged
      }
    } catch (error) {
      console.warn(`[dsh-memory-local] 忽略损坏的注入设置 ${this.settingsPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return base
  }

  /**
   * 被其他记录 supersedes 指向的记录 id(=已退役)。scope 缺省时扫描全部已加载 scope。
   * 只读、不发现、不创建;注入半边/规则段/自动召回共用这一份口径。
   */
  supersededIds(scopes                )           {
    const ids = new Set        ()
    const stores = scopes === undefined
      ? this.store.allScopes()
      : scopes.map((scope) => this.store.peek(scope)).filter((s)                             => s !== undefined)
    for (const store of stores) {
      for (const record of store.records.values()) {
        if (typeof record.supersedes === 'string' && record.supersedes.length > 0) ids.add(record.supersedes)
      }
    }
    return [...ids]
  }

  /**
   * 同步列记录(只读、不触发磁盘发现)。系统提示里的「硬性规则」段每步都要
   * 渲染,必须是同步的;这里直接读已加载 scope 的内存快照。
   *
   * 默认排除已被 supersede 的旧记录;需要历史/审计时显式 includeSuperseded。
   */
  listSync(input                                                                                         = {})                 {
    const seen = new Set             ()
    const stores               = []
    for (const scope of input.scopes ?? []) {
      if (seen.has(scope)) continue
      seen.add(scope)
      const s = this.store.peek(scope)
      if (s) stores.push(s)
    }
    const retired = input.includeSuperseded ? new Set        () : new Set(this.supersededIds(input.scopes))
    const out                 = []
    for (const s of stores) {
      for (const rec of s.records.values()) {
        if (retired.has(rec.id)) continue
        if (input.kind !== undefined && rec.kind !== input.kind) continue
        out.push(rec)
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out.slice(0, input.limit ?? 100)
  }

  /** Own the embedding backend's lifetime: spawn on activation, stop on dispose. */          startEmbedServer()       {
    // Nothing configured and retrieval switched off → do not even build the
    // manager, so no probe, no spawn attempt, no misleading panel state.
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return
    this.embedServer = new EmbedServerManager(this.cfg.vector.spawn)
    // fire-and-forget: activation must never block on a model load
    void this.ensureEmbedServer(60_000).catch(() => { /* lifecycle never breaks activation */ })
  }

  /**
   * Start (or adopt) the embedding backend and arm the exit safety net.
   * Shared by the activation path and the panel's manual start button.
   */
          async ensureEmbedServer(waitMs         )                            {
    const mgr = this.embedServer
    if (!mgr) return 'disabled'
    const state = await mgr.ensureRunning()
    if (state !== 'spawned' && state !== 'adopted-managed') return state
    // hard-exit safety net: cordis disposal covers a clean quit; this covers
    // the host dying without disposing us (the child must not be orphaned)
    if (!this.exitHook) {
      this.exitHook = () => { this.embedServer?.stop() }
      process.once('exit', this.exitHook)
    }
    const ready = await mgr.waitUntilReady(waitMs)
    if (!ready) console.warn('[dsh-memory-local] embed server: 启动超时,检索继续走词法降级')
    return state
  }

  /** Manual start from the memory panel (same semantics as activation). */
  startEmbedServerManually()                            {
    return this.ensureEmbedServer(25_000)
  }

  /**
   * Manual stop from the memory panel. An instance we do not own is left alone
   * (it was started outside the app), so the UI can explain the refusal.
   */
  stopEmbedServerManually()                                                                                {
    const mgr = this.embedServer
    if (!mgr) return { stopped: false, reason: 'NOT_RUNNING' }
    if (!mgr.isOwned) return { stopped: false, reason: 'EXTERNAL_INSTANCE' }
    return { stopped: mgr.stop(), reason: mgr.isOwned ? 'NOT_RUNNING' : 'STOPPED' }
  }

  /**
   * Lifecycle snapshot for the memory panel.
   *
   * `mode` is what the panel needs to decide whether a start/stop switch even
   * makes sense:
   *   - 'off'      nothing configured → no switch, show how to opt in
   *   - 'external' we only know an endpoint (cloud or a server the user runs)
   *                → no switch, we must not claim ownership of that process
   *   - 'managed'  spawn is configured → the switch toggles OUR child process
   * `enabled` is the retrieval switch from config; when it is false while a
   * backend IS configured the panel explains the config instead of showing a
   * switch that cannot turn retrieval on.
   */
  async embedServerStatus()           
                    
                       
                                        
                    
                 
                                     
                      
                    
                     
                                      
                     
                
                        
                                  
                            
                  
                      
                   
                      
                         
                                                                   
                                                                               
                                                                                           
     {
    const mgr = this.embedServer
    const cfg = this.cfg.vector
    const pendingEmbeds = this.pendingEmbedCount
    const mode = !cfg.configured ? 'off' : cfg.spawnConfigured ? 'managed' : 'external'
    const usage = this.vectorInstallUsage()
    const base = {
      enabled: cfg.enabled,
      configured: cfg.configured,
      mode,
      endpoint: cfg.endpoint,
      model: cfg.model,
      modelLabel: cfg.modelLabel,
      presetId: cfg.presetId,
      variantId: cfg.variantId,
      modelFile: cfg.installModel.file,
      dims: cfg.dims,
      pooling: cfg.pooling,
      flavor: cfg.flavor,
      spawnConfigured: cfg.spawnConfigured,
      pendingEmbeds,
      install: this.installSnapshot(),
      maintenance: {
        usageBytes: usage.bytes,
        paths: usage.paths,
        // NOTE: `cfg` is the VECTOR config here, not the whole config — reading
        // cfg.storeDir would silently yield undefined (and JSON drops it).
        storeDir: this.cfg.storeDir,
        records: this.store.allScopes().reduce((n, s) => n + s.records.size, 0),
      },
    }         
    if (!mgr) return { ...base, owned: false, pid: null, baseUrl: '', reachable: false }
    const reachable = await mgr.healthCheck()
    return { ...base, ...mgr.info(), reachable, pendingEmbeds }
  }

  /** Installer state for the panel (idle when nothing was ever requested). */
          installSnapshot()                                                         {
    const root = this.cfg.vector.installRoot
    const modelFile = this.cfg.vector.installModel.file
    const installed = detectInstalled(root, modelFile) !== null
    const progress = this.installer?.progress ?? {
      phase: 'idle'         ,
      message: '',
      receivedBytes: 0,
      totalBytes: null,
      error: null,
      paths: installed ? installPaths(root, modelFile) : null,
    }
    return { ...progress, installed, root }
  }

  /**
   * 面板的"模型与硬件"报告:清单 + 当前选择 + 硬件 + 推荐。
   *
   * 硬件探测会 spawn 外部命令(Windows 上还有 PowerShell),所以**只在面板问的时候**跑,
   * 并且结果缓存 10 分钟 —— 绝不在插件激活路径上。
   */
  async modelsReport(force = false)           
                    
                                                                                 
                                                                                     
                                                                                                     
      
                                                                                                                                                                         
                                 
                                                            
                  
                   
     {
    const root = this.cfg.vector.installRoot
    const catalog = EMBEDDING_MODELS.map((model) => ({
      id: model.id,
      label: model.label,
      note: model.note,
      dims: model.dims,
      pooling: model.pooling,
      languages: model.languages,
      contextTokens: model.contextTokens,
      sizeBytes: variantBytes(model, this.cfg.vector.presetId === model.id ? this.cfg.vector.variantId : undefined),
      installed: model.variants.some((variant) => detectInstalled(root, variant.file) !== null),
      // 逐档判断"装没装":bge-m3 装了 Q4_K_M 不等于 Q8_0 也装了。
      // 判据与 detectInstalled 一致 —— 运行时 exe + 该档模型文件都在。
      variants: model.variants.map((variant) => ({
        id: variant.id, label: variant.label, bytes: variant.bytes, file: variant.file,
        installed: detectInstalled(root, variant.file) !== null,
      })),
    }))
    const records = this.store.allScopes().reduce((n, s) => n + s.records.size, 0)
    const locale = safeLocale()
    let hardware                      = null
    try {
      hardware = await this.hardwareSnapshot(force)
    } catch {
      hardware = null // 探测失败就只显示清单,不给推荐 —— 不猜
    }
    const recommendation = hardware === null
      ? null
      : recommendModel({ hardware, locale, recordCount: records, currentModelId: this.cfg.vector.presetId })
    return {
      catalog,
      current: {
        presetId: this.cfg.vector.presetId,
        variantId: this.cfg.vector.variantId,
        modelLabel: this.cfg.vector.modelLabel,
        file: this.cfg.vector.installModel.file,
        dims: this.cfg.vector.dims,
        pooling: this.cfg.vector.pooling,
        flavor: this.cfg.vector.flavor,
        model: this.cfg.vector.model,
      },
      hardware,
      recommendation,
      locale,
      records,
    }
  }

  /** 硬件探测结果缓存(默认 10 分钟),'auto' 风味与推荐共用它。 */
          async hardwareSnapshot(force = false)                        {
    const now = Date.now()
    if (!force && this.hardwareCache !== null && now - this.hardwareAt < 600_000) return this.hardwareCache
    const hw = await probeHardware({ dir: this.cfg.vector.installRoot })
    this.hardwareCache = hw
    this.hardwareAt = now
    return hw
  }

  /** 把 'auto' 风味解析成具体风味(需要探测;失败则退回 CPU)。 */
          async resolveFlavor()                         {
    const configured = this.cfg.vector.flavor
    if (configured !== 'auto') return configured
    try {
      return pickFlavor(await this.hardwareSnapshot())
    } catch {
      return 'cpu'
    }
  }

  /** 面板选了模型/风味之后,把选择写进安装目录的 state 文件并更新运行中的配置。 */
          applyModelSelection(override               )                         {
    const synthetic                    = override.custom !== undefined
      ? { customModel: override.custom }
      : { ...(override.preset !== undefined ? { preset: override.preset } : {}), ...(override.variant !== undefined ? { variant: override.variant } : {}) }
    const sel = resolveModelSelection(synthetic)
    const cfg = this.cfg.vector
    cfg.installModel = {
      file: sel.file,
      ...(sel.bytes !== undefined ? { bytes: sel.bytes } : {}),
      ...(sel.sources.length > 0 ? { sources: sel.sources } : {}),
    }
    cfg.presetId = sel.presetId
    cfg.variantId = sel.variantId
    cfg.modelLabel = sel.label
    cfg.pooling = sel.pooling
    cfg.dims = sel.dims
    cfg.model = sel.modelName
    cfg.spawn.pooling = sel.pooling
    if (override.flavor !== undefined) cfg.flavor = override.flavor
    cfg.spawn.gpuLayers = cfg.flavor === 'cpu' || cfg.flavor === 'auto' ? 0 : (cfg.spawn.gpuLayers || 99)
    writeModelState(cfg.installRoot, {
      presetId: sel.presetId === 'custom' ? undefined : sel.presetId,
      variantId: sel.variantId === 'custom' ? undefined : sel.variantId,
      ...(override.custom !== undefined ? { customModel: override.custom } : {}),
      ...(override.flavor !== undefined ? { flavor: override.flavor } : {}),
    })
    return cfg.flavor
  }

  /**
   * Panel action: download llama.cpp + the GGML model into installRoot, then
   * adopt them (start the managed server). Never runs on its own — a fresh
   * install downloads nothing until the user asks.
   *
   * `override` 是面板的选择(预设/档位/自定义 URL/风味):它会先落进安装目录的
   * state 文件(下次启动仍然生效),再按新选择下载。配置里写了 preset/customModel
   * 的话,配置永远优先 —— state 只是"面板选过什么"的记忆。
   */
  installVectorBackend(override                = {})       {
    const flavor = this.applyModelSelection(override)
    const model = this.cfg.vector.installModel
    if (detectInstalled(this.cfg.vector.installRoot, model.file)) {
      this.adoptInstalledBackend()
      return
    }
    // 换模型时把上一个安装器的进度丢掉:它描述的是另一个文件。
    this.installer?.cancel()
    this.installer = new VectorInstaller({
      root: this.cfg.vector.installRoot,
      model: { file: model.file, ...(model.bytes !== undefined ? { bytes: model.bytes } : {}), ...(model.sources !== undefined ? { sources: model.sources } : {}) },
      ...(flavor === 'auto' ? {} : { flavor }),
      ...(this.cfg.vector.installModelSources && model.sources === undefined ? { modelSources: this.cfg.vector.installModelSources } : {}),
      onProgress: (progress) => {
        if (progress.phase === 'done') this.adoptInstalledBackend()
      },
    })
    this.installer.start()
  }

  /** Panel action: abort an in-flight download. */
  cancelVectorInstall()       {
    this.installer?.cancel()
  }

  /**
   * What the installer put on disk, so the panel can say "释放 xxx MB" before
   * offering to remove it. Counts only our own layout (runtime dir, models dir,
   * log + pid), never the memory store.
   */
  vectorInstallUsage()                                     {
    const paths = installPaths(this.cfg.vector.installRoot, this.cfg.vector.installModel.file)
    const roots = [paths.dir, join(this.cfg.vector.installRoot, 'models')]
    const files = [paths.logFile, `${paths.logFile}.pid`, `${paths.logFile}.err`]
    let bytes = 0
    const seen           = []
    for (const p of [...roots, ...files]) {
      if (!existsSync(p)) continue
      seen.push(p)
      bytes += pathSize(p)
    }
    return { bytes, paths: seen }
  }

  /**
   * Remove the vector backend we installed (runtime + model + logs).
   *
   * Refuses when the configured backend lives outside installRoot: that is a
   * server the user installed and manages, and deleting it would be destroying
   * something we never created. The memory store is never touched — it lives
   * beside the runtime, not inside it.
   */
  uninstallVectorBackend()   
                    
                                                            
                      
                   
    {
    const root = this.cfg.vector.installRoot
    const configuredExe = this.cfg.vector.spawn.exe
    if (configuredExe && !isInside(root, configuredExe)) {
      return { removed: false, reason: 'EXTERNAL_BACKEND', freedBytes: 0, paths: [] }
    }
    const usage = this.vectorInstallUsage()
    if (usage.paths.length === 0) {
      return { removed: false, reason: 'NOT_INSTALLED', freedBytes: 0, paths: [] }
    }
    // Stop our child first: on Windows the executable and its DLLs are locked
    // while it runs, so removal would fail with EBUSY/EPERM.
    try { this.embedServer?.stop() } catch { /* best effort */ }
    const removedPaths           = []
    for (const p of usage.paths) {
      // Belt and braces: never step outside the install root, and never delete
      // the memory store even if someone pointed storeDir inside it.
      if (!isInside(root, p)) continue
      if (isInside(p, this.cfg.storeDir) || resolve(p) === resolve(this.cfg.storeDir)) continue
      try {
        rmSync(p, { recursive: true, force: true })
        removedPaths.push(p)
      } catch { /* leave it; the panel reports what went */ }
    }
    this.cfg.vector.configured = false
    this.cfg.vector.spawnConfigured = false
    this.cfg.vector.enabled = false
    this.embedServer = null
    return { removed: true, reason: 'REMOVED', freedBytes: usage.bytes, paths: removedPaths }
  }

  /**
   * Delete every memory record in every scope (the panel's "delete all data"
   * action, used when someone wants the plugin gone without leaving notes
   * behind). Goes through the store so the JSONL + vector sidecars stay
   * consistent instead of ripping files out from under a live store.
   */
  wipeAllRecords()                                        {
    let removed = 0
    const scopes           = []
    for (const scope of this.store.allScopes()) {
      const ids = [...scope.records.keys()]
      if (ids.length === 0) continue
      let local = 0
      for (const id of ids) if (scope.remove(id)) local += 1
      removed += local
      scopes.push(scope.scope)
    }
    try { this.store.flushSync() } catch { /* scheduled flush covers it */ }
    return { removed, scopes }
  }

  /**
   * Switch the provider over to a backend that is now on disk: fill the spawn
   * config from the installed layout and start it. Idempotent.
   */
          adoptInstalledBackend()       {
    const paths = detectInstalled(this.cfg.vector.installRoot, this.cfg.vector.installModel.file)
    if (!paths) return
    this.cfg.vector.configured = true
    this.cfg.vector.spawnConfigured = true
    this.cfg.vector.enabled = true
    this.cfg.vector.spawn = {
      ...this.cfg.vector.spawn,
      enabled: true,
      exe: this.cfg.vector.spawn.exe ?? paths.exe,
      // 模型路径必须跟着**当前选择的模型**:换了模型就不能继续用上一个的文件(见 pickSpawnModel)。
      model: pickSpawnModel(this.cfg.vector.installModel.file, this.cfg.vector.spawn.model, paths.model),
      cwd: this.cfg.vector.spawn.cwd ?? paths.cwd,
      logFile: this.cfg.vector.spawn.logFile ?? paths.logFile,
      pooling: this.cfg.vector.pooling,
      gpuLayers: this.cfg.vector.flavor === 'cpu' || this.cfg.vector.flavor === 'auto' ? 0 : (this.cfg.vector.spawn.gpuLayers || 99),
      port: this.cfg.vector.spawn.port,
    }
    if (!this.embedServer) {
      this.startEmbedServer()
      return
    }
    void this.ensureEmbedServer(60_000).catch(() => { /* panel shows the outcome */ })
  }

  /**
   * Hourly expired-record purge + capacity eviction. M4 housekeeping; the
   * timer is unref'd so it never holds the process open, and cleared by
   * flushSync()/dispose.
   */
          maintenanceTimer                                        = null

          startMaintenance()       {
    this.maintenanceTimer = setInterval(() => {
      this.store.purgeExpired()
      this.store.enforceLimit(this.cfg.maxRecordsPerScope)
      this.store.scheduleFlush(0)
    }, 3_600_000)
    this.maintenanceTimer.unref?.()
    // Pending-embed drain: the store queues ids whose embed failed (backend
    // down at save time, or vectors restored from a jsonl-only backup). Until
    // this timer existed nothing ever drained that queue — a single outage
    // stranded them forever (observable as 待嵌入>0 in the memory panel).
    this.embedRetryTimer = setInterval(() => {
      void this.retryPendingEmbeds().catch(() => {})
    }, 60_000)
    this.embedRetryTimer.unref?.()
    // First drain shortly after boot, when the backend is usually already up.
    const initial = setTimeout(() => {
      this.initialDrainTimer = null
      void this.retryPendingEmbeds().catch(() => {})
    }, 5_000)
    initial.unref?.()
    this.initialDrainTimer = initial
  }

          embedRetryTimer                                        = null
          initialDrainTimer                                       = null
  /** Owns the llama-server child process when vector.spawn.enabled. */
          embedServer                            = null
  /** Lazily created by the panel's "download and configure" action. */
          installer                         = null
  /** 硬件探测缓存(面板问了才探测,10 分钟内复用)。 */
          hardwareCache                      = null
          hardwareAt = 0
          exitHook                      = null

  /**
   * Drain the pending-embed queue, probing through the circuit breaker first so
   * a backend that came back online is noticed (backfillEmbeddings itself
   * refuses to touch the network while marked unhealthy, and embed() is the
   * only path that can flip that flag back to healthy).
   */
  async retryPendingEmbeds()                  {
    // Vector retrieval opt-in: with no configured backend there is nothing to
    // retry, and probing would only produce failed requests in the log.
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return 0
    // Scopes load lazily, so without discovery the queue of an untouched scope
    // (e.g. a project store written by a previous session) is invisible here and
    // would never drain — exactly the 待嵌入>0 the panel showed on 2026-10-10.
    try { this.store.loadDiscovered() } catch { /* discovery is best-effort */ }
    if (this.pendingEmbedCount === 0) return 0
    if (!this.embed.isHealthy) {
      const probe = await this.embed.embed(['ping'], undefined, { timeoutMs: this.cfg.vector.writeTimeoutMs }).catch(() => null)
      if (!probe) return 0
    }
    return this.backfillAll({ throttleMs: 100 })
  }

  /**
   * 写路径默认 scope 口径(tools.defaultScope 取值)。
   * 兼容:旧调用方传的是**具体 scope 键**(如 'project:<cwd>'),此时按"固定项目"处理。
   */
  setDefaultScope(scope                                                )       {
    if (scope === 'session' || scope === 'project' || scope === 'global') {
      this.defaultWriteScope = scope
      return
    }
    this.defaultWriteScope = 'project'
    this.projectScope = scope               
  }

  /** 固定项目 scope(只有**显式配置**才调);缺省由会话 cwd 决定。 */
  setProjectScope(scope             )       {
    this.projectScope = scope
  }

  /**
   * 拿不到会话时的项目键:显式配置优先,否则 `project:<process.cwd()>`
   * (用于构造期预载、以及任何没有 agent 上下文的兜底读写)。
   */
          get defaultProjectScope()              {
    return (this.projectScope ?? `project:${process.cwd()}`)               
  }

  /**
   * Provide the one-shot LLM caller used by the rerank stage. Passing null
   * (or never calling) keeps retrieval on recall-order only. The cordis
   * wiring adapts `ctx.llm` into this; it is optional by design — the service
   * must never sit PENDING just because no LLM adapter is loaded.
   */
  setLlmInvoke(invoke                  )       {
    this.llmInvoke = invoke
  }

  /** 写路径默认口径('session' | 'project' | 'global')。 */
  get activeDefaultScope()                                   {
    return this.defaultWriteScope
  }

  /**
   * 当前项目键(诊断/测试用)。没有会话时就是兜底键 —— 真实调用请用 `scopeRefs(agent)`,
   * 那里的优先级是 会话 cwd > 显式配置 > process.cwd()。
   */
  get activeProjectScope()              {
    return this.defaultProjectScope
  }

          assertScopeAllowed(scope             )       {
    if (scope === 'global') {
      if (!this.cfg.globalEnabled) throw memoryError('SCOPE_DISABLED', 'global scope is disabled by configuration')
      return
    }
    if (scope.startsWith('project:')) {
      if (!this.cfg.projectEnabled) throw memoryError('SCOPE_DISABLED', 'project scope is disabled by configuration')
      return
    }
    if (scope.startsWith('session:')) {
      if (!this.cfg.sessionEnabled) throw memoryError('SCOPE_DISABLED', 'session scope is disabled by configuration')
      return
    }
    if (!this.cfg.customEnabled) throw memoryError('SCOPE_DISABLED', 'custom scopes are disabled by configuration')
  }

  /**
   * scopes.custom.max 只统计**新建**的自定义 scope,而且只统计自定义的
   * (会话 / project / global 既不计入也不受限)。
   *
   * 计数走 `store.customScopeCount()`,它会顺带扫一遍磁盘 —— 只在"内存里的已加载数已经触到
   * 上限"时才真扫,否则直接放行,避免每次保存都读一遍 projects/ 目录。
   */
          assertCustomScopeBudget(scope             )       {
    if (!isCustomScope(scope)) return
    if (this.store.peek(scope) !== undefined) return // 已存在(内存或磁盘)→ 写入不受限
    const loaded = this.store.allScopes().filter((s) => isCustomScope(s.scope)).length
    if (loaded < this.cfg.customMaxScopes && this.store.customScopeCount() < this.cfg.customMaxScopes) return
    throw memoryError(
      'SCOPE_LIMIT',
      `custom scope limit reached (${this.cfg.customMaxScopes}); reuse an existing scope instead. ${this.scopeInventory(5)}`,
    )
  }

  /** 作用域清单(名字 + 条数),给 SCOPE_LIMIT 之类的错误提示用。 */
  scopeInventory(limit = 20)         {
    const scopes = this.scopeStats()
    const lines = scopes.slice(0, limit).map((s) => `${s.scope}(${s.records})`)
    const rest = scopes.length - lines.length
    return rest > 0 ? `${lines.join(', ')}, …另有 ${rest} 个` : lines.join(', ')
  }

  /**
   * 写路径的 scope 解析:agent 上下文 → 当前会话 / 当前项目;模型省略 scope 时按
   * `tools.defaultScope`(默认 'session')落点。拿不到会话信息就回退 project,**不抛错**。
   */
  resolveWriteScope(agent         , requested         )              {
    const refs = this.scopeRefs(agent)
    const want = requested?.trim()
    if (want === undefined || want === '' || want.toLowerCase() === 'session') {
      // scopes.session 关掉时"当前会话"不存在:按 defaultScope 口径回退(默认口径是
      // session 而会话被关 → project),而不是让写撞上 SCOPE_DISABLED。
      const session = this.cfg.sessionEnabled ? refs.session : undefined
      return writeScopeForDefault(this.defaultWriteScope, { ...refs, session })
    }
    if (want.toLowerCase() === 'project') return refs.project
    if (want.toLowerCase() === 'global') return 'global'
    return requested                // 具体键(project:/session:/自定义名)由工具层 normalize 后传入
  }

  /** agent 上下文 → { session?, project }(会话能否用由调用方按 scopes.session 决定)。 */
  scopeRefs(agent         )                                                  {
    return resolveCurrentScopes(agent, { projectScope: this.projectScope })
  }

  /**
   * 当前项目 key(= `scopeRefs(agent).project`)。工具层用它解析 `scope:'project'`,保证与服务端
   * 读/写口径**同一处** —— 0.5.5 及以前工具层自己算了一份 `project:<process.cwd()>`,于是同一个
   * 概念在两个层各有各的答案。
   */
  projectKeyFor(agent         )              {
    return this.scopeRefs(agent).project
  }

  /**
   * 无显式 scope 时的**读取**合并集合:当前会话 + 当前项目 + global(各自开关生效、按 key 去重)。
   * 工具 / 注入都用它,保证"写进会话的东西,默认读得回来"。
   */
  resolveReadScopes(agent         )                {
    const refs = this.scopeRefs(agent)
    const out                = []
    const push = (scope                         , enabled         )       => {
      if (scope === undefined || !enabled || out.includes(scope)) return
      out.push(scope)
    }
    push(refs.session, this.cfg.sessionEnabled)
    push(refs.project, this.cfg.projectEnabled)
    push('global', this.cfg.globalEnabled)
    return out
  }

  async save(input                 )                        {
    // 省略 scope 时按当前会话落点 —— 会话上下文必须**从调用方带进来**
    // (工具 handler 拿得到 exec.agent,provider 自己看不到)。
    const requestedScope = input.scope ?? this.resolveWriteScope((input                                         ).agent)
    const scope = this.canonicalScope(requestedScope)
    this.assertScopeAllowed(scope)
    // 0.7.0:项目作用域可以带一个显示名(别名)。同一路径同名幂等,不同路径同名拒绝。
    const requestedName = (input                                        ).name
    if (requestedName !== undefined && requestedName !== null && String(requestedName).trim() !== '') {
      if (!scope.startsWith('project:')) {
        throw memoryError('SCOPE_NAME_UNSUPPORTED', '只有项目作用域支持重命名(需要 path 或 project:<路径>)')
      }
      this.names.claim(scope, String(requestedName))
    }
    // 自定义 scope 的**新建**受 scopes.custom.max 限制;写已存在的 scope 不受限。
    this.assertCustomScopeBudget(scope)
    let content = input.content?.trim()
    if (!content) throw memoryError('CONTENT_EMPTY', 'content must be a non-empty string')
    if (content.length > this.cfg.maxRecordChars) {
      throw memoryError('CONTENT_TOO_LONG', `content exceeds ${this.cfg.maxRecordChars} chars`)
    }
    if (input.supersedes && !this.store.scope(scope).records.get(input.supersedes)) {
      throw memoryError('SUPERSEDES_UNKNOWN', `supersedes target ${input.supersedes} not found in ${scope}`)
    }
    // design §11: keep credentials out of the plaintext store and the embedder
    if (this.cfg.secrets.enabled) {
      const findings = scanSecrets(content)
      if (findings.length > 0) {
        if (this.cfg.secrets.mode === 'refuse') {
          throw memoryError('SECRET_DETECTED', `content matches credential denylist: ${[...new Set(findings.map((f) => f.kind))].join(', ')}`)
        }
        content = redactSecrets(content)
      }
    }
    const { record } = this.store.save(
      { ...input, scope, content },
      { importance: input.source?.origin === 'auto' ? 0.4 : 0.8, source: { origin: 'explicit' } },
    ) 
    void this.embedRecord(record).catch(() => {})
    this.store.scheduleFlush()
    return record
  }

          async embedRecord(record              )                {
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return
    const s = this.store.scope(record.scope)
    // save-time budget: one full record, much slower than a search query
    // 记录按"文档"嵌入:有些模型(nomic/e5)要求文档与查询带不同前缀,不带质量会掉。
    const vec = await this.embed.embed([`${this.cfg.vector.documentPrefix ?? ''}${record.content}`], undefined, { timeoutMs: this.cfg.vector.writeTimeoutMs }).catch(() => null)
    if (vec?.[0]) s.appendVector(record.id, normalizeInPlace(vec[0]))
    else s.embedPending.add(record.id) // backfill queue; the retry timer drains it
  }

  /**
   * Retry pending embeddings in batches; returns number embedded.
   * Batches are bounded by count AND total characters, and use the backfill
   * budget: full record contents on CPU take seconds per batch, so the
   * interactive timeout would abort every attempt.
   */
  async backfillEmbeddings()                  {
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return 0
    if (!this.embed.isHealthy) return 0
    let done = 0
    for (const s of this.store.allScopes()) {
      if (s.embedPending.size === 0) continue
      const texts           = []
      const valid           = []
      let chars = 0
      for (const id of s.embedPending) {
        if (valid.length >= this.cfg.vector.backfillBatchSize) break
        const t = s.records.get(id)?.content
        if (!t) continue
        if (valid.length > 0 && chars + t.length > this.cfg.vector.backfillMaxChars) break
        texts.push(`${this.cfg.vector.documentPrefix ?? ''}${t}`)
        valid.push(id)
        chars += t.length
      }
      if (texts.length === 0) continue
      const vecs = await this.embed.embed(texts, undefined, { timeoutMs: this.cfg.vector.backfillTimeoutMs }).catch(() => null)
      if (!vecs) return done
      for (let i = 0; i < valid.length; i++) {
        if (s.records.has(valid[i] ) && vecs[i]) s.appendVector(valid[i] , normalizeInPlace(vecs[i] ))
        s.embedPending.delete(valid[i] )
        done++
      }
    }
    return done
  }

  /**
   * 编辑之后立即重建**这一条**的向量，不等 60s 的回填窗口。
   * 旧向量同时从内存与磁盘作废（vectorsDirty），失败则留在 pending 里由重试兜底 ——
   * 绝不能让"新内容 + 旧向量"在重启后被当成已嵌入。
   */
  async reindexRecord(scope             , id        )                   {
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return false
    const s = this.store.peek(scope)
    const record = s?.records.get(id)
    if (!s || !record) return false
    s.vectors.delete(id)
    s.vectorsDirty = true
    s.embedPending.add(id)
    try {
      await this.embedRecord(record)
    } catch { /* 失败留给重试定时器 */ }
    if (!s.vectors.has(id)) return false
    s.embedPending.delete(id)
    this.store.scheduleFlush()
    return true
  }

  /**
   * 作废全部向量并按当前模型重新嵌入。给"换模型残留了旧向量 / 怀疑向量有问题"用:
   * 同步部分只清空 + 排队,真正的重嵌在后台跑(别让 HTTP 等几分钟)。
   * 返回排队条数;进度由面板的「待嵌入」计数与自动刷新体现。
   */
  reindexAll()                                    {
    if (!this.cfg.vector.enabled || !this.cfg.vector.configured) return { total: 0, queued: this.pendingEmbedCount }
    this.discoverScopes()
    let total = 0
    for (const s of this.store.allScopes()) {
      for (const id of s.records.keys()) {
        s.vectors.delete(id)
        s.embedPending.add(id)
        total += 1
      }
      s.vectorsDirty = true
      s.dirty = true
    }
    this.store.scheduleFlush()
    void this.backfillAll({ throttleMs: 50 }).catch(() => { /* 失败留给 60s 重试 */ })
    return { total, queued: this.pendingEmbedCount }
  }

  /**
   * First-fill: embed the ENTIRE backlog (unlike backfillEmbeddings' single
   * batch per scope), in throttled batches so a big import does not hammer
   * llama-server or block the caller. Yields to the event loop between
   * batches and stops early on abort/unhealthy embedder.
   */
  async backfillAll(opts                                                = {})                  {
    const throttle = opts.throttleMs ?? 50
    let done = 0
    while (!opts.signal?.aborted) {
      const n = await this.backfillEmbeddings()
      done += n
      if (n === 0) break // per-scope batch was empty → backlog drained
      if (!this.embed.isHealthy) break
      await new Promise((r) => setTimeout(r, throttle))
    }
    return done
  }

  async search(query             )                       {
    // 多 scope 合并由调用方显式给出(工具层传"会话 + 项目 + global");宿主类型里的
    // MemoryQuery 只有单值 scope,所以这里按结构化读一次可选数组,保持原语义不变。
    const queryScopes = (query                                            ).scopes
    const topK = query.topK ?? this.cfg.topK
    const recallN = query.recallN ?? this.cfg.recallN
    const now = Date.now()
    const queryTokens = [...new Set(tokenize(query.text))]

    // 候选 scope:显式 pin(单值)优先;否则用调用方给的合并集合(query.scopes,
    // 工具 / 注入传"会话 + 项目 + global");两者都没有才退回旧的 project + global。
    // `peek` 而不是 `scope`:读路径不创建,不存在的 scope 直接跳过。
    const wanted                = (query.scope
      ? [query.scope]
      : (queryScopes ?? []).length > 0
        ? queryScopes 
        : [this.defaultProjectScope, 'global']).map((scope) => this.canonicalScope(scope))
    const stores                                                                 = []
    const seen = new Set             ()
    for (const scope of wanted) {
      if (seen.has(scope)) continue // 按 scope key 去重(也顺手消掉 defaultScope==='global' 时的重复 push)
      seen.add(scope)
      const store = this.store.peek(scope)
      if (!store) continue
      stores.push({ store, scope, isGlobal: scope === 'global' })
    }

    // --- channel 1: lexical recall, scored per scope with local IDF ---
                                                                                
    const candidates = new Map              ()
    for (const { store, isGlobal } of stores) {
      const all = [...store.records.values()]
      const tokenSets = all.map((r) => new Set(tokenize(r.content)))
      const stats = buildStats(tokenSets)
      for (let i = 0; i < all.length; i++) {
        const rec = all[i] 
        if (rec.expiredAt && rec.expiredAt < now) continue
        const lex = lexicalScore(queryTokens, tokenSets[i] , stats)
        if (lex <= 0) continue
        // Weak-only overlap (no shared word/bigram) must clear the "real hit"
        // floor, not the permissive threshold — kills single-char collisions.
        // 阈值只分两档:global 用 globalThreshold,其余(session / project / 自定义)用
        // projectThreshold —— 不新增配置项。
        const floor = isGlobal ? this.cfg.globalThreshold : this.cfg.projectThreshold
        const effective = hasStrongHit(queryTokens, tokenSets[i] ) ? floor : Math.max(floor, REAL_HIT_FLOOR)
        if (lex < effective) continue
        candidates.set(rec.id, { record: rec, recallScore: lex, isGlobal })
      }
    }

    // --- channel 2: vector recall over embedded records ---
    // Skipped entirely when no backend is configured (lexical recall above
    // already produced the candidates; a request here would just fail).
    const qvec = this.cfg.vector.enabled && this.cfg.vector.configured
      ? await this.embed.embed([`${this.cfg.vector.queryPrefix ?? ''}${query.text}`], query.signal).catch(() => null)
      : null
    if (qvec?.[0]) {
      const vectorScores = new Map                ()
      for (const { store } of stores) {
        for (const [id, vec] of store.vectors) {
          if (!store.records.has(id)) continue
          const sim = cosine(qvec[0] , vec)
          if (sim >= this.cfg.vector.minScore) vectorScores.set(id, sim)
        }
      }
      for (const [id, sim] of vectorScores) {
        const existing = candidates.get(id)
        if (existing) {
          existing.recallScore = Math.max(existing.recallScore, sim) // best channel wins
        } else {
          const rec = this.findById(id)
          if (rec && !(rec.expiredAt && rec.expiredAt < now)) {
            if (!(rec.scope === 'global' && sim < this.cfg.globalThreshold)) {
              candidates.set(id, { record: rec, recallScore: sim, isGlobal: rec.scope === 'global' })
            }
          }
        }
      }
    }

    // shape with recency/importance, sort, cut
    const supersededIds = new Set        ()
    for (const { store } of stores) {
      for (const r of store.records.values()) if (r.supersedes) supersededIds.add(r.supersedes)
    }
    const shape = (c      )         =>
      recordScore(c.recallScore, c.record.importance, c.record.accessCount, c.record.lastAccessedAt, {
        now,
        halfLifeDays: this.cfg.halfLifeDays,
        superseded: supersededIds.has(c.record.id),
      })

    // 稳定 tie-break:同分时 session > project > 自定义 > global,再同分按 record id ——
    // 否则 Map 的插入顺序(取决于 scope 顺序)会让同一查询在不同进程间给出不同结果。
    const ranked = [...candidates.values()]
      .sort((a, b) => shape(b) - shape(a)
        || scopeTier(a.record.scope) - scopeTier(b.record.scope)
        || a.record.id.localeCompare(b.record.id))
      .slice(0, recallN)

    // --- channel 3: LLM rerank (optional; any skip/failure keeps recall order) ---
    const finalScores = new Map                (ranked.map((c) => [c.id, shape(c)]))
    if (this.cfg.llm.enabled && this.llmInvoke && ranked.length >= 2) {
      const asCands = ranked.map((c) => ({ id: c.id, content: c.record.content, recallScore: finalScores.get(c.id)  }))
      const cacheKey = RerankCache.key(query.text, ranked.map((c) => c.id), this.cfg.llm.model)
      let outcome = this.rerankCache.get(cacheKey)
      if (!outcome) {
        outcome = await rerank({
          invoke: this.llmInvoke,
          cfg: this.cfg.llm,
          query: query.text,
          candidates: asCands,
          budget: this.rerankBudget,
          signal: query.signal,
        })
        if (outcome) this.rerankCache.set(cacheKey, outcome)
      }
      if (outcome) {
        for (const { id, score } of blendScores(asCands, outcome, this.cfg.llm.weight)) {
          finalScores.set(id, score)
        }
      }
    }

    const hits              = ranked.map((c) => ({ record: touch(c.record), score: round4(finalScores.get(c.id) ) }))

    this.store.scheduleFlush()
    return hits.slice(0, topK)
  }

          findById(id        )                           {
    for (const s of this.store.allScopes()) {
      const r = s.records.get(id)
      if (r) return r
    }
    return undefined
  }

  async forget(input                                                                              )                                              {
    const ids           = []
    if (input.id) {
      // 按 id 删除天然跨 scope:调用方给的是精确 id,不存在误删别的 scope 的风险。
      for (const s of this.store.allScopes()) {
        if (s.remove(input.id)) ids.push(input.id)
      }
      if (ids.length === 0) throw memoryError('RECORD_NOT_FOUND', `id ${input.id} not found`)
    } else if (input.query) {
      // 按 query 删除的默认范围由工具层显式给出(默认只有当前会话);这里不再回退到
      // provider 的默认 scope —— 那正是"以为删了会话记忆、其实删了 global"的来源。
      const targets = (input.scope !== undefined
        ? [input.scope]
        : (input.scopes ?? []).length > 0
          ? input.scopes 
          : [this.defaultProjectScope]).map((scope) => this.canonicalScope(scope))
      const seen = new Set             ()
      for (const scope of targets) {
        if (seen.has(scope)) continue
        seen.add(scope)
        const store = this.store.peek(scope) // 读/删路径不创建
        if (!store) continue
        const hit = this.store.findIdsByQuery(scope, input.query)
        for (const id of hit) if (store.remove(id)) ids.push(id)
      }
      if (ids.length === 0) throw memoryError('RECORD_NOT_FOUND', `no record matching query in ${targets.join(', ')}`)
    } else {
      throw memoryError('RECORD_NOT_FOUND', 'forget requires id or query')
    }
    this.store.scheduleFlush()
    return { removed: ids.length, ids }
  }

  /**
   * 列记录。显式 scope 只列它;`scopes` 数组用于"全部作用域";两者都没有时退回项目 scope。
   * 一律走 `peek`,所以列一个不存在的 scope 只会得到空数组,不会造出文件。
   */
  async list(input                  = {})                          {
    const wanted = (input.scope !== undefined
      ? [input.scope]
      : (input.scopes ?? []).length > 0
        ? input.scopes 
        : [this.defaultProjectScope]).map((scope) => this.canonicalScope(scope))
    const seen = new Set             ()
    let records                 = []
    for (const scope of wanted) {
      if (seen.has(scope)) continue
      seen.add(scope)
      const store = this.store.peek(scope)
      if (store) records.push(...store.records.values())
    }
    if (input.kind) records = records.filter((r) => r.kind === input.kind)
    records.sort((a, b) => b.updatedAt - a.updatedAt)
    return records.slice(0, input.limit ?? 50)
  }

  /**
   * 按 id 批量取记录(memory_get)。接受完整 id,也接受摘要里给出的前 8 位前缀
   * (前缀命中多条时全部返回,由调用方/模型自行判断)。取全文不需要再检索。
   */
  getByIds(ids          )                 {
    this.discoverScopes()
    const scopes = this.store.allScopes()
    const out                 = []
    const seen = new Set        ()
    for (const token of ids) {
      if (typeof token !== 'string' || token.length === 0) continue
      for (const s of scopes) {
        for (const rec of s.records.values()) {
          if (seen.has(rec.id)) continue
          if (rec.id === token || rec.id.startsWith(token)) {
            seen.add(rec.id)
            out.push(rec)
          }
        }
      }
    }
    return out
  }

  /**
   * 面板新建一条记忆 / 规则。scope 必须是**明确的键**(global / project:<路径> /
   * session:<id> / 自定义名)—— 面板拿不到会话上下文,'project'/'session' 这种
   * 相对写法没法解析,直接拒绝比猜一个错的强。
   */
  async createRecord(input   
                  
                 
                    
                   
                       
   )                        {
    const normalized = normalizeScopeInput(input.scope)
    if (!normalized.ok) throw memoryError('SCOPE_INVALID', normalized.message)
    if (normalized.scope === undefined) {
      throw memoryError('SCOPE_INVALID', '面板写入需要明确的 scope(global / project:<路径> / session:<id> / 自定义名)')
    }
    return this.save({
      scope: normalized.scope               ,
      kind: (input.kind ?? 'note')                        ,
      content: String(input.content ?? ''),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
    })
  }

  /**
   * 导出全部记忆为**纯文本**文档(不含向量)。向量在导入时按当前模型重新算,
   * 所以换过模型也照样导得回去。
   */
  exportAll(now = Date.now())   
              
                      
                    
                        
                  
                     
                    
                        
                       
                       
      
    {
    this.discoverScopes()
    const records = []
    for (const s of this.store.allScopes()) {
      for (const rec of s.records.values()) {
        records.push({
          scope: rec.scope,
          kind: rec.kind,
          content: rec.content,
          tags: rec.tags,
          importance: rec.importance,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
        })
      }
    }
    records.sort((a, b) => a.scope.localeCompare(b.scope) || a.createdAt - b.createdAt)
    return { version: 1, exportedAt: now, records }
  }

  /**
   * 导入文本记忆。逐条走 `save()`(凭据扫描 / 上限 / 去重 / 向量回填都在那条路上),
   * 所以导入的记录会自动按当前模型重新嵌入。返回计数,失败不中断其余条目。
   */
  async importRecords(input         )                                                                                     {
    const list = Array.isArray(input)
      ? input
      : (input && typeof input === 'object' && Array.isArray((input                         ).records))
        ? (input                          ).records
        : null
    if (list === null) throw memoryError('IMPORT_INVALID', '导入格式不对:需要 {version, records:[...]} 或记录数组')
    if (list.length > 5000) throw memoryError('IMPORT_TOO_LARGE', `一次最多导入 5000 条(收到 ${list.length} 条)`)

    let imported = 0
    let skipped = 0
    let rejected = 0
    const errors           = []
    for (const [index, raw] of list.entries()) {
      try {
        const rec = raw                                                                                                
        const content = typeof rec.content === 'string' ? rec.content : ''
        if (content.trim().length === 0) throw new Error('content 为空')
        const normalized = normalizeScopeInput(typeof rec.scope === 'string' ? rec.scope : undefined)
        if (!normalized.ok) throw new Error(normalized.message)
        if (normalized.scope === undefined) throw new Error('缺少明确的 scope')
        const scope = normalized.scope               
        if (this.store.hasContent(scope, content)) {
          skipped += 1
          continue
        }
        await this.save({
          scope,
          kind: (typeof rec.kind === 'string' && rec.kind.length > 0 ? rec.kind : 'note')                        ,
          content,
          ...(Array.isArray(rec.tags) ? { tags: rec.tags.map(String) } : {}),
          ...(typeof rec.importance === 'number' ? { importance: rec.importance } : {}),
        })
        imported += 1
      } catch (error) {
        rejected += 1
        if (errors.length < 20) errors.push(`#${index}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.store.scheduleFlush()
    return { imported, skipped, rejected, errors }
  }

  /** 规则条数(面板设置页显示;只数已加载/已发现的作用域,排除退役规则)。 */
  ruleStats()                                    {
    this.discoverScopes()
    const retired = new Set(this.supersededIds())
    let total = 0
    let scopes = 0
    for (const s of this.store.allScopes()) {
      const n = [...s.records.values()].filter((r) => r.kind === 'rule' && !retired.has(r.id)).length
      if (n > 0) { total += n; scopes += 1 }
    }
    return { total, scopes }
  }

  /** 作用域别名（没有则 undefined，调用方回退到路径/键本身）。 */
  scopeName(scope             )                     {
    return this.names.nameOf(scope)
  }

  /** 名字 → 作用域键：读路径允许直接用别名找作用域。 */
  scopeKeyForName(name        )                          {
    return this.names.scopeOf(name)                           
  }

  /** 自定义名可能是别名：统一转回真实键，读写口径共用。 */
          canonicalScope(scope             )              {
    if (scope === 'global' || scope.startsWith('project:') || scope.startsWith('session:')) return scope
    return (this.names.scopeOf(scope)                           ) ?? scope
  }

  /**
   * 作用域清单(名字 + 条数 + 待嵌入 + 最近活跃时间),给面板 /status 与 memory_list 的尾部清单用。
   *
   * 先 `discoverScopes()`:进程内 store 是懒加载的,只列"已加载"的 scope 会让面板/清单
   * 漏掉别的进程(上一次会话、另一个 agent)写下的作用域。
   * 排序键是"最近活跃"(`updatedAt`):面板据此只给最近活跃的前 N 个会话 scope 查标题。
   */
  scopeStats()                                                                                                          {
    this.discoverScopes()
    return this.store.allScopes()
      .map((s) => ({
        scope: s.scope,
        ...(this.names.nameOf(s.scope) !== undefined ? { name: this.names.nameOf(s.scope) } : {}),
        records: s.records.size,
        pendingEmbeds: s.embedPending.size,
        updatedAt: [...s.records.values()].reduce((max, r) => Math.max(max, r.updatedAt), 0),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.records - a.records || a.scope.localeCompare(b.scope))
  }

  /**
   * 发现磁盘上的 scope(带时间缓存)。面板每次 /status、每次 memory_list 都要一份完整
   * 清单,而 discovery 要读每个文件的第一条记录 —— 限流到最短 3 秒一次,既保证清单够新,
   * 也不至于把 projects/ 目录读成热路径(面板侧还有一层同样时长的缓存,旧 provider 也能受益)。
   */
  /**
   * 当前进程已知的 scope 键:**只读**,不触发发现(要完整清单用 discoverScopes()/scopeStats())。
   */
  knownScopes()                {
    return this.store.allScopes().map((s) => s.scope)
  }

  /**
   * 发现磁盘上的 scope(带时间缓存)。面板每次 /status、每次 memory_list 都要一份完整
   * 清单,而 discovery 要读每个文件的第一条记录 —— 限流到最短 3 秒一次,既保证清单够新,
   * 也不至于把 projects/ 目录读成热路径(面板侧还有一层同样时长的缓存,旧 provider 也能受益)。
   */
  discoverScopes()                {
    const now = Date.now()
    if (this.discoveredAt === 0 || now - this.discoveredAt >= DISCOVER_TTL_MS) {
      this.discoveredAt = now
      try {
        this.store.loadDiscovered()
      } catch {
        // 发现失败不影响读写,清单里少几个而已
      }
    }
    return this.knownScopes()
  }

  /** Force a synchronous flush (dispose/HMR path). */
  flushSync()       {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer)
      this.maintenanceTimer = null
    }
    if (this.embedRetryTimer) {
      clearInterval(this.embedRetryTimer)
      this.embedRetryTimer = null
    }
    if (this.initialDrainTimer) {
      clearTimeout(this.initialDrainTimer)
      this.initialDrainTimer = null
    }
    if (this.embedServer) this.embedServer.stop()
    if (this.exitHook) {
      process.removeListener('exit', this.exitHook)
      this.exitHook = null
    }
    this.store.purgeExpired()
    this.store.enforceLimit(this.cfg.maxRecordsPerScope)
    this.store.close()
  }

  get pendingEmbedCount()         {
    return this.store.allScopes().reduce((n, s) => n + s.embedPending.size, 0)
  }
}

function touch(record              )               {
  record.lastAccessedAt = Date.now()
  record.accessCount += 1
  return record
}

function round4(n        )         {
  return Math.round(n * 10_000) / 10_000
}

/** Port of an http(s) endpoint, or null when it cannot be parsed. */
function portOf(endpoint        )                {
  try {
    const port = new URL(endpoint).port
    return port ? Number.parseInt(port, 10) : null
  } catch {
    return null
  }
}

/**
 * Measured score floor of genuine lexical hits; below this only single-char
 * coincidences live. Used to gate weak-only overlaps regardless of config.
 */
const REAL_HIT_FLOOR = 0.25

function memoryError(code        , message        )                           {
  const err = new Error(`[memory:${code}] ${message}`)                            
  err.code = code
  return err
}

/** discoverScopes() 的最短间隔:清单要够新,但 projects/ 目录不该被读成热路径。 */
const DISCOVER_TTL_MS = 3000

export function createMemoryService(config                    = {})                     {
  return new LocalMemoryService(config)
}


//# sourceURL=source/memory-local/src/index.ts