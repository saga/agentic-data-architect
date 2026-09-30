# 当前实现状态（V1.1）

已实现：SQLGlot AST 解析（dataset + column lineage）、精确证据定位
（文件+行号+hash+discovery run）、Data Estate Graph、只读 DB adapter
（PostgreSQL/Snowflake）、真实 profiling、确定性 findings（含金融审查清单）、
结构化 Agent 结果（含状态校正）、按问题检索证据、golden benchmark + CI。

V1.1 优先完成（本节是对照清单，做完即勾）：
1. Evidence provenance ✓ 2. SQL AST / column lineage ✓ 3. Estate Graph ✓
4. 只读 database adapter ✓ 5. targeted profiling ✓ 6. findings/conflicts ✓
7. 结构化 Agent 结果 ✓ 8. evaluation ✓

V2 做 Semantic / Source-to-Target / Target Architecture。
V3 做 Migration Waves / Dual Run / Reconciliation / Cutover。
详见 `docs/implementation.md`，指标见 `docs/evaluation.md`。

---
## 当前交互与 Workspace

V1.1 现在不是一次性 CLI pipeline，而是持续 Investigation session：

```text
npm run start
   ↓
持续 session
   ↓
用户补充目标 / 上下文 / 文档 / GitHub URL
   ↓
Agent 分析
   ↓
用户继续提问 / 补充 / 纠正方向
   ↓
继续分析
```

默认 workspace：

```text
.workspace/
  shared/
    index.json
    confluence/
    github/
    leanix/
    web/
    document/
  <session-name>/
    context.json
    transcript.md
    discovery/
    reports/
    artifacts/
```

`.workspace/<session-name>/context.json` 是当前 Investigation 的主要状态入口。跨 session 可以复用的研究资料统一放在 `.workspace/shared/`，例如 Confluence 页面保存在 `.workspace/shared/confluence/`，并登记到 `.workspace/shared/index.json`。

研究流程尽量由 SKILL 定义；确定性事实通过现有 TypeScript / JavaScript / Python 工具执行，不在 prompt 里硬编码一套会漂移的操作说明。

---

早期设计阶段的仓库很小，但当前 `main` 已经完成 V1.1 Current-State Discovery 可靠闭环。后续设计必须以当前实现为基线，而不是继续按最初的 skeleton 假设来设计。

我还针对 8 个方向做了资料检索，并重点核查了 AWS、EY、Databricks、dbt、Snowflake、OpenLineage、EDM Council/FIBO，以及投资管理领域的 Security Master、IBOR、point-in-time 数据实践。比较明显的一条主线是：

> **这个项目不应该做成“会聊天的 Data Architect”，而应该做成一个以 Evidence、Metadata、Lineage、Data Profiling 和 Deterministic Validation 为基础，由 AI Agent 负责理解、推理、设计和解释的 Data Modernization Workbench。**

EY 在 2026 年公开的 legacy ETL AI 实践已经非常接近这个方向：先重建 data flow，再解析异构代码，再让 LLM 理解业务逻辑，最后用独立 validation engine 检查 AI 输出，而不是让 LLM 直接“猜”整个系统。([EY][1])

---

# 一、先定义这个 Agent 到底解决什么问题

我建议把项目定位成：

## Agentic Data Architect

> Analyze the existing data estate, understand what the data actually means and how it is produced, identify problems and hidden business logic, design a target-state data architecture, and produce an evidence-backed modernization plan.

不是：

> “帮我设计一个 Snowflake 数据仓库。”

而是：

> “这是一个已经运行了十年的 Portfolio Management 系统。请分析它现在有哪些数据源、哪些是真正的 source of truth、Position 是怎么计算出来的、Price 和 Corporate Action 从哪里来、哪些 ETL 包含业务逻辑、Research 使用的数据有没有 point-in-time 问题，然后设计迁移到新平台后的模型、source-to-target mapping、转换逻辑和验证方案。”

这两个问题的复杂度完全不同。

---

# 二、Data Architect 和 Data Analyst 的工作其实应该合在一个闭环里

实际项目里，这两个角色不是：

```text
Data Analyst
    ↓
Data Architect
    ↓
Data Engineer
```

这么简单。

更接近：

```text
              Business Question
                     │
                     ▼
             Data Analyst Work
       ┌─────────────┼─────────────┐
       │             │             │
   Discover       Profile       Reconcile
       │             │             │
       └─────────────┼─────────────┘
                     ▼
             Current-State Model
                     │
                     ▼
             Data Architect Work
       ┌─────────────┼─────────────┐
       │             │             │
     Model         Source        Transform
       │          Strategy        Design
       │             │             │
       └─────────────┼─────────────┘
                     ▼
              Target Architecture
                     │
                     ▼
             Migration / Mapping
                     │
                     ▼
                Validation
                     │
                     └──────────────► New Findings
```

所以 Agent 应该围绕 **问题和证据** 工作，而不是围绕“我是 Data Analyst / 我是 Data Architect”工作。

---

# 三、最重要的设计原则：LLM 不负责发现事实，LLM 负责理解事实

这是整个系统成败的关键。

不要：

```text
LLM → 看 5000 行 SQL → 猜它干什么
```

应该：

```text
Source system
   ↓
Metadata extraction
   ↓
SQL / ETL parser
   ↓
AST / normalized representation
   ↓
Lineage graph
   ↓
Data profiling
   ↓
Runtime metadata
   ↓
Business documentation
   ↓
Evidence context
   ↓
LLM reasoning
   ↓
Finding / Design / Explanation
   ↓
Deterministic validation
```

