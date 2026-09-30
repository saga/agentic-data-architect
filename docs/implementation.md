# Implementation Roadmap

当前代码状态 → 下一步具体实现 → 为什么。不复述理论，理论在 `architecture_0930.md`。

## V1.1（已完成）：Current-State Discovery 可靠闭环

```
本地 SQL / DB metadata
  → Discovery（run-001, run-002…，可对比）
  → Evidence（文件+行号+hash+run，可过期判定）
  → Estate Graph（dataset/column/file 节点，JSON）
  → Dataset + Column Lineage（sqlglot AST）
  → Profiling（只读 adapter）
  → Findings（确定性规则先行）
  → AI Analysis（结构化 JSON + 状态校正）
  → Current-State Report（8 节 + Coverage/Gaps）
```

已落地：

- `src/evidence/types.ts` — EvidenceRef / Claim（只存 evidenceIds）/ Finding / DiscoveryRun / calibrateStatus
- `scripts/sqlglot_parser.py` + `src/analysis/sql-parser.ts` — SQLGlot 桥（stdin/stdout JSON，单条失败不污染整文件）
- `src/analysis/lineage.ts` — L1 dataset + L2 column，逐 statement / 边发射证据
- `src/model/estate.ts` — JSON graph，不上 Neo4j
- `src/adapters/database.ts` + `postgres.ts` + `snowflake.ts` — 只读接口（`assertReadOnly` 守卫），驱动懒加载
- `src/analysis/findings.ts` — 7 类确定性规则（无证据不建 finding）
- `src/analysis/finance-rules.ts` — 投管 checklist，证据不足时转 unknowns 提问
- `src/agent/prompts.ts` + `src/agent/result.ts` — 严格 JSON + evidenceId 存在性校验 + 状态校正（verified 永不采信）
- `src/analysis/context.ts` — 按问题检索证据（删除了 snapshot 截断）
- `src/analysis/query.ts` — Targeted Query（plan → 校验 → 只读执行 → 证据）
- `src/workflow/` — discover / ask / report，CLI 只剩参数解析
- `tests/` + `examples/investment/golden/` + CI — 24 测试，golden lineage precision/recall=1

刻意没做的（以及原因）：

- `src/adapters/filesystem.ts` — `discovery/scanner.ts` 已经是 filesystem adapter，单列文件只是多一层转发。
- 完整 ontology / FIBO runtime — 等 V2 semantic modeling。
- vector DB / RAG / Neo4j / multi-agent / UI / 写工具 — 全部 V4 以后。

## V2：Semantic + Source-to-Target + Target Architecture

1. `src/model/semantic.ts` — BusinessConcept + SemanticMapping（exact/derived/candidate/conflict）
2. `src/model/mapping.ts` — SourceTargetMapping + ValidationRule（核心产出物，不是 Markdown 表）
3. `src/model/architecture.ts` — ArchitectureProposal（domain/dataset/integration/decision/assumption）
4. `tests/semantic.test.ts` + `tests/mapping.test.ts` + `examples/investment/target/`

## V3：Migration Waves + Validation

1. `src/migration/waves.ts` — 7R + 依赖排序 + coexistence/cutover/rollback
2. `src/migration/validation.ts` — 对账规则（legacy aggregate ≈ target aggregate + 容差）
3. `tests/migration.test.ts` + `examples/investment/migration/`

## V4：Controlled Write

生成 SQL / dbt / Snowflake semantic view → PR → 人工批准 → 合并。写工具默认关闭，独立 Approval Gate。


## V1.1 补充：Investigation Workspace 与企业研究来源

当前 Investigation 的业务状态保存在 investigation.json；Agent 的长期工作目录单独放在 workspace/，避免把研究过程混进核心状态文件。

~~~text
workspace/
  context.json
  inputs/
  research/
    github/
    leanix/
    confluence/
    web/
  sources/
    github/
  findings/
  artifacts/
  notes/
~~~

### context.json

context.json 是每次 Investigation 的第一入口：

- userPrompt：用户最初要求
- inputs：每个问题、发现、外部研究 query、重要决策的追加记录
- importantInformation：已经确认、后续分析必须记住的重要事实
- artifactPath：较长研究结果所在文件

规则：不覆盖历史 input；长内容落盘，context.json 只保留索引和摘要；禁止写入密码、token、cookie 等凭据。

### GitHub

研究开始时让用户选择：

- 直接 GitHub Tool：适合公司 GitHub Organization、目标明确、文件范围较小的检查。
- Clone 到 workspace/sources/github/：适合大仓库、跨文件搜索、需要大量 rg/find/grep/git log 的分析。

两种模式都必须把 query、repo、branch/commit、关键文件和重要发现写到 workspace/research/github/，并在 context.json 登记。

### LeanIX

使用 SAP LeanIX 官方 MCP Server 查询 Fact Sheets 和关系；不要自己实现 LeanIX REST connector。运行时发现真实 MCP tool schema，不猜工具名。LeanIX 返回的是 architecture evidence，和代码、运行数据、业务访谈冲突时必须分别记录。

### Confluence

使用 Atlassian 官方 Rovo MCP Server 查询 Confluence；不要用普通 Web Search 代替私有 Confluence 内容。保存 page id、space、title、更新时间、关键事实和冲突到 workspace/research/confluence/。

### Copilot working directory

Lead Data Agent 的 workingDirectory 指向当前 Investigation 的 workspace，而不是项目根目录。这样 Agent 产生的研究记录、源码副本、临时分析和重要发现都留在 Investigation 内。


## 当前代码审查后的 V1.1 修正

已补齐几个会直接影响真实 Investigation 的问题：

- DB profiling 保留完整 DataProfile，不再只保存 row count；Agent 问答和 findings 都能读取列级 profile。
- Column lineage 带 evidenceId，列级结论可以回指对应 SQL statement。
- DB-only discovery 也会运行适用的 deterministic findings，而不是只有带 SQL 文件的 discovery 才有 findings。
- Data Estate 的 database / schema / dataset 层级现在会一起保存。
- DiscoveryRun 和 workspace context 中不再保存数据库连接密码、token 等凭据。
- 只读查询守卫禁止 CTE 中的 DML，并对实际数据库查询加结果上限，避免 Agent 一条查询拉回整个大表。
- Snowflake 的动态表名、schema、database 名都经过标识符校验和引用，避免把对象名直接拼进 SQL。
- Investigation 文件损坏时不再被错误地当作旧版文件自动迁移。
- Evidence context 会把 profile 和 column lineage 的 evidence id 一起交给 Agent。

这些修改仍然不增加 vector DB、Neo4j、multi-agent 或 workflow engine；目标只是让 V1.1 的 Evidence-first 闭环在真实项目里可用。