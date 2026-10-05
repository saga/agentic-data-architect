1）不要向后兼容，无用代码直接删掉。

2）docs里面的文档，如果没有明显要求删除，不能删。

3）文档说人话

**凡是会被人读到的地方 —— UI 提示、API 错误消息、日志 —— 都用浅显直白的中文。实现里的内部术语（放行、宿主工具、基线、增量、幂等、越界、调度、装配）不进文案。**

写法：先说发生了什么，再说该怎么办。技术线索（环境变量名、字段名、取值）放在
括号里补充，不代替句子本身。

```ts
// 错：术语堆砌，用户不知道自己该干什么
'当前部署未启用宿主工具（HOST_CODING_TOOLS），部署放行后才可用'

// 对：说了发生了什么 + 怎么办，环境变量名只是线索
'这个工具会直接操作运行本服务的机器，管理员还没有打开总开关：' +
  '在服务端设置 HOST_CODING_TOOLS=true 后才能使用'
```

判断标准：把这句话念给不了解实现的人听，他能否明白发生了什么、自己下一步该做什么。面向开发者的日志可以用技术词，但也要说清事实，不写「X != true」这类要翻译的伪代码。



### 4）说人话、去掉 AI 味

这个项目是给 Data Analyst / Data Architect 用的，不是给模型展示术语的。

### 本项目的运行模型：个人本机 Agent

这是一个**单人、本机运行、面向个人生产力的 AI Agent**，不是多人共享的 Agent Server。架构和 UI 都应围绕“用户提出目标，Agent 自己判断、检索、调用技能和工具并持续完成任务”设计。

- 默认使用 Copilot SDK 的 `mode: "copilot-cli"`，保留 Copilot CLI 自带的工具、技能和内置 MCP。不要把单用户本机应用做成“每次 Investigation 手工装配一遍 Agent”。
- capability Skill 放在 `skills/*/SKILL.md`，由 Copilot 根据问题和 Skill 的 `description` 自动判断是否需要使用；**不要让用户为每次 Investigation 逐项勾选 capability Skill**。
- Workflow Skill 是唯一例外：它代表用户明确选择的工作方式，而不是普通能力。用户选择某个 Workflow 后，当前 Workflow 可以预加载；其它 capability 仍由 Agent 自动发现。
- “本次调查说明”只是用户给本次 Investigation 的额外说明，会追加到平台系统指令后面；它不是整个 System Prompt，也不能修改平台安全、Evidence 或运行规则。默认可以是空的，但 UI 必须给出可直接照抄的示例。
- Copilot CLI 自带的 MCP 不进入 Investigation 的 `control.json`。配置页只保存用户主动添加的额外 MCP；页面应该明确告诉用户“自带服务已经可以直接使用”。
- 如果未来把这个项目改成多人共享服务，必须重新设计运行时隔离和权限边界，并改用 `mode: "empty"` 等显式 allowlist 方案；不能直接沿用本地单用户模式。
### 本地数据层

SQLite、DuckDB、Parquet 的职责必须保持分开：

- SQLite 是应用状态的 system of record，保存对话、Investigation、Dataset Registry 和分析运行记录。
- DuckDB 是本地分析引擎，每个 Investigation 有自己的 local.duckdb。
- Parquet 是大型数据和分析中间结果的首选格式。
- 原始文件和用户可直接查看的产物继续保存在 workspace 文件系统中。
- Agent 不直接打开 local.duckdb；使用 local_catalog / local_register_dataset / local_describe / local_sample / local_profile / local_query。
- local_query 必须经过只读检查，不能借此访问 workspace 外部文件、网络或其它数据库。
- 本地分析 Evidence 必须记录 dataset version、SHA-256、SQL 和 analysis run。
- 不要为了统一而增加复杂数据库抽象；LocalAnalyticsEngine 已经足够作为本地分析边界。**凡是用户能看到的内容，都优先用最简单、最直接的中文。**

- UI、按钮、标题、提示、错误信息、报告摘要、Agent 回答：先说人能直接理解的话。
- 不要为了“显得专业”堆砌术语。像“现代化工作”“当前状态”“业务语义”“源到目标映射”“工作产物”“差距分析”这类词，除非确实有必要，否则换成日常说法。
- 一个页面只回答用户最关心的问题：**现在怎么样？哪里有问题？我下一步该做什么？**
- 不要把内部数据结构直接搬到 UI。字段名、类型名、workflow 名称不是用户文案。
- 不要一次列一大堆信息。默认只显示最重要的 3～5 件事，剩下内容放到用户主动打开的详情里。
- 技术名词必须保留时，第一次出现要用一句人话解释；后面再使用技术名词。
- Agent 回答默认用简洁、直白、自然的中文。少用“需要指出的是”“综上所述”“基于当前上下文”等 AI 套话。
- 不写没有实际作用的套话，不为了结构而结构，不把一句简单的话拆成很多小标题。
- 面向开发者的代码注释也要说人话：直接说明“这段代码做什么、为什么这样做、出错时会怎样”，不要写论文式定义。

判断标准：把这段话念给一个刚接手这个项目的 Data Analyst 听，他应该马上明白“发生了什么”和“我现在要做什么”。


### 5）KISS 也适用于 UI

KISS 不只是架构原则，UI 一样要遵守。**界面只保留用户现在需要的内容，不为了“完整”把所有信息都铺出来。**

