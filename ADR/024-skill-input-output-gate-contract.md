# ADR-024：Skill 必须声明统一的输入、输出和验证契约

- Status: Accepted
- Date: 2026-10-06

## Context

Skill 同时承担调查方法、领域能力和 Workflow 说明。过去不同 Skill 对“什么时候使用、会产生什么、什么时候算可靠”的描述深浅不一致，容易导致 Agent 只看到方法，没有明确的输入边界和结果标准。

项目又有两类 Skill：Workflow 需要实际阶段 Gate；Capability 不负责 Workflow transition，但它产生的资料同样需要说明如何验证。

## Decision

所有 `skills/*/SKILL.md` 必须包含五个固定章节：

1. `输入校验`：什么情况下使用，以及开始前必须具备什么。
2. `输出`：会产生什么结果或资料，必要时说明保存位置。
3. `输出与验证`：怎样判断结果有依据、没有越过能力边界。
4. `Gate`：什么条件满足后，结果才能被后续工作采用。
5. `期望结果示例`：给出正常结果的具体样子，并在需要时展示边界错误。

两类 Skill 的 Gate 语义不同：

- Workflow：Gate 必须能够落到服务端确定性条件、阶段成果或专用脚本；Agent 的自然语言不能直接推进 Workflow。
- Capability：Gate 不负责整个 Investigation 的阶段转换，而负责本能力输出的可复核条件。需要进入正式结果时，还必须满足通用 Mission / Scope / Evidence / Report 规则。

`src/workflow/lint.ts` 和 Skill 回归测试负责检查五个章节存在。具体业务结果仍由对应的确定性 Schema、Script、Gate 或工具校验。
此外，Skill lint 必须拒绝当前 DSL 明确不支持的 frontmatter 字段、`@gate` / `@stop` 以及节点未定义的自定义属性，不能把这些内容静默丢掉。

## Consequences

- 新 Skill 不再只有“怎么做”，还必须说明“什么输入可以做、做完得到什么、怎样算可信”。
- Capability 不需要为了有 Gate 而被错误升级成 Workflow。
- Workflow 和通用 Investigation Report 可以共享一套最小输出标准。
- 代价只是每个 Skill 多维护少量说明，并不增加新的 DSL。

## Rejected alternatives

### 给每个 Skill 都增加独立 Workflow Gate 代码

不采用。Capability 本来就不拥有 Workflow 生命周期，强行增加会导致架构复杂化。

### 只靠 Agent Prompt 约束 Skill 输出

不采用。Prompt 不能稳定验证持久化结果；至少章节完整性和关键结果条件必须有确定性检查。

### 要求所有 Skill 使用完全相同的输出文件格式

不采用。不同能力的中间资料格式不同；统一的是契约结构，不是业务数据模型。
