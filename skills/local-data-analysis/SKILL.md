---
name: local-data-analysis
description: 本地数据分析能力，适用于当前 Investigation workspace 中的 CSV、JSON、JSONL、Parquet、XLSX 文件；使用 Dataset Registry 和 DuckDB 做结构查看、抽样、SUMMARIZE profiling、只读分析、变换、对账、执行计划和证据记录。
metadata:
  kind: capability
---

# Local Data Analysis

这是一个本机数据分析能力。

## 什么时候使用

当 workspace 中有真实数据文件，问题需要字段结构、样本、统计特征、数据质量或 SQL 分析时使用。

## 标准顺序

通常按下面的顺序：

    local_catalog
      ↓
    local_describe
      ↓
    local_sample / local_profile
      ↓
    local_query

不要猜文件路径，先用 local_catalog。

## 重要边界

- Dataset Registry 保存文件路径、版本、大小和 SHA-256。
- DuckDB 是当前 Investigation 的分析数据平面，不是整个应用的状态数据库；应用状态仍由 SQLite 保存。
- 不要直接打开或修改 local.duckdb。
- 不要通过 Bash、Python 或用户 SQL 自己读取 workspace 外的文件、网络 URL 或其它数据库。
- XLSX 通过 DuckDB excel extension 读取；只支持 .xlsx，不支持老式 .xls。
- local_query 只执行已经登记数据集上的单条 SELECT / WITH；local_explain 在同样的只读边界内执行 EXPLAIN ANALYZE。
- local_transform 只能在当前 Investigation 的 analysis / scratch schema 中生成派生表，不会修改原始数据或外部数据库。
- local_reconcile 用明确的 keys 和数值 measures 做 source/target 对账；它是验证 Evidence，不是自动批准迁移。
- local_export_parquet 只能把查询结果写到当前 Investigation 的 exports/ 或 parquet/ 目录。
- describe、sample、profile、query、reconcile、explain 的结果会自动保存为当前 Investigation 的 Evidence。
- 数据事实和 Agent 的业务解释必须分开。

## 分析习惯

优先让 DuckDB 完成计算，再把小结果交给 Agent：

- profiling 优先使用 local_profile（底层使用 DuckDB SUMMARIZE）。
- 迁移验证优先使用 local_reconcile，而不是让模型手算 row count 或金额差异。
- SQL 性能问题使用 local_explain，不要凭 SQL 外观猜性能。
- 能导出为 Parquet 的中间结果尽量保存为 Parquet，方便后续重复分析。

## 大文件

Parquet 是首选的分析中间格式。大文件不要先转成巨大的 JSON 送给模型，让 DuckDB 直接扫描并只返回需要的结果。

## 输出习惯

先报告真实数据观察，再解释含义。profiling 结果不是业务事实；缺少业务定义时明确标记未知。

## 输入校验

开始分析前必须先通过 local_catalog 确认数据集已经登记，并且分析范围属于当前 Investigation workspace。

SQL 必须是只读查询；不能访问 workspace 外部文件、网络或其它数据库。
## 输出

结构查看、抽样、画像、查询、对账和执行计划的结果都会保存为当前 Investigation 的资料依据。需要重复使用的大结果优先保存为 Parquet 或分析文件，而不是塞进聊天。
## 输出与验证

- Dataset version 和 SHA-256 必须可追溯。
- 查询结果必须经过只读边界检查。
- profile / reconcile / explain 的结果必须记录分析运行信息。
- 模型只能解释已经计算出的结果，不能自行修改统计数字。
## Gate

分析 Gate 是“输入合法 + 查询只读 + 结果真实保存”。对账结果通过不等于迁移批准；它只是说明这次计算得到的结果满足相应检查条件。
## 期望结果示例

> 这份数据共有 120 万条记录，其中 3.2% 的 security_id 为空，重复业务键约 0.4%。这些数字来自本次实际计算；至于这些缺失是否可以接受，还需要结合业务规则判断。
