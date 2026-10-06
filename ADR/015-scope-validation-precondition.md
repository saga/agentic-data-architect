# ADR-015：Scope Validation 作为正式调查前置条件

- Status: Accepted
- Date: 2026-10-06
- Decision scope: Investigation scope, system/object boundaries, report preconditions

## Context

Mission 回答“为什么做、最后需要什么结果”，但不能单独定义当前 Investigation 究竟包含哪些系统、数据库、schema、repository、dataset 或对象。

Scope 如果只是 UI 上的一组描述，可能在调查过程中被默默改变，进而导致 Evidence、Report 和最终结论失去清晰的适用边界。

因此 Scope 需要成为独立、可验证、可失效的 Investigation 状态，而不是 Mission 的附属文字。

## Decision

Scope Validation 是正式 Investigation 和最终交付的明确前置条件。

### 1. Scope 独立于 Mission

Scope 描述当前任务允许调查的实体边界，例如 systems / applications、repositories、databases / schemas、datasets / tables，以及其它被明确纳入或排除的对象。

Mission 定义任务目标；Scope 定义任务边界；两者不合并成新的 Workflow DSL。

### 2. Scope 必须被明确确认和验证

Scope Validation 必须记录：

- 当前 Scope；
- validation status；
- provenance / validation evidence；
- snapshot 或等价版本信息；
- validation time。

不能仅因为用户写了一段范围描述，就把 Scope 当成 validated。

### 2.1 Discovery generation 必须绑定 Scope

每一次正式 Discovery Run 都必须记录生成时的 `scopeFingerprint`；Run 的 `id` 就是该次 Discovery generation 的稳定身份。当前 schema 对历史 Run 允许缺失该字段，但任何新生成并作为 current source 使用的 Run 都必须有它。

Discovery Snapshot 不单独建立第二套 Scope identity；它只能继承并引用其 `run.scopeFingerprint` 和 `run.id`。因此：

- Snapshot 只能作为生成时 Scope 的事实来源；
- 当前 Scope fingerprint 与 Snapshot 的 Scope fingerprint 不一致时，Snapshot 不能被复用为当前调查事实；
- legacy Snapshot 若没有 Scope fingerprint，可以读取和审计，但不能被新一代 Artifact 当作 current source；
- Scope 不变时，原始 Evidence / Discovery 可以复用，不要求因为 Mission 文案变化而重新扫描来源。

这样可以区分“原始来源仍然可复用”和“旧任务结论不能继续作为当前结论”两种不同的失效语义。

### 3. Scope 未验证时不得正式推进

在 Scope 未通过 validation 时：

- 不允许把调查标记为正式 scope-bound investigation；
- 不允许生成依赖 scope completeness 的最终报告；
- 不允许把 scoped result 表示成已经覆盖全部目标范围。

Agent 可以帮助发现或整理候选范围，但不能代替 deterministic validation。

### 4. Mission 变化使 Scope Validation 失效

Mission 真正改变后，原 Scope 可能不再适用。

因此 Mission change 必须使关联的 Scope Validation 进入 invalid / needs revalidation 状态，并阻止沿用旧 Scope 作为已验证边界。

Mission change 本身不要求删除原始 Evidence 或历史 Discovery。历史来源可以保留并在新的 Scope 下复用；只有 Scope / Discovery generation 不再兼容时，才禁止把旧 Snapshot 当作当前事实源。

### 5. Scope Validation 与 Evidence Gate 分工不同

Scope Validation 回答“调查哪些对象属于本次任务范围”。

Evidence Gate 回答“某个事实是否有足够的来源证据”。

通过 Scope Validation 并不表示 Evidence 充分；通过 Evidence Gate 也不表示 Scope 完整。

## Consequences

- Investigation 的结论有明确适用范围；
- Report 不容易把局部发现误写成全域结论；
- Mission 改变后的 stale scope 可以被确定性识别；
- Scope provenance 可以被审计。

代价是需要保存 scope snapshot / version，并在 Mission 改变时显式 invalidation。

## Rejected Alternatives

### A. 把 Scope 完全作为 Mission 文本的一部分

**Rejected.** 目标和对象边界的生命周期不同；Scope 需要独立 validation。

### B. 让 Agent 判断 Scope 是否可信

**Rejected.** Scope 是系统边界，不能把 authoritative transition 交给概率模型。

### C. 生成报告时再检查 Scope

**Rejected.** 太晚。调查阶段就可能已经产生超出范围的 Evidence 和结论。

## Related

- ADR-011：Mission Contract 作为 Investigation 任务边界
- ADR-014：概率 Agent 与确定性 Gate 的控制边界