EY 2026 年公开的 legacy ETL AI 方法就是类似结构：inventory → code extraction → parsing → data-flow reconstruction → LLM interpretation → quality validation → documentation。([EY][1])

这比“RAG + ChatGPT 问数据”重要得多。

---

# 四、系统应该有一个核心对象：Evidence

我建议从第一天就定义：

```text
Evidence
```

所有 Agent 产生的结论都必须能够回指 Evidence。

例如 Agent 说：

> `portfolio_position.position_qty` 的 authoritative source 是 `IBOR_POSITION`.

不能只保存：

```json
{
  "answer": "IBOR_POSITION is the source of truth"
}
```

应该保存：

```json
{
  "claim": "IBOR_POSITION is the authoritative position source",
  "status": "supported",
  "evidence": [
    {
      "type": "lineage",
      "source": "IBOR_POSITION",
      "target": "PORTFOLIO_POSITION"
    },
    {
      "type": "sql",
      "query": "...",
      "result": "..."
    },
    {
      "type": "documentation",
      "document": "portfolio_architecture.md"
    }
  ]
}
```

然后状态只有几种：

```text
verified
supported
inferred
unknown
contradicted
```

不要一上来搞复杂 confidence score。

这个设计会直接解决 Agent 最危险的问题：

> **它很容易把“我推测这是 source of truth”说成“这是 source of truth”。**

AWS 的 migration guidance 也强调，应尽早使用 programmatic discovery，因为自动采集的数据通常比静态文档和 institutional knowledge 更可靠，并且要显式识别 data gaps，而不是等所有数据都完整以后才开始分析。([AWS Documentation][2])

---

# 五、Agent 的真正知识基础：Data Estate Graph

不要主要靠 vector database。

你的核心应该是一个 **Data Estate Graph**：

```text
System
  │
  ├── Application
  │
  ├── Database
  │     ├── Schema
  │     │    ├── Table
  │     │    │    ├── Column
  │     │    │    └── Constraint
  │     │    └── View
  │
  ├── File
  ├── API
  ├── Vendor Feed
  │
  └── Job
        ├── SQL
        ├── Stored Procedure
        ├── ETL Mapping
        ├── Python
        └── Scheduler

Dataset
   │
   ├── derived_from
   ├── transformed_by
   ├── consumed_by
   ├── mapped_to
   └── defined_by

Business Concept
   │
   ├── Security
   ├── Portfolio
   ├── Position
   ├── Transaction
   ├── Price
   ├── Benchmark
   └── Performance
```

甚至可以做到：

```text
portfolio_position.market_value
        │
        ├── derives_from
        │      ├── position.quantity
        │      └── security_price.close_price
        │
        ├── transformed_by
        │      └── calculate_market_value.sql
        │
        ├── source_price
        │      └── Bloomberg
        │
        ├── business_definition
        │      └── "Market Value"
        │
        └── consumed_by
               ├── Portfolio Analytics
               ├── Risk
               └── Performance
```

OpenLineage 的模型已经体现了这种方向：Job、Dataset、Run、field-level lineage 都可以作为显式 metadata，并且 lineage relationship 本身可以记录 transformation context。([OpenLineage][3])

---

# 六、第一阶段不是设计，而是 Current-State Discovery

Data Architect 最容易犯的错误就是：

> 看了几张表以后开始画 target architecture。

Agent 必须先完成：

## Current State Discovery

输出一套标准化的：

### 1. System Inventory

```text
System
Application
Database
Owner
Technology
Environment
Criticality
Purpose
Status
```

### 2. Data Source Inventory

```text
Source
Dataset
Source Type
Owner
Vendor
Frequency
Volume
Freshness
Format
Identifiers
Consumers
```

### 3. Transformation Inventory

```text
Job
Technology
Input
Output
Schedule
Business Logic
Owner
Failure Handling
```

### 4. Consumer Inventory

```text
Report
Dashboard
Application
API
Research Notebook
Model
User
```

### 5. Dependency Graph

```text
Source
 → ingestion
 → staging
 → transformation
 → curated
 → analytics
 → report/application
```

### 6. Unknowns

这个非常重要。

例如：

```text
UNKNOWN:
- Is PRICE_A authoritative or merely a fallback?
- Why is adjusted_price calculated twice?
- Which job owns FX conversion?
- Is POSITION table a snapshot or a derived state?
- Does RESEARCH_FUNDAMENTAL contain restated values?
```

**Unknown 本身就是结果。**

---

# 七、Data Analyst Agent 应该怎么工作

Data Analyst Agent 不应该只是 Text-to-SQL。

一个真正有价值的流程应该是：

```text
Question
   ↓
Clarify scope
   ↓
Identify candidate sources
   ↓
Check business definitions
   ↓
Profile data
   ↓
Reconcile sources
   ↓
Explore
   ↓
Form hypothesis
   ↓
Test hypothesis
   ↓
Find root cause
   ↓
Validate
   ↓
Produce evidence-backed result
```

例如：

> “为什么 Portfolio A 的 NAV 在两个系统里不一样？”

Agent 不应该直接生成：

```sql
select ...
```

它应该先建立分析计划：

```text
Question:
NAV discrepancy

Check:
1. Same valuation date?
2. Same portfolio definition?
3. Same position status?
4. Same security master?
5. Same prices?
6. Same FX?
7. Same corporate-action adjustments?
8. Same accrued income?
9. Same transaction cutoff?
10. Same rounding rules?
```

然后逐项检查。

最终输出：

