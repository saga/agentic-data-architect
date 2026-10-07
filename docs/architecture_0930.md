# 当前实现状态（V1.7）

已实现：SQLGlot AST 解析（dataset + column lineage）、精确证据定位
（文件+行号+hash+discovery run）、Data Estate Graph、只读 DB adapter
（PostgreSQL/Snowflake）、真实 profiling、domain-agnostic deterministic findings、
Skill-driven financial review、结构化 Agent 结果（含状态校正）、按问题检索证据、golden benchmark + CI。

V1.1 优先完成（本节是对照清单，做完即勾）：
1. Evidence provenance ✓ 2. SQL AST / column lineage ✓ 3. Estate Graph ✓
4. 只读 database adapter ✓ 5. targeted profiling ✓ 6. findings/conflicts ✓
7. 结构化 Agent 结果 ✓ 8. evaluation ✓  9. Current-State Intelligence ✓

V1.2 增加 Current-State Intelligence：canonical asset types、parse coverage、source-of-truth candidates、semantic candidates，以及 provider-neutral Semantic Context。

V1.3 开始把项目从 Current-State Discovery 扩展成 Legacy Modernization Workbench：增加 Analysis Case、Target Architecture、Source-to-Target Mapping、Architecture Decision、Gap Analysis 和 Modernization Plan。它们先作为轻量、可验证的工作产物存在，不引入重量级 workflow engine。生成这些对象时不预填未经调查的架构决定、Mapping 或目标组件；真实工作产物必须由证据和明确的业务/架构判断形成。

V1.4 增加 Structural Analysis：Graphify 作为平台级 structural-analysis capability 运行，平台能力配置随 Control version 固定并进入 audit；Graphify graph.json 记录运行时 hash/version，source_file Evidence 把 Graphify 的结构导航结果重新接回本 Investigation 的 deterministic provenance。Graphify 不直接产生 Claim Evidence，supported 仍要求独立来源。

V1.5 把 Investigation 的导航交互从右侧步骤列表提升为真正的工作导航：主对话区显示 Agent 根据最近一次行动、Evidence、Unknowns 生成的 0～3 个可选下一步；用户点击后发送结构化 routeId，由服务端重新校验当前候选。工作地图使用 AntV X6 展示 Workflow 主线；地图可以只读查看，也可以进入编辑模式修改当前 Investigation 的 Workflow。

后续再逐步增加更细的 Data Analysis / Reconciliation / Migration Waves / Dual Run / Cutover。


## 2026-10-03：本项目明确采用“个人本机 Agent”模型

这里的默认部署方式是**单人、本机使用的个人生产力工具**。用户给出目标后，Copilot 应自己判断下一步要查什么、需要哪些工具、是否需要某个 Skill；用户不应该在每次 Investigation 开始前先配置一套“Agent 能力清单”。

运行时边界固定为：

```text
平台固定规则
  ↓
本次 Investigation 的研究范围
  ↓
可选的“本次调查说明”
  ↓
Copilot 默认 Agent
  ├─ 自带工具 / 自带 Skill / 自带 MCP
  ├─ skills/*/SKILL.md → Agent 按任务自动发现 capability Skill
  └─ 当前 Workflow Skill → 用户明确选择后预加载
  ↓
Evidence / State / Findings
```

因此：

- capability Skill 是“随时可以用的能力”，不进入 `control.json`，也不提供“已启用技能”选择器。
- Workflow Skill 是“用户选择的工作路线”。它继续由 Investigation 的 `workflow` 状态决定，并可以在当前路线下预加载。
- “本次调查说明”是用户对本轮调查增加的补充要求。它会作为追加系统指令发送给 Copilot，但不能覆盖平台固定规则。
- MCP 分成两类：Copilot CLI 自带 MCP 不需要用户配置；用户主动接入的额外 MCP 才进入 Investigation Control。
- 由于这是本机单用户模型，Copilot SDK 使用 `mode: "copilot-cli"`。以后若改成多人共享服务，必须重新采用 `mode: "empty"` 和显式的工具 / MCP / Skill / workspace allowlist。

这个决定也意味着：**配置页是“调整这次调查的输入”，不是“手工组装一个 Agent”**。
## V1.6 Local Data Workbench：SQLite + DuckDB + Parquet

V1.6 开始把本地轻量数据库真正作为 Agent 工作台的一部分，但不把 SQLite 和 DuckDB 混成一个万能数据库。

职责固定为：

~~~text
context.json
  = 当前 Investigation 业务状态的 canonical source

SQLite
  = 应用级持久化：对话 / Dataset Registry / Analysis Run metadata

