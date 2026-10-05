# ADR-009：前端 App 只负责装配，页面与 UI 状态按职责拆分

- Status: Accepted
- Date: 2026-10-05

## Context

`web/src/App.tsx` 同时承担了路由、Investigation 数据加载、Agent turn 控制、权限/用户输入交互、文件上传、Workflow 修改、对话消息构建以及完整页面 JSX。

这种结构使 App 成为一个大型组件：任何局部 UI 修改都可能触碰大量运行状态和事件处理，也让状态之间的依赖关系难以理解和测试。

## Decision

前端采用“App shell + controller hook + presentational components”的轻量拆分：

- `App.tsx` 只负责全局 Provider 和应用入口；
- Investigation 的会话/执行状态和动作集中在 controller hook；
- 左侧调查列表、顶部栏、聊天区、右侧事实栏、弹窗等按 UI 职责拆成独立组件；
- 纯展示组件通过 props 接收状态和 callback，不直接读取全局 Investigation 状态；
- 现有 API、状态语义和用户交互保持不变；本次重构不改变后端架构和业务行为。

拆分的目标是降低单文件复杂度和职责耦合，不建立新的状态管理框架，也不引入 Redux、Context Store 或 UI framework abstraction。

## Consequences

- App.tsx 变成稳定的入口/装配点；
- Investigation runtime state 仍只有一个 controller source；
- 局部 UI 可以独立测试和演进；
- 不需要引入新的全局状态系统。

代价是组件之间需要明确 props contract，controller hook 会承担较多动作编排，因此需要避免把它再次变成另一个 JSX 容器。

## Scope

本 ADR 约束前端结构，不要求所有组件都立即拆分。优先拆分职责明显、代码量大、状态边界清楚的部分。

本 ADR 的形成讨论见 Appendix A；附录仅供参考。
## Appendix A：形成决定时的分析记录（仅供参考）

这次重构的直接原因是 web/src/App.tsx 已经同时包含路由、会话加载、执行状态轮询、Agent turn、权限和用户输入响应、文件上传、Workflow 修改、消息渲染以及完整三栏布局。

检查后发现，真正可以独立出来的边界很清楚：

- controller：状态、API 调用和 Agent turn 行为；
- page router：chat/config/results/trajectory/journey 页面选择；
- sidebar：调查列表和左栏宽度；
- topbar：工作区状态和导航入口；
- chat panel：消息、权限请求、用户输入和 composer；
- context panel：Journey 和当前事实；
- dialogs：新建调查和待查内容。

因此没有引入全局状态管理框架，也没有把每个函数机械地拆成大量小文件，而是按已经存在的职责边界拆分。App.tsx 最终只负责 Provider 和 controller/page/workspace 的装配。

这次分析还发现原 App 与已有组件存在两个潜在的前端类型/解析问题：WorkflowId 没有从统一类型文件导入，以及 ChatContent 使用了未在自身定义的 formatTime。重构时一并恢复到统一类型/本地工具函数，但没有改变业务行为。

本附录只记录重构形成过程，不构成正文之外的额外架构规则。