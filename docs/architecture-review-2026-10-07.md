# 项目架构审查报告（2026-10-07 基线审查）

审查日期：2026-10-07　范围：`src/`、`web/src/`、`skills/`、`tests/`、`ADR/`
**这是 2026-10-07 早期审查的历史快照，不代表当前 `main`；文中代码行号、代码规模和测试数量均以当时基线为准。**
后续实现已针对其中部分问题进行了修复；当前 `main` 的规范以 ADR 和实际代码为准。

---

## 2026-10-07 后续修复状态

这份报告形成于本轮 runtime durability / Stop / CodeBuddy sandbox 修复之前，因此原文中的“严重问题”和“建议顺序”不能直接当作当前 `main` 的状态。

| 原问题 | 当前 main | 当前状态 |
|---|---|---|
| 1. 只读 SQL 校验返回被净化 SQL | 已解决 | `assertReadOnly` 只负责校验，查询执行使用原始 SQL。 |
| 2. `.workspace/copilot` 与 Investigation 冲突 | 已解决 | Copilot Runtime 数据位于 `DATA_DIR/copilot`。 |
| 3. workspace context lock 不可重入 | 已解决 | 当前 lock 使用 owner-aware `AsyncLocalStorage`。 |
| 4. Workflow Skill 名单漏掉 `current-data-architecture` | 已解决 | `WORKFLOW_SKILL_NAMES` 当前包含四条 Workflow。 |
| 5. 头像读取路径越界 | 已解决 | avatar endpoint 对解析后的路径执行 workspace boundary 检查。 |
| 6. Workflow 版本变化后旧 Agent Session 未失效 | 已解决 | 保存/重置 Workflow 时清理 Runtime-neutral 和 legacy session reference。 |
| 7. Control 初始化并发竞争 | 已解决 | Global / Task configuration initialization 使用独立 init lock。 |
| 8. 三 Runtime 逻辑重复、边界漂移 | 主要问题已解决 | Copilot→OpenCode、CodeBuddy→OpenCode/Copilot 的直接依赖已移除；共享 Agent input、用户输入桥和 Graphify 判定已下沉到独立模块。Runtime 仍保留必要的 provider-specific execution 差异。 |
| 9. 持久化路径静默吞错 | 主要路径已解决 | turn failure message、trajectory、运行记录、DuckDB shutdown 和可选 runtime diagnostics 已不再静默丢失；故意的 best-effort 缓存/兼容读取仍保留显式日志或正常降级。 |
| 10. quota error 识别过宽 | 已解决 | 当前只接受明确 quota / rate-limit / resource exhausted / 429 语义。 |
| 11. Skill DSL 禁止字段缺少机器校验 | 已解决 | parser/lint 现在拒绝未知 block、非法字段、重复字段、出口后的字段和未知 completeWhen；已有回归测试覆盖。 |
| 12. Workflow 阶段可被 Agent 口头推进 | 已解决 | 有 `completeWhen` 的节点仍由 deterministic evaluator 判断；没有 `completeWhen` 的 Agent task 必须先通过 Stage Gate 才允许 success transition。 |
| Server restart / SSE / Stop durability | 已解决 | ADR-030 已定义 turn draft、graceful shutdown、startup recovery、transport recovery 和显式 Stop。 |
| CodeBuddy Investigation 可修改宿主仓库 | 已解决 | ADR-031 已定义 built-in allowlist、二次 deny 和 workspace path boundary。 |
## 摘要

按当时 2026-10-07 基线来看，架构骨架是健康的：ADR 分层清晰，Mission/Scope/Stage/Report 四道 Gate 落到了服务端确定性条件，Evidence-first 的意图贯穿，Skill 的五章节 Contract 100% 齐备，15 个 `completeWhen` 全部命中代码常量。**当时共有 29 条 ADR；当前 main 已增加到 ADR-031。**

这份报告下面的严重问题、测试数量和代码行号全部属于当时基线。当前 main 的修复状态以本报告上面的表和 ADR 为准。

