# ADR-031：CodeBuddy Investigation Runtime 必须禁止宿主仓库修改

- Status: Accepted
- Date: 2026-10-07
- Decision scope: CodeBuddy SDK capability boundary and Investigation workspace isolation

## Context

本项目把 CodeBuddy SDK 当作 Investigation Runtime，而不是代码开发 Agent。源码仓库由服务端预先准备到当前 Investigation workspace 的 `artifacts/github/<owner>__<repo>` 下；Agent 不应该拥有修改本项目自身源码的能力。

此前 CodeBuddy adapter 存在一个实际的 authority-boundary 问题：产品层 `allow_all` 被转换成 SDK `bypassPermissions`，而 `canUseTool` 对大多数工具直接 allow。由于内置 Write/Edit/Bash 等宿主能力仍然可用，仅设置 `cwd` 或关闭 `settingSources` 并不能阻止模型离开 cwd 去修改其它目录。

这使一次“调查”理论上可以修改正在运行本项目的 `agentic-data-architect` 源码。这是错误的权限边界。

## Decision

1. **CodeBuddy Investigation 采用显式 built-in tool allowlist。**
   只启用调查所需的 `Read` / `Glob` / `Grep` / `AskUserQuestion` / `Skill`；禁止 `Write` / `Edit` / `Bash` / `Task` 等修改或宿主执行工具。

2. **Allow All 不得升级 capability。**
   产品层 Allow All 只表示安全白名单内的工具免逐次人工确认；它不能把 CodeBuddy Investigation 变成 coding shell。

3. **`canUseTool` 保留为第二道防线。**
   即使 SDK 默认工具集合发生变化，任何不在 allowlist 或不属于受控 MCP 的工具都必须 deny。

4. **Read/Glob/Grep 的路径必须位于 Investigation workspace。**
   用户指定的 GitHub 仓库先由服务端 clone 到当前 workspace，因此 Agent 不需要读取宿主其它目录。未来如确实需要外部源码目录，必须增加 server-managed read-only boundary，而不是开放绝对路径。

5. **SDK configuration sources 保持关闭。**
   `settingSources: []` 继续保持，避免调查目标仓库中的 CodeBuddy 配置改变宿主运行策略。

6. **Investigation 状态写入只能通过 application-owned tools/workflow/store。**
   Workbench/Graphify 等 MCP 可以执行它们自己声明的受控操作；CodeBuddy 不能通过原生 filesystem/shell 直接修改 application repository。

## Consequences

CodeBuddy 仍可以完成代码阅读、结构导航、grep、workspace 内 Evidence 整理和用户问答，但不再拥有直接改代码或执行 shell 的能力。

这和 CodeBuddy 平台自己的权限分层一致：默认 NPC 模式以只读能力为主，显式 Work Mode 才提供代码写入、push、PR 等开发能力。citeturn641627search2turn809562search7

## Rejected alternatives

### 只靠 system prompt 告诉 Agent “不要修改代码”

拒绝。Prompt 是行为约束，不是 capability boundary；拥有 Write/Edit/Bash 的 Agent 仍然有执行路径。

### 只把 cwd 设置为 Investigation workspace

拒绝。cwd 是默认工作目录，不是安全沙箱；shell 和绝对路径工具可以离开 cwd。

### 继续使用 bypassPermissions + 全工具 allow

拒绝。对于 Investigation 这种只读任务，这等于把权限安全交给模型自觉，authority boundary 本身没有收紧。

## Related ADRs

- ADR-003：Personal Local Agent Runtime
- ADR-005：Workflow、Skill、Tool、Agent、Human separation
- ADR-011：Mission Contract as Investigation boundary
- ADR-014：Probabilistic Agent + deterministic gates
- ADR-027：Investigation State / Local Analysis Persistence Boundary
- ADR-028：Agent Runtime Selection and Fallback