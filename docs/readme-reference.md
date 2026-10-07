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
      analysis/

    workflow/
      journey.md
      journey-meta.json
      journey-layout.json
      journey-execution.json
      journey-draft.md
      journey-draft-layout.json
~~~

context.json 保存当前调查状态，不保存完整多轮聊天正文。

conversations.db 保存 user / assistant / system 消息，并使用 SQLite FTS5 做历史检索。

shared/ 保存跨 session 可以复用的研究资料。

## Investigation 与工作路线

新建工作默认采用自主调查，不要求选择 Workflow。可选工作路线为：

- `legacy-modernization`
- `current-data-architecture`
- `financial-ai-native-architecture`
- `data-architecture-assessment`

Workflow 只是当前 Investigation 的工作方法，不是 Investigation 类型。内置 Workflow 来自 Skill；进入全屏工作地图后可以复制为 Investigation 级自定义 Workflow，拖动节点、添加步骤和分支、修改 outcome，并在服务端验证通过后应用。工作方式本身的切换仍需要在“调查配置 → 工作方式”执行明确确认；Workflow Editor 的 draft/apply 不会修改内置 Skill。Agent Runtime 是独立的 execution 配置，不因为 Workflow 切换而改变。

每次完整 Investigation 至少留下 `reports/report.md`；每个有效调查 turn 还会在 `artifacts/analysis/` 留下一份中间分析记录。最终报告只读，不会因为页面刷新重新调用模型。

## API

~~~text
GET  /api/health
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:name
GET  /api/sessions/:name/messages?q=...
POST /api/sessions/:name/messages
POST /api/sessions/:name/messages/stream
PATCH /api/sessions/:name/workflow
POST /api/sessions/:name/messages/abort
GET  /api/sessions/:name/journey
GET  /api/sessions/:name/workflow
PUT  /api/sessions/:name/workflow
POST /api/sessions/:name/workflow/ai
POST /api/sessions/:name/workflow/transition
POST /api/sessions/:name/workflow/reset
GET  /api/sessions/:name/workflow/instruction
GET  /api/sessions/:name/modernization
GET  /api/sessions/:name/assessment
GET  /api/sessions/:name/report  # 返回 ReportArtifactState lifecycle contract
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

capability 是 Agent 可以自由组合的能力；workflow 是可选的、由 Journey 约束阶段、顺序、Gate 和完成条件的完整工作路线。当前可选 workflow 是 legacy-modernization、current-data-architecture、financial-ai-native-architecture、data-architecture-assessment；search-confluence、search-github、search-leanix、financial-data-review 等都是 capability。

task 不是第三种 Skill 类型。复杂程度也不是分类标准。

## Agent / Skill 边界

核心代码负责 Evidence、Agent 输出 Schema、只读 SQL guard、Discovery / Lineage / Profiling、Investigation state、turn 生命周期和 Runtime Stop/recovery 边界。

Skill 负责领域检查方法、调查步骤、问题清单、研究来源使用方式和变化较快的业务知识。
`knowledge/` 负责可跨 Investigation 复用的架构经验；每条知识记录来源、资料时间、复核时间和可信度。知识只指导“怎么做”，不能替代当前 Investigation 的 Evidence。
四条 Data Architect Workflow 都以 kind: workflow 的 Markdown Skill 定义。只有被当前 Investigation 选择时才进入 Journey；Workflow 负责大阶段、顺序和 Gate，kind: capability 的 Skill 提供可自由组合的具体能力。

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
| DATA_DIR | Agent Runtime / application 数据根目录 | .data |
| PORT | Web server 端口 | 3000 |
| HOST | bind 地址 | 127.0.0.1 |
| ALLOW_REMOTE_HOST | 非 loopback bind 的显式总开关 | false |
| COPILOT_MODEL | Copilot Runtime 的默认模型 | auto |
| AGENT_RUNTIME_DEFAULT | 新 Investigation 默认 Runtime | copilot-sdk |
| AGENT_RUNTIME_FALLBACK_ORDER | quota/usage exhaustion 时的 Runtime 顺序 | copilot-sdk,codebuddy-sdk,opencode-run |
| CODEBUDDY_DEFAULT_MODEL | CodeBuddy 默认模型 | glm-5.3-flash |
| CODEBUDDY_MODEL_ALLOWLIST | CodeBuddy 可用模型及顺序 | glm-5.3-flash,deepseek-v4.1-flash,space-bunny |
| CODEBUDDY_MAX_TURNS | 单次 CodeBuddy query 最大循环轮数 | 200 |
| OPENCODE_ENABLED | 是否启用 OpenCode Runtime | true |
| OPENCODE_BASE_URL | OpenCode serve 地址（模型发现） | http://127.0.0.1:4096 |
| OPENCODE_MODEL_ALLOWLIST | OpenCode 模型过滤 | 空 |
| OPENCODE_FALLBACK_MODEL | OpenCode quota fallback 模型 | 空 |
| GITHUB_TOKEN | GitHub API token | 空 |
| TURN_TIMEOUT_MS | Agent 单轮默认等待上限 | 360000 |
| USER_INPUT_WAIT_TIMEOUT_MS | 等待用户输入上限 | 3600000 |
| PERMISSION_WAIT_TIMEOUT_MS | 等待权限确认上限 | 3600000 |
| SKILLS_DIR | Skill 根目录 | skills |
| KNOWLEDGE_DIR | 可复用架构知识根目录 | knowledge |

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


## Workflow Editor

完整设计见 `docs/journey-workflow-editor.md`。工作地图使用 AntV X6，Workflow Definition 与画布布局分开保存。自动排版使用项目内置的 workflow-v2：S 型主线 + 两侧分支，不依赖 ELK。

核心边界：

~~~text
内置 SKILL.md
    ↓
Workflow Definition
    ├─ @flow / @task / @review / @end
    ├─ title / objective / actor / completeWhen
    └─ outcome -> target
          ↓
engine-neutral Graph
          ↓
X6
~~~

Workflow 负责高层工作阶段；Agent 在阶段内部自由调查。completeWhen 的业务含义由宿主 facts/evaluator 决定。retry 是普通真实 Edge，不创建 Group 或特殊节点。Execution 保存真实当前节点和完成状态，UI stages 只是投影。

