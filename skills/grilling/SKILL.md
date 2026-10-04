---
name: grilling
description: 用 decision tree 和当前可回答的 decision frontier 检查复杂架构、业务定义和迁移决定；事实由 Agent 调查，真正的决定交给用户确认。
metadata:
  kind: capability
---

# Grilling

这个 Skill 用来把“还缺什么决定”讲清楚，而不是让 Agent 自己替用户做决定。

## 什么时候使用

适合：

- Source-of-Truth 选择
- 关键业务定义
- Target Architecture 重要取舍
- Source → Target Mapping 歧义
- Temporal / point-in-time 语义
- Cutover / rollback 关键决定
- 难以逆转的 Architecture Decision

普通资料查找不需要使用本 Skill。

## 核心方法

把问题组织成 decision tree：

`Decision A`
`  ├─ prerequisite → Decision B`
`  ├─ prerequisite → Decision C`
`  └─ prerequisite → Decision D`

只向用户提出当前已经具备前置条件的问题。

事实型问题不要问用户：

- 可以从代码查，就查代码。
- 可以从数据算，就用 DuckDB。
- 可以从 GitHub / Confluence / LeanIX 查，就先查。
- 可以从现有 Evidence 判断，就先整理 Evidence。

只有真正需要业务判断或授权的 decision 才交给用户。

## 与当前 UI 的关系

内部可以维护多个 decision frontier，但用户界面保持：

> 一次只问一个最有价值的问题。

不要因为用了 grilling 就一次显示十几个问题。

用户回答以后，重新计算 frontier；不要继续使用上一轮预先写好的问题列表。

## 决策纪律

- Agent 可以推荐答案，但不能把推荐当成用户决定。
- 如果事实没有查清楚，不应该强行进入 decision。
- 用户回答改变前提后，重新检查已经打开的 decision。
- 如果多个候选都合理，展示关键差异和 Evidence，不替用户选。
- 重大、难以逆转的决定才需要单独记录 ADR；普通选择不用滥用 ADR。

## 沉淀

如果用户确认了一个真正重要且难以逆转的决定，记录到：

`.workspace/<session>/artifacts/decisions/<slug>.md`

内容保持简单：

- Decision
- Options
- Chosen
- Why
- Evidence
- Revisit when

这不是每轮聊天的日志，也不是 Agent 的自我总结。

## 验收

好的 grilling 应该让用户看到：

> 目前已经查清楚了 A、B、C；真正卡住迁移的是 D。现在只需要你确认 D。

而不是：

> 根据我的判断，我们决定 D。
