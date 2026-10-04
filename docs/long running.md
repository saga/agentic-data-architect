你这个感觉是对的，而且问题**不主要在 UI，而在 Agent Runtime 的执行模型**。

我看了现在 `main` 的代码，核心问题非常明确：

> **现在的系统实际上是“用户驱动的单轮 Agent”，而不是“Agent 驱动的 Long-running Agent”。**

所以现在的体验自然会变成：

```text
用户：帮我分析这个系统
        ↓
Agent：查了一些东西
        ↓
Agent：告诉你一个结论 + 推荐下一步
        ↓
Agent：停止
        ↓
用户：继续
        ↓
Agent：再查一步
        ↓
Agent：又停止
        ↓
用户：继续
        ↓
...
```

这和你希望的：

```text
用户：帮我分析这个系统
        ↓
Agent 自己规划
        ↓
发现需要代码扫描
        ↓
扫描
        ↓
发现需要 SQL lineage
        ↓
继续查
        ↓
发现业务定义缺失
        ↓
继续找文档 / Confluence
        ↓
发现两个来源冲突
        ↓
继续验证
        ↓
形成结论
        ↓
发现还有关键 unknown
        ↓
继续调查
        ↓
直到：
  1. 当前目标已经完成
  2. 确实需要用户决策
  3. 确实缺少外部输入
        ↓
才停
```

完全是两种架构。

---

# 现在最关键的几个问题

## 1. `answerQuestion()` 天生就是“一问一答”

现在核心入口是：

```ts
const raw = await askCopilot(...)
```

然后马上：

```ts
const parsed = parseAgentAnswer(raw, ...)
```

然后：

```ts
saveConversationMessage(...)
finishConversationTurn(...)
return result
```

也就是说：

**Copilot 一旦 `sendAndWait()` 返回，这一轮就结束。**

而 `askCopilot()` 里面又是：

```ts
const final = await session.sendAndWait(
  { prompt: input.prompt },
  config.turnTimeoutMs
);
```

这就是整个问题的根源。

你虽然保存了：

```ts
copilotSessionId
```

也支持：

```ts
resumeSession(...)
```

但它只是让：

> **下一次用户输入可以继续以前的 Agent Session。**

它并没有让：

> **Agent 自己继续发起下一轮工作。**

所以现在的 `Copilot Session` 是“可恢复上下文”，不是“long-running execution”。

---

# 2. 现在 Prompt 反而在鼓励 Agent “给下一步”

这个地方尤其明显。

现在 system prompt 有：

> `followUpQuestions` 用来给前端生成“继续调查”的可点击动作。

而且明确要求：

> `routeOptions` 用来生成“地图之外的可选路线”。

于是 Agent 很容易形成这种行为：

```text
我已经完成了当前问题
→ 我知道下一步应该干什么
→ 把下一步写进 followUpQuestions
→ 返回 JSON
→ 结束
```

这其实是一个**Agent-as-advisor** 模式。

不是：

> Agent 自己执行任务。

而是：

> Agent 告诉用户 Agent 接下来应该做什么。

这是你现在“AI自主性差”的核心原因之一。

---

# 3. Workflow 也被错误地当成了“阶段导航”

现在的设计理念本身没错：

```text
Workflow
    ↓
规定大阶段
```

例如：

```text
intake
 ↓
estate-map
 ↓
data-truth
 ↓
investigate
 ↓
current-state
 ↓
target
```

这个应该保留。

问题是当前 Runtime 没有真正实现：

> **Agent 在一个阶段里面可以连续执行很多动作，直到这个阶段真正完成。**

现在实际上接近：

```text
Workflow node
    ↓
一次 Agent turn
    ↓
判断
    ↓
返回
```

而应该是：

```text
Workflow node
    ↓
Agent loop
    ├─ inspect
    ├─ search
    ├─ grep
    ├─ read
    ├─ SQL
    ├─ compare
    ├─ validate
    ├─ update evidence
    ├─ reassess
    ├─ 再调查
    ├─ 再验证
    └─ 判断 complete
           ↓
      Workflow transition
```

**Workflow 应该是 Agent 的长期目标约束，不应该是“一轮聊天之后的导航提示”。**

---

# 4. 现在的 `followUpQuestions` 其实是一个架构补丁

这个字段：

```ts
followUpQuestions
```

本意是好的。

但是现在它承担了一个本不该承担的责任：

