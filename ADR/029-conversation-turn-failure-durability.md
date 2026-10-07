# ADR-029：Conversation Turn 在 Agent 失败时仍必须可见

- Status: Accepted
- Date: 2026-10-07
- Decision scope: Investigation conversation durability, Agent failure handling, SSE/UI recovery

## Context

Investigation 的聊天界面同时存在两种状态：

1. SSE 实时流中的临时内容，例如正在生成的 assistant 文本和“秘书”陪伴提示；
2. SQLite conversation 中已经持久化的正式 user / assistant message。

过去的实现只在 Agent 成功完成并通过结果校验后保存 assistant message。Agent 在模型调用、工具调用、审计读取、Gate 或其它准备阶段失败时，浏览器虽然收到过部分 assistant 内容或“秘书”提示，但这些内容只存在于 transient React state。失败处理随后 reload conversation 或清空 streaming state，导致用户刚刚看到的“秘书”消息消失。

这个问题已经多次重复出现。根因不是某一个 Agent runtime，而是没有把“失败也是一次已经发生的 conversation turn”作为持久化契约。

## Decision

1. **Conversation turn 的 durability 与 Agent execution success 解耦。**
   - user message 在执行开始前持久化；
   - Agent 成功时持久化正式 assistant result；
   - Agent 失败时同样必须持久化一条 assistant failure message；
   - 失败不能通过清空 transient UI 状态来“结束”一条消息。

2. **SSE 只负责实时显示，不是 conversation 的事实来源。**
   - delta、reasoning、companion_note 和其它运行态事件可以存在于 transient UI state；
   - reload、断线恢复或执行失败后，UI 必须以 durable conversation 为基准恢复聊天记录。

3. **失败时保留用户已经看到的 assistant 内容。**
   - 已经流出的部分 assistant 文本应进入失败 assistant message；
   - 已经生成的秘书陪伴提示如果尚未形成正式 assistant message，也应保留下来；
   - 另外追加明确的人话失败提示，告诉用户这次调查没有完成、已经保留已有内容，并可以继续提问；
   - 技术错误细节仍通过统一 error event / UI error 区域展示，不把内部错误堆进正常聊天文案。

4. **失败 assistant message 必须具有稳定的 turn-scoped idempotency key。**
   - 当前使用 `<turnId>:assistant:failure`；
   - conversation store 重复收到同一个失败收尾时不得生成多条相同消息。

5. **失败收尾发生在 SSE error event 之前。**
   - server 必须先完成失败 assistant message 的 durable write，再发送 SSE error 并结束 stream；
   - 这样浏览器在收到错误并重新加载 conversation 时，已经能够看到失败消息。

6. **任何 recovery path 都不得把 durable assistant message 删除或回滚。**
   - 前端 catch / finally 可以清理 streaming state；
   - 但清理 streaming state 不能影响已经持久化的 conversation；
   - reload 后必须从 durable conversation 恢复。

7. **该规则适用于所有 Agent Runtime。**
   - Copilot SDK、CodeBuddy SDK、OpenCode Run 的 execution failure 都使用相同的 conversation failure semantics；
   - runtime adapter 不得各自定义一套“失败后 UI 怎么处理”。

## Consequences

- 用户不会因为 Agent 出错而丢失刚刚看到的秘书消息或部分回答。
- 浏览器刷新、SSE 断线和 Agent failure 都能回到同一个 durable conversation。
- UI transient state 可以安全清空，不需要承担历史消息的持久化责任。
- conversation 会多保存一条失败 assistant message；这是有意的，因为它记录了真实发生过的一次失败交互。
- Agent runtime 失败处理需要注意 durable write 的错误，但不能因为失败消息保存失败而隐藏原始 Agent error。

## Rejected alternatives

### 只在前端保留 streaming bubble

拒绝。前端状态不是 durable source，reload、切页、重新加载 session 或其它状态恢复路径都会重新以数据库 conversation 为准，因此无法可靠保证消息不丢。

### 只保存错误字符串

拒绝。这样用户刚刚已经看到的秘书提示和部分 assistant 内容仍会丢失，而且聊天记录不能准确反映当时发生了什么。

### 忽略失败，不写 assistant message

拒绝。一个已经发生且用户已经看到反馈的 turn 不应在 conversation history 中表现成“只有用户提问，没有 assistant 响应”。

## Related ADRs

- ADR-009：App shell 与 UI state separation
- ADR-016：API contract ownership and view models
- ADR-020：Runtime Event、HTTP Error 与 Durable Data Contract
- ADR-027：Investigation State 与本地分析存储边界