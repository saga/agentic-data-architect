# ADR-021：Stage Checkpoint 表示真实执行阶段，不等同于 Deliverable 完成

- Status: Accepted
- Date: 2026-10-06

## Context

Stage Gate 曾把“本阶段推进了 Mission Deliverable”与“本阶段存在真实工作”混为一谈。因此 Agent 已经生成并持久化新的 structured work product 时，如果 deliverable 状态仍是 covered，Gate 可能不生成 checkpoint。

这直接导致“改造工作成果”已有内容，而“阶段小结”为空或阶段记录不足。

## Decision

1. Checkpoint 是一次真实、可验证的执行阶段成果，不是为了填充 UI 而制造的记录。
2. 可以形成 checkpoint 的真实工作包括新增 Evidence、Finding、Discovery run、Scope validation 或新的持久化 structured work product。
3. Deliverable coverage 负责回答“交付物完成到什么程度”，不是 checkpoint 是否存在的唯一条件。
4. 同一个 Investigation 可以有多个 checkpoint，但数量必须对应真实执行阶段；不得为了得到“多个阶段”而人为续跑。
5. Stage Gate 继续是 deterministic Gate；Agent 的 success 声明不能直接创建 checkpoint。
6. Mission completion 与 checkpoint creation 是两个独立判断：Mission completion 决定是否还有必要继续执行；Stage Gate 决定本次真实工作是否足以形成可审计 checkpoint。

## Consequences

- Result 页面可以准确保留多次真实阶段执行的历史。
- 已经 covered 的交付物发生新的有价值细化时，仍可形成 checkpoint。
- 不会因为 UI 需要多个小结而制造没有实际内容的假阶段。

## Related ADRs

ADR-011、ADR-014、ADR-019。