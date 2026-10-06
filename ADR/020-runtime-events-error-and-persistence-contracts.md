# ADR-020：Runtime Event、HTTP Error 与 Durable Data 的统一 Contract

- Status: Accepted
- Date: 2026-10-06

## Context

SSE、Trajectory、HTTP errors、Discovery snapshots 和其它 durable data 过去混合使用手写 interface、宽泛 unknown 和 type assertion。坏数据可能被解释成“不存在”，不同错误响应也缺乏稳定 code。

## Decision

1. SSE 使用 discriminated-union runtime contract；server 发送前和 web 接收后验证。
2. Trajectory event / response 使用同一 canonical schema。
3. HTTP errors 统一为 code、error 和 optional details，并由 Web API client 统一解析成结构化 `ApiError`；所有非 2xx 的 JSON/text API response 都通过同一个 `ApiRequestError` 边界向 UI 传播，不能退化成普通 `Error` 字符串。
4. Mission / Scope / Workflow 等业务前置条件失败使用可区分的 4xx。
5. Durable snapshots / artifacts 读取必须经过 runtime schema validation。
6. Trajectory / Workflow run event 的已知 nested payload 必须通过 type-specific schema 校验；known payload schema 使用 strict object，只有真正 provider-opaque 的字段（例如 tool arguments / provider error payload）允许保留 `z.unknown()`。不能因为外层 event 合法就接受任意 nested object。
7. malformed durable data 不得静默当成 missing；必须可观察。
8. 一个持久化对象只能有一个 schema owner。
9. Assessment / Modernization / Report 对外都使用同一套 `missing / stale / current / blocked / error` lifecycle；读接口只返回现有状态，不隐式 regenerate。

## Consequences

- Contract 变化会被测试捕获。
- 数据损坏和业务阻断更容易诊断。
- Web 可以依据稳定 error code/details 做程序化处理。
- 增加少量 validation 成本。

## Related ADRs

ADR-004、ADR-014、ADR-016、ADR-017。