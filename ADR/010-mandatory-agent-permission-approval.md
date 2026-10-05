# ADR-010：Agent 权限默认必须人工确认

- Status: Accepted
- Date: 2026-10-05
- Decision type: Security / Agent execution control

## Context

现代化数据工作台中的 Agent 可以读取文件、搜索目录、执行命令、写入工作区以及调用 MCP 工具。这些操作可能影响用户本地文件和外部系统，因此权限控制属于 Agent Runtime 的安全边界，而不是单纯的 UI 偏好。

此前实现支持两种模式：

- `permission)：权限请求进入工作台，由用户逐次确认。
- `allow_all`：Agent 自动批准普通权限请求。

此前 Investigation 默认使用 `allow_all`。这与工作台“Agent 代替用户执行操作、但用户保持最终控制权”的交互模型不一致，也会使用户误以为已经存在人工确认，实际上普通操作已经被自动批准。

同时，已有 UI 提供“后续都允许”选项。对于本项目的当前安全模型，这会把一次人工决定扩大为整个 Copilot Session 的权限授权，不符合“必须确认”的要求。

## Decision

Agent 权限采用 **mandatory human approval** 模型：

1. 新 Investigation 默认使用 `permission`。
2. 后端不得因为缺少 `permissionMode` 而回退到 `allow_all`。
3. 现有历史配置中的 `allow_all` 在读取时迁移为 `permission`；不再继续支持 Allow All 作为有效运行模式。
4. 主对话区的权限请求必须等待用户明确选择“允许这次”或“拒绝”。
5. 不提供“后续都允许”作为用户操作；每个权限请求都必须重新确认。
6. Copilot SDK 的 permission request 仍由当前 runtime bridge 转交工作台 pending-permission UI，不绕过人工确认。
7. Agent 的自动连续执行（auto continuation）不能绕过权限确认。
8. 权限决定不写入 Investigation 的持久化配置；一次允许只对当前权限请求生效。

## Consequences

### Positive

- 用户始终知道 Agent 当前准备执行什么操作。
- 不会因为默认配置或历史配置导致 Agent 静默获得本地文件、shell 或 MCP 操作权限。
- “允许一次”与“持续授权”边界清晰。
- auto continuation 仍然可以工作，但每次遇到受控操作都会回到人工确认。

### Negative

- 长时间调查可能产生更多权限确认。
- 大量只读操作的交互成本会明显增加。
- 后续如果需要批量授权，需要设计显式、可审计且范围明确的 capability/scope，而不是恢复 Allow All。

## Rejected alternatives

### Allow All 默认

拒绝。默认自动授权无法满足 mandatory human approval 的安全要求。

### “后续都允许”复用 Copilot Session 权限

拒绝。Copilot SDK 的 `approve-for-session` 是 session 级授权，会扩大一次人工判断的权限范围；当前项目不接受这种隐式扩权。

### 通过 prompt 告诉 Agent“先征求用户同意”

拒绝。Prompt 不是 runtime authorization boundary。真正的权限控制必须在 SDK permission callback / pending permission handler 层实现。

## Appendix A：形成决定时的分析记录（仅供参考）

本次问题由实际 UI 行为暴露：工作台已经能够显示 “Agent 需要执行操作” 的确认卡片，但普通操作仍存在自动批准路径。

代码检查确认：

- `src/investigation/control.ts` 的新 Investigation 默认 `permissionMode: 'allow_all'`。
- `src/agent/copilot.ts` 在没有显式 permission mode 时也默认 `allow_all`，并在普通 permission request 上调用 `approveAll`。
- `src/agent/copilot.ts` 已经存在 `pendingCopilotPermissions` 和 `respondToCopilotPermission()`，说明逐次人工确认的 runtime 基础已经存在。
- 当前 UI 同时提供 “按需确认” 与 “Allow All Access from Agent”，并在按需确认模式下提供“后续都允许”。
- Copilot SDK 本身支持 `approve-once` 和 `approve-for-session`；后者与本项目要求的 mandatory approval 不一致。

因此本次修改不是新增另一套权限系统，而是收紧现有 permission boundary：默认进入 pending → 用户明确决定 → 当前 request 完成；不再存在普通请求的自动批准和 session 级持续授权路径。

**附录仅供历史参考，不是规范文本。**
