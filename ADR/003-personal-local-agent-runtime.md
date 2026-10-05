# ADR-003：默认运行模型采用个人本机 Agent

- Status: Accepted
- Date: 2026-10-05

## Context

本项目当前目标是个人生产力工具，而不是多人共享的 Agent Server。Investigation、workspace、DuckDB 和 Agent session 都围绕单用户本机运行设计。

## Decision

默认运行模型：

- 单用户；
- 本机 workspace 隔离；
- Copilot SDK 使用 `mode: "copilot-cli"`；
- Agent 使用 Copilot CLI 自带工具、Skill 和 MCP；
- capability Skill 由 Agent 根据任务自动发现；
- Workflow Skill 只有在用户明确选择工作路线后才作为当前路线预加载；
- 用户主动接入的额外 MCP 才写入 Investigation control。

配置页用于调整 Investigation 的输入和用户选择，而不是让用户每次手工组装一个 Agent。

如果未来改成多人共享服务，必须重新设计 workspace isolation、工具/MCP allowlist 和权限边界，不能直接继承本 ADR 的本机信任模型。

## Consequences

实现保持简单，Agent 的原生能力可以直接使用。

同时，代码不能假设当前单用户模型天然满足未来的多租户安全需求。
