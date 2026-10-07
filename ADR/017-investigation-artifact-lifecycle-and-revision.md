# ADR-017：Investigation Artifact 的代际一致性与读取/生成分离

- Status: Accepted
- Date: 2026-10-06

## Context

Mission、Scope 和 Investigation facts 会持续变化，而 Report、Assessment、Modernization Plan 等成果保存在 workspace。若 artifact 不记录来源代际，就可能出现“新任务读取旧结果”的污染。

同时，Result 页面刷新不应该隐式触发 LLM generation 或 Reviewer。

## Decision

1. 正式 artifact 必须保存 missionFingerprint、scopeFingerprint、sourceRevision 和自身 version。
2. 如果 Artifact 使用 Discovery Snapshot，还必须保存 `discoveryRunId` 和 `discoveryScopeFingerprint`；二者共同绑定本次 Artifact 使用的 Discovery generation。
3. provenance 由服务端根据 Investigation 当前状态和所捕获的 Discovery Snapshot 确定性计算；当 Artifact 使用 Discovery Snapshot 时，`discoveryRunId` 与 `discoveryScopeFingerprint` 也必须参与 freshness 判断。
4. artifact provenance 与当前 Mission、Scope、Discovery generation 或 source revision 不一致时，状态为 stale，不能当成当前结果。

Freshness 比较必须基于同一套 canonical provenance tuple，而不是由不同 artifact loader 各自选择字段：

```text
missionFingerprint
scopeFingerprint
sourceRevision
[discoveryRunId, discoveryScopeFingerprint]
```

方括号中的 Discovery identity 仅在该 Artifact 实际依赖 Discovery Snapshot 时参与比较。不能用 `latest`、timestamp 或 filename 替代 generation identity。
5. GET 只读取现有 artifact；生成 / regenerate 是显式动作。

6. Artifact generation 的正式顺序固定为 `capture → deterministic gate → build → independent review → persist`。生成过程中可以产生临时内存内容，但未通过必要 Review 的 artifact 不应被标记为 current；Review 失败 / unavailable 时应保持 blocked 或对应的未发布状态。

7. Reviewer result 必须绑定 artifact hash 和 source revision。
8. Reviewer result 必须绑定 artifact hash 和 source revision。

Reviewer input 必须来自同一 captured source snapshot。Reviewer 不得在 artifact 生成完成后再次读取 workspace latest state 补充上下文，否则会破坏 artifact / review 的 revision binding。
9. Report、Assessment、Modernization 使用同一套 `missing / stale / current / blocked / error` lifecycle 语义；某一类 Artifact 当前不适用的状态仍然保留 contract compatibility。

read API 返回的是生命周期状态，而不是通过 `plan === null` / `report === null` 等对象存在性让 Web 自己推断状态；同一状态在不同 resource route 上含义不能改变。
10. Artifact generation 必须先捕获一份 immutable source snapshot，再由同一份 source snapshot 生成内容、provenance 和 Reviewer input；生成期间的新状态不应混入本次 Artifact。对已有下游 Artifact 的引用也必须基于同一份 captured Investigation/Discovery source 判断是否 current，不得在生成过程中重新读取 latest state 后混入。所有依赖 artifact / review 的读取都必须显式接收 captured source，不能在 capture 之后重新 `loadInvestigation` / `loadLatestSnapshot`。

当前 workspace / filesystem 架构下，不要求数据库事务；需要的是明确的 `capture → deterministic gate → build → review → persist` 边界。捕获完成后，本次 generation 只能读取 captured snapshot；生成期间发生的 Investigation mutation 只能影响下一次 generation。
11. 没有 provenance 的旧 artifact 视为 stale。

Artifact 只允许复用与当前 Scope 兼容的 Discovery Snapshot。原始 Evidence 可以跨 Mission change 保留并复用，但 Claims、Findings 和正式 Artifact 必须针对当前 Mission generation 重新计算或验证。

## Consequences

- 避免跨任务和跨代际污染。
- Result 页面成为纯读取操作，不再因为刷新而产生模型调用。
- Artifact 可以被审计到生成时的调查事实。
- UI 可以明确区分“从未生成”和“已有结果但因来源变化而过期”。

## Related ADRs

ADR-010、ADR-011、ADR-015、ADR-016。