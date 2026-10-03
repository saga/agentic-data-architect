# Journey Workflow Editor

> 架构增量：2026-10-03

## 1. 为什么要把工作地图变成编辑器

原来的 Journey Map 只是展示当前阶段，实际运行逻辑仍按节点数组顺序判断。这样有两个问题：

1. React Flow 上看到的分支并不是真正的执行状态机。
2. 用户可以在地图上理解一条路线，却不能把自己的工作方式保存下来并真正执行。

现在 Workflow 分成三个层次：

~~~text
内置 Skill Markdown
      ↓ parse
Workflow Definition
      ↓
React Flow 工作地图
      ├─ 人工拖拽 / 连线 / 属性编辑
      └─ 工作地图 AI 生成 / 修改
      ↓ 保存
服务端 validate
      ↓
Investigation Active Workflow
      ↓
Workflow Execution
      ↓
Agent turn
~~~

React Flow 负责交互和布局；Workflow Definition 才是语义。这样 UI、Markdown 和运行时不会各自维护一套规则。

## 2. 内置 Workflow 与 Investigation 自定义 Workflow

内置路线仍存放在：

~~~text
skills/<workflow>/SKILL.md
~~~

用户编辑工作地图时，不修改内置 Skill，而是在当前 Investigation 下直接保存：

~~~text
<workspace>/<investigation>/
└── workflow/
    ├── journey.md
    ├── journey-meta.json
    ├── journey-layout.json
    └── journey-execution.json
~~~

含义：

- journey.md：当前真正生效的自定义 Workflow。
- journey-meta.json：对应哪个内置 Workflow，以及版本号。
- journey-layout.json：React Flow 节点位置。
- journey-execution.json：当前执行位置、已完成节点和 Workflow version。

没有自定义 Workflow 时，直接读取 Skill 内置 Markdown；版本为 0。

工作地图进入后就是编辑状态。人工编辑和 AI 修改都只改变当前画布；点击“保存”后，服务端验证并创建新的 Investigation Workflow version。保存成功后会清除 Copilot Session，使下一轮 Agent 不继续使用旧工作流上下文。若当前执行节点仍存在于新 Workflow，会保留当前节点和仍然存在的已完成节点；只有当前节点被删除时才回到新 Workflow 的 start。
## 3. DSL：保持小，不建立 BPMN

当前 DSL 仍然只有少量核心构件：

~~~text
@flow
@task
@gate
@review
@end
@stop

title:
objective:
visible:
completion:
completeWhen:
tools:

success -> next
needs-input -> intake
retry -> investigate
rollback -> investigate
~~~

没有新增 @branch、@condition、@switch、@loop 等语法。

### completion

新增：

~~~yaml
completion: deterministic
~~~

或：

~~~yaml
completion: agent
~~~

语义非常简单：

- deterministic：必须有 completeWhen，由代码根据已有 Investigation 状态判断是否满足。
- agent：不能只因为 Agent 说“完成了”就推进，由 Agent 明确返回一个实际存在的 outcome，服务端再验证。

为了兼容旧 Skill：

~~~text
有 completeWhen
  → 默认 deterministic

没有 completeWhen
  → 默认 agent
~~~

因此旧的 Markdown 不需要一次性重写。

### outcome

仍然使用最简单的：

~~~text
- success -> target
~~~

这条线就是 Workflow 的真实边。

同一个节点的 outcome 必须唯一。目标节点必须存在。

## 4. React Flow 编辑器

编辑模式采用 React Flow 的 controlled flow：

~~~text
nodes
edges
  ↓
useNodesState
useEdgesState
  ↓
ReactFlow
~~~

官方文档建议用 useNodesState / useEdgesState 管理受控节点和边，并通过 onConnect + addEdge 增加连接。当前实现还支持 onReconnect + reconnectEdge 修改已有分支的目标。边上的 outcome 使用 EdgeLabelRenderer，因此可以直接点击分支标签编辑。当前编辑器还为每条 incoming/outgoing route 分配独立 Handle，并使用 ELK layered layout 与较宽松的节点间距减少线路交叉。布局在 React Flow 完成节点实测尺寸后会再跑一次，并增加最后一道碰撞保护，避免自定义节点实际高度超过布局估算后互相重叠。React Flow 官方的 ELK multiple-handles 示例明确使用独立 ports 和 FIXED_ORDER 来降低 edge crossings。

