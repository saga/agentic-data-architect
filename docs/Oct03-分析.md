有。按当前 `main` 的前后端、Workflow、Discovery、UI 和相关文档一起看，除了刚删掉的 AI `修改 / 重设计 / 整张图`，还有一批很明显的“设计得很聪明，但对用户价值不大”的东西。

我先不改，只列出来。

## 第一档：我认为应该认真考虑删掉 / 大幅收缩

### 1. `Agent 建议` / Dynamic Route Options

这是目前最明显的一套。

位置：

* `web/src/App.tsx:489` `AgentRecommendationCard`
* `web/src/App.tsx:1242` 主聊天区展示
* `src/workflow/ask.ts:47,276` 每轮生成 `routeOptions`
* `src/agent/result.ts` Agent schema 强制支持 `routeOptions`
* `tests/adaptive-routes.test.ts` 专门维护这套机制

现在实际行为是：

```text
Agent 回答
   ↓
再生成 0～3 条“路线”
   ↓
页面展示成卡片
   ↓
用户点“采用”
   ↓
实际上只是又发送一段自然语言给 Agent
```

也就是说，“采用路线”本身没有真正执行 Workflow，只是：

```ts
send("我选择这条路线……")
```

这就是典型的 UI 套壳。

**我认为它和你刚刚删掉的 AI 模式按钮属于同一种问题：把本来应该由自然语言解决的事情，强行做成第二套交互。**

这个值得列为最高优先级的减法候选。

---

### 2. `FollowUpCard`：回答下面再放一个输入框

位置：

* `web/src/App.tsx:431`
* `web/src/App.tsx:789`

现在一个 Agent 回答后，如果返回 `followUpQuestions`，聊天气泡下面会出现：

```text
下一步

某个问题？

[ 再输入一遍……              ]

[问题2] [问题3]              [继续]
```

但页面底部本来已经有：

```text
[ Sender 输入框                         ]
```

所以实际上同一个页面有两个输入入口。

它只有在一种情况下真正有价值：

> **Agent 确实被某个用户输入卡住了。**

现在 schema 没有把“真正阻塞”与“普通建议”区分开，所以很容易变成“每轮回答后再推你下一步”。

建议后续把它收缩成：

```text
只有 Agent 明确需要用户补充信息时
才出现一个非常小的“请补充：xxx”
```

而不是做成第二个 Composer。

---

### 3. 主聊天右边的“工作方式”

位置：

`web/src/App.tsx:1387` 左右。

现在右栏有：

```text
工作进展
当前情况与下一步

工作方式
[ 改造已有系统 ]

工作方式进入调查后不在首页随手切换……
[ 打开工作方式设置 ]
```

这块几乎完全是：

> 配置页的“工作方式”搬到主页面再解释一遍。

而且用户现在已经明确不希望首页有这种控制。

我认为主工作区右栏应该把它彻底拿掉。

工作方式真正发生变化时去：

```text
调查配置 → 工作方式
```

已经够了。

---

### 4. 顶部的 `配置 vX / 证据 N / 发现问题 N`

位置：

`web/src/App.tsx:1208-1209`

现在顶部同时放：

```text
可以继续提问
配置 v12
证据 38
发现问题 7
Agent 轨迹
调查配置
待查内容 4
```

这些东西里面：

* `证据 38`
* `发现问题 7`
* `配置 v12`

都不是用户当前的主要动作。

而且右栏又有：

```text
数据集
数据来路
业务定义
待查
```

属于两处都在做“状态仪表盘”。

**这很容易变成“数据很多，但不知道现在该干什么”。**

尤其 `配置 v12`，对 Data Architect 主工作流程几乎没有价值，应该留在配置 / 审计页面。

---

### 5. `Modernization Plan` 这一整套 UI 现在很像遗留功能

这个比较特殊，因为不只是“没必要”，而且现在代码里已经出现明显的半废弃状态。

位置：

* `web/src/App.tsx:596`
* `web/src/App.tsx:670-702`
* `web/src/App.tsx:1479` 后面的整个 Modal