```text
Finding

Difference: 1.82%

Primary cause:
Corporate action adjustment

Evidence:
- Source A uses adjusted close
- Source B uses unadjusted close
- Event effective date = 2026-08-14
- Source A applied adjustment on 2026-08-13
- Source B applied it on 2026-08-14

Impact:
Historical NAV for 17 portfolios is affected.
```

这才是 Data Analyst Agent。

---

# 八、Data Architect Agent 则负责把分析结果变成设计

Data Architect Agent 的输入应该是：

```text
Business requirements
+
Current-state model
+
Data profiling
+
Lineage
+
Known issues
+
Business definitions
+
Constraints
```

然后执行：

```text
1. Identify domains
2. Identify system of record
3. Identify ownership
4. Define logical model
5. Define physical model
6. Define integration pattern
7. Define transformation ownership
8. Define semantic layer
9. Define quality controls
10. Define governance
11. Define migration strategy
12. Define transitional architecture
```

当前 JPMorgan 的 Senior Lead Data Architect 职位描述也非常接近这个范围：逻辑/物理模型、3NF/维度模型、semantic foundations、schema evolution、lineage、validation、security、auditability 都属于同一个 data architecture 工作域。([JPMC][4])

---

# 九、金融服务场景必须建立自己的 Domain Model

这是这个项目区别于普通 Data Architecture Agent 的核心。

不能只是：

```text
Customer
Order
Product
```

而应该理解 Investment / Portfolio Management 的核心实体。

我建议第一版至少支持：

```text
Security / Instrument
Issuer / Entity
Portfolio
Account
Position
Transaction
Order
Trade
Cash
Price
FX
Corporate Action
Benchmark
Index
Fundamental
Estimate
Research
Portfolio Performance
Risk
Factor
Exposure
```

然后建立关系：

```text
Issuer
  ↓
Security
  ↓
Position
  ↓
Portfolio
  ↓
Performance
```

以及：

```text
Security
  ├── Price
  ├── Corporate Action
  ├── Fundamental
  ├── Benchmark Membership
  └── Research
```

FIBO 很适合作为这个 Agent 的外部参考 vocabulary，而不是强行成为你的最终物理模型。FIBO 本身就是面向金融行业概念及其关系的机器可读 ontology，EDM Council 还提供了由 FIBO 衍生的 Financial Industry Business Data Model。([EDM Council][5])

设计上应该是：

```text
FIBO
   ↓ reference vocabulary
Firm business ontology
   ↓
Current legacy model
   ↓ mapping
Target domain model
```

而不是：

```text
FIBO
 ↓
直接生成数据库
```

---

# 十、投资研究场景必须把 Time 当成一等公民

这个项目最大的金融特色之一，我认为应该是：

> **任何涉及 historical research 的 Agent，都必须理解 point-in-time semantics。**

普通数据架构可能只关心：

```text
effective_date
```

投资研究往往至少需要：

```text
valid_time
event_time
publication_time
knowledge_time
ingestion_time
```

例如：

```text
FY2025 Revenue
```

可能有：

```text
Fiscal Period End:
2025-12-31

Filed:
2026-02-28

Restated:
2027-03-01
```

2026-01-15 的研究不应该看到 2027 年的 restatement。

近期关于 point-in-time financial data 的研究明确强调，要把 fiscal valid time、public/release time、system time 等分开，并保留原始披露与后续修订。([SSRN][6])

因此 Agent 应该能够主动问：

```text
Is this dataset:
- current truth?
- historical truth?
- as-reported truth?
- restated truth?
- point-in-time truth?
```

这比“这个表是不是 3NF”重要得多。

---

# 十一、Security Master 不能只是一个普通维表

金融数据分析中经常存在：

```text
ISIN
CUSIP
SEDOL
FIGI
Ticker
Internal Security ID
Vendor Security ID
```

Agent 应该能够发现：

```text
Bloomberg security_id
        ↓
Internal security_id
        ↓
Portfolio position
```

并分析：

```text
- identifier mapping
- issuer mapping
- instrument lifecycle
- corporate action
- symbol changes
- inactive securities
- delisted instruments
```

业界的 Security Master 产品普遍采用 centralized reference-data model，并把多供应商数据统一到 canonical identifier / reference-data 层。([GoldenSource][7])

所以 Agent 发现：

```text
System A uses ticker
System B uses ISIN
System C uses Bloomberg ID
System D uses internal ID
```

不能只报告“字段不同”。

应该报告：

```text
Identifier fragmentation

Risk:
Cross-source joins depend on implicit mapping.

Recommendation:
Introduce / strengthen canonical Security Master.

Target:
External Identifier
        ↓
Security Master
        ↓
Canonical Security ID
        ↓
all downstream domains
```

---

# 十二、Position / IBOR 也是一个关键分析模式

Portfolio Management 系统中，Position 经常是最核心的数据对象之一。

行业实践中，IBOR 通常被设计为提供统一、及时的 position view；例如一些 buy-side 架构把 transaction、reference data、corporate action 等汇聚后形成 position，并供 front office、risk、performance、reporting 等消费者使用。([CRD][8])

但这里有一个重要原则：

> **Agent 可以识别 IBOR pattern，但不能默认某个系统就是 IBOR。**

Agent 应该通过证据判断：

```text
Which system calculates position?
Which system owns position?
Which systems merely cache it?
Which positions are:
- forecast
- traded
- committed
- settled
- accounting
- historical
```

这类状态差异本身就是架构分析结果。

---

# 十三、Target Architecture 不要简单套 Bronze / Silver / Gold

Bronze / Silver / Gold 可以作为物理层，但不要把它当作完整逻辑架构。

我更建议：

