我检查了当前 `main` 的最新代码。现在这个仓库已经有了正确的骨架，但**还停留在“V1 demo skeleton”**：真正决定这个项目价值的几个基础能力还没有落地，而且有几处代码已经违反了你自己在 `docs/architecture_0930.md` 里定下的 Evidence-first 原则。

我不建议现在直接跳到完整的 Target Architecture / Migration Agent。应该先把 **Current-State Discovery 做成真正可靠的闭环**，然后再进入 V2。

---

# 一、先说结论：现在最应该补的 7 个功能

按优先级：

| 优先级 | 要加                                        | 原因                                        |
| --- | ----------------------------------------- | ----------------------------------------- |
| P0  | Evidence provenance / 精确证据定位              | 现在的 Claim 虽然有 Evidence 字段，但实际上没有精确绑定      |
| P0  | 真正的 SQL AST / lineage parser              | 当前正则解析太脆弱，不符合 legacy modernization 要求     |
| P0  | Data Estate Graph                         | 当前只有一个 lineage JSON，没有统一的实体/关系模型          |
| P0  | Read-only DB metadata + profiling adapter | 当前只能扫 SQL 文件，还不能分析真实数据库                   |
| P0  | Finding / Conflict / Unknown engine       | 现在 Agent 只能回答问题，不能主动发现问题                  |
| P0  | Structured Agent result                   | 当前把整个自然语言回答当成 `inferred` Claim，这是最明显的设计问题 |
| P0  | Evaluation + tests + CI                   | 当前没有测试体系，Evidence/lineage 设计无法持续保证正确      |

然后才进入：

```text
V2:
Semantic / Financial Domain / Source-to-Target / Target Architecture

V3:
Migration Wave / Dual Run / Reconciliation / Cutover
```

---

# 二、当前代码最大的问题不是“缺功能”，而是 V1 本身还没有真正闭环

现在的代码路径是：

```text
discover
  ↓
scanner
  ↓
regex lineage
  ↓
file statistics
  ↓
JSON snapshot
  ↓
ask
  ↓
把整个 snapshot 截断到 12000 字符
  ↓
LLM
  ↓
把整段回答保存为一个 inferred Claim
```

主要问题有 6 个。

### 1. `src/analysis/lineage.ts`

现在是：

```ts
const FROM_JOIN = /.../;
const CREATE_AS = /.../;
```

这个对于：

```sql
WITH a AS (...)
SELECT ...
FROM ...
```

已经不可靠。

对于你要支持的 legacy：

```text
Oracle
SQL Server
Snowflake
Teradata
Postgres
Databricks
```

更不能继续靠 regex。

**应该现在就换 AST parser，不要等 V2。**

---

### 2. `src/analysis/profiling.ts`

现在叫 profiling，实际只是：

```text
文件行数
文件大小
引用表数量
```

这其实不是 Data Profiling。

真正需要的是：

```text
row count
null %
distinct %
min/max
sample
key candidate
duplicate rate
freshness
distribution
```

否则 Agent 所谓的：

> “Position 是不是 source of truth？”

没有足够证据。

---

### 3. `src/cli.ts`

这里有一个明显的问题：

```ts
snapshot = raw.length > 12000
  ? raw.slice(0, 12000) + '\n...[truncated]'
  : raw;
```

这意味着：

> Agent 看到的不是 Investigation 的完整事实，而是一个随文本长度变化的随机前缀。

一个大型项目里，后面的 lineage / profiling / unknown 很可能根本没有进入上下文。

应该改成：

```text
Question
 ↓
Evidence Query
 ↓
只取与问题相关的节点 / edge / profile / source
 ↓
Agent
```

而不是：

```text
把整个 JSON 塞给模型
```

---

### 4. `cmdAsk()` 对 Claim 的处理是错的

现在：

```ts
inv.claims.push({
  claim: `Q: ${question}\nA: ${answer}`,
  status: 'inferred',
  evidence: [{
    type: 'documentation',
    document: discoveryPath(name)
  }],
});
```

这实际上等于：

> “LLM 说了什么，都当成一个 inferred claim。”

甚至：

```text
verified
supported
unknown
contradicted
```

都没有真正被结构化保存。

这和 `docs/architecture_0930.md` 设计的 Evidence-first 完全不一致。

必须改。

---

### 5. `src/evidence/types.ts` 还不是一个真正的 Evidence model

现在：

