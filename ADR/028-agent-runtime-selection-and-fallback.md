# ADR-028：Agent Runtime 选择与 quota fallback

- Status: Accepted
- Date: 2026-10-07

## Context

当前工作台需要同时支持三种本机 Agent execution 方式：

1. GitHub Copilot SDK
2. CodeBuddy Agent SDK
3. OpenCode run headless CLI

它们的 provider、认证、session 和工具实现不同，但 Investigation 不应该知道这些 runtime 的内部细节。尤其在某个 runtime 的 quota/usage 被耗尽时，用户不应该因为 provider 限额而重新手工选择。

## Decision

### 1. Runtime 是 Investigation 的显式配置

`InvestigationControl.agent.runtime` 保存本次 Investigation 的首选 Runtime：

- `copilot-sdk`
- `codebuddy-sdk`
- `opencode-run`

Runtime 与 `agent.model` 分开。Model 不再隐含 Runtime；旧的 `codebuddy:` / `opencode:` model 引用仅用于兼容已有模型选择与 UI 展示。

### 2. Fallback 只由 Runtime 层负责

全局 `AGENT_RUNTIME_FALLBACK_ORDER` 定义优先顺序，默认：

`copilot-sdk,codebuddy-sdk,opencode-run`

一次执行从用户选择的 Runtime 开始，只向这个顺序的后方尝试，不回绕。

只有明确识别为 quota / usage exhaustion / rate-limit / HTTP 429 的错误才触发自动 fallback。正常工具错误、Mission Gate 错误、业务逻辑错误不能被另一种 Runtime 静默覆盖。

Fallback 不修改 Investigation 中保存的首选 Runtime，也不需要用户确认。

### 3. CodeBuddy SDK

CodeBuddy 通过 `@tencent-ai/agent-sdk` 的 `query()` 使用：

- Investigation workspace 作为 `cwd`；
- 当前模型；
- `bypassPermissions` 与宿主 Mission Action Gate；
- Investigation MCP 和 Graphify MCP；
- 现有 Workbench custom tools 通过 CodeBuddy SDK `createSdkMcpServer` / `tool` 暴露为 in-process MCP，不复制业务 tool implementation；
- `query({ resume: sessionId })` 用于同一 Runtime/model 的连续阶段；
- 由宿主组合的 Mission / system / Workflow prompt；system prompt 使用 SDK `systemPrompt`，而不是把宿主规则伪装成用户消息。

SDK 的默认 filesystem isolation 保持，不自动加载用户或项目的 CodeBuddy settings；避免第二套 Skills / MCP / permission source 改变本项目控制边界。

### 4. CodeBuddy model configuration

CodeBuddy 模型不在代码中 hardcode。

- `CODEBUDDY_MODEL_ALLOWLIST`：控制可见、可选择的模型及其顺序；
- `CODEBUDDY_DEFAULT_MODEL`：默认模型。

当前默认值是 `glm-5.3-flash`，然后 `deepseek-v4.1-flash`、`space-bunny`；这些值属于部署配置，不属于架构常量。

### 5. Session boundary

Workspace 使用 runtime-neutral Agent session slot：

- `agentSessionId`
- `agentSessionRuntime`
- `agentConfigurationVersion`

旧 `copilotSessionId` / `copilotConfigurationVersion` 保留兼容，但新 Runtime 不得把自己的 session 当作 Copilot session 使用。

Session 必须与 Runtime 和 Control version 一致才能恢复；同一 Runtime/model 的阶段继续执行使用 SDK `resume`，发生 Runtime/Configuration/model 变化时必须从新 session 开始。

## Consequences

- 新调查可以直接选择最适合的 Agent runtime。
- 默认顺序下，Copilot quota 用完后自动进入 CodeBuddy，再进入 OpenCode；如果用户直接选择 CodeBuddy，则只向后 fallback 到 OpenCode。
- Runtime implementation 可以独立演进，不污染 Investigation domain。
- CodeBuddy SDK 与 CLI 的配置加载行为被明确隔离，避免“本机能跑但 SDK 环境偷偷加载另一套 Skills/MCP”。

## Related

- ADR-003：个人本机 Agent Runtime
- ADR-005：Workflow、Skill、Tool、Agent、Human 分离
- ADR-014：Probabilistic Agent 与 Deterministic Gate
- ADR-020：Runtime events / errors / persistence contracts
