# dsh-memory 注入审计（Inject Audit）实现审查

> **后续状态**：0.12.1 已按本审查实施审计 v2（schema、评估/投递分离、失败记录、容量/API/UI）；实现详情见 [`docs/audit-v2-implementation-report.md`](audit-v2-implementation-report.md)。本文保留为 v1 基线审查记录。

> **审查对象**：`@restregular/dsh-memory` 0.11.1，提交 `fa5e297`  
> **审查日期**：2026-10-22  
> **审查范围**：注入审计的存储、四个记录点、provider 挂载、面板 HTTP API、相关测试与文档  
> **审查方式**：静态代码走查 + 现有测试执行 + 与 README / CHANGELOG 对照  
> **运行验证**：`npm test` 共 312 项，311 通过、1 跳过、0 失败；`GET http://127.0.0.1:54458/memory/api/audit` 返回 `LOGIN_REQUIRED`，本次未取得真实运行条目。本文不包含线上样本，示例 JSON 均标注为“按当前代码构造的示意”。

---

## 结论摘要

**一句话结论：链路是通的、代码是克制的，但当前实现更准确的定位是“进程内、有界的注入诊断环”，而不是可追责的审计日志。它已经能回答“这次评估选了什么”，但还不能可靠回答“为什么没注入、是否真的进入上下文、重启后还能不能查”，并且 `signal.query` 绕过了脱敏。**

### 分维度评级

| 维度 | 评级 | 说明 |
| --- | --- | --- |
| 功能完整性 | **B** | 摘要、规则、普通召回、信号召回的统计都已覆盖；规则增量、策略段、轮末提醒、失败分支仍有缺口 |
| 数据正确性 | **B-** | 计数与预算大多可信；但“评估记录”早于“消息投递”，且部分失败路径没有记录 |
| 隐私与安全 | **C+** | 召回查询做了凭据脱敏；信号查询直接落原文，与“不记录任何凭据/令牌”的声明冲突 |
| 可追溯性 | **D+** | 进程内、最多 200 条、全局淘汰、无持久化、无序号；长会话会把会话开头的摘要记录挤掉 |
| 可运维性 | **C** | 有 HTTP 读取接口，但没有 UI、分页、按触发源过滤、容量/丢弃统计、清理入口 |
| 测试覆盖 | **C+** | 环形缓冲、脱敏函数、面板路由有测试；记录点本身几乎没有集成测试 |
| 文档一致性 | **C** | README 只有一句 FAQ；CHANGELOG 说记录了“正文、标签”，实际主要是 id 与计数 |

### 最重要的五个问题

| 编号 | 严重度 | 问题 | 直接后果 |
| --- | --- | --- | --- |
| A-01 | **P1** | 信号观察记录使用未脱敏的 `signal.query` | 工具 description、assistant 文本片段里的令牌/密码可能进入审计并经面板读出 |
| A-02 | **P1** | 审计在消息真正追加前写入，没有 `delivered` 字段 | 审计无法说明消息是否由本次追加；被格式保护/宿主拒绝时甚至可能没进上下文 |
| A-03 | **P1** | 摘要/规则的加载失败被静默吞掉；摘要失败前已标记 done | 用户看到“没有摘要”，审计里也查不到失败原因，而且本会话不再重试 |
| A-04 | **P1** | 200 条全局环形缓冲，无每会话/每通道保留 | 一个繁忙会话会挤掉其它会话、以及自己的首轮摘要/规则记录 |
| A-05 | **P1** | 条目没有记录实际作用域、topK/上限、设置快照 | 无法回答“为什么这条没召回”，只能看到候选数 |

### 建议的优先级

1. **0.11.x 安全热修**：所有用户/工具来源的文本统一走 `auditQuery`，包括 `signal.query`；补测试。
2. **0.12 正确性**：引入 `delivery`（是否真的追加、被什么拦下）；失败也记录；记录 `scopes` 与 `limits`。
3. **0.12 保留策略**：按会话/通道保留，或改为可轮转的持久化；至少暴露 `capacity` / `dropped`。
4. **再做产品化**：面板 UI、过滤/分页、导出；若要“合规审计”，需要追加写、防篡改、访问控制，当前实现不具备。

---

## 1. 审计应该回答什么

结合 `audit.ts` 的注释和 0.9.6 的 CHANGELOG，这项能力至少应回答五个问题：

| 编号 | 问题 | 当前 v1 的答案 |
| --- | --- | --- |
| Q1 | 这次注入由什么触发？ | **部分**：普通召回、信号召回、规则、摘要有记录；规则增量、轮末提醒、策略段没有 |
| Q2 | 检索用了哪些作用域、哪些设置？ | **否**：没有 `scopes`、`topK`、`maxItems`、`autoRecall` 快照 |
| Q3 | 有哪些候选、选中了谁、谁被省略、为什么？ | **部分**：摘要/召回有 id 和原因；规则只有计数；部分过滤原因（标签不匹配、已退役）不可见 |
| Q4 | 去重跳过了多少？检索是否失败？ | **部分**：召回有 `dedupSkipped` 与 `retrieval.ok`；摘要/规则固定写 0 或 `ok: true`；失败分支不完整 |
| Q5 | 最终真的进入模型上下文了吗？ | **否**：记录发生在最终消息组装与追加之前，没有投递结果 |

Q1~Q5 里，v1 完整回答的是 **0 个**；这并不代表实现没有价值，而是说明它的定位应被准确描述为“评估快照”，不能当成“上下文事实”。

---

## 2. 实现全景

### 2.1 组件与职责

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `InjectAuditStore` | `source/memory-inject/src/audit.ts` | 进程内数组，最多 200 条；`record` / `list` / `clear` |
| 记录点 | `source/memory-inject/src/apply.ts` | 摘要、规则、召回、信号观察四处调用 `recordAudit` |
| 信号队列 | `source/memory-inject/src/signals.ts` | 每个会话只保留最新一条待消费信号 |
| provider 挂载 | `source/memory-local/src/index.ts` | `attachInjectAudit(sink)` 保存 sink；`injectAudit(sessionId)` 读取 |
| 面板 API | `source/memory-panel/lib/index.js` | `GET /memory/api/audit?session=` |
| 前端 | `source/memory-panel/lib/client.js` | **没有审计入口**（该文件不含 `audit` 字样） |
| 测试 | `source/memory-inject/test/reliability.test.ts`、`source/memory-panel/test/settings-api.test.ts` 等 | 覆盖存储上限、脱敏函数、面板路由 |

### 2.2 单步数据流

