---
name: search-github
description: 研究 GitHub repository、源代码、Issue、Pull Request、实现细节和历史行为，用于补充当前 Investigation 的实现证据。
metadata:
  kind: capability
---

# Search GitHub

用途：研究代码、仓库、Issue/PR、实现方式和历史行为。

## 访问方式

除非用户已经指定，否则开始研究时只问一次：

1. 直接使用 GitHub Tool，通过 repository URL/API 读取。
2. Clone 到当前 session 的 `.workspace/<session-name>/artifacts/github/<owner>__<repo>/`，再用本地 `rg` / `find` / `git` 深入检查。

大仓库、跨文件搜索、需要反复检查时优先本地 clone；小范围检查优先 GitHub Tool。

## 保存研究结果

研究结论和可复用资料保存到：

`.workspace/shared/github/<序号>-<topic>.md`

至少记录：
- GitHub URL
- repository
- branch / commit SHA
- 搜索 query
- 查看过的文件
- 重要发现
- 未解决问题

在当前 session 的 `context.json` 追加 `kind: research`，`artifactPath` 指向 shared 文件。

## 纪律

- GitHub 代码是实现证据，不是业务真相。
- README / architecture doc 是文档证据。
- Issue / PR 是讨论证据，要记录状态和时间。
- 不把完整内部源码复制到 shared 文档；保留路径、函数、行号或最小必要片段。
- 同一 repository 再次研究时优先增量更新已有 shared artifact。
- 用户明确要求修改哪个 branch 时直接修改指定 branch，不自动创建 branch。