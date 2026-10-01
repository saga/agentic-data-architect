---
name: financial-ai-native-architecture
description: 从零设计金融服务 AI-native 数据与 Agent 架构，适用于 Portfolio Research、Investment Analytics 和类似新建平台。
---

# Financial AI-Native Architecture

这个 Skill 用于从零设计一个新的金融服务数据与 AI Agent 方案。

它不是 Legacy Modernization Workflow，也不是固定审批流程。用户给出目标后，Agent 根据已有资料和未知项决定下一步调查或设计动作。

## 什么时候使用

适用于：

- 从零建设 Portfolio Research / Investment Analytics 平台。
- 使用 LangChain / DeepAgents 设计金融领域 Agent。
- 使用 LangSmith 做 tracing、evaluation 和运行观察。
- 使用 Snowflake，并把 Semantic View 作为业务数据的语义入口。
- 设计 Data Analyst / Data Architect 如何把业务需求落到数据、语义、Agent 和治理。

已有 legacy 系统迁移、replatform、验证和切换时，使用 legacy-modernization。

## 核心原则

1. **先定义业务问题，再选技术。**
   先确认用户、目标、输出、数据时效、历史回溯、成功标准和人工确认点。不要因为用户提到某个框架就先画技术架构。

2. **一个通用 Agent 优先。**
   不因为 Data Analyst、Data Architect、Research 等职责不同就马上拆多个 Agent。优先使用一个通用 Agent + Skills + Tools。

3. **新建设任务默认不使用固定 Workflow。**
   Agent 可以自己决定先查资料、查数据、澄清问题还是画方案。只有以后发现某个流程真的稳定、重复、必须按顺序执行，才把它升级成 Markdown Workflow。

4. **确定性工作交给代码。**
   SQL 校验、只读限制、权限判断、数据质量、reconciliation、结果 schema 和 Evidence 引用不要靠模型“记住”。

5. **未知项要明确记录。**
   不要把推断写成事实。无法确认的业务定义、source of truth、数据时点和计算规则，都应该进入 Unknown / Open Question。

## 推荐的设计工作

下面是检查清单，不是强制 Workflow。根据任务跳过不需要的部分。

### 1. 业务范围

先回答：

- 谁使用：PM、Research Analyst、Risk、Data Engineer 等。
- 解决什么问题：Research、Exposure、Performance、Attribution、Risk 等。
- 输出是什么：答案、分析数据集、Data Product、Dashboard、Agent tool 或完整平台。
- 查询属于实时、日终、历史回放还是 point-in-time research。
- 哪些结果必须可追溯、可复算、可人工确认。

### 2. 金融领域模型

Portfolio Research 常见对象：

~~~text
Portfolio
Account
Security / Instrument
Issuer
Position
Transaction
Order / Trade
Price
FX
Corporate Action
Benchmark / Index
Fundamental
Estimate
Research
Performance
Risk / Exposure
~~~

不要默认全部都存在。根据真实业务范围选择需要的对象。

重点检查：

- Security identifier：ISIN、CUSIP、SEDOL、FIGI、Ticker、内部 ID。
- Position 到底是交易后持仓、结算持仓、估算持仓还是历史快照。
- Price 的来源、valuation date 和调整方式。
- Corporate Action 对历史价格和持仓的影响。
- Benchmark 是否有历史成分版本。
- Fundamental / Research 是否要求 point-in-time。

### 3. Snowflake 数据架构

优先形成：

~~~text
Sources
  ↓
Raw / Historical Data
  ↓
Domain Data
  ├─ Security
  ├─ Portfolio
  ├─ Position
  ├─ Transaction
  ├─ Market Data
  └─ Research / Fundamental
  ↓
Analytics / Data Products
  ↓
Semantic View
  ↓
Agent / Analyst / BI
~~~

不要把 Bronze / Silver / Gold 当作业务架构本身；它只是可能的物理组织方式。

### 4. Snowflake Semantic View

Semantic View 是业务语义入口，不等于完整 ontology。

至少说明：

- 实体
- 指标
- 维度
- 指标计算方式
- 时间语义
- 底层真实表和字段
- 已确认定义
- 尚未确认的候选定义

例如：

~~~text
Metric: Market Value
Formula: sum(position.quantity * price.close)