```text
session/event
  ├─ tool/call        ──► highRiskSignal ──┐
  ├─ tool/result      ──► failureSignal ───┤
  ├─ assistant/message│ todo/write│ command/run│ goal/change
  │                   ──► textTagSignal ───┤
  └─ compaction/*     ──► 清空注入状态，不写审计
                                           ▼
                                  observeSignal()
                                           │ 立即写一条“信号观察”审计
                                           ▼
agent/pre-step（每个激活实例一个）
  ├─ rules-delta      ──► parts.push（不写审计）
  ├─ nudge            ──► parts.push（不写审计）
  ├─ digest           ──► recordAudit（仅当 render 返回非空）
  ├─ rules            ──► recordAudit（step===1，重新 render 一次）
  └─ recall           ──► recordAudit（无论 text 是否存在）
                                           │
                                           ▼
                              parts.join → hasRecallMessage / isWellFormedMessage
                                           │
                                           ├─ 通过：追加一条 user 消息
                                           └─ 拦下：直接返回 decision（**审计已记录**）
```

关键事实：**规则段在系统提示里由 `systemPrompt.section()` 另行渲染，审计里那次 `renderRules` 是第二次独立渲染，不是同一份文本。** 这为 A-07 埋下伏笔。

### 2.3 生命周期

```text
apply(ctx)
  ├─ new InjectAuditStore()                 // 每个激活实例一个
  ├─ attachAudit(memory)                    // 仅在 pre-step / session/event 时尝试
  │    └─ provider.injectAuditSink = store  // 后注册覆盖先注册
  └─ 进程退出                                // 全部丢失，没有任何落盘
```

没有 `dispose` 时清空 sink；插件半边重载后，provider 里可能仍指向旧 store。

### 2.4 代码地图

| 关注点 | 文件 | 关键行 |
| --- | --- | --- |
| 环形缓冲、上限、查询 | [`source/memory-inject/src/audit.ts`](../source/memory-inject/src/audit.ts) | 53、58-61、64-69 |
| 查询脱敏 | [`source/memory-inject/src/audit.ts`](../source/memory-inject/src/audit.ts) | 77-80 |
| 预算对象 | [`source/memory-inject/src/audit.ts`](../source/memory-inject/src/audit.ts) | 82-84 |
| 信号观察记录 | [`source/memory-inject/src/apply.ts`](../source/memory-inject/src/apply.ts) | 227-244 |
| 摘要记录 | [`source/memory-inject/src/apply.ts`](../source/memory-inject/src/apply.ts) | 457-471 |
| 规则记录 | [`source/memory-inject/src/apply.ts`](../source/memory-inject/src/apply.ts) | 476-498 |
| 召回记录 | [`source/memory-inject/src/apply.ts`](../source/memory-inject/src/apply.ts) | 519-535 |
| 最终消息保护 | [`source/memory-inject/src/apply.ts`](../source/memory-inject/src/apply.ts) | 539-551 |
| 召回过滤与失败 | [`source/memory-inject/src/inject.ts`](../source/memory-inject/src/inject.ts) | 336-341、352-367 |
| 摘要渲染与截断 | [`source/memory-inject/src/digest.ts`](../source/memory-inject/src/digest.ts) | 200-290 |
| 规则渲染与统计 | [`source/memory-inject/src/rules.ts`](../source/memory-inject/src/rules.ts) | 79-177 |
| provider 挂载 | [`source/memory-local/src/index.ts`](../source/memory-local/src/index.ts) | 548-555 |
| 面板路由 | [`source/memory-panel/lib/index.js`](../source/memory-panel/lib/index.js) | 243-248 |

---

## 3. 数据模型

### 3.1 条目结构

当前接口（`audit.ts:22-51`）的核心字段：

```ts
interface InjectAuditEvaluation {
  at: number
  sessionId?: string
  turn?: number              // 从未写入
  step?: number              // 从未写入
  trigger: string            // 注释列了 turn_start / phase_change / ... / digest / rules
  phase: string              // 无法判断时写 unknown
  query?: string
  candidates: number
  contentIds: string[]
  hintIds: string[]
  omitted: AuditOmission[]
  dedupSkipped: number
  budgets: Record<string, AuditBudget>
  retrieval: { ok: boolean; count: number; error?: string }
  rules?: { ... }
  signal?: { reason: string; errorClass?: string; tool?: string; tag?: string; source?: string }
  error?: string             // 从未写入
}
```

### 3.2 字段填充矩阵

图例：`●` 有真实值，`○` 固定值/空值，`—` 不适用。

| 路径 | trigger | phase | query | candidates | contentIds | hintIds | omitted | dedupSkipped | budgets | retrieval | signal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 摘要成功 | `turn_start` | `unknown` | — | ● | ●（bodyIds） | ● | ●（仅 id/reason） | ○ 0 | digest + hints | `ok:true`，count=候选数 | — |
| 规则（step 1） | `rules` | `unknown` | — | ● | ○ 空 | ○ 空 | ○ 空（只有 `rules.*` 计数） | ○ 0 | rules | `ok:true`，count=候选数 | — |
| 召回成功 | 信号 reason 或 `turn_start` | 信号 phase 或 `detectPhase` | ●（脱敏） | ●（过滤后） | ● | ○ 空 | ● | ● | recall | ● | 信号触发时有 |
| 召回检索失败 | `turn_start` / 信号 reason | 同上 | ●（脱敏） | ○ 0 | ○ 空 | ○ 空 | ○ 空 | ○ 0 | recall | `ok:false`，error=`retrieval_failed` | 信号触发时有 |
| 信号观察 | 信号 reason | 信号 phase | ●（**未脱敏**） | ○ 0 | ○ 空 | ○ 空 | ○ 空 | ○ 0 | ○ 空 | `ok:true`，count=0 | ● |
| 规则增量 | — | — | — | — | — | — | — | — | — | — | — |
| 策略段 / 轮末提醒 | — | — | — | — | — | — | — | — | — | — | — |

这张表是后文很多结论的来源：**同一字段在不同路径上的语义并不一致**，例如 `retrieval` 在摘要/规则里其实是“列表加载”，在信号观察里根本没有发生检索。

### 3.3 容量、排序与生命周期

| 属性 | 当前行为 | 影响 |
| --- | --- | --- |
| 容量 | 全局 200 条（`audit.ts:53`） | 多会话共享一个环；繁忙会话挤掉空闲会话 |
| 淘汰 | 从数组头部 `splice`，淘汰最旧 | 首轮摘要/规则最早被淘汰 |
| 排序 | `list()` 反转插入顺序，不按 `at` 排序 | 正常流程等价于时间倒序；未来合并/导入数据会错序 |
| 会话过滤 | 记录在全局环**之后**过滤 | 某个会话可能一条都不剩 |
| 持久化 | 无 | 重启/重载即丢失 |
| 丢弃统计 | 无 | 看不到“已经丢了多少” |
| 清空 | `clear()` 存在，但没有任何调用点/路由 | 死代码 |
| 索引 | 无 id / seq | 无法引用某一条、无法做游标分页 |

---

## 4. 逐路径审查

### 4.1 摘要（digest）

**记录点**：`apply.ts:457-471`。

记录内容：

- `trigger: 'turn_start'`、`phase: 'unknown'`
- `candidates`：`renderDigest` 收到的记录总数
- `contentIds`：正文实际进入上下文的 id
- `hintIds`：只进入标签索引的 id
- `omitted`：把 `digestStats.omitted` 映射成 `{ id, reason }`
- `budgets.digest` / `budgets.hints`
- `retrieval: { ok: true, count: candidates }`

