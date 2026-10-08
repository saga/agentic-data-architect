# agentic-data-architect

面向 **Data Analyst + Data Architect 的 AI 数据架构工作台**。当前提供四条正式工作路线：改造已有系统、分析当前数据架构、从零设计金融 AI / 数据架构、评估数据架构；另外提供可自由组合的数据分析能力。

它不是一个单纯的 Chat，而是围绕 Data Architect 工作产物运行：理解现状、做数据分析、确认业务语义、设计 Target Architecture、完成 Source-to-Target Mapping / Architecture Assessment，并为后续验证留下 Evidence。

核心不是“聊天”，而是先确认这次为什么做、最后要拿到什么，再围绕这些结果推进调查、评估和设计。Workflow 只是实现任务的路线，Skill 是可组合的能力；任何一个局部问题都不能替代 Mission。已有系统改造路线带有有状态的 Journey：

~~~text
确认任务目的和期望结果
  → 看清旧系统
  → 找到数据真相
  → 梳理当前架构
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

## 本机 OpenCode / 本地模型

工作台同时支持三种 Agent Runtime：Copilot SDK、CodeBuddy SDK 和 OpenCode Run。OpenCode 的 `opencode serve` 只用于读取本机已经配置的 provider / model 并显示在“模型”菜单里；正式 Investigation execution 使用 `opencode run`。

启动本机 OpenCode：

~~~bash
opencode serve
~~~

默认监听 `127.0.0.1:4096`。如需其它地址，在项目环境变量中配置：

~~~bash
OPENCODE_ENABLED=true
OPENCODE_BASE_URL=http://127.0.0.1:4096
~~~

`npm run dev` / `npm run start` 会在启动前自动检查：该地址已有 serve 就直接复用，
没有就按下面这套环境拉起一个新的（日志在 `.workspace/opencode-serve.log`）。
Muse Spark 这类需要出站代理的模型，代理地址配在这里（默认值即本机 10809）：

~~~bash
OPENCODE_HTTP_PROXY=http://127.0.0.1:10809
OPENCODE_HTTPS_PROXY=http://127.0.0.1:10809
OPENCODE_ALL_PROXY=socks5://127.0.0.1:10809
~~~

完整排障手册（400 / 401 / 代理 / 白名单踩坑记录）：`docs/opencode.md`。

模型太多时可以用白名单收敛下拉框（逗号分隔，大小写不敏感，匹配模型 id 或显示名；为空 = 全部列出）：

~~~bash
OPENCODE_MODEL_ALLOWLIST=opencode:opencode/muse-spark-1.3-contributor-free
~~~

OpenCode 默认本机服务不需要工作台保存任何模型厂商 Secret。OpenCode 自己负责 provider、模型、工具、MCP 和认证配置；例如 Ollama 等本地模型应在 OpenCode 中配置完成，工作台不会复制一套 provider 配置。

如果你自己给 `opencode serve` 开了 Basic Auth，工作台可复用 OpenCode 官方的本地服务环境变量：

~~~bash
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=...
~~~

这只是工作台连接本机 OpenCode Server 的认证，不是 Anthropic/OpenAI/Ollama 等模型厂商的 API Secret。

主对话区选择本机模型后，模型值形如：

~~~text
opencode:ollama/<model>
opencode:openai/<model>
~~~

这里的模型选择按 Investigation 保存，下一轮执行即可切换。OpenCode 当前 provider/model 列表来自本机 `opencode serve`；正式模型执行使用 `opencode run` headless CLI，工作台只负责传入任务上下文、接收结构化运行事件和保存 Investigation 结果。

注意：OpenCode 是独立 Runtime，它的工具、MCP 和权限由 OpenCode 本身管理；本项目仍负责 Mission、Evidence、Stage Gate 和 Investigation 结果持久化。

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
  → 确认“为什么做”
  → 确认“最后要拿到什么”
  → 拆出主要交付物
  → 默认：自主调查
  → 可选：采用一套工作路线

如果目标里直接给了 GitHub repository，工作台会先把仓库放进当前 Investigation 的研究目录并自动运行一次 Discovery。后续 Agent 按问题类型继续调查：精确文本/文件/Git 操作用 grep、view、find 等常规工具；调用链、依赖、上下游和结构路径优先使用 Code Structure Index，再回到源码核对；关键源码关系可以登记为 code Evidence。
~~~

当前提供四套可选的工作路线：

~~~text
改造已有系统
  → Legacy Modernization Workflow

分析当前数据架构
  → Current Data Architecture Workflow

从零设计金融 AI / 数据架构
  → Financial AI-Native Architecture Workflow

评估数据架构
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

Workflow 现在不是只读的路线图。打开“编辑工作地图”后，可以拖动节点、添加步骤、增加分支、修改分支目标和 outcome、删除节点，并通过右侧“属性 / AI”两个 Tab 修改节点定义或让 AI 提出修改。编辑器使用 X6 Agent Flow 风格的方向性 Port 和轻量节点；自动排版采用 workflow-v1，主流程纵向向下、分支向左右展开，避免所有步骤挤成一条线。多个分支使用不同方向的连接点，成功线绿色、失败线红色。新建节点会用橙色虚线框明显标出。查看模式与编辑模式显示同一张完整 Workflow 图，只是查看模式锁定所有编辑操作。断开连接的步骤会直接用红框标出。

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

