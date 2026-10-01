# README Reference

README 只保留项目定位、总体架构和主流程；本文件保存开发和运行时需要查阅的细节。

## Web UI

~~~bash
npm install
npm run start
~~~

开发模式：

~~~bash
npm run dev
~~~

前端使用 Ant Design 6、Ant Design X 2.9 和 XMarkdown 2.9。

## Workspace

~~~text
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
~~~

context.json 保存当前调查状态，不保存完整多轮聊天正文。

conversations.db 保存 user / assistant / system 消息，并使用 SQLite FTS5 做历史检索。

shared/ 保存跨 session 可以复用的研究资料。

## API

~~~text
GET  /api/health
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:name
GET  /api/sessions/:name/messages?q=...
POST /api/sessions/:name/messages
POST /api/sessions/:name/messages/stream
POST /api/sessions/:name/messages/abort
GET  /api/sessions/:name/journey
GET  /api/sessions/:name/modernization
GET  /api/sessions/:name/report
GET  /api/sessions/:name/audit
GET  /api/shared
GET  /api/skills
POST /api/sessions/:name/files
~~~

## Agent / Skill 边界

核心代码负责 Evidence、Agent 输出 Schema、只读 SQL guard、Discovery / Lineage / Profiling、Investigation state 和 turn 生命周期。

Skill 负责领域检查方法、调查步骤、问题清单、研究来源使用方式和变化较快的业务知识。
Legacy Modernization Journey 也以 Markdown Skill 定义路线；Workflow 负责顺序和 Gate，Skill 负责每一关的调查方法。

## CLI

~~~bash
npm run init -- demo --goal "Modernize Portfolio Analytics"
npm run discover -- demo --path ./legacy
npm run ask -- demo "Where does Position come from?"
npm run report -- demo
~~~

CLI 和 Web 共用同一个 Investigation workspace。

## 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| WORKSPACE_DIR | workspace 根目录 | .workspace |
| PORT | Web server 端口 | 3000 |
| HOST | bind 地址 | 127.0.0.1 |
| COPILOT_MODEL | Agent 使用的模型 | gpt-5-mini |
| GITHUB_TOKEN | 服务端 Copilot Token | 空 |
| TURN_TIMEOUT_MS | 单轮等待上限 | 300000 |
| SQLGLOT_PYTHON | SQLGlot Python 解释器 | python3 |
| SKILLS_DIR | Skill 根目录 | skills |
| COPILOT_SKILLS | 新 Investigation 默认 Skill | investigation-session,financial-data-review,legacy-modernization |

## 检查

~~~bash
npm run typecheck
npm test
npm run build
npm run flow:lint
~~~

## 相关文档

- [architecture_0930.md](architecture_0930.md)
- [data-control-flow.md](data-control-flow.md)
- [evaluation.md](evaluation.md)
- [implementation.md](implementation.md)
- [current-state-intelligence.md](current-state-intelligence.md)
