/**
 * 注入审计:每次摘要/召回评估都留一条结构化记录。
 *
 * 第一版不要求复杂 UI:记录放在内存环形缓冲里,provider 通过
 * `attachInjectAudit()` 挂上,面板 `GET /memory/api/audit?session=` 读取。
 * 不记录任何凭据/令牌;检索查询会先过凭据脱敏,再最多截到 200 字。
 */

import { redactSecrets } from '../provider/secrets.js'

                                
            
                
 

                              
                
              
                   
 

                                        
            
                    
               
               
                                                                                              
                 
                                     
               
                
                    
                      
                   
                          
                      
                                      
                                                           
                 
           
                    
                       
                         
                             
                     
                            
   
                                  
                                                                 
                
 

const MAX_ENTRIES = 200

export class InjectAuditStore {
          entries                          = []

  record(entry                       )       {
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
  }

  /** 最新在前;可按会话过滤。 */
  list(sessionId         )                          {
    const list = sessionId === undefined
      ? this.entries
      : this.entries.filter((entry) => entry.sessionId === sessionId)
    return [...list].reverse()
  }

  clear()       {
    this.entries = []
  }
}

/** 查询文本里可能带用户内容:截断并折叠空白,不写凭据。 */
export function auditQuery(text                    )                     {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  return redactSecrets(text).replace(/\s+/g, ' ').trim().slice(0, 200)
}

export function auditBudget(budget        , used        )              {
  return { budget, used, remaining: Math.max(0, budget - used) }
}


//# sourceURL=source/memory-inject/src/audit.ts