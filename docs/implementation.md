# Implementation Roadmap

## 当前交互层：Web Workbench

主入口已经从 readline session 改为 Web UI：

```text
Browser
  → Express 5
  → Investigation API
  → existing workflow / Evidence / Copilot
  → .workspace/<session>/context.json
```

前端：Vite + React + Ant Design 6 + Ant Design X 2.9 + XMarkdown 2.9。XMarkdown 负责 Markdown / code / formula / Mermaid 展示，Conversations / Bubble / Sender 负责聊天工作台。 citeturn702320search0turn702320search1

Express 只负责 Web/API 边界，不重新实现 Investigation、Evidence 或 Agent 逻辑。


当前代码状态、下一步实现和边界。不重复架构理论。

## 当前：V1.1

已经具备：

- 持续 Investigation session 和可恢复 Copilot session
- `.workspace/<session>/context.json` 持久化上下文、evidence、claims、findings
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

`context.json` 是主要持久化状态；shared 是可复用资料，不再为每个 session 建一套 research/source/findings/notes 目录。

## Skill / Script 原则

Research workflow 由 SKILL 定义；确定性发现由现有 TypeScript / JavaScript / Python 脚本和工具执行。

不要把会变化的命令、tool schema 或研究流程再复制成大量 prompt 文本。

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