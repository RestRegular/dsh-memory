/**
 * 作用域(scope)规范 —— 纯函数,无 cordis / 无 fs 依赖。
 *
 * 为什么需要这一层:早先 scope 的解析分散在四个工具、provider、面板与注入里,规则还不一致
 * (`tool-memory/src/index.ts` 的 scopeOr 把**任何**认不出的值静默回退成默认 scope,于是
 * "写到了别的 scope"这种错永远不报);而 provider 自己的默认值又是 `global`,与工具的
 * `project:<cwd>` 不一致 —— 读路径与写路径各说各话。现在只有一个入口:
 *
 *   normalizeScopeInput(raw)   模型/HTTP 传进来的字符串 → 规范化的 scope 或明确错误
 *   resolveCurrentScopes(agent)宿主会话上下文 → 当前会话 / 当前项目两个 key
 *   resolveScopeRef(...)       把上面两者的 kind 落到具体 key(读 / 写两种口径)
 *
 * 保留名与键空间:
 *   global                 所有项目共享(文件 global.jsonl)
 *   project:<cwd>          一个工作区(文件 projects/<sha1>.jsonl)
 *   session:<id>           一个会话(同一个 projects/<sha1>.jsonl 体系)
 *   <自定义名>              自由命名,内部键仍是自定义名本身
 * 三者都由 `scopeFileName()` 映射到文件名,因此**自定义名里出现 ':' 一律拒绝**,否则
 * `foo:bar` 会与保留前缀撞成同一个键空间,用户也能靠它伪造 `project:` 键。
 */
import { createHash } from 'node:crypto'
import { isCustomScopeKey } from './store.js'

/** 作用域键:除 'global' 外的形态由 resolveCurrentScopes / normalizeScopeInput 产生。 */
                             

                                                                   

/** normalizeScopeInput 的判别结果(scope 为 undefined 表示"未传")。 */
                                  
                                                                 
                                                
                  
 

                                  
                                    
                                                         

/** 自定义名长度上限(码点)。 */
export const MAX_SCOPE_NAME_CHARS = 64
/** project: / session: 前缀值的长度上限(路径与 uuid 都可能很长)。 */
export const MAX_PREFIXED_SCOPE_CHARS = 512

/** 保留名:不能作为自定义 scope,也不允许被自定义名覆盖(一律小写比较)。 */
export const RESERVED_SCOPE_NAMES = new Set(['global', 'project', 'session', 'all'])

const KEBAB = '-'

/** 控制字符(C0 + DEL + C1)一律拒绝:它们能进文件名映射的输入、也能把日志搅烂。 */
function hasControlChar(value        )          {
  for (const char of value) {
    const code = char.codePointAt(0) 
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true
  }
  return false
}

/**
 * 自定义名允许的字符:Unicode 字母 / 数字(含中文)、空格、'-'、'_'、'.'。
 * 用 `\p{L}\p{N}` 而不是 ASCII 白名单,是因为中文 scope 名("项目笔记")是预期用法;
 * 文件名的歧义由 `scopeFileName()` 的 SHA-1 兜底,这里只负责禁止会造成键空间混淆的字符。
 */
const CUSTOM_NAME_ALLOWED = /^[\p{L}\p{N} _.-]+$/u

/** 码点长度({ length } 会把 emoji 数成 2,K 说"按码点")。 */
function codePointLength(value        )         {
  return [...value].length
}

/**
 * 规范化"自定义名"。
 *   - 内部空白(含制表/换行)折叠为单个空格;
 *   - 转小写(大小写折叠,免出 `Foo` 与 `foo` 两个 scope);
 *   - 长度 1~64 码点;
 *   - 禁止 ':'、路径分隔符、控制字符、'..'、纯点/空格组成的名字、保留名。
 */
function normalizeCustomName(raw        )                                                              {
  const collapsed = raw.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return { ok: false, message: 'scope name is empty after normalization' }
  if (hasControlChar(collapsed)) return { ok: false, message: 'scope name must not contain control characters' }
  const name = collapsed.toLowerCase()
  if (codePointLength(name) > MAX_SCOPE_NAME_CHARS) {
    return { ok: false, message: `scope name exceeds ${MAX_SCOPE_NAME_CHARS} characters` }
  }
  if (name === '..' || name === '.') return { ok: false, message: "scope name must not be '.' or '..'" }
  if (/^[. ]+$/u.test(name)) return { ok: false, message: 'scope name must contain more than dots and spaces' }
  if (name.includes('..')) return { ok: false, message: "scope name must not contain '..'" }
  if (name.includes(':')) return { ok: false, message: "scope name must not contain ':'" }
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, message: 'scope name must not contain path separators' }
  }
  if (RESERVED_SCOPE_NAMES.has(name)) {
    // 'global'/'project'/'session' 在到达这里之前已经各自命中保留分支,所以这里实际拦的是 'all'。
    return { ok: false, message: `scope name "${name}" is reserved` }
  }
  if (!CUSTOM_NAME_ALLOWED.test(name)) {
    return { ok: false, message: 'scope name may only contain letters, digits, spaces, "-", "_" and "."' }
  }
  return { ok: true, name }
}

