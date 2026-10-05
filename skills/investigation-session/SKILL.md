---
name: investigation-session
description: 持续的人机协作数据调查：先确认任务目的和期望结果，再围绕 Mission 组织多轮调查、Evidence 和工作产出；未知项只是状态，不自动变成下一步任务。
metadata:
  kind: capability
---

# Investigation Session

持续的人机协作 Data Investigation，不是一次性问答。

## 启动
在真正开始调查前，必须先确认 Mission：
1. 为什么要做这次调查
2. 最后希望拿到什么结果
3. 这些结果是否已经具体到可以开始工作

如果第 1、2 项没有明确，先让用户确认；不能用模型自己的猜测代替确认。
如果 Mission 已明确，再补业务上下文、范围、时间点、约束，以及需要参考的文件、文档、Confluence 页面和 GitHub repository。
不要为了“尽快开始”而绕过 Mission Confirmation。

## 每一轮
- **先回到 Mission。** 重新确认“为什么做”和“最后要拿到什么”，再决定这一轮做什么。
- **优先补齐未覆盖的交付物。** 不要从 unknowns 里随便挑一个问题作为下一步。
- **回答不能停在“目前不知道”。** 先说清楚已经知道什么、还缺什么，然后判断这些缺口是否真的影响期望结果。
- **能自己查的先自己查。** 只有确实缺少代码库、数据目录、文件、业务定义或访问权限时，才让用户补充。
- **需要用户补充时只问一个最关键的问题。** 问题必须具体、可直接回答或粘贴；前端会把它放进回答后的输入卡片里，所以不要写“请提供更多信息”这种空话。
- 新消息是新增事实、约束、问题或方向修正，不覆盖历史。
- 区分用户事实、外部证据、模型推断和未知信息。
- 上下文不足时只问一个具体问题；但先确认这个问题本身是在帮助完成 Mission，而不是 Agent 自己产生的新课题。
- 能通过确定性脚本得到的信息，直接运行脚本，不用文字猜测结果。
- 已有 SKILL 能定义的流程，遵循对应 SKILL，不在 prompt 中重新发明流程。
- 业务术语影响模型、映射或架构决定时使用 domain-modeling。
- 需要确认外部事实或第三方能力时使用 research，并把结果作为可复核的临时资料。
- 出现真正的业务/架构取舍时使用 grilling；事实先查清，决定由用户确认。
- 用户可以随时补充资料、提出问题或纠正方向；新的用户输入可以修改 Mission，但修改后必须重新确认，不能悄悄改变任务契约。

## Mission 与决策
- Mission 是本次调查的最高优先级任务契约。
- Workflow 只能决定“怎么走”，不能改变“为什么做、最后要什么”。
- Skill / Tool 只能用于完成 Mission 交付物。
- unknown 只有在影响 Mission 时才值得继续解决。
- Smart Function 可以判断“哪个方向更有价值”，但不能替代用户对 Mission 的确认，也不能替代 Script Gate。

## 决策与术语

调查过程中不要把“查到了什么”和“决定怎么做”混在一起：

- Evidence / Research 是事实材料。
- Domain Modeling 保存确认后的业务语言。
- Grilling 只处理真正需要人决定的分叉。
- Target Architecture、Mapping 和 Validation 继续使用现有 Investigation / Workflow 产物。

## 文件沉淀
- 当前 session 的调查状态放在 `.workspace/<session-name>/context.json`。
- user / assistant / system 多轮对话放在 `.workspace/conversations.db`；不要把聊天正文复制进 context.json。
- 长篇分析结果、脚本输出和生成物放到当前 session 的 `artifacts/`。
- 可复用外部资料放到 `.workspace/shared/`。
- Confluence 页面 Markdown 放到 `.workspace/shared/confluence/`；GitHub / LeanIX / Web / 用户文档按来源放入对应 shared 目录。
- 可复用资料必须登记到 `.workspace/shared/index.json`。
- context.json 只保存状态、关键事实、输入索引和 artifactPath。

## 研究纪律
- GitHub、LeanIX、Confluence 是 evidence source，不自动等于业务真相。
- 私有 Confluence 不用普通 Web Search 猜内容；遵循 `search-confluence` SKILL。
- GitHub 研究遵循 `search-github` SKILL。
- 大量代码扫描使用本地 `rg` / `find` / `git` 或对应脚本；不要用长篇自然语言描述代替脚本结果。
- 不把大段内部源代码复制到研究文档；记录路径、函数、行号或最小必要片段。