做得好的地方：

- 摘要统计本身很完整：`candidates / injected / omittedTopK / omittedBudget / omittedSuperseded / omittedExpired / hint.*` 互斥且可核对（`digest.ts:262-289`）。
- 正文与标签索引分预算，审计也分两个 budget，口径清楚。

缺口：

1. **渲染为空时完全不记录**。`renderDigest` 在“全部退役/全部过期”时返回 `null`（`digest.ts:259-260`），`digestStats` 保持 `undefined`，`apply.ts` 不写审计。用户看到“没有摘要”，审计里也没有任何解释。
2. **加载失败完全不记录**。`MemoryDigester.maybeDigestDetailed` 先 `markDone`，再 `list()`；`list()` 抛错时直接 `return undefined`（`inject.ts:432-440`）。这带来两个后果：
   - 本会话之后不再尝试摘要；
   - 审计里没有失败条目，无法区分“没有记忆”与“加载失败”。
3. **省略原因被降级**。`digest.ts` 的 `omitted` 带有 `kind` 与 `tags`（`digest.ts:211、216、233、239、248`），但 `apply.ts:463` 只映射 `{ id, reason }`，标签/类型信息在审计层丢失。
4. **摘要没有自己的 `trigger`**。接口注释把 `digest` 列为一种 trigger，实际写的是 `turn_start`，消费者无法仅凭 `trigger` 区分摘要与普通召回。
5. **`phase` 被固定成 `unknown`**。此时 `userQuery` 已经可用（`apply.ts:425`），`detectPhase` 也在作用域内；即使判断不出，至少可以记录“为什么是 unknown”，而不是所有摘要都长一样。
6. **`retrieval` 语义不成立**：这里发生的是 `list()`，不是检索；`count = candidates` 会让人误以为“检索命中 200 条”。

### 4.2 硬性规则（rules）

**记录点**：`apply.ts:476-498`。

记录内容：

- `trigger: 'rules'`、`phase: 'unknown'`
- `candidates`：`renderRules` 的候选数
- `contentIds`、`hintIds`、`omitted` 全部为空
- `budgets.rules`
- `rules`：注入数、top_k/预算/退役省略数、mandatory 总数与省略数
- `retrieval: { ok: true, count: candidates }`

做得好的地方：

- 规则段有 `mandatory` 优先与溢出警告（`rules.ts:140-152`），审计把关键计数带出来了。
- 只在 `step === 1` 记录，避免每步刷爆 200 条缓冲，这个取舍是合理的。

缺口：

1. **不知道具体注入了哪些规则**。`contentIds` 固定为空，`omitted` 固定为空；`rules` 只有计数。要定位“哪条 mandatory 被挤掉”只能重新查库。
2. **审计与系统提示可能不是同一份渲染**：
   - 审计使用 `scopes`（`apply.ts:415`，来自 `resolveInjectScopes`，包含 `extraScopes` 与 fork 父会话）；
   - 系统提示使用 `memory.resolveReadScopes(context.agent)`，失败时退回 `['global']`（`apply.ts:374-380`），不包含 `extraScopes`/父会话；
   - 两者都可能因为不同的快照/不同的调用时机给出不同结果。
3. **系统提示注册失败时仍然“有规则”**。`ctx.inject(['systemPrompt'])` 的注册在 `try/catch` 里（`apply.ts:359-389`）；老宿主或重复注册失败时，规则段根本不会进入提示，但 pre-step 的审计仍会写一条“规则已评估/已注入”的记录。
4. **规则增量不在审计内**。`apply.ts:434-437` 只把 delta 文本塞进 `parts`，没有记录哪些规则被补、为什么补（新增还是编辑）、预算多少。当某一轮只有 delta 时，整条注入在审计里是空白的。
5. **`rules` 统计缺 `active` 与 `mandatoryInjected`**。`RulesStats` 有这两个字段（`rules.ts:59-70`），审计对象没带；排查“候选多少、激活多少、mandatory 进了几条”要多一步心算。
6. **只在 step 1 记录**，如果系统提示在后续 step 因规则变更而重渲染，审计不会反映。这是有意的容量取舍，但应在文档里写明。

### 4.3 普通召回与信号召回（recall）

**记录点**：`apply.ts:519-535`；核心逻辑在 `inject.ts:322-381`。

记录内容：

- `trigger`：有可用信号时为 `signal.reason`，否则 `turn_start`
- `phase`：信号 phase，或 `detectPhase(userQuery)`
- `query`：`recall.query` 经 `auditQuery` 脱敏、截 200 字
- `candidates`：经过标签过滤、退役过滤后的候选数
- `contentIds`：正文实际写入的 id
- `omitted`：`top_k` / `budget`
- `dedupSkipped`
- `budgets.recall`
- `retrieval`：来自 `MemoryInjector`
- 信号触发时附带 `signal`

做得好的地方：

- 召回失败不会打断 agent 循环，而且返回 `retrieval.ok: false`，审计能区分“失败”与“成功但 0 条”（`inject.ts:336-341`）。
- 召回查询做了凭据脱敏（`apply.ts:523`），这是全篇最重要的一条正面安全设计。
- 去重按会话 + id/版本管理，`dedupSkipped` 能解释“为什么没有新正文”。
- 信号触发的召回会带 `signal` 结构，能看出工具名、错误类别、命中标签、来源。

缺口：

1. **过滤原因不可见**。`candidates` 是标签过滤（`inject.ts:352-354`）与退役过滤（`inject.ts:355-356`）之后的数量；`retrieval.count` 是过滤前的原始命中数。差出来的那部分既不在 `candidates`，也不在 `omitted`，无法区分“标签不匹配”与“已退役”。
2. **预算把全部候选挤掉时，`omitted` 也丢了**。`renderRecallBlock` 在 `lines.length === 0` 时直接 `return null`（`inject.ts:244-245`），已经累积的 `omitted` 被丢弃；`apply.ts` 只看到 `recall` 对象里的空 `omitted`。结果是一条 `candidates > 0`、`contentIds` 空、`omitted` 空的记录，没有任何原因。
3. **记录早于投递**。recall 的 `recordAudit` 发生在该通道 `parts.push` 之后、但整条消息组装之前（`apply.ts:517-535`），而 `hasRecallMessage`（`apply.ts:543`）与 `isWellFormedMessage`（`apply.ts:550`）仍可能拦下整条消息。审计依然显示 `contentIds`，没有 `delivered: false`。
4. **跳过路径没有记录**。以下情况完全不写审计：
   - `recall` 关闭；
   - `pickQueryText` 为空；
   - `skipNormalRecall` 为真（`apply.ts:502-504`，同一用户 query 的后续 step 跳过重复检索）。
   
   这些是“为什么这次没有注入”的常见答案，恰恰查不到。