/**
 * 规范化 `project:` / `session:` 前缀值(旧键与宿主键,原样放行以便读写既有数据)。
 * 只做最小清洗:trim、拒绝控制字符、拒绝空、限长 —— 绝不改写内容,否则旧文件再也找不到。
 */
function normalizePrefixed(key        , label                       )                                                             {
  const value = key.slice(`${label}:`.length).trim()
  if (value.length === 0) return { ok: false, message: `${label}: scope requires a non-empty value` }
  if (hasControlChar(value)) return { ok: false, message: `${label}: scope value must not contain control characters` }
  if (codePointLength(key) > MAX_PREFIXED_SCOPE_CHARS) {
    return { ok: false, message: `${label}: scope exceeds ${MAX_PREFIXED_SCOPE_CHARS} characters` }
  }
  return { ok: true, key: `${label}:${value}` }
}

/**
 * 把模型 / HTTP query 传进来的原始字符串规范化。
 *
 * 关键语义:
 *   - `undefined` / 空串 → `kind: 'current-session'`(调用方按写/读口径决定落到哪里);
 *   - 'global' | 'project' | 'session' → 各自的**种类**,不在这里解析 cwd/会话(纯函数拿不到);
 *   - 'all' | '*' → 跨所有作用域(仅读路径合法,写路径由 assertWritableScope 拒绝);
 *   - 'project:*' | 'session:*' → 原样放行(显式 pin 某个项目 / 某个会话);
 *   - 其余 → 自定义名,严格校验。
 *
 * 不合法**不再静默回退**,一律返回 SCOPE_INVALID。
 */
export function normalizeScopeInput(raw                           )                       {
  // NFC 归一化:同一个中文 scope 从不同输入法过来可能是不同码点序列,不归一化就会分裂成两个 scope。
  const value = typeof raw === 'string' ? raw.normalize('NFC').trim() : ''
  if (value.length === 0) return { ok: true, kind: 'current-session' }
  if (value === '*') return { ok: true, kind: 'all' }
  const lower = value.toLowerCase()
  if (lower === 'global') return { ok: true, kind: 'global', scope: 'global' }
  if (lower === 'project') return { ok: true, kind: 'current-project' }
  if (lower === 'session') return { ok: true, kind: 'current-session' }
  if (lower === 'all') return { ok: true, kind: 'all' }
  if (lower.startsWith('project:')) {
    const prefixed = normalizePrefixed(value, 'project')
    return prefixed.ok
      ? { ok: true, kind: 'project', scope: prefixed.key }
      : { ok: false, code: 'SCOPE_INVALID', message: prefixed.message }
  }
  if (lower.startsWith('session:')) {
    const prefixed = normalizePrefixed(value, 'session')
    return prefixed.ok
      ? { ok: true, kind: 'session', scope: prefixed.key }
      : { ok: false, code: 'SCOPE_INVALID', message: prefixed.message }
  }
  const custom = normalizeCustomName(value)
  return custom.ok
    ? { ok: true, kind: 'custom', scope: custom.name }
    : { ok: false, code: 'SCOPE_INVALID', message: custom.message }
}

/** scope 的种类(用于命名空间 / 阈值 / 排序);未知形态按自定义处理。 */
export function scopeKind(scope          )            {
  if (scope === 'global') return 'global'
  if (scope.startsWith('project:')) return 'project'
  if (scope.startsWith('session:')) return 'session'
  return 'custom'
}

/** 自定义 scope 才计入 scopes.custom.max。 */
export function isCustomScope(scope          )          {
  return isCustomScopeKey(scope)
}

/** 跨 scope 合并排序时的稳定 tie-break:session > project > 自定义 > global。 */
export function scopeTier(scope          )         {
  switch (scopeKind(scope)) {
    case 'session': return 0
    case 'project': return 1
    case 'custom': return 2
    default: return 3
  }
}

/** 写路径遇到只读 scope 时的错误码('all' 不能写)。 */
export const SCOPE_NOT_WRITABLE = 'SCOPE_NOT_WRITABLE'

// ------------------------------------------------------------------ 当前会话 / 当前项目

/** 宿主 agent 上我们真正会碰到的那几个字段(其余一律不碰)。 */
                     
             
                
                                                                                       
   
 

