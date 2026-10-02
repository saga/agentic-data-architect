---
name: structural-analysis
description: 使用 Graphify 建立并查询本地代码、SQL、配置和项目文件的结构关系，帮助在深入调查前快速定位依赖、调用链和关键架构节点。
metadata:
  kind: capability
---

# Structural Analysis

用途：快速理解一个 legacy / modernization 项目的结构关系，尤其是代码、SQL、DDL、配置之间的依赖和路径。

## 什么时候使用

优先用于：
- 不熟悉的大型代码库或 legacy repository
- 想知道一个 dataset / table / module 从哪里来、被谁使用、和哪些对象连接
- 需要查一条调用链、依赖链、上下游路径
- 需要先定位最关键的架构节点，再进行 metadata、profiling 和 targeted query

不要用它替代：
- Snowflake / PostgreSQL 的 live metadata
- 本项目的 SQL AST lineage
- profiling 和 targeted query
- 已确认的 Business / Semantic Context

## 第一次进入 Investigation

先在当前 working directory 建立结构图：

~~~bash
graphify extract . --code-only --no-viz
~~~

这一步主要分析代码和 SQL，不要求 Graphify 自己调用 LLM。生成物位于：

~~~text
graphify-out/graph.json
~~~

已经存在并且需要更新时：

~~~bash
graphify update . --no-viz
~~~

## 调查方式

Graphify MCP 已作为 'graphify-structural-analysis' 注入当前 Copilot Session。优先使用：

- 'query_graph'：按自然语言问题找相关节点和边
- 'get_node' / 'get_neighbors'：查看一个对象及其直接关系
- 'shortest_path'：追踪两个对象之间的结构路径
- 'god_nodes' / 'graph_stats'：快速识别结构性枢纽和整体规模
- 'get_community'：理解一个对象所在的子系统

典型调查：

~~~text
用户问：position 是怎么产生的？

1. query_graph("how is position produced?")
2. 找到相关节点
3. shortest_path("source_position", "position")
4. 再回到本项目 Evidence / Lineage / Metadata 查原始证据
~~~

## 证据边界

Graphify 输出是 **结构导航和关系候选**，不是本 Investigation 的 Evidence。

必须遵守：

~~~text
Graphify
  → 找到可能相关的对象 / 路径
  → 定位原始代码、SQL、metadata 或 documentation
  → 用现有 deterministic discovery / query 产生 Evidence
  → Claim 只引用 Evidence ID
~~~

不得因为 Graphify 给出了某条 INFERRED 或路径，就把它直接写成 supported、verified 的业务事实。

如果 Graphify 与 Evidence 冲突，以 Evidence 为准，并把冲突作为下一步调查对象。

## 控制范围

Graphify 主要回答：

~~~text
“这些东西在结构上怎么连？”
~~~

本项目的其他工具回答：

~~~text
“数据库实际上是什么？”
“数据实际是什么？”
“业务含义到底是什么？”
“这条 lineage 有没有确定证据？”
~~~

复杂问题先 Graphify 缩小调查范围，再做 metadata / lineage / profiling / semantic investigation。