```ts
document: string
file: string
source: string
target: string
```

太粗。

真正需要知道：

```text
是哪一个文件
哪一行
哪个 SQL statement
哪个 parser
哪个 discovery run
哪个 source hash
什么时候发现
```

否则以后文件修改以后，你根本不知道这个 Evidence 还是否成立。

---

### 6. 当前 Investigation 没有“Finding”

现在只有：

```text
claims
unknowns
```

但 modernization 最重要的其实不是问答，而是：

```text
Finding
```

例如：

```text
Potential multiple sources of truth for Position

Candidates:
IBOR_POSITION
PORTFOLIO_POSITION
LEGACY_POSITION

Evidence:
...

Impact:
...

Status:
supported

Decision required:
...
```

这个应该成为一等对象。

---

# 三、建议直接这样改目录

现在不要一下子扩成几十个模块。

先把结构改成：

```text
src/
├── agent/
│   ├── copilot.ts
│   ├── prompts.ts
│   └── result.ts
│
├── evidence/
│   ├── types.ts
│   └── index.ts
│
├── investigation/
│   └── store.ts
│
├── discovery/
│   ├── scanner.ts
│   ├── inventory.ts
│   └── database.ts
│
├── analysis/
│   ├── lineage.ts
│   ├── profiling.ts
│   ├── findings.ts
│   └── reconciliation.ts
│
├── model/
│   └── estate.ts
│
├── adapters/
│   ├── database.ts
│   └── filesystem.ts
│
└── cli.ts
```

注意：

**现在不创建：**

```text
agent/analyst.ts
agent/architect.ts
migration/
semantic/
domain/
target/
waves/
```

这些等 V2。

---

# 四、P0：重做 Evidence Model

文件：

```text
src/evidence/types.ts
```

改成至少支持：

```ts
export type ClaimStatus =
  | 'verified'
  | 'supported'
  | 'inferred'
  | 'unknown'
  | 'contradicted';

export type EvidenceType =
  | 'source_file'
  | 'sql_statement'
  | 'lineage'
  | 'metadata'
  | 'profiling'
  | 'query_result'
  | 'documentation'
  | 'runtime';

export interface EvidenceRef {
  id: string;

  type: EvidenceType;

  investigationId: string;
  discoveryRunId: string;

  source: string;

  file?: string;
  lineStart?: number;
  lineEnd?: number;

  statement?: string;

  dataset?: string;
  column?: string;

  value?: unknown;

  sourceHash?: string;

  collectedAt: string;
}
```

然后：

```ts
export interface Claim {
  id: string;
  claim: string;
  status: ClaimStatus;
  evidenceIds: string[];
}
```

不要把完整 Evidence 嵌进去：

```json
{
  "claim": "...",
  "evidence": [...]
}
```

而要：

```json
{
  "claim": "...",
  "evidenceIds": [
    "ev-001",
    "ev-017"
  ]
}
```

这样以后：

```text
Claim
 ↘
 Evidence
 ↘
 Lineage
 ↘
 Source
```

可以共享。

---

# 五、增加 Finding 对象

仍然放：

```text
src/evidence/types.ts
```

先不要再建一大套 `finding/`。

```ts
export type FindingSeverity =
  | 'info'
  | 'low'
  | 'medium'
  | 'high';

export interface Finding {
  id: string;
  type: string;
  title: string;
  description: string;

  severity: FindingSeverity;

  status: ClaimStatus;

  evidenceIds: string[];

  affectedAssets: string[];

  questions?: string[];

  createdAt: string;
}
```

第一批 Finding 类型就做这几个：

```text
multiple_sources_of_truth
duplicate_transformation
identifier_fragmentation
missing_lineage
semantic_conflict
possible_stale_documentation
data_quality_issue
temporal_risk
```

这 8 个足够。

---

# 六、增加 Discovery Run

`src/investigation/store.ts`

现在 Investigation 只有：

```ts
claims
unknowns
```

增加：

```ts
export interface DiscoveryRun {
  id: string;
  root: string;
  startedAt: string;
  completedAt: string;

  parserVersion: string;

  filesScanned: number;
  datasetsFound: number;
  lineageEdgesFound: number;
}
```

Investigation 改成：

```ts
export interface Investigation {
  name: string;
  goal: string;
  scope: string[];
  systems: string[];

  questions: string[];

  discoveryRuns: DiscoveryRun[];

  evidence: EvidenceRef[];
  claims: Claim[];
  findings: Finding[];

  unknowns: string[];

  updatedAt: string;
}
```

