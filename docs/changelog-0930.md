## 2026-10-03 — Workflow editor cleanup

### 做了什么

- 工作地图从“只读导航”收敛为真正的 Investigation Workflow 编辑器，编辑结果只存在当前画布，点击保存后才创建新的 Workflow version。
- 删除早期 draft / validate / apply 三段式 API 和 draft 文件设计，当前编辑 API 统一为 `/workflow`、`/workflow/ai`、`/workflow/transition`、`/workflow/reset`。
- 右侧工作区改为 Ant Design Tabs，在“属性”和“AI”之间切换，避免两个面板同时挤占空间。
- 修正节点属性 `requires / produces` 未写回画布的问题。
- 统一异步 ELK 布局的 request token，避免独立新建节点时旧布局结果覆盖新结果。
- 修正文档中残留的 draft API、draft 文件和旧的 `server-main.ts` API ownership 描述。

---

## 2026-10-02 — Adaptive navigation / actionable work map

### 做了什么

- Agent 的动态 `routeOptions` 持久化为 `context.journeyPlan`，作为下一步导航建议，不直接驱动 Journey 状态。
- Agent 建议从右侧栏提升到主对话区，路线可以直接“采用”；下一步建议不再被窄侧栏弱化。
- 顶部“待查内容”状态标签变成可点击入口，可查看具体 Unknown，并直接让 Agent 继续调查某一条 Unknown。
- 工作方式不再在首页通过普通下拉随手切换；改为“调查配置 → 工作方式”的明确调整区，需要选择目标并输入确认语句。
- 全屏工作地图改为 React Flow custom nodes + NodeToolbar + Panel + MiniMap + animated edges 的 roadmap / branch 视图；主线是 Workflow 骨架，Agent 建议路线从当前节点分支。
- 地图本身是只读导航视图，不能拖拽编辑节点或连接，不引入第二套 Workflow Engine。

### 设计边界

工作方式属于持久化调查状态，动态路线属于临时导航建议；模糊的“换个思路”只触发路线重新规划，不自动修改工作方式。

---
## 2026-10-02 — Optional / switchable Investigation Workflow

### 做了什么

- 新建 Investigation 默认不绑定 Workflow，用户可以直接进入自主调查。
- Legacy Modernization、Financial AI-Native Architecture、Data Architecture Assessment 从“工作类型”调整为可选 playbook。
- Investigation 过程中可以切换或取消 Workflow；已有 messages、Discovery、Evidence、Findings 和 workspace 状态保持不变。
- Workflow Skill 不再属于普通 capability Skill 配置；当前工作方式决定是否加载对应 Workflow Skill。
- 增加 `PATCH /api/sessions/:name/workflow`，Workflow 变化进入 audit。
- 自主模式下没有 Journey；选择 Workflow 后才显示对应 Journey。

### 设计边界

Agent 决定下一步调查和什么时候需要改变方向；Workflow 只提供需要确定阶段、Gate 和完成条件时的可选约束。不要把 Workflow 再升级成一个固定的全局 Agent 状态机。

---

## 2026-10-02 — Graphify structural analysis / Control / Evidence hardening

### 做了什么

- Graphify 从运行时隐式注入改成平台级 capability：`control.json` 固定 `graphify-structural-analysis` capability version；普通 Skills / MCP 仍可按 Investigation 配置。
- Graphify runtime 增加 package version、MCP command、graph path、graph SHA-256、extraction mode，并进入 Discovery run / turn audit。
- 本地目录 Discovery 为源文件建立 `source_file` Evidence；Graphify 只能用于定位候选文件，最终 Claim 仍引用 deterministic Evidence。
- `supported` 状态不再只看 Evidence 数量，同一个文件/hash 的多条 Evidence 不算两个独立来源。
- Python 运行时依赖从 `requirements*.txt` 收敛到根目录 `pyproject.toml`，由 `uv` 统一创建、同步和执行。
- `npm test` 的 Python 检查改为 `uv run scripts/check-python-deps.py`；CI 使用 `uv sync`，生产依赖通过 `uv export --no-dev` 后交给 `pip-audit`。
- 增加真实 Graphify extraction / runtime integration test。

