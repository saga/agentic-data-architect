我检查了 `saga/agentic-data-architect` 当前 `main`，再结合 2025–2026 的 Data Agent、Data Analyst Agent、legacy modernization、lineage、semantic layer 实践后，结论比较明确：

> **现在的代码已经把“Current-State Discovery”这半边打得不错，但还没有真正跨到“Data Architect / Data Analyst Modernization Workbench”。**
>
> 下一步最重要的不是增加更多 Agent，而是把核心数据模型从 **Discovery Snapshot** 升级成一个能够同时承载 **Current State → Business Semantics → Target State → Source-to-Target Mapping → Validation** 的长期模型。

业界最近的方向也在往这里收敛：Databricks 已经把 table、column、job、dashboard、external system、model API 放进统一 lineage/context；Snowflake 的 Semantic View Autopilot 从历史 SQL、BI、表元数据自动抽取 semantic model，并强调人工 review + verified queries；EY 的 2026 legacy ETL 方案也是“重建 data flow → 解析代码 → 理解业务逻辑 → validation”。([Databricks Documentation][1])

---

# 1. 现在代码最大的定位问题

目前实际是：

```text
Legacy files / DB
      ↓
Discovery
      ↓
SQL lineage
      ↓
Profiling
      ↓
Findings
      ↓
Chat with Agent
      ↓
Current-State Report
```

而你真正要做的是：

```text
Legacy Project
      ↓
Discovery
      ↓
Current-State Reconstruction
      ↓
Business / Semantic Reconstruction
      ↓
Analyst Reconciliation
      ↓
Current-State Data Architecture
      ↓
Target Architecture
      ↓
Source-to-Target Mapping
      ↓
Validation Design
      ↓
Migration Plan
```

也就是说，**Chat 不是主产品，Investigation 也不是最终核心对象。**

真正核心应该是：

```text
Modernization Workspace
        │
        ├── Current Estate
        ├── Data Flow
        ├── Data Model
        ├── Business Semantics
        ├── Source of Truth
        ├── Business Rules
        ├── Target Architecture
        ├── Source-to-Target Mapping
        ├── Validation
        └── Decisions
```

这一点和 2026 年 Data Agent 研究的方向一致：真正的 Data Agent 正从简单问答/工具调用向端到端、工具增强、语义感知、开放世界任务发展，但企业场景目前更现实的是 supervised / Proto-L3，而不是完全自治。([arXiv][2])

---

# 2. 最大的新架构：Canonical Data/Architecture Model

你现在：

```ts
DataEstate {
  nodes[]
  edges[]
}
```

这个方向对，但粒度还不够。

不要马上上 Neo4j。**继续 SQLite + JSON snapshot 完全可以。**

但是需要把 `Estate` 从一个简单图升级为：

```text
Canonical Enterprise Metadata Model
```

建议核心对象：

```text
Asset
├── System
├── Application
├── Interface
├── DataStore
├── Dataset
├── Column
├── File
├── API
├── MessageTopic
├── Job
├── JobRun
├── Report
├── Dashboard
└── DataProduct

Semantic
├── BusinessConcept
├── Entity
├── Metric
├── Dimension
├── BusinessRule
├── Identifier
├── Grain
├── TemporalDefinition
└── SourceOfTruthCandidate

Architecture
├── TargetModel
├── TargetDataset
├── TargetColumn
├── Mapping
├── ArchitectureOption
├── ArchitectureDecision
├── Constraint
└── Assumption

Validation
├── ValidationRule
├── Reconciliation
├── TestCase
├── ValidationResult
└── Approval
```

这个变化非常重要。

---

# 3. Data Estate 现在缺的不是“更多 node type”，而是 Job / Run / Process

现在 lineage：

```text
A → B → C
```

实际上不够。

应该变成：

```text
Dataset A
    │
    │ reads
    ▼
Job J1
    │
    │ writes
    ▼
Dataset B
    │
    │ reads
    ▼
Job J2
    │
    │ writes
    ▼
Dataset C
```

进一步：