- 一个页面只设一个主要动作，次要动作不要抢主视觉。
- 能用一句话说清楚，就不要放标题 + 副标题 + 提示 + 说明四层文字。
- 能用一个输入框解决，就不要再堆卡片、向导、说明面板。
- 默认只显示用户下一步真正需要的信息；详情、统计、配置放到用户主动打开的地方。
- 同一层级的文字使用统一字号、字重和间距，不能出现大数字、小标题、说明文字各自一套视觉规则。
- 不使用“看起来很丰富”但没有实际操作价值的装饰、徽章、渐变、空白提示或重复说明。
- UI 文案和布局都要回答一个问题：**用户现在看到了什么，下一步点哪里或输入什么？**
- 新增 UI 前先问：删掉它会不会影响用户完成任务？如果不会，就不要加。

判断标准：第一次打开页面的人，不看文档也应该马上知道“这里做什么”和“我现在怎么开始”。
- **右栏不是信息仓库，而是当前工作的辅助栏。** 常驻内容只回答四件事：这次要查什么、现在怎么样、卡在哪里、下一步做什么。完整指标、资料清单、技能/MCP、配置版本、审计记录等只在用户主动打开时显示。

- **状态文案也必须说完整的人话。** 不使用“就绪”“处理中”“思考中”“已完成”“失败”等孤立状态词。状态至少要说明是谁在做什么，必要时再告诉用户接下来该等什么或做什么。例如，“可以继续提问”“助手正在查找资料，请稍候”“这一步需要你的确认，请继续操作”。
- **Data Architect 的固定工作路线由 Markdown Workflow 定义。** Data Analyst / Data Architect 的高层工作阶段、人工确认和典型回退不要散落在 prompt 或 React 代码里；分别放在 `skills/legacy-modernization/SKILL.md`、`skills/financial-ai-native-architecture/SKILL.md`、`skills/data-architecture-assessment/SKILL.md` 中。TypeScript runtime 只负责解析、结构校验、执行位置和确定性推进。
- **Workflow DSL 刻意保持很小。** 当前只允许 `@flow`、`@task`、`@review`、`@end` 四种 block。节点只描述 `title`、`objective`、`actor`、`completeWhen`；连线只描述 `outcome -> target`。不再增加 `@gate`、`@stop`、`completion`、`visible`、`tools`、`requires/produces` 或 route condition。
- **Skill 统一用 SKILL.md 打包，但必须声明执行类型。** frontmatter 使用 metadata.kind: capability 或 metadata.kind: workflow。capability 只提供可被 Agent 自由组合的能力，不定义 @flow；workflow 才能定义固定的高层工作路线。Workflow 不替 Agent 决定每一个调查动作。
- **Goal / Scope / Systems 是正式结果的必填范围。** 先从用户问题、代码仓库、文档、SQL、Discovery 和 Evidence 提取；材料明确就记录，存在歧义再让用户确认。没有 `ScopeValidation` 就不能生成阶段成果或最终报告，报告不得用 `(unset)` 代替必填范围。
- **Workflow 和 Skill 分工不能混。** Workflow 说明“现在做什么、什么时候能过、失败回哪里”；Skill 说明“这一关具体怎么查”。SQL、profiling、lineage、GitHub、Confluence、Web Search 都是执行能力，不是 Workflow 节点本身。通用 Data Architect 经验放在 `knowledge/`，只作为方法参考，不能代替当前 Investigation 的 Evidence。
- **路线图必须允许返工。** 发现新的 lineage、业务定义或数据质量问题时，Agent 应回到相应调查关卡，而不是继续往后假装完成。生成 draft 方案、draft mapping 不等于关卡完成。
- **回答之后必须主动把用户带到下一步。** Agent 回答不能停在“目前不知道 / 需要先检索 / 请提供更多信息”。先把已经知道的和不知道的说清楚，再明确下一步；如果下一步需要用户补充信息，就只问一个最关键的问题，并提供一个直接可输入的入口。优先让 Agent 自己完成能完成的检索，只有确实缺少代码库、数据目录、文件、业务定义等外部输入或权限时才让用户补充。
- **需要用户输入时，问题要能直接操作。** 不要写“请补充更多信息”这类空泛问题。要明确用户可以输入什么，例如仓库地址、目录路径、文件名、业务定义或需要核对的名称。前端可以用 Ant Design X 风格的交互卡片放在回答后面承接这个输入，但不要为了引导再复制一遍完整回答。
- **同一信息只保留一个主要展示位置。** 用户问题在聊天里出现后，顶部标题、右栏摘要、弹窗不再重复复制；右栏负责当前状态和动作，弹窗只放主动查看的详细内容。不要用“摘要 / 卡片 / 标签 / 弹窗”把同一句话重复展示。

## ADR 必须遵循

架构设计和实现必须遵循根目录 `ADR/` 中的 Architecture Decision Records。

- 开始新的架构性改动前，先阅读 `ADR/index.md` 和与改动相关的 ADR。
- 不得通过代码、Skill、Workflow、UI、配置或普通文档绕过或悄悄改变已有 ADR 的架构边界。
- 如果实现需要改变现有架构决定，必须在同一次变更中新增或更新 ADR，并说明 Context、Decision、Consequences；不能只改代码。
- 新的重要架构决定必须形成单独 ADR 文件，并在 `ADR/index.md` 登记。
- 不再适用的 ADR 不删除，标记为 `Superseded` 并链接到替代它的新 ADR。
- 普通实现细节不需要 ADR；只有会持续影响模块边界、数据模型、运行模型、技术选型或安全/可验证性边界的决定才需要记录。
- ADR 与代码不一致时，先判断这是实现偏离还是 ADR 已过时；不要默认以代码为准。