Workflow DSL 保持最小语义：有 `completeWhen` 的步骤由已有事实自动推进；没有 `completeWhen` 的步骤由 Agent / 人工选择 Workflow 中真实存在的 outcome。分支只描述结果和目标，例如：

~~~text
- success -> next
- failed -> review
- retry -> investigate
~~~

服务端会检查悬空目标、重复 outcome、不可达节点、死路、无法到达终点的环以及非法 completeWhen。验证通过后才允许保存。AI 修改会先显示 Patch 预览，应用到当前画布后仍需点击“保存”。新建节点可以直接拖动右侧连接点到已有步骤，也可以在“属性” Tab 的“连接到现有步骤”中选择目标和 outcome。

完整设计见：

[docs/journey-workflow-editor.md](docs/journey-workflow-editor.md)

## Current Data Architecture 与 Data Architecture Assessment

“分析当前数据架构”只负责把现状讲清楚：数据从哪里来、经过什么处理、最后到哪里。它不负责打分或提出改造方案。

“评估数据架构”是在这些现状事实之上判断哪里有问题、为什么有问题、先改什么。

### Current Data Architecture Workflow

路线定义在：

~~~text
skills/current-data-architecture/SKILL.md
~~~

这条路线只关注当前事实：数据来源、数据流、核心数据对象、关键转换和未确认事项。

### Data Architecture Assessment Workflow

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
@review
@end
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

Agent 会自动发现当前 workspace 中的 CSV、JSON、JSONL、Parquet 文件，并通过 `local_catalog`、`local_register_dataset`、`local_describe`、`local_sample`、`local_profile`、`local_transform`、`local_export_parquet`、`local_explain`、`local_reconcile`、`local_query` 完成登记、结构查看、抽样、profiling、只读 SQL 分析、分析表生成、Parquet 导出、执行计划和对账。

上传 CSV / JSON / JSONL / Parquet 后会自动进入 Dataset Registry。文件变化会产生新的 dataset version，分析结果会保存为 Evidence，因此后续回答可以回溯到具体数据文件和 SHA-256。
## Structural Analysis

当前提供一个独立的 structural-analysis capability，底层使用项目自己的 Code Structure Index 对当前 Investigation working directory 的 TS/JS 建立可查询的结构索引。

它主要帮助 Agent 快速回答：

~~~text
“这些模块 / 表 / SQL / 文件在结构上怎么连接？”
“从 A 到 B 中间有哪些依赖？”
“这个 legacy 系统哪些节点最关键？”
~~~

Code Structure Index 按语言选择确定性解析器：TS/JS 使用 TypeScript compiler API；Java、Python、C# 使用 Microsoft VS Code 的 `@vscode/tree-sitter-wasm` 预构建 WASM grammar。统一提供 find、callers、callees、trace 等最小结构查询。它只用于缩小调查范围和发现关系候选，不自动进入 Evidence，也不能把业务事实提升为 supported / verified。Agent 定位源码后仍必须回到本项目的 metadata、SQL lineage、profiling、targeted query 和 Semantic Context。

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
  例如：legacy-modernization、current-data-architecture、financial-ai-native-architecture、data-architecture-assessment。
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
workflow: current-data-architecture / legacy-modernization / financial-ai-native-architecture / data-architecture-assessment
capability: investigation-session / financial-data-review / structural-analysis / search-github / search-confluence / search-leanix / working-directory / domain-modeling / research / grilling / ...
~~~
## Investigation 输出

每次完整 Investigation 至少形成一份 `reports/report.md`。报告先讲结论和已经查清楚的事实，再写不能确认的地方和下一步；调查过程中形成的分析记录、研究文件和数据分析结果可以保留为多个 `artifacts/` 文件，不要求全部塞进一份结果 JSON。

Skill 的 `SKILL.md` 还必须明确写出输入校验、输出、输出验证、Gate 和期望结果示例；`npm run flow:lint` 会检查这些基础结构，具体业务 Gate 仍由对应 Workflow、Skill、脚本或工具负责。

## 进一步说明

详细运行、API、Workspace、Skill、CLI、环境变量和实现资料见：

[docs/readme-reference.md](docs/readme-reference.md)

V1.2 Current-State Intelligence 的数据模型和设计见：

[docs/current-state-intelligence.md](docs/current-state-intelligence.md)



## 架构知识

项目内的 `knowledge/` 保存可复用的 Data Architect 实践经验，并标明来源、资料时间、复核时间和可信度。知识只指导“怎么做”，不替代当前 Investigation 的 Evidence。

## Mission-driven Investigation

每次调查先确认“为什么做”和“最后希望拿到什么”，这两项组成 Mission Contract。没有用户确认的 Mission，Agent 不会开始正式调查；后续每一轮都会重新以 Mission 为最高优先级判断是否继续、查什么和什么时候停止。

详见 [Mission Contract 设计](docs/mission-contract.md)。