5. **`candidates` 与 `contentIds` 的语义在“文本相同”分支会漂移**。`inject.ts:370-372` 在 `block.text === lastText` 时返回 `ids` 但不返回 `text`；这些 id 并不是本次新注入的，却会出现在 `contentIds` 里，同时 `dedupSkipped` 又加了它们。
6. **没有记录作用域**。普通召回与信号召回分别使用 `scopes` 与 `autoScopes`（`apply.ts:505`），但审计只记录结果，不记录这次到底搜了哪些 scope。排查“跨项目误召回/漏召回”时这是第一现场。
7. **没有记录 `topK` 与 `impression` 设置**。`budgets` 只有预算，没有 `topK`；`omitted: top_k` 只在有溢出时出现，无法从审计反推上限。
8. **检索错误信息被吞掉**。`inject.ts:336-341` 只给出 `'retrieval_failed'`；具体是向量服务超时、embedding 失败还是别的原因，审计里看不到。
9. **`auditQuery` 被调用两次**（`apply.ts:523` 的条件判断与取值各一次），对大 query 是重复的全量扫描。

### 4.4 信号观察（signal）

**记录点**：`apply.ts:227-244`，调用点在 `315 / 330 / 346`。

记录内容：

- `trigger: signal.reason`、`phase: signal.phase`
- `query: signal.query`（**原文**）
- `candidates: 0`、所有 id 数组为空、`budgets: {}`
- `retrieval: { ok: true, count: 0 }`
- `signal: { reason, errorClass?, tool?, tag?, source? }`

问题：

1. **这是最严重的一处脱敏缺口**。`signal.query` 可能来自：
   - 工具调用的 `description`（`signals.ts:194`）；
   - assistant 可见文本的片段（`signals.ts:228`）；
   - 失败调用的 description 或错误类别（`signals.ts:325`）。
   
   这些文本可能包含令牌、密码、用户数据。`audit.ts` 顶部声明“不记录任何凭据/令牌；检索查询会先过凭据脱敏”，但这条路径没有调用 `auditQuery`。`reliability.test.ts:166-172` 只测了 `auditQuery` 函数本身，没有测“信号记录也会脱敏”。
2. **条目语义错误**。它把一个“尚未执行的观察”写成了 `retrieval.ok: true, count: 0`，看起来像一次成功但零命中的检索；实际上还没有检索。消费者无法区分“观察”与“评估”。
3. **被覆盖的信号没有标记**。`BehaviorSignalStore.note` 每个会话只保留最新一条 pending（`signals.ts:365-378`）。旧信号已经写了审计、但永远不会被消费；审计里没有 `superseded`/`dropped` 标记，会高估实际召回覆盖。
4. **同一信号会出现两条记录**：观察时一条，消费后召回评估又一条；两条没有共享 `signal.key` 或 correlation id，无法配对。
5. **`signal.key` 没有落库**。这个 key 含失败描述/标签的 hash（`signals.ts:328`），是去重与关联的最好线索，但审计只存了 reason/tool/tag/source。
6. **重复信号被静默抑制**。`note()` 返回 `false` 时不写审计，这是合理的降噪，但没有“重复次数”统计，无法判断信号是否风暴。

### 4.5 规则增量、策略段、轮末提醒

| 路径 | 是否审计 | 说明 |
| --- | --- | --- |
| 规则增量（`rulesDelta`） | **否** | `apply.ts:434-437` 只 `parts.push(delta)`；无法知道补了哪些规则、预算多少、为什么补 |
| 记忆使用策略（policy） | **否** | 由 `systemPrompt.section` 渲染（`apply.ts:363-367`），不属于“每次评估”环 |
| 轮末提醒（nudge） | **否** | `apply.ts:438-441` 只 `parts.push`；它确实会改变上下文，但审计不可见 |

如果审计的目标是“解释模型为什么看到这段上下文”，这三条都需要至少一条轻量记录（文本哈希、字数、是否追加），否则“上下文来源”仍然不完整。

### 4.6 压缩（compaction）

`apply.ts:289-299` 在 `compaction/start|end` 时清空注入状态、信号、摘要 done、scope 缓存、tag 缓存、调用元数据，但**不清空审计**，也不写一条“上下文已重建”的标记。

后果：审计里的旧摘要/召回记录看起来与压缩后的新上下文连续，排查“压缩后为什么又注入了/为什么没再注入”时缺少分界点。

---

## 5. 发现清单

严重度定义：

- **P1 / 高**：影响安全边界、审计可信度或关键诊断能力，建议在下个补丁/小版本修。
- **P2 / 中**：明显降低可用性、可解释性或可维护性，建议排期。
- **P3 / 低**：代码/文档/体验上的小问题。

### P1

#### A-01 信号查询未脱敏（安全）

**证据**：`apply.ts:233` 直接把 `signal.query` 写入审计；`audit.ts:77-80` 的脱敏函数只被召回路径使用（`apply.ts:523`）。`audit.ts:5-6` 与 `CHANGELOG.md:74` 都声明不记录凭据。

**影响**：工具 description、assistant 文本片段里的 `token=...`、`sk-...`、`ghp_...` 等会原样进入内存审计；任何能调用面板 `/audit` 的客户端都能读到。即便面板有登录围栏，这也违反了最小化与声明一致性。

**建议**：

```ts
// apply.ts observeSignal
query: auditQuery(signal.query),
```

并把“所有进入审计的自由文本都必须经过同一个 `sanitizeAuditText`”写成代码约束（例如只暴露 `recordAudit` 的受控入口，禁止调用方直接塞 `query`）。测试要覆盖 `signal.query` 带令牌时不出现原文。

#### A-02 记录早于投递，缺 `delivered`

**证据**：`apply.ts:457-535` 在各通道组装 `parts` 的过程中写审计；`apply.ts:539-551` 才决定是否追加最终消息，`hasRecallMessage`（543）与 `isWellFormedMessage`（550）都可能直接返回。

**影响**：审计无法区分“评估选中”与“本次真的追加”。`hasRecallMessage` 命中时（通常意味着另一个激活实例已经放了同样文本），本实例的 `contentIds` 会被记成自己的投递；`isWellFormedMessage` 命中时消息确实没进上下文。两种情况下都没有 `delivered` 字段可供判定，事故复盘容易把评估误读成投递。另外，`inject.ts:370-372` 在“文本与上次相同”时返回 `ids` 但不返回 `text`，这些 id 会进入 `contentIds`，但本次并没有新文本追加。

**建议**：

- 把条目拆成 `evaluation` 与 `delivery` 两阶段，或给条目加：
  ```ts
  delivery?: {
    attempted: boolean
    appended: boolean
    suppressedBy?: 'dedup' | 'malformed' | 'empty' | 'rejected' | 'aborted'
    textChars?: number
    textHash?: string
  }
  ```
- 在消息追加成功后回填/补写 `delivery`；被拦下时也写一条 `suppressed` 记录。
- 注意：`injectionState.markContent`（`apply.ts:451-454`、`inject.ts:374-379`）也发生在投递前；如果 `isWellFormedMessage` 真的拦下一次，去重状态会误以为已注入。修复投递语义时一并考虑。

