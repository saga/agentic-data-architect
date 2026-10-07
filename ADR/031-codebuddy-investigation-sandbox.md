# ADR-031：CodeBuddy Investigation Runtime 必须禁止宿主仓库修改

- Status: Accepted
- Date: 2026-10-07
- Decision scope: CodeBuddy SDK capability boundary and Investigation workspace isolation

## Context

本项目把 CodeBuddy SDK 当作 Investigation Runtime，而不是代码开发 Agent。源码仓库由服务端准备到当前 Investigation workspace 的 `artifacts/github/<owner>__<repo>` 下；Agent 不应该拥有修改本项目自身源码的能力。

此前 CodeBuddy adapter 把产品层 `allow_all` 转成 SDK `bypassPermissions`，而 `canUseTool` 对大多数工具直接 allow。由于 Write/Edit/Bash 等内置宿主能力仍然可用，仅设置 `cwd` 或关闭 `settingSources` 并不是可靠的 authority boundary。

这使一次调查理论上可以离开 Investigation workspace，通过 shell 或文件工具修改正在运行的 `agentic-data-architect` 源码。

## Decision

1. **显式限制 built-in tools。**
   只启用 `Read` / `Glob` / `Grep` / `AskUserQuestion` / `Skill`；禁止 `Write` / `Edit` / `Bash` / `Task` 等修改或宿主执行工具。

2. **Allow All 不得升级 capability。**
   产品层 Allow All 只表示安全白名单内的 Investigation 工具免逐次人工确认；不能把 CodeBuddy Investigation 变成 coding shell。

3. **`canUseTool` 作为第二道防线。**
   不在 allowlist 内的 built-in tool 一律 deny；未来 SDK 默认工具集合变化也不能扩大权限。

4. **文件路径必须留在 Investigation workspace。**
   Read/Glob/Grep 的 path 参数必须解析后仍位于当前 workspace。用户指定的 GitHub repository 先由服务端 clone 到 workspace，Agent 无需访问宿主其它目录。

5. **SDK configuration sources 保持关闭。**
   `settingSources: []` 继续保持，避免调查目标仓库中的 CodeBuddy 配置改变宿主运行策略。

6. **状态写入使用 application-owned tools/workflow/store。**
   Workbench/Graphify 等 MCP 受应用自己的工具实现约束；CodeBuddy 不能通过原生 filesystem/shell 直接修改 application repository。

## Consequences

CodeBuddy 仍能完成代码阅读、结构导航、grep、workspace 内 Evidence 整理和用户问答，但不再拥有直接改代码或执行 shell 的能力。

CodeBuddy 平台自身也把普通 NPC 与显式 Work Mode 的权限区分开：默认模式以只读工作为主，Work Mode 才提供代码写入、push、PR 等开发能力。

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
