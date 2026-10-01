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

前端：Vite + React + Ant Design 6 + Ant Design X 2.9 + XMarkdown 2.9。XMarkdown 负责 Markdown / code / formula / Mermaid 展示，Conversations / Bubble / Sender 负责聊天工作台。

Express 只负责 Web/API 边界，不重新实现 Investigation、Evidence 或 Agent 逻辑。


当前代码状态、下一步实现和边界。不重复架构理论。

## 当前：V1.2

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

当前只有一个 Investigation 主 Agent，直接使用 Copilot SDK default agent。平台级 evidence / output / safety 约束放在 system prompt 和确定性代码中，不做成一个额外的 custom agent。

Skill 是平级、可复用、按 Investigation 配置的能力模块。Research workflow 由 SKILL 定义；确定性发现由现有 TypeScript / JavaScript / Python 脚本和工具执行。

不要把会变化的命令、tool schema 或研究流程再复制成大量 prompt 文本。

## V1.3：Legacy Modernization Workbench

### Data Architect Workflow

当前工作台支持三条固定的大阶段路线：

- Legacy Modernization：已有系统改造、replatform、迁移和切换。
- Financial AI-Native Architecture：从零设计金融 AI / 数据平台，例如 Portfolio Research Agent。
- Data Architecture Assessment：评估已有数据架构、主要问题、改进建议和实施顺序。

三条路线都放在 Skill 的 Markdown Workflow 中。Session 创建时保存所选路线；Agent 会在本轮使用对应 Skill，路线只限制高层阶段，阶段内部仍由 Agent 自主调查和调用工具。

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



当前已经从 Current-State Discovery 进入完整 modernization 工作包，并支持三条高层工作路线。Legacy Modernization 与 Data Architecture Assessment 共用同一个 Journey runtime。

Data Architecture Assessment 当前由 `src/workflow/assessment.ts` 生成轻量评估结果，复用 Current-State、Findings、Gap Analysis 和 Evidence；结果写入当前 Investigation 的 `reports/architecture-assessment.json`。

### Modernization Journey

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

- 把 Journey 的每个关卡接到真正的 deterministic action / reconciliation engine
- 支持 Journey 分支、返工和人工确认状态持久化
- 把 Analysis Case 接到真正的 read-only query / reconciliation engine
- 支持列级 Source-to-Target Mapping
- 支持人工 review / approve / reject，并保留 review history
- 增加 Target Schema / Data Model 编辑与版本化
- 将 Validation Plan 变成可执行的 deterministic checks
- 根据已批准 mapping 生成 migration wave 建议

暂时不增加 Neo4j、vector DB、multi-agent swarm、完整 ontology runtime、Temporal/BPMN、生产写工具。
## Architecture Knowledge

`knowledge/` 保存跨 Investigation 可复用的 Data Architect 经验。每条知识记录来源、资料时间、最近复核时间、来源可信度和知识可信度，并区分 stable / contextual / time-sensitive。

运行时通过 `src/knowledge/catalog.ts` 按 workflow 和当前问题做轻量确定性检索，再把少量结果作为“方法参考”注入 Agent。知识不能成为当前 Investigation 的 Evidence。

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

## V1.4：下一步

- 把 Analysis Case 接到真正的 read-only query / reconciliation engine
- 支持列级 Source-to-Target Mapping
- 支持人工 review / approve / reject，并保留 review history
- 增加 Target Schema / Data Model 编辑与版本化
- 将 Validation Plan 变成可执行的 deterministic checks
- 根据已批准 mapping 生成 migration wave 建议

暂时不增加 Neo4j、vector DB、multi-agent swarm、完整 ontology runtime、Temporal/BPMN、生产写工具。
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