参考：

- React Flow Adding Interactivity
- useNodesState
- useEdgesState
- onConnect
- onReconnect
- reconnectEdge
- EdgeLabelRenderer
- NodeToolbar

当前编辑器支持：

~~~text
进入即编辑
拖动节点
添加步骤
添加分支
从一个节点连接到另一个节点
重新连接已有分支
删除节点
删除分支
编辑节点属性
编辑分支 outcome
修改分支目标
撤销 / 重做
自动排版
AI 生成工作地图
AI 修改当前工作地图
保存
恢复内置 Workflow
~~~
Node Toolbar 只在选中节点时出现，避免整张地图被按钮污染。

工作地图现在是独立路由 `/investigations/:name/journey`，不再使用全屏 Modal；页面打开后直接可以拖动、连线和修改属性。

## 5. Save / Validate / AI

编辑不会在浏览器里单独维护“只读版”和“草稿版”两套地图。进入工作地图后，画布就是当前编辑状态。

### 保存

~~~http
PUT /api/sessions/:name/workflow
~~~

浏览器把当前 Workflow Definition 和 layout 一起提交。服务端再次执行完整 Workflow validation；通过后才写入 `journey.md`、layout、execution，并创建新的 Workflow version。

保存失败时，画布保持当前状态，用户可以继续修正。

### AI 生成 / 修改

~~~http
POST /api/sessions/:name/workflow/ai
~~~

`mode=generate` 表示重新设计整张图；`mode=modify` 表示基于当前地图做局部或结构性修改。

工作地图 AI 是独立的业务能力，不参与数据分析。它不会读取 Dataset Registry、SQL、数据证据，也不会参与 Investigation 的正常执行推进。AI 只返回候选 Workflow Definition；服务端立即用与人工保存相同的 Workflow validation 检查它。

AI 不直接保存。返回结果只替换当前画布，用户检查后再点击“保存”。这样“AI 修改建议”和“真正改变执行 Workflow”之间保留一个明确的确认点。

### 验证

保存时服务端会检查：

~~~text
1. Schema / 基本结构
2. node ID
3. start 是否存在
4. edge target 是否存在
5. outcome 是否重复
6. 非终点节点是否至少有一个出口
7. end / stop 是否还有出口
8. 是否有不可达节点
9. 是否存在无法到达 end / stop 的节点
10. deterministic 是否有 completeWhen
11. completeWhen 是否是已知条件
12. 每个节点是否有画布位置
~~~

### 恢复内置

~~~http
POST /api/sessions/:name/workflow/reset
~~~

恢复操作删除当前 Investigation 的自定义 Workflow，重新使用内置 Skill 路线，并重新建立对应的执行状态。
## 6. Workflow Runtime

Workflow 现在真正拥有一个执行状态：

~~~json
{
  "workflowId": "legacy-modernization",
  "workflowVersion": 2,
  "currentNodeId": "investigate",
  "completedNodeIds": ["intake", "estate-map"],
  "status": "active"
}
~~~

Agent 每一轮启动时只收到当前节点和合法出口：

~~~text
当前节点：investigate

允许的出口：
- success -> current-state
- needs-input -> investigate
~~~

Agent 最终 JSON 可以增加：

~~~json
{
  "workflow": {
    "nodeId": "investigate",
    "outcome": "success"
  }
}
~~~

服务端随后检查：

~~~text
nodeId 是否等于当前节点
       ↓
outcome 是否是当前节点真实存在的出口
       ↓
target 是否存在
       ↓
Workflow version 是否仍然一致
       ↓
写入 journey-execution.json
~~~

任何一步失败，都不推进。

因此：

~~~text
Agent 可以决定“这次走 success 还是 needs-input”
但是
Agent 不能创造一个不存在的出口，也不能自己改变 Workflow 图
~~~

## 7. Deterministic completion 与 Agent completion 的边界

两种完成方式不要混在一起。

### Deterministic

例如：

~~~yaml
completion: deterministic
completeWhen: goal
~~~

代码根据 Investigation 当前状态决定是否完成。

适合：

- goal
- current-state
- data-truth
- investigation
- current-state-ready
- target
- mapping
- validation
- cutover
- assessment-current-state
- assessment-findings
- assessment-recommendation
- assessment-roadmap