```text
Job
  ├── sourceCode
  ├── scheduler
  ├── owner
  ├── inputs
  ├── outputs
  ├── transformation
  └── runs[]

Run
  ├── startedAt
  ├── completedAt
  ├── status
  ├── input versions
  └── output versions
```

这正好和 OpenLineage 的 `Job / Run / Dataset` 模型对齐，同时兼容 design-time static lineage 和 runtime lineage。([GitHub][3])

所以建议：

### `src/model/estate.ts`

不要继续只靠：

```ts
dataset → dataset
```

而改成支持：

```text
Asset
  ↓
Process/Job
  ↓
Asset
```

并让 lineage edge 增加：

```ts
{
  from,
  to,
  type,
  evidenceIds,

  relationKind: "static" | "runtime",
  jobId?,
  runId?,
  expression?,
  confidence?,
  observedAt?,
}
```

---

# 4. 现在 `nodeId(type, name)` 必须改

当前：

```ts
nodeId(type, name)
```

只根据名字：

```text
dataset:position
```

这在真正 enterprise estate 里会撞。

例如：

```text
Oracle.PROD.POSITION
Snowflake.RAW.POSITION
Snowflake.CURATED.POSITION
Postgres.APP.POSITION
```

必须有 namespace。

建议：

```text
<platform>:<environment>:<database>:<schema>:<object>
```

例如：

```text
snowflake:prod:INVESTMENT:CURATED:POSITION
oracle:prod:IBOR:POSITION
```

再给每个 source connector 一个 canonical namespace。

这是后面做跨系统 mapping 的基础。

---

# 5. Scanner 要扩大，但不要“一次支持所有东西”

现在 `scanner.ts`：

```text
SQL
Python
Markdown
YAML
JSON
```

对于 legacy modernization 不够。

至少增加：

```text
SQL
Python
Java
JavaScript / TypeScript
Shell
XML
CSV
Excel
Properties / INI
JSON / YAML
```

然后建立：

```text
Discovery Adapter
```

而不是在 `scanner.ts` 里无限增加 if/else。

例如：

```text
Source
  ↓
Adapter
  ├── SQL Adapter
  ├── Source Code Adapter
  ├── Informatica Adapter
  ├── SSIS Adapter
  ├── dbt Adapter
  ├── Spark Adapter
  ├── Scheduler Adapter
  ├── BI Adapter
  └── Document Adapter
```

商业 modernization 工具现在已经把 scheduler、ETL、SQL object、BI report、dependency、orphan code 一起发现，而不是只扫描 SQL。([NextPathway][4])

---

# 6. 下一阶段最值得增加的 Discovery，不是更多数据库，而是这些

优先级我建议：

| 优先级 | Discovery                       |
| --- | ------------------------------- |
| P0  | SQL / DB metadata               |
| P0  | ETL metadata                    |
| P0  | BI / Dashboard                  |
| P0  | Scheduler / Job                 |
| P0  | Documents / business rules      |
| P1  | Query history / runtime lineage |
| P1  | Stored procedures               |
| P1  | APIs / files / messaging        |
| P2  | 更多数据库                           |

尤其：

```text
BI
SQL history
ETL
Scheduler
Documentation
```

这些东西其实是 **Business Semantics 的金矿**。

Snowflake 当前的 Semantic View Autopilot 已经直接利用 table metadata、历史 SQL、Power BI 等输入生成 semantic model；Snowflake 自己的工程文章也明确强调，业务定义应该来自组织真实使用方式，而不是某个人凭经验手工填写。([Snowflake Documentation][5])

---

# 7. `BusinessConcept` 现在只是一个 node，应该升级成一等对象

这是我认为当前 V2 最大缺口。

现在：

```ts
business_concept
```

只是 `EstateNodeType` 里的一个类型。

不够。

应该让 Agent 最终得到：

```json
{
  "name": "Position",
  "description": "...",
  "grain": "security x portfolio x as_of_date",
  "identifiers": ["security_id", "portfolio_id"],
  "temporalSemantics": "as_of",
  "candidateSources": [
    "IBOR_POSITION",
    "PORTFOLIO_POSITION"
  ],
  "evidenceIds": [],
  "status": "proposed"
}
```

