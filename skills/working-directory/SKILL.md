
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
