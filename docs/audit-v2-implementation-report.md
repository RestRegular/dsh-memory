# dsh-memory 审计 v2 实施报告

> **版本**：`@restregular/dsh-memory` 0.12.4  
> **基线**：`fa5e297`（0.11.1） + `docs/audit-implementation-review.md`  
> **实施方案**：`dsh-memory-audit-v2-implementation-plan.md`  
> **完成日期**：2026-10-22  
> **定位**：可观测、可查询、可核对的记忆注入诊断系统；不是防篡改/合规审计系统。

---

## 1. 完成范围

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| Phase 0 安全热修 | **完成** | 信号查询统一脱敏；先限长再扫描；README/CHANGELOG 更新 |
| Phase 1 schema v2 + delivery | **完成** | 新 schema、稳定 id/seq、evaluation/delivery 分离、scopes/limits、失败事件 |
| Phase 2 全路径记录 | **完成（除持久化）** | digest / rules / rules_delta / recall / signal / policy / nudge / compaction；跳过与失败原因 |
| Phase 3 Store / sink | **完成（内存模式）** | 每会话/全局容量、dropped/writeErrors、cursor、类型化 sink、解绑与 dispose；JSONL 持久化未启用 |
| Phase 4 API | **完成** | 过滤、分页、stats、导出、兼容旧 `?session=`；store 解耦 |
| Phase 5 面板 UI | **完成** | 独立「审计」标签页、筛选、事件流、详情抽屉、健康状态、空/错误/加载态 |
| Phase 6 导出 / 文档 | **完成** | JSON/JSONL 导出、脱敏、README/CHANGELOG、本报告 |

---

## 2. 核心架构

### 2.1 数据流

```text
session/event
  └─ signal observed/queued → InjectAuditStore (kind=signal)

agent/pre-step
  ├─ 各通道产出 AuditDraft（evaluation）
  ├─ 最终消息通过本地保护检查
  ├─ 写 evaluation 事件
  └─ 写 delivery 事件（appended / unknown / suppressed / rejected / not_attempted）

provider
  ├─ attachInjectAudit(sink)
  ├─ injectAuditPage(query)
  └─ injectAuditStats()

panel HTTP
  ├─ GET /memory/api/audit
  ├─ GET /memory/api/audit/stats
  └─ GET /memory/api/audit/export

panel UI
  └─ 「审计」标签页：筛选 → 事件流 → 详情抽屉 → 导出
```

### 2.2 关键语义

- **evaluation**：说明候选、过滤、选中、省略、预算、检索/加载结果；
- **delivery**：说明最终消息是否通过重复/格式保护，以及是否拿到宿主回执；
- **usage**：Agent 是否引用/遵守记忆，当前**不采集、不声称**。

`delivery.status` 取值：

| status | 含义 |
| --- | --- |
| `unknown` | 已通过本地保护并放进 decision，但宿主没有回执；面板显示“已准备（投递未确认）” |
| `suppressed` | 被重复消息保护/空文本等拦下，未追加 |
| `rejected` | 消息结构校验失败，未追加 |
| `not_attempted` | 没有任何可注入内容 |
| `appended` | 只有拿到宿主确认时才会使用；当前 pre-step 拿不到回执，因此**不会乐观写入** |

> 这是本方案最重要的诚实性约束：预置消息不等于宿主接受，更不等于模型读取或遵守。

---

## 3. 主要实现

### 3.1 类型与存储

新增 `source/memory-inject/src/audit-types.ts`：

- `AuditEntryV2`：`schemaVersion / id / seq / at / kind / channel / stage / outcome / reasonCode / scopes / limits / query / candidates / filter / selected / omitted / dedup / budgets / sourceLoad / retrieval / rules / signal / error / delivery`；
- `AuditListQuery`、`AuditPage`、`AuditStoreStats`、`AuditSink`；
- 枚举：`AuditChannel`、`AuditKind`、`AuditOutcome`、`AuditDeliveryStatus`、`AuditSuppressedBy`、`AuditOmitReason`。

`source/memory-inject/src/audit.ts`：

