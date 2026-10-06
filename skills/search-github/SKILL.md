---
name: search-github
description: 研究 GitHub repository、源代码、Issue、Pull Request、实现细节和历史行为，用于补充当前 Investigation 的实现证据。
metadata:
  kind: capability
---

# Search GitHub

用途：研究代码、仓库、Issue/PR、实现方式和历史行为。

## 访问方式

如果当前 Investigation 的目标或研究范围明确给出了 GitHub repository，优先调用工作台提供的 `research_github_repository`：它会把仓库放进当前 Investigation workspace 并自动跑一次 Discovery。之后再用 GitHub Tool、grep、view、Graphify 深入检查关键实现。

`research_github_repository` 解决的是“把仓库纳入本次调查并生成可引用 Evidence”；GitHub Tool 仍用于更灵活的跨文件/Issue/PR 搜索。

## GitHub MCP 调用规则

使用 GitHub MCP 的 `get_file_contents` 时严格使用以下参数：

- `owner`: repository owner，例如 `apache`
- `repo`: repository name，例如 `kafka`
- `path`: **仓库内相对路径**，例如 `README.md`、`src/main/java/foo/Bar.java`；不要传 GitHub URL、`owner/repo/path`、本地绝对路径或 workspace 路径
- `ref`: 分支、tag 或 commit；如果使用分支，优先传 `refs/heads/main` 这种明确 ref

例如：

```text
owner = apache
repo = kafka
path = README.md
ref = refs/heads/trunk
```

不要把目录路径当文件读取。如果目标是目录，先读取目录内容；目录路径和文件路径要区分。官方 GitHub MCP Server 的 `get_file_contents` 同时支持文件和目录，但目录应作为目录读取；其 ref 也支持 branch/tag/commit。urlGitHub MCP Server 文档https://github.com/github/github-mcp-server/blob/main/README.md

### 找不到文件时不要停

`get_file_contents` 返回：

```text
The path does not point to a file or directory, or the file does not exist
```

**这不是整个 Investigation 失败。** 按下面顺序恢复：

1. 检查 `owner` / `repo` 是否正确。
2. 检查 `ref` 是否正确；不确定时先使用 repository 默认分支，不要猜一个 branch。
3. 对上一级目录执行 `get_file_contents`，确认真实文件名和路径。
4. 如果目录也失败，使用 GitHub code search 搜索文件名、类名或关键符号。
5. 找到真实 path 后重新读取。
6. 如果仍然无法读取，把它记录为一个局部检索失败，然后**继续研究其它模块**，不要结束当前 Investigation，也不要把它变成需要用户回答的问题。

尤其不要因为一个文件 path 错误就让用户“确认路径”或停下来等待用户。Agent 应自己修正路径并继续。

## 大仓库策略

用户已经指定 repository 时，不要要求用户先执行 CLI discover。

优先：

1. `research_github_repository` 纳入当前 Investigation 并运行 Discovery。
2. 使用本地 clone / `rg` / `find` / `git` 深入检查关键模块。
3. GitHub MCP 用于远程补充检查、Issue/PR 和无法通过本地副本确认的内容。

大仓库、跨文件搜索、需要反复检查时优先本地 clone；小范围检查优先 GitHub Tool。

如果某一次 GitHub MCP 调用失败，不要反复对同一个错误 path 重试；切换到目录发现、code search 或本地 clone。

## 保存研究结果

研究结论和可复用资料保存到：

`.workspace/shared/github/<序号>-<topic>.md`

至少记录：
- GitHub URL
- repository
- branch / commit SHA
- 搜索 query
- 查看过的文件
- 重要发现
- 未解决问题

在当前 session 的 `context.json` 追加 `kind: research`，`artifactPath` 指向 shared 文件。

## 证据纪律

- GitHub 代码是实现证据，不是业务真相。
- 对关键代码关系（REST → Service → Entity → Table、配置、DAO、SQL 等），先查看实际源码，再用 `record_code_evidence` 保存文件和行号；不要只引用搜索结果或 Graphify 路径。
- GitHub / view / grep / bash 的原始结果可以用于当前调查推理；需要作为最终 Claim 的依据时，必须通过 Discovery 或其他确定性能力沉淀为 Evidence。
- README / architecture doc 是文档证据。
- Issue / PR 是讨论证据，要记录状态和时间。
- 不把完整内部源码复制到 shared 文档；保留路径、函数、行号或最小必要片段。
- 同一 repository 再次研究时优先增量更新已有 shared artifact。
- 用户明确要求修改哪个 branch 时直接修改指定 branch，不自动创建 branch。

## 自主性要求

GitHub 检索是整个架构研究的一部分，不是独立问答任务。

如果已经能够从 repository 得到足够信息，就继续向下完成：

`Current State → Data Flow → Data Model → Data Source → Transformation → Gap → Target Architecture`

不要因为一个局部文件、一个 branch、一个工具调用失败，就回到“请用户选择下一步”。

## 输入校验

必须有明确 repository、organization 或代码对象。Repository 一旦确定，先确认默认分支或明确 ref，不猜路径。

单个文件路径找不到时，应先发现真实路径并继续其它调查，不能因为局部检索失败就结束整个任务。
## 输出

纳入 Investigation 的仓库和重要研究结论必须可追溯。需要复用的研究资料保存到 .workspace/shared/github/，关键代码关系还必须登记正式 Evidence。
## 输出与验证

- repository、branch / commit SHA 和查看过的文件必须可追溯。
- 关键代码结论必须回到实际源码，不得只引用搜索结果。
- Issue / PR 必须记录状态和时间。
- 代码证据不能直接升级成业务事实。
## Gate

Gate 是“仓库来源确定、关键代码已读取、结论有具体文件/提交依据”。局部 path 错误不是整个任务的 Gate 失败；只有无法获得任何可复核来源时，才把研究结果标记为不可验证。
## 期望结果示例

> 在 commit abc123 中，PositionService 调用了 PositionRepository，后者读取 position_snapshot。这能证明当前代码路径，不足以单独证明 position_snapshot 是业务上唯一的权威来源。
