# Implementation Roadmap

## 当前交互层：Web Workbench

主入口已经从 readline session 改为 Web UI：

```text
Browser
  → Express 5
  → Investigation API
  → existing workflow / Evidence / Copilot SDK
  → SQLite conversation history + .workspace/<session>/context.json
                           ↘ Skills / Skill scripts
```

前端：Vite + React + Ant Design 6 + Ant Design X 2.9 + XMarkdown 2.9。XMarkdown 负责 Markdown / code / formula / Mermaid 展示，Conversations / Bubble / Sender 负责聊天工作台。Journey 地图使用 `@xyflow/react` 的 custom nodes、NodeToolbar、Panel、MiniMap 和 animated edges；完整工作地图由 Workflow Definition 驱动，使用 ELK 做自动排版，并由浏览器实际测量节点尺寸后再次布局。地图不是第二套 Workflow Engine，Workflow 语义和执行状态仍由服务端负责。

Express 只负责 Web/API 边界，不重新实现 Investigation、Evidence 或 Agent 逻辑。


当前代码状态、下一步实现和边界。不重复架构理论。

## 当前：V1.8

已经具备：

- 持续 Investigation session 和可恢复 Copilot session
- `.workspace/<session>/context.json` 持久化 goal、scope、evidence、claims、findings、unknowns 等调查状态
- `.workspace/conversations.db` 持久化 user / assistant / system 消息，并使用 SQLite FTS5 建立全文索引
- Copilot SDK 从 `skills/` 发现和加载 Skill；每个 Investigation 通过 `control.json` 选择启用哪些 Skill，未选择的 Skill 会显式禁用
- 金融领域检查放在 `skills/financial-data-review/`，其中 deterministic 检查放在 `scripts/review.mjs`
- `.workspace/shared/index.json` 和共享研究资料
- 本地 SQL / PostgreSQL / Snowflake discovery
- SQLGlot dataset / column lineage
- Evidence provenance
- read-only profiling / targeted query
- deterministic findings
- structured Agent result 和 evidence status 校正
- Current-State Report

运行入口现在是：

```bash
npm run start
```

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

Skill 可以保存本次 Investigation 的运行参数。MCP 可以配置连接方式、URL / command、args、允许使用的 tools 和 headers。MCP 工具每次真正执行时的 input 仍由 Agent 根据任务决定，不作为静态配置。

工作方式属于危险操作：目标路线可以选择，但只有明确输入确认语句后才真正切换。

## Memory / History

当前 Investigation 的“记忆”实际上由四层组成：

```text
1. context.json
   → 当前业务状态：goal / scope / Evidence / Findings / Unknowns / Journey Plan
2. conversations.db
   → 完整 user / assistant / system transcript
3. discovery / reports / artifacts
   → 调查产物和可追溯原始结果
4. Copilot Session
   → Agent runtime 自己的 session history，SDK 可以做上下文 compaction
```

当前已经做到“原始记录持久化”，但还没有完整的 application-owned Memory Archive：

- `listConversationMessages(limit)` 只是限制返回数量，不是完整的 cursor pagination。
- `searchConversation(... beforeRowId)` 已有一个内部时间水位，但没有形成统一的 Memory Page API。
- Copilot SDK 的 compaction 是 runtime 侧的上下文压缩，不等于本项目自己的长期记忆归档。
- 当前没有 `MemoryArchive` / `memory summary` 持久化层，因此不能保证很长调查经过多次上下文压缩后仍有一份独立、可分页、可回溯的历史摘要。

目标模型应改为：

```text
完整 transcript 永不删除
        ↓
按 cursor 分页读取
        ↓
长期历史生成 Archive Summary
        ↓
当前 Agent 只拿 Working Memory + 相关历史
```

`@saga/agent-memory` 已在 `saga/common-agent-lib` 中定义这个公共 contract；本项目下一步应在现有 SQLite 上实现适配器，而不是把 SQLite 模型反向放进 common lib。

Archive 必须保留 `sourceRecordIds` / sequence 范围，摘要只是压缩后的导航，不是事实源。当前 `context.json`、Evidence 和原始 transcript 仍然是事实和可追溯记录。
## Workspace 边界

```text
.workspace/
  shared/
    index.json
    confluence/
    github/
    leanix/
    web/
    document/
  <session>/
    context.json
    transcript.md
    discovery/
    reports/
    artifacts/
```

`context.json` 是当前 Investigation 状态；多轮聊天不再写入这里。`.workspace/conversations.db` 保存所有 session 的消息历史，并通过 FTS5 为相关历史检索提供索引。shared 是可复用资料，不再为每个 session 建一套 research/source/findings/notes 目录。

## Agent / Skill / Script 原则