#### A-03 摘要/规则失败静默；摘要失败仍标记 done

**证据**：

- `inject.ts:432-440`：`markDone(sessionId)` 在 `list()` 之前；`list()` 抛错时 `return undefined`。
- `apply.ts:445-472`：只有 `digestStats` 存在才写审计。
- `apply.ts:476-498`：`memory.listSync` 或 `renderRules` 抛错被 `catch` 吞掉，不写审计。

**影响**：用户看到“没有摘要/没有规则”，审计里也查不到原因；而且本会话的摘要不会重试，属于“静默降级 + 不可诊断”的组合。

**建议**：

- `MemoryDigester` 返回结构化结果：`{ ok: true, stats }` / `{ ok: false, error }` / `{ ok: true, empty: true }`，不要用 `undefined` 混合表达多种状态。
- 失败时写 `error: { stage: 'digest_load', code }`；空结果也写一条 `candidates: 0`。
- 是否在失败时标记 done 应可配置；至少把“已放弃重试”写进审计。

#### A-04 200 条全局环，关键记录先被淘汰

**证据**：`audit.ts:53` 全局上限 200；`record` 从头部淘汰（`audit.ts:58-61`）；`list(sessionId)` 在全局淘汰之后过滤（`audit.ts:64-69`）。

**影响**：

- 一个会话的工具调用/信号观察很容易超过 200 条；首轮摘要与规则记录最先消失。
- 多会话共享时，繁忙会话会把其它会话的记录全部挤掉；按会话查询可能返回空。
- 没有 `dropped` 计数，使用者不知道“看到的不是全部”。

**建议**：

- 每会话独立环（例如 200 条/会话）+ 全局总量上限（例如 2000），或按通道保留配额（digest/rules 各保留最近 N 条）。
- 记录 `capacity` 与 `dropped`，在 API 返回。
- 若要长期追溯，改为追加写文件（JSONL）+ 轮转，而不是内存环。

#### A-05 缺少作用域、设置与上限快照

**证据**：`InjectAuditEvaluation` 没有 `scopes`、`topK`、`maxItems`、`autoRecall` 字段（`audit.ts:22-51`）；`apply.ts` 也没有传。

**影响**：最常见的排查问题是“为什么这条没被召回/为什么召回了别的项目”。没有实际 scope 列表，就无法判断是 scope 解析错了、标签没命中、还是 topK/预算截断。当前只能看到结果计数。

**建议**：至少添加：

```ts
scopes?: string[]
limits?: { topK?: number; maxItems?: number; maxQueryChars?: number }
```

并在 `recall`、`digest`、`rules` 三条路径写入**实际使用**的那一份（不是重新计算的）。如果担心路径泄露，可只存 scope 类型 + hash，但对本地单人工具，路径本身通常不是秘密。

### P2

#### A-06 `/audit` 不带 `session` 时返回所有会话

**证据**：`panel/lib/index.js:245-246`；`session === '' ? undefined : session`，而 `store.list(undefined)` 返回全部（`audit.ts:64-69`）。

**影响**：任何能访问面板的客户端都能读到所有会话的查询片段（即使已脱敏，仍可能包含用户文本/工具描述）。在单机单人场景可接受，但与“按会话查看”的预期不一致；`?session=` 空值也会静默变成“全部”。

**建议**：无 `session` 时返回 `400` 或明确标注 `scope: 'all'`；如果确实需要全局视图，增加显式 `?all=1`，并在 UI 上区分。

#### A-07 rules 审计与系统提示可能不是同一份

**证据**：系统提示使用 `memory.resolveReadScopes(context.agent)`（`apply.ts:374-380`）；审计使用 `readScopesFor`（`apply.ts:415`，`inject.ts:82-107`，包含 `extraScopes` 与父会话）；系统提示注册失败被 `catch` 吞掉（`apply.ts:386-388`）。

**影响**：审计可能显示“规则注入了 5 条”，但系统提示里只有 3 条（或 0 条）。这是审计可信度问题，不只是展示问题。

**建议**：让系统提示的渲染函数同时产出 stats，并把同一份 stats 交给审计；如果拿不到（老宿主/注册失败），审计显式写 `delivery.appended: false, reason: 'no_system_prompt'`。

#### A-08 信号观察条目把“观察”写成“检索成功”

**证据**：`apply.ts:234-235`：`candidates: 0`、`retrieval: { ok: true, count: 0 }`。

**影响**：任何按 `retrieval.ok` 或 `candidates` 聚合的消费者都会把观察当成一次零结果检索；无法区分“信号已排队”与“信号已消费”。

**建议**：加 `kind: 'signal' | 'evaluation'`（或 `stage`），信号条目不要伪造 `retrieval`；用 `pending: true` 表示尚未消费。

#### A-09 过滤/去重/预算省略不可见

**证据**：`inject.ts:352-356` 过滤标签不匹配与已退役记录；`inject.ts:244-245` 在所有候选都超预算时丢弃 `omitted`；`apply.ts:502-504` 跳过重复 query。

**影响**：出现 `candidates > 0` 但 `contentIds` 空、`omitted` 空时，无法知道是标签不匹配、superseded、预算、还是跳过。

**建议**：给 `omitted.reason` 增加 `tag_mismatch`、`superseded`、`skipped_same_query`；`renderRecallBlock` 即使没有可注入行也返回 `omitted`；审计记录 `skipped` 原因。

#### A-10 schema 无版本、死字段、弱类型

**证据**：`turn`/`step` 从未写入（`audit.ts:25-26`）；`error` 从未写入（`audit.ts:50`）；`trigger`/`phase`/`AuditOmission.reason` 都是 `string`（`audit.ts:11-14、27-30`）；没有 `v`/`seq`。

**影响**：字段存在但永远为空，消费者会误判；字符串枚举容易拼错；没有版本号，未来改结构时无法兼容；没有序号，难以引用单条记录。

**建议**：删除死字段或真正填充；用 union 类型；加 `v: 1`、`seq: number`、`id: string`；`turn/step` 至少在 pre-step 能拿到 `step`（`apply.ts:410`），应写入。

#### A-11 sink 生命周期：last-wins、无 detach、可能陈旧

**证据**：provider `attachInjectAudit` 只是赋值（`index.ts:548-550`）；`apply.ts:124-131` 只在本地记住 `attachedMemory`；没有 `dispose` 清空。

**影响**：重复激活/热重载时，后一个 store 覆盖前一个，前一个成为孤儿；插件半边卸载后，provider 仍持有旧 store，面板可能继续返回已停止更新的审计。多激活时，只有一个实例的记录可见。

**建议**：`attachInjectAudit(sink | null)` 支持解绑；apply 在 dispose 时置空；或让 provider 按 sink id 管理多个 store 并按会话合并。至少要检测“sink 已失效”。

#### A-12 API/UI 能力不足

**证据**：`panel/lib/index.js:243-248` 只支持 `session` 过滤；没有 `limit`、`trigger`、`since`、`cursor`；没有 `POST /audit/clear`；`client.js` 没有审计 UI（grep 不到 `audit`）。

