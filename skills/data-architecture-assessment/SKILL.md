---
name: data-architecture-assessment
description: 完整的数据架构评估工作路线：在现状架构基础上识别主要问题、形成改进建议，并排出实施顺序；普通的“看懂当前系统”应直接使用现状架构分析能力。
metadata:
  kind: workflow
---

# 数据架构评估

这条路线用于“现在这套数据架构到底怎么样、哪里有问题、先改什么”，而不是直接做迁移，也不是从零设计新平台。

> 这是工作路线，不是审批引擎。Agent 在每一阶段里自行调查；只有已有 Evidence、Current-State 和评估产物发生变化，Journey 才会前进。
>
> 通用经验来自 `knowledge/`。知识只解释“通常怎么做”，不能当成当前项目的事实；当前项目事实必须来自 Investigation Evidence。

## 适用场景

- 通用数据架构评估
- 数据平台 / Lakehouse / Warehouse 架构评估
- Data Governance / Data Quality / Lineage 评估
- AI Readiness 评估
- 成本、性能、可扩展性评估

评估结果通常回答四件事：

1. 现在是什么情况？
2. 主要问题和风险是什么？
3. 应该往哪里改？
4. 应该按什么顺序改？

## @flow data-architecture-assessment

start -> intake

## @task intake

title: 明确评估目标
objective: 先说清楚为什么做这次评估、评什么、谁使用结果、最终要交付什么。
completeWhen: scope-ready
- success -> current-state

## @task current-state

title: 查清当前架构
objective: 看数据资产、系统、数据流、数据模型、主要使用方、技术栈和关键依赖；不要只看架构图。
completeWhen: assessment-current-state
- success -> findings

## @task findings

title: 找出主要问题
objective: 从 Evidence、Lineage、数据质量、业务定义、治理、安全、技术债和运行情况中找出真正影响业务的问题，并标明哪些仍然未知。
completeWhen: assessment-findings
- success -> recommendation

## @task recommendation

title: 给出改进建议
objective: 每条建议都说明解决什么问题、需要什么依据、影响什么范围，并区分事实、推断和建议。
completeWhen: assessment-recommendation
- success -> roadmap

## @task roadmap

title: 排出实施顺序
objective: 把建议按依赖、风险、业务影响和实施难度排成几个阶段，不把所有问题都列成同一级。
completeWhen: assessment-roadmap
- success -> done

## @end done

title: 评估完成
objective: 当前架构、问题、建议和实施顺序已经形成一份可继续讨论的评估结果。

## 输入校验

正式开始前必须有用户确认的 Mission 和已通过的 Scope Validation。

评估范围必须说明至少一项评价对象，例如数据平台、数据治理、数据质量、AI 使用准备度、成本或性能。若用户只要求“看懂当前系统”，应使用“分析当前数据架构”，不要自动把这次任务升级成评估。

进入问题识别前，应先有足够的当前数据架构事实。不能只根据平台名称、架构图标题或模型常识打分。

## 输出

这条路线至少形成：
1. 当前情况：只引用本次调查已经确认的现状。
2. 主要问题：说明问题是什么、影响什么、依据是什么。
3. 改进建议：说明解决什么问题，为什么值得做。
4. 实施顺序：说明先做什么、依赖什么、为什么这样排。
5. 最终阅读报告：reports/report.md。
6. 评估结构化结果：reports/architecture-assessment.json。

## 输出与验证

- architecture-assessment.json 必须通过运行时 Schema 校验。
- 每个正式问题和建议都必须能回到本次 Investigation 的资料依据；不能用通用经验替代当前项目事实。
- 评估报告不能把“建议”写成“事实”，也不能把“当前不知道”写成“架构缺陷”。
- 最终报告必须经过通用 Report Gate 和独立 Reviewer。
- 中间分析过程产生的资料继续保存到 artifacts/，不要只留下最终 JSON。

## Gate

阶段 Gate 必须使用当前 Investigation 的真实结果，而不是 Agent 的 success 文本：
- 当前架构阶段：已有足够的当前架构事实。
- 问题阶段：至少形成有依据的问题。
- 建议阶段：主要问题都有明确、具体的处理建议。
- 路线阶段：建议已经按依赖和影响形成可理解的顺序。
- 最终输出：结构化结果有效，范围仍然有效，最终报告审核通过。

Reviewer 暂时不可用时，结果不能标成已审核完成；报告可以留下，但状态必须是 blocked。

## 期望结果示例

用户：
> 评估这个数据平台目前最大的问题，告诉我先改什么。

好的结果应该先说：
> 目前最主要的问题不是平台本身，而是关键数据来源没有统一、部分链路也查不清楚。这样会直接影响报表和后续数据产品的可信度。
>
> 第一件事先把关键数据来源和口径定下来；第二件事补关键链路；第三件事再考虑平台层面的调整。这样改的原因是前两件事不解决，后面的平台改造很难验证效果。

这里可以继续给出评估依据和具体问题，但不能直接跳成某个厂商产品的购买建议。
