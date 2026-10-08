# ADR-034：移除 Graphify，Code Structure Index 成为唯一结构分析能力

- Status: Accepted
- Date: 2026-10-08
- Supersedes: ADR-007, ADR-033

## Context

项目原先把 Graphify 作为可选的外部 structural-analysis runtime，并逐步增加了 MCP、runtime 检查、Skill 强制前置和配置项。实际项目只需要其中最核心的能力：从源码建立结构关系并帮助 Agent 快速定位调用链和依赖。

继续保留 Graphify 会增加 Python runtime、MCP、安装和故障降级路径，也会让 Agent 存在两套结构分析实现。对于当前 Investigation，维护这些外围能力的收益不足。

## Decision

1. 完全移除 Graphify。
   - 不再支持 Graphify CLI / graphify-mcp。
   - 不再支持 Graphify MCP server。
   - 不再保留 GRAPHIFY_* 配置。
   - Agent Runtime 不再检查、注册、强制使用 Graphify。
   - OpenCode / Copilot 不再存在 Graphify-specific preflight、trajectory 或 capability。
2. 保留并正式采用 Code Structure Index 作为唯一 structural-analysis 实现。
3. Code Structure Index 采用分语言 Provider：
   - TS/JS 使用 TypeScript compiler API；
   - Java / Python / C# 使用 `@vscode/tree-sitter-wasm` 的预构建 WASM grammar；
   - SQL 使用 `node-sql-parser` 做 statement/table/column 级结构提取。
   最终统一生成 `.code-structure/index.json`；DuckDB 只是查询投影，不是 canonical source。
4. Code Structure Index 仍然只是结构导航层，不直接产生 Evidence；正式结论必须回到源码、SQL、metadata 或 deterministic analysis。
5. 不为了替代 Graphify 而重新建设通用 graph database、MCP server、community/god-node、embedding 或跨语言解析平台。
6. 节点 ID 使用 `file + kind + name + same-name ordinal`，不得使用行号或字符 offset；详见 ADR-035。
7. 多语言扩展遵循 ADR-035：TS/JS 保留 compiler API；Java/Python/C# 优先 Tree-sitter；SQL、Control-M、SnapLogic、Snowflake 使用领域 extractor。

## Runtime boundary

Agent Runtime 只需要知道 structural-analysis Skill 和普通源码工具。进入 structural-analysis 后，可以先运行：

    npm run structure:index -- <repository>

然后使用：

    npm run structure:query -- <repository> find <name> [kind]
    npm run structure:query -- <repository> callers <nodeId>
    npm run structure:query -- <repository> callees <nodeId>
    npm run structure:query -- <repository> trace <fromNodeId> <toNodeId>

查询结果用于缩小调查范围；需要形成正式结论时必须回到原始来源。

## Why

这样可以保留 Graphify 最有价值的设计思想——确定性 AST → 持久化结构索引 → 有界查询——同时删除不必要的外部 runtime、MCP 和双实现维护成本。

## Consequences

Positive:
- 项目不再依赖 Graphify 或 Python Graphify runtime。
- 结构分析路径只有一套，行为更容易预测和测试。
- 部署、启动、配置和 Agent preflight 更简单。
- .code-structure/index.json 可以作为 Investigation 中间分析产物继续复用。

Negative:
- 当前主要覆盖 TS/JS。
- 不再拥有 Graphify 的跨语言和高级 graph analysis 能力。
- 后续多语言扩展遵循 ADR-035，而不是重新引入 Graphify。

## Rejected alternatives

### A. 保留 Graphify 作为可选 fallback

拒绝。两套结构分析能力会产生运行时分支、配置分支和结果语义差异；当前收益不足以抵消复杂度。

### B. Fork Graphify

拒绝。项目不需要其完整产品面和 Python runtime。

### C. 立即建设通用 Graph Database

拒绝。当前结构导航使用 JSON snapshot 已足够。