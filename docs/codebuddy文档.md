https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/workflows.md Dynamic Workflows（动态工作流）
Dynamic Workflows 让 CodeBuddy 写一段 JavaScript 编排脚本，由运行时在后台调度数十甚至数百个子代理协作完成任务。脚本本身可读、可改、可重跑，适合代码库审计、大型迁移、需要交叉验证的研究类任务。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/acp.md ACP 协议集成
ACP (Agent Client Protocol) 是 Zed 编辑器推出的一种通用智能体协议，使智能体的核心功能（服务端）和用户界面（客户端）解耦，允许用户自由选择不同的智能体服务端和客户端进行搭配使用。CodeBuddy Code 原生支持 ACP 协议，可以作为智能体服务端与支持 ACP 的编辑器无缝集成。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/sdk.md CodeBuddy Agent SDK 允许你在应用程序中以编程方式控制 CodeBuddy Agent。支持 TypeScript/JavaScript 和 Python，可实现自动化任务执行、自定义权限控制、构建 AI 驱动的开发工具等场景。npm install @tencent-ai/agent-sdk 。使用已有登录凭据
如果你已经在终端中通过 codebuddy 命令完成了交互式登录，SDK 会自动使用该认证信息，无需额外配置。
使用 API Key：如果未登录或需要使用不同的凭据，可以通过 API Key 认证：export CODEBUDDY_API_KEY="your-api-key"


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/sdk-typescript.md TypeScript SDK 的完整 API 参考。有关快速入门和使用示例，请参阅 SDK 概览。SDK 支持使用已有登录凭据、API Key 或 OAuth Client Credentials 认证，详见 SDK 概览 - 认证配置。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/sdk-sessions.md 本文档介绍如何在 SDK 中管理会话，包括获取会话 ID、恢复会话、分叉会话和多轮对话。会话开始时，SDK 会返回一个 system 类型的初始化消息,其中包含 session_id。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/sdk-permissions.md 本文档介绍如何在 SDK 中实现权限控制，包括权限模式、canUseTool 回调和工具白名单/黑名单。 


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/sdk-mcp.md 本文档介绍如何在 CodeBuddy Agent SDK 中集成和使用 MCP（Model Context Protocol）服务器，为你的应用程序扩展自定义工具和功能。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/sdk-hooks.md 介绍如何在 SDK 中使用 Hook 系统，在工具执行前后插入自定义逻辑。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/sdk-demos.md 仓库地址：https://cnb.cool/codebuddy/agent-sdk-demos


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/sdk-custom-tools.md Custom Tools 是 CodeBuddy Agent SDK 提供的一种通过 MCP（Model Context Protocol）创建自定义工具的方式。与配置外部 MCP 服务器不同，Custom Tools 允许你直接在应用程序中定义工具，无需单独的进程或服务器。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/agent-teams.md Agent Teams 让你协调多个 CodeBuddy Code 实例共同工作。一个会话作为团队领导（team-lead），负责协调工作、分配任务和汇总成果；其余成员（teammates）各自独立工作，拥有自己的上下文窗口，并通过消息系统直接相互沟通。与子代理（Sub-agents）不同的是，子代理在单一会话内运行、只能将结果报告给主代理；而 Agent Teams 的成员之间可以直接通信，你也可以绕过领导直接与任意成员对话。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/workflow-stdio-protocol.md 在 stdio stream-json 通道上如何暴露 Dynamic Workflow 的进度与生命周期，以及该协议与 Claude Code 2.1.220 的对齐关系。目标是让任何按 Claude Code 官方 stream-json 协议实现的 SDK / daemon / CI 都能不改代码地消费 cbc 的 workflow 事件。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/troubleshooting.md 涵盖常见问题解决方案和使用优化建议。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/tools-reference.md 内置一系列工具来帮助理解和修改代码库。下表中的工具名称即为权限规则、子代理工具列表和 Hook 匹配器中使用的标识符。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/sub-agents.md CodeBuddy Code 中的自定义子代理是专门的 AI 助手，可以被调用来处理特定类型的任务。它们通过提供具有自定义系统提示、工具和独立上下文窗口的特定任务配置，实现更高效的问题解决。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/skills.md Skills 是 CodeBuddy Code 的扩展能力系统，允许您创建专业的领域知识和工作流模板，让 AI 助手能够更专业地处理特定类型的任务。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/security.md CodeBuddy Code 默认使用严格的只读权限。当需要额外操作（编辑文件、运行测试、执行命令）时，CodeBuddy Code 会请求明确的权限。用户可以控制是一次性批准操作还是自动允许。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/prewarm.md 预热进程让 cbc 先把冷启动跑完并挂起（加载 bundle → 容器初始化 → 认证 → 产品配置 → MCP 发现），之后通过本地 IPC 唤醒时只需绑定工作目录即可立即服务。 适合需要"秒级拉起会话"的场景（如 serve/acp 网关、会话池、调度器预拉起）。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/plugins.md 插件让你可以通过自定义技能、代理、钩子和 MCP 服务器来扩展 CodeBuddy Code 的功能。本指南涵盖如何创建你自己的插件。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/permissions.md CodeBuddy Code 的权限不是“只看当前 mode”，而是一条分层求值链。每次工具调用，大致按下面顺序判定


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/memory.md CodeBuddy Code 可以跨会话记住您的偏好，例如代码风格指南和工作流程中的常用命令。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/mcp.md MCP (Model Context Protocol) 是一个开放标准，允许 CodeBuddy 与外部工具和数据源进行集成。通过 MCP，您可以扩展 CodeBuddy 的功能，连接到各种外部服务、数据库、API 等。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/large-codebases.md 大型代码库可以是拥有数百万行代码的单个存储库，也可以是包含许多包的 monorepo。 CodeBuddy Code 可以在任何规模下工作，但随着代码库的增长，为较小项目调整的默认设置可能会用与任务无关的指令和文件读取填满上下文窗口，浪费 tokens 并降低 CodeBuddy 的性能。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/iam.md 如何为组织中的 CodeBuddy Code 配置用户身份验证、授权和访问控制。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/hooks-guide.md CodeBuddy Code hooks 是用户定义的 shell 命令，在 CodeBuddy Code 生命周期的不同阶段执行。Hooks 提供了对 CodeBuddy Code 行为的确定性控制，确保特定操作始终发生，而不是依赖 LLM 选择执行它们。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/headless.md 无头模式允许您通过命令行脚本和自动化工具以编程方式运行 CodeBuddy Code,无需任何交互式 UI。无头模式也支持定时任务相关能力。在脚本、SDK 或服务端集成场景中，可以使用 CronCreate、CronList、CronDelete 等工具来创建、查看和取消定时任务。


https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/goal.md /goal 命令设置一个完成条件，CodeBuddy 持续向其推进而无需你逐步催促。每轮（turn）结束时，由小模型（small-fast model）评估器判断条件是否成立——若不成立，CodeBuddy 自动开始下一轮，而不是把控制权交回给你。一旦条件满足，目标自动清除。


