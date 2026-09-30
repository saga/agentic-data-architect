## 2026-09-30 — Web UI / Express 5 / Ant Design X

### 为什么改

readline 形式不适合作为长期 Data Investigation 工作台。真实使用需要会话列表、历史对话、富 Markdown、Mermaid、状态信息和后续文件/知识引用，因此主入口改为 Web UI。

### 相关文件

- `src/server.ts`：新增 Express 5 server，提供 session / message / report / shared API，并在开发环境挂 Vite middleware、生产环境直接服务 `web/dist`。
- `src/config.ts`：增加 `PORT` / `HOST` / `NODE_ENV`。
- `src/agent/copilot.ts`：增加可选 delta callback，为后续 X Chat streaming 保留接口。
- `src/workflow/ask.ts`：Web 对话和 CLI 统一复用；记录 user/assistant transcript。
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

当前消息 API 仍是一次请求返回最终答案，先保持后端 Agent result / evidence 逻辑不变；Copilot delta callback 已预留，后续可以直接接 Ant Design X streaming。

---
## 2026-09-30 — Interactive Investigation Session 与 Workspace 收敛

### 为什么改

原来的使用方式要求用户先 `init`、再 `discover`、再 `ask`、再 `report`，更像一次性 CLI pipeline。真实的数据架构调查通常会持续多个来回：用户先给目标，再补业务上下文、文档和 GitHub URL，然后根据发现结果纠正方向、继续提问。

因此把默认入口改成持续 session，CLI 命令保留为兼容的脚本化入口。

同时收缩 workspace 层级：session 的核心状态只放在 `.workspace/<session-name>/context.json`；跨 session 可复用资料统一进入 `.workspace/shared/`，并由 `index.json` 做轻量索引。

### 相关文件

- `package.json`：增加 `start` / `dev`，默认进入 interactive session。
- `src/cli.ts`：无命令、`start`、`dev` 都进入持续 session；旧 `init/discover/ask/report` 保留。
- `src/workflow/session.ts`：新增 readline 循环；启动时逐步咨询；每轮允许补充、提问和纠正；提供 `/report`、`/context`、`/exit`；不指定名称时使用可恢复的 `default` session。
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