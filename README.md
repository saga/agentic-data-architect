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

Agent 在每一关负责调查和推理；Workflow / Journey 提供当前导航位置和确定性通关条件，但不替 Agent 决定唯一下一步。具体调查方法由 Skill 提供，SQL、Lineage、Profiling、Structural Analysis、GitHub、Confluence、Web Search 等由工具执行。

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

路线不是 Investigation 类型，而是 Agent 可以采用的 playbook。自主调查时没有固定 Journey；调查过程中可以改变工作方式，但这不是首页上的普通下拉选择，而是在“调查配置 → 工作方式”里经过明确确认后执行。已有消息、Discovery、Evidence、Findings 和 workspace 都会保留；旧的动态路线建议会被清除并重新规划。选择路线只约束高层阶段和 Gate，具体调查仍由 Agent 根据证据决定。

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
Agent    → 理解证据、选择调查动作、生成动态路线和下一步建议
Skill    → 这一关具体怎么查
Tool     → 真正执行 SQL / profiling / lineage / search
Human    → 确认业务定义、范围和例外
~~~

## Modernization Work Products

工作台的核心交付物不是聊天记录，而是：

~~~text
Analysis Case
Target Architecture
Source-to-Target Mapping
Architecture Decision
Modernization Plan
~~~

Agent 可以协助生成和修改这些对象；重要结论继续通过 Evidence / Claim / Human Review 固化。

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
