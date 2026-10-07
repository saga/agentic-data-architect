# ADR-032：Agent Runtime 适配器隔离与 Workflow 完成校验

- Status: Accepted
- Date: 2026-10-07
- Decision scope: Agent Runtime module boundaries, shared Agent input contract, Workflow transition completion policy

## Context

当前工作台支持 Copilot SDK、CodeBuddy SDK 和 OpenCode Run。早期实现把部分共享能力放进具体 Runtime adapter，形成了直接交叉依赖：

- Copilot adapter 直接路由 OpenCode；
- CodeBuddy 从 OpenCode 读取 Graphify 判定；
- CodeBuddy 从 Copilot 读取用户输入状态；
- 多个 adapter 各自定义 Agent input 类型和部分默认继续执行行为。

这种结构会让 provider-specific 实现互相知道对方的生命周期，后续修改容易产生行为漂移。

另一个问题是 Workflow 的 DSL 允许 task 节点不写 `completeWhen`。对于这种节点，如果服务器只根据 Agent 返回的 `success` 推进，就等于让模型自己证明自己已经完成阶段，违背 Deterministic Gate 原则。

## Decision

### 1. Runtime adapter 不直接依赖另一个 Runtime adapter

Copilot、CodeBuddy、OpenCode 之间禁止直接导入对方的 execution function、session state 或交互队列。

共享能力必须放在更低的稳定模块：

- `src/agent/ask-input.ts`：Agent input / trajectory callback contract；
- `src/agent/user-input-bridge.ts`：跨 Runtime 共用的人工输入桥；
- `src/adapters/graphify.ts`：Graphify capability 和“是否需要先做结构分析”的判定。

`src/agent/runtime.ts` 是唯一负责 Runtime 选择、模型解析和 quota fallback 的上层编排入口。

### 2. Workflow completion 有两个确定性来源

Agent task 节点只有两种合法完成依据：

1. 节点声明了 `completeWhen`：服务端根据 `JourneyFacts` 的 deterministic evaluator 判断；
2. 节点没有 `completeWhen`：必须先通过本次阶段的 Stage Gate，Runtime 才能把 Agent 的 `success` 作为合法 transition。

没有 Stage Gate 结果时，conditionless agent task 不得推进。

### 3. Runtime 默认继续行为必须一致

没有上层 `shouldContinueMission` 时，所有 Runtime 都默认停止自动续跑。正常 Investigation 由 `ask.ts` 提供统一的 Mission continuation decision。

`autoContinuationTurns` 仍由 Investigation Control 提供，Runtime adapter 只执行传入的值，不各自定义不同的业务默认。

### 4. DSL 必须机器拒绝扩展语法

Workflow parser/lint 必须拒绝：

- `@flow`、`@task`、`@review`、`@end` 之外的 block；
- `title`、`objective`、`actor`、`completeWhen` 之外的节点字段；
- 已声明出口之后再次写属性；
- 未知的 `completeWhen`；
- 人工节点上的 `completeWhen`。

不能先解析部分内容，再把未知字段静默丢掉。

## Consequences

- Provider-specific Runtime 可以独立演进，不再形成反向依赖。
- 人工输入和 Graphify 判断只有一个共享实现，减少行为漂移。
- Workflow 的 `success` 不再天然等于“阶段已完成”。
- Skill DSL 继续保持很小，但错误会更早在 lint 阶段暴露。
- Runtime adapter 的默认自动续跑更保守；正式 Investigation 的行为仍由宿主 Mission decision 控制。

## Related

- ADR-003：个人本机 Agent Runtime
- ADR-005：Workflow / Skill / Tool / Agent / Human 分离
- ADR-014：Probabilistic Agent 与 Deterministic Gates
- ADR-020：Runtime Event、HTTP Error 与 Durable Data Contract
- ADR-024：Skill Input / Output / Gate Contract
- ADR-026：Canonical Derived State 与 Workflow / Result 边界
- ADR-031：CodeBuddy Investigation Sandbox
