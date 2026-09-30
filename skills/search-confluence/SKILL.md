
# Search Confluence

用途：研究公司内部设计文档、业务说明、运行手册、项目记录、ADR、流程说明和其它 Confluence 知识。

## 工具要求

优先、且默认使用 Atlassian 官方 Rovo MCP Server。

Atlassian 官方 MCP 已支持 Confluence，并使用用户已有的 Atlassian 权限访问内容。

运行时从可用 MCP tools 中发现真实的 Atlassian/Confluence MCP tool 名称和 schema；不要猜工具名称和参数。

如果当前会话没有 Atlassian 官方 MCP：
- 明确记录“Confluence MCP 不可用”；
- 不要通过普通 Web Search 猜测私有页面内容；
- 可以继续分析用户已经导出的 Confluence 文档，但标明来源不是实时 Confluence。

## 研究顺序

对于一个业务问题：

~~~text
Search
  ↓
候选 Page
  ↓
确认 space / page id / title / 更新时间
  ↓
读取完整页面
  ↓
寻找 related pages / ADR / runbook
  ↓
提取事实、定义、决策、约束
~~~

优先寻找：

- Architecture Decision Record
- Current-State / Target-State architecture
- Process / Operating Model
- Data Dictionary
- Runbook / SOP
- Project decision / meeting record
- Governance / compliance documentation

## 不要把 Confluence 当成绝对真相

Confluence 是非常重要的 documentation evidence，但老项目里经常存在：

~~~text
文档说 A
代码实际是 B
运行数据表现 C
业务人员说 D
~~~

遇到冲突必须分别记录，不要为了生成一张“漂亮的架构图”而强行统一。

特别关注：

- 文档更新时间
- owner
- 是否明确标记为 superseded / obsolete
- 页面引用的系统版本
- 页面引用的 Jira issue / decision
- 页面是否描述 current state 还是 target state

## 保存研究结果

研究记录保存到：

research/confluence/<序号>-<topic>.md

至少记录：

- query
- space
- page id
- title
- URL
- last updated time
- 关键事实
- 重要引用位置
- 与当前代码/数据的冲突
- 未解决问题

并在 context.json 追加一个 research input，指向对应 artifact。

## 写操作

这个 skill 默认是 research/read-only。

即使 Atlassian MCP 支持写操作，也不能因为研究任务而修改 Confluence。只有用户明确要求更新 Confluence，并且当前任务明确允许写操作时才可以执行。



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
