# ADR-026：Canonical Derived State 与 Workflow / Result 边界收口

- Status: Accepted
- Date: 2026-10-07
- Decision scope: Mission Progress, Workflow completion, Result Gate, Assessment / Modernization artifact boundaries

## Context

项目已经分别实现了 Mission Contract、Workflow、Current-State Intelligence、Modernization、Assessment、Report Gate，但这些能力在多轮演进后容易从同一份事实各自推导状态。

典型问题是：

- Source-of-Truth candidate 在 Current-State 中只是待确认项，但 Mission Progress 可能把它算成 covered；
- Assessment、Modernization 都可以产生自己的 Journey projection，导致 Workflow runtime 出现第二份状态；
- Assessment 的零 Finding 结果被当成“没有完成”，而不是合法的评估结论；
- 最终 Report 与 route-specific artifact 之间没有统一的结果入口。

这些问题不是再增加字段就能长期解决的，必须明确唯一的 derived-state 解释边界。

## Decision

### 1. Canonical Derived State

`src/workflow/derived-state.ts` 是“事实是否足够形成某种业务结果”的唯一确定性 evaluator。

输入只能来自已经持久化的 Investigation facts，例如：

- Current-State coverage；
- DataEstate column / lineage；
- Source-of-Truth candidates；
- Findings / Gaps；
- Modernization work products；
- Assessment work product。

输出是命名的 derived signals。

Mission Progress、Workflow completion、Report Gate 只消费这些 signals，不自行用 array length、status 字符串或 UI 状态重新解释完成语义。

### 2. Workflow runtime 只有一个 owner

Workflow execution 只属于 `WorkflowSnapshot.execution` 及其持久化 execution 文件。

Modernization Plan 和 Assessment Plan 是业务工作成果，不保存 Journey / Execution projection。

Workflow 地图、Journey Context、Transition 和执行状态都从同一份 Workflow runtime 读取。

### 3. Assessment 与 Modernization 必须保持结果边界

Legacy Modernization 的 Artifact 只在 `legacy-modernization` 工作方式下参与最终结果。

Data Architecture Assessment 只在 `data-architecture-assessment` 工作方式下进入统一 `reports/report.md`。

Assessment 不默认生成 Target Architecture，也不使用“必须进入目标架构”的路线作为评估完成条件。

Assessment 没有 Finding 也是合法结果；此时 recommendations / roadmap 可以为空，Workflow 仍然可以完成。

### 4. Skill 描述必须与 deterministic condition 一致

Workflow Skill 中的 `completeWhen` 只能引用平台已实现的 deterministic signal。

如果业务语义需要新的完成条件，先扩展 evaluator 和测试，再改变 Workflow Skill；不能通过 Prompt 让 Agent 自己宣布完成。

### 5. Contract enforcement

Web JSON client 的 `getJson` 必须要求 runtime schema。允许裸泛型返回会重新打开 ADR-016 已关闭的 validation bypass。

### 6. Operational boundaries

Report 与 Assessment artifact 的生成按 Investigation 串行化，避免 version 竞争。

Global Media Cache 是有边界的本机运行资源，总预算为 512 MB；超额时按最近访问时间优先淘汰旧文件。

个人本机 Agent 默认只监听 loopback。非 loopback binding 必须显式设置 `ALLOW_REMOTE_HOST=true`。

本地上传头像只属于当前 Investigation，不再通过 shared assistant default 目录产生隐藏的 Global side effect。

## Consequences

- “完成”语义只有一个地方解释，减少跨页面状态冲突。
- Workflow runtime 与业务工作成果彻底分离。
- Assessment 可以表达“没有重大问题”这样的正常结果。
- Report、Assessment、Modernization 的生命周期更容易理解和验证。
- 少量 derived-state regression tests 可以直接验证跨模块不变量。

## Rejected alternatives

### 为每个 Workflow 建独立 evaluator

Rejected。会再次产生相同事实的不同完成语义。

### 把 Journey 放回每个业务 Artifact

Rejected。Artifact 是工作成果，Workflow execution 是运行状态，二者生命周期不同。

### 用更多 Prompt 约束 Agent 自评完成

Rejected。Prompt 可以指导行为，但不能作为确定性状态证明。

### 保留 shared assistant default 作为“隐式 Global avatar”

Rejected。Global Config / Global Media Cache 已经提供明确的跨 Investigation 资源边界，继续保留另一条默认头像路径会产生隐藏副作用。
