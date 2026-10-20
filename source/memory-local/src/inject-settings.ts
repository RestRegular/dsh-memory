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

export interface TurnEndSettings {
  /** 轮末提醒:下一轮开头提示"上一轮若有可复用结论就记一条"。默认关闭。 */
  enabled: boolean
}

/** 界面:是否在左侧栏「插件」下方显示记忆入口(点击在主界面打开面板)。 */
export interface SidebarSettings {
  enabled: boolean
}

export interface InjectSettings {
  recall: RecallSettings
  digest: DigestSettings
  impression: ImpressionSettings
  policy: PolicySettings
  rules: RulesSettings
  turnEnd: TurnEndSettings
  sidebar: SidebarSettings
}

export const defaultInjectSettings: InjectSettings = {
  recall: { enabled: true, topK: 5, tokenBudget: 500 },
  digest: { enabled: true, topK: 8, tokenBudget: 800, hintBudget: 160, hintMaxItems: 6 },
  impression: { enabled: true, chars: 120 },
  policy: { enabled: true },
  rules: { enabled: true, maxItems: 10, tokenBudget: 300, delta: true },
  turnEnd: { enabled: false },
  sidebar: { enabled: false },
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
      hintBudget: clampInt(digest.hintBudget, 30, 1000, base.digest.hintBudget),
      hintMaxItems: clampInt(digest.hintMaxItems, 1, 30, base.digest.hintMaxItems),
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
export function mergeInjectSettings(current: InjectSettings, patch: unknown): InjectSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...current }
  for (const key of Object.keys(defaultInjectSettings) as Array<keyof InjectSettings>) {
    if (p[key] && typeof p[key] === 'object') merged[key] = { ...current[key], ...(p[key] as Record<string, unknown>) }
  }
  return normalizeInjectSettings(merged, current)
}