也就是说：

```text
Physical Schema
        ↓
Business Concept
        ↓
Business Rule
        ↓
Metric
        ↓
Target Model
```

这是 Data Analyst 和 Data Architect 真正交接的地方。

---

# 8. 一定要增加 Source-of-Truth Analysis

你现在的：

```text
multiple_sources_of_truth
```

只是 finding。

但对于 legacy modernization，它其实是一个核心工作产物。

例如：

| Business Concept | Candidate Source   | Evidence           | Analyst Decision |
| ---------------- | ------------------ | ------------------ | ---------------- |
| Position         | IBOR_POSITION      | lineage + metadata | Pending          |
| Position         | PORTFOLIO_POSITION | lineage + report   | Pending          |
| Price            | MARKET_PRICE       | runtime + docs     | Accepted         |
| Security         | SECURITY_MASTER    | FK + docs          | Accepted         |

状态：

```text
candidate
→ evidence-supported
→ analyst-confirmed
→ architect-approved
```

不要让 Agent 自己选择：

> “IBOR_POSITION 一定是 source of truth。”

而应该：

```text
Agent:
  找到三个候选
  ↓
  给出证据
  ↓
  找出冲突
  ↓
Human:
  确认 / 修正
```

这会比单纯提高 LLM accuracy 有价值。

---

# 9. Evidence 模型也应该升级

现在：

```text
Evidence
Claim
Finding
```

再加一个非常重要的概念：

```text
Proposal
```

最终形成：

```text
Observation
   ↓
Claim
   ↓
Finding
   ↓
Proposal
   ↓
Verification
   ↓
Decision
```

例如：

```text
Observation:
IBOR_POSITION is read by 17 downstream jobs.

Claim:
IBOR_POSITION is a major upstream source.

Finding:
There are two competing position sources.

Proposal:
Use IBOR_POSITION as canonical source.

Verification:
Position values reconcile with downstream report for 99.98%.

Decision:
Approved by Data Architect.
```

这样才能处理：

> **Agent 可以提出设计，但不能把“建议”冒充成“事实”。**

你现在 `verified` 状态实际上没有真正的 upgrade path。`calibrateStatus()` 主要是在降级 Agent 声称的可信度。

建议把：

```text
ClaimStatus
```

和：

```text
ProposalStatus
DecisionStatus
VerificationStatus
```

分开。

不要继续把所有事情塞进 `ClaimStatus`。

---

# 10. 当前 Evidence 的“2 个 Evidence = supported”也应该改

现在：

```ts
supported + evidenceCount >= 2
```

这是一个简单但不够可靠的规则。

因为：

```text
Evidence A = SQL file
Evidence B = 同一个 SQL file 的另一行
```

不能算两个独立证据。

应该有：

```text
sourceId
sourceType
authority
independenceGroup
```

例如：

```text
DB metadata
SQL lineage
runtime log
business document
user confirmation
```

然后：

```text
supported
```

应该考虑：

```text
多个独立来源
+
没有冲突
+
来源可信度
```

而不是单纯数量。

---

# 11. `context.ts` 是下一阶段非常关键的改造点

当前 retrieval 更像：

```text
question token
      ↓
dataset name matching
      ↓
top 6 datasets
```

这个方式 V1 可以。

V2 不够。

应该变成：

```text
Question
   │
   ├── lexical search
   ├── business concept aliases
   ├── dataset / column names
   ├── graph traversal
   ├── lineage neighbors
   ├── relevant jobs
   ├── relevant documents
   ├── findings
   ├── decisions
   └── unknowns
```

例如用户问：

> Position 到底从哪里来？

应该自动扩展：

```text
Position
 ↓
business concepts
 ↓
position-like columns
 ↓
candidate datasets
 ↓
upstream lineage
 ↓
jobs
 ↓
documents
 ↓
reports
 ↓
runtime usage
```

**现在不用上 vector DB。**

先：

```text
SQLite FTS5
+
canonical aliases
+
graph traversal
+
metadata indexes
```

已经足够做第一版。

---

