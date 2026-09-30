
# Search GitHub

用途：研究代码、仓库、Issue/PR、实现方式和历史行为。

## 第一步：让用户选择访问方式

除非用户已经明确指定方式，否则一开始只问一次：

> 请选择 GitHub 代码研究方式：
> 1. 直接使用 GitHub Tool：通过 GitHub URL / API 读取仓库，适合公司 GitHub Organization 和较小范围检查。
> 2. Clone 到当前 Investigation 的 workspace：把仓库拉到 workspace/sources/github/<owner>__<repo>/，再用本地 find / grep / rg / git 做深入分析，适合大仓库、跨文件搜索和需要反复检查的任务。

如果用户明确说“用 GitHub tool / 通过 GitHub URL”，直接选择 1。
如果用户明确说“clone / 本地 grep / 本地分析”，直接选择 2。

## 模式 1：直接 GitHub Tool

1. 先读取 repository metadata，确认仓库、默认分支、当前权限。
2. 再读取 tree / 目标文件 / code search 结果。
3. 深入分析时保存：
   research/github/<序号>-<topic>.md
4. 记录：
   - GitHub URL
   - repository
   - branch / commit SHA
   - 搜索 query
   - 查看过的文件
   - 重要发现
   - 未解决的问题
5. 不要只保存“结论”，要保留足够的路径和行号/函数名，让后续可以复查。
6. 如果用户要求修改代码，可以直接使用 GitHub Tool 修改用户指定的 branch；不要为了方便自动创建 branch。

## 模式 2：Clone 到 workspace

仓库必须进入：

workspace/sources/github/<owner>__<repo>/

不要 clone 到 Investigation 外面，也不要污染项目根目录。

建议流程：

~~~text
GitHub URL
  ↓
git clone
  ↓
find / rg / grep / git log
  ↓
分析
  ↓
research/github/<n>-*.md
~~~

分析结果必须引用具体文件路径、commit、函数或代码片段位置。

## 研究纪律

- GitHub repository 中看到的代码是“实现证据”，不是业务真相。
- README / architecture doc 是“文档证据”，不能自动覆盖代码事实。
- Issue/PR 是“讨论证据”，要标明其状态和时间。
- 公司内部 repo 可能包含访问控制、内部实现或敏感信息，不要把完整源码复制到 research 文档；只记录必要片段和路径。
- 同一个 repository 多次研究时，优先增量追加研究记录，不要覆盖以前的结果。

## 每次研究完成后

1. 写研究记录到 research/github/。
2. 在 context.json 追加一个 kind: "research" 的 input。
3. 如果发现影响后续架构决策的重要事实，追加到 importantInformation。



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