DuckDB
  = 每个 Investigation 的本地分析引擎

Parquet
  = 大型分析数据和可移植中间格式

Filesystem
  = 原始输入和用户可直接打开的工作产物
~~~

### 1. 每个 Investigation 一个分析数据库

本地分析数据放在：

~~~text
.workspace/<investigation>/
  ├── local.duckdb
  ├── uploads/
  ├── reports/
  └── artifacts/
~~~

local.duckdb 只服务当前 Investigation。不会把所有 Investigation 共用一份 DuckDB 写库，也不会把 DuckDB 当作整个 App 的 application-state source。Investigation 的业务状态仍以 context.json 为准。

DuckDB 内部固定创建四个轻量 schema：

~~~text
raw       原始文件对应的只读 view
analysis  可继续复用的分析结果
semantic  本次 Investigation 临时形成的业务语义结果
scratch   Agent 的临时实验
~~~

当前阶段自动建立 schema 和 raw views；analysis、semantic、scratch 是后续本地分析产物的固定落点，不再为此增加第二套数据库抽象。

### 2. Dataset Registry 放在现有 SQLite

项目已经有本地 SQLite conversation store，因此 V1.6 不再新建第三个元数据库，而是在同一个 SQLite 文件中增加 local_datasets 和 local_analysis_runs。

local_datasets 保存：

~~~text
dataset id / Investigation / 文件相对路径 / 格式
DuckDB relation / version / SHA-256 / 文件更新时间 / 大小
~~~

文件变化时 version 递增。分析 Evidence 绑定 dataset version + SHA-256。

local_analysis_runs 保存分析操作、dataset id、SQL、SQL hash、行数、耗时和 Evidence id，用来回看这次分析到底做了什么。

### 3. Agent 不直接操作 DuckDB

Agent 使用六个本地数据工具：

~~~text
local_catalog
local_register_dataset
local_describe
local_sample
local_profile
local_query
local_transform
local_export_parquet
~~~

通常按 local_catalog → local_describe → local_sample / local_profile → local_query 的顺序调查；需要沉淀结果时再用 local_transform 或 local_export_parquet。

工具层会限制路径和 SQL。Agent 不能通过 local_query 使用 ATTACH、COPY、INSTALL、LOAD、文件读取函数、HTTP、SQLite/PostgreSQL scanner，也不能执行多条 SQL。

### 4. 原始数据和分析数据不重复复制

CSV、JSON、JSONL、Parquet 首次进入 Registry 后，在 DuckDB 中建立 raw view，而不是强制把整个文件 COPY 进 DuckDB。

因此大 Parquet 可以直接被 DuckDB 分析，小文件也保持简单。Parquet 是后续本地分析中间结果的首选格式；很大的结果不要转换成 JSON 再送给 Agent。

### 5. Evidence provenance

本地分析继续使用 Evidence-first：

~~~text
Local Dataset Version
        ↓
DuckDB Analysis Run
        ↓
Evidence
        ↓
Claim / Finding
~~~

describe、sample、profile、query 都记录对应 Evidence。Evidence 包含 dataset id、version、SHA-256、SQL 或 operation、有限结果样本和 analysis run id。

这样 Agent 能引用真实数据结果，而不会把自己的解释冒充成数据事实。

### 6. 为什么不把 DuckDB MCP 作为核心路径

当前项目已经拥有 Dataset Registry、read-only SQL guard、Evidence provenance 和 Investigation workspace boundary，因此默认让 Agent 使用 local_* 工具。

通用 DuckDB MCP 可以保留为实验能力，但不要成为默认路径；否则 Agent 很容易绕过这里已经建立的数据集边界和 Evidence 记录。

### 7. 与外部数据库的边界

PostgreSQL / Snowflake 继续由 adapters 负责发现外部真实状态。DuckDB 负责把本地数据变成可快速分析、比较和转换的 analytical staging layer。

推荐的数据流：

~~~text
PostgreSQL / Snowflake
        ↓
      Adapter
        ↓
metadata / selected data
        ↓
   Local Dataset
        ↓
      DuckDB
        ↓
     analysis
        ↓
     Evidence
~~~

### 8. 当前阶段刻意不做的事情

V1.6 不做统一 SQL abstraction framework、复杂 Repository / Unit of Work、多进程共享 DuckDB writer、完整 ETL scheduler、向量数据库、Lakehouse catalog 或云端同步。

