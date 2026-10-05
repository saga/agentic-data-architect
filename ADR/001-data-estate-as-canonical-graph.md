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
