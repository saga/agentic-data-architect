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