```text
                Business / Semantic
                        │
          ┌─────────────┼─────────────┐
          │             │             │
      Research      Portfolio       Risk
          │             │             │
          └─────────────┼─────────────┘
                        │
                Domain Data Products
                        │
          ┌─────────────┼─────────────┐
          │             │             │
     Security       Position      Transaction
       Master
          │             │             │
          └─────────────┼─────────────┘
                        │
                Canonical / Core
                        │
                Standardization
                        │
               Source-preserving
                        │
                 Raw / Landing
```

也就是：

```text
Source Fidelity
      ↓
Normalization
      ↓
Canonical / Domain
      ↓
Analytics
      ↓
Semantic
      ↓
Consumers
```

Snowflake 当前把 Semantic View 定义为在数据上定义 business concepts 的 schema-level object；dbt Semantic Layer 同样把 metrics 定义从 BI 层上移到 modeling layer，目标是让不同消费者使用一致的业务定义。([Snowflake Documentation][9])

因此 Agent 应当把：

```text
Table
Column
Metric
Business Definition
```

分开。

---

# 十四、Business Meaning 应该成为 Agent 的第二张图

最终最好有两张图：

## Technical Graph

```text
DB
 ↓
TABLE
 ↓
COLUMN
 ↓
JOB
 ↓
TABLE
 ↓
REPORT
```

以及：

## Semantic Graph

```text
Security
 ↓
Position
 ↓
Market Value
 ↓
Portfolio
 ↓
Performance
```

然后有 mapping：

```text
position.market_value
        ↓
implements
        ↓
Business Concept: Market Value
```

这样 Agent 才能回答真正有价值的问题：

> “这个系统里的 `mv_amt` 到底是不是我们业务上定义的 Market Value？”

而不是：

> “这张表有一个叫 mv_amt 的字段。”

---

# 十五、Semantic Layer 不应该完全手工维护

这是这个项目可以做出价值的地方。

Agent 可以从现有系统自动挖掘 business semantics：

```text
SQL
CASE expressions
column comments
table comments
reports
dashboard labels
API names
documentation
Jira/user stories
tests
existing metrics
SME conversations
```

例如：

```sql
CASE
  WHEN security_type = 'EQ'
   AND position_qty > 0
  THEN ...
END
```

Agent 可以生成候选业务规则：

```text
Potential Business Rule

"Equity Long Position"

Evidence:
SQL object X
Used by:
Portfolio report Y
Frequency:
Daily

Status:
inferred
```

然后 SME 确认：

```text
accepted
rejected
modified
```

这比人工从零建立 glossary 更现实。

---

# 十六、Lineage 要做到至少三层

## Level 1：Dataset lineage

```text
A → B → C
```

## Level 2：Column lineage

```text
A.price
    ↓
B.adjusted_price
    ↓
C.market_value
```

## Level 3：Transformation lineage

```text
A.price
  ↓
multiply FX
  ↓
apply corporate action
  ↓
join position
  ↓
aggregate portfolio
  ↓
C.market_value
```

第三层其实是 Agent 最有价值的地方。

OpenLineage 已经提供 Job/Dataset/field-level lineage 的标准化表示，尤其支持显式描述 field relationship 和 transformation。([OpenLineage][10])

---

# 十七、Modernization Agent 应该产生 Source-to-Target Mapping

这是 Data Architect 最实际的输出之一。

例如：

| Source           | Target                  | Transformation          | Evidence | Status    |
| ---------------- | ----------------------- | ----------------------- | -------- | --------- |
| `LEGACY.POS_QTY` | `position.quantity`     | direct                  | SQL-182  | verified  |
| `LEGACY.SEC_ID`  | `security.id`           | security master mapping | MAP-41   | supported |
| `LEGACY.MV`      | `position.market_value` | `qty × price × fx`      | SQL-223  | supported |
| `LEGACY.PX_ADJ`  | `price.adjusted`        | corporate-action logic  | PROC-88  | inferred  |

Agent 不应该只生成 target schema。

它必须同时生成：

```text
Source-to-target mapping
+
Transformation specification
+
Validation rule
```

例如：

```text
Target:
position.market_value

Formula:
quantity × price × FX

Validation:
sum(target.market_value)
≈
sum(source.portfolio_value)

Tolerance:
0.01%

Additional checks:
currency
valuation date
position status
security identity
```

---

# 十八、Migration 不是“把所有表搬过去”

AWS 的迁移实践也是先进行 progressively refined discovery，然后按 workload 的依赖、复杂度和目标策略形成 migration waves，而不是一开始就决定所有东西怎么迁。([AWS Documentation][11])

Agent 应该针对每个 data asset 给出：

```text
Rehost
Replatform
Refactor
Replace
Retire
Retain
```

但不是凭模型判断，而是：

```text
Current evidence
+
Business criticality
+
Dependency complexity
+
Data quality
+
Target fit
+
Migration risk
```

例如：

```text
Legacy Pricing Table
→ Replatform

Legacy Position Calculation
→ Refactor

Unused Historical Report Table
→ Retire

Security Master
→ Rebuild / Consolidate

Research Dataset
→ Re-architect for point-in-time
```

---

# 十九、必须支持 Transitional Architecture

这是很多 AI Architecture Agent 会漏掉的。

现实通常不是：

```text
Legacy
   ↓
New
```

而是：

```text
                   ┌───────────────┐
                   │   Legacy      │
                   └───────┬───────┘
                           │
                     CDC / Batch
                           │
                           ▼
                    New Platform
                           │
                ┌──────────┴──────────┐
                │                     │
             Legacy                  New
            Consumers              Consumers
```

