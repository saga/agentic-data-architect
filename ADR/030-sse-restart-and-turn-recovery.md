# ADR-030：SSE 断线、Server Restart 与 Conversation Turn Recovery

- Status: Accepted
- Date: 2026-10-07
- Decision scope: Conversation streaming durability, graceful shutdown, browser reconnect/recovery

## Context

ADR-029 解决的是“Agent 正常进入 catch/finally 后的失败收尾”。但 Server 进程被停止、重启、崩溃或 SSE 连接先断开时，原来的 catch 路径根本没有机会执行。

原来的 UI 把 assistant 文本、秘书陪伴提示和执行状态放在 transient React/SSE state 中；SQLite 只有 running turn、user message 和最终 assistant message。服务重启时虽然会把 running turn 标记为 aborted，但没有生成可见的 assistant recovery message，因此刷新后用户会看到原来的秘书内容消失。浏览器还会把 SSE transport failure 直接显示成“network error / Failed to fetch”。

## Decision

1. **SSE 永远不是 Conversation 的 source of truth。**
   - user message 在开始执行前持久化；
   - 流式 assistant/秘书可见内容必须维护 server-side turn draft；
   - 正常成功或异常收尾后清理 draft，并形成正式 conversation message；
   - `conversation_turns.assistant_draft` 只用于恢复，不作为第二套 conversation。

2. **Turn recovery 必须是幂等的。**
   - startup recovery 将遗留的 `running -> aborted`；
   - 使用 `<turnId>:assistant:failure` 生成可见的 assistant recovery message；
   - 有 draft 时保留已生成的可见内容；没有 draft 时至少保留明确的人话中断提示；
   - recovery 不删除、回滚或重复提交 user message。

3. **Server graceful shutdown 的顺序固定。**
   - 先枚举当前 active turns；
   - 先向 active Agent runtime 发出 Stop；
   - 等待 turn 进入正常 abort/failure 收尾并完成 durable write；
   - 再关闭 HTTP/Vite；
   - 最后关闭 SQLite 和其它本地资源。
   这样手动关闭服务不再成为停止 Agent 的替代手段，也不会因为 DB 先关闭而丢掉失败消息。

4. **浏览器必须区分 Stop、Agent failure 与 transport disconnect。**
   - 用户点击 Stop 是正常操作，不显示 network error；
   - SSE 意外断开先进入 recovery，轮询 execution state，等服务恢复后 reload durable conversation；
   - recovery 期间不能自动创建第二个 turn；
   - 只有服务在恢复窗口内始终不可达时才显示连接错误，并明确告诉用户重启服务即可恢复已有 turn。

5. **Stop 是用户可见的一等操作。**
   - Investigation Composer 在执行中显示明确的“停止”按钮；
   - Stop API 使用当前 `turnId`，同时触发应用层 abort 标记和 runtime-specific abort；
   - Stop、SSE disconnect recovery 和 graceful shutdown 共用同一套 Conversation Turn 生命周期语义。

## Consequences

用户刷新页面、SSE 断线、Server restart 或手动 Stop 后，聊天记录都能回到 durable conversation；不会因为 transient SSE state 被清空而把秘书已经显示过的内容丢掉。

UI 不再把 Server restart 或正常 Stop 当成普通网络错误。

运行时需要维护一个有长度上限的 turn draft，但不需要建立第二套消息存储。

## Rejected alternatives

### 只在前端缓存 streaming bubble

拒绝。刷新、重启和页面重新挂载都会丢失 transient state。

### 只把 running turn 标成 aborted

拒绝。只有状态变化，没有 assistant recovery message，用户仍然看不到已经发生过的交互。

### 继续让用户关闭 Server 来停止 Agent

拒绝。Server shutdown 是基础设施生命周期，不应成为业务级 Agent Stop API。

## Related ADRs

- ADR-009：App shell 与 UI state separation
- ADR-016：API contract ownership and view models
- ADR-020：Runtime Event、HTTP Error 与 Durable Data Contract
- ADR-029：Conversation Turn 在 Agent 失败时仍必须可见