包括：

```ts
loadAssessment()
loadModernization()
handleModernizationAction()
modernizationOpen
modernizationLoading
```

但是我检查了当前 `App.tsx` 的调用关系：

```text
loadAssessment 只定义，没有真正 UI 调用
loadModernization 只定义，没有真正 UI 调用
```

也就是说这整个：

```text
架构评估结果
完整改造方案
路线图
改造步骤
新的方案
后面还会做什么
```

实际上已经变成了一块悬空代码。

这不应该继续保留成“未来也许有用”。

---

## 第二档：不是简单没用，而是“会制造假的确定性”

这类我反而觉得比 UI 冗余更值得警惕。

### 6. 自动生成一个“架构决定”

`src/workflow/modernization.ts:308`

这里的 `buildInitialDecisions()` 直接预先生成：

```text
业务定义不要绑死在一个产品上

options:
- 把 Snowflake 当成唯一的业务定义来源
- 使用通用的业务定义接口

decision:
使用通用的业务定义接口.
```

这个问题很大。

因为这不是：

```text
候选方向
```

而是已经填了：

```text
decision
rationale
tradeoffs
```

也就是说系统在没有真正调查、没有用户做决定之前，就自己造了一个“Architecture Decision”。

这就属于非常典型的：

> **看起来很专业，实际上只是把默认观点包装成了决策。**

这个我建议列入最高级别的清理对象。

---

### 7. 自动生成 Source → Target Mapping

`src/workflow/modernization.ts:38` / `buildInitialMappings()`

它会把：

```text
source-of-truth candidate
```

自动变成：

```text
legacy asset
→ target:domain-data:<name>
```

甚至还给：

```text
transformation
businessRule
validationRule
status: proposed
```

问题是实际上很多东西根本还不知道。

例如：

```text
legacy_position
    ↓
target:domain-data:legacy_position
```

这并不是一个真实 Mapping。

它其实只是：

```text
“我暂时给你起了个名字”
```

但 UI 又会显示：

```text
旧数据对应关系：N 条建议
```

容易让用户误以为已经做了一部分真正的 Mapping 工作。

---

### 8. 自动生成整套 Target Architecture 模板

还是 `src/workflow/modernization.ts`

`buildTargetArchitecture()` 固定产生：

```text
source
ingestion
domain_data
transformation
semantic
serving
governance
```

再自动生成：

```text
重要业务含义要说清楚
不要绑死产品
切换前要检查
需要人工审核
```

这其实不是“分析结果”。

它是一个固定模板。

模板本身没有问题，但现在被包装成：

```text
Target Architecture
```

就会让系统显得“已经理解这个项目并设计好了架构”。

实际上只是：

```text
一个通用 Data Architecture skeleton
```

这种能力更适合做一个非常轻的模板，而不是作为 Investigation 的自动产物。

---

## 第三档：Workflow 的“确定性”其实有点装得太满

### 9. `data-truth = lineage >= 80%`

`src/workflow/journey.ts:350`

现在：

```ts
lineageCoverage >= 0.8
```

就可以认为：

```text
data-truth
```

完成。

但：

```text
80%
```

为什么是 80？

为什么不是：

```text
60%
70%
90%
关键业务流 100%
```

这里没有实际业务依据。

更重要的是：

> **Data Architect 并不是“血缘覆盖率达到 80% 就找到数据真相”。**

一个 95% lineage 的系统，如果：

```text
Position 定义错了
Price precedence 不知道
EOD / intraday 不清楚
```

一样不能说“数据真相已经找到”。

所以这套 `deterministic completion` 很容易变成一种伪精确。

---

### 10. `unknowns <= 3` 就认为 investigation 可以过

`src/workflow/journey.ts:364`

```ts
facts.unknowns.length <= 3
```

这个很明显。

系统实际上假定：

```text
3 个 Unknown = 可以继续
4 个 Unknown = 不可以继续
```

现实里完全不成立。

可能：

```text
只有 1 个 Unknown
```

但它恰恰是：

> 哪个系统是 Position source of truth？