然后逐步：

```text
Wave 1
Security Master

Wave 2
Prices

Wave 3
Positions

Wave 4
Portfolio Analytics

Wave 5
Research

Wave 6
Legacy retirement
```

Agent 必须设计：

```text
coexistence
dual run
cutover
rollback
reconciliation
decommission
```

而不是只画一个漂亮的 target architecture。

---

# 二十、Validation 是整个系统最重要的“刹车”

每一个 Agent architecture output 都应该经过 validation。

至少：

### Schema Validation

```text
columns
types
constraints
keys
nullability
```

### Data Validation

```text
row count
distinct count
null rate
distribution
min/max
duplicates
referential integrity
```

### Business Validation

```text
NAV
Position
AUM
Performance
Cash
Exposure
```

### Temporal Validation

```text
as-of
effective date
publication date
knowledge date
```

### Reconciliation

```text
Legacy aggregate
       ≈
Target aggregate
```

### Lineage Validation

```text
Every target field
must have source/evidence
```

### Transformation Equivalence

```text
Legacy logic
      vs
New logic
```

而不是：

> “LLM 认为两套逻辑应该一样。”

---

# 二十一、Agent 的工具应该分成 Read / Analyze / Design / Write

## Read-only

```text
list_databases
get_schema
get_table_metadata
get_column_metadata
sample_data
profile_data
get_query_history
get_job_metadata
get_lineage
read_code
read_document
search_catalog
search_git
```

## Analyze

```text
profile_dataset
compare_datasets
compare_schema
infer_keys
detect_duplicates
detect_outliers
trace_lineage
trace_column_lineage
explain_transformation
find_source_of_truth
find_conflicting_definitions
detect_data_quality_issue
```

## Design

```text
create_domain_model
create_logical_model
create_physical_model
create_source_target_mapping
create_transformation_spec
create_migration_wave
create_validation_plan
create_adr
```

## Write

默认只允许：

```text
write artifact
create branch
create SQL
create YAML
create mapping
create documentation
```

而不是：

```text
ALTER TABLE production
DROP TABLE
DELETE DATA
change pipeline in production
```

如果未来支持这些，必须独立 Approval Gate。

---

# 二十二、不要让 Agent 直接扫整个生产数据库

这是一个非常重要的工程边界。

建议：

```text
Metadata
    ↓
statistics
    ↓
sample
    ↓
targeted query
    ↓
full scan
```

而不是：

```text
LLM → SELECT * FROM gigantic_table
```

Agent 第一轮应该先拿：

```text
row count
column statistics
null %
distinct %
min/max
histogram/sample
partition info
freshness
```

发现问题以后再定向查询。

这也是 Data Analyst 实际工作更接近的方式：先缩小问题空间，再深入。

---

# 二十三、知识库不要成为“系统真相”

建议明确：

```text
Knowledge Base
        ≠
Source of Truth
```

Knowledge Base 只是：

```text
context
```

而 Source of Truth 来自：

```text
database metadata
runtime metadata
lineage
source code
query result
data profiling
approved business definition
human confirmation
```

例如：

```text
README:
"Positions come from IBOR"

Runtime:
Actually 23% of reports read LEGACY_POSITION directly.

Agent:
CONFLICT DETECTED
```

这是非常有价值的结果。

---

# 二十四、Agent 最应该主动找的是“矛盾”

真正有价值的 modernization work 往往不是：

> “这里有一张 Position 表。”

而是：

> “发现 4 个系统都声称自己提供 Position。”

例如：

```text
IBOR_POSITION
ACCOUNTING_POSITION
PORTFOLIO_POSITION
RISK_POSITION
```

Agent 应该自动产生：

```text
Finding #17

Potential Multiple Sources of Truth

Concept:
Position

Candidates:
A
B
C
D

Evidence:
...

Differences:
- timing
- transaction status
- valuation
- corporate actions

Impact:
Potential inconsistent downstream analytics.

Decision required:
Define authoritative position views by use case.
```

---

# 二十五、金融场景里，Agent 应该有一组“专用审查问题”

例如 Position：

```text
What is the authoritative source?
What is the position definition?
What transaction states are included?
Is it estimated/traded/settled/accounting?
Is it point-in-time?
How are corporate actions applied?
How is FX handled?
How is cash treated?
```

Security：

```text
What is the canonical security ID?
How are identifiers mapped?
What is the lifecycle model?
How are delisted instruments represented?
How are corporate actions versioned?
```

Price：

```text
Which vendor is primary?
What is fallback precedence?
Raw or adjusted?
Intraday or EOD?
Timezone?
Currency?
Pricing date?
Revision policy?
```

Fundamentals：

```text
Reported or restated?
Announcement date?
Fiscal date?
Knowledge date?
Restatement history?
```

Portfolio：

```text
Who owns the position?
How is NAV calculated?
What is the valuation cutoff?
What is the hierarchy?
What constitutes a portfolio?
```

Research：

```text
What information was actually available at the research date?
What is the vintage?
What is the source?
What assumptions were applied?
```

---

# 二十六、Agent 的输出不应该只有一份 Architecture Document

我建议标准化成 10 类 artifacts：

```text
01. Data Estate Inventory
02. Current-State Architecture
03. Data Model Catalog
04. Data Dictionary / Semantic Model
05. Data Lineage
06. Transformation Catalog
07. Data Quality Findings
08. Source-to-Target Mapping
09. Target-State Architecture
10. Migration & Validation Plan
```

以及两个特别重要的：

```text
11. Decision Log / ADR
12. Evidence Pack
```

---

