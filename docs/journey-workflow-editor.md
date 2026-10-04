# Journey Workflow Editor

> 架构增量：2026-10-04

## 1. 定位

工作地图是 Workflow Definition 的可视化编辑器，不是另外一套执行引擎。

~~~text
Skill Markdown
    ↓
Workflow Definition
    ↓
X6 工作地图
    ├─ 人工拖动 / 连线 / 属性修改
    └─ AI 生成 / 修改
    ↓
服务端 validate
    ↓
Investigation Active Workflow
    ↓
Workflow Execution
    ↓
Agent turn
~~~

职责边界：

- Workflow Definition：唯一业务语义来源。
- X6：节点、Port、Edge、选择、缩放、吸附、连线交互。
- Layout：只负责把 Workflow Definition 排成适合人阅读的坐标。
- Execution：只读取 Workflow Definition 和 Investigation 状态，不读取 X6 对象。

## 2. 内置 Workflow 与 Investigation 自定义 Workflow

内置路线仍存放在：

~~~text
skills/<workflow>/SKILL.md
~~~

用户编辑工作地图时，不修改内置 Skill，而是在当前 Investigation 下保存：

~~~text
<workspace>/<investigation>/
└── workflow/
    ├── journey.md
    ├── journey-meta.json
    ├── journey-layout.json
    ├── journey-execution.json
    └── journey-run-events.jsonl
~~~

含义：

- journey.md：当前真正生效的自定义 Workflow。
- journey-meta.json：对应哪个内置 Workflow，以及版本号。
- journey-layout.json：只保存节点坐标，不保存 X6 对象。
- journey-execution.json：当前执行位置、已完成节点、runId 和 waiting 状态。
- journey-run-events.jsonl：轻量运行事件历史。

没有自定义 Workflow 时，直接读取 Skill 内置 Markdown；版本为 0。

## 3. Workflow DSL

当前 DSL 只描述工作地图真正需要的少量语义：

~~~text
@flow
@task
@review
@end
~~~

节点：

- task：普通工作步骤，默认由 Agent 处理。
- review：人工确认步骤，默认由人工处理。
- end：结束事件。

节点可以有：

- actor
- completeWhen

route 只有：

- outcome
- target

规则很简单：

- 有 `completeWhen`：已有事实满足条件后自动走该节点的第一个出口。
- 没有 `completeWhen`：由 Agent / 人工选择当前节点真实存在的 outcome。
- `retry`、`failed` 等只是普通 outcome；工作地图根据 outcome 做视觉分类，不额外引入节点类型或分组。

这不是完整 BPMN runtime，不做 gateway、parallel token、timer、message event、subprocess 等复杂执行语义。

### 3.1 为什么只保留这些语义

Workflow 固定的是 Data Architect 的高层工作顺序，不是 Agent 每一步必须调用什么工具。Agent 在一个阶段内部可以自由检索、调用 Skill、使用 Tool、反复验证和回到前面的调查步骤。这些细节不应该继续膨胀 Workflow DSL。

因此 Workflow、Skill、Tool、Agent、Investigation State 的职责必须分开：Workflow 负责高层顺序、人工步骤和合法出口；Skill 负责某阶段怎么调查；Tool 负责真正执行；Agent 负责阶段内部的判断；State 保存当前执行位置和已完成步骤；runtime 不负责授权、审批、SQL 执行或外部副作用。

### 3.2 completeWhen 怎么工作

`completeWhen` 只是一个字符串 key，不是表达式语言。例如 `goal`、`current-state`、`validation`。Workflow runtime 把这个 key 交给宿主应用的事实判断逻辑；只有宿主应用知道这个 key 是否真的满足。

当前项目的 `conditionPassed()` 是应用层实现，它把这些 key 映射到 Investigation 的真实状态。它可以检查数据集数量、SQL parse failure、source-of-truth gap、Mapping、Validation 等事实，但这些业务字段不进入 Markdown DSL。