最要紧的一条（当时基线）：`validateLocalReadOnlySql` 把「校验用的净化副本」当成「校验后的 SQL」返回，导致所有带字符串条件的本地查询都会执行被挖空引号的语句，其中一类会**静默返回错误数据并写成 Evidence**。这直接反转了 ADR-002 的 Evidence-first 承诺。

第二条：`.workspace/copilot` 既是 Copilot SDK 的运行目录，又是一个合法的 Investigation 目录，两者路径重合。实测该目录已膨胀到 **214M / 2124 条 evidence**，且用户在 UI 上既建不了也删不了这个假 session。

第三条：`withWorkspaceContextLock` 不可重入，而 `runReport` 在锁内做最多两轮 LLM 往返。现在没死锁是靠调用顺序侥幸，一次重构就会让进程永久挂起。

---

## 严重问题（2026-10-07 基线，历史记录）

### 1. `validateLocalReadOnlySql` 返回被破坏的 SQL

`src/analytics/local-data.ts:454-483`

```ts
export function validateLocalReadOnlySql(sql: string): string {
  const sanitized = sql.replace(/--[^\n]*(?:\n|$)/g, ' ')
    .replace(/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ')   // 所有字符串字面量 → 空格
    .trim();
  // ...各种校验都基于 sanitized...
  return trimmed;                        // ← 返回 sanitized，不是 sql
}
```

**意图是对的**（先 strip 掉注释和字面量，避免关键字误判），**返回值用错了对象**。四个下游全部执行被挖空的 SQL：

| 调用点 | 用途 |
|---|---|
| `local-data.ts:1043` | `query` |
| `local-data.ts:873` | `explain` |
| `local-data.ts:908` | `transform`（`CREATE TABLE ... AS <safeSql>`） |
| `local-data.ts:982` | `exportParquet`（`COPY (<safeSql>) TO ...`） |

实测输出（`./node_modules/.bin/tsx /tmp/probe/c1.mts`）：

```
[无字面量]   "select count(*) from raw.ds_demo"
        →   "select count(*) from raw.ds_demo"                ✓

[WHERE 字符串] "SELECT a FROM raw.t WHERE name = 'Alice'"
        →   "SELECT a FROM raw.t WHERE name ="                ✗ 语法错误

[块注释]     "SELECT 1 /* delete from x */ FROM raw.t"
        →   "SELECT 1 /  FROM raw.t"                          ✗ 残留单斜杠

[字面量藏关键字] "SELECT 'drop table t' AS x FROM raw.ds_demo"
        →   "SELECT   AS x FROM raw.ds_demo"                   ✗ 静默语义改变
```

**最危险的是静默错误**：当被挖空的片段恰好构成合法语法时，查询会成功返回**别的列的数据**，然后经 `local-data.ts:1094-1114` 的 `appendInvestigationEvidence` 落盘成为可引用 Evidence。之后的报告推理会把它当成"从用户数据里查出来的事实"。这是 ADR-002 明令禁止的事。

**测试为什么没抓到**（`tests/local-data.test.ts:18-35`）：

```ts
assert.equal(
  validateLocalReadOnlySql('select count(*) from raw.ds_demo'),
  'select count(*) from raw.ds_demo',   // 不含引号，"原样返回"恰好成立
);
```

四个用例全部不含字符串字面量，测试名关注的是"拒绝危险 SQL"，完全没覆盖"正确放行并保持语义"。

**修法**：改成纯谓词（返回 `void` 或布尔），调用方继续用原始 `sql`。若要保留去尾分号，只对 `sql` 做 `.replace(/;\s*$/,'')`，绝不返回 `sanitized`。**修之前先补一条带引号的往返测试**，否则改完仍然没有回归保护。

---

### 2. `.workspace/copilot` 既是 SDK 运行目录，又是合法 Investigation

两个路径定义撞在一起：

```ts
// src/agent/copilot.ts:56
const copilotBaseDirectory = path.join(config.workspaceDir, 'copilot');

// src/investigation/workspace.ts:32
export function workspaceRoot(name: string): string {
  return path.join(config.workspaceDir, safeName(name));
}
```

`listSessions`（`src/server.ts:215`）只排除 `shared`：