# 12. Target Architecture 不应该只是一个 Markdown Report

这是目前 V2 最大的产品层缺口。

现在：

```text
Current-State Report
```

将来应该变成几个真正的 **Work Product**：

```text
1. Estate Inventory
2. Current Data Flow
3. Current Data Model
4. Business Semantic Model
5. Source-of-Truth Matrix
6. Business Rule Inventory
7. Issue / Risk Register
8. Target Architecture
9. Target Data Model
10. Source-to-Target Mapping
11. Validation Plan
12. Migration Waves
13. Architecture Decisions
```

而且这些不只是 Markdown。

应该：

```text
structured object
      +
generated Markdown
      +
Mermaid
      +
CSV / Excel
      +
future target-specific artifacts
```

---

# 13. Source-to-Target Mapping 必须成为核心对象

不要等 V3。

它实际上是 Data Architect 工作的核心产物。

建议：

```ts
Mapping {
  sourceAssets[]
  targetAsset
  sourceExpression?
  transformation?
  businessRuleIds[]
  keyMapping[]
  grainMapping?
  temporalMapping?
  dataTypeMapping?
  evidenceIds[]
  confidence
  status
  validationRuleIds[]
}
```

必须支持：

```text
1 → 1
1 → N
N → 1
derived
lookup
fallback
filter
aggregation
split
merge
```

例如：

```text
legacy.position.qty
        ↓
CASE
  WHEN status = 'OPEN'
  THEN quantity
END
        ↓
target.position.quantity
```

不能只保存：

```text
position.qty → position.quantity
```

否则真正的 migration value 不够。

---

# 14. Target Architecture 应该先做“方案”，再做“选择”

不要：

```text
Agent → 自动生成一个 target architecture
```

应该：

```text
Requirements
     ↓
Constraints
     ↓
Option A
Option B
Option C
     ↓
Impact / Tradeoff / Risk
     ↓
Human Decision
     ↓
Architecture Decision
```

例如：

```text
Option A
Legacy → Snowflake directly

Option B
Legacy → Raw → Canonical → Semantic

Option C
Legacy → Domain data products → Semantic layer
```

然后记录：

```text
Decision
Why
Evidence
Constraints
Rejected alternatives
Consequences
```

这就是一个真正的数据架构 ADR。

---

# 15. Semantic Layer 应该成为 Target Architecture 的一部分

这一点现在已经有很强的产业验证。

Snowflake Semantic Views 定义 logical tables、dimensions、facts、metrics、relationships；dbt Semantic Layer 也把 metrics 和允许的关系从 raw schema 中独立出来。dbt 2026 年的公开 benchmark 中，Semantic Layer 在其 15-table 测试上达到 98.2% / 100%，而直接 Text-to-SQL 是 90.0% / 84.1%；这是 dbt Labs 自己的 benchmark，不应视作独立验证，但它很好地说明了为什么企业数据架构不能停在 physical schema。([Snowflake Documentation][6])

所以你的 Target Architecture 应该是：

```text
Physical Data
      ↓
Canonical / Curated Model
      ↓
Business Semantic Model
      ↓
Metrics / Dimensions / Relationships
      ↓
Analytics / AI Agent
```

而且 semantic model 应该从：

```text
legacy SQL
+
BI
+
documents
+
query history
+
analyst confirmation
```

**自动发掘 + 人工确认**。

---

# 16. Data Analyst / Data Architect 不需要两个 Agent

我不建议现在做：

```text
Data Analyst Agent
Data Architect Agent
Data Engineer Agent
Validation Agent
```

再搞一个 swarm。

DeepAnalyze 等研究说明 agentic data analysis 确实能够把复杂分析做成端到端流程，但企业 modernization 最需要的是稳定的工具、上下文和验证边界。([arXiv][7])

你的项目更适合：

```text
One main Agent
       │
       ├── Discovery Skill
       ├── Data Analyst Skill
       ├── Semantic Analysis Skill
       ├── Data Architecture Skill
       ├── Mapping Skill
       └── Validation Skill
```

