---
name: working-directory
description: Workspace conventions for investigation state, shared research artifacts, evidence, reports, and generated files.
---

# Workspace 约定

当前 workspace 只有两层：session 和 shared。

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

## Session

`.workspace/<session-name>/context.json` 是 Investigation 状态入口；user/assistant/system 多轮消息存放在 `.workspace/conversations.db`。

它记录：
- 用户最初要求
- goal / scope / systems
- 研究输入、重要事实和状态索引
- importantInformation / unknowns
- discovery runs / evidence / findings / claims
- 可恢复 Copilot session id

长篇分析结果、临时文件或生成物写到当前 session 的 `artifacts/`；聊天历史由 SQLite 保存。

## Shared

`.workspace/shared/` 保存跨 session 可以复用的资料。

`index.json` 只做轻量索引，至少包含：
- id
- kind
- path
- title
- source / uri
- updatedAt
- sessionNames（有需要时）

Confluence 下载页面保存为：

`.workspace/shared/confluence/<id>.md`

其它外部资料按来源放到对应目录。

## 规则

1. 新用户输入追加到 session context，不覆盖历史。
2. 长内容落文件，context.json 保留摘要和 artifactPath。
3. 外部研究资料优先沉淀到 shared，避免重复下载和重复研究。
4. 不保存 password、token、cookie、OAuth access token 等凭据。
5. 能由脚本确定性获得的事实，直接运行脚本；不要在 SKILL 或 prompt 中写一份会漂移的“内置答案”。
6. GitHub / LeanIX / Confluence 的具体访问流程由对应 SKILL 决定。