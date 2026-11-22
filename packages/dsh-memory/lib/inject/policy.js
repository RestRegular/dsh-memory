/**
 * 「记忆使用策略」常驻段:告诉模型什么时候查、查到怎么用、查不到怎么办。
 * 只写操作口径,不写具体记忆内容 —— 内容由摘要 / 召回 / 规则段负责。
 *
 * 0.45.0 起这段是**可改设置**（`policy.prompt`），默认文本搬到 provider 半边
 * （`inject-prompts.ts`）与其它通道的默认提示词住在一起；这里只做转出，
 * 保持既有 import { POLICY_TEXT } 的调用点与契约测试不变。
 */
import { DEFAULT_POLICY_PROMPT } from '../provider/inject-prompts.js'

export const POLICY_TEXT = DEFAULT_POLICY_PROMPT


//# sourceURL=source/memory-inject/src/policy.ts