下一阶段再考虑 Dataset Version → Parquet snapshot、分析结果 → reusable local dataset、semantic/* → local semantic model，以及把现有 conversations.db 最终统一成 app.sqlite。


### Structural Analysis 控制边界

```text
Control version
  ├─ user-configurable investigation guidance / custom MCP
  └─ platform capability: graphify-structural-analysis
        ↓
Graphify MCP
        ↓ 只做结构导航
文件 / SQL / metadata
        ↓
deterministic Evidence
        ↓
Claim
```

Graphify 是平台能力，不由单个 Investigation 的 Skill/MCP 配置关闭。Skill `structural-analysis` 只负责告诉 Agent 何时以及如何使用该能力；真正的 Graphify executable、版本和 graph hash 在 turn audit 中记录。
详见 `docs/implementation.md`，指标见 `docs/evaluation.md`。
数据流、控制流、turn 生命周期和并发模型见 `docs/data-control-flow.md`。

---
## Data Architect 工作路线

当前有四条明确的 Data Architect 工作路线：

1. **Legacy Modernization**
   - 适用于已有系统改造、replatform、迁移和切换。
2. **Financial AI-Native Architecture**
   - 适用于从零设计金融服务 AI / 数据平台，例如 Portfolio Research Agent。
3. **Data Architecture Assessment**
   - 适用于评估已有数据架构：查清当前情况、主要问题、改进建议和实施顺序。
4. **Current Data Architecture**
   - 适用于只看清现有系统的数据来源、数据流、数据模型和关键转换。

四条路线都写在对应 Skill 的 Markdown Workflow 中。区别只是业务工作方法不同：

~~~text
Legacy Modernization
  接到任务
    → 看清旧系统
    → 找到数据真相
    → 查关键问题
    → 定下现状
    → 设计新方案
    → 新旧对应
    → 验证
    → 切换

Financial AI-Native Architecture
  明确业务目标
    → 明确业务需求
    → 查数据
    → 定义金融业务模型
    → 设计数据架构
    → 设计业务语义
    → 设计 Agent
    → 设计安全和运行控制
    → 设计验证和评估
    → 形成实施路线

Data Architecture Assessment
  明确评估目标
    → 查清当前架构
    → 找出主要问题
    → 给出改进建议
    → 排出实施顺序
~~~

四条 Workflow 都只固定“大阶段”。Workflow 更像导航地图，而不是唯一道路：Agent 在阶段内部自由调查、使用工具和反复验证；必要时给出 0～3 个下一步候选。用户点击候选后，前端发送结构化 routeId，服务端从当前候选中解析并执行；也可以完全忽略候选，直接输入自己的问题。

当前 UI 不提供首页上的普通 Workflow 下拉切换。工作方式属于 Investigation 的重要持久化状态：只有在“调查配置 → 工作方式”的明确调整区选择目标、输入确认语句后才执行切换。这样可以保持工作方式灵活，但避免一次误点击就改变本次调查的导航语义。

Financial AI-Native Architecture 的 Skill 重点覆盖：

- Portfolio Research / Investment Analytics 业务范围
- Security / Position / Price / FX / Corporate Action / Benchmark 等金融数据
- Snowflake 数据层和 Semantic View
- LangChain / DeepAgents / Skills / Tools
- LangSmith tracing / evaluation
- point-in-time research、Evidence 和 deterministic validation

不要把四条 Workflow 再抽象成新的 Workflow Registry、Journey Registry 或通用 orchestration engine。

## Data Architecture Assessment Workflow

Data Architecture Assessment 用于回答“现在这套数据架构怎么样、哪里有问题、先改什么”，不直接替代迁移方案，也不等于从零设计目标平台。

路线定义在：

```text
skills/data-architecture-assessment/SKILL.md
```

当前路线：

```text
明确评估目标
  → 查清当前架构
  → 找出主要问题
  → 给出改进建议
  → 排出实施顺序
```

运行时位于 `src/workflow/assessment.ts`。它复用已有 Current-State、Finding、Gap Analysis 和 Evidence，不重新做一套 discovery engine；生成的评估结果保存为 `reports/architecture-assessment.json`。

右侧工作区只保留紧凑 Journey 导引和当前事实；下一步候选直接出现在最近一条 Agent 回答下面。需要查看或编辑完整路线时打开全屏 X6 工作地图。

## Legacy Modernization Workflow

Legacy Modernization 不再只是一次性生成 Modernization Plan，而是由一个 Markdown Workflow 定义可选的固定高层路线；只有 Investigation 选择这套 playbook 时才启用 Journey：

```text
接到任务
  → 看清旧系统
  → 找到数据真相
  → 查关键问题
  → 定下现状
  → 设计新方案
  → 新旧对应
  → 验证结果
  → 切换
```

Workflow 定义位于 `skills/legacy-modernization/SKILL.md`，使用轻量的 `@flow / @task / @review / @end` 语法。节点只有 title、objective、actor、completeWhen；连线只有 outcome -> target。Execution 保存真正的当前节点和完成状态；用户可以在工作地图中创建自定义 Workflow，并由服务端验证后应用。仍不引入完整的审批/命令执行引擎。

边界：

- Workflow：提供高层地图、阶段和典型回退路径。
- 下一步候选：由 Agent 根据当前问题、Evidence、Unknowns 和用户动作临时生成，是本轮可选调查动作；用户点击后通过 routeId 结构化选择，不直接修改 Workflow。
- Skill：说明这一关具体怎么调查。
- Tool：执行 SQL、profiling、lineage、GitHub、Confluence、Web Search 等动作。
- Agent：根据当前证据决定具体调查动作，并解释结果。
- 人：确认业务定义、范围和不能自动判断的例外。

Legacy Modernization Workflow 的确定性关卡不依赖 Agent 自评。空白/草案 Target Architecture、未经证据支持的 Mapping 和未确认的 Architecture Decision 都不会被当成真实工作产物；deterministic 节点只根据当前 Investigation 状态推进；data-truth / investigation / current-state-ready 只在关键 discovery、lineage、source-of-truth 缺口消失后才推进，而需要判断的 agent 节点必须返回当前节点实际存在的 outcome，服务端才会推进。

右侧工作区继续展示当前地图相关信息，下一步候选显示在最近一条 Agent 回答下面。全屏工作地图现在就是 Workflow 编辑器：用户可以拖动节点、添加步骤、增加分支、修改 outcome/目标、删除节点或分支。编辑结果只留在当前画布；服务端验证通过后，点击“保存”才创建新的 Workflow version，并尽量保留当前执行位置；只有当前节点被删除时才回到新 Workflow 的 start。

## Agent Runtime

当前 Investigation 支持三种 Agent Runtime：

1. **Copilot SDK**：通过 GitHub Copilot SDK 执行。
2. **CodeBuddy SDK**：通过 `@tencent-ai/agent-sdk` 程序化执行。
3. **OpenCode Run**：通过官方 `opencode run` headless CLI 执行；正式 Investigation execution 不直接调用 `opencode serve`，serve 只用于本机模型发现等辅助能力。

Runtime 与 Model 分开保存。新建 Investigation 时可以指定首选 Runtime；quota / usage exhaustion 发生时，只在本次执行内从当前 Runtime 向后按全局配置 `AGENT_RUNTIME_FALLBACK_ORDER` 自动尝试，成功后不修改 Investigation 的首选 Runtime，也不需要用户确认。

Capability Skill 的 discovery 也保持统一边界：Copilot 使用 SDK 的 `skillDirectories`；CodeBuddy / OpenCode 在当前 Investigation workspace 的 `.agents/skills` 中获得全部 capability 和当前 Workflow Skill，其它 Workflow Skill 不进入当前 Runtime 的 Skill catalog。

默认顺序是：

~~~text
Copilot SDK → CodeBuddy SDK → OpenCode Run
~~~

CodeBuddy 默认模型和可见模型由 `CODEBUDDY_DEFAULT_MODEL` / `CODEBUDDY_MODEL_ALLOWLIST` 配置，不写死在 Workflow 或 UI。CodeBuddy SDK 默认处于隔离环境，因此本项目显式传入 cwd、MCP、权限策略和任务 prompt，不依赖工作仓库中的 CodeBuddy 配置。

## Agent Trajectory / 执行轨迹

Investigation 现在持久化 Agent 执行轨迹到 `.workspace/<session>/trajectory.jsonl`。

轨迹只记录可展示、可审查的运行事件，不保存模型隐式思维链正文：

```text
用户问题
  ↓
Agent turn
  ├─ intent
  ├─ model call / usage
  ├─ tool call
  ├─ tool result
  ├─ permission
  ├─ context compaction
  └─ final turn
```

UI 通过独立的 `/investigations/:name/trajectory` 页面查看完整调查轨迹，展示 Token、模型、工具调用、上下文占用以及 Copilot SDK 的 AI credit / Premium Request Cost。

成本口径遵循 Copilot SDK：`assistant.usage` 是单次模型调用的 token 与 Premium Request Cost multiplier；`session.usage.getMetrics` 是整个 session 累计 AI credit 与 token。这里的 cost 不是货币金额。SDK 还提供 per-model usage breakdown，因此后续可以按模型拆分成本。

这套 UI 结构参考 LangSmith 的 trace tree / token-cost breakdown，以及 DeepSeek 的“模型 → tool call → tool result → 后续模型调用”执行链；不展示 reasoning / chain-of-thought 正文。

## Investigation Configuration Page / 配置页

调查配置已经从 Modal 改为独立路由：

```text
/investigations/:name/config
```

配置页包含：

- 研究范围
- 技能与指导
- MCP
- 工作方式
- 版本历史

“本次调查说明”可以补充本次 Investigation 的背景、关注点和输出要求；它只是追加到平台系统指令后的用户说明。Capability Skill 由 Copilot 自动发现，不再保存到本次 Investigation 的 Control。MCP 只配置用户主动添加的额外服务；Copilot 自带 MCP 不需要在这里重复配置。

工作方式属于危险操作：目标路线可以选择，但只有明确输入确认语句后才真正切换。

## Memory / Rule / State 边界

当前代码检查发现三类逻辑值得进一步公共化，但职责必须分开：

### Memory

`agentic-data-architect` 已经把 transcript、Investigation state、discovery/artifacts 和 Agent session 分开保存；但目前没有独立的 application-owned archive summary 和统一 cursor pagination。

这不是“没有保存历史”，而是“还没有把长期历史整理成稳定的 Agent Memory 层”。完整 transcript 应永久保留；Archive 只是对旧记录的压缩导航，不能替代原始记录。

`@saga/agent-memory` 已定义 MemoryRecord、MemoryArchive、MemoryStore、分页以及 working-memory window / archive candidate contract。

### Rule

当前 deterministic 判断主要散落在：

- `src/analysis/findings.ts`：Finding 规则和数据质量阈值。
- `src/analysis/gap.ts`：Current-State / Finding → Gap / Recommendation。
- `src/workflow/journey.ts`：`completeWhen` → Journey 状态。
- `src/workflow/modernization.ts` / `src/workflow/assessment.ts`：Validation readiness 和评估阶段完成条件。

这些都属于“facts → deterministic result”，适合由声明式 Rule Engine 承载条件和优先级；复杂的数据扫描算法仍然保留在代码里。

`@saga/agent-rules` 已提供最小的声明式规则评估器。`recommendationForFinding` 如果重新引入，应实现成应用规则配置，而不是散落在 `if/else` 或 prompt 中。

### State

`@saga/markdown-workflow` 本身已经是 Workflow 层状态运行时；不需要再造第二套 Workflow Engine。

但底层已经有多处稳定的状态转移：Conversation turn 的 `running → completed/failed/aborted`、Investigation turn 的 `executing → committing`、以及 Workflow 的 `node + outcome → next node`。

`@saga/agent-state-machine` 提供最小 state / event / transition 原语。后续可以逐步让 `markdown-workflow` 和 turn lifecycle 复用这个底层能力，但不应把业务状态、权限或副作用塞进公共状态机。
## Skill / Core / Agent 边界

当前架构明确把容易变化的业务知识从核心 workflow 中拿出来：

~~~text
Core Platform
  ├─ Evidence / State
  ├─ SQL Read-only Guard
  ├─ Lineage / Profiling
  ├─ Claim validation
  ├─ Curated Architecture Knowledge
  └─ Copilot SDK integration
          │
          └── skillDirectories → skills/*/SKILL.md
                                  ├─ investigation-session
                                  ├─ financial-data-review
                                  ├─ structural-analysis
                                  ├─ search-github
                                  ├─ search-confluence
                                  ├─ search-leanix
                                  └─ working-directory

