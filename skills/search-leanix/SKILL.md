
# Search LeanIX

用途：研究公司 Enterprise Architecture 中 SAP LeanIX 的 Fact Sheets、关系、生命周期、owner、应用依赖和其它已登记架构事实。

## 工具要求

优先、且默认使用 SAP LeanIX 官方 MCP Server。不要自己调用 REST API，也不要先用普通 Web Search 代替 LeanIX Fact Sheet 数据。

SAP LeanIX 官方 MCP Server 就是为 AI Agent 访问企业架构 inventory / Fact Sheets / relationships 设计的，并支持按用户权限访问数据。

运行时应从可用 MCP tools 中发现实际的 LeanIX MCP tool 名称和 schema；不要凭空猜工具名或参数。

如果当前会话没有 LeanIX 官方 MCP：
- 明确记录“LeanIX MCP 不可用”；
- 不要伪造 Fact Sheet 数据；
- 可以继续分析已有 workspace 中的 LeanIX 导出/文档，但必须把它标成非实时来源。

## 研究顺序

不要只搜索一个 Fact Sheet。通常按：

~~~text
Business / Application
  ↓
Fact Sheet
  ↓
relationships
  ↓
dependencies / supporting applications
  ↓
owner / lifecycle / tags / criticality
  ↓
相关 Architecture facts
~~~

对于一个具体系统，优先回答：

- 它是否存在于 LeanIX？
- Fact Sheet 的 canonical name / id 是什么？
- owner 是谁？
- lifecycle / status 是什么？
- 与哪些 application / IT component / business capability 有关系？
- dependency map 是什么？
- LeanIX 中的记录和代码/数据库发现是否一致？

## 事实优先级

LeanIX MCP 返回的结构化 Fact Sheet 数据属于重要 Evidence，但不是绝对真相。

当 LeanIX 与代码、运行数据、业务人员说法冲突时，不要自动选一方。记录：

semantic_conflict / possible_stale_documentation

并把各来源分别保存。

## 保存研究结果

原始 MCP 结果不要整段塞进聊天回答。保存必要内容到：

research/leanix/<序号>-<topic>.md

研究记录至少包含：

- 查询目标
- Fact Sheet id / name
- 页面或对象引用
- 查询时间
- 关键属性
- 关键关系
- 与当前 investigation 的关系
- 冲突 / unknown

然后在 context.json 追加：

~~~json
{
  "kind": "research",
  "source": "leanix",
  "artifactPath": "research/leanix/001-application-landscape.md",
  "important": true
}
~~~

## 禁止事项

- 不根据名字猜 Fact Sheet 属性。
- 不把 LeanIX “已登记”写成“系统实际运行如此”。
- 不把一个 application Fact Sheet 当成完整 data lineage。
- 不把过期 lifecycle/status 当成当前运行状态。



# Working Directory 约定

所有 Investigation 都有一个可持续的 workspace：

.data/investigations/<name>/workspace/

~~~text
workspace/
  context.json
  inputs/
  research/
    github/
    leanix/
    confluence/
    web/
  sources/
    github/
  findings/
  artifacts/
  notes/
~~~

## context.json

这是 workspace 的第一入口，不能删除，也不要用一次性的临时文件替代。

~~~json
{
  "schemaVersion": 1,
  "userPrompt": "最初用户要求",
  "importantInformation": [
    "已经确认的重要事实、约束、决定"
  ],
  "inputs": [
    {
      "id": "input-001",
      "kind": "research",
      "capturedAt": "2026-09-30T00:00:00Z",
      "title": "研究主题",
      "content": "本次输入、问题或研究 query",
      "source": "github",
      "uri": "https://github.com/...",
      "artifactPath": "research/github/001-xxx.md",
      "important": true
    }
  ],
  "updatedAt": "2026-09-30T00:00:00Z"
}
~~~

规则：

1. 用户最初 prompt 放在 userPrompt。
2. 每次新的用户问题、研究 query、外部事实输入、重要决策，都追加到 inputs，不要覆盖历史记录。
3. 长内容放到 research/、findings/、notes/ 等文件，context.json 用 artifactPath 指向它。
4. 只能把已经核实的重要事实放入 importantInformation；推测写进研究文件并标明状态。
5. 不要把密码、token、cookie、OAuth access token 等敏感凭据写进 workspace。
6. 研究记录要能复现：至少保存 query / source / uri / 时间 / commit 或 page id / 简短结果摘要。
