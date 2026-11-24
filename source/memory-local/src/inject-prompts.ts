/**
 * 所有「会注入上下文的提示词」的内置默认值。
 *
 * 为什么放在 provider 半边：这些提示词现在是**可改设置**（面板「记忆 → 设置」里
 * 每条通道的文本框），设置要落盘、要能通过 HTTP 读写，而注入半边只是一组纯函数。
 * 默认值必须和设置住在同一侧，否则注入半边改设置时拿不到"留空回退成什么"。
 *
 * 约定：设置里存的空串 / 纯空白 = 用这里的默认值（`resolvePrompt`）。
 * 这样老 settings.json、脏数据、用户手滑清空都不会让某条通道静默失效。
 */

/**
 * 提示词刻意写短：常驻策略段和每段表头都会进**每一轮**的系统上下文，重复一遍
 * 「取正文 / 定位 / 屏蔽」就是每个会话都在浪费 token。统一口径只在策略段说一次，
 * 各段表头只保留自己的身份说明（规则段例外：历史解析要认表头里的 摘要 + memory_get）。
 */

/** 每轮召回（长文形态）的表头。 */
export const DEFAULT_RECALL_PROMPT = '相关记忆（正文用 memory_get，无关用 memory_block 屏蔽）：'

/** 印象形态召回的默认表头。 */
export const DEFAULT_IMPRESSION_PROMPT = '相关记忆摘要：'

/** 会话摘要正文的表头。 */
export const DEFAULT_DIGEST_PROMPT = '已有记忆摘要（按重要度；无关用 memory_block，过时/写错才 memory_forget）：'

/** 摘要里"被截断记录的标签索引"表头。 */
export const DEFAULT_DIGEST_HINT_PROMPT = '相关记忆索引（正文未注入）：'

/** 标签索引结尾那句指路。 */
export const DEFAULT_DIGEST_HINT_FOOTER = '未展开，取正文用 memory_get。'

/** 硬性规则常驻段（系统提示）的表头。 */
export const DEFAULT_RULES_PROMPT =
  '必须遵守的硬性规则（kind=rule，只注入摘要；每条的短 ID 用 memory_get 取全文，除非用户明确破例）：'

/** 规则增量块的表头（旧会话里补一条新增/变更的规则时用）。 */
export const DEFAULT_RULES_DELTA_PROMPT =
  '新增或变更的硬性规则（kind=rule，摘要；短 ID 用 memory_get 取全文，从现在起遵守）：'

/** 流程索引（系统提示里的 procedure 目录）表头。 */
export const DEFAULT_PROCEDURES_PROMPT = '相关流程索引（用 memory_get <id> 取全文）：'

/** 轮末提醒正文。 */
export const DEFAULT_TURN_END_PROMPT = '有可复用结论（决策、踩坑、流程、口径）就先 memory_save 记一条再继续。'

/** 「记忆使用策略」常驻段全文（整段可改）。 */
export const DEFAULT_POLICY_PROMPT = `## 记忆系统

本会话挂本地记忆库：memory_search / memory_list / memory_get / memory_save / memory_forget / memory_scopes / memory_block（会话 / 项目 / 全局 / 自定义作用域）。

- 不确定以往做法、约定、坑，或用户说「上次 / 之前 / 还是那样」→ 先 memory_search，再 memory_get 取正文；查到就复用并说明来源。同一会话已出现过的记忆只回 ID（上下文去重），要正文直接用 memory_get。
- 命中范围外默认不弹审批，只给作用域清单与用途；确认相关再用 memory_search(requestApproval=true) 或 memory_scopes(request) 申请（按作用域屏蔽会弹审批，谨慎）。查目录 / 权限用 memory_scopes(list)。
- 自定义作用域传裸名（dsh-plugin-dev）；展示名 custom:xxx / project:<路径> / session:<id> 中后两者可直接传。新建自定义作用域 memory_save 要带 scopeDescription；supersedes 跨作用域修正旧记忆必须显式带 scope、用 36 位完整 id，且目标作用域要有写权限。
- 普通限制下每次 memory_* 都要带 description（一句话说明本次用途）。
- 无关记忆用 memory_block({id}) 降噪：可逆、不删除数据、可 unblock 复原；memory_forget 只删过时/写错的，别删别人的。
- 查不到：低风险按现有风格推断并标注假设；高风险 / 不可逆 / 外部系统 / 凭据 / 发布先问用户，给 2~3 个选项和推荐。
- 记忆与现场冲突以现场为准，更新过时记忆并告知。有可复用结论先 memory_search 去重再 memory_save。`

/**
 * 设置里的提示词 → 实际生效的文本：空串 / 纯空白 / 非字符串一律回退内置默认。
 *
 * 注入路径绝不能因为"用户把文本框清空了"就少一段上下文，所以这里只做兜底，
 * 不做长度限制（提示词多长是用户的自由，token 预算由各自的预算字段管）。
 */
export function resolvePrompt(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}
