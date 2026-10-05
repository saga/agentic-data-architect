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