**影响**：排查时只能拉全量 JSON 自己过滤；长会话/多会话下体验差；普通用户根本看不到这个能力，只能读 README 用 HTTP。

**建议**：

- `GET /audit?session=&channel=&trigger=&since=&limit=&cursor=`
- 返回 `total`、`capacity`、`dropped`、`nextCursor`
- `POST /audit/clear`（带确认/仅管理员）
- 面板加“诊断/审计”标签页：按会话、触发源、失败状态筛选，展示预算条与省略原因
- 明确文档：这是内存诊断，不是持久化审计。

#### A-13 规则增量/策略段/轮末提醒无审计

见 4.5。建议至少记录 `channel`、`textChars`、`textHash`、`appended`；规则增量还应记录 `ids` 与“新增/编辑”原因。

#### A-14 测试缺口

**现状**：

- `reliability.test.ts:151-172` 覆盖 200 条上限、按会话过滤、`auditQuery` 脱敏。
- `settings-api.test.ts:181-207` 覆盖面板路由与 session 过滤。
- `inject-settings.test.ts:118-124` 覆盖 provider 挂载/未挂载。
- 全量 312 项中 311 通过（1 项跳过）。

**缺口**：

| 缺口 | 风险 |
| --- | --- |
| 没有 `apply.ts` 记录点的集成测试 | 字段、触发条件、投递顺序漂移不会被发现 |
| 没有 `signal.query` 脱敏测试 | A-01 这类漏洞可以长期存在 |
| 没有失败路径测试（digest list 抛错、rules 抛错、recall 抛错） | A-03 无法防回归 |
| 没有“消息被 `hasRecallMessage`/`isWellFormedMessage` 拦下”的测试 | A-02 无法防回归 |
| 没有按会话/通道容量测试 | A-04 的淘汰行为不可预期 |
| 没有 schema 快照 | 字段改名/删除无感知 |
| 没有 compaction 后审计连续性测试 | 4.6 的分界问题 |

**建议**：把“构建审计条目”抽成纯函数（输入 `DigestStats`/`RecallResult`/信号/投递结果，输出条目），这样不必启动 cordis 就能做表驱动测试；再加一个最小的 apply 集成测试（fake ctx + fake memory）覆盖一次完整的 digest → recall → delivery 链路。

### P3

| 编号 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| A-15 | 文档与实现漂移 | `CHANGELOG.md:74` 说记录“正文、标签”，实际只存 id；`apply.ts:463` 丢掉了 `kind/tags`；README 只有 `README.md:372-375` 一句 FAQ | 文档改称“id/计数/原因”，补字段表、容量、生命周期、脱敏边界 |
| A-16 | 脱敏前先全量扫描、且调用两次 | `audit.ts:79` 先 `redactSecrets(text)` 再截 200；`apply.ts:523` 调两次 | 先截断到 200 再脱敏（记录长度），或提取 `auditQuery` 结果复用；对大消息避免全量正则 |
| A-17 | 压缩不写审计标记 | `apply.ts:289-299` | 写一条 `kind: 'lifecycle', event: 'compaction'`，或在返回中带 `contextEpoch` |
| A-18 | `clear()` 死代码、`list` 浅拷贝 | `audit.ts:71-73`、`64-69` | 要么接 API，要么删除；如需防止外部修改，返回条目副本 |

---

## 6. 隐私与安全

### 6.1 凭据脱敏的真实边界

`auditQuery` 调用 `redactSecrets`（`secrets.ts:19-30`），覆盖：

- PEM 私钥
- `sk-...`
- `ghp_/gho_/ghu_/ghs_/ghr_...`
- AWS `AKIA...`
- Slack `xox...`
- `Bearer ...`
- `api_key/secret/token/password/passwd/pwd` 赋值

这是一组保守的“形状匹配”，不是数据分类器：不符合形状的密码、内部 token、用户隐私文本仍会保留。它能降低风险，但不能支撑“绝不泄露”的承诺。

**当前唯一的硬伤是 A-01**：召回查询走了脱敏，信号查询没有。修复时应把“脱敏”放到 `recordAudit` 的边界上，而不是依赖每个调用方自觉。

### 6.2 访问面

- `/memory/api/audit` 复用了面板的 `refuseRequest`（`panel/lib/index.js:228-233`），会经过宿主 `connection.requestRejection` 或 loopback/Host/Origin 兜底。这个方向是对的。
- 但审计内容包含跨会话的查询片段；无 `session` 参数时返回全部。若未来支持多用户共享同一 DSH 实例，这会成为横向信息泄露点。
- 审计是内存态、可被同进程代码读取；没有完整性保护，不能作为“谁在何时改了什么”的证据。

### 6.3 建议的安全口径

1. 所有自由文本字段（`query`、未来可能新增的 `error.message`、`description`）在写入前统一 `sanitizeAuditText`。
2. 审计条目只存“解释所需的最小信息”：id、计数、原因、长度/哈希；不存正文、不存原始参数。
3. `/audit` 默认要求 `session`；全局视图需要显式参数与管理员权限。
4. 若要对外提供“审计”承诺，改为追加写 + 轮转 + 只读 API + 访问控制；当前内存环不满足。

---

## 7. API、provider 契约与前端

### 7.1 面板 API

| 项 | 当前 |
| --- | --- |
| 方法/路径 | `GET /memory/api/audit` |
| 查询参数 | `session`（空字符串等价于全部） |
| 成功响应 | `{ ok: true, value: { entries: InjectAuditEvaluation[] } }` |
| 失败 | 501（provider 无 `injectAudit`）、503（无 `memory.store`）、403（围栏拒绝） |
| 分页 | 无 |
| 过滤 | 仅 session |
| 容量信息 | 无 |
| 清理 | 无 |
| 前端入口 | 无 |

一个实现细节：路由在 `/audit` 之前先检查 `memory?.store`（`panel/lib/index.js:236`）。审计本身只依赖 sink，不依赖 store；如果未来 provider 的 store 加载失败但审计可用，`/audit` 会被 503 挡住。建议把 store 检查移到需要 store 的路由。

### 7.2 provider 契约

```ts
attachInjectAudit(sink: { list(sessionId?: string): unknown }): void
injectAudit(sessionId?: string): unknown
```

问题：

- `unknown` 让面板与调用方无法类型检查条目结构；没有导出的 `InjectAuditEvaluation` 类型。
- sink 只有 `list`，没有 `stats`/`clear`/`subscribe`；未来做 UI 时能力不足。
- last-wins、无 detach（A-11）。

建议把契约提升为：

```ts
interface InjectAuditSink {
  list(query?: { sessionId?: string; channel?: string; trigger?: string; since?: number; limit?: number; cursor?: string }): InjectAuditPage
  stats(): { entries: number; capacity: number; dropped: number }
  clear?(): void
}
```

### 7.3 前端

