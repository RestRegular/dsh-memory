/**
 * 注入审计:每次摘要/召回评估都留一条结构化记录。
 *
 * 第一版不要求复杂 UI:记录放在内存环形缓冲里,provider 通过
 * `attachInjectAudit()` 挂上,面板 `GET /memory/api/audit?session=` 读取。
 * 不记录任何凭据/令牌;检索查询会先过凭据脱敏,再最多截到 200 字。
 */

import { redactSecrets } from '../../memory-local/src/secrets.ts'

export interface AuditOmission {
  id: string
  reason: string
}

export interface AuditBudget {
  budget: number
  used: number
  remaining: number
}

export interface InjectAuditEvaluation {
  at: number
  sessionId?: string
  turn?: number
  step?: number
  /** turn_start / phase_change / before_high_risk_tool / tool_failure / digest / rules ... */
  trigger: string
  /** 当前任务阶段;无法判断时显式写 unknown,不伪造。 */
  phase: string
  query?: string
  candidates: number
  contentIds: string[]
  hintIds: string[]
  omitted: AuditOmission[]
  dedupSkipped: number
  budgets: Record<string, AuditBudget>
  retrieval: { ok: boolean; count: number; error?: string }
  /** 规则段额外统计。 */
  rules?: {
    injected: number
    omittedTopK: number
    omittedBudget: number
    omittedSuperseded: number
    mandatory: number
    mandatoryOmitted: number
  }
  /** 工具失败/高风险信号的结构化分类;不保存原始参数。 */
  signal?: { reason: string; errorClass?: string; tool?: string }
  error?: string
}

const MAX_ENTRIES = 200

export class InjectAuditStore {
  private entries: InjectAuditEvaluation[] = []

  record(entry: InjectAuditEvaluation): void {
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
  }

  /** 最新在前;可按会话过滤。 */
  list(sessionId?: string): InjectAuditEvaluation[] {
    const list = sessionId === undefined
      ? this.entries
      : this.entries.filter((entry) => entry.sessionId === sessionId)
    return [...list].reverse()
  }

  clear(): void {
    this.entries = []
  }
}

/** 查询文本里可能带用户内容:截断并折叠空白,不写凭据。 */
export function auditQuery(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  return redactSecrets(text).replace(/\s+/g, ' ').trim().slice(0, 200)
}

export function auditBudget(budget: number, used: number): AuditBudget {
  return { budget, used, remaining: Math.max(0, budget - used) }
}