- `InjectAuditStore` 实现 `AuditSink`；
- 全局容量 2000，每会话 200；
- 容量淘汰优先保留 `digest / rules / rules_delta / delivery / error / lifecycle`；
- `dropped / writeErrors / lastRecordedAt / persistence` 可查询；
- `seq` 单调、`id = sessionId:seq`、`list()` / `query()` 返回副本；
- `query()` 支持 session/trace/operation/memory/channel/trigger/outcome/problem/since/until/limit/cursor；
- `record()` 内部吞异常并累加 `writeErrors`，绝不向 Agent 主链路抛出；
- `clear()` 只接受明确范围，避免误清空全部。

### 3.2 脱敏

`sanitizeAuditText()`：

1. 限制扫描长度 4000 字符；
2. 对扫描片段执行 `redactSecrets`（PEM、`sk-`、GitHub token、AWS、Slack、Bearer、key=value）；
3. 折叠空白并截到 200 字；
4. 返回 `{ text?, chars, redacted, hash }`，hash 为 FNV-1a 短 hash。

`auditQuery()` 保留旧签名，内部调用 `sanitizeAuditText`。信号观察路径（`apply.ts observeSignal`）已改为写入脱敏后的 `query`，不再落原始 `signal.query`。

### 3.3 pre-step 记录点

`source/memory-inject/src/apply.ts`：

- 收集 `staged: AuditDraft[]`，最终消息组装后再统一写；
- 每个通道的评估：
  - digest：成功 / 空结果 / source load 失败；
  - rules：实际注入 ID、省略 ID、mandatory 统计；系统提示使用同一份渲染缓存（pre-step 先算，section 回调复用）；
  - rules_delta：新增/编辑的规则 ID、原因、token；
  - recall：原始命中、标签过滤、退役排除、最终候选、top-K/预算省略、去重、scopes、limits、query；
  - signal：observed/queued/consumed/dropped，区分观察与检索；
  - policy / nudge：字符数、hash、投递未确认状态；
  - compaction：`lifecycle` 事件与 context 分界。
- 空 query、关闭开关、同一 query 跳过、全部候选超预算、标签不匹配、退役排除、检索失败、source load 失败都有稳定 `reasonCode`；
- 最终 delivery：空文本 / 重复保护 / 格式保护 / 已准备分别记录。

### 3.4 provider 与面板 API

`source/memory-local/src/index.ts`：

- `attachInjectAudit(sink | null)`；
- `detachInjectAudit(sink?)` 按 sink 身份解绑；
- `injectAuditPage(query)` / `injectAuditStats()`；
- `flushSync()` 释放 sink；
- 多激活覆盖时输出诊断日志。

`source/memory-panel/lib/index.js`：

- `GET /memory/api/audit`：过滤、limit 1..200、seq cursor、stats、query echo；
- `GET /memory/api/audit/stats`；
- `GET /memory/api/audit/export?format=json|jsonl`：按当前筛选循环取页（最多 10000 条）；
- 非法 `limit / cursor / channel / outcome / since / until` 返回清晰 4xx；
- 审计路由先于 `memory.store` 检查，store 不可用不影响审计读取；
- 旧 `?session=` 调用保持兼容。

### 3.5 面板 UI

`source/memory-panel/lib/client.js` 新增独立「审计」标签页：

- 顶部只保留带边框的持久化/内存模式提示（0.12.3 起移除标题、解释文本与右侧状态气泡）；
- 概览统计：筛选内事件、本页已准备（投递未确认）、被抑制/未尝试、失败、丢弃/容量；
- 两行筛选：会话、通道、结果、时间范围、搜索、仅看问题、刷新；触发源、自定义日期、清空、导出；
- 时间范围为自绘下拉（全部/15m/1h/24h/7d/30d/自定义），“仅看问题”与“自动刷新”使用自绘开关；
- 自动刷新默认 500ms，可关闭并在 0.5/1/2/5/10 秒间切换；页面隐藏时跳过；
- 事件流表格：带固定表头（时间、通道/事件、触发/阶段、候选/选中/省略、预算、投递、结果），只有列表纵向滚动；
- 审计页固定为视口高度，整页不滚动；详情抽屉独立滚动；
- 详情抽屉：生命周期、查询（脱敏）、检索与过滤、选择与省略、预算条、投递、失败、信号、原始 JSON、复制 ID/JSON；
- 分页：上一页/下一页（cursor 栈）；
- 导出当前筛选 JSONL/JSON；复制/导出反馈就地显示在按钮旁；
- 加载、空状态、错误重试、内存模式/降级/写入失败提示；
- 不使用大型前端依赖，沿用现有 React + `h()` + CSS token。