# 二十七、Evidence Pack 是金融服务场景很重要的一层

例如最后要回答：

> 为什么建议 Security Master 从三个系统合并成一个？

Evidence Pack 应该包含：

```text
Finding
Affected systems
Affected datasets
Evidence
Lineage
Profiling
Source precedence
Business impact
Architecture decision
Alternative considered
Validation
Human approval
Timestamp
Agent version
```

这样未来可以重新检查。

---

# 二十八、Agent 的工作状态应该是一个 Investigation，而不是 Chat Session

建议核心实体：

```text
Investigation
```

里面包含：

```text
Goal
Scope
Systems
Questions
Evidence
Findings
Decisions
Artifacts
Reviews
Status
```

例如：

```text
Investigation:
"Modernize Portfolio Analytics"

Questions:
1. What is the source of position?
2. How is market value calculated?
3. Which prices are authoritative?
4. How is performance calculated?
5. Which legacy transformations are still required?
6. Which data can move unchanged?
7. Which data needs redesign?
```

Agent 不是“聊天几轮以后记住上下文”。

它是在维护一个 **可持续的 investigation state**。

---

# 二十九、推荐的 Agent 结构：不要做成 Agent Swarm

你这个项目不需要几十个 agent。

我建议：

```text
                 Lead Data Agent
                       │
          ┌────────────┼────────────┐
          │            │            │
      Analyst Skill  Architect   Reviewer
                         Skill      Skill
          │            │            │
          └────────────┼────────────┘
                       │
                 Tool / Engine Layer
```

也就是说：

## 1 个主要 Agent

负责：

```text
planning
reasoning
questions
synthesis
communication
architecture decisions
```

## 下面是 deterministic engines

```text
parser
profiler
lineage
query engine
comparison engine
validation engine
```

## Skills

```text
data-analysis
data-modeling
investment-data
migration
semantic-modeling
data-quality
```

而不是：

```text
SecurityAgent
PriceAgent
PositionAgent
ResearchAgent
PortfolioAgent
...
```

这种方案很容易变成 multi-agent orchestration 地狱。

---

# 三十、Repository 建议从一开始就按这些边界设计

考虑到现在项目几乎是空的，我建议：

```text
agentic-data-architect/
│
├── README.md
│
├── docs/
│   ├── architecture.md
│   ├── workflow.md
│   ├── finance-domain.md
│   ├── evidence-model.md
│   └── evaluation.md
│
├── src/
│   │
│   ├── agent/
│   │   ├── planner.ts
│   │   ├── analyst.ts
│   │   ├── architect.ts
│   │   └── reviewer.ts
│   │
│   ├── discovery/
│   │   ├── catalog.ts
│   │   ├── schema.ts
│   │   ├── source.ts
│   │   └── runtime.ts
│   │
│   ├── analysis/
│   │   ├── profiling.ts
│   │   ├── lineage.ts
│   │   ├── reconciliation.ts
│   │   └── transformation.ts
│   │
│   ├── modeling/
│   │   ├── domain.ts
│   │   ├── logical.ts
│   │   ├── physical.ts
│   │   └── semantic.ts
│   │
│   ├── migration/
│   │   ├── mapping.ts
│   │   ├── waves.ts
│   │   └── validation.ts
│   │
│   └── evidence/
│       ├── claim.ts
│       ├── finding.ts
│       └── artifact.ts
│
├── adapters/
│   ├── postgres/
│   ├── snowflake/
│   ├── oracle/
│   ├── sqlserver/
│   ├── files/
│   ├── git/
│   └── catalog/
│
└── examples/
    ├── investment/
    ├── portfolio/
    └── modernization/
```

不过这些只是逻辑边界，不代表第一版全部实现。

---

# 三十一、第一版最值得做什么

不要一开始做完整 Enterprise Data Architecture Platform。

我会把 V1 压到下面这条闭环：

```text
Git / DB / SQL / ETL
        ↓
Discovery
        ↓
Inventory
        ↓
Schema extraction
        ↓
SQL / ETL parsing
        ↓
Lineage
        ↓
Data profiling
        ↓
AI Analyst
        ↓
Current-State report
```

用户可以问：

```text
Where does Position come from?
```

Agent 能回答：

```text
source
 → transformation
 → table
 → downstream
```

并且全部带 evidence。

再问：

```text
Why does this field have this value?
```

Agent 能追到：

```text
source column
 → expression
 → transformation
 → business rule
```

做到这个，项目已经成立。

---

# 三十二、V2 才开始 Target Architecture

加入：

```text
domain modeling
semantic modeling
source-of-truth identification
data quality findings
canonical model proposal
source-target mapping
```

这时候用户可以：

> “把当前 Position architecture modernize。”

Agent 输出：

```text
Current State
     ↓
Problems
     ↓
Target State
     ↓
Domain Model
     ↓
Mapping
     ↓
Transformation
     ↓
Validation
```

---

# 三十三、V3 才做 Migration Planning

加入：

```text
7R classification
dependency-based wave planning
coexistence architecture
dual-run
reconciliation
cutover
rollback
decommission
```

AWS 的 migration methodology 本身就是渐进式 discovery → detailed assessment → migration strategy → wave planning → continuous assessment，而不是一次性生成一个 migration plan。([AWS Documentation][12])

所以 Agent 也应该是迭代式。

---

# 三十四、V4 才考虑自动修改数据平台

最后才进入：

```text
generate SQL
generate dbt models
generate Snowflake semantic views
generate pipeline
create PR
run validation
request human approval
merge
```

