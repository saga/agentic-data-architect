---
name: legacy-modernization
description: 数据现代化工作路线：用有状态的 Markdown Workflow，把 Data Analyst 和 Data Architect 在 legacy modernization、replatform 和迁移中的工作组织成“当前关卡 → Evidence → Gate → 下一关”。
  Data Modernization Journey：用一条有状态的 Markdown Workflow，把 Data Analyst 和 Data Architect
  在 legacy modernization / replatform 中反复出现的工作组织成“当前关卡 → 证据 → Gate → 下一关”。
metadata:
  kind: workflow
---

# Legacy Modernization Journey

这份 Skill 同时是人可以读的工作说明，也是路线图的 Markdown Workflow 定义。

原则：

- 先减少未知，再做架构决定。
- Agent 能自己查就自己查；只有真的缺少资料、权限或业务定义时才问用户。
- 每一关都要有明确工作结果和通关条件；通关条件只判断是否已有足够事实，不用任意百分比或“生成了一个对象”冒充完成。
- Workflow 决定先做什么、什么时候能进入下一关；Skill/Tool 决定这一关具体怎么查。数值指标只提供调查线索，不单独决定关键业务 Gate。
- Web Search 是调查动作，不是独立阶段。没有本地证据时可以主动去 GitHub、Confluence、Web 或问业务人员。
- Agent 的“我已经完成了”不是通关依据。关键阶段必须先产生持久化工作成果，再通过服务端的确定性 Script Gate。
- 目标架构、新旧对应、验证结果都会保存到 `reports/modernization-plan.json`，结果页直接展示这些内容。
- Gate 检查已经落盘的成果、真实 Evidence、Mapping 完整性和 Validation 实际结果；单独返回 `workflow.success` 永远不能完成这些阶段。
- 出现新证据后可以回到前面的关卡重新调查。
- “查关键问题”不是固定阶段。调查中的 unknown 只是当前不知道的内容，不自动变成必须解决的问题；是否继续深挖由用户目标、当前成果覆盖面和确定性 Gate 决定。

## 路线图

接到任务
   ↓
看清旧系统
   ↓
找到数据真相
   ↓
梳理当前架构
   ↓
定下现状
   ↓
设计新方案
   ↓
新旧对应
   ↓
验证结果
   ↓
切换

## @flow legacy-modernization

start -> intake

## @task intake

title: 接到任务
objective: 明确这次为什么改、改什么、范围在哪里，以及当前已经有哪些资料。
completeWhen: scope-ready

先判断：

- 业务目标
- 范围
- 已知系统入口
- 当前资料
- 当前未知数

Goal / Scope / Systems 是正式结果的必填内容。先从已有材料挖掘候选；材料足够时直接记录，存在歧义时让用户确认。没有确认完整前，不得生成正式报告或进入下一阶段。

如果输入不足，不要停在“信息不足”。主动问一个最关键的问题，并把问题放进回答后的输入入口。

- success -> estate-map

## @task estate-map

title: 看清旧系统
objective: 建立系统地图：数据集、来源、SQL/ETL、主要数据流和下游使用方。
completeWhen: current-state

优先做：

1. 扫描代码库和数据目录。
2. 识别表、视图、文件、SQL、ETL、调度和主要消费者。
3. 解析 SQL，建立 dataset / column lineage。
4. 找出高价值资产、孤儿对象、解析失败和明显未使用对象。
5. 不要因为看到了少量表就开始设计新架构。

- success -> data-truth

## @task data-truth

title: 找到数据真相
objective: 确认数据从哪里来、代表什么、哪个来源最可信，以及数据质量有哪些实际问题。
completeWhen: data-truth

重点检查：

- source-of-truth
- data profiling
- null / duplicate / range / format
- referential integrity
- semantic candidates
- business definitions
- 同名不同义、同义不同名

发现业务定义缺失时，主动问一个具体问题，例如“这个字段的 A / R / P 各代表什么？”而不是“请提供更多信息”。

- success -> current-state

## @task current-state

title: 梳理当前架构
objective: 围绕用户真正要交付的内容，形成当前系统的 Data Source、Data Flow、Data Model，并补充关键 transformation、business meaning 和明显缺口。不要为了清空 unknowns 而无限深挖。
completeWhen: current-state-ready

优先使用“现状架构分析”能力，从已经发现的代码、SQL、数据目录、Lineage 和 Evidence 中整理：

- Data Source：关键数据从哪里来，哪些来源是可信候选
- Data Flow：数据经过哪些系统、表、服务、SQL / ETL 到哪里
- Data Model：核心实体、表 / 视图、关键关系和业务含义
- Transformation：关键计算和转换发生在哪里
- Gap：哪些信息仍不清楚，以及它们是否真的影响用户当前目标

不要求把所有 unknown 都解决。只有缺口会影响当前目标或下一阶段关键决策时，才继续深挖。Web Search 只在本地代码、目录和内部资料无法解释问题时使用。

- success -> target


这些阶段不设置 completeWhen：目标架构、映射和验证都必须走“工作成果 → Script Gate → Workflow transition”。
Agent 返回 success 只是完成申请；服务端先把结果落盘，再执行确定性 Gate。Gate 不通过就留在当前阶段，Agent 需要继续补齐结果。
本地可以直接检查：`npm run gate:modernization -- <session> <target|mapping|validation|all>`。


## @task target

title: 设计新方案
objective: 在旧系统已经说清楚以后，确定新的数据怎么接、怎么整理、业务定义放哪里、怎么管。

设计内容：

- target data domains
- ingestion
- transformation
- semantic layer
- serving
- lineage / quality / governance
- architecture decisions
- open questions
- 不要锁死在单一厂商

目标方案只是草案时，不要把它当成已经完成。

- success -> mapping

## @task mapping

title: 新旧对应
objective: 把旧数据对应到新数据，并把 transformation、business rule、validation rule 写清楚。

每条 mapping 至少说明：

- source
- target
- transformation
- business rule
- validation
- evidence
- 当前状态

遇到不能自动确定的映射，回到 investigate，而不是猜。

- success -> validation

## @task validation

title: 验证结果
objective: 证明目标系统和旧系统在关键业务结果上可以对得上，并提前定义切换条件。

至少覆盖：

- schema / coverage
- row count
- control totals
- aggregate comparison
- record-level reconciliation
- data quality
- business metric
- performance / SLA
- cutover / rollback readiness

发现差异后回到 investigate，先找原因再继续。

- success -> cutover

## @review cutover

title: 切换确认
objective: 验证已经完成后，由负责人确认切换条件、回退方案和运行准备，再进入实际切换；工作台不会把“生成了一份计划”当成已经切换完成。

- approved -> done
- rollback -> investigate

## @end done

title: 完成
objective: Modernization Journey 正常结束。
