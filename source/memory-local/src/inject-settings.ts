/**
 * 注入相关的运行时设置 —— 面板「记忆 → 设置」里能开关的那些东西。
 *
 * 为什么放在 provider 侧:设置要落盘(进程重启后还在)、要能通过面板 HTTP
 * 接口读写,而注入半边只是一组纯函数 + 一个 pre-step 监听器。所以 provider
 * 负责存与发事件,注入半边只负责"每步读一次"。
 */
export interface RecallSettings {
  enabled: boolean
  topK: number
  tokenBudget: number
}

export interface DigestSettings {
  enabled: boolean
  /** 摘要最多列几条。 */
  topK: number
  tokenBudget: number
  /** 被截断记忆的标签索引预算（与正文预算分开计）。 */
  hintBudget: number
  /** 标签索引最多列几条。 */
  hintMaxItems: number
}

export interface ImpressionSettings {
  /** 每轮召回的"印象"形态:每条只给开头这么多字,细节让模型再 memory_search。 */
  enabled: boolean
  chars: number
}

export interface PolicySettings {
  /** 系统提示里的「记忆使用策略」常驻段。 */
  enabled: boolean
}

/** 状态型记忆(kind=state)的默认有效期。过期后默认隐藏,但 memory_get 仍可取。 */
export interface StateSettings {
  /** 默认 TTL(毫秒);也接受旧配置里的顶层 `stateTtlMs`。 */
  ttlMs: number
}

/** 流程索引:系统提示里按当前工作区/触发词列出的 procedure 目录。 */
export interface ProceduresSettings {
  enabled: boolean
  maxItems: number
  tokenBudget: number
}

export interface RulesSettings {
  /** 系统提示里的「硬性规则」段(来自 kind:'rule' 的记忆)。 */
  enabled: boolean
  maxItems: number
  tokenBudget: number
  /**
   * 规则变更提醒:旧会话在下一轮第一步补一条「新增/变更的规则」消息。
   * 系统提示段每步都会刷新,但那条更新不产生对话消息,模型未必会重读;
   * 规则段又有预算上限,新规则可能被旧规则挤掉 —— 所以补这一条。
   */
  delta: boolean
}

/**
 * 自动召回的“模式”就是一组**标签**。工具调用的 name / description / 参数
 * 命中任一标签时触发一次定向召回;失败调用则始终用 description 触发。
 * 标签来自用户的记忆数据(如 release / database / credentials),可在设置里增删,
 * 不需要写正则,也不只服务发布部署。
 */
export interface AutoRecallSettings {
  enabled: boolean
  /** 失败工具调用优先用它的 description 作为检索查询。 */
  useToolDescription: boolean
  /** 查询最大字符数,防止把整段命令/描述塞进 embedding。 */
  maxQueryChars: number
  /** 额外触发标签;还会自动并入当前记忆库里已有的标签。 */
  tags: string[]
  /** 是否自动使用记忆库里的标签作为触发词。 */
  useMemoryTags: boolean
}

/** 默认触发标签:覆盖发布、部署、数据库、凭据、破坏性操作、依赖、远程等域。 */
export const DEFAULT_AUTO_RECALL_TAGS: string[] = [
  'release', 'publish', 'deploy', 'deployment', 'rollback', 'restore', 'backup',
  'database', 'migration', 'migrate', 'schema', 'credentials', 'credential', 'auth', 'token',
  'secret', 'login', 'permission', 'security', 'destructive', 'delete', 'drop', 'truncate',
  'install', 'upgrade', 'network', 'ssh', 'server', 'git', 'push', 'github', 'npm',
  'devcred', 'docker', 'kubectl', 'terraform', 'production', 'prod',
  '发布', '推送', '部署', '回滚', '恢复', '备份', '数据库', '迁移', '凭据', '认证',
  '权限', '安全', '删除', '清空', '安装', '升级', '网络', '服务器', '生产',
]



export interface TurnEndSettings {
  /** 轮末提醒:下一轮开头提示"上一轮若有可复用结论就记一条"。默认关闭。 */
  enabled: boolean
}