### 不变的边界

Graphify 是结构导航工具，不是业务事实来源。SQL AST lineage、database metadata、profiling、targeted query 和 semantic context 仍然是 Evidence 来源。

---
## 2026-09-30 — Skill-driven domain logic

### 为什么改

原来 discovery / findings 里混合了平台逻辑和金融业务知识。这样每增加一个领域就要修改 TypeScript 核心代码，也不利于让 Copilot 自己根据当前问题选择合适的方法。

### 现在怎么分

- `src/agent/copilot.ts`：通过 Copilot SDK `skillDirectories` 加载项目 Skill；`investigation-session` 默认预加载，并在每次 session 使用前执行 skill reload。
- `src/workflow/ask.ts`：不再读取 `SKILL.md` 并手工拼接进 system prompt。
- `src/analysis/findings.ts`：只保留 domain-agnostic deterministic findings。
- 删除 `src/analysis/finance-rules.ts`。
- `skills/financial-data-review/SKILL.md`：承载金融领域知识、检查重点和交互方法。
- `skills/financial-data-review/scripts/review.mjs`：承载确定性的金融 schema/review 检查，并写入 session artifact。
- `skills/*/SKILL.md` 增加 description frontmatter，便于 Copilot Skill discovery。

### 边界

不要把安全和一致性规则放 Skill：SQL read-only、Evidence ID 校验、Claim status calibration、持久化和核心状态仍由代码控制。

不要把可确定执行的算法写成 prompt：放到 Skill 的 `scripts/`，由 Agent 执行。
## 2026-09-30 — SQLite Conversation History / FTS5

### 为什么改

多轮对话继续写入 `context.json` 会让 Investigation 状态文件随着聊天轮数不断膨胀。现在把 conversation 与 Investigation state 分开：SQLite 保存 user / assistant / system message，`context.json` 只保存当前调查状态。

### 实现

- `src/investigation/conversation.ts`：基于 Node 22 `node:sqlite` 的 SQLite message store。
- `conversation_messages`：按 session 保存消息。
- `conversation_messages_fts`：SQLite FTS5 external-content 索引，使用 trigram tokenizer。
- 旧 `context.json` 中的 `question` / `assistant_message` 会在读取时自动迁移到 SQLite。
- `src/workflow/ask.ts`：写入 SQLite，并按当前问题检索少量相关历史消息补充到 Agent context。
- `src/server.ts`：Web UI 从 SQLite 读取最近消息，并增加 `GET /api/sessions/:name/messages?q=...` 搜索接口。

### FTS5 当前用途

当前最直接的用途是长对话中的“相关历史召回”：用户隔了几十轮重新讨论 Position、Price、Security Master 等主题时，不需要把全部历史重新放进 prompt，只检索相关消息。相同索引也可以用于 Web UI 的历史消息定位。

---
## 2026-09-30 — Web UI / Express 5 / Ant Design X

### 为什么改

readline 形式不适合作为长期 Data Investigation 工作台。真实使用需要会话列表、历史对话、富 Markdown、Mermaid、状态信息和后续文件/知识引用，因此主入口改为 Web UI。

### 相关文件