```ts
if (!entry.isDirectory() || entry.name === 'shared') continue;
```

**实测后果**（`.workspace/copilot/`）：

| 路径 | 体积 | 性质 |
|---|---|---|
| `artifacts/` | **177M** | 真实调查产物 |
| `graphify-out/` | 29M | Discovery 扫描生成 |
| `session-state/` | 2.7M | SDK 自己的 |
| `context.json` | 1.9M | **2124 条 evidence 的真实 context** |
| `logs/`、`installed-plugins/` | 236K | SDK 自己的 |
| **合计** | **214M** | 对照正常 session「研究IBM的sample项目数据架构」仅 **124K** |

`context.json` 里 `name = "copilot"`，`mission.purpose = "弄清一个IBM java老系统的数据架构"` —— 这是一份正在使用的真实调查，被 SDK 的运行目录污染了。

**连带问题**：

- `investigationExists('copilot')` 恒为 true → 用户**建不了**名叫 copilot 的调查，也**删不掉**这个假 session（`server.ts:246-248` 会直接返回已有 context）。
- SDK 的 `logs/`、`session-state/` 被 Discovery 全量扫描当成源码证据，混进 Evidence。
- `local-data.ts:358` 的 discover skip 列表里已经硬编码了 `'copilot'` —— 说明问题被感知过，但只在数据层绕过，没在布局层解决。

**修法**：SDK `baseDirectory` 移到 `config.dataDir` 下（那里本来就是运行时数据）；`listSessions` 改白名单过滤（只认含 `context.json` 且 `context.name === 目录名` 的目录）。迁移时注意别丢那 2124 条 evidence。

---

### 3. `withWorkspaceContextLock` 不可重入，且锁内做 LLM

`src/investigation/workspace.ts:89-106`

```ts
export async function withWorkspaceContextLock<T>(name, operation) {
  const previous = contextWriteLocks.get(name) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(() => gate);
  contextWriteLocks.set(name, queued);
  await previous.catch(() => undefined);   // ← 无 owner 标记，嵌套时等自己
  try { return await operation(); } finally { release(); ... }
}
```

没有任何 owner / reentrancy 标记。嵌套调用时，内层的 `previous` 就是外层尚未 `release()` 的 `queued`，`await previous` 永远不 resolve —— 经典自死锁。同样模式在 `withSharedIndexWriteLock`（`workspace.ts:55`）和 `withControlUpdateLock`（`control.ts:39`）各复制一份，三把锁都不可重入。

**锁内 LLM**（`src/workflow/report.ts:153`）：

```
runReport()  → withWorkspaceContextLock(name, async () => {
  :193  await reviewArtifact({...})
          → src/analysis/reviewer.ts:184 askAgentWithFallback()   ← 真实 LLM 往返
          → src/analysis/reviewer.ts:187 失败时再跑一轮（非结构化）
```

Reviewer 最多两轮 LLM，锁被持有数分钟。期间所有 `appendContextInput`、`saveInvestigation`、`appendInvestigationEvidence`、`getJourneySnapshot` 全部排队 —— 用户在 UI 上点"保存工作地图"会一直转圈。

**为什么现在没死锁**：靠调用顺序侥幸。`assessment.ts:112` 和 `modernization.ts:373` 都在 `journey-editor.ts:968` 取锁**之前**完成。任何人把这两处挪进 968 的回调，或让 `applyAgentWorkflowTransition` 本身被包进锁，进程立刻永久挂起。

**修法**：给锁加 owner token（`AsyncLocalStorage` 或显式 held 集合）支持重入；同时把 LLM 调用移出锁区间 —— 锁只该保护"读快照 → 计算 → 原子写"这一小段。

---

## 中等（8 条）

### 4. `WORKFLOW_SKILL_NAMES` 漏了一个 workflow

`src/agent/copilot.ts:35` 硬编码了 3 个：

```ts
const WORKFLOW_SKILL_NAMES = ['legacy-modernization', 'financial-ai-native-architecture', 'data-architecture-assessment'];
```