Dimensions:
  Portfolio
  Security
  As Of Date
  Currency

Business rule:
  Price 必须使用指定 valuation date 的价格。

Point-in-time:
  Research 查询不能看到查询时点之后才公开的数据。
~~~

不要让 Agent 自己创造 Semantic View 中不存在的业务定义。

### 5. LangChain / DeepAgents

如果用户指定 LangChain + DeepAgents，重点定义职责，不重新造 orchestration framework。

典型结构：

~~~text
DeepAgent
  ├─ planning / reasoning
  ├─ workspace
  ├─ domain Skills
  ├─ Snowflake tools
  ├─ research/search tools
  └─ deterministic validation tools
~~~

模型适合：

- 理解业务问题
- 选择调查路径
- 解释证据
- 形成架构方案
- 根据反馈修改方案

代码适合：

- SQL schema / request validation
- read-only SQL guard
- permission checks
- data quality
- reconciliation
- calculation
- evidence references
- structured output validation

### 6. LangSmith

主要用途：

- Agent / Tool tracing
- Evaluation datasets
- prompt / skill / model / tool 对比
- 失败案例和回归测试
- 运行过程观察

不要把 LangSmith trace 本身当成监管审计证据。需要业务审计时，另外保存：

~~~text
谁发起
什么问题
用了什么数据
调用了什么工具
产生了什么结果
谁确认
最终采用了什么决定
~~~

### 7. Portfolio Research 质量检查

至少检查：

- Portfolio 是否正确。
- As-of Date 是否正确。
- 是否误用了未来才公开的数据。
- Security identifier 是否正确。
- Price / FX / Corporate Action 是否正确。
- Benchmark 版本是否正确。
- 指标定义是否来自可信来源。
- 结论是否可以回到数据和证据。

最终研究结果至少应该能够说明：

~~~text
Conclusion
Evidence
Data As-of
Business Definition
Calculation
Unknowns
~~~

## 一次完整的新建方案应该交付什么

优先形成：

1. Business scope
2. Assumptions / constraints
3. Target data architecture
4. Financial domain model
5. Snowflake data model
6. Semantic View design
7. DeepAgents architecture
8. Skill / Tool boundaries
9. LangSmith tracing and evaluation
10. Security / governance controls
11. Key decisions and trade-offs
12. Open questions
13. Incremental implementation plan

## Portfolio Research 示例

用户：

> 从零建设一个 Portfolio Research AI Agent，底层用 Snowflake，Agent 用 LangChain DeepAgents，要回答 PM 的 portfolio exposure、performance attribution 和 security research 问题。

Agent 不要直接开始画组件图。先澄清：

~~~text
1. PM 真正要回答哪些问题？
2. Exposure / Attribution 的业务定义是什么？
3. Position / Price / FX / Benchmark 从哪里来？
4. 哪些数据需要 point-in-time？
5. 哪些定义适合放入 Semantic View？
6. 哪些问题由 SQL / analytics 解决？
7. 哪些问题需要 Research Search？
8. 哪些结果必须 deterministic validation？
9. 哪些操作允许 Agent 自动完成？
10. 哪些结果必须人工确认？
~~~

然后再逐步形成：

~~~text
Financial Data Sources
        ↓
Snowflake Domain Data
        ↓
Semantic Views
        ↓
DeepAgent
   ├─ Snowflake / SQL
   ├─ Research Search
   ├─ Portfolio Analytics
   └─ Evidence / Validation
        ↓
PM Research Answer
~~~

## 不要做

- 不要为了这个场景创建多个 Data Architect / Analyst Agent。
- 不要把每一个分析动作都变成 Workflow 节点。
- 不要把 Semantic View 当成完整业务 ontology。
- 不要让 Agent 自己决定权限。
- 不要把 LangSmith 当成审计系统。
- 不要把模型推断的业务定义当成事实。
- 不要为了未来扩展提前增加 Workflow Registry、Agent Registry 或通用 orchestration engine。

## 参考资料

涉及具体框架能力时优先使用官方资料：

- LangChain / DeepAgents
- LangSmith
- Snowflake Cortex / Semantic Views
- Anthropic Agent Skills / agent architecture
- OpenAI Agents / Responses

框架能力会变化，涉及具体版本时重新查官方文档。
