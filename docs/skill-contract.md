# Skill Contract

每个 skills/<name>/SKILL.md 都要回答五个问题。这样 Agent 读到 Skill 后，不只知道“怎么做”，也知道“什么时候可以做、做完得到什么、怎样算可信”。

## 五个固定部分

| 部分 | 要回答的问题 |
|---|---|
| 输入校验 | 什么情况下该用这个 Skill？开始前必须有什么？ |
| 输出 | 会产生什么结果？需要保存在哪里？ |
| 输出与验证 | 怎么证明结果来自真实资料，而不是模型猜的？ |
| Gate | 什么条件满足以后，这个结果才可以被后续工作采用？ |
| 期望结果示例 | 一个正常结果应该长什么样？需要避开什么错误结果？ |

这五个章节是 Skill 的最小契约，不要求所有 Skill 使用相同的数据格式。

## Workflow 与 Capability 的区别

Workflow 有自己的工作路线，因此 Gate 必须能落到服务端确定性条件、阶段成果或专用脚本。Agent 说“完成了”本身不能推进 Workflow。

Capability 不拥有 Investigation 的阶段生命周期，所以不需要自己的 Workflow transition。它的 Gate 要说明这个能力产生的结果在什么条件下可以信任；例如研究资料要有来源，代码分析要能回到实际源码，数据分析要能回到真实的计算结果。

最终 Investigation 不论使用哪种 Skill，都统一经过：

Mission → Scope → 调查成果 → 中间分析记录 → 最终报告 → 独立 Reviewer

这里每一层只负责自己的事情：Mission 判断任务是否明确，Scope 判断调查范围是否明确，调查成果必须有真实依据，中间分析记录保证过程可以继续和复核，最终报告负责把结果讲给人听，Reviewer 负责检查报告是否真的回答了用户目标。

## 当前 Skill 的实际验证方式

| Skill | 主要 Gate / 验证 |
|---|---|
| current-data-architecture | Workflow completion condition + 通用 Report Gate + 独立 Reviewer |
| data-architecture-assessment | Workflow completion condition + assessment 结构化结果 + 通用 Report Gate + 最终报告 Reviewer |
| legacy-modernization | Workflow completion condition + modernization Gate + 通用 Report Gate + Reviewer |
| financial-ai-native-architecture | Workflow completion condition + 各阶段真实成果检查 + 通用 Report Gate + Reviewer |
| investigation-session | Mission / Scope / Stage / Mission Completion / Report Gate |
| domain-modeling | 业务定义依据 + 用户确认或明确记录冲突 |
| financial-data-review | 实际数据检查结果、资料依据和时间语义可追溯 |
| grilling | 事实依据充分 + 用户明确做出决定 |
| local-data-analysis | 数据集已登记 + 查询只读 + 计算结果和数据版本可追溯 |
| research | 关键结论有来源、版本敏感信息有时间/版本 |
| search-confluence | 页面真实读取 + 页面定位和更新时间可追溯 |
| search-github | repository / commit / 文件内容可追溯 |
| search-leanix | 对象真实找到 + 属性和关系来自返回资料 |
| structural-analysis | 图生成成功 + 关键关系能回到源码/SQL/配置 |
| working-directory | 路径安全 + 文件可读 + 来源可追溯 |

## 静态检查

npm run flow:lint 会检查所有 Skill 是否具备五个固定章节，并继续检查 Workflow 的 Markdown DSL。

tests/skill.test.ts 会把这个要求作为回归测试。它只证明“Skill Contract 没有漏写”，不会把章节存在误当成业务结果已经正确；后者仍由具体 Schema、脚本、确定性 Gate 和 Reviewer 负责。

## 调查输出

每个有效调查 turn 都留下 artifacts/analysis/ 中的一份分析记录。一个 Investigation 可以同时产生多个专业 Artifact，例如研究资料、代码结构分析、数据分析结果、术语整理和结构化工作成果。

Investigation 完成后至少有一份 reports/report.md。这份报告只负责把结果讲清楚，不把内部状态或工具执行过程原样倒给用户。