那整个架构都不能继续。

反过来：

```text
还有 15 个 Unknown
```

但全部是低影响问题，完全可以进入下一阶段。

应该关注的是：

```text
关键 Unknown 是否已经解决
```

而不是数量。

---

### 11. `current-state` 完成条件过于宽松

`src/workflow/journey.ts:333`

现在：

```ts
case 'current-state':
  return Boolean(facts.currentState);
```

意思基本就是：

```text
只要生成过一个 Current-State snapshot
→ current-state 完成
```

这和：

> “已经把现状定下来”

其实不是一回事。

---

### 12. Assessment 的 Gate 更明显

`src/workflow/journey.ts:339-341`

现在：

```ts
assessment-findings
→ findingCount > 0 || currentState

assessment-recommendation
→ recommendationCount > 0

assessment-roadmap
→ roadmapItemCount > 0
```

尤其：

```ts
findingCount > 0 || currentState
```

等于：

> 有 Current State，就可以算“发现问题”这一关已经具备条件。

这就有点“为了让地图往前走而往前走”。

---

### 13. `cutover` 直接等于 `validation`

`src/workflow/journey.ts:357`

这里甚至是：

```ts
case 'cutover':
  return conditionPassed('validation', facts);
```

也就是：

```text
Validation ready
    =
Cutover ready
```

这实际上非常不合理。

真正的：

```text
validation passed
```

和：

```text
cutover readiness
```

不是同一回事。

至少还会涉及：

```text
business sign-off
rollback
operational readiness
parallel run
ownership
cutover window
```

所以这里是一个比较明显的“自动化设计过头”。

---

## 第四档：Current-State Intelligence 里也有几处“聪明过头”

### 14. Source-of-Truth Score

`src/analysis/current-state.ts:57`

核心：

```ts
score =
  downstream * 3
  - upstream
  + metadataSignals
```

然后按照 score 排。

这相当于：

> 下游用得多，所以更可能是 Source of Truth。

作为探索 heuristic 没问题。

但它其实完全不能说明：

```text
谁是 authoritative source
```

真正 Source of Truth 经常取决于：

```text
business ownership
operational process
timeliness
official valuation
regulatory definition
manual override policy
```

而这里没有这些东西。

所以这个能力最好永远只是：

```text
“可能值得先看”
```

而不是：

```text
“Source-of-Truth candidate 排名”
```

现在虽然叫 candidate，但整个系统已经在围绕 score 产生后续 mapping / gap，这会放大 heuristic 的作用。

---

### 15. `SemanticCandidate` 的字段命名猜业务概念

`src/analysis/current-state.ts`

比如：

```text
xxx_id        → identifier
xxx_date      → temporal_dimension
xxx_amount    → metric
```

再通过：

```text
去掉 raw_
stg_
ods_
dw_
snapshot
history
legacy
```

把：

```text
something_...
```

归并成一个 business concept。

这个作为 discovery helper 没问题。

但它仍然是：

```text
命名规则猜业务含义
```

而 Data Architect 最怕的就是：

```text
字段名字看起来像这样
→ 所以它应该代表这个业务概念
```

所以它最好只存在于内部调查辅助层，不应该进入：

```text
Current State 已确认事实
```

---

### 16. `datasetLineageCoverage` 这个数字其实不是“覆盖率”

`src/analysis/current-state.ts:172`

当前算法基本是：

```text
有 lineage edge 的 endpoint 数
/
dataset 数
```

这个指标更像：

```text
graph connectedness proxy
```

而不是严格意义的：

```text
dataset lineage coverage
```

但 UI 直接显示：

```text
数据来路 84%
```

用户很容易理解成：

> 84% 的数据集已经完成可靠血缘分析。

这并不一定成立。

而更麻烦的是，这个数字又直接参与：

```text
data-truth
validation
gap
workflow progression
```

于是一个并不严谨的指标，开始影响工作流程。

这是比较典型的：

> **一个方便展示的指标，最后被系统当成事实依据。**

---

## 第五档：有些“技术上很完整”，但产品价值低