Skill 都统一用 SKILL.md 打包；frontmatter 用 metadata.kind 区分执行语义。
capability 由 Agent 自由组合，workflow 才由 Journey 约束大阶段、顺序和完成条件。

当前实现对应：

```text
capability
  search-confluence
  search-github
  search-leanix
  financial-data-review
  investigation-session
  working-directory

workflow
  legacy-modernization
  financial-ai-native-architecture
  data-architecture-assessment
```

这样比 swarm 简单，而且和你现在 Copilot SDK + Skill 的实现天然兼容。

---

# 17. Workflow 应该正式升级

当前基本是：

```text
ask
discover
report
```

应该升级成：

```text
INTAKE
  ↓
DISCOVER
  ↓
RECONSTRUCT
  ↓
UNDERSTAND
  ↓
RECONCILE
  ↓
CURRENT_STATE
  ↓
TARGET_DESIGN
  ↓
MAPPING
  ↓
VALIDATE
  ↓
DECIDE
  ↓
MIGRATION_PLAN
```

其中：

```text
Agent 可以在一个 phase 内自主行动
```

但：

```text
CURRENT_STATE
TARGET_DESIGN
DECIDE
```

这些是人工 review gate。

这比把 workflow 做成复杂 BPMN/Temporal 更合适。

---

# 18. UI 也要从“Chat UI”转成“Architecture Workbench”

现在 UI 的中心还是：

```text
Conversation
```

对于真正的 Data Architect 工作，应该变成：

```text
┌──────────────┬──────────────────────────┬────────────────┐
│ Workflow     │ Work Product             │ Evidence       │
│              │                          │                │
│ ✓ Scope      │ Current Data Flow        │ Evidence #123  │
│ ✓ Discovery  │                          │ SQL             │
│ ✓ Data Model │ [interactive graph]      │ Metadata       │
│ → Semantics  │                          │ Runtime         │
│   Target     │                          │ Document        │
│   Mapping    │                          │                │
│   Validation │                          │ Agent proposal │
│              │                          │                │
│              │                          │ Accept / Edit  │
└──────────────┴──────────────────────────┴────────────────┘
```

Chat 变成：

```text
“为什么 Position 有两个 source？”

“把这三个业务概念画出来。”

“这个 mapping 有什么证据？”

“给我两个 target architecture options。”
```

而不是整个产品都围绕 chat。

这也符合 Snowflake Semantic View Autopilot 的一个很有价值的产品经验：他们发现把几十个细粒度 AI suggestion 都丢给用户逐条 review 会造成很大 friction，所以需要把**调查、验证、上下文和接受建议**放在一个工作流里。([Snowflake][8])

---

# 19. `report.ts` 应该重新定位

现在：

```text
buildReport()
```

生成一个 Current-State Report。

以后应该变成：

```text
buildWorkProduct()
```

例如：

```text
buildEstateInventory()
buildCurrentDataFlow()
buildCurrentDataModel()
buildSemanticModel()
buildSourceOfTruthMatrix()
buildArchitectureOptions()
buildTargetArchitecture()
buildSourceToTargetMapping()
buildValidationPlan()
buildMigrationPlan()
```

然后再统一：

```text
exportMarkdown()
exportMermaid()
exportCsv()
exportJson()
```

这样未来才容易接：

```text
Snowflake Semantic View
dbt Semantic Model
Architecture ADR
Jira backlog
Migration specification
```

---

# 20. Profiling 这里有一个实际的大问题：不要把 sampleValues 默认交给 Agent

现在：

```ts
sampleValues
```

会进入 profiling。

对于金融企业，这个风险很明显：

```text
account number
security identifier
client data
transaction data
PII
```

都可能进入模型上下文。

应该默认改成：

```text
pattern
null rate
distinct rate
length distribution
min/max
data type
format detection
sensitive classification
```

而不是原始样本。

需要 sample 时：

```text
explicit user action
+
masked
+
limited
+
audit
```

---

# 21. Database Adapter 也需要从“数据库表扫描器”升级

当前只发现：

```text
database
schema
table
column
```

建议增加：

