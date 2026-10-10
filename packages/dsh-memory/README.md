# @restregular/dsh-memory

DeepSeek Harness 的本地长期记忆插件（核心包）：JSONL 存储 + 本地向量检索 + 四个模型工具 + 自动召回注入。

## 安装

装进任意 DSH profile（例如桌面端 `~/.dsh/profiles/desktop`，Web 端 `~/.dsh/profiles/web`）：

```bash
pnpm add @restregular/dsh-memory
```

本包同时提供三个 loader entry，装好后自动生效（bundle patch 已随包分发）：

| entry id | 作用 |
| --- | --- |
| `dsh-memory-local` | 提供 `memory` 服务：存储、检索、向量回填 |
| `dsh-tool-memory` | 注册 `memory_save` / `memory_search` / `memory_list` / `memory_forget` 四个工具 |
| `dsh-memory-inject` | 在 `agent/pre-step` 注入召回块（可选，可关） |

> 管理面板是独立包：**@restregular/dsh-memory-panel**（设置页里查看/编辑/删除记忆，并手动启停向量服务）。

## 配置

patch 里给 `dsh-memory-local` 传配置即可（默认值通常够用）：

```yaml
- id: dsh-memory-local
  config:
    storeDir: '~/.dsh/memory-store'      # 默认 <home>/.dsh/memory-store
    scopes: { global: true, project: true }
    retrieval:
      topK: 5
      vector:
        enabled: true
        endpoint: 'http://127.0.0.1:8078/v1/embeddings'
        model: bge-m3
        dims: 1024
        timeoutMs: 300            # 交互检索预算（要紧）
        writeTimeoutMs: 10000     # 保存时嵌整条记录
        backfillTimeoutMs: 30000  # 批量回填
        backfillMaxChars: 8000
      llm: { enabled: false }     # LLM 重排（可选）
    limits: { maxRecordsPerScope: 2000, maxRecordChars: 4000 }
    secrets: { enabled: true, mode: refuse }   # 拒绝写入疑似凭据
```

### 向量检索（可选，默认不启用）

**不配任何东西也能用**：检索自动降级为纯词法匹配（IDF + CJK bigram），保存/搜索/注入全部正常。向量检索是**按配置启用**的——写了 `endpoint`、配了 `spawn`、或面板里装了本地后端，才会去碰网络；否则一个请求都不发（不会白试、不会刷错误日志）。

三条启用路径，任选一条：

**① 面板一键装（推荐给不想折腾的人）**：设置页「记忆」→「向量服务」卡片 → 点 **下载并配置**。插件会下载 llama.cpp CPU 版运行时 + bge-m3 量化模型（约 440MB）到 `retrieval.vector.autoInstall.dir`（默认：显式配了 `storeDir` 时用它上一级目录，否则 `~/.dsh/memory-vector`），解压后就地托管启动，下次开机自动拉起、退出自动关闭。

**② 云端 / 自建 OpenAI 兼容服务**（不用下模型）：

```yaml
        vector:
          enabled: true
          endpoint: 'https://api.example.com/v1/embeddings'
          model: 'bge-m3'        # 服务端要求的模型名
          dims: 1024             # 必须与服务端输出维度一致
```

**③ 自己管进程（手填路径）**：

```yaml
        vector:
          spawn:                    # 让插件托管 llama-server 进程（opt-in）
            enabled: true
            exe: '/path/to/llama-server.exe'
            model: '/path/to/bge-m3-Q4_K_M.gguf'
            cwd: '/path/to/llamacpp'   # 该目录须含 llama-server-impl.dll
            logFile: '/path/to/llama-server.log'
            threads: 6
```

- 路径 ①③ 都由插件托管进程：应用启动后台拉起、应用退出自动关闭；已在跑的实例（有 PID 文件）会被接管，没有 PID 文件的外部实例不接管。路径 ② 只调用、不启停（面板会标成「外部服务」）。
- 若 `autoInstall.dir`（或 `storeDir` 上一级）里已经存在 `llamacpp/` + `models/`，插件会**直接采用**，面板只显示状态，不需要重新下载。
- 面板的开关只在"进程确实由本应用托管"时出现；未配置给下载按钮，外部服务只显示连通性，配置里关掉了就只解释原因——不会出现一个永远灰着的开关。

### 维护与卸载

面板底部有一个「维护」区，不可撤销的操作都走**两步确认**（第一次点击只是把按钮换成"确认…"）：

| 动作 | 做什么 | 安全边界 |
| --- | --- | --- |
| **卸载向量服务** | 删掉插件下载的 llama.cpp 运行时 + 模型 + 日志（约 480 MB） | 只删 `retrieval.vector.autoInstall.dir`（默认 storeDir 上一级）里的东西；**绝不碰记忆数据目录**；若 `spawn.exe` 指向该根目录之外（也就是你自己装的 llama.cpp），直接拒绝并说明原因 |
| **清空记忆数据** | 删除所有作用域的全部记录（走 store，JSONL 与 `.vec` 边车保持一致，不会删出半个库） | 两步确认，且接口要求显式 `confirm: "delete"`，缺了不执行 |

**卸载插件本身**：在 DSH 的「插件 / 插件市场」里移除本包和 `@restregular/dsh-memory-panel`。

> ⚠️ DSH 卸载插件只是在 profile 里 `pnpm remove` 并去掉 bundles 条目：它**不会**给插件任何提问机会，也**不会**自动删除向量服务文件或记忆数据。所以"要不要留向量服务""要不要留记忆数据"这两件事要在卸载**之前**到面板「维护」区处理——插件卸载后那个面板也就没了。
>
> 手动清理路径：向量服务在 `retrieval.vector.autoInstall.dir`（默认 `~/.dsh/memory-vector`；显式配了 `storeDir` 时是它的上一级目录），记忆数据在 `storeDir`。

## 说明

- 存储为每作用域一个 JSONL + `.vec` 向量边车（含模型/维度身份头，不匹配自动重建）。
- 记忆分 `global` 与 `project:<cwd>` 两类作用域。
- 只在插件自己的生命周期内工作：任何异常都被吞掉并记日志，绝不让 DSH 启动失败。
- License: MIT
