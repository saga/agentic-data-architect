# ADR-007：Graphify 结构分析能力（历史决定）

- Status: Superseded
- Date: 2026-10-07

## Context

项目需要分析大型 legacy repository。仓库调查中同时存在两类完全不同的问题：

1. **结构问题**：模块如何连接、调用链怎么走、某个表/SQL/模块有哪些上下游、哪些节点是结构枢纽、两个对象之间是否存在路径。
2. **文本 / 文件问题**：某个字符串在哪里、有哪些文件、读取一个确定文件、查看目录、按文件名过滤、查看 Git diff 等。

Graphify 专门解决第一类问题。它把代码、SQL、配置和相关项目资料转换成可查询的 structural graph，并提供关系查询、邻居查询、路径、community、god nodes 等能力。

常规命令（例如 `find`、`grep`、`rg`、`cat`、`sed`、`git`）解决第二类问题，而且在简单、确定的文件操作上更直接、更快。

此前项目已经引入 Graphify capability，但只有“Graphify 是 structural navigation，不是事实来源”的边界，没有明确规定**什么时候必须优先使用 Graphify、什么时候应该使用常规命令**。结果是 Agent 很容易退化成“什么都 grep”，即使问题本质上是在询问代码结构。

这和项目对专用工具的总体原则不一致：当一个工具专门解决某类问题，并且已经纳入运行环境时，Agent 应优先使用该专用能力，而不是用通用工具重新实现同一类工作。类似地，面对媒体下载/解析问题时，应使用 yt-dlp，而不是让 Agent 自己用 curl/wget 拼下载逻辑。

## Decision

### 1. Graphify 是 repository structural analysis 的首选专用能力

当问题的主要目标是理解**结构关系**而不是寻找某段文本时，Agent **必须优先使用 Graphify**。

典型问题包括：

- “A 是怎么调用到 B 的？”
- “这个模块的上下游是什么？”
- “这个 table / dataset 在代码里从哪里产生、被谁使用？”
- “从 source A 到 target B 中间有哪些结构路径？”
- “哪些模块是这个系统的结构枢纽？”
- “这个 legacy application 可以分成哪些结构子系统？”
- “某个 SQL / table / service 与哪些代码对象存在关系？”
- “先帮我找出这个大型 repository 中值得深入看的关键节点。”

这些问题的共同特征是：**答案依赖对象之间的关系、路径、邻接或结构组织，而不是简单的文本匹配。**

对于大型 repository，第一次进入 Investigation 后，若 Graphify 可用，应先建立当前 working directory 的 structural graph：

```bash
graphify extract . --code-only --no-viz
```

已有 graph 需要更新时：

```bash
graphify update . --no-viz
```

随后通过 Graphify MCP 查询结构，而不是反复用 `grep` 模拟关系搜索。

### 2. 常规命令仍然是默认的 lexical / filesystem 工具

以下场景不需要 Graphify，直接使用常规命令：

| 问题 | 首选工具 | 原因 |
|---|---|---|
| 某个精确字符串在哪里 | `rg` / `grep` | 纯文本匹配 |
| 找所有名为 `application.yml` 的文件 | `find` / `rg --files` | 文件发现 |
| 查看一个确定文件 | `cat` / `sed` / `view` | 直接读取 |
| 查看目录结构 | `find` / `ls` / `rg --files` | 文件系统操作 |
| 查 TODO / FIXME | `rg` | lexical search |
| 查某个配置值 | `rg` | 精确文本检索 |
| 查看 Git 状态 / diff / history | `git` | Git 专用信息 |
| 批量处理文件 | shell / Python | 文件操作 |
| 验证一个命令或脚本输出 | shell | 直接执行 |
| 读取已知源码文件的局部内容 | `sed` / `view` | 无需建立关系图 |

不要为了使用 Graphify 而把简单的文本或文件操作复杂化。

### 3. 两者可以组合，但职责不能混淆

复杂 repository investigation 通常采用：

**Graphify 定位结构 → 常规命令读取原始内容 → 项目自己的 deterministic analysis 形成 Evidence。**

例如用户问：

> “Position 是怎么产生的？”

应先使用 Graphify 找到可能的生产链和关键节点，再使用 `rg` / `view` / SQL / metadata 等查看实际实现，最后才能形成正式 Evidence。

Graphify 的 structural observation 不能直接升级成 supported / verified business fact。

### 4. 不允许用常规命令替代已经明确匹配的 Graphify 能力

当问题明确属于 structural analysis，且 Graphify 已可用时，Agent 不应该仅仅因为 `grep` 更熟悉就用：

- 大量 `grep` 试图拼调用关系；
- 多轮 `find` + `grep` 猜测模块依赖；
- 人工扫描大量文件来寻找上下游；
- 自己从文本搜索结果拼接 structural graph。

常规命令可以作为 Graphify 的补充和验证手段，但不是 Graphify 的默认替代品。

### 5. Graphify 不可用时允许明确降级到常规工具

Graphify 不是所有环境都必须可用。

以下情况允许使用常规命令替代：

- Graphify capability 被明确关闭；
- Graphify runtime 未安装或无法启动；
- 当前文件类型不在 Graphify 的有效分析范围；
- repository 太小，建立 structural graph 的成本明显高于直接检查；
- 问题本身不是 structural analysis；
- Graphify 的结果不足以回答问题，此时应回到源码、SQL、metadata 等正式来源。

如果问题本身属于 structural analysis，但 Graphify 不可用，Agent 应明确知道这是**能力降级**，而不是把常规 grep 结果假装成 Graphify 等价能力。

