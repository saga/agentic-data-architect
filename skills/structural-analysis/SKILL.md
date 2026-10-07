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

Investigation 进入代码仓库后，宿主运行时会先确保当前 working directory 有一份可查询的 Graphify 结构图。第一次没有 graph 时生成，正式 Discovery 会刷新已有 graph。Skill 自己负责在源码明显变化后按需刷新：

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

Graphify MCP 已作为 'graphify-structural-analysis' 注入当前 Agent Runtime。进入 structural-analysis 后，它是第一项结构调查动作；常规 grep / view / bash 只能用于后续源码核对：

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

运行时会检查 structural-analysis 是否先使用 Graphify；如果先调用 grep / glob / view / bash，系统会要求先完成 Graphify 结构查询。精确文本、文件发现、Git 操作等没有进入 structural-analysis 时仍直接使用常规工具。

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

## 输入校验

开始前必须确认工作目录是当前 Investigation 的研究目录，并检查 Graphify 是否可用。

Graphify 只用于结构导航；需要业务结论时必须再查源码、SQL、数据或正式资料。
## 输出

Graphify 生成的图和查询结果属于中间分析产物。继续分析时保留在当前 workspace，并把关键关系回写到正式 Evidence。
## 输出与验证

- graph.json 必须能生成并有稳定 hash。
- 重要关系必须可以追溯到原始代码、SQL 或配置。
- Graphify 输出不能直接变成 supported / verified 业务结论。
## Gate

Gate 是“结构图生成成功 + 关键路径能回到原始来源”。如果只能得到 Graphify 路径、找不到原始依据，就只能把它当作待验证线索。
## 期望结果示例

> Graphify 找到 A → B → C 的代码依赖。进一步查看源码后，确认 A 确实调用 B；C 只是结构上可达，目前还没有证据证明它参与这个业务流程。