以后每次：

```bash
npm run discover -- demo ...
```

不是覆盖：

```text
discovery.json
```

而是：

```text
run-001
run-002
run-003
```

这样你以后才能比较：

```text
Discovery Run 1
vs
Discovery Run 2
```

---

# 七、P0：`scanner.ts` 增加 source fingerprint

文件：

```text
src/discovery/scanner.ts
```

现在只有：

```ts
path
kind
sizeBytes
```

增加：

```ts
sha256
modifiedAt
lineCount
```

例如：

```ts
export interface SourceFile {
  path: string;
  kind: 'sql' | 'python' | 'doc' | 'yaml' | 'json' | 'other';

  sizeBytes: number;
  lineCount: number;

  modifiedAt: string;
  sha256: string;
}
```

原因很简单。

以后 Evidence：

```text
source: x.sql
line: 37
hash: abc123
```

才可以证明：

> 当时 Agent 分析的到底是哪一个版本。

这对 modernization 极其重要。

---

# 八、P0：`lineage.ts` 必须彻底换掉 regex

这是当前最应该动的一处。

文件：

```text
src/analysis/lineage.ts
```

不要继续扩展：

```ts
FROM_JOIN
CREATE_AS
INSERT_INTO
```

应该改成：

```ts
export interface ParsedStatement {
  id: string;

  file: string;

  statementIndex: number;

  target?: string;

  sources: string[];

  columns?: ColumnLineage[];

  dialect?: string;
}
```

然后：

```ts
export interface ColumnLineage {
  sourceDataset: string;
  sourceColumn: string;

  targetDataset: string;
  targetColumn: string;

  expression?: string;

  statementId: string;
}
```

---

## 第一版 parser 策略

我建议：

```text
TS Application
      ↓
SQL parser adapter
      ↓
normalized AST
      ↓
lineage extractor
```

不要让整个系统依赖某个 parser。

增加：

```text
src/analysis/sql-parser.ts
```

接口：

```ts
export interface SqlParser {
  parse(
    sql: string,
    dialect?: string,
  ): ParsedStatement[];
}
```

这样以后可以：

```text
SQLGlot
```

作为实现。

目前项目是 TypeScript，可以用一个非常小的 Python bridge 调 SQLGlot，不需要把整个项目改成 Python。

增加：

```text
scripts/sqlglot_parser.py
```

它只负责：

```text
stdin JSON
→ SQLGlot
→ stdout JSON
```

TS：

```text
src/analysis/sql-parser.ts
→ spawn python
→ parse
```

这样以后要换 parser，也只换 adapter。

这是比继续自己写 regex 更值得的工程投入。

SQLGlot 本身已经有 AST、dialect、transpilation 和 lineage 能力，没必要自己重造。

---

# 九、第一版就应该支持 Column Lineage

你原来的架构文档把：

```text
L1 dataset
L2 column
L3 transformation
```

放到 V2。

我建议这里调整。

**Dataset lineage 可以保留 L1；但 column lineage 至少应该加入 V1.1。**

因为：

```text
Position
```

这种问题真正有价值的是：

```text
legacy.pos_qty
      ↓
portfolio_position.position_qty
```

而不是：

```text
legacy_position
      ↓
portfolio_position
```

否则 Agent 无法回答：

> `market_value` 到底来自哪里？

所以：

```text
V1:
dataset lineage

V1.1:
column lineage

V2:
semantic transformation
```

这是最小调整。

---

# 十、P0：建立真正的 Data Estate Graph

新增：

```text
src/model/estate.ts
```

不要上 Neo4j。

第一阶段直接 JSON graph。

定义：

```ts
export type EstateNodeType =
  | 'system'
  | 'database'
  | 'schema'
  | 'dataset'
  | 'column'
  | 'file'
  | 'job'
  | 'report'
  | 'business_concept';

export interface EstateNode {
  id: string;
  type: EstateNodeType;
  name: string;
  attributes: Record<string, unknown>;
}

export type EstateRelationType =
  | 'contains'
  | 'reads_from'
  | 'writes_to'
  | 'derived_from'
  | 'transformed_by'
  | 'consumed_by'
  | 'implements'
  | 'mapped_to'
  | 'defined_by';

export interface EstateEdge {
  id: string;

  from: string;
  to: string;

  type: EstateRelationType;

  evidenceIds: string[];
}
```