```text
views
materialized views
PK
FK
unique keys
indexes
comments
tags
stored procedures
functions
streams
tasks
external tables
stages
query history
usage
```

特别是：

```text
PK / FK
query history
comments
```

对 Semantic Model 非常重要。

Snowflake 的 Semantic View Autopilot 本身就会利用 metadata、unique/primary key 和 historical query 来帮助识别 relationship 和 verified queries。([Snowflake Documentation][5])

---

# 22. SQL parser 现在最大的缺陷：失败被静默吃掉

这里：

```ts
if (r.error || !r.statements) return;
```

这是 modernization 场景比较危险的。

因为：

```text
SQL parse failure
```

本身就是非常重要的信息。

应该生成：

```text
ParseFailure
```

例如：

```json
{
  "file": "etl/foo.sql",
  "lineStart": 182,
  "dialect": "oracle",
  "reason": "...",
  "severity": "high",
  "status": "unresolved"
}
```

最终：

```text
Lineage Coverage = 82%
```

应该比：

```text
Lineage Coverage = 100%
```

但实际上 18% SQL 被 parser silently skip 更可信。

另外一定要把：

```text
dialect
```

作为 source metadata，而不是现在默认不传。

---

# 23. 当前 lineage 还应该加入“Coverage”

现在报告有：

```text
8 / 10 datasets connected
```

这个方向正确。

但应该进一步：

```text
SQL parsing coverage
ETL parsing coverage
dataset lineage coverage
column lineage coverage
job lineage coverage
runtime lineage coverage
BI lineage coverage
semantic coverage
```

例如：

```text
Current-state confidence

SQL parsing          96%
Dataset lineage      91%
Column lineage       83%
Runtime lineage      61%
Business semantics   54%
Source-of-truth      42%
```

这会比一个“AI confidence = 0.87”有意义得多。

---

# 24. Architecture Assessment 已经落地

当前代码已经增加了独立的 `data-architecture-assessment` 工作路线：

```text
明确评估目标
  → 查清当前架构
  → 找出主要问题
  → 给出改进建议
  → 排出实施顺序
```

实现位于：

- `skills/data-architecture-assessment/SKILL.md`
- `src/workflow/assessment.ts`
- `GET /api/sessions/:name/assessment`

当前实现复用已有 Current-State、Findings、Gap Analysis 和 Evidence，不再需要另起一套大型 Assessment Engine。

下面原来的 “以后至少增加” 列表，现在应理解为 **Findings 能力的后续扩展**，而不是 Architecture Assessment Workflow 尚未实现。

## Findings Engine 后续仍需要扩展

目前主要：

```text
duplicate transformation
missing lineage
semantic conflict
data quality
```

以后至少增加：

```text
duplicate source
multiple source of truth
identifier fragmentation
grain mismatch
temporal inconsistency
hidden business rule
embedded business logic
orphan dataset
orphan job
dormant asset
missing owner
missing SLA
missing lineage
unverified transformation
manual process dependency
BI hard-coded logic
high downstream blast radius
PII propagation
migration blocker
target incompatibility
```

商业 modernization 产品目前已经把 orphan/dormant assets、job dependencies、complexity、migration waves、test planning 都作为 discovery 后的重要产物，而不只是 lineage 图。([NextPathway][4])

---

# 25. Evaluation 必须完全换一档

现在 golden：

```text
4 SQL files
```

对于 V1 很好，但无法验证你真正要做的产品。

新的 benchmark 应该是一个完整 legacy project：

```text
DB
├── tables
├── views
├── procedures

ETL
├── SQL
├── Python
├── XML
└── scheduler

BI
├── dashboard
└── measures

Documents
├── architecture doc
├── business rules
└── user procedure

Runtime
└── query logs
```

然后定义：

