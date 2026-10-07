# ADR-010：AI 工作成果增加独立语义质量审核

- Status: Accepted
- Date: 2026-10-05

## Context

项目已经有确定性 Gate，用来检查 Evidence、字段完整性和状态是否合法。这些检查能证明结果“有依据”，但不能判断一份报告、目标架构或映射成果是否真的容易阅读、是否回答用户目标、是否存在明显的内部结构泄漏或内容矛盾。

让生成成果的同一个 Agent 自己判断质量也不可靠，因为生成者和验收者共享同一上下文和偏好。

## Decision

对需要交付或推进 Workflow 的 AI 工作成果增加独立 Reviewer。

Reviewer：

- 使用独立 Agent Session，不继承主 Agent 的 Session。Reviewer 走与主 Investigation 相同的 Runtime abstraction，可按当前 Runtime / model 与 quota fallback 规则执行，但绝不复用主 Agent Session；
- 不提供 GitHub、数据库、grep、bash 等调查工具，不负责补证据；
- 只读取完整 Mission Contract（purpose / expectedResult / deliverables）、待审核成果和必要的确定性事实摘要；
- 检查目标匹配、可读性、结论、信息噪声、一致性和决策价值；
- 输出结构化 pass/fail、分数和具体问题；
- 只把 Reviewer 作为语义质量检查，不取代 Evidence Gate 或实际验证结果。

Reviewer 是 ADR-014 控制模型中的独立 semantic quality gate signal。它不能替代 Evidence / deterministic Gate，也不能替代 Human approval；需要 Reviewer 的交付流程必须在 Reviewer unavailable / fail 时保持 blocked。Reviewer 本身使用 runtime-neutral 的独立 Agent Session。

当前接入：

- Current-State Report：作为最终报告发布前的质量审核；
- Legacy Modernization 的 target、mapping、validation：在现有确定性 Gate 通过后，再增加独立语义审核；
- Intake / Scope：继续由确定性检查和用户确认负责；
- Cutover：继续由人工负责，不由 Reviewer 代替批准。

Reviewer 失败时，不能推进对应的报告/Modernization 阶段；失败原因必须保存到 reports 中。对于已有已发布 Report，其当前成功 review 不得被新的失败尝试覆盖；新的失败尝试单独保存，作为诊断和后续重试依据。

## Consequences

- 可以发现“事实正确，但报告没法看”这类确定性规则覆盖不到的问题；
- 可以发现成果虽然结构完整，但没有回答用户原始目标的问题；
- Target、Mapping、Validation 仍然保留确定性 Gate，不会因为 Reviewer 通过而绕过证据和实际执行要求；
- 增加一次 LLM 调用和少量延迟，但不改变现有 DataEstate、Evidence 或 Workflow DSL。

## Rejected alternatives

### 让主 Agent 自己审核

不采用。生成者和 Reviewer 共用上下文，很容易重复同一种表达错误，也很难形成稳定的质量边界。

### 只靠 Prompt 要求“说人话”

不采用。Prompt 能改善生成行为，但不能作为最终质量证明；当前 Report 的主要问题恰恰来自内部结构直接被渲染，而不是 Agent 的 answer。

### 用确定性规则判断全部报告质量

不采用。规则适合检查格式、一致性和 Evidence 引用，但很难可靠判断一份架构成果是否真正回答了目标以及是否容易理解。

## Non-goals

Reviewer 不是第二个调查 Agent，不负责重新搜索资料、证明业务事实或自动修改工作成果。