`source/memory-panel/lib/client.js` 没有审计入口；当前只能靠 README 的 `GET /memory/api/audit?session=<id>` 手工调用。对于一个“可观测性”功能，这意味着它实际上只服务于开发者。

如果做 UI，建议最小形态：

- 会话选择器（默认当前会话）
- 时间线：`触发源 → 候选/选中/省略 → 预算条 → 是否投递`
- 失败筛选：`retrieval.ok=false`、`delivery.appended=false`
- 详情抽屉：完整 JSON、复制 id
- 容量提示：`已用 187/200，最早记录将被淘汰`

---

## 8. 测试审查

### 8.1 现有覆盖

| 测试 | 覆盖点 | 评价 |
| --- | --- | --- |
| `reliability.test.ts:151-164` | 200 条上限、最新在前、按会话过滤 | 好，但只覆盖存储层 |
| `reliability.test.ts:166-172` | `auditQuery` 对 token/sk 的脱敏 | 好，但没覆盖信号路径 |
| `settings-api.test.ts:181-207` | 面板 `/audit` 返回与 session 过滤 | 好，使用 fake sink |
| `inject-settings.test.ts:118-124` | provider 挂载/未挂载 | 好，契约层 |
| 全量 | 312 项，311 通过，1 跳过 | 当前基线健康 |

### 8.2 建议新增的测试

| 用例 | 断言 |
| --- | --- |
| 信号查询带 `token=...` | 审计里不出现原文，出现 `[REDACTED:` |
| digest list 抛错 | 有失败条目；本会话不静默标记成功（或明确记录放弃重试） |
| recall 检索抛错 | `retrieval.ok=false` + 稳定 error code；不追加消息 |
| 所有候选超预算 | `omitted` 含 `budget`，不是空数组 |
| 标签不匹配 | `omitted` 含 `tag_mismatch`；`candidates` 与 `retrieval.count` 可解释 |
| 消息被 `hasRecallMessage` 拦下 | `delivery.appended=false, suppressedBy='dedup'` |
| 消息被 `isWellFormedMessage` 拦下 | `delivery.appended=false, suppressedBy='malformed'` |
| 多会话各 100 条 | 每个会话都能查到自己的首轮摘要；`dropped` 正确 |
| 规则段渲染两次 | 审计 stats 与系统提示文本来自同一次渲染 |
| 字段快照 | 条目包含 `v/seq/id/channel/delivery`，未知字段不被静默丢弃 |
| compaction | 有生命周期标记；旧记录不被误读为当前上下文 |

---

## 9. 文档一致性

| 文档 | 当前表述 | 实际问题 |
| --- | --- | --- |
| `audit.ts:2-6` | “每次摘要/召回评估都留一条结构化记录”“不记录任何凭据/令牌” | 信号路径未脱敏；规则增量/策略/提醒/失败分支没有记录 |
| `CHANGELOG.md:74` | “记录触发原因、阶段、候选、正文、标签、去重、省略原因和各通道预算” | 正文只有 id；标签只在 digest 统计里，审计层被丢弃；规则只有计数 |
| `README.md:372-375` | 只说明可用 `/audit` 看“触发原因、候选、去重与各通道预算” | 没有字段表、容量、生命周期、脱敏边界、session 参数语义 |
| `audit.ts:27` | trigger 注释列了 `digest` | 实际摘要写 `turn_start` |

建议在 README 增加“诊断与审计”小节，明确：

- 这是内存诊断环，重启即失，最多 200 条；
- 记录的是评估快照，不等于消息一定进入上下文；
- 查询文本会做保守脱敏，但不保证覆盖所有秘密形状；
- `/audit` 默认按会话查看，全局视图的访问边界。

---

## 10. 改进方案

### 10.1 最小修复（建议 0.11.x）

1. **A-01**：`observeSignal` 的 `query` 改走 `auditQuery`；补测试。
2. **A-16**：`recall` 的 `auditQuery` 只算一次；先截断再脱敏（或至少限制输入长度）。
3. **A-02 的最小版本**：不重构整条链路，先在条目里加 `delivered?: boolean`；记录后如果消息被拦下，补一条 `suppressed` 条目或回填。更彻底的做法是“评估后置记录”，见 10.2。
4. **A-04 的最小版本**：在 `InjectAuditStore` 增加 `dropped` 计数；`list` 返回 `capacity/dropped`（或加 `stats()`）。
5. **A-05 的最小版本**：`recall/digest/rules` 写入 `scopes` 与实际 `topK`。

### 10.2 审计 v2 数据结构（建议）

```ts
type AuditChannel = 'digest' | 'recall' | 'rules' | 'rules_delta' | 'policy' | 'nudge' | 'signal'
type AuditTrigger = 'turn_start' | 'before_high_risk_tool' | 'tool_failure' | 'text_tag_match' | 'rules' | 'digest' | 'manual'
type AuditPhase = 'release' | 'deploy' | 'development' | 'unknown'
type OmitReason = 'top_k' | 'budget' | 'superseded' | 'expired' | 'tag_mismatch' | 'dedup' | 'skipped'

interface AuditEntryV2 {
  v: 1
  seq: number
  id: string                  // `${sessionId ?? 'unknown'}:${seq}`
  at: number
  sessionId?: string
  turn?: number
  step?: number
  kind: 'evaluation' | 'signal' | 'delivery' | 'lifecycle'
  channel: AuditChannel
  trigger: AuditTrigger
  phase: AuditPhase
  scopes?: string[]
  limits?: { topK?: number; maxItems?: number; maxQueryChars?: number }
  query?: { text?: string; redacted: boolean; chars: number }
  candidates?: number
  selected?: { contentIds: string[]; hintIds: string[]; count: number }
  omitted?: Array<{ id: string; reason: OmitReason; kind?: string; tags?: string[] }>
  dedup?: { skipped: number; updated: number; lastTextSame: boolean }
  budgets?: Record<string, { budget: number; used: number; remaining: number; over: boolean }>
  retrieval?: { ok: boolean; count: number; errorClass?: string; durationMs?: number }
  rules?: { active: number; injected: number; mandatory: number; mandatoryInjected: number; mandatoryOmitted: number }
  signal?: { key: string; reason: string; tool?: string; tag?: string; errorClass?: string; source?: string }
  error?: { stage: string; code: string; message?: string }
  delivery?: {
    attempted: boolean
    appended: boolean
    suppressedBy?: 'dedup' | 'malformed' | 'empty' | 'rejected' | 'aborted'
    textChars?: number
    textHash?: string
  }
}
```

示意条目（按当前代码构造，不是运行采样）：