| 指标                                 | 测什么                |
| ---------------------------------- | ------------------ |
| Asset discovery recall             | 有没有发现真正的资产         |
| Parse coverage                     | 有多少代码成功解析          |
| Dataset lineage precision/recall   | lineage 对不对        |
| Column lineage precision/recall    | column mapping 对不对 |
| Business concept accuracy          | 概念是否正确             |
| Source-of-truth accuracy           | source 判断是否有依据     |
| STTM coverage                      | mapping 是否完整       |
| STTM correctness                   | mapping 是否正确       |
| Architecture constraint compliance | target 是否违反约束      |
| Unsupported proposal rate          | Agent 是否胡乱设计       |
| Validation effectiveness           | 是否发现真实问题           |
| Human correction rate              | 人需要改多少             |
| Evidence traceability              | 能否一路追到原始证据         |

现在的 evaluation 最应该增加的不是“回答质量”，而是：

> **整个 modernization work product 是否正确。**

---

# 26. 建议新的整体架构

最终我建议收敛成：

```text
                    Legacy Enterprise
                          │
        ┌─────────────────┼──────────────────┐
        │                 │                  │
      Data              Code               Docs
        │                 │                  │
      DB/Files         ETL/SQL             Wiki/BI
        │                 │                  │
        └─────────────────┼──────────────────┘
                          ↓
                 Discovery Adapters
                          ↓
              ┌───────────────────────┐
              │ Canonical Metadata    │
              │ + Evidence            │
              └───────────┬───────────┘
                          ↓
                 Data / Architecture
                     Context Graph
                          │
           ┌──────────────┼──────────────┐
           ↓              ↓              ↓
      Data Analyst    Semantic       Architecture
      Investigation   Discovery      Analysis
           │              │              │
           └──────────────┼──────────────┘
                          ↓
                 Current-State Model
                          ↓
                 Source of Truth
                 Business Rules
                 Data Semantics
                          ↓
              ┌───────────────────────┐
              │ Target Architecture   │
              │ Target Data Model     │
              │ Architecture Options  │
              │ ADR / Decisions       │
              └───────────┬───────────┘
                          ↓
                 Source-to-Target
                     Mapping
                          ↓
                 Validation Design
                          ↓
                Human Review / Decision
                          ↓
                  Migration Waves
```

---

# 27. 我建议这样重新划 V1.2 / V2 / V3

### V1.2 — Current-State Intelligence

重点不是增加很多 UI，而是补齐：

```text
Canonical Metadata Model
Job / JobRun
External Asset
Better lineage
Discovery adapters
Parse failures
Graph retrieval
Business Concept
Source-of-Truth candidates
```

目标：

> **把“我们发现了什么”真正建立起来。**

---

### V2.0 — Architecture Design

加入：

```text
Business Semantic Model
Business Rules
Current Data Model
Target Data Model
Architecture Options
Architecture Decision
Source-to-Target Mapping
```

目标：

> **从“理解 legacy”进入“设计 future state”。**

---

### V2.1 — Validation

加入：

```text
Mapping validation
Data reconciliation
Business rule validation
gold query
test cases
coverage
human review
```

目标：

> **证明 target design 没有把原有业务行为悄悄改掉。**

---

### V3.0 — Migration Planning

加入：

```text
dependency-based migration waves
work packages
backlog
dual run
reconciliation
cutover
rollback
```

目标：

> **从架构设计进入真正 modernization execution。**

---

# 28. 现在不要做的东西

目前我仍然不建议：

```text
❌ Neo4j
❌ Vector DB
❌ Multi-agent swarm
❌ Temporal
❌ BPMN
❌ 20+ database adapters
❌ 自动生产部署
❌ 自动修改 legacy system
❌ 全自动 migration
```

尤其不要因为现在目标变大，就推翻目前的：

```text
SQLite
+
JSON snapshot
+
Copilot SDK
+
Skills
+
SQLGlot
+
Evidence-first
```

这些都是可以保留的基础。

---

# 29. 按代码文件看，最应该动的顺序

