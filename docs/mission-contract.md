# Mission Contract：让 Investigation 始终围绕用户真正要完成的事

## 为什么要有它

长时间调查最容易出现的问题，不是 Agent 不会查，而是查着查着忘了为什么查。

因此每次 Investigation 都先固定两个问题：

- **任务目的**：为什么要做这次调查？
- **期望结果**：最后希望拿到什么？

这两项组成 Mission Contract。它不是 Workflow，也不是一个新的规划引擎，而是整个 Investigation 的最高优先级任务边界。

## 开始调查前

没有确认 Mission 时，系统不启动正式 Agent 调查。

用户确认后，系统会从期望结果中保守拆出少量交付物，例如：

- Data Source
- Data Flow
- Data Model
- Transformation
- Target Architecture
- Mapping
- Validation

这些交付物用于检查调查有没有跑偏，不是硬性的流程步骤。

## 每一轮

Mission 会重新放进 Agent 的动态 system message 最前面，并在自动续跑时再次出现。

Agent 每次选择工具或下一步动作时，都应该先回答：

> 这个动作是不是直接帮助完成期望结果？

如果答案是否定的，就不要因为 unknown、某个工具结果或者当前 Workflow 节点而继续追。

## Unknown 和 Mission 的关系

Unknown 只是“目前还不知道什么”。

它不是待办清单，也不代表一定要解决。

只有一个未知会影响当前期望结果，或者影响下一阶段真正需要做的决定时，才值得继续调查。

因此：

```text
Mission
  ↓
期望结果
  ↓
还缺哪些结果？
  ↓
什么动作最直接？
  ↓
Evidence / Tool / Skill
  ↓
继续或结束
```

而不是：

```text
发现一个 unknown
  ↓
继续追 unknown
  ↓
又发现一个 unknown
  ↓
继续追
```

## Workflow、Skill、Smart Function、Script Gate 的边界

| 能力 | 负责什么 |
|---|---|
| Mission | 定义为什么做、最终要什么 |
| Workflow | 给出高层路线 |
| Skill | 说明具体怎么查、怎么做 |
| Agent | 实际调查和推理 |
| Smart Function | 做有界的小判断，例如“是否值得继续” |
| Script Gate | 做确定性检查，例如“是否真的产生了成果” |

任何一个层都不能改变 Mission。

## 当前系统数据架构分析

“看懂当前系统的数据架构”“给我 Data Source / Data Flow / Data Model”是常见能力，不应该成为新的固定 Workflow。

对应能力是：

`skills/current-state-architecture/SKILL.md`

它可以被 Legacy Modernization、Architecture Assessment 或自主调查自由组合。

## 实现位置

- `src/investigation/schemas.ts`：Mission Contract Schema
- `src/workflow/mission-gate.ts`：确定性 Mission Gate 和交付物拆分
- `src/workflow/ask.ts`：每轮注入 Mission
- `src/agent/prompts.ts`：最高优先级 Prompt
- `src/workflow/stage-gate.ts`：阶段成果必须绑定已确认 Mission
- `web/src/components/MissionContractPanel.tsx`：用户确认和修改 Mission
- `scripts/investigation-mission-gate.ts`：本地 Script Gate

## 一个例子

用户输入：

> 分析 IBM 的老系统，给我 replatform 方案。

系统会要求先确认：

**任务目的**

> 理解 IBM 老系统当前的数据架构，为 replatform 决策提供依据。

**期望结果**

> 形成当前 Data Source、Data Flow、Data Model，并给出可落地的 replatform 方案。

确认以后，Agent 才开始调查。

后续即使发现：

> 某个历史字段的业务定义还不确定。

也不会自动把它变成下一阶段任务；只有这个定义真的影响上述交付结果时，才继续追查。
