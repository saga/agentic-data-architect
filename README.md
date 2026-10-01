# agentic-data-architect

面向 **Data Analyst + Data Architect 的 AI 数据架构工作台**。当前包含 Legacy Modernization 和从零建设金融 AI / 数据架构两类固定工作路线。

它不是一个单纯的 Chat，而是围绕 modernization 工作产物运行：理解现状、做数据分析、确认业务语义、设计 Target Architecture、完成 Source-to-Target Mapping，并为迁移和验证留下 Evidence。

核心不是“聊天”，而是一条有状态的 Legacy Modernization Journey：

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

Agent 在每一关负责调查和推理；Workflow 决定当前在哪一关、什么时候可以进入下一关，以及发现新问题后回到哪里。具体调查方法由 Skill 提供，SQL、Lineage、Profiling、GitHub、Confluence、Web Search 等由工具执行。

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

~~~bash
npm install
python3 -m pip install -r requirements-dev.txt
npm run start
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

新建工作时可以选择：

~~~text
改造已有系统
  → Legacy Modernization Workflow

从零设计金融 AI / 数据架构
  → Financial AI-Native Architecture Workflow
~~~

两条路线都只固定 Data Architect 的大阶段。每一关里面怎么调查、调用哪些工具、是否回到前一关，由 Agent 根据证据决定。

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
Workflow → 现在做什么、什么时候能过、失败回哪里
Skill    → 这一关具体怎么查
Tool     → 真正执行 SQL / profiling / lineage / search
Agent    → 理解证据、选择调查动作、解释结果
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

主 Agent 使用 Copilot SDK default agent。领域方法通过 Skill 提供：

~~~text
skills/
  investigation-session/
  financial-data-review/
  search-github/
  search-confluence/
  search-leanix/
  legacy-modernization/
~~~

legacy-modernization 同时承载 Modernization Journey 的路线定义。安全、Evidence 校验、只读查询、Lineage、Profiling 和状态持久化仍由代码负责。

## 进一步说明

详细运行、API、Workspace、Skill、CLI、环境变量和实现资料见：

[docs/readme-reference.md](docs/readme-reference.md)

V1.2 Current-State Intelligence 的数据模型和设计见：

[docs/current-state-intelligence.md](docs/current-state-intelligence.md)