function asString(value         )                     {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

                                
                                             
                    
                                                
                   
 

/**
 * 从宿主的 agent 对象解析出"当前会话 / 当前项目"两个 key。
 *
 *   - sessionId 优先 `agent.session.header.id`,退回 `agent.session.id`;
 *   - **子代理沿用父会话的记忆**:`header.origin === 'subagent'` 且有 `parentSession` 时,
 *     sessionId 取 parentSession(子代理是同一个任务的一部分,不该另起一个记忆作用域);
 *   - cwd 优先 `header.cwd`,退回 `projectScope` 配置,最后 `process.cwd()`;
 *   - 任何字段缺失都只降级、**绝不抛错**(注入路径上抛错会打断整个 agent 循环)。
 */
export function resolveCurrentScopes(agent         , opts                            = {})                {
  let header                                                                                        
  let sessionId                    
  try {
    const session = (agent                         )?.session
    header = session?.header
    sessionId = asString(header?.id) ?? asString(session?.id)
    if (sessionId !== undefined && header?.origin === 'subagent') {
      sessionId = asString(header.parentSession) ?? sessionId
    }
  } catch {
    // 宿主对象形态意外:当作拿不到会话,继续走 project 回退
    sessionId = undefined
  }
  const cwd = asString(header?.cwd)
  const project = opts.projectScope ?? `project:${cwd ?? process.cwd()}`
  return sessionId !== undefined ? { session: `session:${sessionId}`, project } : { project }
}

// ------------------------------------------------------------------ kind → 具体 key

                            
                                   
                    
                  
                   
 

                                      
                                                 
                        
                                                      
                                                 
                       
                    
     
                                                                
                                                                
                                                                 
     
                          
 

                                
                                              
                                                

/**
 * 把 normalizeScopeInput 的结果落到具体 key。
 *
 * 写路径(`mode: 'write'`):
 *   - `undefined`(字段省略)→ defaultScope 口径;'session' 拿不到会话时**回退 project**,不报错;
 *   - 'session' → 同上;'project' → 项目 key;'global' → 'global';
 *   - 'all' / '*' → 明确报错(只读);
 *   - 显式 'session:<id>' → 原样写入(允许显式 pin 某个会话)。
 * 读路径(`mode: 'read'`):
 *   - `undefined` → `scope: undefined`(表示"由调用方决定合并集合",由工具层填三路合并);
 *   - 'session' 拿不到会话 → `scope: undefined`(等价于默认合并集合,而不是报错);
 *   - 'all' → `{ all: true }`。
 */
export function resolveScopeRef(
  input                      ,
  refs           ,
  opts                     ,
)                     {
  if (!input.ok) return { ok: false, code: input.code, message: input.message }
  if (input.kind === 'all') {
    if (opts.mode === 'write') {
      return { ok: false, code: SCOPE_NOT_WRITABLE, message: "scope 'all' is read-only; name one scope to write to" }
    }
    if (opts.allowAll === false) {
      return { ok: false, code: SCOPE_NOT_WRITABLE, message: "scope 'all' is not allowed here; name one scope" }
    }
    return { ok: true, all: true }
  }
  if (input.kind === 'global') return { ok: true, scope: 'global' }
  if (input.kind === 'current-project') return { ok: true, scope: refs.project }
  if (input.kind === 'current-session') {
    // 省略 scope:写路径按会话落点(拿不到会话 / 会话被关 → 回退项目);读路径交给
    // 调用方的合并集合 —— 工具层要的是"会话 + 项目 + global",不是单个 key。
    if (opts.mode === 'write') {
      const current = opts.sessionEnabled === false ? undefined : refs.session
      return { ok: true, scope: writeScopeForDefault(opts.defaultScope, { ...refs, session: current }) }
    }
    return { ok: true }
  }
  if (input.kind === 'session') {
    // 显式 'session:<id>' 原样 pin(开关关掉时由 provider 报 SCOPE_DISABLED);裸 'session'
    // 与省略等价:写按会话(被关则回退项目)、读交给合并集合。
    if (input.scope !== undefined) return { ok: true, scope: input.scope }
    const scope = opts.sessionEnabled === false ? undefined : refs.session
    if (opts.mode === 'write') {
      return { ok: true, scope: writeScopeForDefault(opts.defaultScope, { ...refs, session: scope }) }
    }
    return { ok: true }
  }
  // project / custom:scope 已经在 normalize 阶段确定
  if (input.scope !== undefined) return { ok: true, scope: input.scope }
  return { ok: false, code: 'SCOPE_INVALID', message: 'scope could not be resolved' }
}

/**
 * 写路径的默认口径:model 省略 scope 时按 `tools.defaultScope` 落到哪个 scope。
 * 'session' 拿不到会话 → project(不报错);'global' → global。
 */
export function writeScopeForDefault(
  defaultScope                                              ,
  refs           ,
)           {
  if (defaultScope === 'global') return 'global'
  if (defaultScope === 'project') return refs.project
  return refs.session ?? refs.project
}

// ------------------------------------------------------------------ 文件名与标签

/**
 * 自定义 scope 的稳定短哈希(8 位)。仅用于**展示/调试**;真正的文件名映射仍是
 * `scopeFileName()` 的完整 SHA-1,因此这里不参与任何寻址,不存在撞名风险。
 */
export function scopeShortHash(scope          )         {
  return createHash('sha1').update(scope).digest('hex').slice(0, 8)
}


//# sourceURL=source/memory-local/src/scope.ts