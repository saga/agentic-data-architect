# agentic-data-architect

使用 AI Agent 做 Data Architect / Data Analyst，重点解决老系统 modernize / replatform 时的 data model、source、transformation、lineage 和业务上下文分析。

## Web UI

现在的主入口是 Web UI，不再使用命令行 readline 作为主要交互方式。

```bash
npm install
npm run start
```

打开：

```text
http://127.0.0.1:3000
```

也可以：

```bash
PORT=8080 npm run start
```

开发模式同样由 Express 5 托管，并通过 Vite middleware 提供前端 HMR：

```bash
npm run dev
```

### UI

前端使用：

- Ant Design 6
- Ant Design X 2.9
- @ant-design/x-markdown 2.9

聊天界面使用 Ant Design X 的 Conversations、Bubble.List、Sender、Welcome 等组件。Markdown 使用 XMarkdown，支持 CommonMark/GFM、代码高亮、公式和 Mermaid；Mermaid 图可以直接在回答中交互查看。

## Workspace

```text
.workspace/
  conversations.db
  shared/
    index.json
    confluence/
    github/
    leanix/
    web/
    document/
    other/
  <session-name>/
    context.json
    transcript.md
    discovery/
    reports/
    artifacts/
```

`.workspace/<session-name>/context.json` 是当前 Investigation 的状态入口，只保存 goal、scope、evidence、claims、findings、unknowns 等状态，不再保存多轮聊天正文。

`.workspace/conversations.db` 保存所有 session 的 user / assistant / system 消息。多轮对话不会随着轮数增长而不断膨胀 `context.json`。

对话表同时建立 SQLite FTS5 索引。当前主要用于两件事：

- 用户重新追问已经讨论过的主题时，按问题检索少量相关历史消息，补充给 Agent，而不是把整段历史全部塞进 prompt。
- Web API 可以按关键词搜索某个 session 的历史消息，后续可用于历史定位、会话恢复和审计查看。

当前检索只取相关历史消息的一个小窗口；SQLite 是长期消息存储，`context.json` 仍然是当前调查状态。

`.workspace/shared/` 是跨 session 可复用资料区。例如 Confluence 页面保存为：

```text
.workspace/shared/confluence/<page-id>.md
```

并登记到：

```text
.workspace/shared/index.json
```

## API

Web UI 后面的 Express server 提供：

```text
GET  /api/health

GET  /api/sessions
POST /api/sessions

GET  /api/sessions/:name
GET  /api/sessions/:name/messages?q=...
POST /api/sessions/:name/messages
GET  /api/sessions/:name/report

GET  /api/shared
```

Agent 问答仍然复用现有：

```text
Evidence
→ Question Context
→ Copilot
→ Structured Agent Result
→ Claim / Unknown / Finding
→ context.json
```

Web 层没有重新实现这一套逻辑。

## Skills

Copilot SDK 负责加载 `skills/*/SKILL.md`，而不是在 TypeScript workflow 里手工拼接 Skill 文本。当前由一个 `lead-data-agent` custom agent 预加载默认 Skill；Skill 集合可通过 `COPILOT_SKILLS` 调整。

当前 Skill 分工：

```text
skills/
  investigation-session/      # 基础调查行为，session 默认预加载
  financial-data-review/      # 金融领域知识，按问题按需使用
    SKILL.md
    scripts/review.mjs        # deterministic 金融检查
  search-github/              # GitHub 研究方法
  search-confluence/          # Confluence 研究方法
  search-leanix/              # LeanIX 研究方法
```

边界：

- 核心代码保留安全、持久化、Evidence 校验、SQL read-only、Lineage/Profiling 等必须确定执行的逻辑。
- 领域知识、业务检查清单、追问方法放在 Skill。
- Skill 中需要确定性计算的部分放进同一个 Skill 的 `scripts/`，由 Copilot 调用，而不是复制一份算法到 prompt。
- Skill 内容本身不是 Evidence；脚本结果和原始 Evidence 才是事实依据。

Copilot SDK 支持通过 `skillDirectories` 发现 Skill，并可以用 `skills.reload()` 刷新目录变化。

## Research Skills

研究流程尽量由 SKILL 定义，而不是硬编码在 UI 或 prompt 中：

```text
skills/investigation-session/SKILL.md
skills/search-github/SKILL.md
skills/search-confluence/SKILL.md
skills/search-leanix/SKILL.md
```

能通过确定性脚本得到的事实直接运行脚本（例如 SQLGlot、rg、find、git），不要让模型用自然语言模拟执行结果。

## 当前 V1.1

```text
Source
  → Discovery
  → Evidence
  → Data Estate
  → Dataset / Column Lineage
  → Profiling
  → Findings
  → AI Analysis
  → Current-State Report
```

原则：LLM 负责理解、追问、推理和解释；确定性系统负责发现事实。Claim 必须引用 Evidence，状态由系统校正。

后续路线：

```text
V1.1  Current-State Discovery
V2    Semantic + Source-to-Target + Target Architecture
V3    Migration Waves + Validation
V4    Controlled Write / PR / Deployment
```

## 兼容 CLI

旧 CLI 仍保留用于脚本化场景：

```bash
npm run init -- demo --goal "Modernize Portfolio Analytics"
npm run discover -- demo --path ./legacy
npm run ask -- demo "Where does Position come from?"
npm run report -- demo
```

它们共享 `.workspace/<session-name>/context.json`，不是另一套状态存储。

## 环境

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `WORKSPACE_DIR` | 当前 workspace 根目录 | `.workspace` |
| `PORT` | Express Web server 端口 | `3000` |
| `HOST` | Express Web server bind 地址 | `127.0.0.1` |
| `COPILOT_MODEL` | Agent 使用的模型 | `gpt-5-mini` |
| `GITHUB_TOKEN` | 服务端模式使用；本机可直接复用 copilot 登录 | 空 |
| `TURN_TIMEOUT_MS` | 单轮等待上限 | `300000` |
| `SQLGLOT_PYTHON` | SQLGlot Python 解释器 | `python3` |
| `SKILLS_DIR` | Copilot SDK Skill 根目录 | `skills` |
| `COPILOT_SKILLS` | Copilot Lead Agent 默认预加载 Skill，逗号分隔 | `investigation-session,financial-data-review` |

## 检查

首次运行需要安装 SQLGlot：

```bash
python3 -m pip install -r requirements-dev.txt
npm install
```

然后：

```bash
npm run typecheck
npm test
npm run build
```

## 技术资料

Express 5 对 wildcard 路由等行为有调整；本项目使用 Express 5 的 `/{*splat}` 形式处理 SPA fallback。参见 https://expressjs.com/en/guide/migrating-5/。
