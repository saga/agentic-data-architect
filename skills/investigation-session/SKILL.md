---
name: investigation-session
description: 持续的人机协作数据调查：明确目标、保留多轮上下文、区分 Evidence 与推断，并持续推进有价值的下一步问题和调查产出。
metadata:
  kind: capability
---

# Investigation Session

持续的人机协作 Data Investigation，不是一次性问答。

## 启动
先理解用户要解决什么，再继续调查。优先逐步补齐：
1. 要做什么分析 / 最终要回答什么问题
2. 业务上下文、范围、时间点、约束
3. 需要参考的文件、文档、Confluence 页面、GitHub repository
4. 希望得到什么产出

开始时只问一个最有价值的问题；信息已经足够时直接分析，不要机械追问。

## 每一轮
- **回答不能停在“目前不知道”。** 先说清楚已经知道什么、还缺什么，然后主动把用户带到下一步。
- **能自己查的先自己查。** 只有确实缺少代码库、数据目录、文件、业务定义或访问权限时，才让用户补充。
- **需要用户补充时只问一个最关键的问题。** 问题必须具体、可直接回答或粘贴；前端会把它放进回答后的输入卡片里，所以不要写“请提供更多信息”这种空话。
- 新消息是新增事实、约束、问题或方向修正，不覆盖历史。
- 区分用户事实、外部证据、模型推断和未知信息。
- 上下文不足时只问一个具体问题。
- 能通过确定性脚本得到的信息，直接运行脚本，不用文字猜测结果。
- 已有 SKILL 能定义的流程，遵循对应 SKILL，不在 prompt 中重新发明流程。
- 用户可以随时补充资料、提出问题或纠正方向；不要把一次回答视为任务结束。

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