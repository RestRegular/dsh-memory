/**
 * 子代理 → 主代理 记忆授权申请网关（0.48.0）。
 *
 * 子代理调用 memory_scopes(request) 申请范围外权限时：
 *   1) 不弹面板审批卡（子代理不该直接找用户）；
 *   2) 通过宿主 ctx.subagents.sendMessage 给主代理发一条申请消息；
 *   3) 登记一个待授权请求（按子会话 id），工具调用返回「已通知主代理」。
 *
 * 主代理收到消息后用 memory_scopes(request, {target_session: <子会话id>}) 授权，
 * 该路径会写子会话授权上限、父会话保留新权限，并回一条「记忆范围已更新」消息。
 *
 * 这一层是纯宿主编排；没有 subagents 服务（老宿主 / 测试）时完全降级：什么都不做，
 * 由调用方决定是否回退到普通面板审批。
 */
                                                  

/** 待授权申请（进程内存，等待主代理处理）。 */
                                     
            
                        
                          
                                                                        
                
                     
                                          
 

                           
                                                              
                                                                                                                                                      
 

                         
                           
 

/** 从 exec 里取 agent（宿主工具同口径）。 */
function agentOf(exec         )      {
  return (exec                                   )?.agent
}

function sessionIdOf(agent         )                     {
  const session = (agent                                                                         )?.session
  const id = session?.header?.id ?? session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 尝试把子代理的范围外申请转交主代理。
 * @returns true = 已成功转交（调用方应停止走面板审批）；false = 无法转交（调用方可回退）。
 */
export async function relayToParent(
  ctx         ,
  exec         ,
  input   
                                                                          
                  
   ,
  requests                                 ,
)                   {
  const child = agentOf(exec)
  if (child === undefined) return false
  const subagents = ctx.get('subagents')                               
  if (subagents === undefined || typeof subagents.sendMessage !== 'function') return false
  const agents = ctx.get('agents')                             
  let names                                                
  try { names = subagents.namesOf?.(child) } catch { return false }
  if (names === undefined || names.parent === undefined) return false // 根代理：走正常面板审批

  const childSessionId = sessionIdOf(child)
  const request                     = {
    id: `parent-grant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    childSessionId: childSessionId ?? '',
    scopes: input.scopes,
    reason: input.reason,
    requestedAt: Date.now(),
    status: 'pending',
  }
  requests.set(request.id, request)

  const scopeText = input.scopes
    .map((item) => `${item.scope}(${item.permissions.map((perm) => perm === 'write' ? '读写' : '只读').join('/')})`)
    .join('、')
  const message = [
    '【子代理记忆授权申请】',
    `申请方：${names.self ?? childSessionId ?? '子代理'}（子会话 id：${childSessionId ?? '未知'}）`,
    `申请范围：${scopeText}`,
    `理由：${input.reason || '（未提供）'}`,
    '',
    '如果你有这些权限，请直接调用 memory_scopes({ action: "request", target_session: "<上面的子会话 id>", scopes: [...], permissions: [...] }) 授权，',
    '并给子代理回一条消息说明「记忆范围已更新」。如果你也没有权限，该工具会先向用户弹审批卡，批准后再授权。',
  ].join('\n')

  try {
    await subagents.sendMessage(child, names.parent, [{ type: 'text', text: message }], {
      ...((exec                                        )?.signal !== undefined
        ? { signal: (exec                            ).signal }
        : {}),
    })
    return true
  } catch {
    // 发送失败：撤销登记，让调用方回退到面板审批。
    requests.delete(request.id)
    return false
  }
}

/** 主代理授权后回执子代理（在 memory_scopes target_session 路径调用）。 */
export async function notifyChildGrantUpdated(
  ctx         ,
  parentAgent         ,
  childSessionId        ,
  scopes                                                                ,
)                {
  const subagents = ctx.get('subagents')                               
  if (subagents === undefined || typeof subagents.sendMessage !== 'function' || parentAgent === undefined) return
  const scopeText = scopes.map((item) => `${item.scope}(${item.permissions.join('/')})`).join('、')
  try {
    await subagents.sendMessage(parentAgent, childSessionId, [{
      type: 'text',
      text: `工具调用成功，记忆范围已更新：${scopeText}`,
    }], {})
  } catch { /* 子代理可能已结束；回执失败不影响授权本身 */ }
}


//# sourceURL=source/tool-memory/src/parent-gateway.ts