而 `src/api/contracts.ts:25-30` 的 `WorkflowIdSchema` 是完整 4 个（多 `current-data-architecture`），`skills/` 下也确实有 4 个 `kind: workflow`。

这个数组用于 `copilot.ts:550` 和 `:758` 的 `disabledSkills`——本意是"只禁掉用户没选的那几条，避免两条路线混跑"（`:757` 自己的注释就是这么写的）。漏了一个的后果是：用户选了 `legacy-modernization` 之后，`current-data-architecture` 仍可被 Copilot 自动加载，**两条工作路线同时跑**。直接违反 AGENTS.md 第 47 行。

`src/cli.ts:30-31` 同样漏，且默认值硬编码 `legacy-modernization`，与 README「新建工作默认采用自主调查」矛盾。

### 5. 头像读取存在路径穿越

`src/server.ts:1130-1162`。`control.agent.avatarPaths` 的 schema 是 `z.array(z.string().trim().min(1))`（`src/investigation/schemas.ts:248`），**只有 min(1)，没有路径格式约束**。经 `PUT /api/sessions/:name/config` 写入后直接使用：

```ts
const relativePath = avatarPaths.find((item) => path.basename(item, path.extname(item)) === avatarId);
const buffer = await fs.readFile(path.join(workspaceRoot(name), relativePath));   // ← 无 containment 校验
```

**同项目其他所有文件读取路径都有防护**，只有这条漏了：
- `local-data.ts:238-267` `absoluteDatasetPath()` —— realpath + `startsWith(root + sep)` 双重检查
- `local-data-tools.ts:44-49` —— `resolve` + `startsWith(rootWithSep)`
- `server.ts:181-187` `sessionKey()` —— 拒绝 `basename !== name`

请求参数的 `/^[0-9a-f-]+$/i` 只过滤 URL 段，过滤不了存储的路径。写 `avatarPaths: ["../../../../etc/passwd"]` 就能读 workspace 外任意文件。

**修法**：zod 层约束必须匹配 `^assistant/avatars/[0-9a-f-]+\.(png|jpg|webp|gif|mp4|webm|mov)$`，并在 `readFile` 前加 containment 校验。

### 6. 改工作地图后旧 session 不会被失效

`src/workflow/journey-editor.ts:583-593`（`saveJourneyDefinition`）和 `:627-637`（`resetJourneyCustomization`）：

```ts
const current = await loadWorkspaceContext(name);
const nextContext = { ...current };
delete nextContext.copilotSessionId;              // 只删 legacy 字段
delete nextContext.copilotConfigurationVersion;
await writeJsonAtomic(path.join(workspaceRoot(name), 'context.json'), {  // ← 绕过 contextFile() 和 Schema.parse
  ...nextContext, updatedAt: new Date().toISOString(),
});
```

**三个问题**：

**a)** `agentSessionId` / `agentSessionRuntime` / `agentConfigurationVersion` 没被删。对照 `store.ts:206-210` 的正确做法（`updateInvestigationWorkflow` 五个全删）。

**b)** 后果很实际：`ask.ts:484-489` 的 session 复用条件是 `inv.agentConfigurationVersion === control.version && inv.agentSessionRuntime === control.agent.runtime && inv.agentSessionId`。改工作地图**不改 config version**，所以条件仍命中 —— Agent 带着**旧 Workflow 上下文**的 session 继续跑。

**c)** `:582` 的注释写的是"Workflow 版本变化后，普通调查 Copilot Session 不能继续携带旧 Workflow 上下文"。**注释的意图和代码行为相反。**

另外这两处绕过了 `store.ts` 写入口、绕过 `WorkspaceContextSchema.parse`、绕过权威的 `contextFile()`（路径在项目里被独立拼了 3 份）。

### 7. `loadInvestigationControl` 初始化写入没进锁

`src/investigation/control.ts:238-275`。`:237` 的注释明确写着「**并用初始化锁避免并发重复创建**」—— 函数体里**根本没有锁**。`writeJsonAtomic(controlFile(name), task)`（`:266`）是无锁读改写。