---

## 4. 修改文件

### 源码

- `source/memory-inject/src/audit-types.ts`（新增）
- `source/memory-inject/src/audit.ts`
- `source/memory-inject/src/apply.ts`
- `source/memory-inject/src/inject.ts`
- `source/memory-inject/src/rules.ts`
- `source/memory-inject/src/rules-delta.ts`
- `source/memory-local/src/index.ts`
- `source/memory-panel/lib/index.js`
- `source/memory-panel/lib/client.js`

### 测试

- `source/memory-inject/test/apply-audit.test.ts`（新增）
- `source/memory-inject/test/reliability.test.ts`
- `source/memory-inject/test/inject.test.ts`
- `source/memory-local/test/inject-settings.test.ts`
- `source/memory-panel/test/settings-api.test.ts`
- `source/memory-panel/test/client-render.test.ts`

### 构建 / 文档

- `package.json`（构建版本 0.12.4）
- `packages/dsh-memory/**`（重新构建）
- `README.md` / `CHANGELOG.md`
- `docs/audit-implementation-review.md`（基线审查）
- `docs/audit-v2-implementation-report.md`（本报告）

---

## 5. 测试与验证

### 5.1 命令

```bash
# 审计相关定向测试
node --experimental-strip-types --test \
  source/memory-inject/test/apply-audit.test.ts \
  source/memory-inject/test/reliability.test.ts \
  source/memory-panel/test/settings-api.test.ts \
  source/memory-panel/test/client-render.test.ts

# 全量
npm test

# 构建
npm run build
```

### 5.2 结果

- 全量：**323 项，322 通过，1 跳过，0 失败**（跳过项为既有环境相关用例）。
- 构建：`@restregular/dsh-memory@0.12.4`，39 个产物文件，`BUILD OK`。
- 新增测试覆盖：
  - pre-step 评估 + delivery（unknown / suppressed / not_attempted）；
  - digest source load / 渲染失败错误码；
  - 信号 query 脱敏；
  - store 每会话容量、dropped、seq、分页游标、返回副本、筛选/问题视图；
  - API v2 过滤、分页、stats、非法参数、store 解耦、JSONL 导出；
  - provider sink 透传、解绑、dispose；
  - 审计标签页空状态/真实事件/详情/评估与投递区分。

### 5.3 未执行

- 没有在运行中的 DSH 桌面实例里做真实点击验证（当前 profile 仍安装 0.11.1）；面板渲染由 `client-render.test.ts` 通过真实 bundle + mock React 验证。
- 没有做 JSONL 持久化压测（该能力未启用）。

### 5.4 发布状态

| 项 | 状态 |
| --- | --- |
| npm `0.12.0` | 已发布 |
| npm `0.12.1` | 已发布 |
| npm `0.12.2` | 已发布；修复 `CordisMemoryService` 未转发审计方法 |
| npm `0.12.3` | 已发布；两行筛选、自绘时间范围/开关、列表滚动 |
| npm `0.12.4` | 已发布，`npm view` 验证 `dist-tags.latest = 0.12.4` |
| GitHub `main` | `cd65d93`（0.12.4 UI/自动刷新）；0.12.3 为 `4dfa673` |
| Git tags | `v0.12.0`、`v0.12.1`、`v0.12.2`、`v0.12.3`、`v0.12.4` |
| 本地 profile | 未升级（按项目约定，发布/推送后不自动改本地插件） |

---

## 6. 容量与性能

