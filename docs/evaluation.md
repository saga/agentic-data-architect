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
   按证据数量重算（无证据→unknown，verified→inferred，supported 需 2+ 证据）。
3. 测试层：`golden.test.ts` 断言谎称 verified 的输出被校正为 unknown。

换模型（GPT / Claude / Gemini）时直接重跑同一套 golden，对比上表即可，
不需要肉眼判断“好像更聪明了”。

## V1.1 可靠性回归

- query safety：覆盖 CTE 写操作、字符串中的分号、锁定查询、SELECT INTO。
- evidence traceability：覆盖 column lineage、profile table、profile column 都能进入 Agent context 并携带 evidence id。
- workspace safety：覆盖 database URI 脱敏，避免密码/token 写入 context。
- profiling performance：PostgreSQL / Snowflake 的 profile 已收敛为每表一次聚合 + 一次小样本，而不是每列多次全表查询。

## 依赖安全回归

CI 对生产依赖执行 critical blocking audit；high severity audit 当前为 informational，因为 Snowflake driver 的已知 `toml` 传递依赖问题尚无兼容的上游修复。恢复 high blocking 的条件是 Snowflake SDK 发布使用已修复 `toml` 版本且不需要破坏性降级。
