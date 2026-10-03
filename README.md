# agentic-data-architect

面向 **Data Analyst + Data Architect 的 AI 数据架构工作台**。当前提供三套可选工作路线：改造已有系统、从零设计金融 AI / 数据架构、评估现有数据架构。

它不是一个单纯的 Chat，而是围绕 Data Architect 工作产物运行：理解现状、做数据分析、确认业务语义、设计 Target Architecture、完成 Source-to-Target Mapping / Architecture Assessment，并为后续验证留下 Evidence。

核心不是“聊天”，而是围绕三类工作路线推进调查、评估和设计；其中已有系统改造路线带有有状态的 Journey：

~~~text
接到任务
  → 看清旧系统
  → 找到数据真相
  → 查关键问题
  → 定下现状
  → 设计新方案
  → 新旧对应
  → 验证结果
  → 切换
~~~

Agent 在每一关负责调查和推理；Workflow / Journey 提供当前导航位置、分支和通关规则；用户也可以在当前 Investigation 中编辑这张工作地图。具体调查方法由 Skill 提供，SQL、Lineage、Profiling、Structural Analysis、GitHub、Confluence、Web Search 等由工具执行。

## 总体架构

~~~mermaid
flowchart LR
    U[Data Analyst / Data Architect] --> W[Investigation Workbench]
    W --> D[Discovery]
    D --> M[Canonical Metadata]
    D --> E[Evidence]
    D --> L[Lineage]
    D --> P[Profiling]
    D --> C[Current-State Intelligence]
    M --> C
    E --> C
    L --> C
    P --> C
    C --> S[Business / Semantic Context]
    S --> T[Target Architecture]
    T --> X[Source-to-Target Mapping]
    X --> V[Validation & Reconciliation]
    U <--> C
    U <--> S
    U <--> T
    U <--> X
    U <--> V
~~~

Semantic Context 是 provider-neutral 的。Snowflake Semantic View、Data Product、dbt Semantic Layer、企业 Data Catalog、BI 定义和业务文档都可以成为输入；核心模型不依赖某一家平台。

## 主 Flow

~~~mermaid
sequenceDiagram
    autonumber
    participant User as Architect / Analyst
    participant UI as Workbench
    participant WF as Investigation Workflow
    participant Disc as Discovery
    participant Meta as Canonical Metadata
    participant Ev as Evidence
    participant Agent as AI Agent
    participant Sem as Semantic Context
    participant Review as Human Review

    User->>UI: 创建项目 / 提出问题
    UI->>WF: 开始 Investigation
    WF->>Disc: 按 Journey 当前关卡执行发现
    Disc->>Meta: 生成资产、Job、Dataset、Column
    Disc->>Ev: 保存证据与 provenance
    Disc->>Meta: 生成 lineage / profiling / coverage
    Meta->>WF: Current-State Intelligence

    User->>UI: 查看 data flow / data model / findings
    UI->>Agent: 提问 legacy 数据是怎么产生的
    Agent->>Meta: 检索资产和上下游
    Agent->>Ev: 检索证据
    Agent->>Sem: 使用已有 semantic / business context
    Agent-->>UI: 事实、未知项、当前关卡、下一步

    User->>Review: 确认或修正业务含义
    Review-->>WF: 人工确认
    WF->>Sem: 保存确认后的 business context

    User->>Agent: 设计 target architecture
    Agent-->>UI: 提出方案与 trade-offs
    User->>Review: 审核方案
    Review-->>WF: 接受 / 修改 / 否决
    WF->>UI: 输出 current-state + target-state work products
~~~

## 快速开始

Python 依赖由 `pyproject.toml` 管理，运行环境由 `uv` 创建和同步；不要再直接执行 `pip install -r requirements*.txt`。首次运行或依赖变化后执行：

~~~bash
npm install
uv sync
npm run start
~~~

需要更新依赖锁文件时执行：

~~~bash
uv lock
~~~

浏览器打开：

~~~text
http://127.0.0.1:3000
~~~

开发模式：

~~~bash
npm run dev
~~~

## Data Architect 工作路线

新建工作默认采用自主调查，不要求选择 Workflow：

~~~text
New Investigation
  → 目标 / 问题
  → 默认：自主调查
  → 可选：采用一套工作路线
~~~

当前提供三套可选的工作路线：

~~~text
改造已有系统
  → Legacy Modernization Workflow

从零设计金融 AI / 数据架构
  → Financial AI-Native Architecture Workflow

评估现有数据架构
  → Data Architecture Assessment Workflow
~~~

