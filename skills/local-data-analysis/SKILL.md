---
name: local-data-analysis
description: 本地数据分析能力，适用于当前 Investigation workspace 中的 CSV、JSON、JSONL、Parquet 文件；使用 Dataset Registry 和 DuckDB 做结构查看、抽样、profiling、只读分析和证据记录。
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
- DuckDB 负责本地分析，不是整个应用的状态数据库。
- 不要直接打开 analysis.duckdb。
- 不要通过 Bash、Python 或 SQL 自己读取 workspace 外的文件、网络 URL 或其它数据库。
- local_query 只允许使用已经登记的数据集 relation，并且只允许单条 SELECT / WITH。
- local_transform 只能在当前 Investigation 的 analysis / scratch schema 中生成派生表，不会修改原始数据或外部数据库。
- local_export_parquet 只能把查询结果写到当前 Investigation 的 exports/ 或 parquet/ 目录。
- describe、sample、profile、query 的结果会自动保存为当前 Investigation 的 Evidence。
- 数据事实和 Agent 的业务解释必须分开。

## 大文件

Parquet 是首选的分析中间格式。大文件不要先转成巨大的 JSON 送给模型，让 DuckDB 直接扫描并只返回需要的结果。

## 输出习惯

先报告真实数据观察，再解释含义。profiling 结果不是业务事实；缺少业务定义时明确标记未知。
