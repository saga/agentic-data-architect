
# Agentic Data Architect：数据流、控制流与并发模型

> 2026-10-03
> 本文以当前 main 实现为准，重点检查一次 Investigation 从浏览器发起问题，到 Agent Runtime 执行、状态持久化、SSE 返回、取消、重启恢复的完整链路，以及文件状态和配置状态的竞争问题。当前 Runtime 包括 Copilot SDK、CodeBuddy SDK 和 OpenCode Run。

## 1. 结论

当前系统的核心状态分成三块：

| 状态 | 存储 | 作用 | 权威性 |
|---|---|---|---|
| Investigation State | .workspace/<session>/context.json | goal、scope、evidence、claims、findings、inputs、Agent session reference | Investigation 当前状态 |
| Conversation / Local Registry | .workspace/conversations.db | user/assistant 消息、turn、Dataset Registry、local analysis run | 对话与本地分析元数据 |
| Control State | .workspace/<session>/control.json | Research、guidance、MCP、平台能力、版本历史 | Agent 执行配置 |

Agent session 本身不作为业务状态源，而是由 context.json 保存的可恢复引用；具体是 Copilot、CodeBuddy 还是 OpenCode 由 Runtime 配置决定。

本轮已经处理的关键问题：

1. 一个 Investigation 同时只允许一个 active turn。
2. turn 在任何 Agent Runtime 真正启动前就完成进程内 reservation，避免异步创建 runtime session 的竞争窗口。
3. server 重启后残留的 running turn 会恢复成 aborted。
4. 没有真实 Agent Runtime execution 的 stale running turn 可以被恢复。
5. 前端使用稳定 turnId，SSE 与 abort 使用同一个 turn。
6. SSE 现在是真实使用路径，不再存在“后端有 streaming、前端却调用普通 POST”的双轨问题。
7. workspace JSON 使用临时文件 + rename 原子更新。
8. Investigation 保存不会覆盖回答期间新上传的文件/input。
9. 同一个 session 的 context 写入和 configuration 写入分别做轻量串行化。
10. 取消状态在 Runtime session 创建前后都能被感知；模型返回后进入不可取消的 commit phase，避免半提交。

仍然需要注意：当前项目是单 Node 进程模型。这些进程内 reservation / write lock 不是分布式锁。如果以后运行多个 API replica，需要把 turn lease / session ownership / workspace state 迁移到共享存储。

## 2. 运行时整体架构

~~~mermaid
flowchart LR
    Browser[Web UI<br/>React + Ant Design X]
    API[Express API]
    Turn[(SQLite<br/>conversation_turns)]
    Msg[(SQLite<br/>conversation_messages)]
    Context[(context.json)]
    Control[(control.json)]
    Audit[(audit.jsonl)]
    Runtime[Agent Runtime<br/>Copilot / CodeBuddy / OpenCode]
    Session[(Agent Session)]
    Workspace[Investigation Workspace]
    DuckDB[(local.duckdb)]
    Dataset[(SQLite local_datasets)]

    Browser -->|POST /messages/stream<br/>message + turnId| API
    Browser -->|POST /messages/abort<br/>turnId| API
    API --> Turn
    API --> Msg
    API --> Context
    API --> Control
    API --> Audit
    API --> Runtime
    Runtime --> DuckDB
    DuckDB --> Dataset
    Runtime --> Session

    Context -.->|sessionId + configVersion| API
    Control -.->|Research / Skills / MCP / Prompt| API

    Workspace --- Context
    Workspace --- Control
    Workspace --- Audit
    Workspace --- Session
~~~

核心原则：

> Browser 负责交互状态；SQLite 负责 turn / conversation 生命周期；context.json 负责 Investigation 状态；control.json 负责 Agent 配置；Agent session 负责模型运行上下文，但不定义 Investigation 业务状态。

## 3. 正常提问的数据流

