---
name: search-leanix
description: 研究 SAP LeanIX 中的 Fact Sheet、应用关系、owner、生命周期、依赖和企业架构事实，用于补充当前架构调查。
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
## 输入校验

必须有明确 Fact Sheet、应用或架构对象。使用实际 LeanIX MCP 时再根据真实 schema 调用工具，不猜字段。

没有 LeanIX MCP 时，只能使用用户提供的导出资料，并明确标记资料不是实时数据。
## 输出

可复用结果保存到 .workspace/shared/leanix/，当前 Investigation 通过 artifactPath 引用。
## 输出与验证

- 记录 Fact Sheet id / name、查询时间和关键关系。
- owner、lifecycle、criticality 等属性必须来自实际返回数据。
- 与代码或运行数据冲突时保留两个来源，不静默覆盖。
## Gate

Gate 是“对象确实找到 + 属性来源可追溯 + 关系没有凭名称猜出来”。没有实时访问能力时，结果只能按导出资料的时间范围使用。
## 期望结果示例

> LeanIX 当前把 A 标成 retired，但代码仓库在 2026-10-01 仍有部署配置。这里应该先记录“系统登记状态”和“实际代码状态”两个事实，不直接宣布 A 已停止使用。
