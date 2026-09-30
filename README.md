# agentic-data-architect
使用AI Agent，完成Data Architect和Data Analyst的工作。尤其是在一个老项目进行modernize或者replatform的时候，对当前data model，data source，transformation等数据相关问题进行分析和设计

设计文档：`docs/architecture_0930.md`

## V1：Current-State Discovery（只做这条闭环）

```
本地 SQL / ETL → Discovery → Inventory → L1 Lineage → AI 问答 → Current-State 报告
```

原则：LLM 只负责理解事实，不负责发现事实。每个结论必须能回指 Evidence（状态只有 `verified / supported / inferred / unknown / contradicted`）。

## 快速开始

本机装好 `copilot` CLI 并登录即可（优先复用本机登录，服务器环境才需要 `GITHUB_TOKEN`）：

```bash
npm install
npm run init -- demo --goal "Modernize Portfolio Analytics" --scope Position,Price
npm run discover -- demo examples/investment/legacy
npm run ask -- demo "Where does Position come from?"
npm run report -- demo
```

环境变量（都有默认值，可不配）：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `COPILOT_MODEL` | 问答用的模型 | `gpt-5-mini` |
| `DATA_DIR` | Investigation 存盘位置 | `.data` |
| `GITHUB_TOKEN` | 配了就走服务端模式，不配就用本机 `copilot` 登录 | 空 |
| `TURN_TIMEOUT_MS` | 单轮等待上限 | `300000` |

## 目录

```
src/
  agent/copilot.ts        Copilot SDK 最小封装（本机 CLI 优先）
  evidence/types.ts       Evidence / Claim 核心对象
  investigation/store.ts  Investigation 存盘（单个 JSON）
  discovery/scanner.ts    本地目录扫描 → Inventory
  analysis/lineage.ts     L1 dataset 血缘（FROM/JOIN 正则）
  analysis/profiling.ts   文件级统计（DB profiling 预留 V1+）
  cli.ts                  init / discover / ask / report
  config.ts
examples/investment/legacy/  示例 SQL
```

V2 才做：列级血缘、domain/semantic 建模、source-to-target mapping。V3 才做：migration waves。
