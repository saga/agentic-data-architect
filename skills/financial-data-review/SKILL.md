---
name: financial-data-review
description: Financial-services data investigation and review for investment management, portfolio, security master, price, research, lineage, identifiers, and point-in-time semantics. Use when a question involves Position, Security, Price, Portfolio, Transaction, Performance, Research, or financial data provenance.
---

# Financial Data Review

这是金融领域的业务知识层，不是平台安全边界。使用它来决定“应该检查什么、应该问什么”，不要把它当成事实来源。

## 什么时候使用

当用户的问题涉及以下领域时使用：
- Position / IBOR / holdings
- Security / Security Master / identifiers
- Price / valuation / FX / corporate action
- Portfolio / transaction / trade / performance
- Investment research / fundamental / estimate
- historical / as-of / point-in-time / restatement

## 工作方式

先看确定性发现结果，再解释业务含义。

需要金融领域检查时，先运行本 skill 的脚本：

~~~bash
PROJECT_ROOT="$(git rev-parse --show-toplevel)" && node "$PROJECT_ROOT/skills/financial-data-review/scripts/review.mjs" <session-name>
~~~

脚本会读取当前 investigation 的 context.json 和最新 discovery snapshot，生成：

~~~text
.workspace/<session-name>/artifacts/financial-data-review.json
~~~

这个文件是 deterministic review artifact，不是业务真相。输出中的 evidenceIds 可以继续引用，但必须回到原始 Evidence 判断结论。

## 重点检查

### Position
至少确认 authoritative source、position state、as-of semantics、security identifier、corporate action、FX。

### Security
至少确认 canonical security identifier、identifier mapping、security lifecycle。

### Price / Valuation
至少确认 source precedence / fallback、raw vs adjusted price、valuation date、currency、timezone、corporate-action adjustment。

### Research
至少确认 publication time、knowledge time、restatement、point-in-time reproducibility。

## 对话规则

- 缺少关键业务定义时，不要自行补全。
- 一次只提出一个最有价值的澄清问题。
- “可能是 Position source”与“已经证明是 Position source”必须分开。
- Skill 中的业务知识不是 Evidence。
- 确定性脚本发现与用户确认的事实优先于模型常识。
- 如果多个系统都像 source of truth，不要自行选一个；列出候选和证据，并要求确认或继续发现。

## 输出

回答时把内容分成：已确认的事实、基于 Evidence 的推断、未知 / 冲突、下一步最有价值的问题或确定性检查。

不要为了完整而编造金融业务规则。