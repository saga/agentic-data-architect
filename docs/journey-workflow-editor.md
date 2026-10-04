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

当前 DSL 只保留工作地图真正需要的少量语义：

~~~text
@flow
@task
@gate
@review
@end
@stop
~~~

节点：

- task：普通工作步骤。
- gate：判断点。
- review + actor: human：人工确认。
- end / stop：结束事件。

节点可以有：

- actor
- completion
- completeWhen
- requires
- produces
- tools

route 可以有：

- outcome
- target
- condition

这不是完整 BPMN runtime。当前不做 parallel / inclusive gateway、多 token join、timer / message event、subprocess 等复杂执行语义。

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

Port 只负责连接和交互；用户选中连线后，在右侧“属性”查看真实 outcome、目标和 condition。

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

旧的 elk / elk-v2 ... elk-v5 layout 值继续可读，新保存的自动布局统一写 workflow-v1。

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

连线上不直接显示文字。选中连接后，右侧“属性”显示真实 outcome、来源、目标和 condition。

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