/** 界面:是否在左侧栏「插件」下方显示记忆入口(点击在主界面打开面板)。 */
export interface SidebarSettings {
  enabled: boolean
}

/** 「整理记忆」工作区菜单打开的新会话开场提示词（面板「设置」页可改）。 */
export interface OrganizeSettings {
  prompt: string
}

export interface InjectSettings {
  recall: RecallSettings
  digest: DigestSettings
  impression: ImpressionSettings
  policy: PolicySettings
  state: StateSettings
  procedures: ProceduresSettings
  rules: RulesSettings
  autoRecall: AutoRecallSettings
  turnEnd: TurnEndSettings
  sidebar: SidebarSettings
  organize: OrganizeSettings
}

export const DEFAULT_STATE_TTL_MS = 7 * 86_400_000

/** 「整理记忆」开场提示词的默认值（面板可改；工作区路径/名称在发出时动态附上）。 */
export const DEFAULT_ORGANIZE_PROMPT = [
  '请整理当前工作区的记忆。这是一次性整理会话，严格按下面四步执行：',
  '1. 扫描：用 memory_scopes({action:"list"}) 看有哪些作用域，再用 memory_list 和 memory_search 找出与这个工作区相关的记忆。排除 kind=rule（硬性规则不参与整理）。',
  '2. 只分析、出整体报告（这一步不要写任何记忆）：告诉我一共多少条、大致分成哪些主题、每组里哪些是过时结论、哪些是同主题重复、哪些高度重合可以删除。用中文写一份总体情况说明，不要逐条列出来让我逐条确认。',
  '3. 等我回复确认后再动手（我没确认前不要修改任何记忆）。确认后：同主题的多条记忆合并成一条更完整的，用 memory_save 的 supersedes 传数组一次指向所有旧记忆的完整 id（一条修正多条），旧版本默认退出检索、历史仍可用 memory_get 查到；scope 必须显式传旧记录所在作用域，本会话无写权限时先用 memory_scopes({action:"request"}) 申请。',
  '4. 高度重合、内容几乎一样的重复记忆才用 memory_forget 删除；拿不准的一律用 supersedes 合并而不是删。删除前在报告里说清是哪几条，我没有单独反对才做。全程不要碰 kind=rule。',
].join('\n')