### 17. 每轮都保存 Graphify Before / After Runtime Metadata

`src/workflow/ask.ts:169,232`

每轮 Agent：

```text
Graphify runtime started
Graphify runtime completed
graph hash
package version
MCP command
platform capabilities
```

这个东西有审计 / 可复现价值，所以我**不会建议现在删**。

但它属于：

```text
后台审计能力
```

而不是用户工作流能力。

以后不要继续把这类东西往 UI 上扩，否则很容易变成：

```text
为了证明系统很严谨
→ 给用户看一堆 runtime metadata
```

正确位置就是后台 audit。

---

### 18. `workflow` Agent 输出字段现在基本是死协议

这是一个很典型的代码层“自作聪明”。

`src/agent/result.ts`：

```ts
workflow: {
  nodeId,
  outcome
}
```

`buildQuestionPrompt()` 还要求模型返回：

```json
"workflow": {
  "nodeId": "...",
  "outcome": "..."
}
```

但是我检查 `src/workflow/ask.ts`：

```text
parsed.workflow
```

实际上没有被真正消费。

也就是说：

```text
Prompt 要
Schema 有
Parser 有
保存没用
执行没用
```

这是纯粹的协议噪音。

后面非常适合删。

---

## 19. “连接到现有步骤” + 拖线，两套交互

工作地图属性里现在同时有：

```text
连接到现有步骤
[选择目标]
[输入 outcome]
[建立连接]
```

同时画布又支持：

```text
拖右边 Handle → 左边 Handle
```

这一项我不会说它“没用”，因为属性面板方式对精确修改确实有价值。

但它是一个可以继续观察的地方：

> 如果实际使用中 90% 都是拖线，那么属性面板里的连接表单可以删。

目前不急。

---

# 我会把现在的问题分成这几个级别

| 项目                                         | 我的判断                    |
| ------------------------------------------ | ----------------------- |
| Agent 动态路线 / `routeOptions`                | **强烈建议删**               |
| FollowUpCard 第二输入框                         | **大幅简化**                |
| 主页面“工作方式”                                  | **建议删**                 |
| 顶部配置版本 / 证据数 / Finding 数                   | **建议收掉**                |
| 悬空 Modernization Modal / functions         | **应清理**                 |
| 自动生成 Architecture Decision                 | **强烈建议删**               |
| 自动生成初始 Mapping                             | **强烈建议收掉**              |
| 自动生成 Target Architecture 模板                | **改成模板/按需生成**           |
| `data-truth >= 80%`                        | **建议重做**                |
| `unknowns <= 3`                            | **建议删掉这个规则**            |
| `currentState exists = current-state done` | **建议重做**                |
| `assessment-findings` 条件                   | **建议重做**                |
| `cutover = validation`                     | **应该修**                 |
| Source-of-Truth score                      | **保留作内部 heuristic，但降级** |
| Semantic candidate 命名推断                    | **保留作辅助发现，不要升级成事实**     |
| lineage coverage 百分比                       | **建议改名/改算法**            |
| Graphify before/after audit                | **后台保留，别继续扩 UI**        |
| Agent `workflow` 输出字段                      | **应删除**                 |
| 双重连接方式                                     | **暂时保留观察**              |

## 最核心的一条

现在代码里有一个很明显的模式：

```text
Agent 已经可以判断
        ↓
系统再加一个结构化对象
        ↓
再加一个卡片
        ↓
再加一个按钮
        ↓
再加一个状态
        ↓
再加一个“自动判断”
```

然后产品就开始越来越“聪明”，但用户实际上只是想：

```text
我问问题
→ 你帮我查
→ 告诉我查到了什么
→ 不确定的地方告诉我
→ 我说下一步怎么做
```

所以后续继续做减法时，我会优先盯着这三类东西：

**“把自然语言已经能解决的事情做成按钮”**、**“把 heuristic 包装成确定事实”**、**“为了让 Workflow 往前走而人为制造完成条件”**。

这三类目前就是这个项目最明显的“聪明过头”来源。
