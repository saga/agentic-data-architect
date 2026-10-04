---
name: research
description: 针对外部事实、第三方能力和版本行为进行有来源的调查，把可复核的结论沉淀成当前 Investigation 的临时 Research Artifact。
metadata:
  kind: capability
---

# Research

这个 Skill 用来查“外部世界到底是什么样”，不是替代业务决策。

## 什么时候使用

- 第三方 API / SDK 行为需要确认。
- 某个库是否支持某项能力需要验证。
- 版本、协议、标准或官方行为需要确认。
- 本地代码和内部资料解释不了问题。

## 研究原则

优先访问拥有事实的原始来源：

1. 官方文档
2. 官方 source code
3. 官方 API / schema
4. 标准、规范或正式 RFC
5. 第一方 release notes

社区文章、博客和搜索结果只能作为线索，不能在没有验证时直接当作关键事实。

## 输出

每次研究尽量形成一个短的 Markdown artifact：

`.workspace/<session>/artifacts/research/<slug>.md`

至少包含：

- Question
- Findings
- Sources
- What this means for this Investigation
- Open questions

每一个重要结论都应有来源链接或明确 source reference。

## 使用规则

- 先把问题缩小成能验证的事实。
- 不为了“研究得很深”而无限扩展范围。
- 找到直接支持结论的来源后停止继续搜索。
- 同一个结论被多个低质量页面重复，不代表证据更强。
- 如果官方来源和二手来源冲突，优先报告冲突并回到第一方来源。
- 研究结果是临时上下文，不自动成为业务真相。
- 研究不能替代用户做 Source-of-Truth、业务定义或架构决策。

## 与 Evidence 的关系

Research Artifact 记录外部资料；正式 Investigation Evidence 仍由项目已有 Evidence 机制管理。

回答时区分：

- 外部事实
- 项目内部 Evidence
- 模型推断
- 未确认事项

不要把“官方文档说明产品有这个能力”写成“当前项目已经验证可以这样用”。