然后：

```ts
export interface DataEstate {
  nodes: EstateNode[];
  edges: EstateEdge[];
}
```

Discovery 输出：

```json
{
  "estate": {
    "nodes": [],
    "edges": []
  }
}
```

这样后面：

```text
Source-to-target
Semantic graph
Impact analysis
Finding
Architecture
```

都可以建立在同一个模型上。

---

# 十一、P0：增加 DatabaseAdapter，但只读

新增：

```text
src/adapters/database.ts
```

不要马上实现 10 个数据库。

接口：

```ts
export interface DatabaseAdapter {
  readonly type: string;

  connect(): Promise<void>;
  close(): Promise<void>;

  listDatabases(): Promise<DatabaseInfo[]>;
  listSchemas(database?: string): Promise<SchemaInfo[]>;
  listTables(
    database?: string,
    schema?: string,
  ): Promise<TableInfo[]>;

  getTableMetadata(
    table: string,
  ): Promise<TableMetadata>;

  sample(
    table: string,
    limit: number,
  ): Promise<Record<string, unknown>[]>;

  profile(
    table: string,
    columns?: string[],
  ): Promise<DataProfile>;

  query(
    sql: string,
  ): Promise<QueryResult>;
}
```

**全部只读。**

第一版实际实现：

```text
PostgreSQL
Snowflake
```

因为一个用于本地开发，一个用于实际 enterprise target。

别做：

```text
Oracle
SQL Server
Databricks
BigQuery
Teradata
```

先只留 adapter interface。

---

# 十二、数据库发现流程应该改成这样

当前：

```text
scan files
```

改成：

```text
discover filesystem

可选：

discover database
```

命令：

```bash
npm run discover -- demo ./legacy
```

以及：

```bash
npm run discover-db -- demo snowflake://...
```

但我更建议统一：

```bash
npm run discover -- demo \
  --path ./legacy \
  --database snowflake
```

内部：

```text
Metadata discovery
      ↓
schemas/tables
      ↓
targeted metadata
      ↓
only then profiling
```

---

# 十三、P0：真正实现 Data Profiling

文件：

```text
src/analysis/profiling.ts
```

现在的：

```ts
FileProfile
```

可以删除。

改成：

```ts
export interface ColumnProfile {
  column: string;

  dataType: string;

  nullable: boolean;

  rowCount: number;
  nullCount: number;
  nullRate: number;

  distinctCount: number;
  distinctRate: number;

  min?: string;
  max?: string;

  sampleValues?: unknown[];
}
```

表级：

```ts
export interface DataProfile {
  dataset: string;
  rowCount: number;
  columns: ColumnProfile[];

  profiledAt: string;
}
```

第一版只做：

```text
row count
null %
distinct %
min/max
sample
```

不要做复杂统计学。

---

# 十四、增加“Targeted Query”机制

这是你架构文档里说了，但是当前代码没有实现的。

新增：

```text
src/analysis/query.ts
```

提供：

```ts
export interface QueryPlan {
  reason: string;

  dataset: string;

  sql: string;

  expectedEvidence: string[];
}
```

执行前必须：

```text
Agent 产生 query plan
       ↓
deterministic validation
       ↓
read-only execution
       ↓
evidence
```

这一步以后才能做真正的 Data Analyst。

---

# 十五、P0：加 Findings Engine

新增：

```text
src/analysis/findings.ts
```

先不要让 LLM 自己“发现所有问题”。

先做 deterministic rules。

例如：

```ts
function findMultipleSourcesOfTruth(
  estate: DataEstate,
): Finding[]
```

检查：

```text
同一个 business concept
→ 多个候选 dataset
```

例如：

```text
Position
 ├── IBOR_POSITION
 ├── LEGACY_POSITION
 └── PORTFOLIO_POSITION
```

就产生：

```text
multiple_sources_of_truth
```

---

## 第二个规则

```text
duplicate_transformation
```

发现：

```text
market_value =
quantity × price
```

在两个 SQL 文件重复出现。

---

## 第三个

```text
identifier_fragmentation
```

例如：

```text
security_id
sec_id
ticker
isin
bloomberg_id
```

出现在不同路径。

---

## 第四个

```text
semantic_conflict
```

例如：

```text
mv_amt
market_value
nav_value
```

都指向类似数据，但是定义不同。

