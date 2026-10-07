# ADR-003：默认运行模型采用个人本机 Agent

- Status: Accepted
- Date: 2026-10-05

## Context

本项目当前目标是个人生产力工具，而不是多人共享的 Agent Server。Investigation、workspace、DuckDB 和 Agent session 都围绕单用户本机运行设计。

## Decision

默认运行模型：

- 单用户；
- 本机 workspace 隔离；
- Agent runtime 通过统一的 provider/runtime abstraction 接入；
- 当前可用 runtime 包括 Copilot CLI 和 OpenCode；
- runtime 只负责模型会话、工具执行和 provider-specific execution，不拥有 Investigation 的业务状态；
- OpenCode model 统一通过官方 `opencode run` headless CLI 执行，不直接通过 `opencode serve` HTTP API 驱动模型；
- capability Skill 由 Agent 根据任务自动发现；
- Workflow Skill 只有在用户明确选择工作路线后才作为当前路线预加载；
- 用户主动接入的额外 MCP 才写入 Investigation control。

配置页用于调整 Investigation 的输入和用户选择，而不是让用户每次手工组装一个 Agent。

OpenCode 的 `opencode serve` 可以继续用于本机模型发现等辅助能力，但不属于 Investigation 的模型执行链。
由于 CLI 没有独立的 system-prompt 参数，本项目当前把原有 system prompt 与 Mission / Workflow instruction 一起组成 CLI message；不因此引入临时 Agent 配置文件或第二套 prompt runtime。

如果未来改成多人共享服务，必须重新设计 workspace isolation、工具/MCP allowlist、credentials 和权限边界，不能直接继承本 ADR 的本机信任模型。

## Consequences

实现保持简单，同时可以在 Copilot 与 OpenCode 之间切换，而不把 runtime 选择扩散到 Investigation domain logic。

代码不能假设当前单用户模型天然满足未来的多租户安全需求。

## Related

- ADR-005：Workflow 与 Skill 分离
- ADR-014：Agent 不直接拥有关键状态转换权
