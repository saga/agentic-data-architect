---
name: data-architecture-assessment
description: 现有数据架构评估工作路线：查清当前架构、找出主要问题、形成改进建议，并排出实施顺序。
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
completeWhen: goal

## @task current-state

title: 查清当前架构
objective: 看数据资产、系统、数据流、数据模型、主要使用方、技术栈和关键依赖；不要只看架构图。
completeWhen: assessment-current-state

## @task findings

title: 找出主要问题
objective: 从 Evidence、Lineage、数据质量、业务定义、治理、安全、技术债和运行情况中找出真正影响业务的问题，并标明哪些仍然未知。
completeWhen: assessment-findings

## @task recommendation

title: 给出改进建议
objective: 每条建议都说明解决什么问题、需要什么依据、影响什么范围，并区分事实、推断和建议。
completeWhen: assessment-recommendation

## @task roadmap

title: 排出实施顺序
objective: 把建议按依赖、风险、业务影响和实施难度排成几个阶段，不把所有问题都列成同一级。
completeWhen: assessment-roadmap

## @end done

title: 评估完成
objective: 当前架构、问题、建议和实施顺序已经形成一份可继续讨论的评估结果。
