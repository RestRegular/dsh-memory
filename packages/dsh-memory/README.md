# dsh-memory

DeepSeek Harness 的本地长期记忆插件 —— **一个包、一条 Loader entry、四个半边**:JSONL 存储 + 本地向量检索(llama-server,OpenAI 兼容)+ 四个模型工具 + 自动召回注入 + 设置页管理面板。

[![npm version](https://img.shields.io/npm/v/@restregular/dsh-memory.svg)](https://www.npmjs.com/package/@restregular/dsh-memory)
[![license](https://img.shields.io/npm/l/@restregular/dsh-memory.svg)](./LICENSE)

English: Local, durable memory for DeepSeek Harness — one npm package, one loader entry: a JSONL store, local vector recall through llama-server, four model-facing tools, automatic recall injection, and a management panel in the settings page.

## 它给你什么

| 能力 | 说明 |
| --- | --- |
| **落盘存储** | 每条记忆一行 JSONL,按 scope 分文件(global / project),同 scope 内按内容去重;写入前过凭据扫描 |
| **双通道检索** | 词法(IDF + CJK bigram)**+** 向量(llama-server 的 `/v1/embeddings`)。向量缺席时自动降级为纯词法,**不报错、不阻塞** |
| **自动召回** | `agent/pre-step` 注入相关记忆(可关、有 token 预算、按 topK 截断) |
| **四个工具** | `memory_save` / `memory_search` / `memory_list` / `memory_forget` |
| **管理面板** | 设置页「记忆」:浏览 / 搜索 / 编辑 / 删除、向量服务启停、模型与硬件、维护(卸载 / 清空) |
| **向量后端一键装** | 面板里选模型 → 下 llama.cpp 运行时 + 模型 → 托管 `llama-server` 进程;内置 8 个模型 + 硬件推荐 + 自定义 GGUF |

## 安装 / Install

```bash
pnpm add @restregular/dsh-memory
# 或 npm i @restregular/dsh-memory
```

装进任意 DSH profile(桌面端 `~/.dsh/profiles/desktop`,Web 端 `~/.dsh/profiles/web`)。包自带 `cordis.patch.yml`,装好后自动注册**唯一一条** entry:

```yaml
- insert:
    - id: dsh-memory
      name: '@restregular/dsh-memory'
```

**不写任何配置就能用**:检索退化为词法,一个网络请求都不发。

### 为什么是一个包

宿主的 `dsh-client-modules` 只在「某条**活的** Loader entry 能解析到包名」时才为该包提供 client bundle,并且 `reconcilePackage` 要求**一个包名只有一个解析源**(否则抛 `resolves from multiple active Loader sources` → 客户端图组合失败 → 桌面端 fail-loud 起不来)。所以「一个包 + 一个面板」的稳定形态只有一个:**一个包名、一条 entry、两侧都在**(与 `dshmarket` 同形)。

早期把 provider / 工具 / 注入 / 面板拆成两个包、四条 entry;现在合并为一条 entry,由 `lib/index.js` 组合四个半边,每个半边各自 try/catch —— **任何一半失败都只记一行日志,绝不让 DSH 启动失败**。

| 半边 | 作用 |
| --- | --- |
| `lib/provider` | 提供 `memory` 服务:JSONL 存储、双通道检索、向量回填、向量后端生命周期与一键安装 |
| `lib/tools` | 注册 `memory_save` / `memory_search` / `memory_list` / `memory_forget` |
| `lib/inject` | 在 `agent/pre-step` 注入召回块(可关) |
| `lib/panel` | `/memory/api` 管理接口(含同源 / 登录围栏) |
| `lib/client.js` | 设置页「记忆」区块(注册 id == 包名) |

## 快速开始

**1. 存一条记忆**(模型自己会调,你也可以在对话里要求):

```jsonc
memory_save({
  "content": "本仓库用 pnpm 11 安装依赖,PATH 上的 pnpm 10 会踩 ERR_PNPM_UNEXPECTED_STORE",  // 必填,自洽的一句话
  "scope": "project",                       // global(所有项目) / project(当前工作区)
  "kind": "fact",                           // fact / decision / preference / procedure / note
  "tags": ["pnpm", "toolchain"],
  "importance": 0.8                         // 0~1
})
```

**2. 检索**:`memory_search({ query: "pnpm 装依赖", scope: "project", topK: 5 })`
**3. 列出 / 忘记**:`memory_list({ scope: "global", limit: 20 })`、`memory_forget({ id })` 或 `memory_forget({ query, scope })`。

**4. 打开面板**:设置页 →「记忆」。面板里能做的事:

- 顶部统计(记忆数 / 作用域数 / 待嵌入向量数)与记录列表(搜索、按作用域筛选、展开编辑、删除)
- 「向量服务」:状态、地址、启停开关、**模型与硬件**(见下)、维护(卸载向量服务 / 清空记忆数据,两步确认)

面板后端在 `/memory/api`,全部路由:`GET /status`、`GET /records`、`POST /update`、`POST /delete`、`GET /embed/status`、`POST /embed/start|stop`、`GET /embed/model`、`POST /embed/model/refresh|install|install/cancel|uninstall`、`POST /data/wipe`。

## 数据与文件布局

| 路径 | 内容 |
| --- | --- |
| `<storeDir>/<scope>.jsonl` | 记忆本体,一行一条。<br>`storeDir` 默认 `.dsh-memory`(相对启动目录),**建议显式配一个绝对路径** |
| `<storeDir>/<scope>.vec` | 向量边车。首行是身份头 `#<model>\t<dims>`,后面每行 `id\t<base64 向量>` |
| `<installRoot>/llamacpp/` | llama-server 运行时(exe + 依赖 dll + `llama-server.log`) |
| `<installRoot>/models/` | 下载的 GGUF 模型 |
| `<installRoot>/selected-model.json` | 面板里选过哪一档(比配置优先级低) |

`installRoot` 默认 `~/.dsh/memory-vector`;显式配了 `storeDir` 时取**它的父目录**(所以手写的 `<root>/llamacpp` + `<root>/models` 布局会被直接认出来)。

> **换模型 = 向量作废重建**。`.vec` 的身份头记录 `model` 与 `dims`,对不上就整份丢弃并重新嵌入;重建期间检索暂时只用词法。面板会在换之前告诉你涉及多少条记忆。

## 配置 / Configuration

provider 的配置在顶层,工具 / 注入 / 面板各占一个小节(合并前它们各是独立 entry 的 `config`):

```yaml
- id: dsh-memory
  name: '@restregular/dsh-memory'
  config:
    storeDir: '~/.dsh/memory-store'
    scopes: { global: true, project: true }
    retrieval:
      topK: 5
      recallN: 30
      vector:
        enabled: true
        endpoint: 'http://127.0.0.1:8078/v1/embeddings'
        model: bge-m3
        dims: 1024
        timeoutMs: 300            # 交互检索(短查询)预算,要紧
        writeTimeoutMs: 10000     # 保存时嵌整条记录
        backfillTimeoutMs: 30000  # 批量回填
        backfillMaxChars: 8000
        spawn:                    # 让插件托管 llama-server 进程(opt-in)
          enabled: true
          exe: '/path/to/llama-server.exe'
          model: '/path/to/bge-m3-Q4_K_M.gguf'
          cwd: '/path/to/llamacpp'   # 该目录须含 llama-server-impl.dll
          logFile: '/path/to/llama-server.log'
      llm: { enabled: false }     # LLM 重排(可选)
    limits: { maxRecordsPerScope: 2000, maxRecordChars: 4000 }
    secrets: { enabled: true, mode: refuse }
    tools: { defaultScope: project }              # 或 global;projectScope 默认 project:<cwd>
    inject: { enabled: true, tokenBudget: 500, topK: 5 }
    panel: { route: '/memory/api' }
```

向量检索是**按配置启用**的:写了 `endpoint`、配了 `spawn`、或面板里装了本地后端才会碰网络,否则一个请求都不发,检索自动降级为纯词法(IDF + CJK bigram)。不需要自动召回就 `inject.enabled: false`。

`spawn.enabled: true` 时:应用启动后台拉起向量服务、退出时自动关闭;带 PID 文件的遗留实例会被接管,没有 PID 文件的外部实例不接管。

### 模型与硬件

面板「记忆 → 向量服务」里有两行状态气泡 + 一块折叠区:

```
本机配置：[12 核][14GB 内存][显卡 …][磁盘剩余 9GB]        [重新检测硬件]
当前模型：[Qwen3-Embedding-0.6B][Q8_0][1024 维][last][cpu]  [下载并安装]
▸ 模型与硬件
```

- **本机配置 / 当前模型**两行是**标签气泡**,超宽横向滚动(不换行、不显示滚动条);本机配置在**面板一出现**就取一次(服务端对硬件探测有 10 分钟缓存,通常只是读缓存)。
- **内置清单 8 个模型**,下载源与体积都实测过:BGE-M3(Q4_K_M / Q8_0)、Qwen3-Embedding 0.6B / 4B / 8B、Nomic Embed v1.5、BGE 中文 small / base / large。每个模型自带 `dims` 与 `pooling`,**选它就自动配对** —— 维度写错会让检索静默退化成词法,这是最容易踩的坑。
- **按本机推荐**:探测 CPU 核数 / 内存 / 磁盘剩余 / 显卡与显存,推荐那一档在列表里带「推荐」气泡并默认选中。规则:质量优先;能整块放进显存就用 GPU;CPU 上重罚 4B/8B;中文环境优先中文 / 多语言;显存 < 4GB 的核显不算可用显卡(实测:共享显存的核显并不比多核 CPU 快)。
- **运行时风味** `cpu` / `vulkan` / `cuda` / `metal` / `auto`:Vulkan 自包含(驱动自带即可);**CUDA 会把 cudart 伴随包一起下**(llama.cpp 把 cuBLAS 拆在另一个资产里,不配对就起不来);所选风味找不到时退回 CPU 并在面板里说明。
- **自定义 GGUF**:填 URL + 维度即可装清单之外的模型(`pooling` 默认交给 GGUF 元数据决定);需要前缀的模型(Nomic 的 `search_query:` / `search_document:`)会自动带上。
- **一次只保留一份**:已经装了运行时与某个模型时**不能再装第二个** —— 按钮变成「需先卸载」并置灰,换模型要先去「维护」里卸载向量服务(否则 `<root>` 下会堆好几份模型,而配置只能指向一份,"现在跑的是哪个"就说不清了)。按钮四态:下载并安装 / 下载中… / 已安装 / 需先卸载。
- **选择会被记住**:写在 `<installRoot>/selected-model.json`,重启后仍生效;配置里写了 `preset` / `customModel` 时**配置优先**。

```yaml
    retrieval:
      vector:
        preset: 'qwen3-embedding-0.6b'   # 清单 id(配合 variant 选量化档)
        variant: 'q8_0'
        flavor: 'auto'                   # auto = 按探测到的硬件选;也可写死 cpu/vulkan/cuda/metal
        # customModel: { url: 'https://…/model.gguf', dims: 1024, pooling: 'auto' }
        # 覆盖项:dims / pooling / gpuLayers
```

## 安全 / Security

- `/memory/api` 的**每条**路由都先过 `refuseRequest`:宿主 `connection.requestRejection`(Host/Origin 围栏 + 浏览器登录)可用时以它为准,围栏自己抛错一律 403(失败关闭);旧宿主没有该服务时退化为「只认 loopback 权威 + 同源」。原因:注册在裸 `webServer` 上的路由**不在**宿主 `/api` 围栏与浏览器登录之后,而这里的接口能读、改、删、清空全部记忆。
- 记忆内容写入前过凭据扫描(`secrets.mode: refuse | redact`),默认拒绝。
- 清空记忆是两步确认 + 接口要求显式 `confirm: "delete"`。

## 卸载 / Uninstall

```bash
pnpm remove @restregular/dsh-memory   # 再从 profile 的 patch 里删掉那条 entry
```

**卸载插件不会移除已配置的向量服务与记忆文件** —— 它们不在 node_modules 里,而是在 `<storeDir>` 与 `<installRoot>`。要清掉,先打开面板「记忆 → 维护」:

- **卸载向量服务**:删掉运行时与模型(两步确认,显示将释放多少空间);记忆数据保留。
- **清空记忆数据**:删掉全部 JSONL 与向量边车(两步确认,不可恢复)。

插件被卸掉后面板就打不开了,所以这件事只能在卸载**之前**做。想手动清理,直接删上面那两个目录即可。

## 构建与测试 / Build & test

```bash
npm test        # node --experimental-strip-types --test source/*/test/*.test.ts
npm run build   # source/ → packages/dsh-memory(顺带跑产物契约检查)
npm run verify  # 构建到 .verify/,不落 packages/(CI 或改动后自检)
```

构建用 Node 内置的类型剥离(`stripTypeScriptTypes`,无额外工具链),相对 `.ts` 说明符改写为 `.js`,跨半边相对 import 重映射,每个产出文件 `node --check`。

产物契约检查(错了会**静默失败**的几处,所以做成会失败的检查):

1. patch **恰好一行** insert,且 `name` 就是包名;
2. `package.json` 同时声明 `dsh.bundle.patch` 与 `dsh.client.platform: web`,并导出 `./client`;
3. `lib/client.js` 的 `__ModuleLoader__.load({ id })` 等于包名;
4. 入口里四条半边的相对 import 都在(改写没生效时,只有装到用户机器上才会 `Cannot find module`)。

可选的真实加载验证(证明产物在没有 TS 支持的普通 node 里能跑):

```bash
node tools/build-single-package.mjs --scope @restregular --version 0.4.0 \
  --host-modules <一个 @deepseek-ai 目录>       # 或设 DSH_HOST_MODULES
```

## 仓库结构 / Layout

```
source/memory-plugin/     单入口:组合四个半边(唯一一条 entry 的实现)
source/memory-local/      provider:存储 / 检索 / 向量后端 / 一键安装 / 模型清单与硬件推荐
source/tool-memory/       四个模型工具
source/memory-inject/     召回注入
source/memory-panel/      面板:lib/index.js(服务端)+ lib/client.js(客户端 bundle)
packages/dsh-memory/      构建产物 → 发布为 @restregular/dsh-memory(与 npm 上的包逐字节一致)
tools/build-single-package.mjs   构建(产物契约检查 + 可选加载验证)
```

## 测试 / Tests

`npm test` 覆盖存储 / 检索打分 / 边车身份 / 回填重试 / 安装器(含真实发行包解压)/ 卸载边界 / 模型清单与推荐规则 / 硬件解析 / 面板渲染冒烟 / 围栏判定 / 产物契约。测试用宿主的 DSH 包作为解析依赖(`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`),它们不随本仓库分发。

## 常见问题

**向量服务起不来**
看 `<installRoot>/llamacpp/llama-server.log`。三个常见原因:端口被占(换 `spawn` 的端口或停掉占用者)、`cwd` 里缺 `llama-server-impl.dll`(llama.cpp 的 Windows 包需要同目录的依赖)、模型与运行时风味不匹配(比如 GPU 风味但没驱动)。

**检索结果很差 / 全是词法命中**
先看面板「当前模型」那行的**维度**是否与模型一致,再看 `.vec` 身份头。维度或 pooling 写错不会报错,只会让向量通道悄悄失效。另外 `minScore` 默认 0.5 是按 BGE 的 CLS 噪声底定的,**换模型后可能需要微调**(太少就调低,太杂就调高)。

**下载中断 / 装到一半**
安装器先写 `.part` 再 rename,所以磁盘上不会留半成品;面板会显示「重试下载」。

**想换模型**
0.4.0 起必须先「维护 → 卸载向量服务」再装(理由见「模型与硬件」)。换完现有记忆会重新嵌入。

**面板里看不到「记忆」**
包名与 Loader entry 必须一一对应(见「为什么是一个包」)。检查 profile 的 patch 里是否只有一条 `@restregular/dsh-memory`,以及 profile 是否真的装上了这个依赖(`ls node_modules/@restregular/dsh-memory`)。

## 版本

- **0.4.0** —— 单包合并里程碑:面板并入主包(一条 entry)、模型清单与硬件推荐、自定义 GGUF、运行时风味、"一次只保留一份"。
- **0.3.x 及更早** —— 拆分结构(provider / tools / inject / panel 各自独立 entry)。从 0.3.x 升级请按上面的单行 entry 重新挂载,并把旧的多条 entry 删掉。

## License

MIT
