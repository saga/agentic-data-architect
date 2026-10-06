# ADR-011：Mission Contract 作为 Investigation 的最高优先级任务边界

- Status: Accepted
- Date: 2026-10-05

## Context

调查过程很容易被局部发现、unknown、Workflow 节点和 Agent 自己提出的问题带偏。

现有 Investigation 已经有 Goal、Scope、Systems、Workflow、Evidence 和 unknowns，但这些信息没有形成一个足够稳定的“任务契约”。结果是 Agent 可能继续追一个有趣但并不影响最终交付的问题，而用户真正需要的 Data Source、Data Flow、Data Model 或最终方案还没有完整形成。

本项目需要一个简单、持久化、每轮都能重新注入 Agent 上下文的任务边界。

## Decision

引入 Mission Contract，作为 Investigation 的最高优先级任务上下文：

- purpose：为什么做这次调查；
- expectedResult：最后希望拿到什么；
- deliverables：从期望结果拆出的主要可观察交付物；
- status / confirmedBy / confirmedAt：明确记录这组内容已经由用户确认。

### 规则

1. 没有经过用户确认的 Mission，不得开始 Agent 正式调查。
2. Mission 放在动态 Agent system message 的最前面，并在自动续跑的每一轮再次注入。
3. Workflow 只能服务 Mission，不能改变 Mission。
4. Skill 提供完成 Mission 所需的能力，不负责重新定义 Mission。
5. unknown 只是调查状态，不是任务队列。
6. route、followUpQuestions、局部发现都只是实现手段，不能覆盖 Mission。
7. Mission 真正改变后，旧的 ScopeValidation、Copilot Session 和动态路线失效，需要重新对齐。
8. Mission Gate 负责确定性检查“有没有明确且用户确认的任务契约”；不让模型替用户确认。
9. deliverables 是导航和覆盖检查依据，不是事实证明，也不替代 Evidence Gate。
10. 当前系统的数据架构 / Data Source / Data Flow / Data Model 现在有独立的可选工作方式 `current-data-architecture`；它仍然只负责现状分析，不负责架构评估或改造方案。具体边界见 ADR-022。
11. Scope Validation 独立回答“本次任务究竟调查哪些对象”，通过 Mission Gate 不代表 Scope 已验证；正式调查和依赖 scope completeness 的最终交付还需满足 ADR-015 的 Scope Validation。

## Consequences

### 正面

- Agent 每一轮都有明确的“为什么做、最后要什么”；
- 长时间运行的 Copilot Session 不容易被局部上下文淹没；
- 是否继续调查可以从“还缺什么交付物”出发，而不是从“还有多少 unknown”出发；
- 当前数据架构分析已经有明确入口，但仍复用已有 Evidence、Discovery 和 Current-State Intelligence，不建立新的事实模型；
- Mission 可以被 UI、Script Gate、Workflow 和 Agent Runtime 共同消费。

### 代价

- 新 Investigation 第一次正式执行前增加一次用户确认；
- Mission 修改后可能需要重新确认 Scope；
- 需要维护少量 deliverable 归类规则。

## Rejected alternatives

### 只在 Prompt 里重复 Goal

不够稳定。长期 Session、自动续跑和局部上下文仍可能冲淡原始目标，而且无法被代码确定性检查。

### 让 Agent 自己判断 Goal / Expected Result 是否足够清楚

不采用。是否开始正式调查是运行边界，不能把这个边界交给概率模型。

### 把 Mission 做成新的 Workflow DSL 字段

不采用。Mission 是 Investigation 的任务契约，Workflow 是实现任务的路线；两者职责不同。为了一个任务边界扩展 Workflow DSL 会让 DSL 变复杂。

### 把“当前架构分析”继续只做成 capability

不采用。用户需要在新建 Investigation 时明确选择“分析当前数据架构”；因此现在提供独立的 `current-data-architecture` Workflow。它仍然复用已有 Current-State Intelligence，不建立新的事实模型。
