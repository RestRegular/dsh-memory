/**
 * 注入相关的运行时设置 —— 面板「记忆 → 设置」里能开关的那些东西。
 *
 * 为什么放在 provider 侧:设置要落盘(进程重启后还在)、要能通过面板 HTTP
 * 接口读写,而注入半边只是一组纯函数 + 一个 pre-step 监听器。所以 provider
 * 负责存与发事件,注入半边只负责"每步读一次"。
 */
                                 
                  
              
                     
 

                                 
                  
                 
              
                     
 

                                     
                                                     
                  
               
 

                                 
                           
                  
 

                                
                                           
                  
                  
                     
     
                                      
                                      
                                     
     
                
 

                                  
                                           
                  
 

/** 界面:是否在左侧栏「插件」下方显示记忆入口(点击在主界面打开面板)。 */
                                  
                  
 

                                 
                        
                        
                                
                        
                      
                          
                          
 

export const defaultInjectSettings                 = {
  recall: { enabled: true, topK: 5, tokenBudget: 500 },
  digest: { enabled: true, topK: 8, tokenBudget: 400 },
  impression: { enabled: true, chars: 120 },
  policy: { enabled: true },
  rules: { enabled: true, maxItems: 10, tokenBudget: 300, delta: true },
  turnEnd: { enabled: false },
  sidebar: { enabled: false },
}

const clampInt = (value         , min        , max        , fallback        )         => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const bool = (value         , fallback         )          =>
  typeof value === 'boolean' ? value : fallback

/** 容错读取:未知字段忽略、越界值夹紧,配置/面板发来脏数据也不该把注入搞崩。 */
export function normalizeInjectSettings(raw         , base                 = defaultInjectSettings)                 {
  let r = (raw && typeof raw === 'object' ? raw : {})                           
  // 0.5.x 的 inject 小节只有 enabled / topK / tokenBudget(召回),继续认它们。
  const legacy = r                                                                
  if (legacy.enabled !== undefined || legacy.topK !== undefined || legacy.tokenBudget !== undefined) {
    r = {
      ...r,
      recall: {
        ...(legacy.enabled !== undefined ? { enabled: legacy.enabled } : {}),
        ...(legacy.topK !== undefined ? { topK: legacy.topK } : {}),
        ...(legacy.tokenBudget !== undefined ? { tokenBudget: legacy.tokenBudget } : {}),
        ...((r.recall && typeof r.recall === 'object' ? r.recall : {})                           ),
      },
    }
  }
  const section = (key                      )                          => {
    const value = r[key]
    return (value && typeof value === 'object' ? value : {})                           
  }
  const recall = section('recall')
  const digest = section('digest')
  const impression = section('impression')
  const policy = section('policy')
  const rules = section('rules')
  const turnEnd = section('turnEnd')
  const sidebar = section('sidebar')
  return {
    recall: {
      enabled: bool(recall.enabled, base.recall.enabled),
      topK: clampInt(recall.topK, 1, 20, base.recall.topK),
      tokenBudget: clampInt(recall.tokenBudget, 50, 4000, base.recall.tokenBudget),
    },
    digest: {
      enabled: bool(digest.enabled, base.digest.enabled),
      topK: clampInt(digest.topK, 1, 30, base.digest.topK),
      tokenBudget: clampInt(digest.tokenBudget, 50, 4000, base.digest.tokenBudget),
    },
    impression: {
      enabled: bool(impression.enabled, base.impression.enabled),
      chars: clampInt(impression.chars, 40, 800, base.impression.chars),
    },
    policy: { enabled: bool(policy.enabled, base.policy.enabled) },
    rules: {
      enabled: bool(rules.enabled, base.rules.enabled),
      maxItems: clampInt(rules.maxItems, 1, 40, base.rules.maxItems),
      tokenBudget: clampInt(rules.tokenBudget, 50, 4000, base.rules.tokenBudget),
      delta: bool(rules.delta, base.rules.delta),
    },
    turnEnd: { enabled: bool(turnEnd.enabled, base.turnEnd.enabled) },
    sidebar: { enabled: bool(sidebar.enabled, base.sidebar.enabled) },
  }
}

/** 把面板发来的补丁合并进当前设置(只认已知字段,其余忽略)。 */
export function mergeInjectSettings(current                , patch         )                 {
  const p = (patch && typeof patch === 'object' ? patch : {})                           
  const merged                          = { ...current }
  for (const key of Object.keys(defaultInjectSettings)                               ) {
    if (p[key] && typeof p[key] === 'object') merged[key] = { ...current[key], ...(p[key]                           ) }
  }
  return normalizeInjectSettings(merged, current)
}


//# sourceURL=source/memory-local/src/inject-settings.ts