~~~mermaid
sequenceDiagram
    autonumber
    participant U as Browser
    participant API as Express
    participant T as SQLite Turn
    participant M as SQLite Message
    participant C as context.json
    participant K as control.json
    participant A as audit.jsonl
    participant W as Workflow
    participant RT as Agent Runtime

    U->>API: POST /messages/stream {message, turnId}
    API->>T: create turn = running
    API-->>U: SSE started(turnId)

    W->>T: reserve Investigation turn
    W->>M: save user message
    W->>C: load Investigation state
    W->>K: load current configuration
    W->>A: append investigation.question

    W->>W: load discovery snapshot
    W->>M: FTS search relevant history
    W->>W: build question context/prompt

    W->>RT: create/resume Agent session
    RT-->>W: sessionId
    W->>C: keep sessionId + configurationVersion in memory

    loop assistant deltas
        RT-->>W: assistant.message_delta
        W-->>API: delta
        API-->>U: SSE delta
    end

    RT-->>W: final response
    W->>W: parse structured answer
    W->>W: create claims / unknowns
    W->>C: merge and atomically save Investigation
    W->>M: save assistant message
    W->>T: running -> completed
    API-->>U: SSE completed(result)
~~~

关键顺序：

~~~text
LLM 返回
  ↓
parse
  ↓
保存 Investigation state
  ↓
保存 assistant message
  ↓
turn = completed
  ↓
SSE completed
~~~

浏览器收到 completed 时，后端状态已经基本落盘。

## 4. 一个 Investigation 为什么不能同时跑两个 turn

### 错误模型

早期模型相当于：

~~~text
request A
  ↓
SQLite running

request B
  ↓
看到 running
  ↓
但 A 还没有把 Copilot session 放进 activeSessions
  ↓
B 误认为 A 是 stale
  ↓
B 把 A 清掉
  ↓
两个 Agent 同时跑
~~~

这是典型的 TOCTOU 竞争。

### 当前模型

~~~mermaid
sequenceDiagram
    participant A as Request A
    participant W as Workflow Reservation
    participant DB as SQLite
    participant CP as Copilot
    participant B as Request B

    A->>DB: INSERT turn=running
    A->>W: activeInvestigationTurns[session]=turnA
    A->>CP: createSession / resumeSession

    B->>W: check session reservation
    W-->>B: turnA already reserved
    B-->>B: reject active turn

    CP-->>A: session created
    A->>W: active Copilot session registered
~~~

关键点：

> 是否允许新 turn 的 reservation 必须发生在任何可能 await 的 Copilot 操作之前。

SQLite 负责持久化事实，进程内 Map 负责填补同一进程中的异步时间窗口。

## 5. 重启恢复

server 关闭时，内存中的 activeInvestigationTurns 和 activeSessions 都会消失。

SQLite 里的 turn.status=running 却可能还存在。

因此启动顺序必须是：

~~~mermaid
flowchart TD
    Start[Node process starts]
    DB[Open conversations.db]
    Recover[Find status=running]
    Abort[recover as aborted + durable assistant message]
    App[Create Express app]
    Listen[HTTP listen]

    Start --> DB --> Recover --> Abort --> App --> Listen
~~~

当前 server 在开始监听之前执行 recovery。

### 重启与 SSE 断线的 durable recovery

Server 正常关闭时，会先请求所有 active turn 停止，并等待 workflow 的 abort/failure 收尾完成后再关闭 SQLite。进程已经意外退出时，下一次启动会扫描遗留的 `running` turn：如果存在 `assistant_draft`，会连同已生成的秘书/assistant 内容恢复成可见的 assistant 中断消息，然后把 turn 标记为 `aborted`。

因此 SSE 不是 Conversation 的 source of truth。浏览器看到 “network error” 时，不能直接把 turn 当作失败并丢掉已有内容；当前前端会先检查服务器是否恢复，并重新加载 durable conversation。

## 6. 取消 / Stop 的控制流

~~~mermaid
sequenceDiagram
    participant U as Browser
    participant API as Express
    participant W as Workflow
    participant RT as Agent Runtime

    U->>API: POST /messages/abort {turnId}
    API->>W: requestAbort(session, turnId)
    W->>W: abortRequestedTurns.add(turnId)
    API->>RT: runtime-specific abort

    alt Runtime session already exists
        RT-->>W: abort
        W-->>API: aborted=true
    else Runtime session not created yet
        W-->>API: cancellation requested
        W->>RT: shouldAbort() checked before execution
        RT-->>W: stop before model execution
    end

    API-->>U: abort result
