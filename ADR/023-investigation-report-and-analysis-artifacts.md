# ADR-023：Investigation 必须留下用户可读报告和中间分析产物

- Status: Accepted
- Date: 2026-10-06

## Context

当前 Investigation 已经会保存 Evidence、Discovery、Findings 和少量专用 Artifact，但不同工作方式的最终输出不一致。有的路线可以生成 JSON 工作成果，有的调查只有聊天记录，用户需要自己从执行过程里拼出结论。

长期调查还需要保留中间分析结果。一个任务可能产生多个研究文件、数据分析结果、领域术语、结构分析结果和阶段成果；只保留最终报告会让后续复核和继续工作缺少依据。

## Decision

### 1. 每次 Investigation 完成后必须有一份用户可读报告

最终报告统一使用当前 Investigation 的 `reports/report.md`。

报告最低要求：

- 用简单直白的话先说结论；
- 说明这次调查解决了什么问题；
- 说明已经查清楚什么；
- 说明哪些地方仍然不能确认；
- 说明下一步最值得做什么；
- 不把内部状态字段、Workflow、Gate、Evidence 等实现术语当成正文语言。

不同 Workflow 可以增加自己的结果部分，但不能省掉这份基础报告。

### 2. 调查过程必须保留中间分析产物

Agent 每次完成一个有效调查 turn，都必须留下一个分析记录：

`.workspace/<session>/artifacts/analysis/turn-*.md`

这份文件保存本轮已经形成的分析结论、资料编号、未知事项和下一步，不替代聊天记录。

调查过程中其它 Skill 产生的专业 Artifact 继续保存在 `artifacts/` 或 `.workspace/shared/` 的既有位置；一个 Investigation 可以同时拥有多个 Artifact。

### 3. 最终报告和中间产物分别承担不同职责

- `report.md`：给人读，回答“最后得到什么”。
- `artifacts/analysis/turn-*.md`：给后续调查和复核使用，回答“过程中形成了哪些分析结果”。
- Evidence / Discovery：保存可追溯原始依据。
- 专用 Artifact：保存某个 Skill 的结构化中间结果或工作成果。

不得把聊天 transcript 当成唯一的分析产物。

### 4. 生成与读取分开

报告只在显式生成或 Investigation 完成时生成。

读取报告不重新调用模型，不重新执行研究，不因为刷新页面而改变报告。

### 5. 报告生成仍受 Gate 和独立 Reviewer 约束

报告生成前先通过确定性前置检查；生成后经过独立 Reviewer。Reviewer 失败不会修改原始调查结果，但报告状态必须明确保持为 blocked，而不能假装 current。

## Consequences

- 所有完整 Investigation 都有一个固定的最终阅读入口。
- 长任务的中间分析可以继续被 Agent、用户和后续工作使用。
- 一个 Investigation 可以产生多个专业 Artifact，不需要把所有内容塞进一个 JSON。
- 需要在每个 turn 增加一次轻量文件写入，并在任务结束时生成最终报告。

## Rejected alternatives

### 只保存最终报告

Rejected。无法支撑复杂调查的复核、返工和继续分析。

### 把所有中间结果塞进一个 artifacts.json

Rejected。不同分析结果的生命周期和格式不同，统一成一个大文件会重新制造“万能对象”。

### 每个 Skill 都要求一种完全不同的最终报告

Rejected。最终阅读入口必须统一；Skill 只负责自己的专业中间结果和内容贡献。