Snowflake 当前的 Semantic View 已经支持 YAML 定义 business concepts，因此很适合作为 Agent 生成 semantic contract 的目标格式之一；dbt 的 Semantic Layer 也是类似的 architectural precedent。([Snowflake Documentation][9])

---

# 三十五、评估这个 Agent 时，不要只评估“答案对不对”

应该建立一个 Legacy Data Architecture Benchmark。

准备几组真实结构的 synthetic estate：

```text
Oracle
SQL Server
Postgres
Snowflake
Informatica
Stored Procedures
Python ETL
CSV
Excel Mapping
Tableau
Power BI
Documentation
```

并人为制造：

```text
duplicate sources
hidden transformations
wrong documentation
multiple identifiers
missing lineage
semantic conflicts
bad joins
historical revisions
corporate actions
point-in-time problems
```

然后让 Agent 完成任务：

### Task 1

> Find the source of truth for Position.

### Task 2

> Trace `market_value` back to source.

### Task 3

> Explain why two systems disagree.

### Task 4

> Find duplicate transformation logic.

### Task 5

> Identify data quality risks.

### Task 6

> Produce source-to-target mapping.

### Task 7

> Propose target domain model.

### Task 8

> Design migration waves.

### Task 9

> Produce reconciliation strategy.

### Task 10

> Identify all unsupported assumptions.

评价：

```text
Lineage precision
Lineage recall
Field mapping accuracy
Transformation accuracy
Finding accuracy
Evidence coverage
Unsupported-claim rate
Reconciliation completeness
Artifact completeness
Human review effort
```

特别应该测：

> **Unsupported Claim Rate**

也就是：

```text
Agent confidently said X
but no evidence supports X
```

这个指标对你的项目比普通 LLM benchmark 更重要。

---

# 三十六、最应该防的 10 个失败模式

## 1. Hallucinated lineage

“看起来是从 A 来的。”

实际上没有证据。

---

## 2. Documentation bias

旧文档说 A 是 source of truth，但实际运行路径已经变成 B。

---

## 3. Semantic hallucination

`mv_amt` 被 Agent 自己解释成 Market Value。

其实可能是：

```text
market value
book value
exposure
valuation amount
```

---

## 4. SQL ≠ Business Logic

Agent 只读 SQL，却没有理解：

```text
transaction status
corporate action
portfolio hierarchy
```

---

## 5. Current Data ≠ Historical Data

尤其是 investment research。

---

## 6. Duplicate Logic

两个系统都计算：

```text
market_value
performance
FX
```

Agent 如果只看 schema 很容易漏掉。

---

## 7. Replatform = Modernization

这是必须主动识别的错误。

迁移后如果：

```text
same schema
same bad ETL
same duplicated business logic
```

实际上只是移动了技术债务。AWS 和其他 modernization guidance 都明确区分 rehost/replatform/refactor，并强调 rehost 本身不会消除底层架构问题。([Amazon Web Services, Inc.][13])

---

## 8. Sampling Bias

Agent 看 1000 行数据得出：

> “这个字段 always populated。”

实际生产数据可能有 5 billion rows。

---

## 9. False Reconciliation

两个 aggregate 相同，不代表业务逻辑相同。

---

## 10. Overconfident Architecture

Agent 给出了漂亮的 target architecture，但：

```text
business owner didn't agree
source owner doesn't agree
data contract doesn't exist
migration dependency unknown
```

所以最终必须有：

```text
Evidence
Unknown
Decision
Approval
```

四种状态。

---

# 三十七、最后形成的产品体验应该是什么样

用户进入项目以后，不是：

```text
Chat with Data Architect
```

而是：

```text
New Investigation

Goal:
Modernize Portfolio Analytics

Scope:
- Position
- Security
- Price
- Performance

Systems:
- Legacy Oracle
- Informatica
- Bloomberg
- Portfolio DB
- Tableau

[Start Discovery]
```

Agent 开始以后：

```text
Discovery                  ✓
Source inventory           ✓
Schema analysis            ✓
Lineage                    82%
Data profiling             71%
Semantic mapping           54%
Business rules             41%

Open questions:
12

Conflicts:
7

High-risk findings:
4
```

然后用户可以进入：

```text
Current State
Lineage
Data Model
Data Quality
Business Semantics
Findings
Target Architecture
Migration Plan
Validation
Evidence
```

这比一个聊天窗口有价值很多。

---

# 三十八、我认为这个项目真正的核心定位

最终可以把整个系统浓缩成这一句话：

> **AI 不负责“知道企业的数据架构”；AI 负责从企业实际存在的 metadata、code、data、lineage、documentation 和 business definitions 中重建这个架构，然后提出并验证下一版架构。**

也就是：

```text
                ENTERPRISE DATA ESTATE
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
     Metadata           Code              Data
       │                 │                 │
       └─────────────────┼─────────────────┘
                         ▼
                 Deterministic Analysis
                         │
         ┌───────────────┼───────────────┐
         │               │               │
      Profiling       Lineage        Transformation
         │               │               │
         └───────────────┼───────────────┘
                         ▼
                    Evidence Graph
                         │
                         ▼
                     AI Agent
             ┌───────────┼───────────┐
             │           │           │
          Analyst     Architect    Reviewer
             │           │           │
             └───────────┼───────────┘
                         ▼
                Current-State Truth
                         │
                         ▼
                 Target Architecture
                         │
                         ▼
               Mapping / Migration
                         │
                         ▼
                    Validation
                         │
                         ▼
                 Human Decision
```