~~~

取消不是简单的 setLoading(false)。

真正的 stop 至少包含：

~~~text
UI cancel
  ↓
abort request
  ↓
workflow cancellation state
  ↓
Copilot session abort
  ↓
turn = aborted
~~~

浏览器的 SSE fetch 同时使用 AbortController 断开网络读取。

## 7. Execution / Commit 两阶段

Agent turn 在模型执行阶段允许 Stop；模型已经返回后进入 commit phase：

~~~text
executing
  ↓ model final
committing
  ↓ save Investigation
  ↓ save assistant message
  ↓ completed
~~~

commit phase 不再接受新的 abort 请求。这样不会出现 context 已保存、assistant message 未保存、turn 却被标记为 aborted 的半提交状态。

## 8. 网络断开与重试

turnId 是一次用户操作的幂等键。

~~~mermaid
flowchart TD
    Send[Browser sends message + turnId]
    Running[turn=running]
    Agent[Agent Runtime runs]
    Done[turn=completed + result saved]
    Network[Network failure]
    Retry[Retry same turnId]
    Return[Return stored result]

    Send --> Running --> Agent --> Done
    Done --> Network
    Network --> Retry
    Retry --> Return
~~~

因此：

~~~text
same turnId + completed
    => directly return stored result
~~~

而不是再次启动 Agent Runtime。

不同 turnId + 相同 user text 仍然被认为是新的业务操作。

## 9. context.json 的竞争风险

### 原来的危险操作

~~~text
Request A                  Request B
---------                  ---------
load context
                           load context
modify claims              add uploaded file
write whole file
                           write whole file
~~~

结果：B 的 upload 可能被 A 的旧快照覆盖。

### 当前处理

1. JSON 文件使用临时文件 + rename。
2. 保存 Investigation 时重新读取最新 workspace，并保留最新 inputs。
3. 同一个 session 的 context mutation 使用轻量 async lock。

~~~mermaid
flowchart LR
    A[Agent state snapshot] --> Merge[Load latest context + merge]
    B[New uploaded input] --> Context[Latest context]
    Merge --> Atomic[Temporary JSON + rename]
    Context --> Atomic
~~~

因此 Agent 回答期间上传文件，不应该再因为最后的 saveInvestigation 而消失。

## 10. Control configuration 的竞争

配置更新本质上是：

~~~text
load current
  ↓
calculate next version
  ↓
write
  ↓
audit
~~~

如果两个浏览器窗口同时保存，早期可能出现：

~~~text
window A: v10 -> v11
window B: v10 -> v11
~~~

当前增加 session-level configuration write serialization：

~~~text
A: load v10 -> write v11
B: wait
B: load v11 -> write v12
~~~

所以至少在单 Node process 中，version 不会因为并发 PUT 而发生简单覆盖。

## 11. Configuration 与正在执行的 Agent

一次 Agent turn 在开始时读取：

~~~text
control.version
research
skills
systemPrompt
MCP
platform capabilities
~~~

形成该 turn 的 execution configuration。

如果用户在 Agent 执行中途修改配置：

~~~text
Turn A -> config v10
User updates -> config v11
Turn A continues -> still uses v10
Next turn -> uses v11
~~~

这是有意的。

### Graphify 的可重放边界

Graphify 不绕过 Control version。`control.json` 固定 `graphify-structural-analysis` 平台 capability version；turn audit 记录本次实际 Graphify package version、MCP command、graph.json path 和 graph SHA-256。Discovery run 也会保存当时的 Graphify runtime metadata。

因此一个 turn 即使运行过程中通过 Skill 创建或更新 `graphify-out/graph.json`，也能区分“平台工具版本”和“实际读取的 graph 快照”。Graphify 结果只是结构导航，最终 Claim 仍必须回到 deterministic Evidence。

### Graphify 与 Evidence

本地目录 Discovery 为每个源文件创建 `source_file` Evidence。它记录文件路径、sha256、大小、行数和 mtime；Agent 可以先用 Graphify 定位文件，再使用源码读取工具检查具体内容。source_file Evidence 是 provenance anchor，不等同于“这段代码表达了某个业务事实”。

不能允许一个 turn 执行到一半：

