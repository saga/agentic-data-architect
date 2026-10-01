# 架构知识

这里放的是可以跨 Investigation 复用的“Data Architect 怎么做”的经验。

## 和 Evidence 的区别

- `knowledge/`：外部资料整理出来的通用经验、方法和检查点。
- `.workspace/<session>/`：这一次调查真正查到的事实、Evidence、Finding 和用户确认。

知识可以指导 Agent 下一步怎么查，但**不能证明当前系统就是这样**。当前项目的结论仍然必须回到 Evidence。

## 可信度怎么看

每条知识有两个层次：

- `knowledgeConfidence`：这条总结本身有多可靠。高表示多个高质量、独立来源收敛到相近结论；中表示只有一个强来源或主要来自实践总结。
- `sourceConfidence`：单个资料来源本身的可信程度。监管机构、官方标准、官方技术文档和雇主自己的岗位说明通常更高；厂商案例、咨询文章和二手整理需要更谨慎。

这里不使用 0–100 的“伪精确分数”。看到“高”仍应检查原始来源。

## 时间

- `publishedAt`：原资料发布时间。
- `reviewedAt`：本项目最近一次重新核查来源的时间。
- `timeSensitivity`：stable / contextual / time-sensitive。
- 监管、产品能力、岗位职责等容易变化的内容，需要重新搜索；不要把旧资料当成当前规则。

## 怎么写

一条知识尽量包含：

- 什么时候用
- 输入是什么
- 应该查什么
- 应该产出什么
- 常见误区
- 原始来源和日期

知识是“方法”，不是把网页复制进仓库。

## 当前第一批知识

`data-architecture.json` 汇总了 Data Architect 实际工作中反复出现的几类工作：从业务目标开始、先做 Current-State、同时看数据模型和语义、选择合适的集成方式、把治理/质量/血缘当作架构的一部分、做 target + transition、评审与 roadmap，以及金融场景对 lineage / data authority / time context 的额外要求。