export const defaultInjectSettings: InjectSettings = {
  recall: { enabled: true, topK: 5, tokenBudget: 500 },
  digest: { enabled: true, topK: 8, tokenBudget: 800, hintBudget: 160, hintMaxItems: 6 },
  impression: { enabled: true, chars: 120 },
  policy: { enabled: true },
  state: { ttlMs: DEFAULT_STATE_TTL_MS },
  procedures: { enabled: true, maxItems: 10, tokenBudget: 500 },
  rules: { enabled: true, maxItems: 10, tokenBudget: 300, delta: true },
  autoRecall: {
    enabled: true,
    useToolDescription: true,
    maxQueryChars: 240,
    tags: DEFAULT_AUTO_RECALL_TAGS,
    useMemoryTags: true,
  },
  turnEnd: { enabled: false },
  sidebar: { enabled: false },
  organize: { prompt: DEFAULT_ORGANIZE_PROMPT },
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

/** 容错读取:未知字段忽略、越界值夹紧,配置/面板发来脏数据也不该把注入搞崩。 */
export function normalizeInjectSettings(raw: unknown, base: InjectSettings = defaultInjectSettings): InjectSettings {
  let r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  // 0.5.x 的 inject 小节只有 enabled / topK / tokenBudget(召回),继续认它们。
  const legacy = r as { enabled?: unknown; topK?: unknown; tokenBudget?: unknown }
  if (legacy.enabled !== undefined || legacy.topK !== undefined || legacy.tokenBudget !== undefined) {
    r = {
      ...r,
      recall: {
        ...(legacy.enabled !== undefined ? { enabled: legacy.enabled } : {}),
        ...(legacy.topK !== undefined ? { topK: legacy.topK } : {}),
        ...(legacy.tokenBudget !== undefined ? { tokenBudget: legacy.tokenBudget } : {}),
        ...((r.recall && typeof r.recall === 'object' ? r.recall : {}) as Record<string, unknown>),
      },
    }
  }
  const section = (key: keyof InjectSettings): Record<string, unknown> => {
    const value = r[key]
    return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  }
  const recall = section('recall')
  const digest = section('digest')
  const impression = section('impression')
  const policy = section('policy')
  const state = section('state')
  const procedures = section('procedures')
  const rules = section('rules')
  const autoRecall = section('autoRecall')
  const turnEnd = section('turnEnd')
  const sidebar = section('sidebar')
  const organize = section('organize')
  // 兼容方案里的 `inject.stateTtlMs` 写法;新配置统一放到 state.ttlMs。
  const legacyStateTtl = (r as { stateTtlMs?: unknown }).stateTtlMs
  const stateTtlInput = state.ttlMs ?? legacyStateTtl
  const rawTags = Array.isArray(autoRecall.tags) ? autoRecall.tags : base.autoRecall.tags
  const normalizedTags: string[] = []
  const seenTags = new Set<string>()
  for (const raw of rawTags.slice(0, 60)) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim()
    if (tag === '') continue
    const key = tag.toLowerCase()
    if (seenTags.has(key)) continue
    seenTags.add(key)
    normalizedTags.push(tag)
  }
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
      hintBudget: clampInt(digest.hintBudget, 30, 1000, base.digest.hintBudget),
      hintMaxItems: clampInt(digest.hintMaxItems, 1, 30, base.digest.hintMaxItems),
    },
    impression: {
      enabled: bool(impression.enabled, base.impression.enabled),
      chars: clampInt(impression.chars, 40, 800, base.impression.chars),
    },
    policy: { enabled: bool(policy.enabled, base.policy.enabled) },
    state: {
      ttlMs: clampInt(stateTtlInput, 60_000, 365 * 86_400_000, base.state.ttlMs),
    },
    procedures: {
      enabled: bool(procedures.enabled, base.procedures.enabled),
      maxItems: clampInt(procedures.maxItems, 1, 30, base.procedures.maxItems),
      tokenBudget: clampInt(procedures.tokenBudget, 50, 4000, base.procedures.tokenBudget),
    },
    rules: {
      enabled: bool(rules.enabled, base.rules.enabled),
      maxItems: clampInt(rules.maxItems, 1, 40, base.rules.maxItems),
      tokenBudget: clampInt(rules.tokenBudget, 50, 4000, base.rules.tokenBudget),
      delta: bool(rules.delta, base.rules.delta),
    },
    autoRecall: {
      enabled: bool(autoRecall.enabled, base.autoRecall.enabled),
      useToolDescription: bool(autoRecall.useToolDescription, base.autoRecall.useToolDescription),
      maxQueryChars: clampInt(autoRecall.maxQueryChars, 40, 500, base.autoRecall.maxQueryChars),
      tags: normalizedTags,
      useMemoryTags: bool(autoRecall.useMemoryTags, base.autoRecall.useMemoryTags),
    },
    turnEnd: { enabled: bool(turnEnd.enabled, base.turnEnd.enabled) },
    sidebar: { enabled: bool(sidebar.enabled, base.sidebar.enabled) },
    organize: {
      prompt: typeof organize.prompt === 'string' && organize.prompt.trim() !== ''
        ? organize.prompt
        : base.organize.prompt,
    },
  }
}

/** 把面板发来的补丁合并进当前设置(只认已知字段,其余忽略)。 */
export function mergeInjectSettings(current: InjectSettings, patch: unknown): InjectSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...current }
  for (const key of Object.keys(defaultInjectSettings) as Array<keyof InjectSettings>) {
    if (p[key] && typeof p[key] === 'object') merged[key] = { ...current[key], ...(p[key] as Record<string, unknown>) }
  }
  return normalizeInjectSettings(merged, current)
}