Skill
  └─ scripts/   deterministic domain procedure
~~~

金融领域的 Position、Security、Price、Research 检查不再硬编码在 discovery workflow；由 `financial-data-review` Skill 按需驱动脚本执行。这样新增其它行业/业务领域时，不需要改核心 Agent workflow。

平台安全边界仍然由代码负责：Skill 不能绕过 Evidence 校验、read-only SQL guard 或状态持久化规则。
## 当前交互与 Workspace

V1.1 现在的主入口是 Web Investigation Workbench：

```text
Browser
   ↓
Express 5 API
   ↓
Investigation / Evidence / Copilot
   ↓
SQLite conversation history + .workspace/<session>/context.json
```

浏览器中的 session 可以持续切换和恢复；用户可以在同一个 session 中连续补充上下文、提问、提供资料和纠正方向。

UI 使用 Ant Design + Ant Design X；XMarkdown 负责 Markdown、代码、公式和 Mermaid 展示。

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

.workspace/<session-name>/context.json 是当前 Investigation 的状态入口，只保存调查状态，不保存多轮聊天正文。`.workspace/conversations.db` 保存 user / assistant / system 消息，并使用 FTS5 做全文检索。跨 session 可以复用的研究资料统一放在 `.workspace/shared/`，例如 Confluence 页面保存在 `.workspace/shared/confluence/`，并登记到 `.workspace/shared/index.json`。

