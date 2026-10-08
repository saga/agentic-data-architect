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
- `bypassPermissions` 仅用于安全的 Investigation capability allowlist；产品层 `allow_all` 不能扩大 CodeBuddy capability；宿主 Mission Action Gate 仍负责业务动作边界；
- built-in tools 仅允许 `Read` / `Glob` / `Grep` / `AskUserQuestion` / `Skill`；禁止 `Write` / `Edit` / `Bash` / `Task` 等宿主修改/执行能力；
- Investigation MCP 和 Graphify MCP；
- 现有 Workbench custom tools 通过 CodeBuddy SDK `createSdkMcpServer` / `tool` 暴露为 in-process MCP，不复制业务 tool implementation；
- `query({ resume: sessionId })` 用于同一 Runtime/model 的连续阶段；
- 由宿主组合的 Mission / system / Workflow prompt；system prompt 使用 SDK `systemPrompt`，而不是把宿主规则伪装成用户消息。

SDK 的默认 filesystem isolation 保持，不自动加载用户或项目的 CodeBuddy settings；另外由应用层显式限制 built-in tool 和 workspace path，避免第二套 Skills / MCP / permission source 改变本项目控制边界。完整 authority boundary 见 ADR-031。

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


### 7. Provider catalog and health state

Provider preference and provider availability are different facts:

- Global Agent configuration owns the preferred Runtime; the application fallback order is the single source of ordering.
- `GET /api/agent/catalog` is the canonical provider/model catalog used by the new-Investigation UI and server-side Session creation. The legacy `/api/copilot/models` route is only a model-list projection of that catalog.
- Copilot and OpenCode availability comes from live discovery. CodeBuddy's allowlist means “configured candidate”, not a claim that authentication/quota has already been verified.
- Actionable quota exhaustion, authentication failure and connection failure are persisted in `.data/agent-provider-health.json`. Known unavailable providers are skipped for subsequent calls and new sessions; a confirmed model success or explicit user retry clears the marker. Skill, prompt, tool and business errors must not poison provider health.
- If the preferred Runtime is known to be unavailable, new Investigation creation chooses the first usable Runtime in the canonical fallback order. The Global preference itself is not silently rewritten. If no Runtime is usable, creation is blocked with provider-specific diagnostics.
- Server console records use ISO timestamps and severity levels. Startup logs the effective configuration and provider snapshot; HTTP requests, turn lifecycle, model attempts, failures and fallback transitions carry investigation/turn/runtime context where available.

### 6. Copilot 模型分层

Copilot Runtime 使用两档明确的模型策略：

- `claude-sonnet-5.5`：普通 Investigation、Discovery、Synthesis、Report、Review 等实质性工作；
- `claude-haiku-5.5`：Jev Smart Function 以及明确标记为简单、高频、结构化判断的调用。

`COPILOT_MODEL` 和 `COPILOT_SIMPLE_MODEL` 是部署配置，默认分别为上述两个模型。Smart Function 不继承普通 Agent 的模型配置，避免高频判断意外消耗 Sonnet；普通 Agent 也不使用 `auto`，保证 Trajectory、成本和质量分析具有确定的模型维度。

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