当前只有一个 Investigation 主 Agent，直接使用 Copilot SDK default agent。平台级 evidence / output / safety 约束放在 system prompt 和确定性代码中，不做成一个额外的 custom agent。Workflow 只提供地图骨架；Agent 可以在回答后给出少量下一步候选，用户点击候选后，前端发送 routeId，服务端从当前调查的真实候选中解析并作为结构化上下文交给 Agent，而不是拼一段“我选择这条路线……”的提示词。

Skill 是平级、可复用、按 Investigation 配置的能力模块。Research workflow 由 SKILL 定义；确定性发现由现有 TypeScript / JavaScript / Python 脚本和工具执行。

Structural Analysis 是一个例外边界：Graphify executable 属于平台级 capability，不由 Investigation 的 MCP/Skill 列表决定是否安装。每个 turn 的 Control snapshot 记录平台 capability version；runtime audit 再记录实际 Graphify package version、graph path 和 graph hash。这样既保留能力的稳定可用性，又避免 toolchain 漂移而无法重放。

不要把会变化的命令、tool schema 或研究流程再复制成大量 prompt 文本。

Graphify 只做 structural navigation。Discovery 会为扫描到的源文件建立 `source_file` Evidence（包含 file + sha256 + line count）；Agent 可以用 Graphify 找到文件，再回到源码、SQL AST、metadata 或 profiling 等 deterministic Evidence。source_file Evidence 只证明“当时分析的是哪个文件版本”，不自动证明业务语义。

## V1.3：Legacy Modernization Workbench

### Investigation 与 Data Architect Workflow

当前 Investigation 不要求绑定 Workflow。新建工作默认是自主调查：

```text
Goal
 ↓
Agent 自主调查
 ↓
发现新的结构或约束
 ↓
可选：在“调查配置 → 工作方式”经过明确确认后采用 / 切换 Workflow
 ↓
继续调查
```

当前提供三套可选的大阶段路线：

- Legacy Modernization：已有系统改造、replatform、迁移和切换。
- Financial AI-Native Architecture：从零设计金融 AI / 数据平台，例如 Portfolio Research Agent。
- Data Architecture Assessment：评估已有数据架构、主要问题、改进建议和实施顺序。

Workflow 是 playbook，不是 Investigation 类型。选择 Workflow 后，系统加载对应的 Workflow Skill，并把它作为“地图骨架”。工作方式不是首页上的普通筛选项；需要在“调查配置 → 工作方式”明确选择并输入确认语句后才会切换。Agent 的下一步候选只是调查辅助，点击后通过结构化 routeId 执行，不修改 Workflow，也不会创建第二套状态机。

金融 AI-native 路线：

```text
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
```



当前已经从 Current-State Discovery 进入完整 modernization 工作包；Legacy Modernization 与 Data Architecture Assessment 在被选中时共用同一个 Journey runtime。

Data Architecture Assessment 当前由 `src/workflow/assessment.ts` 生成轻量评估结果，复用 Current-State、Findings、Gap Analysis 和 Evidence；结果写入当前 Investigation 的 `reports/architecture-assessment.json`。

### Modernization Journey

工作地图现在既是导航视图，也是 Investigation Workflow 的编辑入口。当前实现：
- 主对话区继续使用 `context.journeyPlan.routes` 作为 Agent 的临时调查建议；这些建议不直接改变 Workflow 状态。
- 完整工作地图使用 `@xyflow/react` 展示 Workflow Definition、执行状态、分支和结构问题。
- 工作地图可以直接拖拽节点、添加步骤、连接/重新连接分支、编辑节点和分支属性，并通过 AI 提出 Workflow Patch。
- 右侧栏使用 Ant Design Tabs，在“属性”和“AI”之间切换，避免属性表单与 AI 对话同时挤占空间。
- 编辑结果先留在当前画布；只有点击“保存”后，服务端验证通过才创建新的 Investigation Workflow version。
- Unknowns 和 Agent 下一步候选都属于调查辅助，不会绕过正式 Workflow 的执行控制；下一步候选只表示“这次可以做什么”，不代表流程已经推进。

路线定义在：

```text
skills/legacy-modernization/SKILL.md
```

使用轻量 Markdown Workflow：

```text
@flow
@task
@gate
@end
@stop
```

主路线：

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

实现分工：

- Workflow：定义顺序、Gate、返工和下一关。
- Skill：定义每一关怎么调查。
- Tool：执行 SQL、profiling、lineage、GitHub、Confluence、Web Search 等动作。
- Agent：根据证据选择调查动作并解释结果。
- Human：确认业务定义、范围和例外。