> **代替 Agent 自己继续执行。**

于是 UI 才会出现：

```text
Agent：
目前发现 A。

下一步可以：
[查 B]
[查 C]
[查 D]
```

这很像 Copilot Chat，而不是 DeepAgent。

真正的 Agent 应该是：

```text
Agent：
发现 A。

[内部继续执行]
→ 查 B
→ 查 C
→ 验证 D
→ ...
```

只有到了：

```text
我无法继续，因为缺少业务定义
```

才出现：

```text
需要你确认：

“Position 的 valuation date 是交易日还是结算日？”

[输入]
```

---

# 5. 你现在其实已经有 Long-running 所需要的很多零件

这也是为什么我认为**不用推翻重做**。

目前已经有：

* Copilot Session persistence
* `copilotSessionId`
* SQLite conversation
* Investigation state
* Evidence
* Unknowns
* Workflow
* Journey execution
* Tool execution
* trajectory
* Stop
* permission handling
* `ask_user`
* session compaction
* context persistence
* stale turn recovery

甚至还有：

```ts
requestAbort()
```

和：

```ts
shouldAbort()
```

所以基础设施已经相当接近了。

**缺的是最关键的一层：Agent Run Loop。**

---

# 应该怎么改

我建议不要搞一个很复杂的 orchestration framework。

就增加一层：

```text
Investigation Run
       ↓
Agent Loop
       ↓
Copilot Session
       ↓
Tools / Skills / MCP
       ↓
Evidence / Findings
       ↓
Agent Loop 再判断
       ↓
继续 / 等用户 / 完成
```

核心应该变成：

```ts
runInvestigation()
```

而不是现在只有：

```ts
answerQuestion()
```

---

# 一个真正合理的执行模型

例如用户：

> 帮我分析 ISS proxy voting 旧系统，找清楚数据来源和投票流程。

应该发生：

### Run #1

Agent：

```text
目标：搞清楚旧系统数据来源和投票流程

当前阶段：estate-map

开始扫描：
- Excel
- SQL
- Java
- 邮件模板
- ISS portal integration
```

然后自己调用：

```text
glob
grep
view
bash
project_discover
```

---

### Run #2

发现：

```text
Vote data
  ↓
Excel
  ↓
内部系统
  ↓
ISS
```

但发现一个问题：

```text
Excel 中的 security identifier
和
内部 Position identifier
对应关系不明确
```

Agent 不应该返回：

> 下一步建议查 identifier mapping。

而应该：

```text
继续调查 identifier mapping
```

然后自己：

```text
grep
→ 找 mapping table
→ 找 SQL
→ 找 transformation
→ 找配置
```

---

### Run #3

发现：

```text
ISIN → internal security_id
```

但两个 SQL 逻辑不一致。

继续：

```text
查调用方
→ 查时间范围
→ 查实际数据
→ 对比结果
```

---

### Run #4

最后发现：

```text
业务定义缺失：
某个 voting status 的 A/R/P 含义无法从代码确认
```

这时候才停：

> 我已经查完代码、SQL 和配置，但这个定义在现有资料里没有找到。需要你确认 A/R/P 分别代表什么。

这才是合理的 Human-in-the-loop。

---

# 什么时候 Agent 才应该停？

我建议定义成非常简单的 4 种原因。

```text
CONTINUE
继续自己干

WAIT_USER
确实需要用户输入/决策

WAIT_PERMISSION
确实需要权限批准

DONE
目标完成
```

而不是：

```text
Agent 回答了一次
→ DONE
```

这是现在最大的错误。

---

# 更重要的是：不要让模型自己随便决定 DONE

可以让模型输出：

```json
{
  "status": "continue",
  "reason": "还有两个关键 unknown 没有解决"
}
```

或者：

```json
{
  "status": "wait_user",
  "reason": "缺少 Position valuation date 定义"
}
```

或者：

```json
{
  "status": "done",
  "reason": "当前阶段 completeWhen 已满足"
}
```

但最终 `DONE` 最好由：

```text
Agent judgment
        +
Workflow facts
        +
Evidence / Unknowns
```

共同决定。

不能因为模型说：

```json
"status": "done"
```

就真的结束。

---

# Workflow 的正确角色

你现在的 Workflow 应该重新定位成：

> **Agent 的长期任务边界。**

比如：