| 项 | 值 |
| --- | --- |
| 全局容量 | 2000 条 |
| 每会话容量 | 200 条 |
| 单条 query 文本 | 最多 200 字；扫描最多 4000 字符 |
| 淘汰策略 | 优先保留 digest/rules/rules_delta/delivery/error/lifecycle |
| 淘汰计数 | `stats.dropped` |
| 写入失败 | `stats.writeErrors`，不影响主链路 |
| 查询分页 | 默认 50，最大 200，seq 游标 |
| 导出 | 最多 50 页 × 200 = 10000 条 |
| 持久化 | 无（`persistence: "memory"`） |

审计记录只保存 id、计数、枚举、字符数、短 hash 与脱敏后的短 query，不保存正文、完整工具参数、堆栈；单条记录通常远小于 1 KB，2000 条内存占用可控。

---

## 7. 已知限制与未完成项

1. **没有持久化**：重启后记录丢失；面板与 README 明确显示“内存模式”。JSONL 追加写、轮转、损坏恢复未实现。
2. **delivery 不能确认宿主采纳**：pre-step 只能证明消息通过本地保护并放进 decision，宿主后续拒绝不可见；因此正常路径记 `unknown`，不写 `appended`。
3. **traceId / operationId 未生成**：schema 与 API/UI 已预留，当前没有可靠来源，不伪造。
4. **全局查询默认“全部会话”**：HTTP 路由拿不到“当前会话”，为兼容旧调用未强制 `session`；响应 `query.scope` 标记 `session|all`，UI 记住上次选择。若今后能拿到当前会话，应改为默认当前会话 + 显式全局。
5. **rules 同源渲染是 best-effort**：pre-step 与 systemPrompt assemble 的先后顺序由宿主决定；缓存能在常见顺序下复用同一份文本，但无法 100% 证明系统提示最终采纳。
6. **多激活实例 last-wins**：provider 仍只保留一个 sink；覆盖时输出诊断日志，未实现按实例合并。
7. **无审计清理 API**：`clear()` 只在 store 内部支持明确范围清理，未暴露 HTTP 路由（按方案的可选项暂不实现，避免越权删除）。
8. **hash 不是密码学哈希**：FNV-1a 用于稳定比较/展示，不可用于完整性证明。
9. **不是合规审计**：无追加写、哈希链、签名、不可否认、独立访问控制。

---

## 8. 手工验证方法

1. 构建并安装到 DSH profile（或使用已安装 0.12.0 的实例）。
2. 打开记忆面板 → 顶部「审计」标签页。
3. 触发一次普通对话或包含发布/部署关键词的工具调用。
4. 观察事件流：
   - `signal`（如触发）：`signal_queued` / `signal_consumed`；
   - `digest` / `rules` / `recall` evaluation；
   - `delivery`：`delivery_prepared`（未确认）或被抑制/拒绝。
5. 点击事件行查看详情：scopes、limits、filter、selected/omitted、预算、query 脱敏、delivery、error、原始 JSON。
6. 切换会话/通道/结果/“仅看问题”，确认列表与 URL 请求参数变化；翻页确认 cursor 稳定。
7. 点击「导出 JSONL」，确认导出条数与当前筛选一致。
8. 重启 DSH 后回到审计页，确认显示真实空状态与“内存模式”提示（不补造历史）。

### 回放一条任务

当前没有自动 `traceId`，按以下顺序人工回放：

1. 选会话 + 时间范围；
2. 先看 `kind=signal` 的 queued/consumed；
3. 再看同 `step` 的 `kind=evaluation`（digest/rules/recall）；
4. 最后看 `kind=delivery`；
5. 用详情里的 event `seq` 与 `step` 对齐；缺失阶段显示“未记录”，不要推断成功。

---

## 9. 后续建议

1. **宿主回执**：若 DSH 暴露 post-step/message-appended 回调，补一次 delivery 确认，才能出现 `appended=true`。
2. **持久化**：在现有 `<storeDir>` 下增加 JSONL 追加写 + 轮转 + 降级状态；不要在未覆盖磁盘失败前默认开启。
3. **trace/operation**：由宿主提供 turn/step/trace 上下文后写入，补全关联追踪视图。
4. **清理 API**：等现有权限体系能可靠判断管理员后再做，且必须显式确认 + 范围化。
5. **真实数据测试**：按方案第 10 节，用真实会话做隐私处理、人工相关性标注与回放统计。