### Agent

例如：

~~~yaml
completion: agent
~~~

表示这一阶段需要真正调查、分析、判断，再选择出口。

适合：

- 业务需求澄清
- 金融业务模型判断
- 架构设计
- Semantic 设计
- Agent 设计
- 安全控制设计
- Evaluation 设计

这不是把判断交给“模型做安全控制”，而是把 Workflow 中本来就属于分析判断的选择显式化；最终能不能走，只接受 Workflow 中已有 outcome。

## 8. 环与回退

不能简单禁止 DAG。

现有 Workflow 已经需要：

~~~text
retry
rollback
needs-input
investigate -> 前一步
~~~

因此验证允许环，但必须满足：

~~~text
所有节点从 start 可达
+
所有节点至少存在一条最终到 end / stop 的路径
~~~

例如：

~~~text
investigate
   ├─ retry ─────┐
   │             ↓
   └─ success → current-state → done
~~~

是合法的。

而：

~~~text
A -> B
B -> A
~~~

没有出口到终点，就会被验证拒绝。

## 9. 动态 Route Plan 不等于 Workflow

已有的 Agent routeOptions 继续保留，但它们和 Workflow 是两种不同东西：

~~~text
Workflow
  = 当前 Investigation 的正式工作方式
  = 有状态
  = 可编辑
  = 会真正影响 Agent execution

routeOptions
  = Agent 临时建议
  = 没有持久化控制权
  = 可以有，也可以没有
  = 不能绕过 Workflow
~~~

因此 UI 仍然可以显示：

~~~text
Agent 临时建议
  ├─ 先查血缘
  ├─ 先确认业务定义
  └─ 先做数据 profiling
~~~

但这些建议不等于 Workflow 分支。

## 10. React Flow 为什么放在 UI，Markdown 为什么留在后端

不把 React Flow JSON 当唯一存储格式，原因很实际：

React Flow JSON 适合：

- 节点位置
- viewport
- 画布交互
- UI 状态

Markdown DSL 适合：

- Git diff
- 人工 review
- 文档化
- Skill 打包
- 测试
- 离线修改
- 长期兼容

所以使用：

~~~text
Workflow semantics → Markdown / parsed definition
Canvas layout      → JSON
Execution state    → JSON
~~~

而不是：

~~~text
React Flow toObject()
    ↓
直接当 Workflow DSL
~~~

## 11. 当前 API

~~~text
GET  /api/sessions/:name/journey
GET  /api/sessions/:name/workflow
PUT  /api/sessions/:name/workflow
POST /api/sessions/:name/workflow/ai
POST /api/sessions/:name/workflow/reset
~~~

其中：

- /journey：调查页面使用的简化状态。
- /workflow：工作地图完整快照。
- PUT /workflow：保存当前工作地图，并创建新版本。
- /workflow/ai：工作地图专用 AI，生成或修改 Flow。
- /workflow/reset：恢复内置 Skill。
- /workflow/instruction：普通 Investigation Agent 当前会收到的 Workflow 控制摘要。
## 12. 与现有代码的边界

### src/workflow/journey.ts

负责：

~~~text
DSL parse
completion
route
graph validation
execution transition
JourneyState
~~~

### src/workflow/journey-editor.ts

负责：

~~~text
active custom Workflow
layout
version
execution persistence
serialization
Agent transition
~~~

### web/src/components/JourneyMap.tsx

负责：

~~~text
React Flow
graph interaction
node inspector
edge inspector
undo/redo
validation UI
AI 操作、保存 / 恢复
~~~

### src/server-main.ts

在原有 src/server.ts 外增加：

~~~text
Workflow Editor APIs
~~~

这样不用把已有 API 文件继续做成“大杂烩”。

## 13. 后续可以做，但当前不要做

暂时不引入：

- BPMN / Temporal
- 独立 Workflow Registry
- 独立 Agent Registry
- 通用规则引擎
- React Flow Pro 依赖
- ELK
- 多用户 Workflow 权限体系
- Workflow marketplace

当前编辑器先把最核心的事情做好：

~~~text
看得见
→ 改得动
→ 加得了分支
→ 服务端能验证
→ 应用后真的按新路线执行
→ 出问题能恢复内置版本
~~~