竞态：两个并发请求（`POST /api/sessions` 在 `server.ts:255` 调它，`GET /config` 也调）都读到 ENOENT，都写 v1。若其中一个是 `updateInvestigationControl`（有 `withControlUpdateLock`），它写完 v1+1 可能被另一个无锁的 `loadInvestigationControl` 用 v1 **覆盖回去** —— 版本倒退，MCP / systemPrompt / model 的更新静默丢失，`history` 数组被截断。

`loadGlobalConfiguration`（`:150`）首次初始化同样无锁。同一模式在 `ensureSharedIndex`（`workspace.ts:180`）里做对了 —— 专门用 `withSharedIndexWriteLock` 包住。**注释承诺了但代码没实现，是最容易被当成"已处理"的一类坑。**

### 8. 三种 Agent runtime 的续跑循环重复约 70%，行为已经漂移

`runtime.ts` 只收敛了模型解析与 fallback 顺序（`:14-103`），最复杂的部分被完整复制三份：

| 逻辑 | copilot | opencode | codebuddy | 差异 |
|---|---|---|---|---|
| 续跑循环 | `:1399-1602` | `:932-1067` | `:528-644` | — |
| `autoContinuationTurns` 默认 | **2** | 0 | 0 | 不一致 |
| Graphify 前置检查 | deny + 引导 | 抛错 | 抛错 | 行为不同 |
| `shouldContinueMission` 缺失时 | 默认 `true`（更激进） | `stageGate.passed !== false` | 同 opencode | copilot 会继续推进 |
| usage/费用 diff | `:403-443` | 手写不等价版 | 手写不等价版 | 三份 |

`runtime.ts:131-150` 的 `executeRuntime` 只做 `adaptInput` + 三行 switch —— **是薄包装的直接证据**。

**逻辑泄漏 7 处**，其中三处值得单独点名：
- `copilot.ts:488-522` —— `askCopilot` **内部反向调用 `askOpenCode`**，形成 `runtime.ts → copilot.ts → opencode.ts` 的反向依赖
- `codebuddy.ts:20` —— CodeBuddy 从 opencode 导入 `requiresGraphifyFirst`，Graphify 能力判定实际以 opencode 为准
- `codebuddy.ts:234` —— CodeBuddy 用 copilot 模块的 `requestAgentUserInput`，即 CodeBuddy 的用户输入状态存在 copilot 的 Map 里

**权限模型未统一**：copilot 有完整 pending 状态 + 前端确认 UI（`copilot.ts:1080-1185`）；codebuddy 用 `canUseTool` 直接 allow/deny，**没有 pending、前端无从确认**；opencode 完全没有权限层。ADR-029 §7 点名要求三 runtime 共享失败语义，实际只有 copilot 实现了。

### 9. 静默吞错集中在持久化路径

```ts
// src/workflow/ask.ts:195-201  —— 轨迹的唯一写入通道，15+ 处调用
.catch(() => undefined);   // 磁盘满 / 权限 / schema 失败全部不可观测
```

ADR-020 §7 明确要求「malformed durable data 不得静默当成 missing；必须可观察」。读取侧 `trajectory.ts:96-102` 做对了（schema 失败抛「Trajectory 数据损坏」），**写入侧没有对称保护**。

同类：`ask.ts:503` 的 session 持久化链同样静默 —— 落盘失败 → 下一轮无法 resume → 静默丢上下文。`server.ts:227` 的裸 `catch {}` 让损坏的 session 目录永久静默（用户看到的是"这个 session 不存在"，不知道自己的数据坏了）。`server.ts:994-996` CSV 注册失败静默降级为普通文档，Agent 后续看不到这个数据集且用户不知原因。

### 10. `isQuotaError` 正则过宽，业务错误会被当成配额耗尽

`src/agent/runtime.ts:21-24` 三个无锚点的宽松模式：

```ts
/quota|usage\s*limit|rate\s*limit|resource\s*exhausted|credits?\s*(?:exhausted|depleted)|limit\s*(?:reached|exceeded)|HTTP\s*429/i
```