Agent 不把整个聊天历史重新塞进每轮 prompt；当前实现只按问题从 FTS5 检索少量相关历史消息，作为补充上下文。

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

# Skill 类型与 Workflow 边界

Skill 统一用 SKILL.md 打包，但运行语义只保留两类：

```text
capability
  一个明确能力，提供给 Agent 在相关任务中随时使用。
  Copilot 根据 prompt 和 Skill description 自动判断是否需要加载。
  例如：search-confluence、search-github、financial-data-review。

workflow
  一条有明确阶段、顺序、Gate 和完成条件的工作路线。
  用户明确选择工作方式后，由当前 Investigation 预加载。
  例如：legacy-modernization、financial-ai-native-architecture、data-architecture-assessment。
```

类型写在 frontmatter 的 metadata.kind。只有需要 Journey 约束阶段、顺序和完成条件时，才使用 workflow。

- `src/skills/catalog.ts`：统一解析并用 Zod 校验 Skill manifest。
- `src/workflow/journey.ts`：只允许 kind: workflow 的 Skill 进入 Journey。
- `src/workflow/lint.ts`：所有 Skill 都必须有合法 kind，capability 不得定义 @flow。
- Copilot SDK：通过 `skillDirectories` 暴露 Skill 目录；capability 不由本项目手工做一层启用名单。

