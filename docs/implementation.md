# Implementation Roadmap

## 当前交互层：Web Workbench

主入口已经从 readline session 改为 Web UI：

```text
Browser
  → Express 5
  → Investigation API
  → existing workflow / Evidence / Copilot SDK
  → SQLite conversation history + .workspace/<session>/context.json
                           ↘ Skills / Skill scripts
```

前端：Vite + React + Ant Design 6 + Ant Design X 2.9 + XMarkdown 2.9。XMarkdown 负责 Markdown / code / formula / Mermaid 展示，Conversations / Bubble / Sender 负责聊天工作台。

Express 只负责 Web/API 边界，不重新实现 Investigation、Evidence 或 Agent 逻辑。


当前代码状态、下一步实现和边界。不重复架构理论。

## 当前：V1.1

已经具备：

- 持续 Investigation session 和可恢复 Copilot session
- `.workspace/<session>/context.json` 持久化 goal、scope、evidence、claims、findings、unknowns 等调查状态
- `.workspace/conversations.db` 持久化 user / assistant / system 消息，并使用 SQLite FTS5 建立全文索引
- Copilot SDK 从 `skills/` 发现和加载 Skill；每个 Investigation 通过 `control.json` 选择启用哪些 Skill，未选择的 Skill 会显式禁用
- 金融领域检查放在 `skills/financial-data-review/`，其中 deterministic 检查放在 `scripts/review.mjs`
- `.workspace/shared/index.json` 和共享研究资料
- 本地 SQL / PostgreSQL / Snowflake discovery
- SQLGlot dataset / column lineage
- Evidence provenance
- read-only profiling / targeted query
- deterministic findings
- structured Agent result 和 evidence status 校正
- Current-State Report

运行入口现在是：

```bash
npm run start
```

## Workspace 边界

```text
.workspace/
  shared/
    index.json
    confluence/
    github/
    leanix/
    web/
    document/
  <session>/
    context.json
    transcript.md
    discovery/
    reports/
    artifacts/
```

`context.json` 是当前 Investigation 状态；多轮聊天不再写入这里。`.workspace/conversations.db` 保存所有 session 的消息历史，并通过 FTS5 为相关历史检索提供索引。shared 是可复用资料，不再为每个 session 建一套 research/source/findings/notes 目录。

## Agent / Skill / Script 原则

当前只有一个 Investigation 主 Agent，直接使用 Copilot SDK default agent。平台级 evidence / output / safety 约束放在 system prompt 和确定性代码中，不做成一个额外的 custom agent。

Skill 是平级、可复用、按 Investigation 配置的能力模块。Research workflow 由 SKILL 定义；确定性发现由现有 TypeScript / JavaScript / Python 脚本和工具执行。

不要把会变化的命令、tool schema 或研究流程再复制成大量 prompt 文本。

## V1.2

1. Canonical Estate 扩展到 application / data store / job / job run / API / dashboard 等资产类型
2. SQL parse failure / discovery coverage
3. provider-neutral Semantic Context
4. Snowflake Semantic View discovery，并把定义转换成通用 SemanticAsset
5. Source-of-Truth Candidates / Semantic Candidates
6. graph-aware + semantic-aware question retrieval

## V2

1. BusinessConcept / SemanticMapping
2. Source-to-Target Mapping
3. Target Architecture

## V3

1. Migration Waves
2. Reconciliation / Validation
3. Cutover / Rollback

## V4

Controlled Write / PR / Deployment。

暂时不增加 Neo4j、vector DB、multi-agent swarm、完整 ontology runtime、Temporal/BPMN、生产写工具或大量数据库 adapter。
## Skill 边界

核心代码负责安全和一致性：Evidence 校验、Claim 状态校正、SQL read-only、workspace/state persistence、lineage/profile 等确定性基础能力不交给模型。

Skill 负责容易变化的领域知识、调查方法、问题清单和专业解释。需要精确计算或扫描时，Skill 自带 scripts，由 Agent 调用并读取生成 artifact。Skill 内容不是 Evidence，脚本结果仍必须回指原始 Evidence。

当前金融 Skill 示例：

~~~text
skills/financial-data-review/
  SKILL.md
  scripts/review.mjs
~~~


### Schema 验证

项目使用 Zod 4 作为运行时 Schema 层。持久化 JSON、HTTP 请求体、环境变量和 Agent 结构化输出都在进入业务逻辑前经过 Schema 校验；TypeScript 类型由 Zod Schema 推导，避免手写 interface 与验证逻辑长期漂移。