---

# 十六、P0：Agent 不应该自己决定 Claim status

文件：

```text
src/agent/result.ts
```

新增。

让模型返回严格 JSON：

```ts
export interface AgentAnswer {
  answer: string;

  claims: Array<{
    claim: string;
    status: ClaimStatus;
    evidenceIds: string[];
  }>;

  unknowns: string[];

  followUpQuestions: string[];
}
```

模型禁止：

```text
自由发挥 Claim
```

系统收到以后：

```text
JSON parse
↓
schema validation
↓
verify evidenceIds actually exist
↓
recalculate status where possible
↓
save
```

非常重要：

**LLM 给出的 `status` 不能完全相信。**

例如模型说：

```json
"status": "verified"
```

但它引用了：

```text
没有任何 evidence
```

系统应该自动降级：

```text
unknown
```

而不是照单全收。

---

# 十七、Evidence 状态应该由系统校正

简单规则：

```text
无 Evidence
→ unknown

只有 LLM inference
→ inferred

有一个 deterministic evidence
→ supported

多个独立 evidence
→ supported

deterministic validation passed
→ verified

互相冲突
→ contradicted
```

这里不要过早设计复杂的 confidence score。

你现在的 5-state 设计可以继续保留。

---

# 十八、P0：`cmdAsk()` 改成 Evidence Retrieval，而不是 snapshot injection

现在：

```ts
const raw = await fs.readFile(...)
snapshot = raw.slice(0, 12000)
```

删除。

换成：

```ts
const context = await buildQuestionContext({
  investigation: inv,
  question,
});
```

新增：

```text
src/analysis/context.ts
```

逻辑：

```text
Question
 ↓
extract entities
 ↓
find related estate nodes
 ↓
find related lineage edges
 ↓
find profiles
 ↓
find findings
 ↓
find relevant documentation
 ↓
build compact context
```

例如问题：

> Where does Position come from?

只取：

```text
Position nodes
upstream lineage
related SQL
related findings
security/identifier metadata
```

而不是整个项目。

---

# 十九、P0：增加 Evidence Pack

现在 `report` 太简单。

增加：

```text
src/analysis/report.ts
```

生成：

```text
.data/investigations/<name>/
├── inventory.json
├── estate.json
├── lineage.json
├── profiles.json
├── findings.json
├── claims.json
├── unknowns.json
└── report.md
```

不要继续一个：

```text
demo.discovery.json
```

把所有东西塞进去。

---

# 二十、Current-State Report 至少增加这 6 部分

现在只有：

```text
Goal
Files
Lineage
Claims
Unknowns
```

改成：

```text
# Current-State Report

## 1. Scope

## 2. Data Estate

## 3. Dependency / Lineage

## 4. Findings

## 5. Data Quality

## 6. Open Questions

## 7. Evidence-backed Claims

## 8. Coverage / Gaps
```

特别是：

```text
Coverage / Gaps
```

例如：

```text
SQL source coverage: 83%
Database metadata coverage: 61%
Lineage coverage: 74%
Column lineage: 42%

Unknown:
9
```

这比简单说：

```text
analyzed 41 files
```

有用得多。

---

# 二十一、金融场景增加一个非常小的 Review Rule Pack

不要马上做完整 ontology。

新增：

```text
src/analysis/finance-rules.ts
```

做 deterministic checklist。

例如：

```ts
export const investmentChecks = {
  position: [
    'authoritative_source',
    'position_state',
    'as_of_time',
    'security_identifier',
    'corporate_action',
    'fx',
  ],

  security: [
    'canonical_identifier',
    'identifier_mapping',
    'lifecycle',
  ],

  price: [
    'source_precedence',
    'raw_or_adjusted',
    'valuation_date',
    'currency',
    'timezone',
  ],

  research: [
    'publication_time',
    'knowledge_time',
    'restatement',
    'point_in_time',
  ],
};
```

这几个检查可以让 Agent 主动发现：

```text
Price lacks source precedence
```

或者：

```text
Research dataset has no publication-time evidence
```

这就是你和 generic Data Analyst Agent 的第一层区别。

---

# 二十二、不要现在把 FIBO 做成 hard dependency

`finance-rules.ts` 可以先做。

但：

```text
FIBO ontology
```

暂时不要直接加入 runtime model。

等 V2 semantic modeling 再做：

```text
external vocabulary
        ↓
candidate business concept
        ↓
firm concept
```

