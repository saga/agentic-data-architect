---
name: structural-analysis
description: 快速理解 legacy / modernization 项目的代码和集成工件结构，帮助 Investigation 在深入查证前缩小范围。
metadata:
  kind: capability
---

# Structural Analysis

用途：快速理解 legacy / modernization 项目的代码和集成工件结构，帮助 Investigation 在深入查证前缩小范围。

## 输入校验

先确认待分析的仓库或工作目录可访问。结构索引是导航工具；已有索引可复用，源码明显变化时再重新生成。没有可访问的源码时，不要把缺失的结构索引解释成系统不存在相关能力。

## 边界

Code Structure Index 是本项目唯一的 structural-analysis 能力。它只产生结构导航信息，不直接产生 Evidence，也不替代 live metadata、SQL lineage、profiling 或 business semantics。

进入代码仓库后，优先：

~~~bash
npm run structure:index -- <repository>
~~~

然后：

~~~bash
npm run structure:query -- <repository> find <name> [kind]
npm run structure:query -- <repository> callers <nodeId>
npm run structure:query -- <repository> callees <nodeId>
npm run structure:query -- <repository> trace <fromNodeId> <toNodeId>
~~~

如果已有 `.code-structure/index.json` 和 `.code-structure/structure.duckdb`，query 直接读取 DuckDB projection；源码变化明显时重新 index。DuckDB 文件只是派生数据，可以删除后重新生成。

## 当前实现

TS/JS 使用 TypeScript compiler API；Java/Python/C# 使用 Tree-sitter；SQL 使用 SQL-specific extractor。所有 provider 最终合并为一个 canonical `.code-structure/index.json`，而不是多套图。成功 build 后会生成可重建的 `.code-structure/structure.duckdb` 作为 analytical projection；JSON 仍是 canonical source。

节点 ID 必须稳定：`file + kind + name + same-name ordinal`。不得把行号或字符 offset 放进 ID，因为插入注释/空行不应改变已有实体身份。

当前节点：
- file
- module / package
- class / interface / type
- function / method
- statement
- table / view / column
- job / pipeline（为 Control-M / SnapLogic 等 artifact extractor 预留）

当前关系：
- imports
- defines
- calls
- references
- contains
- reads / writes
- joins
- dependsOn

关系必须区分 exact / inferred。无法可靠解析的关系宁可不建立，也不要伪造 exact relation。

## 多语言策略

不要把所有东西都强行 Tree-sitter 化。遵循 ADR-035：

| 对象 | 实现策略 | 优先级 |
|---|---|---:|
| TS / JS / TSX | TypeScript compiler API | 已有 |
| Java | Tree-sitter extractor | P1 |
| Python | Tree-sitter extractor | P1 |
| C# | Tree-sitter extractor | P1 |
| SQL | SQL-specific extractor；当前使用 node-sql-parser，并保留 dialect 边界 | P1 |
| C/C++ / Go / Kotlin / Scala | Tree-sitter，真实项目需要时再加 | P2 |
| COBOL / PL-SQL / DB2 SQL | 真实 legacy 项目需要时增加 dialect/language extractor | P2 |
| Control-M | job/folder/dependency artifact extractor | P1（有该工件时） |
| SnapLogic | pipeline/export JSON artifact extractor | P1（有该工件时） |
| Snowflake | SQL extractor + Snowflake live metadata | P1（有该工件时） |
| YAML / JSON / XML / HCL | 按承载的架构语义增加轻量 artifact extractor | P2 |

Control-M、SnapLogic、Snowflake 不是普通 Tree-sitter language 问题。它们应映射为 job、pipeline、table、view、dependency 等领域对象。

## 调查规则

结构索引的正确使用方式是：

~~~text
Code Structure Index
  → 找到候选对象 / 路径
  → 回到源码、SQL、配置、metadata
  → 产生正式 Evidence
  → Claim 只引用 Evidence
~~~

如果结构索引与 Evidence 冲突，以 Evidence 为准。

## 输出

保留可重建的结构索引和其来源引用，供后续 Investigation 查询。正式调查结论仍应回到源码、SQL、配置或 metadata，并产生相应 Evidence。

## 输出与验证

结构索引是中间分析产物，应保留在 Investigation workspace。报告或正式 Claim 不得只引用结构图中的 inferred 关系作为已验证事实。

## Gate

Code Structure Index 的可用条件是：
1. snapshot 成功生成；
2. 关键结构关系可以回到原始来源；
3. 重要关系不能只依赖 inferred 结果；
4. 正式结论已经进入 Evidence。

不要因为结构图存在，就把结构关系直接写成 verified / supported business fact。

## 不做什么

- 不重新引入 Graphify。
- 不建立第二套 graph database。
- 不为了语言覆盖一次性实现几十种 parser。
- 不把 structural analysis 当作 lineage / metadata / business semantics 的替代品。

## 期望结果示例

发现 `OrderService` 调用了 `loadPositions` 后，先把调用关系作为源码导航线索，再回到实现和 SQL 确认它实际读取的数据；仅在形成可追溯 Evidence 后，才把数据来源写进架构结论。
