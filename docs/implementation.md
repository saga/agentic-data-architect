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