不要：

```text
FIBO
 ↓
自动生成数据库
```

---

# 二十三、V2：真正开始做 Semantic Graph

V2 新增：

```text
src/model/semantic.ts
```

对象：

```ts
export interface BusinessConcept {
  id: string;
  name: string;

  definition?: string;

  synonyms: string[];

  evidenceIds: string[];

  status: ClaimStatus;
}
```

以及：

```ts
export interface SemanticMapping {
  conceptId: string;

  dataset: string;
  column?: string;

  mappingType:
    | 'exact'
    | 'derived'
    | 'candidate'
    | 'conflict';

  evidenceIds: string[];
}
```

例如：

```text
Business Concept
Market Value
        ↓
portfolio_position.market_value
        ↓
implements
        ↓
quantity × price × fx
```

---

# 二十四、V2：Source-to-Target Mapping

新文件：

```text
src/model/mapping.ts
```

定义：

```ts
export interface SourceTargetMapping {
  id: string;

  source: {
    dataset: string;
    column?: string;
  };

  target: {
    dataset: string;
    column?: string;
  };

  transformation?: string;

  ruleType:
    | 'direct'
    | 'rename'
    | 'derive'
    | 'lookup'
    | 'aggregate'
    | 'split'
    | 'merge';

  validation: ValidationRule[];

  status: ClaimStatus;

  evidenceIds: string[];
}
```

这是 V2 的核心，而不是让 Agent 输出 Markdown table 就结束。

---

# 二十五、V2：Target Architecture

新增：

```text
src/model/architecture.ts
```

不要做一个自由文本：

```text
targetArchitecture: string
```

而是：

```ts
export interface ArchitectureProposal {
  domains: Domain[];
  datasets: DatasetDesign[];
  semanticModels: SemanticModel[];
  integrations: IntegrationDesign[];

  assumptions: string[];

  decisions: ArchitectureDecision[];

  evidenceIds: string[];
}
```

不过这里也不要一步做到完整 enterprise metamodel。

第一版只支持：

```text
domain
dataset
relationship
integration
decision
assumption
```

够了。

---

# 二十六、V3：Migration Waves

到这里才增加：

```text
src/migration/waves.ts
src/migration/validation.ts
```

模型：

```ts
export type MigrationStrategy =
  | 'rehost'
  | 'replatform'
  | 'refactor'
  | 'replace'
  | 'retire'
  | 'retain';
```

Wave：

```ts
export interface MigrationWave {
  id: string;

  assets: string[];

  strategy: MigrationStrategy;

  dependencies: string[];

  prerequisites: string[];

  validationPlan: string[];

  coexistenceRequired: boolean;

  cutoverPlan?: string;

  rollbackPlan?: string;
}
```

这里才进入：

```text
dual run
reconciliation
cutover
rollback
decommission
```

---

# 二十七、我不建议现在实现的东西

目前全部不要加：

```text
❌ Neo4j
❌ vector database
❌ RAG platform
❌ multi-agent swarm
❌ full ontology engine
❌ BPMN/workflow engine
❌ production write tools
❌ 10+ database adapters
❌ UI
❌ autonomous migration execution
❌ Temporal
❌ complex scoring model
```

尤其不要因为前面研究了 DataHub/OpenMetadata/Atlan，就在这个项目里自己造一个 Catalog。

它们应该是未来的 adapter/context source。

---

# 二十八、`package.json` 必须改

目前没有：

```text
test
build
lint
```

加：

```json
{
  "scripts": {
    "init": "tsx src/cli.ts init",
    "discover": "tsx src/cli.ts discover",
    "ask": "tsx src/cli.ts ask",
    "report": "tsx src/cli.ts report",
    "typecheck": "tsc --noEmit",
    "test": "tsx --test",
    "build": "tsc"
  }
}
```

增加：

```text
package-lock.json
```

必须提交。

---

# 二十九、测试现在必须开始建

新增：

```text
tests/
├── lineage.test.ts
├── evidence.test.ts
├── findings.test.ts
├── profiling.test.ts
├── scanner.test.ts
└── fixture/
    └── investment/
```

至少要有：

## lineage

测试：

```text
CREATE VIEW
CTE
JOIN
INSERT
schema.table
quoted identifiers
nested query
multiple statements
```

特别测试：

```sql
WITH p AS (
  SELECT ...
)
SELECT ...
FROM p
JOIN security_price ...
```

