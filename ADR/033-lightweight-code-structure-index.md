# ADR-033：轻量级 Code Structure Index 作为 Graphify 的可替换实现

- Status: Accepted
- Date: 2026-10-08

## Context

项目已经把 Graphify 定义为 repository structural analysis capability，但 Graphify 是可选的外部 runtime。项目需要在不安装 Graphify 的环境中，仍然获得最有价值的结构分析能力，同时避免复制 Graphify 的完整产品面。

真正需要的是一层很小的 repository structure index：从源码建立稳定的节点和关系，持久化为可复用快照，并提供少量结构查询。它应该服务于 Data Architecture Investigation，而不是成为第二套通用 graph platform。

## Decision

### 1. 内部实现命名为 Code Structure Index

Code Structure Index 是本项目自己的轻量 structural-analysis provider。它不是 Graphify fork，也不实现 Graphify 的 MCP、可视化、community、god-node、向量检索等外围能力。

第一阶段只覆盖：

- file
- class / interface / type
- function / method
- import

关系只覆盖 Investigation 最有价值的最小集合：

- imports
- defines
- calls
- references

节点和边必须保留源码文件及行号；无法确定的关系不得伪装成 exact。

### 2. Provider 边界

上层 Investigation 只依赖 CodeStructureProvider，不直接依赖 Graphify 或内部索引实现。Graphify 可以继续作为外部 provider，Code Structure Index 是本地 provider。

最小查询接口：

- find(query)
- callers(nodeId)
- callees(nodeId)
- trace(from, to)

因此 Agent/Investigation 层只知道“结构查询”，不知道后端是 Graphify 还是本地索引。

### 3. 持久化采用 JSON 快照

第一阶段使用一个版本化 JSON 文件保存索引，不引入 Neo4j、NetworkX、DuckDB 或向量数据库。文件内容包含 repository root、index version、生成时间、文件 fingerprint、nodes、edges。

后续可以按文件 hash 增量更新，但第一阶段优先保证模型简单、可重放、容易测试。

### 4. Evidence 仍是事实边界

Code Structure Index 的查询结果是 structural observation。它可以帮助 Agent 定位源码并生成候选关系，但不能直接授予 verified 或 supported business claim。

正式 Evidence 必须回到源码、SQL、metadata 或 deterministic analysis，并带有 file/line/sourceHash 等 provenance。

### 5. 第一阶段实现范围

第一阶段先支持 TypeScript/JavaScript，使用项目已有 TypeScript compiler API 做确定性 AST 分析，不新增 parser runtime。Java、SQL 和其它语言通过同一个 provider abstraction 后续扩展。

忽略 node_modules、.git、dist、build、coverage 等生成目录。

## Minimal model

```ts
interface CodeNode {
  id: string;
  kind: 'file' | 'class' | 'function' | 'interface' | 'type';
  name: string;
  file: string;
  line?: number;
}

interface CodeEdge {
  from: string;
  to: string;
  kind: 'imports' | 'defines' | 'calls' | 'references';
  confidence: 'exact' | 'inferred';
  file?: string;
  line?: number;
}
```

Node id 必须由 repository-relative path + symbol identity 稳定生成，避免同一次 repository snapshot 因运行次序变化而产生不同 id。

## Query semantics

- find：按名称、路径或 kind 找节点；不执行模糊的业务语义推断。
- callers：返回直接 calls 入边。
- callees：返回直接 calls 出边。
- trace：只沿 calls 关系做有界 BFS，避免把 imports/references 当成调用路径。

查询结果必须带 node/edge provenance，方便回到源码验证。

## Rejected alternatives

### A. 安装或 fork Graphify

拒绝。项目只需要 Graphify 最有价值的结构索引思想，不需要复制完整工具链或引入额外 Python runtime。

### B. 直接建设通用 graph database

拒绝。当前收益主要来自结构导航，JSON 快照足够，数据库会增加部署、迁移和并发复杂度。

### C. 用正则表达式长期替代 AST

拒绝。正则可以作为未来某些语言的 fallback，但 TypeScript/JavaScript 第一阶段必须使用 AST，避免调用/定义关系因文本格式变化产生大量误判。

### D. 让 Code Structure Index 直接写 Evidence

拒绝。保持 structural observation 与 Evidence-first 事实模型的边界。

## Consequences

Positive：无需 Graphify 也能进行基本结构导航；代码量小；provider 可替换；查询结果可复现；未来可接入 Graphify 而不修改 Investigation contract。

Negative：第一阶段语言覆盖有限；本地 AST 解析不能立即达到 Graphify 的跨语言能力；需要维护索引版本和快照生命周期。