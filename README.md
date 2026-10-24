<p align="center">
  <img src="https://raw.githubusercontent.com/RestRegular/dsh-memory/main/preview/icon-128.png" width="84" alt="记忆系统">
</p>

# 记忆系统

**本地优先的长期记忆，让每次对话都接得上。**

JSONL 落盘 · 本机向量检索 · 五个模型工具 · 自动召回 · 硬性规则 · 可视化管理面板

[![npm version](https://img.shields.io/npm/v/@restregular/dsh-memory.svg)](https://www.npmjs.com/package/@restregular/dsh-memory)
[![npm downloads](https://img.shields.io/npm/dm/@restregular/dsh-memory.svg)](https://www.npmjs.com/package/@restregular/dsh-memory)
[![license](https://img.shields.io/npm/l/@restregular/dsh-memory.svg)](https://github.com/RestRegular/dsh-memory/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.13-5FA04E.svg)](https://nodejs.org/)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/restregular/dsh-memory)

[npm 包](https://www.npmjs.com/package/@restregular/dsh-memory) · [问题反馈](https://github.com/RestRegular/dsh-memory/issues) · [更新日志](https://github.com/RestRegular/dsh-memory/blob/main/CHANGELOG.md)

> **它解决的不是「存一段文本」，而是「让模型在该记的时候记住、该用的时候用上」。**
> 记忆默认只落在本机；没有向量服务也能工作——检索自动退化为词法，不产生任何网络请求。

![记忆记录：搜索、作用域筛选、类型与修正关系](https://raw.githubusercontent.com/RestRegular/dsh-memory/main/preview/memory-records.png)

## 它解决什么

| 常遇到的问题 | 记忆系统怎么做 |
| --- | --- |
| 新会话从零开始，换个窗口就问不出上次的结论 | 结论落成记忆；新会话第一步注入摘要，之后每轮按问题召回 |
| 同一个坑反复踩，上次查到的命令又要再查一遍 | 发布 / 部署 / 工具失败等行为会触发定向召回；查到的做法直接复用 |
| 写了规则没人执行，改过的规则旧会话不知道 | `kind: rule` 进系统提示常驻段；新增或编辑会补一条提醒 |
| 临时状态被当成永久事实 | `kind: state` 带默认 7 天 TTL 和「使用前验证」前缀；过期后默认隐藏，但不会自动删除 |
| 云端记忆不可控，敏感内容不敢写 | 全部本地 JSONL；写入前过凭据扫描；检索默认不联网 |

它也不是「把聊天记录整段塞给模型」：每条记忆是一句自洽的话，按作用域、类型和重要度管理；
召回有 token 预算与去重；旧结论可以用 `supersedes` 标注修正，被修正的旧版本默认不再参与
检索 / 摘要 / 召回（历史仍可用 `memory_get` 和面板查看），而不是悄悄覆盖。

## 功能

| 能力 | 说明 |
| --- | --- |
| **六个工具** | `memory_save` / `memory_search` / `memory_list` / `memory_get` / `memory_forget` / `memory_scopes`。`memory_search` 只回印象（8 位 id / 作用域 / 类型 / 标签 / 短摘要），正文和元数据用 `memory_get` 的 `fields` 按需取；同一会话里已出现过的条目只回 id。`description` 字段在普通限制下必填，审批卡会展示它。`memory_scopes` 只读目录：给作用域名字 / 用途 / 当前可读可写状态，不返回任何正文 |
| **四种作用域** | 会话 / 项目 / `global` / 自定义名。默认写进当前会话，读默认合并会话 + 项目 + global；项目作用域可起别名。自定义作用域**首次由 Agent 创建时必须带 `scopeDescription`**（一句话用途），可选带 `scopeRule` 写一条初始规则；元数据存在 `<storeDir>/scope-meta/`，删光记录也不会丢 |
| **作用域目录与绝对隔离** | `memory_scopes` 列出范围内 / 范围外的名字与用途；normal / none 下还带**初始化记录正文**（每个作用域最多 3 条，方便 Agent 直接读到“这个作用域主要放什么”）。绝对限制下范围外作用域**仍可发现**，但正文（含初始记录）永不可读、不可写、不可申请（没有任何审批放行路径）；普通限制下范围外条目可申请，`memory_scopes request` 走审批后写入**本会话**授权（默认只读，写权限必须单独申请），子 Agent 沿父会话继承 |
| **会话授权（grants）** | Agent 申请、用户批准的例外单独存在 `<storeDir>/grants/<session>.json`，不并入可见域策略；只读 / 可写独立、可撤销、只在本会话（及子 Agent）生效；`absolute` 下授权不生效，作用域被删除重建后按创建代次自动失效 |
| **双通道检索** | 词法（IDF + 中文 bigram）**+** 向量（本机 llama-server 的 OpenAI 兼容 `/v1/embeddings`）。向量缺席自动降级，不报错、不阻塞 |
| **自动召回** | 每轮按用户问题召回；新会话第一步注入项目 / global 摘要；发布、部署、工具失败等行为按标签触发定向召回 |
| **印象形态** | 每轮只给每条记忆的短摘要；模型判断相关但需要细节时再 `memory_get` 取全文，省 token 也不丢信息 |
| **硬性规则** | `kind: rule` 进系统提示常驻段；行首带 8 位 id，注入的是摘要，需要全文时用 `memory_get`；旧会话会收到新增 / 编辑提醒；超预算有明确警告，不静默丢弃 |
| **记忆权限** | 输入框旁的「记忆权限」按钮设置本会话可读的作用域 + 限制等级（绝对 / 普通 / 无限制）；每个作用域还有**绑定 / 可读 / 可写**状态按钮——绑定到当前工作区后新会话默认可见，可读 / 可写独立影响工具读写；浮窗里还有「Agent 会话授权」区块，**实时轮询**（3 秒）显示 Agent 通过 `memory_scopes request` 申请到的授权，可逐条撤销（撤销后下一次注入会告知 Agent）；Agent 及其子 Agent 都按它检索、注入与 `memory_get` |
| **修正版编辑** | 面板里编辑一条记忆 = 新建一条修正版并通过 `supersedes` 指向旧记录，旧记录不原地修改；记录页「是否被修正」筛选默认隐藏旧版本，可切到全部 / 只看已修正 |
| **范围外审批** | 普通限制下，工具命中可见域外的记忆时会在**对应会话的输入框上方**出现审批卡（样式与系统权限审批一致）：展示工具、Agent 说明、查询关键词与范围外记忆摘要，支持逐条勾选 / 全选 / 取消全选（「允许选中的 N 条」或整单「允许一次」）或「拒绝」；点记忆 ID 直接跳到面板「记录」页并展开该条 |
| **上下文去重** | `memory_search` / `memory_list` 返回过的条目记进会话上下文状态；同一版本再次命中只回记忆 ID（`memory_search` 的裸 ID 与带摘要条目之间空一行），并提示用 `memory_get` 取全文（内容更新后重新给摘要） |
| **状态记忆** | `kind: state` 默认 7 天 TTL；注入带「状态，使用前验证」；过期后默认不进检索 / 摘要 / 召回，但 `memory_get` 与面板仍可取 |
| **流程索引** | `kind: procedure` 的目录进系统提示：按当前工作区 + 触发词（工具名 / 关键词）列 `id · 触发词 → 标题`，需要时再用 `memory_get` 取全文 |
| **可视化管理** | 记录浏览 / 搜索 / 新建 / 编辑 / 删除（编辑生成修正版）；**记录页可主动做语义检索**（与 `memory_search` 同一套排序），并有「是否被修正」筛选；记忆树展示作用域、类型与修正链；设置改完即存；导入导出 |
| **一键向量后端** | 面板里下载 llama.cpp 运行时与内置模型，按 CPU / 内存 / 显卡推荐；换模型自动重建向量 |
| **跨进程安全** | 每个作用域一把写锁，锁内重新读盘再合并；多个 DSH 实例或 MCP server 共用一个 store 不丢数据 |

## 界面

### 记录页的语义检索

记录页搜索框旁边有「语义检索」开关。开启后，搜索不再按关键词过滤，而是把这句话交给和
`memory_search` **同一套**的召回排序（向量 + 词法，必要时再重排），结果按相关度返回并标出得分。

- 开关只在向量后端已配置时可用；没装后端时保持禁用并说明原因。
- 语义检索是**只读浏览**：不增加访问计数，不会把 `memory_search` 后续的排序带偏。
- 结果卡上的「得分」是**排序分**（向量/词法命中 × 重要度 × 时效 × 访问次数），不是概率，
  访问次数多时可能大于 1；结果顺序与这个分数一致。
- 结果说明会如实写出这次是「语义排序」还是「关键词回退」：例如记录还没嵌入向量、或向量服务
  没有响应时，不会把词法结果冒充成语义结果。嵌入完成后列表会自动刷新成语义结果。
- 作用域下拉与新建 / 编辑 / 删除仍然照常工作；从审计页点记忆 ID 跳过来时会自动回到普通列表并展开该条。

### 记忆树

按 **作用域 → 类型 → 记录** 三层展开，根节点显示总数。`supersedes` 是关系而不是层级，
所以不改树结构：金色虚线从修正版弯到旧版，悬停或选中任意一端，整条修正链一起点亮。

![记忆树](https://raw.githubusercontent.com/RestRegular/dsh-memory/main/preview/memory-tree.png)

### 设置

召回、摘要、印象、策略、状态、流程索引、规则、自动召回逐项开关；每个开关都有可见 label、说明和当前状态。
修改立即写入 `settings.json`，不需要点保存。

![记忆设置](https://raw.githubusercontent.com/RestRegular/dsh-memory/main/preview/memory-settings.png)

### 输入框的记忆权限

输入框工具行右侧有「记忆权限」按钮。**打开会话时就会读取这个会话的设置**，按钮上的数字是当前生效的作用域数量，边框样式表示限制等级（绝对限制 = 橙黄实线 / 普通限制 = 蓝色实线 / 无限制 = 灰色虚线；`title` 里写明「已设置 / 使用默认 / 继承父会话 + 数量 + 等级」）。点开的浮窗使用毛玻璃背景，按当前会话列出可选作用域（当前会话 / 当前项目 / global / 已有自定义作用域）：

- **默认范围**：没有显式设置时（新会话）按默认设置生效 —— **当前会话 + 当前项目 + global + 已绑定的作用域** + **普通限制**；面板按同一份默认范围预选，不会出现空面板。
- **搜索与批量**：顶部可搜索作用域，支持「全选 / 取消全选」；列表最大高度受限，作用域多时在浮窗内滚动。
- **状态按钮（0.23.0 / 0.23.1）**：作用域列表每行有【绑定】、【可读】|【可写】。**默认范围自带的会话 + 项目 + global 显示为已绑定且不可取消**；**绑定**按钮用于把其它作用域额外并入当前工作区的默认范围（没有显式覆盖的新会话可见）；**可读 / 可写**是会话级，独立控制该作用域的读取与写入（关掉可读 → 搜索 / 读取跳过并说明原因；关掉可写 → 保存 / 删除被拒绝并说明原因）。
- **限制等级**：
  - **绝对限制**：可见域外的读取 / 写入 / 删除一律不执行；命中被挡住时会明确告诉 Agent 是「绝对限制」以及怎么调整（不再假装记忆不存在）。
  - **普通限制**（默认）：可见域内正常返回；命中范围外记忆时，工具会暂停并在**该会话**的输入框上方显示审批卡，展示 Agent 的查询关键词与范围外记忆摘要；读审批可以逐条勾选，只允许其中一条或多条。用户拒绝 / 5 分钟未回答时，工具结果里会明确写出真实原因（「用户拒绝了本次访问」/「审批超时」），模型不会误以为记忆不存在。范围外写入 / 删除同样走审批。
  - **无限制**：不启用范围白名单，可以读写任意作用域（选择仍会保存，供下次切换）。
- **Agent 会话授权（0.25.0）**：浮窗里的「Agent 会话授权」列出本会话由 `memory_scopes request` 审批得到的授权（作用域 / 只读或可写 / 授予时间）。Agent 调用工具授予权限后区块会**实时出现**（打开期间每 3 秒刷新）；点「撤销」删掉这条授权，Agent 下一次 pre-step 会收到「记忆权限已更新」的注入，必须重新申请。继承自父会话的授权标「继承」且不可在本会话撤销，需要到父会话操作。
- **不再按记忆类型收窄**：0.19.1 起只按作用域限制；旧配置里的 `kinds` 会被忽略，同一作用域下的事实 / 规则 / 流程等都可读。
- **审批卡（0.21.0 / 0.22.x）**：注册在会话内的 `conversation.input.dock`，**只在发起审批的那个会话里显示**，切到别的会话看不到；视觉与系统自带的权限审批弹窗一致（警告色 strip、卡片、右对齐动作行，同一批主题 token）。按动作分为「记忆读取 / 写入 / 删除审批」。读审批默认全部勾选：可逐条取消、用「全选 / 取消全选」批量操作，**点条目任意位置即可切换选中**，再点「允许选中的 N 条」，工具只放行勾选的 id、其余写入 `withheld.reason='partial'`；全选时等价于原来的「允许一次」。strip 右侧可**折叠 / 展开**详情，折叠后仍保留「拒绝 / 允许」动作。写 / 删审批是单条，隐藏勾选框。**0.22.0 起**卡片展示工具调用的 `description`（普通限制下工具层强制模型提供），点记忆 ID 会打开记忆面板的「记录」标签页、选中并滚动到该条、自动展开；**0.22.2 起**查询与说明固定显示在条目列表上方，条目再多也不会被列表挤没（两行锁 `flex:none`，只有列表滚动）；**0.22.3 起**审批卡高度只受 composer 文本区上限约束（与宿主审批卡同口径），矮窗口下列表也有空间。拒绝、超时或无法发起审批都会把原因告诉模型。Enter = 允许、Esc = 拒绝（焦点在卡片内时）。
- 子 Agent 自动继承父会话 / 根会话的设置；在子 Agent 自己的会话里再设置，只影响那一个会话。
- 保存后，下一次 Agent 步骤会通过注入的上下文消息收到「记忆权限已更新」通知（可见范围 + 限制等级 + 本次授权变更 + 当前会话授权）；Agent 申请或用户撤销授权走同一条注入，不需要重启会话。
- 「恢复默认」清除覆盖，回到默认设置（会话 + 项目 + global + 已绑定的作用域 + 普通限制）。
- 覆盖按会话落盘在 `<storeDir>/visibility/<session>.json`，浏览器刷新 / 插件重载后仍在；0.18 的旧文件按「绝对限制」兼容读取。
- 浮窗与审批卡的半透明背景、边框、文字颜色全部走宿主主题 token；勾选框选中态、保存按钮、限制等级选中态使用 `--dsw-alias-state-business-primary` + `--dsw-alias-label-primary-foreground`，深色模式下不会出现白底白勾 / 白底白字；按钮三档边框用 `state-warn-primary`（橙黄）/ `state-business-primary`（蓝）/ 虚线灰；阴影已收敛为小范围投影，滚动列表高度收紧到 `min(220px, 32vh)`。
- **可见范围 = 可操作范围（0.20.0 起，0.23.0 拆分读写）**：`memory_search` / `memory_list` / `memory_get` 与 `memory_save` / `memory_forget` 共用同一份可见域；0.23.0 起每个作用域的「可读 / 可写」状态独立生效，失败原因会写进工具回复。面板管理页仍是用户本人的操作，不受会话语义限制。

### 向量服务

在本机托管 `llama-server`，下载运行时与模型；内置清单为每个模型配好 `dims` 与 `pooling`，
避免维度写错导致向量通道静默失效。按硬件推荐，也支持自定义 GGUF。

![向量服务](https://raw.githubusercontent.com/RestRegular/dsh-memory/main/preview/memory-service.png)

## 安装

一条命令装进 Web profile：

```bash
dsh plugin --profile web add @restregular/dsh-memory
```

也可以手动加进 profile 的依赖（桌面端 `~/.dsh/profiles/desktop`，Web 端 `~/.dsh/profiles/web`）：

```bash
pnpm add @restregular/dsh-memory
# 或
npm i @restregular/dsh-memory
```

装进任意 DSH profile（桌面端 `~/.dsh/profiles/desktop`，Web 端 `~/.dsh/profiles/web`）。
包自带 `cordis.patch.yml`，注册**唯一一条** entry：

```yaml
- insert:
    - id: dsh-memory
      name: '@restregular/dsh-memory'
```

**不写任何配置就能用**：检索退化为词法，不产生任何网络请求。需要语义检索时，
在面板「服务 → 向量服务」里一键装本机后端即可。

> 宿主只允许**一个包名、一个解析源**，所以本插件是「一个包 + 一条 entry + 面板与服务端同包」。
> 拆成两个包会触发 `resolves from multiple active Loader sources`，客户端图组合失败，
> 桌面端直接起不来。这段设计约束写在下面的折叠块里，不影响使用。

<details>
<summary>为什么是一个包（给想改结构的人）</summary>

宿主的 `dsh-client-modules` 只在「某条**活的** Loader entry 能解析到包名」时才为该包提供
client bundle，并且 `reconcilePackage` 要求一个包名只有一个解析源。因此稳定形态只有一种：
**一个包名、一条 entry、两侧都在**。入口 `lib/index.js` 组合四个半边，每个半边各自
try/catch——任何一半失败都只记一行日志，绝不让 DSH 启动失败。

| 半边 | 作用 |
| --- | --- |
| `lib/provider` | 提供 `memory` 服务：JSONL 存储、双通道检索、向量回填、向量后端生命周期与一键安装 |
| `lib/tools` | 注册五个模型工具 |
| `lib/inject` | `agent/pre-step` 召回、摘要、策略、规则与行为触发 |
| `lib/panel` | `/memory/api` 管理接口（含同源 / 登录围栏） |
| `lib/client.js` | 设置页「记忆系统」区块与左侧栏入口（注册 id == 包名） |

</details>

## 快速开始

### 1. 打开面板

设置页 →「记忆系统」；也可以在「设置 → 侧栏入口」打开左侧栏的「记忆系统」按钮。
面板分四个标签：**服务 / 记录 / 记忆树 / 设置**。记录页的搜索框旁有「语义检索」开关，
开启后可以直接用一句话主动搜索（需要先配置向量后端）。

### 2. 存一条记忆

模型自己会调，也可以直接对 Agent 说「记住：……」。工具入参如下：

```jsonc
memory_save({
  "content": "本仓库用 pnpm 11 安装依赖；PATH 上的 pnpm 10 会报 ERR_PNPM_UNEXPECTED_STORE。",
  "kind": "procedure",            // fact / decision / preference / procedure / note / rule / state
  "tags": ["pnpm", "toolchain"],
  "triggers": ["pnpm", "install"], // 可选：流程索引按工具名/关键词匹配；缺省用 tags
  "importance": 0.8,              // 0~1
  "expiresAt": 1793836800000,     // 可选：过期时间(ms)；kind=state 不传时按默认 TTL(7 天)，也可传 ttlMs
  "path": "D:/repositories/dsh-memory" // 可选：写入 project:<该路径>
})
```

### 3. 检索、取全文、列出、忘记

```jsonc
memory_search({ "query": "pnpm 装依赖", "topK": 5, "description": "查装依赖的约定" }) // 只回 id / 作用域 / 类型 / 标签 / 摘要
memory_search({ "query": "旧的发布流程", "includeSuperseded": true, "description": "核对旧发布流程" }) // 默认隐藏被修正/覆盖的旧版本
memory_get({ "ids": ["3f2a9c1d"], "description": "取装依赖那条的全文" })          // 默认：正文 + scope + kind + tags
memory_get({ "ids": ["3f2a9c1d"], "fields": ["summary", "updatedAt"] })
memory_get({ "ids": ["3f2a9c1d"], "fields": ["content"] })         // 只要正文
memory_list({ "limit": 20 })
memory_forget({ "id": "3f2a9c1d", "description": "删除过期的临时结论" }) // 按内容删：memory_forget({ query, scope })
```

`memory_search` 不再返回正文：每条只有 8 位 id、作用域、类型、标签和摘要（默认 160 字，
`summaryChars` 可调 20~2000）。判断相关后用 `memory_get` 取正文或元数据：

- `fields` 省略 = `content + scope + kind + tags`（与旧版看到的一致）；
- 只取摘要：`["summary"]`；只取正文：`["content"]`；
- 元数据可选 `importance` / `createdAt` / `updatedAt` / `expiresAt` / `triggers` / `supersedes`；
- `id` 始终返回；未知字段会明确报 `FIELDS_INVALID`，不会静默忽略。

`memory_search` 省略 `scope` 时合并**会话 + 项目 + global**（按来源标注、按 id 去重）；
`scope: "all"` 查所有已发现的作用域，写入路径会明确拒绝 `all`。

**上下文去重（0.21.0）**：同一会话里已经由 `memory_search` / `memory_list`（或摘要 / 召回 / `memory_get`）
放进上下文的条目，再次命中且 `updatedAt` 未变时，`memory_search` / `memory_list` 只回记忆 ID，并附一句
「本次请求部分记忆摘要因上下文去重机制被省略，若要获取完整内容请使用 memory_get」；内容更新（版本变化）
后会重新返回摘要。`memory_search` 里这些裸 ID 单独成块，与带摘要的条目之间**空一行**，不会看起来像
上一条的续行。状态与召回/摘要共用同一份会话去重记录（`summary_injected` / `content_injected`）。

**`description`（0.22.0）**：六个工具都新增 `description` 参数 —— 一句话说明这次调用要做什么。
本会话「记忆权限」为**普通限制**（默认）时**必填**，漏了会被 `DESCRIPTION_REQUIRED` 拒绝；
绝对限制 / 无限制下可省略。它只用于范围外访问的审批卡（展示给用户判断是否放行），不写进记忆。

### 4. 作用域怎么选

| 写法 | 含义 |
| --- | --- |
| 省略 / `session` | **当前会话**（子代理共享父会话；拿不到会话信息时回退当前项目） |
| `project` | 当前工作区（键是 `project:<cwd>`） |
| `path` + 可选 `scope` | 指定工作区目录；`scope` 成为这个项目作用域的显示名（别名） |
| `global` | 所有项目共享 |
| `handbook`、`项目笔记` … | 自定义作用域，首次 `memory_save` 自动创建（Agent 创建时必须带 `scopeDescription`） |
| `session:<id>` / `project:<path>` | 显式钉住某个会话 / 工作区 |
| `all` / `*` | **只在读取时可用**：跨所有已发现作用域 |

项目作用域的身份永远是 `project:<绝对路径>`，别名只影响显示与引用，不迁移数据。
同一路径重复用同一个名字是幂等的；换名字会覆盖原别名；另一个路径抢同一个名字会被拒绝
（`SCOPE_NAME_TAKEN`）。

**新建自定义作用域（0.24.0）**：Agent 必须说明用途，可选写一条初始规则；两者在同一次
`memory_save` 里原子写入（元数据先落 `pending`，记录与规则写完后转 `ready`，中途失败下次保存会续上）：

```js
memory_save({
  scope: "handbook",
  content: "本作用域用于收集团队约定、流程与踩坑记录。",
  kind: "fact",
  scopeDescription: "团队约定与流程；只放可复用的结论，不放一次性排错日志。",
  scopeRule: "只记录与团队协作 / 发布 / 工具链有关的内容；一次性排错过程不进这里。",
  description: "初始化团队约定作用域"
})
```

用途会出现在 `memory_scopes` 的目录里：

```js
memory_scopes({ action: "list", description: "看看有哪些作用域、各自干什么" })
```

绝对限制下**目录可见但正文不可读**：范围外作用域仍显示名字与用途（方便判断要不要让用户
调整范围），但记录数、正文、申请入口都不会返回。

**申请本会话权限（0.24.0 / D3）**：普通限制下，Agent 可以对**范围外**作用域发申请；
默认只申请只读，写权限必须显式列出：

```js
memory_scopes({
  action: "request",
  scopes: ["handbook"],
  permissions: ["read"],
  reason: "需要团队约定与发布流程",
  description: "申请读取 handbook"
})
```

审批卡默认只勾只读；用户勾上写权限才会授予写。批准后写入
`<storeDir>/grants/<session>.json`（本会话 + 子 Agent 继承），不会改可见域策略；
`absolute` 下所有申请都返回 `not-requestable`，不会弹卡。一次性访问仍走 `memory_*`
自己的隐式审批，不需要先申请。

### 5. 导入 / 导出

导出是纯文本 JSON：作用域、类型、内容、标签、重要度、时间戳，**不含向量**。
导入时逐条走保存路径，按当前模型重新嵌入，并按「作用域 + 内容」去重；一次最多 5000 条。

## 注入链路

| 层 | 触发 | 作用 |
| --- | --- | --- |
| `recall` | 每轮 `agent/pre-step` | 按本轮用户问题检索，按 topK / token 预算注入；默认只给每条 120 字摘要 + `memory_get` 指引 |
| `digest` | 会话第一步 | 注入项目 + global 概览：按重要度 × 新鲜度挑选；`kind=rule` 不进摘要（已常驻系统提示）；正文超预算时附可检索的标签索引 |
| `policy` | 系统提示常驻 | 什么时候查记忆、查到怎么复用、查不到时低风险推断 / 高风险先问用户 |
| `rules` | 系统提示常驻 | `kind: rule` 的硬性规则摘要；每行 `id · 正文`，需要全文时 `memory_get`；限量与预算；`mandatory` / `pinned` 排在最前 |
| `procedures` | 系统提示常驻 | `kind: procedure` 的目录：当前工作区 + 触发词命中的流程，每行 `id · 触发词 → 标题`；正文按需 `memory_get` |
| `turnEnd` | 每轮结束（默认关） | 下一轮开头提醒「有可复用结论先落盘」 |
| 行为召回 | 可见文本 / 任务 / 命令 / 工具失败 | 命中标签后，在**下一个** `agent/pre-step` 定向检索；工具失败优先用该工具自己的 description |

行为召回只检索 **global + 当前会话 + 当前工作区**，不把自定义作用域或 fork 父会话带进来。
匹配源包括可见 assistant 文本、todo、`command/run`、`goal/change`、带 `description` 的 `tool/call`，以及工具失败描述；**没有 `description` 的工具调用不触发**，`memory_*` 工具一律不触发（`memory_search` 本身在取记忆，再召回一次只会重复注入）。**不读取隐藏思维链**。

### 规则会跟进旧会话

系统提示段每步都会重渲染，但那只是提示词文本变化，不会产生对话消息；常驻段还有 token 预算，
新规则可能被更重要的旧规则挤掉。`rules.delta`（默认开）会在每轮第一步比较「该会话上一轮开始时
的规则快照」与当前规则：新增、以及编辑过（同一 id 的行变了）的规则都补一条提醒，没变化不重复；
宿主重启用历史里的规则行做种子，不会整批重提醒。关掉它只停提醒，常驻段与检索照旧。

规则段注入的是**摘要**：每行是 ``- `<8位id>` <正文前240字>``。段头会明确说明这一点，模型需要完整规则或细节时用 `memory_get` 按 ID 取；因此规则再长也不会把整段正文常驻在系统提示里。

### 流程索引（procedure）

流程通常很长，全部常驻会挤爆系统提示；而注入发生在 `agent/pre-step`，模型决定调用工具之前拿不到工具名。
所以系统提示里只放一个**目录**：当前工作区的 `procedure` 总是可见；其他作用域的流程必须命中
`triggers`（缺省用 `tags`），匹配源是本轮用户消息、本会话最近调用过的工具名和当前项目路径。
每行是 `id · 触发词 → 标题`，模型判断相关后用 `memory_get` 取全文。条数与 token 预算可在设置里调；
没有命中项时不注入。

### 去重与修正

- 召回按 **sessionId + 记忆 id / 版本** 去重；只给过标签的记录，任务命中后可补正文；内容更新会重新评估。
- **工具结果也参与去重（0.21.0）**：`memory_search` 返回过的摘要记为 `summary_injected`，`memory_list` 返回过的正文记为 `content_injected`。同一会话再次命中同版本条目时只回记忆 ID 并提示用 `memory_get` 取全文；版本变化（`updatedAt`）后重新返回。标签索引（`hint_injected`）只给 id + tags，不算摘要已出现；`memory_get` 始终显式返回正文，不做去重。
- `memory_get` 取到正文后，这条记忆会记成「正文已注入」；同一会话后续的普通召回 / 摘要 / 自动召回都不会再把同一段正文塞一遍。只取 `summary` / `tags` / 元数据不算正文，仍可被召回。
- `memory_save` **保存成功**同样算「正文已在上下文里」：写入语句（`content`）就是模型自己产出的 tool/call 参数，因此这条记录会立刻记成「正文已注入」，本会话后续的召回 / 摘要不会把刚保存的记忆原样再注入一次（去重命中既有记录时也一样）。保存失败不标记；记录之后被更新（`updatedAt` 变化）仍会重新评估。审计里会留一条 `content_pinned / saved_in_context` 的 lifecycle 事件，说明后面的「去重跳过」从哪来。
- **去重状态持久化**：状态写到会话工作区的插件目录
  `<cwd>/.dsh/dsh-memory/sessions/<session>.jsonl`，插件重载 / 宿主重启后自动恢复；只有首次接触该会话时读一次盘。
  - 只存记录 id、状态、版本（`updatedAt`）和时间戳，**不存正文，也不存查询**。
  - JSONL 增量日志：默认 250ms 合并写一行，写延迟不随状态大小增长；行数 / 字节超过阈值时 compact 成一行快照（临时文件 + rename 原子替换）。
  - 每个工作区默认保留 30 天、最多 1000 个会话文件；目录不可写或文件损坏时自动退化为内存去重，不阻断注入。
  - 插件配置 `inject.sessionState.{enabled,dir,debounceMs,maxAgeDays,maxFiles}` 可覆盖默认值；默认开启。
  - 工作区里的 `.dsh/` 已加入本仓库 `.gitignore`；其他项目按需自行忽略。
- 被 `supersedes` 指向的旧记录不再进入 `memory_search`、`memory_list`、摘要、规则段和自动召回；`memory_get(id)` 与面板仍可查历史。需要历史检索时 `memory_search({ includeSuperseded: true })`。
- 摘要排除 `kind=rule`；规则段实际进入系统提示的 id 会写进会话注入状态，recall 不再重复注入同一条规则。
- 同一轮最多发生一次 signal 驱动召回；同 tag / 同 query 的第二个信号只记一条 `signal_dropped` 审计。
- `kind=state` 过期后默认从检索 / 摘要 / 召回 / 列表隐藏，但数据不删除；`memory_get` 与面板仍可取。
- compaction 后重置摘要与注入去重状态。

## 检索

- **词法通道**：IDF 加权 + 中文 bigram；记录标签也并入可检索文本，所以中文正文 + 英文标签也能被标签查询命中。
- **向量通道**：调用 `llama-server` 的 OpenAI 兼容 `/v1/embeddings`；可用面板一键安装，也可接自己的端点。
- **可选 LLM 重排**：`retrieval.llm.enabled`，默认关。
- **自动降级**：端点没配、进程没起、向量身份不匹配时，只走词法，不报错、不阻塞。
- **面板主动语义检索**：记录页的「语义检索」开关走 `GET /memory/api/search`，用同一套召回排序
  （只读、不写访问计数），并在结果说明里标明向量通道是否真的参与；旧 provider 会退回关键词过滤并在界面注明。

向量边车 `.vec` 的首行是身份头 `#<model>\t<dims>\t<pooling>`。任一对不上就整份丢弃并重新嵌入；
重建期间检索暂时只用词法。老边车只有 `model` + `dims` 两段，按兼容接受，下一次写向量时自动升级。
**换模型 = 向量作废重建**，面板会在切换前告诉你涉及多少条记忆。

`minScore` 默认 `0.5` 是按 BGE 的 CLS 噪声底定的；换模型后如果召回太少就调低、太杂就调高。

## 向量后端与硬件

- **内置 8 个模型**：BGE-M3（Q4_K_M / Q8_0）、Qwen3-Embedding 0.6B / 4B / 8B、Nomic Embed v1.5、BGE 中文 small / base / large。
- **维度与 pooling 自动配对**：每个模型自带 `dims` 与 `pooling`，选它就自动写入。维度写错会让向量通道静默失效，这是最容易踩的坑。
- **按本机推荐**：探测 CPU 核数 / 内存 / 磁盘剩余 / 显卡与显存；质量优先，能整块放进显存就用 GPU；CPU 上重罚 4B / 8B；显存 < 4GB 的核显不算可用显卡。
- **运行时风味**：`cpu` / `vulkan` / `cuda` / `metal` / `auto`。Vulkan 自包含；CUDA 会一并下载 cudart 伴随包；所选风味找不到时退回 CPU 并在面板说明。
- **自定义 GGUF**：填 URL + 维度即可装清单之外的模型；需要前缀的模型（Nomic 的 `search_query:` / `search_document:`）自动带上。
- **一次只保留一份**：已装运行时 + 模型时不能再装第二个；换模型先去「维护 → 卸载向量服务」，否则「现在跑的是哪个」说不清。

```yaml
retrieval:
  vector:
    preset: 'qwen3-embedding-0.6b'   # 清单 id
    variant: 'q8_0'                  # 量化档
    flavor: 'auto'                   # auto / cpu / vulkan / cuda / metal
    # customModel: { url: 'https://…/model.gguf', dims: 1024, pooling: 'auto' }
```

`spawn.enabled: true` 时，应用启动会后台拉起向量服务、退出时自动关闭；带 PID 文件的遗留实例会被接管，
没有 PID 文件的外部实例不接管。

## 配置

```yaml
- id: dsh-memory
  name: '@restregular/dsh-memory'
  config:
    storeDir: '~/.dsh/memory-store'       # 建议绝对路径；默认 .dsh-memory
    scopes:
      global: true
      project: true
      session: true
      custom: { enabled: true, max: 200 } # 只统计自定义作用域
    retrieval:
      topK: 5
      recallN: 30
      vector:
        enabled: true
        endpoint: 'http://127.0.0.1:8078/v1/embeddings'
        model: bge-m3
        dims: 1024
        timeoutMs: 300                     # 交互检索预算，要紧
        writeTimeoutMs: 10000              # 保存时嵌整条记录
        backfillTimeoutMs: 30000
        backfillMaxChars: 8000
        spawn:
          enabled: true
          exe: '/path/to/llama-server.exe'
          model: '/path/to/bge-m3-Q4_K_M.gguf'
          cwd: '/path/to/llamacpp'         # 目录里要有 llama-server-impl.dll
          logFile: '/path/to/llama-server.log'
      llm: { enabled: false }
    limits: { maxRecordsPerScope: 2000, maxRecordChars: 4000 }
    secrets: { enabled: true, mode: refuse }   # refuse | redact
    tools: { defaultScope: session }            # session / project / global
    inject:
      enabled: true                             # 整个注入半边总开关
      extraScopes: ['handbook']                 # 可选：额外参与普通召回的 scope
      recall: { enabled: true, topK: 5, tokenBudget: 500 }
      impression: { enabled: true, chars: 120 }
      digest: { enabled: true, topK: 8, tokenBudget: 800, hintBudget: 160, hintMaxItems: 6 }
      policy: { enabled: true }
      rules: { enabled: true, maxItems: 10, tokenBudget: 300, delta: true }
      turnEnd: { enabled: false }
    panel: { route: '/memory/api' }
```

面板改过的值写入 `<storeDir>/settings.json`，**优先级高于这里的配置**。
注入分层各自独立开关；`inject.enabled: false` 全关，但工具检索不受影响。

只有写了 `endpoint`、配了 `spawn`、或面板里装了本地后端，插件才会碰网络；否则一个请求都不发。

## 数据与文件布局

| 路径 | 内容 |
| --- | --- |
| `<storeDir>/global.jsonl` | global 作用域，一行一条 |
| `<storeDir>/projects/<sha1(scope)>.jsonl` | 其它作用域（会话 / 项目 / 自定义）；文件名是 scope 键的 SHA-1，路径分隔符无法穿越 |
| `<storeDir>/projects/<sha1(scope)>.vec` | 向量边车；首行 `#<model>\t<dims>\t<pooling>`，后面每行 `id\t<base64 向量>` |
| `<storeDir>/settings.json` | 面板设置（覆盖配置文件里的默认值） |
| `<storeDir>/scopes.json` | 项目作用域别名（显示名 → `project:<路径>`） |
| `<storeDir>/scope-meta/<sha1(scope)>.json` | 作用域用途 / 来源 / 创建者 / 创建代次 / 初始化状态；每个作用域一个文件，删光记录也不删元数据 |
| `<storeDir>/grants/<session>.json` | 会话级作用域授权（Agent 申请、用户批准）；只读 / 可写分开、可撤销、带作用域创建代次 |
| `<storeDir>/approvals.jsonl` | 审批与授权生命周期审计（requested / approved / denied / timeout / granted / revoked）；只记 scope 与权限，不记记忆正文 |
| `<storeDir>/visibility/<session>.json` | 会话「记忆权限」的可见范围覆盖（作用域 + 限制等级）；没有文件 = 使用默认三路集合 |
| `<storeDir>/*.lock` | 跨进程写锁；陈旧锁（持有者已死或 10s 未动）会被接管 |
| `<installRoot>/llamacpp/` | llama-server 运行时、依赖 dll、`llama-server.log` |
| `<installRoot>/models/` | 下载的 GGUF 模型 |
| `<installRoot>/selected-model.json` | 面板里选过哪一档 |

`storeDir` 默认 `.dsh-memory`（相对启动目录），**建议显式配一个绝对路径**。文件首次写入才创建；
作用域被删空后，它的 `.jsonl` 与 `.vec` 会在下一次落盘时一起移除（`global.jsonl` 例外：只清内容、留文件）。
作用域元数据（`scope-meta/`）独立于记录：删光某个作用域的最后一条记忆，不会删除它的用途说明。

scope 键有三种形态：`global`、`project:<cwd>`、`session:<会话 id>`，其余是自定义名
（小写折叠、内部空白折成一个空格、最长 64 字符，禁止 `:`、路径分隔符、控制字符、`..`
与保留名 `global/project/session/all`）。**没有任何数据迁移**：旧的 `project:<cwd>` 文件继续原样读写。

`installRoot` 默认 `~/.dsh/memory-vector`；显式配了 `storeDir` 时取它的父目录。

### 多进程共用

写入按 scope 走锁文件，每次「锁内重新读盘 + 合并本次增量」，不再用内存快照整份覆盖磁盘；
读路径每秒 stat 一次，别的进程刚写的记录不用重启就能看到。实测 4 个进程 × 20 条并发写同一个 scope 零丢失。
已知取舍：同内容去重仍是进程内判断，两个进程同时写**完全相同**的内容理论上会落两条。

## 安全

- `/memory/api` 的每条路由都先过 `refuseRequest`：宿主 `connection.requestRejection` 可用时以它为准
  （Host / Origin 围栏 + 浏览器登录），围栏抛错一律 403（失败关闭）；旧宿主没有该服务时退化为
  「只认 loopback 权威 + 同源」。原因是注册在裸 `webServer` 上的路由不在宿主 `/api` 围栏之后，
  而这里的接口能读、改、删、清空全部记忆。
- 记忆内容写入前过凭据扫描（`secrets.mode: refuse | redact`），默认拒绝。
- **统一授权判定（0.24.0）**：`discover / read / write / delete` 都走 provider 的同一个纯函数 `authorize()`；工具层只决定“要不要发起审批”，不再各自解释绝对 / 普通 / 无限制。`absolute` 下不存在任何审批放行路径；显式关掉「可读 / 可写」的作用域也不通过审批放行。
- 清空记忆是两步确认 + 接口要求显式 `confirm: "delete"`。
- 数据默认只在本机：JSONL 不加密，向量端点默认 loopback；请自行保护 store 目录，导出文件也是明文。

## 诊断与审计

面板顶部有独立的「审计」标签页，不需要手工请求 HTTP。它按事件流展示每次注入的评估、过滤、预算、投递与失败原因，并支持按会话 / 通道 / 结果 / 时间筛选、分页、详情抽屉和导出当前筛选。

审计严格区分三件事：

- **评估（evaluation）**：候选、选中、省略、预算、检索/加载结果；
- **投递（delivery）**：最终消息是否通过本地保护并被放进上下文；
- **使用/遵守**：Agent 后续是否引用或执行了记忆。当前系统无法可靠证明，面板不会声称已验证。

因此 `selected.contentIds` 只表示“评估选中”，不等于“已投递”。宿主没有向 middleware 回执最终采纳结果时，`delivery.status` 记为 `unknown`（面板显示“已准备（投递未确认）”），不会乐观写成 `appended`。

### API

```text
GET /memory/api/audit
  ?session=<id>&trace=<id>&operation=<id>&memory=<id>
  &channel=digest|recall|rules|rules_delta|policy|nudge|signal|lifecycle
  &trigger=<trigger>&outcome=success|failed|skipped|partial|unknown
  &problem=1&since=<ms|ISO>&until=<ms|ISO>&limit=1..200&cursor=<seq>

GET /memory/api/audit/stats
GET /memory/api/audit/export?format=json|jsonl&<same filters>

GET /memory/api/anchor?session=<id>&turn=<n>&step=<n>&callId=<optional>

GET  /memory/api/visibility?session=<id>
POST /memory/api/visibility   { session: "<id>", scopes: ["session:<id>", "project:<cwd>", "global"] | null }
```

响应为 `{ ok: true, value: { entries, total, nextCursor?, stats, query } }`。旧调用 `GET /audit?session=<id>` 仍兼容；不带 `session` 时查询全部会话，`query.scope` 会标记为 `all`。

`/visibility` 返回 `{ sessionId, override, effective, inherited, scopes }`：`override` 是该会话自己的覆盖（`null` = 使用默认集合），`effective` 是当前实际生效的读取范围，`inherited` 表示是否继承自父会话，`scopes` 是可勾选的作用域目录（含 `label` 与记录数）。保存 `scopes: null` 即恢复默认；空数组会被拒绝（至少保留一个范围）。

### 和会话轨迹互相跳转

DSH 自带的 Trajectory 面板是一个**纯投影**：它只声明 `conversation.trajectory.images` 一个子槽，没有行/列扩展点，选中状态也只存在组件内部。因此插件不能直接往轨迹表格里插审计行。当前采用的是一条不碰轨迹 React 树的组合：

- **轨迹 → 记忆审计**：Trajectory 的选中行带有 `data-trajectory-row-key`。注意它在 DOM 上经过 `encodeURIComponent`（工具行实际是 `tool%00call%00<callId>`），插件会先解码再取 callId。有审计的调用行左侧会显示产品年轮线条图标；选中行右侧另有「记忆 N」徽标，点击按 `op:<callId>` 打开审计。两者都会按轨迹滚动容器（扣除 sticky 表头与底部浮动 composer）裁剪，行滚出可视区后被遮住时不会残留。
- **轨迹详情页签**：点击轨迹里的任意记录后，右侧详情面板的页签行会多出一个「记忆审计」页签（用 `shell.overlay` 贴着详情面板，不改轨迹的 React 树）。它展示该记录 callId 对应的审计事件，底部按钮直接打开本会话的记忆审计面板；没有 callId 的记录明确提示无法精确过滤。
- **记忆审计 → 轨迹**：审计详情里的「在轨迹中定位」把条目上的 `operationId`（记忆工具调用、触发召回的工具调用）交给 Trajectory 的 `openView('trajectory', callId)`；主面板会先打开会话，再切换轨迹并选中该记录，右侧详情面板自动打开。没有 `operationId` 的按轮/步事件先请求 `/anchor`，由 Host 从会话事件窗口里找该 turn/step 的第一个 `tool/call`；找不到就只切到轨迹页，不伪造定位。
- **会话内的「记忆」视图**：与 Chat / 轨迹同一个 view ring，按当前会话展示审计；它直接使用宿主传给每个 view 的 `openView`，因此跳转是官方支持路径。它声明 `data-conversation-composer-overlay` 让壳层压住外层滚动，审计列表在自己的滚动容器里滚动，外层界面不需要跟着滚。主面板不在 view ring 内，通过 `conversation.session` 注册的 per-session store 调同一个 action；拿不到时退化为打开会话/轨迹页。
- 记忆工具调用（`memory_save/search/list/get/forget`）本身会额外留一条 `stage: tool_call` 的审计锚点：即使自动召回关闭，也能从这条记录精确跳回轨迹里的那次调用。

`/anchor` 只返回 `{ callId, tool?, turn?, step?, reason }`，不返回工具参数、消息正文或记忆内容；找不到会话/工具时 `callId` 为 `null` 并给出稳定 `reason`。

审计数据默认**只在内存**：容量 2000 条、每会话 200 条，超出时优先保留 digest / rules / delivery / error 等关键通道；`stats` 暴露 `entries / capacity / dropped / writeErrors / persistence`。重启后记录丢失，面板会明确提示。

写入前所有自由文本都经过统一 sanitizer：先限制扫描长度（4000 字符），再做凭据模式脱敏，最后截到 200 字；只保存 ID、计数、枚举原因、字符数和短 hash，不保存记忆正文、原始工具参数、异常堆栈。模式脱敏是保守匹配，不承诺覆盖所有秘密形状。

## 卸载 / 迁移

```bash
pnpm remove @restregular/dsh-memory   # 再从 profile 的 patch 里删掉那条 entry
```

卸载插件**不会**移除已配置的向量服务与记忆文件——它们不在 `node_modules` 里，而是在
`<storeDir>` 与 `<installRoot>`。要清掉，先打开面板「服务 → 维护」：

- **卸载向量服务**：删运行时与模型（两步确认，显示释放空间）；记忆数据保留。
- **清空记忆数据**：删全部 JSONL 与向量边车（两步确认，不可恢复）。

插件被卸掉后面板就打不开了，所以这件事只能在卸载**之前**做。迁移时直接复制这两个目录即可；
只想带走记忆内容，用「设置 → 数据 → 导出」。

## 开发

```bash
npm test        # node --experimental-strip-types --test source/*/test/*.test.ts
npm run build   # source/ → packages/dsh-memory（含产物契约检查）
npm run verify  # 构建到 .verify/，不落 packages/
```

构建用 Node 内置类型剥离，相对 `.ts` 说明符改写为 `.js`，每个产出文件 `node --check`。
产物契约检查覆盖会**静默失败**的几处：patch 恰好一行、`exports` 放行 `./client` 与 locale、
`__ModuleLoader__.load({ id })` 等于包名、四个半边的相对 import 都在、`icon.svg` 体积在宿主上限内。

> 发布：`node tools/publish-npm-packages.mjs --scope @restregular --version x.y.z`。
> npm token 不经过命令行，默认从 DevCred 读取，由 `devcred inject` 写进临时 `.npmrc`，发布后连目录删除。
> npm 的暂存发布会短暂出现版本不可下载、`latest` 未更新；先轮询确认，不要重复发布或 bump 版本。

## 常见问题

**向量服务起不来**
看 `<installRoot>/llamacpp/llama-server.log`。常见原因：端口被占、`cwd` 里缺 `llama-server-impl.dll`、
模型与运行时风味不匹配（比如 GPU 风味但没驱动）。

**检索很差 / 全是词法命中**
先看面板「当前模型」那行的维度是否与模型一致，再看 `.vec` 身份头。维度或 pooling 写错不会报错，
只会让向量通道悄悄失效。`minScore` 可能需要按模型微调。

**想换模型**
先「维护 → 卸载向量服务」再装；换完现有记忆会重新嵌入。

**面板里看不到「记忆系统」**
包名与 Loader entry 必须一一对应；确认 profile 的 patch 里只有一条 `@restregular/dsh-memory`，
以及依赖真的装上了。

**插件列表里还是包名，没有「记忆系统」**
先确认版本 ≥ 0.11.0 且包里有 `locale/` 目录；然后**重启一次 DSH 桌面端**。宿主的 Node 进程会缓存
`package.json` 的 `exports` 映射，原地更新不会让这份缓存失效；重启后恢复，之后的版本更新不再需要。

**记忆没有自动召回**
确认 `inject.recall` / `autoRecall` 已开、当前作用域在召回范围内（标签触发的自动召回只含 global + 当前会话 +
当前工作区，普通每轮召回按 `inject.extraScopes` 配置），并检查标签是否真的命中。打开面板顶部的「审计」标签页，
按会话/通道/问题筛选即可看到触发原因、候选、过滤、省略、预算和投递状态；也可以直接请求
`GET /memory/api/audit?session=<id>`。

**作用域列表里出现两个同名路径 / 用 `path` 存的记忆工作区里看不到**
0.11.0 及以前，`D:/repo` 与 `D:\repo` 会被当成两个项目作用域（写的人用正斜杠、会话读的是宿主给的反斜杠）。
0.11.1 起路径写法统一，首次启动会把历史分叉合并到规范键（记录、别名都跟着走，旧文件删除）。

**数据怎么备份**
复制整个 `<storeDir>`；或用面板导出 JSON。导入会按当前模型重新嵌入，不携带旧向量。

## 更新日志

- **0.22.3** —— 审批卡高度与宿主审批卡同口径（去掉额外的 `46vh` 上限），矮窗口下详情行固定后条目列表仍有滚动空间。
- **0.22.2** —— 修复审批卡条目不显示 Agent 查询 / 说明：两行原来带 `overflow:auto`，在 flex 列里会被长列表压成 0 高；现在锁 `flex:none`，只让列表滚动。
- **0.22.1** —— 审批卡可折叠（strip 上「折叠 / 展开」，折叠后动作行仍可用），读审批条目整行点击即可选中。
- **0.22.0** —— 审批卡支持「全选 / 取消全选」，展示工具调用的 `description`，点记忆 ID 跳到面板「记录」页并展开；`memory_*` 新增 `description`（普通限制下必填）；`memory_search` 的去重裸 ID 与带摘要条目之间空一行。
- **0.21.0** —— 范围外审批卡改为会话内展示（对齐系统权限审批的样式与行为），读审批支持逐条勾选允许；`memory_search` / `memory_list` 引入会话上下文去重，已出现过的条目只回记忆 ID 并提示用 `memory_get`（内容更新后重新给摘要）。
- **0.12.7** —— 审计详情可完整滚到底；ID 浮窗改为按气泡位置固定显示，延迟 hover 显示、可移入浮窗，点击气泡或浮窗都直接跳转。
- **0.12.6** —— 审计详情分类展示选中/新增/标签/省略/去重 ID；记忆与会话 ID 支持 hover 浮窗和点击跳转；详情独立滚动可到底。
- **0.12.5** —— 审计表头移入滚动容器并 sticky，与行严格对齐；重分配列宽，行内预算改紧凑条。
- **0.12.4** —— 审计页默认每 0.5 秒自动刷新（可关/可调间隔）；移除顶部标题与气泡，整页固定在窗口内，仅列表滚动；新增表头并优化列宽；复制/导出提示就地显示。
- **0.12.3** —— 审计页筛选改为两行紧凑布局与自绘时间范围/开关；事件列表放入独立滚动容器。
- **0.12.2** —— 修复 `CordisMemoryService` 未转发审计方法，导致审计页显示“provider 未提供注入审计接口”；升级后需重启 DSH。
- **0.12.1** —— 审计 v2 收尾：详情无障碍/唯一 key、JSON 导出、摘要渲染失败记录、部分注入 outcome。
- **0.12.0** —— 注入审计 v2：评估/投递分离、失败与跳过可解释、统一脱敏、有界存储与容量统计、分页筛选 API、独立「审计」标签页与 JSON/JSONL 导出。
- **0.11.1** —— 修复项目作用域因路径写法不同而分叉：`D:/repo` 与 `D:\repo` 统一成同一个键，历史分叉首次启动自动合并。
- **0.11.0** —— 插件显示名改为「记忆系统」，重写 README 并更新截图；无 API / 配置 / 数据格式变更。
- **0.10.1** —— 深色模式开关跟随宿主 token，修复白点融进白轨道。
- **0.10.0** —— 多进程安全写入、向量身份加入 pooling、读路径能看到其它进程的新写入。

完整记录见 [CHANGELOG.md](https://github.com/RestRegular/dsh-memory/blob/main/CHANGELOG.md)。

## License

[MIT](https://github.com/RestRegular/dsh-memory/blob/main/LICENSE)

---

English: **Memory System** — local-first long-term memory for DeepSeek Harness. One npm package,
one loader entry: JSONL storage, local vector recall through llama-server, five model tools,
automatic recall, hard rules, and a visual management panel. Memory stays on your machine.