会匹配 `"row limit exceeded"`、`"memory usage limit"`、`"上下文 limit exceeded"` —— 都是 400 级的真实业务错误。ADR-028 §2 要求「正常工具错误、Mission Gate 错误、业务逻辑错误不能被另一种 Runtime 静默覆盖」，但 `runtime.ts:195` 会判定为配额问题 → 切换 runtime 重跑 → 用户看到的是"自动切换中"而不是真实错误。**保护意图落空。**

### 11. `flow:lint` 对 AGENTS.md 明令禁止的字段零校验

AGENTS.md 第 95 行写着「不再增加 `@gate`、`@stop`、`completion`、`visible`、`tools`、`requires/produces` 或 route condition」，第 97 行写着「不能只靠模型记住约定」。**但 lint 恰好拦不住这些**：

- `parseSkillManifest`（`src/skills/catalog.ts:56-118`）是**手写行解析器**，只正则提取 name / description / metadata.kind 三项，其余行直接丢弃。`SkillMetadataSchema` 上的 `.strict()`（`:23-25`）无从触发 —— 字段根本没进 Zod 对象
- `journey.ts:162` 的 headingPattern 只认 `flow|task|review|end`，`@gate` / `@stop` 被静默忽略（不当节点也不报错）
- `journey.ts:209-213` 无条件写入 `current.attrs`，节点里写 `gate:` / `tools:` / `requires:` 全部吸收然后消失

**现存 15 个 SKILL.md 是干净的**（frontmatter 零禁用字段、零 `@gate`/`@stop`、节点四属性之外零自定义属性），四章节 Contract 100% 齐备。**风险在于没有机器约束** —— 下一个人加一个 `tools:` 字段，lint 全绿。

### 12. 一条 workflow 的阶段可被 Agent 口头推进

`skills/financial-ai-native-architecture/SKILL.md` 10 个节点里**只有 intake 有 `completeWhen`**（`:39`），其余 9 个全没有。而 `journey-editor.ts:917-928` 的确定性校验只对声明了 `completeWhen` 的节点生效 → `outcome === 'success'` 时跳过检查，**Agent 声明成功即可推进**。

该 Skill 自己写的话（`:525-526`）：「每一阶段只能在对应真实成果形成后推进……不能只因为 Agent 说完成了就通过」—— **这句话没有任何代码支撑**。同时 `report-gate.ts:119,129` 的 workflow 专属报告 gate 也只覆盖另外两条路线。

直接违反 AGENTS.md 第 34 行和第 97 行。

---

## 轻微（12 条，摘要）

| 问题 | 位置 |
|---|---|
| **死代码约 246 行**：`journey-map-types.ts` 6 个零引用导出；`journey-map-layout.ts` 的 `layoutWithElk` / `enforceWorkflowReadingOrder` / `workflowLayoutEngine` / `WORKFLOW_LAYOUT_ENGINE`（ELK 已随 `c7782dc` 移除，这 3 个是零引用兼容包装，注释还写着"保留旧函数名"）；`styles.css` 约 212 行无 DOM 对应选择器；`node_modules/@xyflow/`（空目录，lockfile 0 条残留） | 见左 |
| 边 kind→颜色映射写了两遍，4 个色值完全重复 | `JourneyX6Graph.tsx:307-328` 与 `:693-714` |
| 读 `data.completion` / `data.visible`，但 `FlowNodeData` 无此字段，恒 `undefined` | `JourneyX6Graph.tsx:661,663` |
| DuckDB `engines` Map 无上限回收，每 session 一个常驻 native 连接，长期运行内存泄漏（registry db 是单例，这半边是对的） | `local-data.ts:113,485-497` |
| macOS 大小写不敏感：`safeName` 不归一化，`Foo` 与 `foo` 共享 context.json 但 SQLite 用 BINARY 比较分两套记录，锁 key 也不同 → 真正 lost-update | `workspace.ts:24` |
| shutdown 顺序反了：`stopClient()` 排最后，`server.close()` 不等待在途请求，DuckDB 断连是 fire-and-forget | `server-main.ts:90-96`、`local-data.ts:1197` |
| `sessionKey` 抛裸 Error → 中间件兜底成 **500** 而非 400（26 个路由调用），且 `error.message` 原样回显客户端 | `server.ts:181-187`、`:1611` |
| user message 在 SSE 路径双写（`server.ts:1448` 与 `ask.ts:209`），两处内容计算方式不同；非流式路由没这次预写，行为不一致 | `server.ts:1427-1453` |
| `artifacts/analysis/turn-*.md` 文件名模式与实现不符（实际 `0001-<turnId>.md`） | `investigation-session/SKILL.md:73` vs `analysis-artifact.ts:29` |
| `graphify` 命令未说明需项目 venv（只在 `.venv/bin/graphify`），Agent 照抄会失败 | `structural-analysis/SKILL.md:31,43` |
| `getJourneySnapshot` 前半段是无锁读，与 `saveJourneyDefinition` 的 5 文件非原子写形成窗口，可致执行进度被静默重置 | `journey-editor.ts:430-455`、`:566-587` |
| `JourneyMap.tsx:155` `onClick={props.onBack}` 未判空，而同文件 `:143` 做了保护 | `JourneyMap.tsx:155` |

