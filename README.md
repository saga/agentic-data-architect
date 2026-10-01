# agentic-data-architect

面向 **Data Analyst + Data Architect 的 Legacy Modernization / Replatform AI 工作台**。

它不是一个单纯的 Chat，而是围绕 modernization 工作产物运行：理解现状、做数据分析、确认业务语义、设计 Target Architecture、完成 Source-to-Target Mapping，并为迁移和验证留下 Evidence。

核心不是“聊天”，而是：

~~~text
Legacy Project
  → Discovery
  → Current-State Intelligence
  → Analyst Investigation
  → Business / Semantic Context
  → Target Architecture
  → Source-to-Target Mapping
  → Gap Analysis
  → Migration / Validation
~~~

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
    WF->>Disc: 扫描代码、数据库、ETL、文档
    Disc->>Meta: 生成资产、Job、Dataset、Column
    Disc->>Ev: 保存证据与 provenance
    Disc->>Meta: 生成 lineage / profiling / coverage
    Meta->>WF: Current-State Intelligence

    User->>UI: 查看 data flow / data model / findings
    UI->>Agent: 提问 legacy 数据是怎么产生的
    Agent->>Meta: 检索资产和上下游
    Agent->>Ev: 检索证据
    Agent->>Sem: 使用已有 semantic / business context
    Agent-->>UI: 事实、推断、未知项、下一步

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
~~~

安全、Evidence 校验、只读查询、Lineage、Profiling 和状态持久化仍由代码负责。

## 进一步说明

详细运行、API、Workspace、Skill、CLI、环境变量和实现资料见：

[docs/readme-reference.md](docs/readme-reference.md)

V1.2 Current-State Intelligence 的数据模型和设计见：

[docs/current-state-intelligence.md](docs/current-state-intelligence.md)
