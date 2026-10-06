# Evaluation

测“证据对不对”，不只测“答案像不像”。

## Golden dataset

`examples/investment/golden/`：4 个 legacy SQL（故意埋了双 Position 源、重复 `market_value` 逻辑、
`security_id`/`sec_id` 碎片、无时间列的 NAV）+ `expected/lineage.json` + `expected/findings.json`。

跑：`npm test`（`tests/evaluation/golden.test.ts`）。

## 指标

| 指标 | 定义 | 当前 golden |
| --- | --- | --- |
| lineage precision | 抽出的 dataset 边里对的比例 | 1 |
| lineage recall | 期望边里找回的比例 | 1 |
| column mapping accuracy | 期望列边（源表.源列 → 目标列）命中数 | 全命中 |
| finding accuracy | 期望 finding 类型全检出 | 全检出 |
| evidence coverage | claim 引用的 evidence id 真实存在 | 100%（不存在的自动剔除+告警） |
| **unsupported claim rate** | 无证据支撑却给出非 unknown 状态的 claim 比例 | 0（`calibrateStatus` 强制降级） |
| unknown recall | 该说不知道时说了不知道 | 由校正规则保证下限 |

## Unsupported Claim Rate（核心指标）

```
Agent 自信地说了 X，但没有任何 evidence 支持 X → unsupported
```

防线有三层，全部可测：

1. 提示词层：`prompts.ts` 禁止模型自报 `verified`。
2. 校验层：`result.ts` 剔除不存在的 evidenceId（记 warning），`calibrateStatus`
   按 evidence provenance 重算（无证据→unknown，verified→inferred，supported 需要至少 2 个独立来源）。同一个文件/hash 的多条 Evidence 不会因为数量达到 2 就自动变成 supported。
3. 测试层：`golden.test.ts` 断言谎称 verified 的输出被校正为 unknown。

换模型（GPT / Claude / Gemini）时直接重跑同一套 golden，对比上表即可，
不需要肉眼判断“好像更聪明了”。

## V1.1 可靠性回归

- query safety：覆盖 CTE 写操作、字符串中的分号、锁定查询、SELECT INTO。
- evidence traceability：覆盖 column lineage、profile table、profile column 都能进入 Agent context 并携带 evidence id。
- workspace safety：覆盖 database URI 脱敏，避免密码/token 写入 context。
- profiling performance：PostgreSQL / Snowflake 的 profile 已收敛为每表一次聚合 + 一次小样本，而不是每列多次全表查询。

## Structural Analysis 回归

- Graphify runtime 安装检查：`graphify-mcp --help` 必须能够启动。
- Graphify extraction：真实生成 `graphify-out/graph.json`，并检查 graph SHA-256 可计算。
- Graphify graph/version/hash 进入 Discovery snapshot 和 turn audit；Graphify 结果本身不直接成为 Evidence。

## 依赖安全回归

CI 对 Node 生产依赖执行 critical audit；Python 生产依赖从 `uv` 锁定项目导出后交给 `pip-audit` 做 strict audit。恢复 high blocking 的条件是 Snowflake SDK 发布使用已修复 `toml` 版本且不需要破坏性降级。


## Skill Contract 回归

所有 `skills/*/SKILL.md` 都必须写清：

- 输入校验
- 输出
- 输出与验证
- Gate
- 期望结果示例

`npm run flow:lint` 和 `tests/skill.test.ts` 会检查这五项是否缺失。这个检查只保证“写清楚了契约”，不会假装它已经证明业务结果正确；真正的结果正确性仍由对应的 Schema、脚本、确定性 Gate 和独立 Reviewer 负责。

## Investigation Report 回归

每次完整 Investigation 最终都应有 `reports/report.md`。报告生成前检查任务、范围、真实调查成果、中间分析记录和资料引用；生成后再由独立 Reviewer 检查是否真的回答了用户目标、是否容易读懂、是否存在明显越界或矛盾。

Reviewer 不可用、报告过期或报告资料与当前任务不一致时，都不能把结果标成当前可交付结果。
