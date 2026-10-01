---
name: search-leanix
description: Research SAP LeanIX application facts, relationships, ownership, lifecycle, dependencies, and enterprise architecture evidence.
metadata:
  kind: capability
---

# Search LeanIX

用途：研究 SAP LeanIX 的 Fact Sheets、关系、生命周期、owner、应用依赖和其它企业架构事实。

## 工具

优先使用 SAP LeanIX 官方 MCP Server，不自己实现 REST connector，也不要用普通 Web Search 伪造 Fact Sheet 数据。

运行时发现实际 MCP tool 名称和 schema，不猜参数。

没有 LeanIX MCP 时，明确记录不可用；已有导出文档可以继续分析，但标明非实时来源。

## 研究顺序

```text
Business / Application → Fact Sheet → relationships → dependencies / owner / lifecycle / tags / criticality → 相关架构事实
```

## 保存

可复用研究结果放到：

`.workspace/shared/leanix/<序号>-<topic>.md`

记录查询目标、Fact Sheet id/name、查询时间、关键属性和关系、与当前 investigation 的关系、冲突和 unknown。

当前 session 的 `context.json` 通过 artifactPath 引用，`.workspace/shared/index.json` 做共享索引。

## 事实纪律

- LeanIX 是重要 architecture evidence，但不是绝对真相。
- 不根据名字猜 Fact Sheet 属性。
- 不把“已登记”写成“系统实际运行如此”。
- 与代码、运行数据、用户输入冲突时分别保存，不强行统一。