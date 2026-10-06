# ADR-017：Investigation Artifact 的代际一致性与读取/生成分离

- Status: Accepted
- Date: 2026-10-06

## Context

Mission、Scope 和 Investigation facts 会持续变化，而 Report、Assessment、Modernization Plan 等成果保存在 workspace。若 artifact 不记录来源代际，就可能出现“新任务读取旧结果”的污染。

同时，Result 页面刷新不应该隐式触发 LLM generation 或 Reviewer。

## Decision

1. 正式 artifact 必须保存 missionFingerprint、scopeFingerprint、sourceRevision 和自身 version。
2. provenance 由服务端根据 Investigation 当前状态确定性计算。
3. artifact provenance 与当前 Mission、Scope 或 source revision 不一致时，状态为 stale，不能当成当前结果。
4. GET 只读取现有 artifact；生成 / regenerate 是显式动作。
5. Reviewer result 必须绑定 artifact hash 和 source revision。
6. missing、stale、blocked、error 是四种不同状态，UI 必须保留这种语义。
7. 没有 provenance 的旧 artifact 视为 stale。

## Consequences

- 避免跨任务和跨代际污染。
- Result 页面成为纯读取操作，不再因为刷新而产生模型调用。
- Artifact 可以被审计到生成时的调查事实。

## Related ADRs

ADR-010、ADR-011、ADR-015、ADR-016。