# 二十九、Agent 与 Skill 的边界

当前实现不是 multi-agent swarm，也没有单独的 `lead-data-agent` custom agent。

运行时只有一个 Investigation 主 Agent：

```text
Investigation
      │
      ▼
Copilot SDK default agent
      │
      ├── platform system rules
      ├── research configuration
      ├── investigation-specific guidance
      ├── capability Skills（Copilot 按任务自动发现）
      ├── current Workflow Skill（用户选择后唯一保持可用）
      └── Copilot 内置 MCP + 用户配置的额外 MCP
```

## Agent

Agent 是运行时角色，不是用户需要维护的一套业务能力包。

当前主 Agent 负责：

```text
planning
reasoning
questions
synthesis
communication
architecture decisions
```

这些平台级规则不放进某一个 Skill，也不要求用户配置。

## Skill

Skill 是平级、可复用的能力模块；capability 不按 Investigation 手工启用：

```text
skills/
  investigation-session/
  financial-data-review/
  search-github/
  search-confluence/
  search-leanix/
  working-directory/
```

每个 Skill 通过 `SKILL.md` 描述能力；需要确定性计算时，可以带 `scripts/`。

一次 Investigation 的 `control.json` 不保存 capability Skill 清单。Copilot 会看到技能目录及其描述，并在任务相关时加载对应 SKILL.md；只有当前 Workflow 作为用户明确选择的工作方式保持唯一可用；普通 capability 仍由 Copilot 自动发现。

## 为什么现在不使用 Custom Agent

Copilot SDK 的 Custom Agent 适合真正存在不同 Agent 角色时，例如：

```text
Data Architect Agent
Security Reviewer Agent
Financial Domain Agent
```

当前项目只有一个主推理角色，因此再包一层 `lead-data-agent` 只会增加配置和 UI 概念，没有增加实际能力。

以后真的需要多个 Agent 时，再引入 Custom Agent；届时每个 Agent 可以拥有自己的 prompt、model、tools、MCP 和 Skill 集合。

## Deterministic engine

确定性能力仍然独立于 Agent：

```text
SQL parser
profiler
lineage
query engine
findings
validation
report
```

Agent 负责理解和综合这些结果，不能把它们的确定性约束改成 prompt 中的“建议”。

---

# 三十、当前 Repository 边界

当前代码已经形成下面这套实际边界，不再需要 `planner.ts / analyst.ts / architect.ts / reviewer.ts` 这种预先拆开的多 Agent 目录：

