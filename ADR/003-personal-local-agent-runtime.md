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
## Appendix A：形成决定时的分析记录（仅供参考）

这一决定是结合项目实际使用方式形成的，而不是为了预先设计 SaaS 多租户架构。

讨论中明确了几个现状：

- 用户希望给出一个目标后，让 Agent 自己判断调查步骤；
- Copilot CLI 已经提供工具、Skill 和 MCP；
- 每个 Investigation 已经有自己的 workspace、状态、trajectory 和 local DuckDB；
- 用户不应该每次创建 Investigation 都手工配置一套 capability 清单。

因此曾考虑让平台把所有工具和 Skill 显式装配给 Agent，但这会把本机工具编排工作重新搬回应用层，和 Copilot CLI 的默认能力发现机制重复。

最后确定：

```text
Investigation
   ↓
固定平台规则
   ↓
研究范围 / 用户说明
   ↓
Copilot 默认 Agent
   ↓
自带能力 + 自动发现 capability Skill
   ↓
当前 Workflow（如果用户选择）
```

另一个重要讨论是未来的多人部署。结论不是“现在按多租户来做”，而是明确知道当前本机 trust boundary 一旦失效，就必须重新设计 workspace、工具 allowlist、MCP 和 session isolation。

本附录保留讨论背景，不构成未来多人部署的详细设计。