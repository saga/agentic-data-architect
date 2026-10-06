---
name: domain-modeling
description: 在数据架构和业务建模过程中持续统一业务术语，发现同名异义、同义异名和代码/业务描述冲突，并把确认后的定义与 Evidence 关联起来。
metadata:
  kind: capability
---

# Domain Modeling

这个 Skill 只解决一个问题：当业务词会影响数据模型、SQL、映射或架构决定时，把它说清楚。

## 什么时候使用

遇到以下情况自动使用：

- 同一个词在不同系统中可能不是同一个概念。
- 一个词在多个文件中承担不同职责。
- 业务人员、SQL、数据字典或 Semantic Context 对同一个词的定义冲突。
- 需要决定表名、字段名、实体名、指标名、状态值或时间语义。
- Mapping、Source-of-Truth 或 Target Architecture 因术语含义不清而无法继续。

## 工作方式

先查已有上下文和 Evidence，再检查代码、SQL、数据和 Semantic Context。

不要因为名字“看起来合理”就定义业务概念。

发现冲突时：

1. 明确当前看到的不同含义。
2. 给出最小、具体的澄清问题。
3. 一次只问一个最有价值的问题。
4. 用户确认后记录 canonical term、定义、避免使用的词和 supporting Evidence。
5. 如果代码与确认后的定义冲突，明确指出冲突，不要静默解释掉。

## 沉淀

确认后的业务词记录在当前 Investigation：

`.workspace/<session>/artifacts/domain/glossary.md`

格式保持很小：

- **Term**
- **Definition**
- **Avoid**
- **Evidence**
- **Status**

不要把实现细节、完整数据字典或聊天记录塞进 glossary。

## 边界

- glossary 是业务语言，不是 Application State。
- glossary 不是 Evidence；业务定义本身仍需要来源或用户确认。
- Skill 不自己决定 security、authorization、policy 或审批。
- 不为了“完整”而创建大量术语。
- 重要术语应该能回到代码、数据、用户确认或其他正式来源。

## 验收

这个 Skill 真正在工作时，应该能在错误概念快要进入模型之前停下来，例如：

> Position 和 Holding 在当前系统里是不是同一个业务概念？

而不是等模型完成以后再生成一份“术语表”。

## 输入校验

使用前必须有具体业务术语或会影响模型、SQL、映射、架构决定的概念冲突。普通查词不需要启动这个 Skill。

优先检查已有 Investigation Evidence、业务资料和用户已确认的定义；不能只凭名称猜含义。
## 输出

需要形成清晰的业务术语结论时，保存到当前 Investigation 的 artifacts/domain/glossary.md。

每个术语至少说明：这个词是什么意思、当前依据是什么、有没有冲突、是否已经确认。
## 输出与验证

- 未确认的定义必须明确标为未确认。
- 术语定义必须能回到资料依据或用户确认。
- 如果代码与确认后的业务定义冲突，必须保留冲突，不得静默改写。
- 不因为“看起来合理”就把候选定义升级成正式定义。
## Gate

当术语会影响正式结果时，只有“定义已确认或冲突已明确保留”才能作为后续建模依据。
## 期望结果示例

用户已经能看到：
> Position 在当前系统里指日终持仓，而 Holding 指研究页面上的展示对象，两者不是同一个概念。这个区别已经从数据表和页面代码中得到支持；业务定义仍需要负责人确认。

不要输出：
> Position = Holding，后续统一使用 Position。