```text
agentic-data-architect/
├── src/
│   ├── agent/
│   │   ├── copilot.ts       # Copilot SDK runtime integration
│   │   ├── prompts.ts       # platform-level investigation rules
│   │   └── result.ts        # structured result parsing / claim validation
│   ├── analysis/
│   │   ├── context.ts       # question-scoped evidence retrieval
│   │   ├── findings.ts
│   │   ├── lineage.ts
│   │   ├── profiling.ts
│   │   ├── query.ts
│   │   ├── report.ts
│   │   └── sql-parser.ts
│   ├── discovery/
│   ├── investigation/
│   │   ├── control.ts       # research / skills / guidance / MCP / versions
│   │   ├── conversation.ts  # SQLite messages + durable turns
│   │   ├── store.ts         # Investigation state
│   │   └── workspace.ts     # filesystem / workspace persistence
│   ├── workflow/
│   │   ├── ask.ts
│   │   ├── discover.ts
│   │   └── report.ts
│   ├── adapters/
│   ├── evidence/
│   ├── model/
│   └── server.ts
├── skills/
│   └── <skill>/SKILL.md
├── tests/
└── web/
    └── src/App.tsx
```

这套结构的核心边界是：

```text
Workflow
   ↓
Investigation state / Evidence
   ↓
Copilot default agent
   ↓
Auto-discovered Skills + MCP
   ↓
Structured result
   ↓
Evidence / claims / findings
```

不要为了“Agent 架构完整”再拆出一层假的 Agent 类。

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
.workspace/<session-name>/
  context.json
  transcript.md
  discovery/
  reports/
  artifacts/
~~~

## context.json 是当前 Investigation 状态的入口

context.json 是当前 Investigation 状态的 canonical persistence boundary，至少记录：

- 用户最初 prompt
- 每次新的 input / question / research query
- 重要事实、约束和决定
- 长研究结果对应的 artifactPath

它是当前 Investigation 的规范化业务状态入口；对话正文由 conversations.db 保存，Evidence 仍按 Evidence Catalog 的 schema 管理。

## 企业研究来源的优先级

### GitHub

代码研究开始时由用户选择：

1. 直接 GitHub Tool：通过 repository URL/API 读取，适合公司 GitHub Organization 和小范围检查。
2. 大仓库研究由当前 Investigation 的 GitHub research 能力纳入 workspace，再用本地 find / grep / rg / git 做大范围、跨文件、反复分析。

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


## 可复用架构知识

项目增加了一个独立的 `knowledge/` 层，用来保存从外部资料整理出来的 Data Architect 实践经验。

它和 Evidence 的边界很重要：

```text
knowledge/                       .workspace/<session>/
通用方法和经验                    当前项目真正查到的事实
来源、时间、可信度                 Evidence / Finding / 用户确认
用于决定“下一步怎么查”             用于证明“当前系统是什么”
不能证明当前项目事实               是当前项目结论的依据
```

知识条目记录 `publishedAt`、`reviewedAt`、`sourceConfidence`、`knowledgeConfidence` 和 `timeSensitivity`，并带有 inputs / outputs / checks / cautions。Agent 每轮按 workflow 和问题用轻量确定性检索挑选少量知识；知识只进入方法参考区，不进入 Evidence。

第一批知识覆盖：业务目标、Current-State、Target/Transition、数据模型与业务语义、集成方式、治理/质量/lineage、Architecture Review、Data Product，以及金融场景的 lineage 和 source authority。

## V1.7 Journey Workflow Editor：工作地图成为真正的可执行 Workflow

V1.7 修正了一个之前架构上的不一致：工作地图展示的分支，之前并不是实际状态机的一部分；Workflow runtime 仍主要依赖节点数组顺序。

当前链路：

~~~text
Skill Markdown
    ↓
Journey Definition
    ↓
X6 Workflow Editor
    ↓
Investigation Workflow Draft
    ↓
Server-side Validation
    ↓
Active Workflow Version
    ↓
Workflow Execution
    ↓
Agent Turn
~~~

核心边界保持很小：

- Skill 中的内置 SKILL.md 不被 UI 直接修改。
- 用户修改当前 Investigation 时，创建 Investigation 级自定义 Workflow。X6 只编辑这份 Investigation 草稿，不修改内置 Skill。
- Markdown 保存流程语义，X6 canvas layout 单独保存，execution 单独保存。
- 保存前必须经过服务端 Schema、Graph 和 Runtime 语义验证。
- Agent 只能从当前节点选择已经存在的 outcome，不能自己发明 Workflow 分支。
- Workflow version 改变后清除 Agent session，避免继续使用旧的流程上下文。

### V1.7 Workflow DSL 收敛

这一版不是继续增加 DSL，而是把最近验证后没有独立运行价值的字段删掉。

当前正式语法：

~~~text
@flow
@task
@review
@end

start -> intake
- success -> inspect
- failed -> review
- retry -> intake
~~~

节点字段只有：

- title
- objective
- actor
- completeWhen