- `src/server.ts`：新增 Express 5 server，提供 session / message / report / shared API，并在开发环境挂 Vite middleware、生产环境直接服务 `web/dist`。
- `src/config.ts`：增加 `PORT` / `HOST` / `NODE_ENV`。
- `src/agent/copilot.ts`：增加可选 delta callback，为后续 X Chat streaming 保留接口。
- `src/workflow/ask.ts`：Web 对话和 CLI 统一复用；user/assistant message 写入 SQLite。
- `web/index.html`：Vite HTML 入口。
- `web/src/main.tsx`：React 入口。
- `web/src/App.tsx`：Ant Design X Conversations / Bubble / Sender / Welcome，以及 Ant Design context panel。
- `web/src/styles.css`：Workbench 布局。
- `web/tsconfig.json`：前端独立 typecheck。
- `vite.config.ts`：Vite + React 配置。
- `.gitignore`：忽略 `.workspace/` 和 `web/dist/`。
- `.github/workflows/ci.yml`：依赖增加后使用 `npm install`，再执行 audit / typecheck / test。
- `README.md`：Web UI 成为主入口。

### UI 取舍

没有再引入一个独立 chat framework。直接使用 Ant Design X 原子组件；Markdown 使用官方 `@ant-design/x-markdown`，Mermaid 使用 Ant Design X 的 `Mermaid` 组件。

当前 Web UI 使用 `/messages/stream` + SSE，把 Copilot delta/status 作为实时 UI 状态输出；Agent result / Evidence 仍在 workflow commit 阶段一次性持久化。

---
## 2026-09-30 — Interactive Investigation Session 与 Workspace 收敛

### 为什么改

原来的使用方式要求用户先 `init`、再 `discover`、再 `ask`、再 `report`，更像一次性 CLI pipeline。真实的数据架构调查通常会持续多个来回：用户先给目标，再补业务上下文、文档和 GitHub URL，然后根据发现结果纠正方向、继续提问。

因此把默认入口改成持续 session，CLI 命令保留为兼容的脚本化入口。

同时收缩 workspace 层级：session 的核心状态只放在 `.workspace/<session-name>/context.json`；跨 session 可复用资料统一进入 `.workspace/shared/`，并由 `index.json` 做轻量索引。

### 相关文件

- `package.json`：增加 `start` / `dev`，默认进入 interactive session。
- `src/cli.ts`：无命令、`start`、`dev` 都进入持续 session；旧 `init/discover/ask/report` 保留。
- `src/cli.ts`：保留兼容 CLI；Web Workbench 是当前主入口。启动时逐步咨询；每轮允许补充、提问和纠正；提供 `/report`、`/context`、`/exit`；不指定名称时使用可恢复的 `default` session。
- `src/agent/copilot.ts`：支持为同一 investigation 固定 sessionId，使退出重启后可以恢复 Copilot session。
- `src/config.ts`：当前 workspace 默认改为 `.workspace`；`.data` 仅保留 legacy migration。
- `src/investigation/workspace.ts`：session 根目录收敛为 `.workspace/<name>`；新增 `shared/index.json`、shared artifact registration 和 transcript。
- `src/investigation/store.ts`：`context.json` 成为 Investigation 持久化状态；兼容旧 `.data` 布局一次性迁移。
- `skills/investigation-session/SKILL.md`：把持续咨询、上下文沉淀、shared 资料复用和 script-first 原则放入 SKILL，而不是继续堆在代码 prompt 中。
- `skills/working-directory/SKILL.md`：更新 workspace 布局。
- `skills/search-github/SKILL.md`：研究资料改为 `.workspace/shared/github/`。
- `skills/search-confluence/SKILL.md`：Confluence Markdown 改为 `.workspace/shared/confluence/`。
- `skills/search-leanix/SKILL.md`：LeanIX 研究资料改为 `.workspace/shared/leanix/`。
- `tests/workspace.test.ts`：覆盖 session root、shared index、Confluence shared document 和凭据脱敏。
- `README.md`：更新默认使用方式、workspace 和兼容 CLI。
- `docs/implementation.md`：更新实现边界和 roadmap。

### 设计取舍

没有增加 session manager、workflow engine 或新的 persistence service。持续循环只是 CLI 层的 thin loop；真正的状态仍然由 `context.json`、现有 workflow 和 Copilot session persistence 承担。

Research 访问方式继续由已有 SKILL 决定；确定性分析继续由现有 TS / Python 工具执行。

---