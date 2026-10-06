# Agent Soul / Relationship Memory 设计与实现

## 结论

人格不需要提升任务能力，但不能造成任务结果减益。Task Agent 决定任务结果，Soul 只决定最终表达；长期熟悉感由真实的 Relationship Memory 提供，而不是让 Soul 自行漂移。

核心原则：

> **Soul stable, relationship grows.**
> **人格不变，关系变熟。**

EMNLP 2025 的 *Principled Personas* 研究表明，模型对与任务无关的人格细节也可能敏感，实验中观察到明显的任务性能下降，因此不能假定把人格放进主 Agent prompt 是无害的。https://aclanthology.org/2025.emnlp-main.1364/

长期记忆研究支持另一条路径：保存长期信息、按当前上下文召回相关记忆、持续更新记忆，而不是不断修改人格本身。MemoryBank 将长期记忆拆成存储、相关记忆召回和记忆更新机制；MemGuide 进一步强调 goal-oriented agent 的 memory selection。https://ojs.aaai.org/index.php/AAAI/article/view/29946
https://ojs.aaai.org/index.php/AAAI/article/view/40313

## 架构边界

\`\`\`mermaid
flowchart TD
    Mission[Mission] --> Agent[Task Agent]
    Evidence[Evidence] --> Agent
    Workflow[Workflow] --> Agent
    Agent --> Result[Structured Task Result]

    Soul[Soul] --> Renderer[Persona Renderer]
    Memory[Relationship Memory] --> Renderer
    Result --> Renderer
    Renderer --> User[User]
\`\`\`

### Task Agent

Task Agent 负责 Mission、Evidence、Workflow、工具选择、调查深度、停止条件、Claim / Finding 和任务结论。

Task Agent **不读取 Soul，也不读取 Relationship Memory**。

### Soul

Soul 是稳定身份和表达配置，只负责身份、称呼、语气、表达节奏、亲近程度、幽默程度和长期一致的表达风格。

Soul 不负责事实判断、Evidence、Claim / Finding、工具选择、调查深度、Workflow、权限、安全规则或任务结论。

默认 Soul 已经从“主动推进、发现问题直接指出、信息不足时如何判断”等行为性规则收紧为 presentation-only。

### Relationship Memory

Relationship Memory 与 Soul 分离。

它保存长期相处过程中用户明确表达过的、适合影响表达方式的信息，例如回答风格偏好、明确的长期交互要求、稳定的工作方式和用户明确要求保持的共同上下文。

第一版只自动保存 **explicit memory**，不把模型推断出的偏好直接升级为长期事实，避免形成“模型猜测 → 写入 Memory → 下一轮相信自己的猜测”的反馈回路。

Memory 生命周期支持 active / superseded。更新同一个 category + key 时覆盖当前 active 值，不删除历史状态。

## 三个 Phase

### Phase 1：Soul Isolation

主链路：

\`\`\`
Task Agent
    ↓
Structured Task Result
    ↓
Persona Renderer
    ↓
User
\`\`\`

任务 Agent 的 system prompt 不包含 Soul。

Renderer 使用独立 prompt，只接受已经完成的答案，并明确禁止增加或删除事实、修改数字、结论、不确定性和建议，也不得添加新的知识或因人格改变判断。

Renderer 失败时直接回退到 Task Agent 原始答案。

同时加入回归测试，验证主 Agent prompt 不包含 Assistant Soul、Relationship Memory 或长期人格。

### Phase 2：Minimal Relationship Memory

实现位置：

src/relationship/memory.ts

存储：

.data/relationship-memory.json

第一版没有引入 SQLite / Vector DB，因为当前 Memory 规模很小，而且它不是 Research Knowledge Store。JSON + 原子写已经足够，避免为一个小型关系层增加基础设施。

数据结构：

\`\`\`typescript
type RelationshipMemory = {
  id: string;
  category:
    | "preference"
    | "working_style"
    | "ongoing_context"
    | "shared_history"
    | "explicit_instruction";
  key: string;
  value: string;
  source: "explicit";
  confidence: number;
  status: "active" | "superseded";
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};
\`\`\`

当前支持显式表达，例如：

- “记住：以后回答简洁一点”
- “以后不要……”
- “以后回答……尽量……”

只对明确表达进行自动保存。

不做 embedding、vector database、automatic personality evolution、emotion model、memory graph、自动推断用户人格，也不自动把普通对话升级为长期记忆。

### Phase 3：Renderer 使用 Relationship Memory

最终渲染链：

\`\`\`
Task Result + Soul + Relevant Relationship Memory
                         ↓
                  Persona Renderer
                         ↓
                   Final Answer
\`\`\`

Memory 通过轻量 lexical relevance selection 选择，当前规模下不需要 embedding。

Renderer contract 明确规定：

> Relationship Memory 只能影响称呼、语气、表达习惯和连续感；不能作为任务事实或技术依据。

即使 Memory 中存在用户偏好，也不会改变 Task Agent 对技术问题的判断。

## 为什么不把 Memory 加到 Task Agent

例如用户 Memory：

> “用户喜欢 Snowflake。”

用户问：

> “Snowflake 和 Databricks 哪个更适合当前企业数据平台？”

Task Agent 仍必须根据当前需求、架构约束、成本、数据规模、governance、workload、security 和 operational model 得出结论。

Memory 最多允许 Renderer 在最终表达中体现：

> “结合我们之前讨论的企业数据平台场景……”

而不能让 Memory 成为技术判断依据。

## 与现有 Config / Investigation 的关系

三者生命周期不同，因此不合并：

| 层 | 生命周期 | 作用 |
|---|---|---|
| Global Config | 用户配置 | 系统运行行为 |
| Task Config | Investigation | 当前任务配置 |
| Soul | 长期稳定 | 身份与表达 |
| Relationship Memory | 长期动态 | 用户关系与表达连续性 |
| Investigation Context | 单任务 | Evidence / Claim / Finding / Workflow |
| Conversation History | 对话 | 当前任务的对话上下文 |

Relationship Memory 不是 Configuration，也不是 Evidence，更不是 Research Knowledge。

## 当前实现的关键路径

- src/agent/prompts.ts
  - buildAssistantSoulPrompt()：Soul boundary
  - buildAssistantAnswerPrompt()：最终表达 renderer
- src/workflow/ask.ts
  - Task Agent 主 prompt 不注入 Soul / Memory
  - 用户明确表达的 Memory 在任务执行入口被捕获
  - Task Result 完成后才召回 Relationship Memory
  - Renderer 失败回退原始 Task Result
- src/relationship/memory.ts
  - explicit memory capture
  - active / superseded lifecycle
  - lightweight relevance retrieval
- src/investigation/schemas.ts
  - 默认 personality 收紧为 presentation-only
- tests/prompts.test.ts
  - 防止 Soul / Memory 泄漏到 Task Agent
- tests/relationship-memory.test.ts
  - 验证 Memory 只能作为 Renderer context

## 验收标准

1. 不使用 Soul 时，Task Agent 的任务结果不依赖 Soul。
2. Relationship Memory 不进入 Task Agent reasoning prompt。
3. Renderer 不能改变 Task Agent 的事实、结论、不确定性和建议。
4. Renderer 失败时结果仍可正常返回。
5. 明确的用户偏好可以跨 Investigation 保留。
6. 新 Memory 可以 supersede 旧 Memory，而不是形成冲突的 active memories。
7. 普通对话不会自动产生长期 Memory。
8. 长期表达可以变得更熟悉，但任务正确性、Evidence grounding、Task completion 和 uncertainty calibration 不应因此下降。

## 后续暂不实现

如果后续 Memory 规模真正增长，再考虑 semantic / embedding retrieval、memory importance scoring、explicit user memory management UI、memory expiration / reinforcement、episodic / semantic memory 分层和更复杂的 memory consolidation。

这些不是当前项目解决“人格不减益”的必要条件。
