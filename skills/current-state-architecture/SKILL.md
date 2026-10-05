---
name: current-state-architecture
description: 现状架构分析能力：从代码、SQL、数据目录、Lineage 和 Evidence 中梳理当前系统的 Data Source、Data Flow、Data Model、关键转换和明显缺口。
metadata:
  kind: capability
---

# 现状架构分析

这个能力用于回答：

> “现在这套系统的数据架构到底是什么？”

它不是一条固定 Workflow，也不是问题清单。

## 核心产出

### Data Source

找清楚关键数据从哪里来：

- 数据库、表、视图、文件、外部系统
- API / Service / Job 等入口
- 哪些来源只是候选，哪些有更强证据支持
- source-of-truth 候选及依据

### Data Flow

把关键数据怎么流动串起来：

- Source → ingestion / service → transformation → target / consumer
- REST / Service / Repository / SQL / ETL 的关键关系
- dataset / column lineage
- 关键下游使用方

### Data Model

说明数据怎么组织：

- 核心实体和业务对象
- 关键表 / 视图 / 文件
- 主键、外键和主要关系
- 一个实体在不同系统里的对应关系
- 关键字段的业务含义

### Transformation

找出会改变业务结果的关键处理：

- SQL / ETL / Java / Python 等转换
- join / filter / aggregate / mapping
- 派生字段和关键业务规则

### Gap

只留下真正影响用户目标的缺口：

- 当前还不知道什么
- 为什么它可能影响结论
- 能不能从现有资料继续查
- 如果继续查，最有价值的方向是什么

## 调查原则

1. 先覆盖 Source、Flow、Model，再补细节。
2. 不因为一个字段或一个 unknown 很有意思，就偏离用户目标。
3. unknown 不是任务队列；只有影响当前交付或下一步关键决策时才值得继续调查。
4. Evidence 是事实依据；Graphify / 搜索结果可以帮助导航，但不能单独证明业务含义。
5. 已经足够回答用户问题时就停止，不需要把所有未知都清零。
6. 用户要求“当前系统的数据架构 / 数据模型 / data flow / data source”时，直接使用这个能力，不要求先选择工作模式。

## 典型结果

对“帮我看一下这个老系统的数据架构”这类问题，至少应形成：

- 一张可以讲清楚主要 Source → Flow → Model 的现状说明
- 关键数据对象及其关系
- 最重要的转换位置
- 少量真正影响结论的未决问题

不要把结果写成“发现了 N 个问题”的问题清单。