后续如果真实 Workflow 开始出现明显的图复杂度，再考虑 ELK 自动布局；如果出现多人同时编辑，再增加 optimistic concurrency / revision check，而不是现在提前做完整协作系统。

## 14. 为什么这次改了布局

之前的默认布局只是按图深度分列。对于简单线性流程还能工作，但一个节点存在多个 outcome 后，所有边从同一个右侧连接点出发，线路和标签很容易叠在一起。

现在使用 ELK layered layout。React Flow 官方把 Dagre 作为简单方案，把 ELK 作为更可配置的方案；官方的 multiple-handles 示例还展示了通过 ports + FIXED_ORDER 降低 edge crossings 的做法。当前地图始终使用同一套节点、边、Handle 和布局；不存在单独的只读画布。（参考 React Flow 官方 Auto Layout / ELK 文档与 Multiple Handles 示例）

本项目选择 ELK 的原因不是为了做复杂 BPMN，而只是解决当前编辑器最明显的两个问题：

~~~text
节点位置
  ↓
分层 + 间距 + crossing minimization

连接点
  ↓
每条 outgoing / incoming route 独立 port

边
  ↓
SmoothStep rendering

标签
  ↓
按分支序号做轻微垂直偏移
~~~

因此新增分支后不再要求用户自己一点点挪节点躲线。自动布局同时为节点保留更大的安全间隔，并按新的 ELK-v2 layout 标记自动升级旧的布局数据。

React Flow 的 EdgeLabelRenderer 默认没有 pointer events；当前项目为 label 设置 pointer-events: all，并使用 nodrag / nopan，让用户可以直接点击 outcome 编辑。（参考 React Flow 官方 EdgeLabelRenderer 文档）

### 连接问题提示

地图会直接在节点上标出结构性连接问题：普通节点没有入口或出口、或者存在指向不存在节点的 route，会显示红框和“需要修正连接”。`@end` / `@stop` 没有出口以及 Workflow start 没有入口属于正常情况，不会误报。



### 新节点的交互

- 新节点使用橙色虚线框 + “新建步骤”标签。
- 创建后自动选中。
- 如果当前节点已有 success 路线，“添加下一步”会把新节点插入现有 success 路线，而不是生成 success-1 之类难以理解的出口。
- “添加分支”会创建一条新的 branch；存在主 success 目标时，新分支会先接回主流程。
- 任何节点都可以通过“连接到现有步骤”直接选择目标和 outcome。
- 也可以拖动右侧 source Handle 到目标节点左侧 target Handle。

这些操作最后仍然只生成原来的 Markdown DSL；没有增加第二套图语法。

### 15. 地图显示原则

Workflow 的 `@end` / `@stop` 是真正的终点，不因为 DSL 中的 `visible:false` 就在工作地图里消失；否则最后一条边会视觉上像“断掉”。

普通业务节点仍可按 `visible` 控制展示，而终点在地图中始终保留。这样地图展示的是完整 Workflow，而不是只展示当前正在操作的阶段。

### 16. Journey Map 前端代码结构

为了避免 `JourneyMap.tsx` 再次变成“大组件”，前端现在按职责拆成：

```text
JourneyMap.tsx
  └── 页面组合与 React Flow 容器

useJourneyWorkflowEditor.ts
  └── 编辑状态、Undo/Redo、Graph mutation、Save / AI

journey-map-types.ts
  └── Workflow / React Flow shared types

journey-map-graph.ts
  └── Definition ↔ React Flow graph、Handle、连接诊断

journey-map-layout.ts
  └── ELK 自动布局 + measured size + collision guard

JourneyFlowNode.tsx
  └── 节点渲染 / Handle / toolbar

JourneyFlowEdge.tsx
  └── Edge / self-loop / outcome label

JourneyMapInspector.tsx
  └── 节点与分支属性编辑
```

其中自动布局使用 React Flow 完成节点尺寸测量后再执行最终布局；这和 React Flow 官方 `useNodesInitialized` 的推荐使用方式一致。ELK multiple-handles 方案也要求为 port 使用稳定 ID、正确 side 和 `FIXED_ORDER`，当前实现按这个模式处理分支连接点。（参考 React Flow 官方 useNodesInitialized、ELK Multiple Handles 文档）
