# Contract Consolidation Map

本文记录 server、domain、persistence 和 web 之间的 canonical Contract ownership。它是本轮第一阶段的架构基线；具体约束以 ADR 为准。

## 1. Canonical ownership

| 对象 | Canonical Owner | Boundary | Web / Consumer |
|---|---|---|---|
| WorkflowId | shared API Contract | Session / Workflow API | shared type |
| Mission Contract | Investigation domain + shared API Contract | /mission | shared type |
| Mission Progress | deterministic evaluator | Session / Mission API | shared type |
| Stage Checkpoint | Stage Gate + Trajectory | /results + runtime event | Result View |
| Execution Status | runtime Contract | /execution | shared type |
| SSE Event | runtime Contract | /messages/stream | common SSE client |
| Trajectory Event / Response | runtime Contract | /trajectory | Trajectory View |
| WorkflowSnapshot | workflow runtime | /workflow | Workflow / Journey UI |
| Result View Model | result API Contract | /results | Result page only |
| Report | Report artifact | /results + /report | Result projection |
| Modernization Plan | modernization domain model | /results + /modernization | Result projection |
| Assessment Plan | assessment domain model | /results + /assessment | Result projection |
| Configuration | Control persistence model + API View | /config | Config projection |
| Current State | Discovery snapshot | Session / Report | explicit UI projection |
| Discovery Snapshot | Discovery persistence schema | internal store | never direct |
| HTTP Error | shared API Error Contract | all API routes | common API client |
| Workspace Input | Investigation persistence schema | Session API | Input View |
| Conversation Message | SQLite conversation store | Session / Messages API | Message View |

## 2. Layering rules

### Domain / Persistence → Server

Persistence schema 是其对象的唯一 owner。Server 不复制 domain semantics，只做 validation、security filtering 和 API projection。

### Server → Web

只有 API Contract 跨 boundary。Web 页面不能根据 JSON 形状猜业务结构。

### Web → UI

UI 可以创建纯 presentation View，但必须显式命名为 View / Projection，不能冒充 canonical domain object。

### Runtime

WorkflowSnapshot 是唯一 workflow runtime resource；Trajectory 是历史 runtime evidence；Stage Checkpoint 是经过 Stage Gate 的阶段成果记录。

### Result

`/results` 是 Result 页面唯一聚合 resource。它只读取已经生成的 artifact；生成使用显式 action endpoint。

## 3. Artifact lifecycle

~~~mermaid
flowchart LR
    A[Investigation State] --> B[Deterministic Evaluator]
    B --> C[Artifact / Result Builder]
    C --> D[Result View Model]
    E[Artifact Provenance] --> C
    F[Independent Reviewer] --> C
    D --> G[Web Result Page]
~~~

artifact 必须能够判断 current / stale。Reviewer 不能修改事实或替代 Evidence Gate。

## 4. Workflow lifecycle

~~~mermaid
flowchart LR
    A[Workflow Definition] --> B[WorkflowSnapshot]
    C[Execution] --> B
    D[Derived Facts] --> B
    E[Run Events] --> B
    B --> F[Workflow Editor]
    B --> G[Context Panel]
~~~

## 5. 已明确的历史不一致及其 ADR