~~~text
前半段用 Skill v1
后半段突然变成 Skill v2
~~~

否则同一个执行的可重放性很差。

## 12. Conversation 与 Investigation state 的边界

### Conversation DB

保存：

~~~text
user message
assistant message
turn status
turn result
error
timestamps
~~~

用于：

- chat history
- full-text search
- idempotency
- execution lifecycle

### context.json

保存：

~~~text
goal
scope
evidence
claims
findings
unknowns
questions
workspace inputs
copilot session reference
~~~

用于：

- Investigation current state
- report generation
- discovery results
- agent next-turn context

因此：

> Chat history 不是 Investigation state。

Agent 不会把整个历史对话塞回 prompt，而是从 FTS5 检索少量相关历史作为补充。

## 13. 当前实际控制流

~~~mermaid
flowchart TD
    Q[User question]
    R[Create / validate turn]
    L{Existing turn?}
    C[Completed]
    X[Active]
    S[Stale]
    P[Reserve session]
    M[Persist user message]
    I[Load investigation]
    K[Load control]
    H[Retrieve relevant history]
    G[Build grounded prompt]
    RT[Create/resume selected Agent Runtime]
    D[Stream deltas]
    F[Parse result]
    V[Save Investigation]
    AM[Save assistant message]
    T[turn completed]
    E[Error]
    AB[turn aborted]

    Q --> R --> L
    L -->|completed| C
    L -->|running + active| X
    L -->|running + no execution| S
    S --> P
    L -->|new| P
    P --> M --> I --> K --> H --> G --> CP --> D --> F --> V --> AM --> T
    CP --> E
    G --> E
    V --> E
    P --> AB
~~~

## 14. 当前仍然存在的边界

### 13.1 单进程假设

以下状态都在 Node 内存：

~~~text
activeInvestigationTurns
abortRequestedTurns
activeSessions
workspace write locks
control update locks
~~~

因此多个 API replica 之间看不到彼此的 reservation。

如果未来部署多个 replica，需要把 turn lease、session ownership、workspace state 迁移到共享存储。

### 13.2 本地文件不是多实例数据库

当前本地 workspace 适合：

~~~text
单实例
开发
本地 investigation workbench
~~~

不适合直接扩展成：

~~~text
多实例 API
共享 NFS
高并发生产服务
~~~

### 13.3 Agent session 不是业务事务

不同 Runtime（Copilot、CodeBuddy、OpenCode）的 session 都只属于模型运行上下文；业务正确性不能依赖 provider session。本机 workspace 还会为 CodeBuddy / OpenCode 建立标准 `.agents/skills` bridge，让 capability Skill 与当前 Workflow Skill 的可见性保持一致。

### 13.4 Provider-specific: Copilot session

Copilot session 可以 resume、disconnect、abort 或丢失。

所以业务正确性不能依赖 Copilot session 本身。

业务事实应该由：

~~~text
turn state
Investigation state
conversation message
control version
~~~

决定。

## 15. 关键不变量

后续修改代码时，优先保护下面这些 invariant。

### Turn

~~~text
一个 Investigation 最多一个 running turn

running turn 必须有：
  - 持久化 turn row
  - 当前进程 reservation（若进程内）
~~~

### Completed

~~~text
turn=completed
  => result 已持久化
  => Investigation state 已保存
~~~

### Configuration

~~~text
一个 turn 使用一个确定的 control.version
~~~

### Idempotency

~~~text
completed(turnId)
  => retry same turnId 不重新调用模型
~~~

### Cancellation

~~~text
abort(turnId)
  => 不应该再把该 turn 正常完成为 completed
~~~

### Workspace

~~~text
JSON 更新必须 atomic
read-modify-write 必须避免覆盖同时产生的新 input
~~~

### Restart

~~~text
server restart
  => 不允许旧 running turn 永久锁死 Investigation
~~~

## 16. 检查结论

当前比较大的数据流 / 控制流问题已经收敛到：

~~~text
Browser
  ↓
stable turnId
  ↓
persistent turn
  ↓
process reservation
  ↓
grounded context
  ↓
fixed configuration version
  ↓
selected Agent Runtime execution
  ↓
stream
  ↓
persist
  ↓
completed
~~~

