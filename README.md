# agentic-data-architect

使用 AI Agent 做 Data Architect / Data Analyst，重点解决老系统 modernize / replatform 时的 data model、source、transformation、lineage 和业务上下文分析。

## 现在怎么用

安装后直接进入持续 Investigation session：

```bash
npm install
npm run start
```

也可以指定 session：

```bash
npm run start portfolio-analytics
npm run dev portfolio-analytics
```

启动后 Agent 会逐步了解：
- 要做什么分析、最终要回答什么问题
- 业务上下文、范围、时间点、约束
- 相关文件、文档、Confluence、GitHub repository
- 希望得到什么产出

之后保持同一个 session。用户可以继续补充、提问、提供新的资料或纠正方向，不需要重新执行一串命令。

交互命令：

```text
/report   生成当前 Current-State Report
/context  显示当前 context.json
/help     查看命令
/exit     保存并退出
```

退出后再次使用同一个 session name，会尝试恢复同一个 Copilot session，并继续读取已有 workspace context。

## Workspace

当前唯一主目录是 `.workspace`：

```text
.workspace/
  shared/
    index.json
    confluence/
    github/
    leanix/
    web/
    document/
    other/
  portfolio-analytics/
    context.json
    transcript.md
    discovery/
    reports/
    artifacts/
```

`context.json` 是当前 Investigation 的主要状态入口。

`.workspace/shared/` 是跨 session 可复用资料区。例如 Confluence 页面下载为：

```text
.workspace/shared/confluence/<page-id>.md
```

可复用资料同时登记在 `.workspace/shared/index.json`。

## Research Skills

研究流程尽量由 SKILL 定义，而不是硬编码在 TypeScript prompt 中：

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

持续 session 是默认入口，旧 CLI 仍保留用于脚本化场景：

```bash
npm run init -- demo --goal "Modernize Portfolio Analytics"
npm run discover -- demo --path ./legacy
npm run ask -- demo "Where does Position come from?"
npm run report -- demo
```

## 环境

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `WORKSPACE_DIR` | 当前 workspace 根目录 | `.workspace` |
| `COPILOT_MODEL` | Agent 使用的模型 | `gpt-5-mini` |
| `GITHUB_TOKEN` | 服务端模式使用；本机可直接复用 copilot 登录 | 空 |
| `TURN_TIMEOUT_MS` | 单轮等待上限 | `300000` |
| `SQLGLOT_PYTHON` | SQLGlot Python 解释器 | `python3` |

## 检查

```bash
npm run typecheck
npm test
```