| 原问题 | 架构结论 | ADR |
|---|---|---|
| Mission / Scope / Workflow 边界混用 | Mission 是任务边界，Scope 是正式调查前置条件 | ADR-011、ADR-015 |
| Independent Reviewer 只是建议，没有明确 gate 语义 | Reviewer 是 artifact 发布/Workflow 推进前的独立语义质量 gate，不替代 Evidence Gate / Human approval | ADR-010 |
| Soul / Relationship Memory 可能进入任务推理 | Persona 只能影响最终 rendering，不能影响 task facts / conclusions | ADR-012 |
| Global / Task 配置发生默认值污染 | Task 只保存 sparse override，Global 与 Task 分层 | ADR-013 |
| Agent 自己宣布完成 | Agent 提议，deterministic gate 控制状态转换 | ADR-014 |
| 阶段小结为空，而改造成果已有内容 | structured work product 属于真实阶段成果；checkpoint 不等同 deliverable coverage | ADR-021 |
| Server / Web 重复定义相同类型 | 一个 canonical API Contract，UI 只能使用 View / Projection | ADR-016 |
| 旧 artifact 可能污染新任务 | artifact 必须绑定 provenance；GET 与 generate 分离 | ADR-017 |
| Journey / Workflow 状态双轨 | WorkflowSnapshot 是唯一 canonical runtime state | ADR-018 |
| Mission / Journey / Completion 的完成语义不一致 | 统一 deterministic evaluator | ADR-019 |
| SSE / HTTP error / persistence schema 各自演化 | 共享 runtime contracts + validation | ADR-020 |

## 6. Phase-1 completion criteria

第一阶段完成后：

- ADR-016 ～ ADR-021 已进入 ADR index。
- Contract owner、boundary 和 compatibility 规则已经明确。
- Result、Workflow、Runtime Event、Artifact provenance、Derived State、Stage Checkpoint 的 canonical ownership 已明确。
- 既有架构不一致已经被记录为正式 ADR，而不是只存在于代码注释或讨论中。
- 第一阶段不改变业务代码；第二阶段才按这些 ADR 执行 Align。


## 7. Phase-2 / Phase-3 implementation status

### Phase 2 — Contract Align

阶段 2 已完成主要 Contract 与 lifecycle 对齐：

- Shared browser-safe API Contract 已建立，Server / Web 不再各自维护 Mission、Workflow、Trajectory、Control 等跨边界类型。
- WorkflowSnapshot 顶层 execution 成为 canonical runtime owner，`/journey` 仅保留 compatibility projection。
- Report / Modernization / Assessment 的 artifact 生命周期增加 provenance / version freshness 约束。
- Report GET 只读，生成通过显式 action endpoint。
- Reviewer unavailable / fail 按统一规则阻断正式结果。
- Discovery Snapshot、Trajectory / Journey Event 增加 runtime validation。

### Phase 3 — Final Hardening

已完成的最终收口还包括：
- Mission / Workflow / Result Gate 统一使用 `src/workflow/derived-state.ts` 的 canonical evaluator。
- Assessment 与 Modernization 的专用 Artifact 严格按 Workflow 分开；Workflow runtime 不再嵌入业务 Artifact。
- Report / Assessment generation 按 Investigation 串行化，避免版本竞争。

阶段 3 聚焦“contract declared but not enforced”的剩余问题：

- Report generation 真正执行 Current-State deterministic Gate。
- Assessment / Modernization GET 只读，新增显式 regenerate action。
- SSE Server / Web 双向运行时校验，checkpoint / completed payload 均使用结构化 Contract。
- Session / Mission / Workflow / Trajectory / Control / File Upload 等关键 HTTP response 使用 Runtime Schema。
- SessionContext 改为明确 API Projection，不再直接暴露完整 persistence object。
- Web controller、Result、Trajectory、Config 页面统一消费 Shared Contract，移除重复 interface / response casts。
- JourneyPlan / Workflow AI Change / Artifact Review 等剩余跨边界对象统一 canonical owner。
- Domain persistence schema 与 Shared API Contract 不直接互相暴露；跨 server/web 的对象必须通过 canonical API projection + runtime validation 对齐，避免 persistence 字段泄漏。
- 增加 artifact provenance、checkpoint、shared contract 相关 regression tests。

## 8. Remaining work / phase boundary

本轮三阶段的目标是完成现有 Contract Consolidation Map 中识别出的架构不一致，不扩展新的业务流程或引入新的基础设施。

未完成的事项不应再通过“继续增加类型/接口”解决；后续变更应遵循本文件的 ownership / projection / lifecycle 规则，并优先修改 canonical contract 和确定性 evaluator，再修改消费者。