当当前节点有 `completeWhen` 且 evaluator 返回 true 时，runtime 只做一件事：沿该节点的第一个 route 前进。这样避免同时维护 `completion`、route condition、fallback 三套容易互相冲突的规则。

### 3.3 outcome 为什么保持字符串

`success`、`failed`、`retry`、`approved` 都只是 outcome。runtime 不理解这些词的业务含义，只根据当前节点找到同名出口，再进入 target。

工作地图可以根据 outcome 做视觉分类：success 绿色、failed 红色、retry 灰色虚线。但这些颜色和线型不能反过来决定执行行为。

`retry` 必须保留为真实 Edge。它表达的是“从当前处理步骤重新回到哪个真实步骤”，所以不需要 Group、隐藏节点或新的 DSL 类型。

### 3.4 人工步骤的最小实现

人工等待只依赖 `actor: human`。`@review` 默认就是人工步骤，因此普通路线不需要再写一套 approval DSL。

进入人工步骤以后，Execution 会记录：

~~~text
status = waiting
currentNodeId = review
pendingInteraction = { nodeId, reason, requestedAt }
~~~

Agent 不能替代人工推进。只有收到当前节点实际声明的 outcome，才会调用 Workflow transition。

Approval、authorization、policy、风险判断等安全语义不放进 Workflow。它们属于平台控制层；Workflow 只表达“这里需要人确认”以及“确认后有哪些合法出口”。

### 3.5 执行状态只有一个来源

`WorkflowExecution` 是真实运行状态，负责保存当前节点、已完成节点、运行状态和人工等待信息。`WorkflowState.stages` 只是 UI 投影。

因此不要再在其它对象里重复保存 `currentNodeId`、`completedNodeIds` 或 `unlockedNodeIds`。重复状态会让工作地图和实际执行位置出现分叉。

### 3.6 什么属于 Workflow，什么不属于 Workflow

| 内容 | 所在层 |
| --- | --- |
| 高层阶段顺序 | Workflow Skill |
| 当前阶段具体怎么调查 | Agent + Skill |
| SQL / 搜索 / lineage / profiling | Tool |
| 当前 Investigation 的事实 | Investigation State |
| completeWhen 的业务判断 | 宿主 evaluator |
| 人工确认 | Workflow actor + 宿主 UI |
| 权限 / approval / policy | 平台控制层 |
| 节点坐标和连线样式 | X6 / Layout |

这个边界决定了 Workflow 文件应该短而稳定；复杂性留在已有能力层，而不是不断给 DSL 增加字段。

## 4. X6 编辑器

X6 是实际的图编辑器。

~~~text
Workflow Definition
      ↓
X6 Graph
  ├─ React Shape node
  ├─ Port
  ├─ Edge
  ├─ Selection
  ├─ Snapline
  ├─ MiniMap
  └─ Keyboard
~~~

Workflow Definition 不依赖 X6 类型，因此以后即使替换画布实现，也不需要修改 Workflow runtime。

### Port

采用 X6 Agent Flow 类似的方向性 Port，不再在节点或连线旁显示 outcome 文案：

- success / 主流程：从节点底部出去，下一步从顶部进入。
- fail：从右侧出去，从目标步骤左侧进入。
- 其它分支：向另一侧展开。
- retry：保留真实 Port 和 Edge，使用灰色虚线回线。

Port 只负责连接和交互；用户选中连线后，在右侧“属性”查看真实 outcome、目标。

### Edge

连线只承担关系本身，不显示文字：

- 成功：绿色实线。
- 失败：红色实线。
- 其它普通分支：灰色实线。
- retry：灰色虚线回线；如果目标在上游，沿画布外侧 return lane 绕行。

成功边固定走 bottom → top，失败边走 right → left，其它分支由 X6 Manhattan router 自然寻找路径；统一使用 rounded connector，避免折线过硬。X6 自带 top/right/bottom/left 均匀分布 Port，因此不需要自己计算 Port 像素位置。

