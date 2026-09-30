# agentic-data-architect
使用AI Agent，完成Data Architect和Data Analyst的工作。尤其是在一个老项目进行modernize或者replatform的时候，对当前data model，data source，transformation等数据相关问题进行分析和设计

设计文档：`docs/architecture_0930.md`；实现路线：`docs/implementation.md`；评测：`docs/evaluation.md`。

## V1.1：Current-State Discovery 可靠闭环

```text
Source（本地 SQL / 只读 DB）
  → Discovery（run-001…，可对比）
  → Evidence（文件+行号+hash+run）
  → Estate Graph
  → Dataset / Column Lineage（SQLGlot AST）
  → Profiling
  → Findings（确定性规则 + 金融清单）
  → AI Analysis（结构化 JSON + 状态校正）
  → Current-State Report（8 节 + Coverage/Gaps）
```

原则：LLM 只负责理解事实，不负责发现事实。每个结论必须回指 evidence id；
状态只有 `verified / supported / inferred / unknown / contradicted`，
且 `verified` 永不由模型自封（系统按证据数量校正）。

```text
V1: Current-State only（本仓库现在在这里）
V2: Semantic + Source-to-Target + Target Architecture
V3: Migration Waves + Validation
V4: Controlled Write / PR / Deployment
```

## 快速开始

需要：Node ≥22，本机 `copilot` CLI 已登录（服务器环境才需要 `GITHUB_TOKEN`），
以及装了 sqlglot 的 Python（`pip install sqlglot`，多版本时用 `SQLGLOT_PYTHON` 指定）：

```bash
npm install
npm run init -- demo --goal "Modernize Portfolio Analytics" --scope Position,Price
npm run discover -- demo --path examples/investment/golden/legacy
npm run ask -- demo "Where does Position come from?"
npm run report -- demo
```

连只读数据库（PostgreSQL / Snowflake，默认只扫 metadata）：

```bash
npm run discover -- demo --database "postgres://user:pass@localhost:5432/db" --schema public --profile
```

质量门：`npm run typecheck`，`npm test`（24 测试，含 golden precision/recall）。

环境变量（都有默认值，可不配）：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `COPILOT_MODEL` | 问答用的模型 | `gpt-5-mini` |
| `DATA_DIR` | Investigation 存盘位置 | `.data` |
| `GITHUB_TOKEN` | 配了就走服务端模式，不配就用本机 `copilot` 登录 | 空 |
| `TURN_TIMEOUT_MS` | 单轮等待上限 | `300000` |
| `SQLGLOT_PYTHON` | 装了 sqlglot 的 Python 解释器 | `python3` |
| `PG_URL` | （预留）默认 PG 连接串 | 空 |

## 目录

```text
src/
  agent/copilot.ts        Copilot SDK 最小封装（本机 CLI 优先）
  agent/prompts.ts        Lead 提示词（严格 JSON + evidence id 目录）
  agent/result.ts         JSON 抽取 → 校验 → 状态校正
  evidence/types.ts       EvidenceRef / Claim / Finding / DiscoveryRun
  investigation/store.ts  Investigation 存盘（目录布局）
  discovery/scanner.ts    本地扫描 + 源指纹（sha256）
  discovery/database.ts   DB metadata 发现流程
  analysis/sql-parser.ts  SQLGlot 桥适配（语句切分 + 行号）
  analysis/lineage.ts     L1 dataset + L2 column（AST 驱动）
  analysis/profiling.ts   真实 profiling（证据发射）
  analysis/findings.ts    确定性 findings 引擎
  analysis/finance-rules.ts 投管审查清单
  analysis/context.ts     按问题检索证据
  analysis/query.ts       Targeted Query（plan → 校验 → 只读执行）
  analysis/report.ts      Current-State Report（8 节）
  model/estate.ts         Data Estate Graph（JSON）
  adapters/database.ts    只读 DatabaseAdapter 接口 + 守卫
  adapters/postgres.ts    PostgreSQL 实现
  adapters/snowflake.ts   Snowflake 实现
  workflow/               discover / ask / report（CLI 只剩参数解析）
  cli.ts                  init / discover / ask / report
scripts/sqlglot_parser.py SQLGlot 桥（stdin/stdout JSON）
tests/                    单测 + tests/evaluation/golden.test.ts
examples/investment/golden/ golden 数据集 + 期望结果
```


## Investigation Workspace

每个 Investigation 都有独立的工作目录：

~~~text
.data/investigations/<name>/
  investigation.json
  discovery/
  reports/
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

workspace/context.json 是整个研究过程的上下文入口，记录最初用户 prompt、每次 input、重要信息以及对应研究文档。外部研究不能只留在聊天记录里。

GitHub 代码研究支持两种方式，由用户在研究开始时选择：

1. 直接使用 GitHub Tool，通过 GitHub URL / repository API 读取和分析。
2. Clone 到 workspace/sources/github/，再使用本地 find / grep / rg / git 做深入分析。

LeanIX 架构事实使用 SAP LeanIX 官方 MCP；Confluence 内部文档使用 Atlassian 官方 Rovo MCP。研究记录和重要发现分别保存到 workspace/research/ 和 workspace/findings/。
