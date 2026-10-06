---
name: current-data-architecture
description: 当前数据架构分析工作方式：把数据来源、数据流、核心数据对象、关键转换和业务含义查清楚，并形成一份容易读懂的现状报告；不负责架构评分、改造方案或实施路线。
metadata:
  kind: workflow
---

# 分析当前数据架构

这条工作方式只回答一个问题：

> 这套系统现在是怎么工作的？

它和“评估数据架构”不是一回事。这里先把现状讲清楚；不打分，不判断架构好不好，不设计目标架构，也不制定改造路线。

## 适用场景

- 想看清一个已有系统的数据来源。
- 想弄明白数据怎么流动、在哪里转换、谁在使用。
- 想整理核心表、文件、数据集、实体和关键字段的关系。
- 为后续架构评估、系统改造或数据治理先建立可靠的现状基础。

## 不负责什么

以下内容不属于本工作方式的交付：

- “这个架构好不好”的评分和评价；
- 风险分级和改进建议；
- Target Architecture；
- Source-to-Target Mapping；
- Migration / Replatform Roadmap。

发现明显问题时可以如实写出来，但只说明“现在看到的问题是什么、为什么需要注意”，不要顺手把它扩展成整改方案。

## @flow current-data-architecture

start -> intake

## @task intake

title: 先把要看的范围说清楚
objective: 明确这次为什么要看当前数据架构、重点看哪些对象、涉及哪些系统，以及最后希望拿到什么。
completeWhen: scope-ready
- success -> discovery

## @task discovery

title: 查清数据从哪里来、怎么流
objective: 从代码、SQL、数据目录、文档和已有调查资料中找出主要数据来源、数据流、核心数据集和关键转换。
completeWhen: current-data-architecture
- success -> synthesis

## @task synthesis

title: 把现在的架构讲明白
objective: 把已经查清楚的来源、数据流、数据模型、关键转换和业务含义组织成一份可以直接阅读的现状说明，并明确仍不能确认的地方。
completeWhen: current-data-architecture-ready
- success -> done

## @end done

title: 当前数据架构已经说明清楚
objective: 已形成一份以当前事实为基础、说人话的现状架构说明；未确认事项已经明确标出。

## 输入校验

正式开始前必须有用户确认的 Mission 和已通过的 Scope Validation。

至少要知道：

- 为什么做这次分析；
- 最后希望拿到什么；
- 需要看的范围；
- 涉及哪些系统或数据源。

用户只说“帮我看看”但没有明确范围时，不要猜。先把最关键的问题问清楚。

若已有 GitHub、Confluence、LeanIX、SQL、数据文件或 Discovery 结果，优先使用已有资料，不要求用户重复提供。

## 输出

本工作方式至少形成以下结果：

1. 数据来源：关键数据来自哪里，哪些只是候选来源。
2. 数据流：数据经过哪些系统、数据集、SQL / ETL / 服务，再到哪里。
3. 数据模型：核心数据对象、关键表/文件、主要关系和已经确认的业务含义。
4. 关键转换：真正改变业务结果的计算、过滤、关联和映射发生在哪里。
5. 未确认事项：哪些还不能确定，以及它们是否会影响当前理解。
6. 最终阅读报告：`reports/report.md`。

调查过程中产生的结构分析、研究资料、领域术语、数据分析结果等，继续放在 `artifacts/` 或既有 shared 目录中；不要把所有内容硬塞进一份 JSON。

## 输出与验证

结果不是“Agent 说查完了”就算完成。

- Discovery Snapshot 必须属于当前 Scope generation。
- 关键 Claim 不能引用不存在的资料编号，也不能把没有依据的内容写成已验证事实。
- 当前数据架构的最终报告必须通过通用 Report Gate，并经过独立 Reviewer。
- 中间分析结果必须保存到当前 Investigation 的 `artifacts/analysis/`，这样下一轮还能继续使用。
- 报告只总结已经形成的事实和明确的不确定项，不把推测包装成事实。

## Gate

本工作方式使用两层 Gate：

**阶段 Gate：** `current-data-architecture` 和 `current-data-architecture-ready` 由服务端根据真实 Discovery / Evidence / 当前成果判断。Agent 的“完成”声明不能直接推进 Workflow。

**最终输出 Gate：** 生成 `reports/report.md` 前必须通过 Mission、Scope 和结果完整性检查；报告生成后必须通过独立 Reviewer。Reviewer 暂时不可用时，报告可以保留，但状态为 blocked，不能当成已通过的正式结果。

## 期望结果示例

用户：

> 帮我分析这个系统现在的数据架构，我主要想知道 Position 从哪里来、经过哪些处理、最后被谁使用。

好的结果应该让人直接看到：

> Position 目前主要来自 A 数据集。进入 B 服务后经过两次转换：第一次去掉无效记录，第二次按 Security ID 聚合，最后写入 C 数据集供两个下游报表使用。  
>  
> 现在可以确认 A → B → C 这条主链路。历史回补流程还没有找到可靠依据，所以这部分暂时不能下结论。  
>  
> 报告里会同时列出关键数据对象、主要转换位置和还没查清楚的地方。

不应该出现：

> 当前架构评分 72 分，建议采用 Lakehouse，并在 Phase 2 重构 Position Pipeline。

后一句已经进入“评估”和“改造方案”，不属于本工作方式。