## 5. 为什么不用 ELK

X6 核心负责 Graph 编辑、Port、Edge、router 和 connector；通用布局算法属于另外的布局能力，官方 Gallery 也同时提供 Dagre、ELK 等不同实践。

当前工作地图不继续使用 ELK。

原因：

1. 业务结构固定：一条主要路线 + 少量分支 + 少量回退。
2. 节点数量通常不大。
3. 最重要的是阅读顺序，而不是任意 DAG 的全局最优。
4. 当前旧方案使用 ELK 后又手工二次调整 rank / Y，容易把结果压成一条线。

现在使用 workflow-v1：

- rank：决定主流程上下层级。
- lane：决定左右分支位置。
- retry 不参与布局排名，但仍保留为真实 Edge 并单独走 return lane。
- back edge：其它循环关系仍由图结构识别。
- collision guard：最后只做一次简单矩形碰撞保护。

布局只使用 workflow-v1；不再保留旧 ELK layout engine 的 schema 值。

## 6. 自动排版规则

目标不是把节点塞进最小面积，而是让人一眼看懂主线和分支。

主流程默认纵向向下；分支向左右展开。长 Workflow 因此自然占用二维空间，而不是被压成一条很长的横线：

~~~text
                         ┌──────────┐
                         │ 失败分支  │
                         └────┬─────┘
                              │
                     ┌────────▼────────┐
                     │ 查关键问题       │
                     └────────┬────────┘
                              │
                         ┌────▼────┐
                         │ 找到数据 │
                         └────┬────┘
                              │
                         ┌────▼────┐
                         │ 看清旧系 │
                         └────┬────┘
                              │
                         ┌────▼────┐
                         │ 接到任务 │
                         └─────────┘

       retry 关系直接用灰色虚线回线表示，并沿画布外侧 return lane 绕行。
~~~

主线只是视觉概念，不是第二套 Workflow。

拖动节点后不会自动重新布局；只有用户点击“自动排版”时才重新计算。

## 7. 保存

保存接口：

~~~http
PUT /api/sessions/:name/workflow
~~~

客户端提交：

- Workflow Definition。
- 节点 x/y layout。

服务端重新执行完整 Workflow validation。

Workflow version 保存语义；layout 保存同一版语义对应的视觉坐标。

## 8. AI

工作地图 AI 只负责 Workflow 设计，不直接修改 Investigation 数据，也不参与正常 Investigation execution。

AI 返回：

~~~text
WorkflowChange[]
~~~

前端先预览，再由用户应用，再保存。

AI 生成的 Definition 与人工编辑走同一套 validation。

## 9. Retry / Failed 语义

retry 不是 BPMN 的标准 outcome，而是这个 Workflow DSL 的业务结果。工作地图不把它转换成额外的节点或分组语义。

推荐的表达方式是：

~~~text
A ── success ──► B
B ── failed  ──► Failure Review
Failure Review ── retry ──► A
~~~

其中：

- success：绿色实线。
- failed / error / rejected：红色实线。
- retry / rework / rollback：灰色虚线。
- 其它 outcome：灰色实线。

连线上不直接显示文字。选中连接后，右侧“属性”显示真实 outcome、来源和目标。

retry 线不会删除 Workflow 中真实存在的 retry 关系；只是使用画布外侧的 return lane 绕行，避免穿过其它节点。这样业务语义和视觉表达是一致的，也比视觉分组更容易理解。

## 10. 当前刻意不做

不引入：

- BPMN 全量 runtime。
- parallel / inclusive gateway。
- 多 token join。
- Workflow Registry。
- 通用 orchestration engine。
- 通用图布局服务。
- 为布局再引入一层图引擎。

工作地图当前只解决一件事：把真实 Workflow 变成一个可编辑、可保存、可执行、看得懂的工作图。
