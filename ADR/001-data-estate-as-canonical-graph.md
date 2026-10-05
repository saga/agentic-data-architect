# ADR-001：DataEstate 作为唯一的规范数据资产图，并统一图查询

- Status: Accepted
- Date: 2026-10-05

## Context

项目已经通过 Discovery 将 SQL lineage、数据库 metadata、dataset、column、job 和其他资产关系汇总到 `DataEstate`。它是当前 Investigation 的统一实体/关系模型。

此前不同分析模块开始直接遍历自己的输入：

- `context.ts` 查询 `LineageGraph.tables/edges/columns`；
- `current-state.ts` 自己遍历 `DataEstate.nodes/edges`，同时又依赖 `LineageGraph.edges`；
- 后续的 impact、orphan、producer/consumer 等分析很容易继续重复实现同类 traversal。

如果这些查询继续分散，多个模块会逐渐对同一关系产生不同解释，尤其是 dataset lineage 和 column lineage。

## Decision

`DataEstate` 保持唯一 canonical graph model。

不建立第二套 CatalogAsset、CatalogEdge，也不增加独立的持久化 Catalog Query / Projection Layer。

重复的图 traversal 统一放入轻量的纯查询函数：

`src/model/estate-query.ts`

该模块只提供对 `DataEstate` 的查询，不保存新的状态，不复制图数据，不改变 graph 的 canonical ownership。

当前统一查询包括：

- node/type lookup
- edge from/to lookup
- incident edges
- dataset lineage relations
- upstream/downstream dataset relations
- column lineage relations

分析模块仍然直接消费 `DataEstate`，但图查询不得重新实现一套 `nodes/edges` traversal。

`LineageGraph` 继续作为 SQL parser 的 rich analysis result 保留，用于 parser-specific statements、parse failures 等信息；它不再作为跨分析模块的第二个 dataset/column graph source。

## Consequences

正面影响：

- DataEstate 真正成为单一事实来源；
- Current-State、Question Context、Future Impact Analysis 可以共享同一图语义；
- 减少重复 traversal 和隐藏的不一致；
- 不增加新的 domain model 或 persistence layer。

代价：

- 新的图查询需要先判断是否应加入 `estate-query.ts`；
- 该模块必须保持“查询工具”定位，不能逐步膨胀成第二个 Analysis domain。

## Rejected alternatives

### 建立独立 Catalog Query / Projection Layer

拒绝。当前项目是个人本机 Investigation workbench，DataEstate 已经存在且规模适中。再增加一层会制造新的对象生命周期和同步问题，却没有解决核心问题。

### 每个 Analysis 自己直接遍历 DataEstate

拒绝作为长期做法。短期简单，但重复 traversal 会重新形成当前已经出现的问题。
## Appendix A：形成决定时的分析记录（仅供参考）

这一决定来自对当前实现和 Duckle 的对比，而不是先假定项目需要一个 Data Catalog。

### 1. 当前代码已经有 canonical graph

src/model/estate.ts 定义了 DataEstate、EstateNode 和 EstateEdge。Discovery 在 src/workflow/discover.ts 中把 SQL lineage、数据库 metadata、dataset、column、job 和其他资产关系合并到这个图里。

因此当前最自然的数据流已经是：

```text
Discovery
  ↓
Lineage / Metadata
  ↓
DataEstate
  ↓
Analysis
```

不存在“没有 Catalog 所以需要先建 Catalog”的问题。

### 2. 真正发现的问题是查询实现重复

检查代码后发现：

- src/analysis/context.ts 自己从 LineageGraph 查询 dataset、dataset lineage、column lineage，再组合 semantic assets、source-of-truth candidates、findings 和 profiles。
- src/analysis/current-state.ts 自己遍历 DataEstate.nodes/edges，同时又从 LineageGraph.edges 重新计算上下游。
- 后续的 impact、producer/consumer、orphan、unresolved 等分析如果继续复制这类 traversal，会形成多个对同一关系的解释。

所以解决目标应该是“统一 query logic”，而不是“增加 Catalog”。

### 3. Duckle 的 Catalog 值得借鉴什么

研究 slothflowlabs/duckle 时，最值得借鉴的是它把跨 pipeline 的资产关系整理成可查询的结构，并配合 revision、staleness、diff、schema drift 等确定性能力。

但 Duckle 的 Catalog 是其 workflow/ETL 系统的独立数据结构。直接照搬到本项目会产生第二个资产模型，进而需要处理 DataEstate 与 Catalog 的同步、生命周期和一致性问题。

因此最后保留“统一查询”的思想，不复制 Duckle 的 Catalog 模型。

### 4. 也讨论过单独的 Projection Layer

曾考虑：

```text
DataEstate
  ↓
Catalog Query / Projection
  ↓
Current State / Findings / Impact / Retrieval
```

进一步分析后认为，在当前规模和“个人本机 Investigation workbench”定位下，这一层没有独立的数据拥有权，也没有新的 persistence boundary。

最终改为：

```text
DataEstate
  ↓
estate-query.ts
  ↓
Analysis
```

其中 estate-query.ts 只是纯查询函数集合，不是 domain model、repository、缓存层或 Catalog persistence。

### 5. 一个重要的边界判断

LineageGraph 没有被删除。

它仍然是 SQL parser 的 rich analysis result，承载：

- parsed statements
- parse failures
- parser-specific column lineage
- SQL statement details

但是跨分析模块使用的 dataset/column graph 事实统一回到 DataEstate。

因此两者的关系是：

```text
SQL Parser
   ↓
LineageGraph
   ↓
Discovery normalization
   ↓
DataEstate
```

而不是两个并列的 canonical graph。

### 6. 后续扩展原则

以后需要增加查询能力时，优先判断是不是对同一个 DataEstate 关系的重复遍历：

- 是：优先加入 estate-query.ts；
- 不是：继续放在对应 Analysis domain；
- 只有出现新的持久化事实模型或独立生命周期时，才重新考虑是否需要新的 projection/model。

这个附录保留的是当时的设计推导过程，不是额外的架构规则。