当前 regex 很容易错。

---

# 三十、增加 Golden Dataset

新增：

```text
examples/investment/golden/
```

里面不只是 SQL。

建议：

```text
examples/investment/golden/
├── legacy/
│   ├── ibor_position.sql
│   ├── legacy_position.sql
│   ├── price.sql
│   └── valuation.sql
│
├── docs/
│   └── position.md
│
└── expected/
    ├── lineage.json
    ├── findings.json
    └── claims.json
```

这个特别重要。

因为以后换：

```text
GPT-5.x
Claude
Gemini
```

可以直接跑同一套：

```text
estate
→ agent
→ expected
```

而不是靠肉眼觉得“好像更聪明了”。

---

# 三十一、必须新增 Unsupported Claim Rate 测试

`docs/architecture_0930.md` 里已经提出这个指标，这是对的。

增加：

```text
tests/evaluation/
```

以及：

```text
docs/evaluation.md
```

至少测：

```text
lineage precision
lineage recall
column mapping accuracy
finding accuracy
evidence coverage
unsupported claim rate
unknown recall
```

尤其：

```text
Unsupported Claim Rate
```

应该成为这个项目最核心的 Agent 指标之一。

---

# 三十二、`src/agent/copilot.ts` 保持简单，不要大改

这个文件目前的 Copilot SDK 封装整体可以继续用。

暂时不要加入：

```text
multi-agent
MCP
tool registry
session manager
```

只改两处：

### 1. 支持 response format / structured output

如果当前 SDK 能稳定返回结构化 JSON，就使用它。

否则：

```text
自然语言
 ↓
JSON extraction
 ↓
schema validation
```

### 2. 把 `workingDirectory` 固定到 investigation workspace

不要：

```ts
process.cwd()
```

默认作为 Agent 工作目录。

改成：

```text
.data/investigations/<name>/
```

这样未来：

```text
generated artifact
analysis file
temporary query
```

不会散落在项目目录。

---

# 三十三、`src/investigation/store.ts` 需要顺便把 workspace 做出来

增加：

```ts
export function investigationRoot(name: string): string {
  return path.join(config.investigationDir, name);
}
```

目录：

```text
.data/
└── investigations/
    └── portfolio-analytics/
        ├── investigation.json
        ├── discovery/
        ├── evidence/
        ├── artifacts/
        └── reports/
```

比：

```text
demo.json
demo.discovery.json
```

更合理。

---

# 三十四、`src/cli.ts` 要做一次明显的瘦身

现在 `cli.ts` 同时负责：

```text
init
discover
ask
report
prompt
context
file IO
```

这些逻辑已经开始混在一起。

改成：

```text
cmdInit()
cmdDiscover()
cmdAsk()
cmdReport()
```

各自只负责：

```text
parse args
call service
print result
```

新建：

```text
src/workflow/discover.ts
src/workflow/ask.ts
src/workflow/report.ts
```

这里不需要复杂 class。

例如：

```ts
export async function runDiscovery(
  investigation: Investigation,
  target: string,
): Promise<DiscoveryResult>
```

以及：

```ts
export async function answerQuestion(
  investigation: Investigation,
  question: string,
): Promise<AgentAnswer>
```

这样以后 UI / API 复用时不需要调用 CLI。

这是现在很值得做的小型重构。

---

# 三十五、README 要修改

文件：

```text
README.md
```

把现在：

```text
V1:
SQL → Discovery → Inventory → L1 Lineage → AI → Report
```

改成：

```text
V1:
Source
→ Discovery
→ Evidence
→ Estate Graph
→ Dataset / Column Lineage
→ Profiling
→ Findings
→ AI Analysis
→ Current-State Report
```

并明确：

```text
V1:
Current-State only

V2:
Semantic + Source-to-Target + Target Architecture

V3:
Migration Waves + Validation

V4:
Controlled Write / PR / Deployment
```

这样项目边界会清楚很多。

---

# 三十六、`docs/architecture_0930.md` 不需要大改，但应该增加一节“当前实现边界”

建议文件顶部增加：

```md
# 当前实现状态

## V1.0

已实现：
- local file discovery
- investigation state
- dataset lineage skeleton
- Copilot Q&A

尚未达到设计要求：
- SQL AST parsing
- precise evidence provenance
- database metadata discovery
- real data profiling
- findings detection
- structured agent result
- evaluation benchmark

## V1.1

优先完成：
1. Evidence provenance
2. SQL AST / column lineage
3. Data Estate Graph
4. Read-only database adapter
5. targeted profiling
6. findings/conflicts
7. structured Agent result
8. evaluation
```