这个顺序是当前实现最重要的骨架。

后续如果继续增加功能，尽量不要让新的状态绕开 turn、context、conversation DB、control version 这四个边界。


## 17. 当前 Agent / Skill / Local Data 运行边界

当前 session 不再注册 `lead-data-agent` custom agent。每个 Investigation 通过 Runtime adapter 使用选定的 Agent Runtime；Copilot 自身才使用 SDK default agent。

```text
default agent
  +
platform system rules
  +
selected Skills
  +
investigation guidance
  +
configured MCP
  +
explicit built-in tool allowlist
```

Capability Skill 不再保存为 Investigation 的“启用清单”。当前 Runtime 负责发现 capability；只有用户选中的 Workflow Skill 保持可用，其它 Workflow Skill 通过 Runtime-specific 禁用策略关闭，避免路线混用。

Copilot Runtime 使用 mode: "copilot-cli"，因为当前产品是个人本机 Agent，需要保留 Copilot CLI 的 ambient skills、工具和内置 MCP；CodeBuddy / OpenCode 使用各自的 Runtime boundary。

本地数据工具由应用显式注册。它们通过 Dataset Registry 和 DuckDB 查询当前 workspace 数据，并把分析结果写成 Evidence；Agent 没有直接打开 local.duckdb 或任意本地文件的工具。

HTTP MCP 的 headers 与 URL 一样从配置中解析环境变量后传入 runtime；secret 本身不写入 `control.json`。




## 18. Local Data 分析数据流

本地数据不经过外部数据库 adapter。文件先进入当前 Investigation workspace，再由 Dataset Registry 登记，DuckDB 建立 raw view。

~~~text
CSV / JSON / JSONL / Parquet
            ↓
     Dataset Registry
       SQLite metadata
            ↓
        DuckDB raw view
            ↓
local_describe / sample / profile / query
            ↓
      Analysis Run
            ↓
         Evidence
            ↓
      Claim / Finding
~~~

每个 Investigation 一个 local.duckdb；同一进程内的操作在单个 connection 上串行化。大数据不复制进 SQLite，query 结果只返回受控行数。

local_query 只允许 SELECT / WITH，禁止多语句、ATTACH、COPY、INSTALL、LOAD、文件读取函数、网络和其它数据库 scanner。

Dataset Registry 与 conversation store 当前共用同一 SQLite 文件，后续可以自然迁移成统一 app.sqlite，但不需要因为这个目标提前重写现有 Conversation API。

### Local Data 并发与写入边界

每个 Investigation 只有一个进程内 DuckDB engine 和 connection。Agent 的本地分析操作通过单队列串行化；Dataset Registry 仍使用 SQLite WAL 和 busy_timeout。

原始文件只读，raw schema 只建立 view。需要写入时，Agent 只能生成 analysis / scratch 派生表，或把只读查询导出成当前 Investigation 内的 Parquet 文件。

因此本地数据路径仍然是：

~~~text
raw input
   ↓
Dataset Registry
   ↓
DuckDB read-only analysis
   ├─ query/profile/sample
   ├─ analysis/scratch derived table
   └─ Parquet export
   ↓
Evidence
~~~


## 19. Schema 与边界验证（当前实现）

运行时数据不再只靠 TypeScript interface 约束。当前代码使用 Zod 作为 JSON / API 边界的运行时 Schema：

- `src/evidence/types.ts` 定义 Evidence / Claim / Finding / DiscoveryRun 的 Schema，并由 Schema 推导 TypeScript 类型。
- `src/investigation/schemas.ts` 定义 `context.json`、`control.json`、shared index、audit event 的 Schema；读取持久化数据时重新校验。
- `src/agent/result.ts` 对模型结构化输出做 Zod 校验，再做 Evidence ownership 校验和状态校正。
- `src/api/schemas.ts` 校验创建 Investigation、配置保存、消息发送、Stop 请求的 HTTP body。
- `src/config.ts` 校验环境变量，并对端口、超时等数值做类型转换和范围约束。

原则是：TypeScript 用于开发期类型安全，Zod 用于运行时不可信输入；Schema 是类型和验证规则的单一来源，避免 `as Type` 把未经验证的 JSON 当成可信对象。
