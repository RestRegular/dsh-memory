/**
 * 子代理「授权上限」(delegation cap)。
 *
 * 背景（0.48.0）：记忆 grant 现在沿 parentSession 链无条件继承，父会话获批的
 * 全部作用域会原样流进每个子会话。新模型要求子代理创建时可以限定自己的记忆
 * 权限范围：默认只能拿父会话有效权限的子集，超出部分需要用户 / 父代理批准。
 *
 * 做法：给子会话写一份 `<storeDir>/grants/<session>.cap.json`，记录它被允许
 * 从父链继承哪些 scope + permission。provider 的 validGrants 在合并父链 grant
 * 时按这份上限过滤；子会话**自己**通过 memory_scopes 拿到的 grant 不受影响。
 * 父会话没有 cap 文件 = 沿用旧的「全部继承」语义（向后兼容）。
 *
 * 与 grants 分文件、按会话分文件的并发取舍跟 grants.ts 一致：原子 rename，
 * 只碰自己那份；cap 丢失 / 损坏时保守回退为「空继承」（不放宽权限）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isWellFormedScopeKey, normalizeScopeKey } from './scope.js'
                                                  

export const DELEGATION_CAP_VERSION = 1

/** 一个作用域允许继承的权限（read / write 独立）。 */
                                
               
                                
 

                                
                 
                   
                   
                                         
                         
                                                                    
                    
 

function safeName(sessionId        )         {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  if (cleaned === sessionId && cleaned !== '') return cleaned
  const base = cleaned === '' ? 'session' : cleaned.slice(0, 64)
  return `${base}-${createHash('sha1').update(sessionId).digest('hex').slice(0, 8)}`
}

function cleanPermissions(raw         )                    {
  if (!Array.isArray(raw)) return []
  const out                    = []
  for (const item of raw) {
    if ((item === 'read' || item === 'write') && !out.includes(item)) out.push(item)
  }
  return out
}

                                     
                   
                                                                                   
                    
 

export class DelegationCapStore {
           dir        

  constructor(options                  ) {
    this.dir = join(options.root, 'grants')
  }

  fileFor(sessionId        )         {
    return join(this.dir, `${safeName(sessionId)}.cap.json`)
  }

  /** 读取上限；没有文件返回 undefined（= 旧语义：全部继承）。 */
  get(sessionId        )                            {
    let text        
    try {
      text = readFileSync(this.fileFor(sessionId), 'utf8')
    } catch {
      return undefined
    }
    try {
      const raw = JSON.parse(text)           
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
      const value = raw                           
      const entries = Array.isArray(value.scopes) ? value.scopes : []
      const scopes                  = []
      const seen = new Map                           ()
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const item = entry                           
        if (typeof item.scope !== 'string' || item.scope === '') continue
        const scope = normalizeScopeKey(item.scope)
        if (!isWellFormedScopeKey(scope)) continue
        const permissions = cleanPermissions(item.permissions)
        if (permissions.length === 0) continue
        const prev = seen.get(scope)
        if (prev !== undefined) {
          for (const perm of permissions) if (!prev.includes(perm)) prev.push(perm)
        } else {
          seen.set(scope, permissions)
        }
      }
      for (const [scope, permissions] of seen) scopes.push({ scope, permissions })
      return {
        version: DELEGATION_CAP_VERSION,
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : sessionId,
        createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
        scopes,
        ...(typeof value.grantedBy === 'string' ? { grantedBy: value.grantedBy } : {}),
      }
    } catch {
      // 损坏的 cap 保守处理为「空继承」，绝不因为读不出来而放宽权限。
      return { version: DELEGATION_CAP_VERSION, sessionId, createdAt: Date.now(), scopes: [] }
    }
  }

  /** 写入 / 覆盖上限。合并已有权限（只增不减由调用方决定是否重算）。 */
  set(input                    )                {
    const scopes                  = []
    const seen = new Map                           ()
    for (const entry of input.scopes) {
      const scope = normalizeScopeKey(entry.scope)
      if (!isWellFormedScopeKey(scope)) continue
      const permissions = cleanPermissions(entry.permissions)
      if (permissions.length === 0) continue
      const prev = seen.get(scope)
      if (prev !== undefined) {
        for (const perm of permissions) if (!prev.includes(perm)) prev.push(perm)
      } else {
        seen.set(scope, permissions)
      }
    }
    for (const [scope, permissions] of seen) scopes.push({ scope, permissions })
    const cap                = {
      version: DELEGATION_CAP_VERSION,
      sessionId: input.sessionId,
      createdAt: Date.now(),
      scopes,
      ...(input.grantedBy !== undefined ? { grantedBy: input.grantedBy } : {}),
    }
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(input.sessionId)
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, `${JSON.stringify(cap, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return cap
  }

  /** 在已有上限上追加权限（父代理批准子代理申请时用）。 */
  addPermissions(sessionId        , scopes                                                                           , grantedBy         )                {
    const existing = this.get(sessionId)
    const merged = new Map                           ()
    for (const entry of existing?.scopes ?? []) merged.set(entry.scope, [...entry.permissions])
    for (const entry of scopes) {
      const scope = normalizeScopeKey(entry.scope)
      if (!isWellFormedScopeKey(scope)) continue
      const permissions = cleanPermissions(entry.permissions)
      const prev = merged.get(scope) ?? []
      for (const perm of permissions) if (!prev.includes(perm)) prev.push(perm)
      merged.set(scope, prev)
    }
    return this.set({
      sessionId,
      scopes: [...merged].map(([scope, permissions]) => ({ scope, permissions })),
      ...(grantedBy !== undefined ? { grantedBy } : existing?.grantedBy !== undefined ? { grantedBy: existing.grantedBy } : {}),
    })
  }

  remove(sessionId        )       {
    try {
      const file = this.fileFor(sessionId)
      if (existsSync(file)) renameSync(file, `${file}.removed-${randomUUID().slice(0, 8)}`)
    } catch { /* 清理失败不影响主流程 */ }
  }
}


//# sourceURL=source/memory-local/src/delegation-cap.ts