其中 `@review` 默认由人工处理；有 `completeWhen` 的节点由宿主事实判断后自动推进，没有 `completeWhen` 的节点由 Agent/人工选择真实 outcome。

明确不放进 DSL：`completion`、`visible`、`tools`、`requires/produces`、route condition、`@gate`、`@stop` 和 `system actor`。这些字段要么属于 UI，要么属于宿主业务规则，要么没有独立运行语义。

### V1.7 Workflow Execution

当前执行状态包含 workflowId、workflowVersion、currentNodeId、completedNodeIds 和 status。

deterministic 节点由已有 Investigation 状态自动推进；agent 节点只有在 Agent 返回合法 nodeId + outcome 后才推进。人工节点进入 waiting，由用户选择已有 outcome 推进。

因此：

~~~text
Agent 可以选择现有分支
Human 可以推进 waiting 节点
Agent 不能修改流程控制边界
服务端决定是否真的推进
~~~

### V1.7 Editor API

早期设计曾把编辑过程拆成 draft / validate / apply 多个接口。V1.8 收敛后，当前实际 API 只有：

~~~text
GET  /api/sessions/:name/journey
GET  /api/sessions/:name/workflow
PUT  /api/sessions/:name/workflow
POST /api/sessions/:name/workflow/ai
POST /api/sessions/:name/workflow/transition
POST /api/sessions/:name/workflow/reset
~~~

普通 Investigation Agent 使用的 `/workflow/instruction` 仍存在，但它只负责把当前 Workflow 控制摘要接到 Agent 请求链路，不属于编辑器 API。

### V1.7 存储边界

V1.8 去掉了单独的 draft 文件。当前 Investigation：

~~~text
<workspace>/<name>/workflow/
  journey.md
  journey-meta.json
  journey-layout.json
  journey-execution.json
  journey-run-events.jsonl
~~~

编辑时的 Definition 只存在当前浏览器画布内；点击保存后才写入上述 Workflow 文件，并创建新的 Workflow version。

这样 Workflow、Canvas、Execution 和运行事件分别可读、可恢复、可校验，也不需要额外引入 Workflow Registry。

完整设计见 docs/journey-workflow-editor.md。

### V1.7 Editor 交互

- 完整 Workflow graph 统一由 AntV X6 绘制；Port 只承担连接，不把 outcome 文案常驻画在画布上。
- 节点、Edge 和属性修改都先作用于当前画布，再统一转换回 Workflow Definition。
- 右侧栏使用 Ant Design Tabs，在“属性”和“AI”之间切换；属性面板显示当前节点或当前 Edge 的真实语义。
- retry 保留为真实 Workflow Edge，视觉上使用灰色虚线外侧回线，不创建 Group、隐藏节点或第二套控制结构。
- 服务端保存前检查 start、route target、重复 outcome、不可达节点以及无法到达 @end 的循环。

自动排版使用项目自己的 workflow-v2：

- 主流程默认纵向向下。
- 同层分支横向展开。
- retry 回线不参与正常向下的 rank，而是走画布外侧 return lane。
- 最后做一次简单的节点碰撞保护，不引入通用布局服务。

X6 负责 Graph 编辑、Port、Edge、Selection、Snapline 和 MiniMap；Workflow runtime 不依赖 X6。

### V1.8 Journey Map 前端重构

Journey Map 现在把图引擎与 Workflow 业务状态彻底分开，X6 不进入 Workflow DSL。

当前边界：

~~~text
JourneyMap
  → 页面组合 / X6 画布

JourneyX6Graph
  → X6 Graph / Port / Edge / Selection / Snapline / MiniMap

JourneyX6Node
  → React 节点卡片

useJourneyWorkflowEditor
  → 编辑状态 / Undo / Graph mutation / Draft Apply / Save

journey-map-graph
  → Workflow Definition ↔ engine-neutral Graph / 连接问题诊断

journey-map-layout
  → workflow-v2 主流程阅读顺序 / S 型主线 / 分支和回线布局

JourneyMapInspector
  → node / edge property editing
~~~

自动排版现在是：

~~~text
Workflow Definition
        ↓
engine-neutral Graph
        ↓
workflow-v2 domain layout
        ↓
主流程纵向 + 分支左右展开 + retry 外侧回线
        ↓
X6 Node / Port / Edge
~~~

X6 不在画布上常驻显示 outcome 文案。选中 Edge 后，右侧属性面板显示真实 outcome、来源和目标；success / failed / retry 的颜色和线型只是视觉提示。

布局请求使用递增 token 丢弃过期结果，避免快速连续编辑时旧布局覆盖新布局。