| 优先级    | 文件 / 模块                      | 修改                                                          |
| ------ | ---------------------------- | ----------------------------------------------------------- |
| **P0** | `src/model/estate.ts`        | 升级 Canonical Metadata / Job / Run / external assets         |
| **P0** | `src/evidence/types.ts`      | Observation / Claim / Proposal / Verification / Decision 分离 |
| **P0** | `src/analysis/lineage.ts`    | static + runtime + job/process lineage                      |
| **P0** | `src/analysis/context.ts`    | graph-aware + semantic-aware retrieval                      |
| **P0** | `src/discovery/scanner.ts`   | adapter 化 + XML/ETL/代码类型                                    |
| **P0** | `src/analysis/sql-parser.ts` | parse failure + dialect + coverage                          |
| **P0** | `src/discovery/database.ts`  | PK/FK/views/procedure/query history                         |
| **P0** | `src/analysis/findings.ts`   | architecture assessment                                     |
| **P1** | `src/model/`                 | BusinessConcept / BusinessRule / Metric / Grain / SoT       |
| **P1** | `src/workflow/`              | phase workflow + review gate                                |
| **P1** | `src/agent/result.ts`        | structured proposal/design/mapping output                   |
| **P1** | 新增 `src/mapping/`            | STTM                                                        |
| **P1** | 新增 `src/architecture/`       | target architecture + ADR                                   |
| **P1** | `src/analysis/report.ts`     | Work Product generator                                      |
| **P1** | `tests/evaluation/`          | 完整 legacy modernization benchmark                           |
| **P1** | `web/src/App.tsx`            | Workbench，而非纯 Chat                                          |
| **P2** | DB/runtime adapters          | query history/runtime lineage                               |
| **P2** | export                       | dbt/Snowflake semantic view/Jira等                           |

---

## 最关键的一句话

现在这个项目的下一步**不是把 Agent 做得更聪明，而是让它拥有一套正确的“工作对象”**：

```text
Legacy Asset
     ↓
Evidence
     ↓
Current-State Fact
     ↓
Business Meaning
     ↓
Architectural Finding
     ↓
Target Design Proposal
     ↓
Source-to-Target Mapping
     ↓
Validation
     ↓
Human Decision
```

这样 `agentic-data-architect` 才会从目前的：

> **“一个能够调查 legacy 数据的 AI Agent”**

真正变成：

> **“Data Analyst + Data Architect 做 legacy modernization 时使用的 AI 工作台”。**

而且这条路线与目前行业实践相当一致：Databricks 正把外部系统、BI、Job、Column、Model API 纳入同一 lineage/context；Snowflake 正把历史 query、BI 和 metadata 用于自动建立 semantic model，并把人工验证嵌回同一工作流；OpenLineage 则提供了 Job/Run/Dataset 的通用 lineage 基础。([Databricks Documentation][1])

**因此我会把下一次代码修改的核心目标定成：`V1.2 = Canonical Metadata + Semantic Discovery + Architecture Workbench foundation`，而不是直接跳到完整 V2 target architecture。**

[1]: https://docs.databricks.com/aws/en/data-governance/unity-catalog/external-lineage?utm_source=chatgpt.com "External lineage | Databricks on AWS"
[2]: https://arxiv.org/abs/2602.04261?utm_source=chatgpt.com "Data Agents: Levels, State of the Art, and Open Problems"
[3]: https://github.com/OpenLineage/OpenLineage/blob/main/proposals/1837/static_lineage.md?utm_source=chatgpt.com "OpenLineage/proposals/1837/static_lineage.md at main · OpenLineage/OpenLineage · GitHub"
[4]: https://www.nextpathway.com/crawler360?utm_source=chatgpt.com "Enterprise Data Intelligence & Migration Assessment | CRAWLER360"
[5]: https://docs.snowflake.com/en/user-guide/views-semantic/autopilot?regcode=xandsz%7B%7B7%2A7%7D%7D&utm_source=chatgpt.com "Semantic View Autopilot | Snowflake Documentation"
[6]: https://docs.snowflake.com/en/user-guide/views-semantic/semantic-view-yaml-spec?utm_source=chatgpt.com "YAML specification for semantic views | Snowflake Documentation"
[7]: https://arxiv.org/abs/2510.16872?utm_source=chatgpt.com "DeepAnalyze: Agentic Large Language Models for Autonomous Data Science"
[8]: https://www.snowflake.com/en/blog/engineering/using-ai-improving-ai/?utm_source=chatgpt.com "Using AI to Improve AI with Cortex Analyst"