路线不是 Investigation 类型，而是一份可执行的 playbook。内置路线来自 Skill；用户可以在当前 Investigation 中复制为自定义 Workflow，验证通过后再应用。自主调查时没有固定 Journey；调查过程中可以改变工作方式，但这不是首页上的普通下拉选择，而是在“调查配置 → 工作方式”里经过明确确认后执行。已有消息、Discovery、Evidence、Findings 和 workspace 都会保留；旧的动态路线会被清除并重新生成。具体调查仍由 Agent 根据证据决定。

从零建设金融 Portfolio Research Agent 的路线定义在：

~~~text
skills/financial-ai-native-architecture/SKILL.md
~~~

典型路线：

~~~text
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
~~~

该路线直接覆盖 LangChain / DeepAgents、LangSmith、Snowflake Semantic View、金融数据模型和 Portfolio Research 场景。

## 工作地图编辑器

Workflow 现在不是只读的路线图。打开“编辑工作地图”后，可以拖动节点、添加步骤、增加分支、修改分支目标和 outcome、删除节点，并通过右侧“属性 / AI”两个 Tab 修改节点定义或让 AI 提出修改。编辑器会自动使用 ELK 重新排版，并为步骤保留明显的节点间距；React Flow 完成节点实际尺寸测量后会再做一次最终布局，并增加碰撞保护，避免节点重叠。多个分支使用独立连接点，尽量避免线路和标签互相覆盖。新建节点会用橙色虚线框明显标出。查看模式与编辑模式显示同一张完整 Workflow 图，只是查看模式锁定所有编辑操作。断开连接的步骤会直接用红框标出。

编辑采用：

~~~text
当前画布
  → 服务端验证
  → 保存为新的 Workflow version
  → 尽量保留当前执行位置
  → Agent 下一轮按修改后的 Workflow 执行
~~~

编辑阶段不会单独持久化 draft 文件；只有点击“保存”后，当前 Definition、画布布局和执行状态才会写入 Investigation 的 workflow/ 目录。

内置 Skill 的 SKILL.md 不会被直接改写。自定义 Workflow 保存在当前 Investigation 的 workflow/ 目录，并把 Markdown DSL、画布布局和执行状态分开保存。

Workflow DSL 新增 completion：

~~~text
completion: deterministic
completion: agent
~~~

有 completeWhen 的旧节点默认按 deterministic 处理；没有 completeWhen 的旧节点默认由 Agent 根据实际 outcome 推进。Workflow 的分支仍然使用简单的：

~~~text
- success -> next
- needs-input -> intake
- retry -> investigate
~~~

服务端会检查悬空目标、重复 outcome、不可达节点、死路、无法到达终点的环以及非法 completeWhen。验证通过后才允许保存。AI 修改会先显示 Patch 预览，应用到当前画布后仍需点击“保存”。新建节点可以直接拖动右侧连接点到已有步骤，也可以在“属性” Tab 的“连接到现有步骤”中选择目标和 outcome。

完整设计见：

[docs/journey-workflow-editor.md](docs/journey-workflow-editor.md)

## Data Architecture Assessment Workflow

路线定义在：

~~~text
skills/data-architecture-assessment/SKILL.md
~~~

典型路线：

~~~text
明确评估目标
  → 查清当前架构
  → 找出主要问题
  → 给出改进建议
  → 排出实施顺序
~~~

评估结果保存到当前 Investigation 的 `reports/architecture-assessment.json`。问题和建议必须回到当前 Investigation 的 Evidence；通用架构经验只作为方法参考。

## Legacy Modernization Workflow

路线定义在：

~~~text
skills/legacy-modernization/SKILL.md
~~~

它使用轻量 Markdown Workflow：

~~~text
@flow
@task
@gate
@end
@stop
~~~

这条路线不是一条不能回头的流程图。发现新的 lineage、业务定义或数据质量问题时，可以回到前面的调查关卡；只有 Current-State、Mapping、Validation 等确定性状态满足条件，路线才会推进。

Workflow 和 Skill 分工如下：

~~~text
Workflow → 提供高层导航骨架和确定性通关条件
Journey  → 把当前 Workflow 变成当前可见位置
Agent    → 理解证据、执行用户选择的下一步、必要时给出少量下一步候选
Skill    → 这一关具体怎么查
Tool     → 真正执行 SQL / profiling / lineage / search
Human    → 确认业务定义、范围和例外
~~~

## Modernization Work Products

这些对象是最终工作产物，不是发现几个表以后自动填出来的模板：

~~~text
Analysis Case
Target Architecture
Source-to-Target Mapping
Architecture Decision
Modernization Plan
~~~

当前规则：

- Target Architecture 在证据和业务范围还不清楚时只保留空白草稿，不自动拼一套通用组件。
- Source-to-Target Mapping 只有在真实 source、target、转换规则和证据都明确后才创建；不会把“看起来像对应关系”当成 Mapping。
- Architecture Decision 只有在确实出现需要选择的架构问题时才创建，并保留候选方案、依据、取舍和人工决定。
- `npm run modernize` 仍会生成一个工作包文件，但里面未确认的对象保持为空，避免把模板误当成结果。

