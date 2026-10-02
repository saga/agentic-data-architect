# README Reference

README 只保留项目定位、总体架构和主要工作路线；本文件保存开发和运行时需要查阅的细节。

## Python 依赖与检查

Python 依赖的唯一声明位置是根目录 `pyproject.toml`；本地环境由 `uv` 管理。

~~~bash
uv sync
npm test
~~~

`npm test` 中的 Python 环境检查通过 `uv run` 执行 `scripts/check-python-deps.py`。不再维护 `requirements.txt` / `requirements-dev.txt` 或项目专用 Python 解释器环境变量。

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

## Investigation 与工作路线

新建工作默认采用自主调查，不要求选择 Workflow。可选工作路线为：

- `legacy-modernization`
- `financial-ai-native-architecture`
- `data-architecture-assessment`

Workflow 只是当前 Investigation 的可选工作方法，不是 Investigation 类型。用户可以在调查过程中切换或取消路线；context、消息、Evidence、Findings 和 workspace 状态不会因此重置。

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
GET  /api/sessions/:name/assessment
GET  /api/sessions/:name/report
GET  /api/sessions/:name/audit
GET  /api/shared
GET  /api/skills
POST /api/sessions/:name/files
~~~

## Skill 类型

统一使用 SKILL.md 打包，但 frontmatter 必须声明 metadata.kind：

~~~yaml
metadata:
  kind: capability
~~~

或：

~~~yaml
metadata:
  kind: workflow
~~~

capability 是 Agent 可以自由组合的能力；workflow 是由 Journey 约束阶段、顺序、Gate 和完成条件的完整工作路线。当前 workflow 是 legacy-modernization、financial-ai-native-architecture、data-architecture-assessment；search-confluence、search-github、search-leanix、financial-data-review 等都是 capability。

task 不是第三种 Skill 类型。复杂程度也不是分类标准。

## Agent / Skill 边界

核心代码负责 Evidence、Agent 输出 Schema、只读 SQL guard、Discovery / Lineage / Profiling、Investigation state 和 turn 生命周期。

Skill 负责领域检查方法、调查步骤、问题清单、研究来源使用方式和变化较快的业务知识。
`knowledge/` 负责可跨 Investigation 复用的架构经验；每条知识记录来源、资料时间、复核时间和可信度。知识只指导“怎么做”，不能替代当前 Investigation 的 Evidence。
三条 Data Architect Workflow 都以 kind: workflow 的 Markdown Skill 定义。Workflow 负责大阶段、顺序和 Gate；kind: capability 的 Skill 提供可自由组合的具体能力。当前三条路线分别是 legacy-modernization、financial-ai-native-architecture 和 data-architecture-assessment。

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
| SKILLS_DIR | Skill 根目录 | skills |
| KNOWLEDGE_DIR | 可复用架构知识根目录 | knowledge |
| COPILOT_SKILLS | 新 Investigation 默认 capability Skill | investigation-session,financial-data-review,structural-analysis,search-github,search-confluence,search-leanix,working-directory |

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
