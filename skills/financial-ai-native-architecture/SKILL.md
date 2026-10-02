---
name: financial-ai-native-architecture
description: 从零设计金融服务 AI 与数据架构的工作路线，适用于 Portfolio Research、Investment Analytics 和类似的新建平台。
metadata:
  kind: workflow
---

# Financial AI-Native Architecture

这个 Skill 用于从零设计一个新的金融服务数据与 AI Agent 方案。

它有一条固定的 Data Architect 工作路线，但只固定大阶段；每一关里面怎么查、查哪些资料、是否回到前一关，由 Agent 根据证据决定。

## 什么时候使用

适用于：

- 从零建设 Portfolio Research / Investment Analytics 平台。
- 使用 LangChain / DeepAgents 设计金融领域 Agent。
- 使用 LangSmith 做 tracing、evaluation 和运行观察。
- 使用 Snowflake，并把 Semantic View 作为业务数据的语义入口。
- 设计 Data Analyst / Data Architect 如何把业务需求落到数据、语义、Agent 和治理。

已有 legacy 系统迁移、replatform、验证和切换时，使用 legacy-modernization。


这个 Skill 包含一条固定的 Data Architect 工作路线。路线只固定“大阶段”；每一关里面怎么查、查哪些资料、是否回到前一关，由 Agent 根据证据决定。

## Workflow

## @flow financial-ai-native-architecture

start -> intake

## @task intake

title: 明确业务目标
objective: 明确用户、业务目标、范围和最终交付物。
completeWhen: goal
tools: read,url

先回答：

- 谁使用。
- 解决什么问题。
- 范围是什么。
- 最终需要交付答案、数据集、Data Product、Dashboard、Agent tool 还是完整平台。
- 成功标准是什么。

- success -> requirements
- needs-input -> intake

## @task requirements

title: 明确业务需求
objective: 把用户真正要解决的问题和关键使用场景说清楚。
tools: read,url

重点确认：

- Portfolio Research、Exposure、Performance、Attribution、Risk、Security Research 中具体是哪类工作。
- 实时、日终、历史回放还是 point-in-time research。
- 哪些判断必须有证据。
- 哪些结果必须人工确认。

发现业务范围不清时回到 intake。

- success -> data
- needs-input -> intake

## @task data

title: 查数据
objective: 找到需要的数据、来源、质量、时效和历史版本。
tools: read,url

优先检查：

- Portfolio / Position / Security / Price / FX / Transaction / Benchmark / Research 等真实来源。
- identifier mapping。
- 数据质量、freshness、coverage。
- valuation date 和 point-in-time。
- 哪些数据可以作为可信来源。

不要因为找到一个表就假设它是 source of truth。

- success -> domain-model
- needs-input -> requirements
- retry -> data

## @task domain-model

title: 定义金融业务模型
objective: 把业务对象、关系、时间语义和关键业务规则说清楚。
tools: read,url

根据真实业务范围决定是否需要：

Portfolio、Account、Security、Issuer、Position、Transaction、Order / Trade、Price、FX、Corporate Action、Benchmark / Index、Fundamental、Estimate、Research、Performance、Risk / Exposure。

重点检查：

- Security identifier。
- Position 的确切含义。
- Price 与 Corporate Action 的时间关系。
- Benchmark 的历史版本。
- Research / Fundamental 是否要求 point-in-time。

发现业务定义冲突时回到 data 或 requirements，不要猜。

- success -> architecture
- needs-input -> data
- retry -> data

## @task architecture

title: 设计数据架构
objective: 确定数据如何进入 Snowflake、如何组织、如何提供给分析和 Agent。
tools: read,url

至少说明：

- sources。
- raw / historical data。
- domain data。
- analytics / data products。
- data flows。
- quality / lineage / ownership。
- 哪些数据需要权限隔离。

不要把 Bronze / Silver / Gold 当成业务架构本身。

- success -> semantic
- needs-input -> domain-model
- retry -> data

## @task semantic

title: 设计业务语义
objective: 把指标、实体、维度和时间口径变成可供 Agent 使用的 Semantic View 定义。
tools: read,url

至少说明：

- 实体。
- 指标和计算方式。
- 维度。
- 时间语义。
- 底层真实表和字段。
- 已确认定义与候选定义。

Semantic View 是业务语义入口，不等于完整 ontology。

发现指标定义不清时回到 domain-model 或 data。

- success -> agent
- needs-input -> domain-model
- retry -> semantic

## @task agent

title: 设计 Agent
objective: 确定 DeepAgents、Skills、Tools 和人工确认点如何协同完成 Portfolio Research 等工作。
tools: read,url

默认一个通用 Agent + Skills + Tools。

典型能力：

- DeepAgents planning / workspace。
- Snowflake / SQL。
- Research Search。
- Portfolio analytics。
- Evidence / validation。
- Skill 按需加载。

不要因为 Data Analyst、Data Architect、Research 就马上拆多个 Agent。

- success -> controls
- needs-input -> semantic
- retry -> requirements

## @task controls

title: 设计安全和运行控制
objective: 明确数据访问、工具权限、Evidence、审计和高风险操作的控制边界。
tools: read,url

至少说明：

- 谁可以访问什么数据。
- Agent 是否只读。
- 哪些动作必须人工确认。
- 哪些判断必须有 Evidence。
- LangSmith tracing 如何用于运行观察。
- 什么内容另外保存为业务审计记录。

不要把 LangSmith trace 本身当成监管审计证据。

- success -> evaluation
- needs-input -> agent
- retry -> data

## @task evaluation

title: 设计验证和评估
objective: 证明 Agent 的答案、数据、业务口径和工具使用是可靠的。
tools: read,url

至少覆盖：

- 代表性的 Portfolio Research 问题。
- Semantic View 定义正确性。
- SQL / 数据结果正确性。
- point-in-time 正确性。
- Evidence 覆盖。
- Tool selection。
- Regression evaluation。
- LangSmith tracing / evaluation。

发现验证标准不足时回到 semantic 或 agent。

- success -> roadmap
- needs-input -> controls
- retry -> agent

## @task roadmap

title: 形成实施路线
objective: 把方案拆成可以逐步建设的阶段，并明确风险、依赖和待确认事项。
tools: read,url

输出：

- 第一阶段先建设什么。
- 哪些数据和语义必须先准备。
- 哪些 Agent 能力随后加入。
- 哪些问题现在还不能确定。
- 每阶段如何验证。

- success -> done
- needs-input -> architecture

## @end done

title: 方案完成
visible: false
objective: 已形成可以继续审核和实施的 Data Architecture 方案。

## 核心原则

1. **先定义业务问题，再选技术。**
   先确认用户、目标、输出、数据时效、历史回溯、成功标准和人工确认点。不要因为用户提到某个框架就先画技术架构。

2. **一个通用 Agent 优先。**
   不因为 Data Analyst、Data Architect、Research 等职责不同就马上拆多个 Agent。优先使用一个通用 Agent + Skills + Tools。

3. **Workflow 固定大阶段，不固定每一步具体怎么做。**
   Agent 可以在每一关内自由调查、调用工具、反复验证，并按照 route 回到前面的关卡。

4. **确定性工作交给代码。**
   SQL 校验、只读限制、权限判断、数据质量、reconciliation、结果 schema 和 Evidence 引用不要靠模型“记住”。

5. **未知项要明确记录。**
   不要把推断写成事实。无法确认的业务定义、source of truth、数据时点和计算规则，都应该进入 Unknown / Open Question。

## 推荐的设计工作

下面的内容是各关的工作方法。Workflow 固定阶段，Agent 在每一关内决定具体调查顺序。

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