### 6. 小型 repository 不强制为了结构问题建立完整 graph

Graphify 是专用工具，不意味着所有 repository 都必须先运行一次。

对于很小、关系非常直接的 repository，如果：

- 目标对象很少；
- 调用关系已经明确；
- 只需要读取一两个文件；
- 建图和查询的成本高于直接检查；

可以直接使用常规命令。

但对于大型 legacy repository、跨语言 repository、代码 + SQL + 配置混合 repository，Graphify 应作为默认 structural navigation 能力。

### 7. Graphify 是导航层，不是第二个事实系统

Graphify 只负责：

- structural graph；
- dependency / call / relationship navigation；
- candidate paths；
- structural communities；
- structural hubs。

正式业务事实仍必须回到本项目自己的：

- source provenance；
- DataEstate / canonical metadata；
- SQL lineage；
- profiling；
- targeted query；
- Semantic Context；
- 原始代码、SQL、配置和文档。

因此：

```text
Graphify
  → structural observation
  → investigation candidate
  → 原始代码 / SQL / metadata
  → deterministic analysis
  → Evidence
  → Claim / Finding
```

Graphify 与正式 Evidence 冲突时，以可复核的正式 Evidence 为准，并把冲突作为新的调查对象。

### 8. Runtime provenance 必须可追溯

Graphify 运行信息应进入 audit，包括：

- Graphify command；
- Graphify package version（能够读取时）；
- extraction mode；
- graph path；
- graph SHA-256；
- capturedAt。

这样可以知道一个 structural observation 是基于哪一次 graph snapshot 得到的。

## Selection Rule

Agent 可以使用下面的简单判断：

| 首要问题 | 使用 |
|---|---|
| “在哪里？”、“有没有这个字符串/文件？” | `rg` / `grep` / `find` |
| “这个文件是什么？” | `view` / `cat` / `sed` |
| “Git 改了什么？” | `git` |
| “A 和 B 怎么连接？” | **Graphify** |
| “A 的上下游是什么？” | **Graphify** |
| “A 到 B 的路径是什么？” | **Graphify** |
| “这个 repository 的结构枢纽是什么？” | **Graphify** |
| “哪些模块属于同一个结构子系统？” | **Graphify** |
| “Graphify 找到的关系到底是不是业务事实？” | **源码 / SQL / metadata / Evidence** |
| Graphify 不可用但又必须回答结构问题 | 常规命令降级，并保持“候选/待验证”语义 |

核心原则只有一句：

> **文本问题用通用工具，结构问题用 Graphify；结构问题需要事实结论时，再回到原始来源和 Evidence。**

## Consequences

### Positive

- Agent 不再把 `grep` 当成万能代码分析工具。
- 大型 legacy repository 的结构导航效率更高。
- Graphify、常规命令和项目 Evidence 各自有明确边界。
- 专用工具优先原则可以推广到其它 capability，例如 yt-dlp。
- Graphify 的结果不会污染 Evidence-first 的事实模型。

### Negative

- Graphify 增加一个本地 runtime dependency。
- 需要维护 graph snapshot 和 runtime provenance。
- Agent 必须理解“结构关系”和“业务事实”的区别。
- 小型 repository 使用 Graphify 可能没有收益，因此不能机械强制。

## Rejected alternatives

### A. 所有 repository 都强制使用 Graphify

拒绝。Graphify 是 structural analysis capability，不是所有文件操作的统一入口。简单文本搜索和文件操作使用 `rg` / `find` 更直接。

### B. 永远只使用 grep / find / view

拒绝。对于大型 repository 的调用关系、依赖关系、路径和结构聚类，这会迫使 Agent 用通用文本搜索重复实现结构分析，而且结果更容易遗漏。

### C. Graphify 直接成为 Evidence 来源

拒绝。Graphify 的结构关系不能自动证明业务语义、数据实际状态或 Source of Truth。

### D. Agent 每次都让用户选择 Graphify 还是 grep

拒绝。工具选择属于 Agent 的执行策略，不应该增加用户负担。根据本 ADR 的选择规则自动判断即可。

## Appendix A：形成决定时的分析记录（仅供参考）

当前项目实际上已经具备 Graphify integration：`src/adapters/graphify.ts` 提供 per-Investigation graph、MCP server、runtime metadata 和 graph hash；`skills/structural-analysis/SKILL.md` 也已经定义 Graphify capability；README 也将 Graphify 列为 structural-analysis capability。

问题不是“项目完全没有 Graphify”，而是原来的 ADR 只定义了“Graphify 不是真实事实来源”，没有定义**工具选择优先级**。因此 Agent 仍然可能在应该做 structural analysis 时直接使用 grep / find。

本 ADR 补充的核心决定不是再增加一套分析系统，而是明确已有能力的职责和选择规则：

- Graphify：结构导航；
- `rg` / `grep` / `find` / `view`：文本和文件操作；
- 项目 deterministic analysis + Evidence：可验证事实。

这种设计与“专用工具优先”的原则一致：当任务属于某个专用能力的职责范围，应优先使用该能力；只有任务超出其范围、能力不可用或成本明显不值得时，才使用通用工具。


## Superseded

本 ADR 已被 ADR-034 取代。项目已经移除 Graphify runtime、MCP、配置和相关 Agent 强制逻辑；当前结构分析统一使用本项目自己的 Code Structure Index。本文保留为历史设计记录，不再作为实现约束。
