# ADR-016：跨层 API Contract 的唯一归属与 View Model 边界

- Status: Accepted
- Date: 2026-10-06

## Context

当前系统的跨层对象同时存在 Domain Schema、server route 返回结构、web 私有 Interface 和页面级解析。结果是同一个概念可能出现不同字段层级、枚举和 optional 语义。

此前“阶段小结”问题就是一个典型例子：Trajectory 中 checkpoint 的 canonical identity 在事件顶层，但 Web 曾按 details.id 取值，导致有效 checkpoint 被静默丢弃。

## Decision

1. 所有跨 server/web 的业务或运行时对象必须有唯一 authoritative API Contract。
2. Contract 使用 Zod runtime schema，并导出 TypeScript type。
3. Contract 必须保持 browser-safe，不依赖 Node-only、filesystem 或 server implementation。
4. Domain Model 可以比 API Contract 丰富；Server 负责把 Domain Model projection 成 API Contract。
5. Web 如需要更小的结构，只能定义显式的 View / Projection，不得重新定义同一个 canonical object。
6. HTTP response 和 SSE event 在 boundary 上必须做 runtime validation；前端不得把 as Type 当作验证。
7. HTTP error 必须通过 shared `ApiErrorSchema` 在 Web client boundary 解析，并以结构化错误对象传播；UI 不得依赖把 `Error.message` 再当作 JSON 解析。
8. 已知的 nested runtime payload（Trajectory event details、Workflow run event data、SSE payload）必须有明确 schema；provider-specific 扩展只能在明确的 extension boundary 上保留 unknown。
9. 一个概念只能有一个 canonical resource；兼容 endpoint 可以暂时存在，但不能产生第二套业务语义。

## Consequences

- 消除 server/web 类型漂移。
- UI 不再负责猜测业务字段结构。
- API schema 成为长期维护对象，需要增加少量 contract 测试。
- Web client 对业务错误保持 code/details 结构，而不是退化成字符串错误；这样调用方可以按错误语义处理，而不是按 message 文本猜测。

## Related ADRs

ADR-009、ADR-011、ADR-014、ADR-017、ADR-018、ADR-019、ADR-020。