这比继续在文档里描述一个实际上还没有实现的完整平台更诚实。

---

# 三十七、再加一个 `docs/implementation.md`

这个文件只负责：

```text
当前代码状态
↓
下一步具体实现
↓
为什么
```

不要把大量理论再复制一次。

结构：

```md
# Implementation Roadmap

## V1.1
Evidence / Parser / Graph / Profiling / Findings

## V2
Semantic / Domain / Mapping / Target Architecture

## V3
Migration / Validation / Waves

## V4
Controlled Execution
```

---

# 三十八、最终文件变更清单

## 修改

```text
README.md

package.json

src/cli.ts
src/agent/copilot.ts
src/evidence/types.ts
src/investigation/store.ts
src/discovery/scanner.ts
src/analysis/lineage.ts
src/analysis/profiling.ts

docs/architecture_0930.md
```

## 新增：V1.1

```text
src/agent/prompts.ts
src/agent/result.ts

src/model/estate.ts

src/discovery/inventory.ts
src/discovery/database.ts

src/analysis/sql-parser.ts
src/analysis/context.ts
src/analysis/findings.ts
src/analysis/query.ts
src/analysis/report.ts

src/adapters/database.ts
src/adapters/filesystem.ts

src/analysis/finance-rules.ts

scripts/sqlglot_parser.py

tests/lineage.test.ts
tests/evidence.test.ts
tests/findings.test.ts
tests/profiling.test.ts
tests/scanner.test.ts

examples/investment/golden/...

docs/implementation.md
docs/evaluation.md

.github/workflows/ci.yml

package-lock.json
```

---

# 三十九、V2 再增加这些

```text
src/model/semantic.ts
src/model/mapping.ts
src/model/architecture.ts

tests/semantic.test.ts
tests/mapping.test.ts

examples/investment/target/...
```

实现：

```text
Business Concept
Semantic Mapping
Domain Model
Source-to-Target Mapping
Target Architecture
Architecture Decision
```

---

# 四十、V3 再增加这些

```text
src/migration/waves.ts
src/migration/validation.ts

tests/migration.test.ts

examples/investment/migration/...
```

实现：

```text
7R
Dependency-based waves
Transitional architecture
Dual run
Reconciliation
Cutover
Rollback
Decommission
```

---

# 四十一、最重要的实施顺序

不要按目录顺序写。

应该严格按这个顺序：

```text
1. Evidence model
       ↓
2. Source fingerprint
       ↓
3. SQL AST parser
       ↓
4. Estate Graph
       ↓
5. DB metadata adapter
       ↓
6. Real profiling
       ↓
7. Findings engine
       ↓
8. Structured Agent result
       ↓
9. Evidence retrieval
       ↓
10. Current-State report
       ↓
11. Golden benchmark
       ↓
12. Finance review rules
       ↓
──────── V1.1 complete ────────
       ↓
13. Semantic graph
       ↓
14. Source-to-target mapping
       ↓
15. Target architecture
       ↓
──────── V2 complete ──────────
       ↓
16. Migration waves
       ↓
17. Reconciliation
       ↓
18. Cutover / rollback
```

---

# 四十二、我认为现在最值得立刻修改的 5 个地方

如果还要继续抓大放小，就只做这 5 个：

**第一：`src/analysis/lineage.ts` 立即废掉 regex，换 AST parser。**

**第二：`src/evidence/types.ts` 增加 `EvidenceRef + Finding + sourceHash + line range + discoveryRunId`。**

**第三：`src/cli.ts` 不再把整个 JSON snapshot 截断塞给 LLM，改成按问题检索相关 Evidence。**

**第四：增加 `DatabaseAdapter + profiling`，至少支持 Snowflake / PostgreSQL 的 read-only metadata。**

**第五：增加 deterministic Finding Engine，把 `multiple sources of truth / duplicate logic / identifier fragmentation / semantic conflict / temporal risk` 做出来。**

这 5 个完成以后，这个项目才真正开始从：

```text
Copilot + SQL files
```

变成：

```text
Evidence-backed Data Architecture Investigator
```

然后再做 Semantic / Source-to-Target / Target Architecture，就顺理成章了。