---

## 测试覆盖的结构性缺口

| 模块 | 代码行数 | 直接测试 |
|---|---|---|
| `src/agent/copilot.ts` | 1791 | **无** |
| `src/server.ts` | 1616 | 1 个（60 行） |
| `src/workflow/ask.ts`（`answerQuestion` 937 行） | 1021 | **无** |
| `src/media/remote-media.ts` | 298 | **无** |
| `src/agent/copilot-permission-bridge.ts` | 36 | **无** |
| `src/analytics/local-data.ts` | 1203 | 有，但漏掉致命路径（见问题 1） |
| `src/workflow/journey-editor.ts` | 1221 | 197 行 |

`tests/architecture-invariants.test.ts` 是个有意思的做法 —— 用源码正则断言架构边界（比如 `assert.doesNotMatch(server, /sharedDir\s*,\s*['"]assistant['"]/)`）。这个思路值得扩展到当前缺失的边界上，但它是**文本匹配**，保护不了上面任何一条严重问题。

---

## 当时建议处理顺序（历史）

| 序 | 事项 | 理由 |
|---|---|---|
| 1 | **问题 1（SQL 校验）** + 先补带引号的往返测试 | 唯一会静默产出错误 Evidence 的问题，污染下游全部推理；改一行返回值，但没测试保护会复发 |
| 2 | **问题 2（copilot 目录冲突）** | 214M 脏数据 + 用户无法删假 session；迁移时注意别丢 2124 条 evidence |
| 3 | **问题 3（锁）** | 唯一会导致进程永久挂起的问题；加 owner token + 移出 LLM 是结构性改动，越早做越便宜 |
| 4 | **问题 6 + 7（session 失效 + 初始化锁）** | 都是"注释承诺了但代码没实现"，改动小、风险低、收益明确 |
| 5 | **问题 4（workflow 名单）** | 一行修复，但违反的是 AGENTS.md 明文写出的核心约束 |
| 6 | **问题 5（头像穿越）** | 与项目内其他所有路径读取对齐 |
| 7 | **问题 8-12** | 按实际使用频率排期 |

---

## 一句话结论

架构文档和设计意图是这份资产里最扎实的部分，ADR 分层、Gate 落点、Skill Contract 完整度都高于同类项目水平。真正的风险不在设计，而在**设计意图没有下沉成类型约束和机器校验** —— 按当时基线，182 个测试全绿、29 条 ADR 大部分条款正确，但三条严重问题全部落在"靠调用点自觉"的缝隙里，且一条都没被现有测试捕获。

把 ADR-027 的写入口收敛（消灭 `journey-editor.ts:587` 的直接 `writeJsonAtomic`）、把 ADR-013 §4 的 runtime capability 约束从约定提升到类型、把 AGENTS.md 第 95 行的 DSL 禁令从文档变成 lint 规则 —— 这三件事的收益高于任何单点 bug 修复。

---

*复核方式：`./node_modules/.bin/tsx /tmp/probe/c1.mts` 直接调 `validateLocalReadOnlySql` 打印输入/输出对比。`git status` 干净。*