Journey 状态由 `src/workflow/journey.ts` 根据确定性事实计算，不依赖 Agent 自评。当前路线通过 `GET /api/sessions/:name/journey` 提供给 UI；Legacy Modernization 的完整方案通过 `GET /api/sessions/:name/modernization` 提供，Data Architecture Assessment 的评估结果通过 `GET /api/sessions/:name/assessment` 提供。

Markdown Workflow 的基本检查可以运行：

```bash
npm run flow:lint
```



当前已经从 Current-State Discovery 进入完整 modernization 工作包：

1. **Current-State Intelligence**
   - metadata / dataset / column
   - SQL / ETL lineage
   - profiling
   - parse coverage
   - source-of-truth candidates
   - semantic context
2. **Analyst Investigation**
   - Analysis Case
   - hypotheses / analysis steps
   - Findings / Evidence / Unknowns
3. **Target Architecture**
   - provider-neutral target blueprint
   - domain data
   - transformation
   - semantic layer
   - serving / governance
4. **Source-to-Target Mapping**
   - dataset-level mapping skeleton
   - transformation / business rule / validation rule
   - mapping remains `proposed` until reviewed
5. **Gap Analysis**
   - discovery / lineage / semantic / quality / architecture / migration gaps
6. **Validation Plan**
   - coverage
   - lineage
   - semantic
   - mapping
   - reconciliation
   - quality
   - cutover / rollback
7. **Migration Stages**
   - baseline
   - business semantics
   - target architecture
   - mapping
   - validation
   - migration waves / cutover

这些对象通过 `modernization-plan.json` 持久化，UI 和 Agent 都可以继续基于它工作。自动生成结果一律视为 draft / proposed，不把模型推理当成最终业务事实。

## 当前未完成的主要工作

- 把 Journey 的关键关卡逐步接到真正的 deterministic action / reconciliation engine；当前 Workflow 已负责路线、分支、waiting、版本和执行位置，但不执行具体业务动作。
- 把 Analysis Case 接到真正的 read-only query / reconciliation engine。
- 支持列级 Source-to-Target Mapping。
- 支持人工 review / approve / reject，并保留 review history。
- 增加 Target Schema / Data Model 编辑与版本化。
- 将 Validation Plan 变成可执行的 deterministic checks。
- 根据已批准 mapping 生成 migration wave 建议。
- 在现有 SQLite conversation store 上补齐 application-owned Memory Archive / cursor pagination。

暂时不增加 Neo4j、vector DB、multi-agent swarm、完整 ontology runtime、Temporal/BPMN、生产写工具。

## Architecture Knowledge

`knowledge/` 保存跨 Investigation 可复用的 Data Architect 经验。每条知识记录来源、资料时间、最近复核时间、来源可信度和知识可信度，并区分 stable / contextual / time-sensitive。

运行时通过 `src/knowledge/catalog.ts` 按 workflow 和当前问题做轻量确定性检索，再把少量结果作为“方法参考”注入 Agent。知识不能成为当前 Investigation 的 Evidence。

## Skill 类型

Skill 统一以 skills/<name>/SKILL.md 打包，但运行语义只有两类：

- capability：明确的一项能力，Agent 自己决定什么时候用、如何和其它能力组合。例如 search-confluence、search-github、financial-data-review。
- workflow：完整的工作路线，存在固定的大阶段、顺序、Gate 和完成条件。例如 legacy-modernization、financial-ai-native-architecture、data-architecture-assessment。

类型写在 Skill frontmatter 的 metadata.kind，而不是再创建另一套 Skill 目录格式。

~~~yaml
metadata:
  kind: capability
~~~

或：

~~~yaml
metadata:
  kind: workflow
~~~

复杂度不是分类条件。一个 capability 内部可以有多个查询或脚本；只要 Agent 仍然可以自由组合，就不需要升级成 workflow。也不要增加 task 之类的第三种类型。

当前代码由 src/skills/catalog.ts 统一解析 manifest。Journey 只接受 kind: workflow；普通 capability 不得定义 @flow。

## Skill 边界

核心代码负责安全和一致性：Evidence 校验、Claim 状态校正、SQL read-only、workspace/state persistence、lineage/profile 等确定性基础能力不交给模型。

Skill 负责容易变化的领域知识、调查方法、问题清单和专业解释。需要精确计算或扫描时，Skill 自带 scripts，由 Agent 调用并读取生成 artifact。Skill 内容不是 Evidence，脚本结果仍必须回指原始 Evidence。

当前金融 Skill 示例：

~~~text
skills/financial-data-review/
  SKILL.md
  scripts/review.mjs
~~~

### Schema 验证

项目使用 Zod 4 作为运行时 Schema 层。持久化 JSON、HTTP 请求体、环境变量和 Agent 结构化输出都在进入业务逻辑前经过 Schema 校验；TypeScript 类型由 Zod Schema 推导，避免手写 interface 与验证逻辑长期漂移。
