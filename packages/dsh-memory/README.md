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

### 本地向量服务（可选）

不配向量服务时，检索自动降级为纯词法（IDF + CJK bigram），功能不受影响。要启用语义检索，指向任意 OpenAI 兼容的 `/v1/embeddings` 服务（推荐 `llama-server` + BGE-M3）：

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

`spawn.enabled: true` 时：应用启动后台拉起、应用退出自动关闭；已在跑的实例（有 PID 文件）会被接管，没有 PID 文件的外部实例不接管。也可在面板里手动开关。

## 说明

- 存储为每作用域一个 JSONL + `.vec` 向量边车（含模型/维度身份头，不匹配自动重建）。
- 记忆分 `global` 与 `project:<cwd>` 两类作用域。
- 只在插件自己的生命周期内工作：任何异常都被吞掉并记日志，绝不让 DSH 启动失败。
- License: MIT
