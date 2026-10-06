# ADR-020：Runtime Event、HTTP Error 与 Durable Data 的统一 Contract

- Status: Accepted
- Date: 2026-10-06

## Context

SSE、Trajectory、HTTP errors、Discovery snapshots 和其它 durable data 过去混合使用手写 interface、宽泛 unknown 和 type assertion。坏数据可能被解释成“不存在”，不同错误响应也缺乏稳定 code。

## Decision

1. SSE 使用 discriminated-union runtime contract；server 发送前和 web 接收后验证。
2. Trajectory event / response 使用同一 canonical schema。
3. HTTP errors 统一为 code、error 和 optional details。
4. Mission / Scope / Workflow 等业务前置条件失败使用可区分的 4xx。
5. Durable snapshots / artifacts 读取必须经过 runtime schema validation。
6. malformed durable data 不得静默当成 missing；必须可观察。
7. 一个持久化对象只能有一个 schema owner。

## Consequences

- Contract 变化会被测试捕获。
- 数据损坏和业务阻断更容易诊断。
- 增加少量 validation 成本。

## Related ADRs

ADR-004、ADR-014、ADR-016、ADR-017。