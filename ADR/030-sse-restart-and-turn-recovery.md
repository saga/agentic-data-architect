# ADR-030：SSE 断线、Server Restart 与 Conversation Turn Recovery

- Status: Accepted
- Date: 2026-10-07
- Decision scope: Conversation streaming durability, graceful shutdown, browser reconnect/recovery

## Context

ADR-029 只覆盖 Agent 正常进入 catch/finally 后的失败收尾。Server 进程被停止、重启、崩溃或 SSE 连接先断开时，原来的 catch 路径可能根本没有机会执行。

原来的 UI 把 assistant 文本、秘书陪伴提示和执行状态放在 transient React/SSE state 中；SQLite 有 running turn，但服务重启只把它标记为 aborted，没有同时生成可见的 assistant recovery message，因此刷新后原来的秘书内容会消失。浏览器还会把 SSE transport failure 直接显示成 network error / Failed to fetch。

## Decision

1. **SSE 永远不是 Conversation 的 source of truth。**
   - user message 在开始执行前持久化；
   - 流式 assistant/秘书可见内容维护 server-side turn draft；
   - 正常成功、失败、Stop 或 recovery 收尾后形成正式 conversation message，并清理 draft；
   - `conversation_turns.assistant_draft` 只是恢复状态，不建立第二套消息存储。

2. **Turn recovery 必须幂等。**
   - startup recovery 将遗留的 `running -> aborted`；
   - 使用 `<turnId>:assistant:failure` 生成 assistant recovery message；
   - 有 draft 时保留已生成的可见内容；没有 draft 时至少保留明确的人话中断提示；
   - recovery 不删除、回滚或重复提交 user message。

3. **Server graceful shutdown 顺序固定。**
   - 先枚举 active turns；
   - 先向 active Agent runtime 发出 Stop；
   - 先等待 turn 的 abort/failure/completed finally 完成 durable write（有明确超时，超时后由下一次 startup recovery 接管）；
   - 再关闭 HTTP/Vite；
   - 最后关闭 SQLite 和其它本地资源。
   服务生命周期关闭不是业务级 Agent Stop；如果 Agent 无法及时退出，下一次启动仍由 durable recovery 接管残留 running turn。

4. **浏览器区分 Stop、Agent failure 与 transport disconnect。**
   - 用户点击 Stop 是正常操作，不显示 network error；
   - SSE 意外断开先进入 recovery，轮询 execution state，服务恢复后 reload durable conversation；
   - recovery 期间不能自动创建第二个 turn；
   - 服务长期不可达时才显示连接错误，并明确告诉用户已有 turn 可在服务恢复后恢复查看。

5. **Stop 是一等用户操作。**
   Investigation Composer 执行中显示明确的“停止”按钮；Stop API 使用当前 `turnId`，同时触发应用层 abort 和 runtime-specific abort。

## Consequences

刷新页面、SSE 断线、Server restart 或手动 Stop 后，聊天记录都回到 durable conversation，不会因为 transient SSE state 被清空而丢掉已经显示的秘书内容。

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