```json
{
  "v": 1,
  "seq": 42,
  "id": "sess-abc:42",
  "at": 1761150000000,
  "sessionId": "sess-abc",
  "turn": 3,
  "step": 1,
  "kind": "evaluation",
  "channel": "recall",
  "trigger": "before_high_risk_tool",
  "phase": "release",
  "scopes": ["session:sess-abc", "project:D:/repo", "global"],
  "limits": { "topK": 5 },
  "query": { "text": "发布 dsh-memory", "redacted": true, "chars": 8 },
  "candidates": 12,
  "selected": { "contentIds": ["a1b2c3d4"], "hintIds": [], "count": 1 },
  "omitted": [{ "id": "e5f6a7b8", "reason": "top_k" }],
  "dedup": { "skipped": 3, "updated": 0, "lastTextSame": false },
  "budgets": { "recall": { "budget": 500, "used": 321, "remaining": 179, "over": false } },
  "retrieval": { "ok": true, "count": 15, "durationMs": 42 },
  "signal": {
    "key": "auto-tag:publish",
    "reason": "before_high_risk_tool",
    "tool": "ops_bash",
    "tag": "publish",
    "source": "tool"
  },
  "delivery": { "attempted": true, "appended": true, "textChars": 321, "textHash": "sha256:..." }
}
```

### 10.3 记录时机

推荐从“记录评估”改为“评估 → 组装 → 记录投递”两段式：

```text
1. 各通道产出 text + stats（不写审计）
2. 组装 parts，计算 hasRecallMessage / isWellFormedMessage
3. 追加消息
4. 一次性写审计：
   - 每条通道一条 evaluation（含 stats）
   - 一条 delivery（含 appended / suppressedBy / textChars / textHash）
5. 若被拦下，也写 delivery，不写“已注入”
```

这样所有条目共享同一个 `seq`/`at`，并且 `delivered` 与上下文事实一致。

### 10.4 保留与持久化

- **短期**：每会话 200 条 + 全局 2000 条；digest/rules 各保留最近 N 条（例如 20），不被信号条目挤掉；暴露 `capacity/dropped`。
- **中期**：可选的 JSONL 追加写（`<storeDir>/audit/YYYY-MM.jsonl`），按大小/日期轮转；只写脱敏后的条目；启动时按需读取尾部。
- **长期（若定位为合规审计）**：只追加、哈希链/签名、独立访问控制、保留策略、导出与校验工具。这不是当前实现的自然延伸，而是另一个产品能力。

### 10.5 分阶段建议

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| Phase 0 | A-01 脱敏、A-16 去重调用、补测试 | 0.5 天 |
| Phase 1 | A-02 投递字段、A-03 失败条目、A-05 scopes/limits、A-08 kind/stage | 2~3 天 |
| Phase 2 | A-04 保留策略、A-09 过滤原因、A-10 schema v2、A-11 sink 生命周期 | 3~5 天 |
| Phase 3 | A-12 API/UI、导出、持久化（可选） | 1~2 周 |
| Phase 4 | 合规审计（追加写/完整性/权限） | 独立立项 |

---

## 11. 验收标准

修复后应满足（Given/When/Then）：

1. **脱敏**：给定信号查询包含 `token=...`，写入后审计与 `/audit` 响应中都不出现原文，出现 `[REDACTED:`。
2. **投递一致**：给定消息被去重/格式保护拦下，`delivery.appended=false` 且 `suppressedBy` 正确；上下文没有该消息时，审计不声称已注入。
3. **失败可见**：给定 digest list 抛错或 rules listSync 抛错，存在 `error`/失败条目；不再出现“无记录 + 已放弃重试”。
4. **原因完整**：给定所有候选超预算/标签不匹配/已退役，`omitted` 分别给出 `budget`/`tag_mismatch`/`superseded`。
5. **可解释范围**：给定普通召回与信号召回，条目包含实际 `scopes` 与 `limits.topK`，能解释“为什么是这些候选”。
6. **容量可观测**：给定 300 条记录，API 返回 `capacity=200`、`dropped>=100`；按会话查询不会因为其它会话而完全为空（在保留策略生效后）。
7. **规则一致**：给定系统提示渲染失败，审计明确 `delivery.appended=false`，不假装规则已进入上下文。
8. **生命周期**：给定插件半边重载，旧 sink 不再被读取；新条目从新 store 开始。
9. **测试**：新增上述用例；全量测试保持通过；字段快照测试覆盖 schema v2。
10. **文档**：README 明确“内存诊断环、200 条、重启丢失、评估≠投递、脱敏边界”。

---

## 12. 附录

### A. 关键代码索引

| 内容 | 位置 |
| --- | --- |
| 审计接口与环形缓冲 | `source/memory-inject/src/audit.ts:11-84` |
| 脱敏函数 | `source/memory-inject/src/audit.ts:77-80` |
| 预算对象 | `source/memory-inject/src/audit.ts:82-84` |
| 信号观察写入 | `source/memory-inject/src/apply.ts:227-244` |
| 摘要写入 | `source/memory-inject/src/apply.ts:457-471` |
| 规则写入 | `source/memory-inject/src/apply.ts:476-498` |
| 召回写入 | `source/memory-inject/src/apply.ts:519-535` |
| 投递保护 | `source/memory-inject/src/apply.ts:539-551` |
| 召回过滤/失败 | `source/memory-inject/src/inject.ts:336-367` |
| 摘要统计 | `source/memory-inject/src/digest.ts:200-290` |
| 规则统计 | `source/memory-inject/src/rules.ts:79-177` |
| provider sink | `source/memory-local/src/index.ts:548-555` |
| 面板路由 | `source/memory-panel/lib/index.js:243-248` |

### B. 本次执行的命令

```bash
# 定向测试
node --experimental-strip-types --test \
  source/memory-inject/test/reliability.test.ts \
  source/memory-panel/test/settings-api.test.ts
# 结果：18 passed / 0 failed

# 全量测试
npm test
# 结果：312 tests, 311 passed, 1 skipped, 0 failed
```

### C. 审查限制

- 未取得运行时审计样本：本地面板 `/memory/api/audit` 返回 `LOGIN_REQUIRED`，因此没有对真实条目做统计或脱敏验证。
- 未评估检索质量本身（embedding、rerank、minScore），只评估“审计是否准确描述注入过程”。
- 未做性能压测；A-16 的性能判断来自代码路径（7 组正则 + 全量文本扫描 × 2），不是实测数据。
- 未检查 DSH 宿主内部对 `systemPrompt.section`、`session/event` 的所有边界行为；相关结论以本仓库代码中的防御性处理为准。

### D. 术语

| 术语 | 含义 |
| --- | --- |
| 评估（evaluation） | 一次“决定要不要注入、注入什么”的计算 |
| 投递（delivery） | 评估结果真正变成消息并进入模型上下文的动作 |
| 信号（signal） | 来自工具调用/失败/assistant 文本/待办/命令/目标的触发事件 |
| 观察（observation） | 信号被记录、等待下一个 pre-step 消费的状态 |
| 审计环 | `InjectAuditStore` 的内存数组（最多 200 条） |

---

**最终判断**：当前审计实现是 0.9.6 阶段一个**务实、低耦合、不会拖垮主链路**的诊断原型。它值得保留并继续演进，但不应被宣传或依赖为“完整审计”。在补上“信号脱敏、投递事实、失败记录、作用域快照、保留策略”之前，它更适合回答“这次选了什么”，不适合回答“为什么发生”和“事后追责”。