## Current-State Intelligence

V1.2 先把“现有系统到底是什么”整理清楚：

~~~text
Source
  → Asset / Job / Dataset / Column
  → Static Lineage
  → Profiling
  → Parse / Discovery Coverage
  → Source-of-Truth Candidates
  → Semantic Candidates
  → Business / Semantic Context
~~~

候选只是结构化分析结果，不代表已经确认的业务事实。

## Local Data Workbench

本地数据分析现在直接集成到 Investigation：

~~~text
SQLite
  → 应用状态、对话、数据集登记和分析记录

DuckDB
  → 当前 Investigation 的本地分析

Parquet
  → 大数据和分析中间结果

CSV / JSON / JSONL
  → 原始输入
~~~

Agent 会自动发现当前 workspace 中的 CSV、JSON、JSONL、Parquet 文件，并通过 local_catalog、local_describe、local_sample、local_profile、local_query 完成结构查看、抽样、profiling 和只读 SQL 分析。

上传 CSV / JSON / JSONL / Parquet 后会自动进入 Dataset Registry。文件变化会产生新的 dataset version，分析结果会保存为 Evidence，因此后续回答可以回溯到具体数据文件和 SHA-256。
## Structural Analysis

当前增加了一个独立的 structural-analysis capability，底层使用 [Graphify](https://github.com/Graphify-Labs/graphify) 把当前 Investigation working directory 中的代码和 SQL 建成可查询的结构图。

它主要帮助 Agent 快速回答：

~~~text
“这些模块 / 表 / SQL / 文件在结构上怎么连接？”
“从 A 到 B 中间有哪些依赖？”
“这个 legacy 系统哪些节点最关键？”
~~~

Graphify 是平台级 structural-analysis capability，通过 MCP 注入当前 Copilot Session；第一次调查时由 Skill 运行本地、确定性的结构扫描。当前 Control version 会固定 Graphify capability version，turn audit 记录实际 package version、MCP command 和 graph SHA-256。Graphify 的结果只用于缩小调查范围和发现关系候选，不自动进入 Evidence，也不能把业务事实提升为 supported / verified。目录 Discovery 同时为源文件建立 `source_file` Evidence，Agent 定位文件后仍必须回到本项目的 metadata、SQL lineage、profiling、targeted query 和 Semantic Context。

## Semantic Context

核心层只认识通用 Semantic Asset：

~~~text
semantic_view
data_product
catalog_term
metric
verified_query
dashboard
~~~

Snowflake Semantic View 可以由 Snowflake adapter 发现；Data Product、Catalog、dbt、BI 和其他语义来源可以通过同一抽象接入，不需要修改核心 Agent workflow。

## Skills

Skill 仍然统一以一个 SKILL.md 目录作为打包单位，但运行语义只分两类：

~~~text
capability
  一个明确能力，Agent 自己决定什么时候用、怎么和其它能力组合。
  例如：search-confluence、search-github、financial-data-review。

workflow
  一条有明确阶段、顺序、Gate 和完成条件的工作路线。
  例如：legacy-modernization、financial-ai-native-architecture、data-architecture-assessment。
~~~

每个 Skill 的 frontmatter 都要声明 metadata.kind：

~~~yaml
metadata:
  kind: capability
~~~

或：

~~~yaml
metadata:
  kind: workflow
~~~

复杂程度不是分类标准。一个 capability 即使内部有多个查询或脚本，只要 Agent 仍然可以自由组合，就保持 capability；只有需要 Workflow / Journey 约束阶段、顺序和完成条件时，才是 workflow。

代码层面，src/skills/catalog.ts 统一解析和校验 Skill manifest；src/workflow/journey.ts 只接受 kind: workflow 的 Skill；flow:lint 同时检查 Skill metadata 和 Markdown Workflow。

当前 Skill：

~~~text
capability: investigation-session / financial-data-review / structural-analysis / search-github / search-confluence / search-leanix / working-directory
workflow: legacy-modernization / financial-ai-native-architecture / data-architecture-assessment
~~~
## 进一步说明

详细运行、API、Workspace、Skill、CLI、环境变量和实现资料见：

[docs/readme-reference.md](docs/readme-reference.md)

V1.2 Current-State Intelligence 的数据模型和设计见：

[docs/current-state-intelligence.md](docs/current-state-intelligence.md)



## 架构知识

项目内的 `knowledge/` 保存可复用的 Data Architect 实践经验，并标明来源、资料时间、复核时间和可信度。知识只指导“怎么做”，不替代当前 Investigation 的 Evidence。
