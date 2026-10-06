# ADR-022：Current Data Architecture 与 Data Architecture Assessment 分开

- Status: Accepted
- Date: 2026-10-06

## Context

“分析当前数据架构”和“评估数据架构”原来没有清晰分开。现状架构分析主要回答“系统现在是什么样”，数据架构评估却又包含了一遍“查清当前架构”，导致两个入口容易产生重复工作，也让用户难以理解两者区别。

同时，新建 Investigation 需要可以明确选择“分析当前数据架构”，而不是只能选择更宽泛的自主调查。

## Decision

建立两个明确的工作方式：

### Current Data Architecture

Workflow id 为 `current-data-architecture`，负责回答：

> 这套系统现在是怎么工作的？

重点形成：

- 数据从哪里来；
- 数据经过哪些系统、表、文件、服务和转换；
- 核心数据对象如何组织；
- 关键业务含义和仍然无法确认的地方。

它不负责给架构打分、不负责判断“好不好”、不负责给出目标架构，也不负责制定改造路线。

### Data Architecture Assessment

Workflow id 为 `data-architecture-assessment`，负责回答：

> 现在这套数据架构怎么样，主要问题在哪里，先改什么？

它把 Current Data Architecture 作为输入基础，再增加：

- 架构问题和风险；
- 评价依据；
- 改进建议；
- 建议的实施顺序。

Assessment 可以重新调查现状，但不会把“查清现状”重新定义成另一套结果模型；现状事实仍来自 Investigation Evidence / Current-State Intelligence。

## Workflow selection

新建 Investigation 的工作方式可以选择：

- 自主调查
- 改造已有系统
- 分析当前数据架构
- 金融 AI / 数据架构设计
- 评估数据架构

“分析当前数据架构”对应 `current-data-architecture`。

## Consequences

- 用户可以直接选择自己真正需要的工作。
- Current Data Architecture 可以作为独立交付，也可以成为其它工作的基础。
- Assessment 的价值集中在“评价和改进”，不会和现状分析抢职责。
- 需要维护两条轻量 Workflow，但二者共享已有 Evidence、Discovery 和 Current-State Intelligence。

## Rejected alternatives

### 保留 current-state-architecture capability，不提供独立 Workflow

Rejected。用户已经明确需要在新建 Investigation 时直接选择“分析当前数据架构”；只有自动能力而没有明确入口，会让用户仍然不知道应该怎么开始。

### 让 data-architecture-assessment 继续同时承担现状分析和评估

Rejected。两个目标不同，合并会让结果既不够深入，也不够明确。

### 为 Current Data Architecture 再建一套新的数据模型

Rejected。继续使用现有 Current-State Intelligence、Evidence 和 Discovery，不建立第二套事实模型。
