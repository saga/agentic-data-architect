---
name: search-confluence
description: 研究公司内部 Confluence 中的架构文档、ADR、业务说明、运行手册、流程和约束，用于补充内部业务与架构证据。
metadata:
  kind: capability
---

# Search Confluence

用途：研究公司内部设计文档、业务说明、运行手册、ADR、流程说明和其它 Confluence 知识。

## 工具

优先使用 Atlassian 官方 Rovo MCP Server。

运行时从可用 MCP tools 中发现真实的 Confluence tool 和 schema，不猜工具名称或参数。

没有 Confluence MCP 时，明确记录不可用；不要用普通 Web Search 猜私有页面内容。用户提供的导出文档可以继续分析，但要标明来源。

## 研究顺序

```text
Search → 确认 page / space / 更新时间 → 读取完整页面 → 查 related pages / ADR / runbook → 提取事实、定义、决策、约束
```

特别关注 current / target state、owner、superseded / obsolete、引用的系统版本和 Jira issue。

## 保存

页面 Markdown 放到：

`.workspace/shared/confluence/<id-or-sequence>-<topic>.md`

至少保留：
- query
- space / page id / title
- URL
- last updated time
- 关键事实
- 重要引用位置
- 与代码/数据的冲突
- 未解决问题

并把对应 artifactPath 登记到当前 session 的 `context.json` 和 `.workspace/shared/index.json`。

不要把原始 MCP 大对象整段塞进聊天；页面本体作为 Markdown 文件复用。

## 写操作

默认 read-only。只有用户明确要求更新 Confluence，且当前任务允许写操作时才执行。
## 输入校验

必须有明确的 Confluence 搜索目标或用户提供的页面线索。没有 Confluence MCP 时不能假装已经读取私有页面。

需要关注页面更新时间、状态和是否已经被替代；不把页面标题当成事实。
## 输出

可复用页面资料保存到 .workspace/shared/confluence/，当前 Investigation 通过 artifactPath 引用。
## 输出与验证

- 必须记录页面或空间标识、标题、URL 和最后更新时间。
- 重要结论需要保留原文定位信息。
- 页面与代码、运行数据冲突时分别记录，不能静默统一。
- 不把 Confluence 上写着的内容直接当成系统实际运行状态。
## Gate

Gate 是“页面确实读到了 + 来源可追溯 + 关键事实有定位”。MCP 不可用、页面不可读或证据不足时，结果只能标记为未知/局部资料。
## 期望结果示例

> Confluence 的 2026-09-18 架构文档描述 A 是主数据源，但当前代码显示 B 也在写入同一数据集。两者冲突已经记录，不能直接把 A 认定为唯一来源。
