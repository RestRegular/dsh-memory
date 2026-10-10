# dsh-memory

DeepSeek Harness 的本地长期记忆插件：**JSONL 存储 + 本地向量检索（BGE-M3）+ 四个模型工具 + 自动召回注入 + 可视化管理面板**。

Local, durable memory for DeepSeek Harness: a JSONL store, local vector recall through llama-server / BGE-M3, four model-facing tools, automatic recall injection into the conversation, and a management panel in the settings page.

## 安装 / Install

```bash
pnpm add @restregular/dsh-memory @restregular/dsh-memory-panel
```

装进任意 DSH profile（桌面端 `~/.dsh/profiles/desktop`，Web 端 `~/.dsh/profiles/web`）。两个包各自带 `cordis.patch.yml`，安装后自动注册 entry。

## 它做什么 / What it does

| 能力 | 说明 |
| --- | --- |
| 四个工具 | `memory_save` / `memory_search` / `memory_list` / `memory_forget`，让模型自己存取长期记忆 |
| 自动召回 | 每轮对话前按当前请求检索相关记忆，作为一条 recall 上下文消息注入（可配置 token 预算） |
| 两类作用域 | `global`（所有项目）与 `project:<cwd>`（当前工作区） |
| 混合检索 | 词法（IDF + CJK bigram）与向量（BGE-M3）并行召回，可选 LLM 精排 |
| 管理面板 | 设置页「记忆」区块：浏览 / 搜索 / 折叠查看 / 编辑 / 删除，一键启停本地向量服务 |
| 优雅降级 | 没有向量服务时自动退化为纯词法检索；任何异常都被吞掉并记日志，绝不让 DSH 启动失败 |

## 仓库结构 / Layout

```
packages/dsh-memory/        发布到 npm 的核心包（provider + tools + inject）
packages/dsh-memory-panel/  发布到 npm 的面板包（服务端路由 + 客户端 UI）
source/<pkg>/{src,test}/    TypeScript 源码与测试
tools/                      构建、发布、安装后验证脚本
```

`packages/*` 是构建产物，由 `npm run build` 从 `source/` 生成——它们与 npm 上的包逐字节一致。

## 构建与发布 / Build & publish

```bash
npm run build     # source/ → packages/（用 Node 内置的 TypeScript 剥离，无额外工具链）
npm run publish   # 需要 npm 凭据；先 whoami 预检，失败即中止
```

## 配置 / Configuration

给 `dsh-memory-local` 传配置即可（默认值通常够用）：

```yaml
- id: dsh-memory-local
  config:
    storeDir: '~/.dsh/memory-store'
    scopes: { global: true, project: true }
    retrieval:
      topK: 5
      vector:
        enabled: true
        endpoint: 'http://127.0.0.1:8078/v1/embeddings'
        model: bge-m3
        dims: 1024
        timeoutMs: 300            # 交互检索（短查询）预算，要紧
        writeTimeoutMs: 10000     # 保存时嵌整条记录
        backfillTimeoutMs: 30000  # 批量回填
        backfillMaxChars: 8000
        spawn:                    # 让插件托管 llama-server 进程（opt-in）
          enabled: true
          exe: '/path/to/llama-server.exe'
          model: '/path/to/bge-m3-Q4_K_M.gguf'
          cwd: '/path/to/llamacpp'   # 该目录须含 llama-server-impl.dll
          logFile: '/path/to/llama-server.log'
      llm: { enabled: false }     # LLM 重排（可选）
    limits: { maxRecordsPerScope: 2000, maxRecordChars: 4000 }
    secrets: { enabled: true, mode: refuse }
```

`spawn.enabled: true` 时：应用启动后台拉起向量服务、退出时自动关闭；带 PID 文件的遗留实例会被接管，没有 PID 文件的外部实例不接管。

## 测试 / Tests

```bash
npm test
```

测试需要 DSH 宿主包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`）在解析路径上——它们是宿主提供的 peer 依赖，不随本仓库分发。

## License

MIT