```text
estate-map

目标：
建立系统地图

Agent 可以自由：
  查代码
  查 SQL
  查配置
  查数据
  查文档
  建 Evidence
  反复验证

什么时候离开：
  current-state facts 满足 estate-map 的完成条件
```

而不是：

```text
estate-map
→ Agent 回答一次
→ routeOptions
→ 用户点击下一步
```

---

# JourneyMap 也应该随之改变

现在 JourneyMap 很容易给用户一种感觉：

```text
现在在这里
↓
下一步点击这里
↓
再点这里
```

这实际上又强化了“工作流导航器”的感觉。

应该变成：

```text
当前阶段
  ● 正在调查

Agent 正在自己推进：
  ✓ 扫描代码
  ✓ 找到 12 个数据集
  ✓ 解析 34 条 SQL
  ● 正在确认 lineage
  ○ 业务定义
```

而不是让用户承担：

```text
[继续调查]
[下一步]
[查这个]
[查那个]
```

这些应该降级成：

> **Agent 自己做。**

---

# `routeOptions` 也应该降级

现在：

```ts
routeOptions
```

被放得太重要了。

它应该只用于真正存在分叉时：

```text
发现两个合理方向：

A. 先查 Position lineage
B. 先查 Voting business rule
```

而且这时候 Agent 可以自己选择一个默认方向继续：

```text
我先查 A，因为它会影响后面的 B。
```

用户不需要每次点。

只有两个方向涉及**业务决策**的时候：

```text
A：继续沿旧系统逻辑迁移
B：重新定义业务规则
```

才问用户。

---

# 所以你现在真正缺的是这一层

最终我建议架构变成：

```text
                 User Goal
                    │
                    ▼
             Investigation Run
                    │
                    ▼
             ┌──────────────┐
             │ Agent Loop   │
             └──────┬───────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      Plan        Tools       Skills
                    │
                    ▼
                 Evidence
                    │
                    ▼
              Re-evaluate
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
       CONTINUE  WAIT_USER   DONE
          │         │
          └────┐    │
               ▼    ▼
          Agent Loop
```

Workflow 放在旁边：

```text
Workflow
  ↓
告诉 Agent：
“当前长期目标是什么”
“什么时候算完成”
“什么时候应该回退”
```

而不是：

```text
Workflow
  ↓
告诉用户：
“下一步点什么”
```

---

# 我认为现在最值得改的 5 个地方

按收益排序：

| 优先级    | 修改                                                   | 收益                      |
| ------ | ---------------------------------------------------- | ----------------------- |
| **P0** | `answerQuestion()` → `runInvestigation()` Agent Loop | 解决“走一步就停”               |
| **P0** | Copilot 一次返回后，根据状态自动继续下一 turn                        | 真正 Long-running         |
| **P0** | `followUpQuestions` 不再作为正常推进机制                       | 去掉“请用户替 Agent 干活”       |
| **P1** | Workflow `completeWhen` 成为长期停止条件                     | Agent 知道什么时候应该继续        |
| **P1** | `WAIT_USER / WAIT_PERMISSION / DONE` 明确区分            | Human-in-loop 只发生在真正需要时 |

而**不要**先去改 JourneyMap UI。

因为现在如果只改 UI：

```text
Agent 停
↓
UI 看起来更漂亮
↓
还是停
```

问题依旧。

---

## 一个很重要的判断

你现在这个项目已经不是“Agent 能不能调用工具”的问题了。

工具、Skill、MCP、Session、Evidence、Workflow 基本都有。

现在进入了真正的 **Agent Runtime** 问题：

> **一次用户请求，到底是一个 turn，还是一个持续运行的任务？**

目前代码把它定义成了：

```text
User Request = One Turn
```

你真正想要的是：

```text
User Request = One Run
                 ├── Turn 1
                 ├── Turn 2
                 ├── Turn 3
                 ├── ...
                 └── Turn N
```

其中：

```text
Turn = 模型的一次推理/工具循环

Run = Agent 为完成一个目标而持续工作的整个生命周期
```

**这个 `Run` 层目前基本不存在。**

这就是为什么你会明显感觉“AI 不够自主、long running 很差”。

如果接下来直接改，我会优先重构 `src/workflow/ask.ts + src/agent/copilot.ts`，增加一个很小的 `InvestigationRun/AgentLoop`，让 Agent 默认**自己连续调查到完成/真正需要人时才停**，而不是继续堆 `followUpQuestions`、route card 和“继续调查”按钮。
