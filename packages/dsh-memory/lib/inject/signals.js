/**
 * 行为信号 → 自动召回查询。
 *
 * 只消费宿主**公开**的可观测信号:
 *   - session/event 的 `tool/call`（name + arguments）
 *   - session/event 的 `tool/result`（error / message.isError）
 *   - compaction 事件（上下文重建）
 *
 * 不读取隐藏思维链,也不把原始工具参数写进审计或日志。这里只做关键词分类,
 * 生成短的检索查询和稳定 key;是否真的召回由注入半边在下一个 pre-step 决定。
 */

                                                                                    

                            
                        
                       
             
                     
                 

                                 
             
                      
               
               
               
                             
 

const HIGH_RISK_PATTERNS                                                                   = [
  {
    key: 'npm-publish',
    re: /\b(?:npm|pnpm|yarn)\s+(?:publish|stage\s+publish|release)\b/i,
    query: 'npm publish release credentials devcred validating',
    phase: 'release',
  },
  {
    key: 'git-push',
    re: /\bgit\s+push\b/i,
    query: 'git push github rest api credentials network',
    phase: 'release',
  },
  {
    key: 'container-deploy',
    re: /\b(?:docker|podman)\s+push\b|\bkubectl\s+(?:apply|rollout|delete)\b|\bhelm\s+(?:upgrade|install)\b/i,
    query: 'deploy container kubernetes release rollback',
    phase: 'deploy',
  },
  {
    key: 'terraform-apply',
    re: /\bterraform\s+(?:apply|destroy)\b/i,
    query: 'deploy terraform apply rollback approval',
    phase: 'deploy',
  },
  {
    key: 'generic-release',
    re: /\b(?:release|deploy|ship)\s+(?:the\s+)?(?:package|app|service|build|version)\b/i,
    query: 'release deploy publish checklist credentials rollback',
    phase: 'release',
  },
]

/** 从用户可见文本推断任务阶段;不确定就返回 unknown,不伪造。 */
export function detectPhase(text                    )         {
  const value = String(text ?? '').toLowerCase()
  if (/(?:npm|pnpm|yarn)\s+(?:publish|stage)|git\s+push|\brelease\b|\bpublish\b|发布|推送/.test(value)) return 'release'
  if (/(?:deploy|rollout|kubectl|terraform\s+apply|部署)/.test(value)) return 'deploy'
  if (/(?:implement|refactor|fix|add)\b|开发|实现|修复|新增|重构|添加/.test(value)) return 'development'
  return 'unknown'
}

/** 工具名 + 参数里的可见操作目标是否命中高风险操作。只返回匹配类别,不保留参数。 */
export function highRiskSignal(tool        , argumentsText        )                             {
  const haystack = `${tool} ${argumentsText}`
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.re.test(haystack)) {
      return {
        key: `high-risk:${pattern.key}`,
        reason: 'before_high_risk_tool',
        query: pattern.query,
        phase: pattern.phase,
        tool,
      }
    }
  }
  return undefined
}

/** 工具失败分类。只根据 code/消息里的**类别词**判断,不保存原始消息。 */
export function failureSignal(tool                    , code                    , message                    )                 {
  const haystack = `${code ?? ''} ${message ?? ''}`.toLowerCase()
  let errorClass                 = 'TOOL_FAILED'
  let query = `failure diagnostics ${tool ?? 'tool'}`
  let phase = 'unknown'
  if (/credential|missing.*token|no.*token|unauthori[sz]ed|e401|401|auth(?:entication)?\s+required/.test(haystack)) {
    errorClass = 'MISSING_CREDENTIAL'
    query = 'credentials npm publish devcred token missing'
    phase = 'release'
  } else if (/permission|denied|forbidden|e403|403|eacces|eperm/.test(haystack)) {
    errorClass = 'PERMISSION_DENIED'
    query = 'permission denied sandbox approval credentials'
  } else if (/timeout|timed\s*out|etimedout/.test(haystack)) {
    errorClass = 'TIMEOUT'
    query = 'timeout retry long running command'
  } else if (/abort|cancel|interrupt/.test(haystack)) {
    errorClass = 'ABORTED_UNKNOWN'
    query = 'aborted command diagnosis retry'
  }
  return {
    key: `tool-failure:${tool ?? 'unknown'}:${errorClass}`,
    reason: 'tool_failure',
    query,
    phase,
    ...(tool !== undefined ? { tool } : {}),
    errorClass,
  }
}

/** 从一个 tool/result 事件里取错误信息（已做防御性读取）。 */
export function toolResultFailure(event         )                                                        {
  const data = (event                                                  )?.data
  const error = data?.error                                                                    
  const message = data?.message                                                                                        
  const text = Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text          ).join(' ')
    : ''
  const code = typeof error?.code === 'string'
    ? error.code
    : typeof error?.name === 'string' ? error.name : undefined
  return {
    ...(code !== undefined ? { code } : {}),
    ...(text !== '' ? { message: text.slice(0, 240) } : {}),
    isError: message?.isError === true || error !== undefined,
  }
}

/**
 * 每个会话只保留**最新一条未消费**的信号;相同 key 不重复排队。
 * `take()` 消费后保留 lastKey,同一失败不会因为重复事件反复搜索。
 */
export class BehaviorSignalStore {
                   bySession = new Map                                                       ()

  note(sessionId                    , signal                )          {
    if (sessionId === undefined) return false
    const key = sessionId
    const state = this.bySession.get(key) ?? { lastKey: '' }
    if (signal.key === state.lastKey) return false
    state.pending = signal
    state.lastKey = signal.key
    this.bySession.set(key, state)
    if (this.bySession.size > 500) {
      const oldest = this.bySession.keys().next()
      if (!oldest.done) this.bySession.delete(oldest.value)
    }
    return true
  }

  take(sessionId                    )                             {
    if (sessionId === undefined) return undefined
    const state = this.bySession.get(sessionId)
    if (state?.pending === undefined) return undefined
    const signal = state.pending
    state.pending = undefined
    return signal
  }

  clear(sessionId                    )       {
    if (sessionId === undefined) return
    this.bySession.delete(sessionId)
  }
}


//# sourceURL=source/memory-inject/src/signals.ts