这套结构和当前行业实践的交集比较大：AWS 强调 progressive discovery、metadata 和 high-fidelity assessment；EY 已经把 legacy ETL 的 AI 分析做成“flow reconstruction + parsing + LLM interpretation + validation”；Databricks/OpenLineage 强调可追踪的 lineage；dbt/Snowflake 都把 business semantics 往数据建模层推进；FIBO 则可以给金融领域提供机器可读的业务语义参考。([AWS Documentation][12])

对于你的场景，**第一优先级不是做“最聪明的 Data Architect Agent”，而是先把 `Evidence → Metadata Graph → Deterministic Analysis → Agent Reasoning → Validation` 这条链做扎实**。一旦这条链成立，Data Analyst、Data Architect、Migration Architect 其实都可以只是不同的工作模式，而不需要再堆很多 Agent。

[1]: https://www.ey.com/en_ch/insights/ai/ai-etl-analysis-automation?utm_source=chatgpt.com "From days to minutes: AI-powered logic analysis of legacy ETL | EY - Switzerland"
[2]: https://docs.aws.amazon.com/prescriptive-guidance/latest/strategy-application-portfolio-assessment-migration/portfolio-discovery-initial-planning.html?utm_source=chatgpt.com "Discovery acceleration and initial planning - AWS Prescriptive Guidance"
[3]: https://openlineage.io/docs/spec/facets/?utm_source=chatgpt.com "Facets & Extensibility | OpenLineage"
[4]: https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210793254?utm_source=chatgpt.com "Senior Lead Data Architect: Information Architecture - JPMC Candidate Experience page Careers"
[5]: https://edmcouncil.org/financial-industry-business-ontology/?utm_source=chatgpt.com "Financial Industry Business Ontology - EDM Council"
[6]: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7183438&utm_source=chatgpt.com "<p>Point-In-Time Data Integrity in Quantitative Equity Research </p> <div> A Reproducible Framework for Eliminating Look-Ahead Bias </div> by Arthur Wang :: SSRN"
[7]: https://www.thegoldensource.com/reference-data/?utm_source=chatgpt.com "GoldenSource Reference Data Solutions and Compliance - GoldenSource"
[8]: https://www.crd.com/solutions/charles-river-ibor/?utm_source=chatgpt.com "IBOR – Cash and Position Management (IBOR) | Charles River Development"
[9]: https://docs.snowflake.com/en/user-guide/views-semantic/semantic-view-yaml-spec?utm_source=chatgpt.com "YAML specification for semantic views | Snowflake Documentation"
[10]: https://openlineage.io/docs/spec/facets/job-facets/lineage/?utm_source=chatgpt.com "Lineage Job Facet | OpenLineage"
[11]: https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-portfolio-playbook/discovery.html?utm_source=chatgpt.com "Task 1: Performing the initial discovery - AWS Prescriptive Guidance"
[12]: https://docs.aws.amazon.com/prescriptive-guidance/latest/strategy-application-portfolio-assessment-migration/introduction.html?utm_source=chatgpt.com "Application portfolio assessment strategy for AWS Cloud migration - AWS Prescriptive Guidance"
[13]: https://aws.amazon.com/blogs/migration-and-modernization/a-framework-for-accelerated-modernization-and-technical-debt-reduction/?utm_source=chatgpt.com "A Framework for Accelerated Modernization and Technical Debt Reduction | Migration & Modernization"


---

# Investigation Workspace 与外部企业知识

真人做 Brownfield Data Analysis 时，不会只依靠一次 Agent prompt。研究会持续几天甚至几周，输入来自代码、数据库、GitHub、企业架构库、Confluence、访谈和历史研究。因此 Investigation 必须有独立、可持续的 workspace。

目录：

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

## context.json 是研究上下文的入口

context.json 至少记录：

- 用户最初 prompt
- 每次新的 input / question / research query
- 重要事实、约束和决定
- 长研究结果对应的 artifactPath

它是工作记忆和研究索引，不替代 investigation.json 中的规范化业务状态，也不替代 Evidence Catalog。

## 企业研究来源的优先级

### GitHub

代码研究开始时由用户选择：

1. 直接 GitHub Tool：通过 repository URL/API 读取，适合公司 GitHub Organization 和小范围检查。
2. Clone 到 workspace/sources/github/：使用本地 find / grep / rg / git 做大范围、跨文件、反复分析。

代码、README、Issue/PR 分别视为实现证据、文档证据、讨论证据。不要把 README 当成比实际代码更高优先级的事实来源。

### SAP LeanIX

企业架构 Fact Sheet、应用关系、owner、lifecycle 等信息优先从 SAP LeanIX 官方 MCP 获取。LeanIX 官方 MCP 的作用就是让 AI Agent 安全访问企业架构 inventory、Fact Sheet 和关系，因此不应在项目里重新实现一个专用 LeanIX REST connector。

LeanIX 的登记状态仍然只是一个 Evidence Source。若与代码、运行数据或业务确认冲突，应记录 conflict，而不是自动覆盖其它证据。

### Confluence

企业内部架构、ADR、流程和运行文档优先通过 Atlassian 官方 Rovo MCP 查询。Confluence 是重要 documentation evidence，但不能假设它就是当前真实状态；必须关注更新时间、owner、版本、superseded/obsolete 标记，以及是否描述 current state 或 target state。

## 研究结果必须落盘

研究记录不得只存在 chat history：

- search / query 记录放 workspace/research/
- 重要结论放 workspace/findings/
- 外部源码副本放 workspace/sources/
- 可复用中间产物放 workspace/artifacts/
- context.json 保留索引和重要信息

这样 Agent 才能在多轮、多天的 Investigation 中继续工作，而不是每次重新研究一遍。
