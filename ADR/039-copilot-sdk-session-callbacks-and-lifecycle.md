# ADR-039：Copilot SDK Session 回调与 Runtime 生命周期可靠性

- Status: Accepted
- Date: 2026-10-23

## Context

多个应用直接使用 `@github/copilot-sdk`，各自负责 client 启动、session 创建/恢复、权限审批、MCP OAuth 和 turn 取消。审查发现两类实现风险：

1. 通过修改 `CopilotClient.prototype` 注入缺省权限回调，把单个应用的权限行为施加到同一进程中的所有 SDK client；这种隐式全局副作用难以组合、测试和追踪。
2. `client.start()` 尚未完成时，服务关闭可能先清空 `starting` 或返回；原启动 Promise 随后仍能把客户端写回服务对象，造成关闭后 runtime 被重新挂起。会话恢复错误若用宽泛的 `does not exist` / `has been deleted` 匹配，也可能把 model/provider 配置问题误判为历史缺失。

Copilot SDK 的 permission callback 是 Session 配置的一部分。未提供 handler 时，SDK 可以发出权限事件并将请求留在 pending，等待宿主经 pending-permission RPC 完成决策。此行为不是隐式拒绝或自动批准。

## Decision

1. **权限策略按 Session 注入。** `onPermissionRequest` 必须在创建或恢复 Session 时由宿主显式配置。禁止通过修改 SDK 原型或其它全局 monkey patch 注入默认策略。
2. **公共 Runtime 不替业务做授权决定。** `common-agent-lib` 负责类型、调用、事件、abort 和生命周期；是否批准工具调用仍由应用依据工具面、资源范围和业务策略决定。人工审批模式可以让本 SDK client 返回 `no-result`，前提是确实存在另一个消费者可完成 pending permission RPC；没有审批消费者的服务必须 fail closed。
3. **MCP OAuth 必须有明确所有者。** 宿主若没有 OAuth 登录 UI / token broker，就在 Session 配置中返回 SDK 的 `cancelled` 结果，并告知用户外部授权要求；不得留下无限 pending 的认证请求。
4. **启动与关闭使用代次守卫。** 当 `stop()` 使正在进行的启动失效时，迟到的 `client.start()` 完成路径必须关闭其本地客户端并拒绝发布，不能复活已关闭的 Runtime。已有 turn 的事件监听和串行锁由该 turn 自己的 `finally` 收尾；关闭过程不能提前清空锁队列，让下一轮绕过同一 Session 的串行执行约束。
5. **只在确认 SDK Session 不存在时恢复为新 Session。** 会话缺失判断必须限定为 session-specific 错误（必要时结合 SDK 提供的缺失状态）；model、provider、认证、配额、参数和 transport 错误保持失败，不得通过创建新 Session 静默丢失历史。
6. **回调中的可观测性不得阻塞协议握手。** 权限/MCP auth 回调以及 client 生命周期关键路径中的遥测使用容错的 detached logging；日志故障不能阻止权限响应，也不能把已启动客户端伪装成启动失败。

## Consequences

- 应用的授权语义保持显式且可测试；不同应用可以分别使用人工审批、拒绝、一次性批准或 session-level 策略。
- 服务关闭与异步启动竞争时不会重新发布迟到的 SDK client。
- 恢复错误更容易诊断，不会把通用配置故障伪装成干净的新会话。
- 应用仍需在 create 和 resume 两条路径提供同一份有效 Session 配置，并通过服务端工具策略保护实际副作用。
- SDK 版本必须经过兼容性矩阵和回归测试后再统一升级；本 ADR 不要求未经验证地同步升级所有应用的依赖版本。

## Related ADRs

ADR-020、ADR-028、ADR-029、ADR-030。
