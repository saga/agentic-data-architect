# ADR-019：Derived State 必须共享同一套确定性语义

- Status: Accepted
- Date: 2026-10-06

## Context

Mission Progress、Journey Facts、Workflow completion 和 Result summary 都需要判断 Target Architecture、Mapping、Validation 等工作成果是否形成，但历史上存在各自实现，导致同一状态可能被一个页面认为 covered、另一个页面认为 incomplete。

## Decision

1. 业务事实语义只定义一次，归属于 deterministic evaluator / signal builder。
2. Mission Progress、Journey Facts、Workflow completion 和 UI summary 必须消费同一 evaluator。
3. covered 必须有明确规则，不能由 UI 自行用数量推断。
4. draft、proposed、ready、passed 等状态保持原语义，不允许消费者隐式升级。
5. 同一个 evaluator 必须用于 write-time gate 与 read-time derived state；不能在 artifact 生成时和结果读取时各写一套 completion 规则。
6. evaluator 输出的 signal 必须是命名且可测试的 domain facts；消费者可以组合这些 signal，但不能根据 array length、status 字符串或 UI loading state 再推导新的 completion semantics。
7. 新 Workflow 所需事实必须先扩展 evaluator，再扩展 completion condition。
8. 如果某个 Workflow 对同一工作成果需要多个语义层次（例如存在 / 已验证 / 已批准），必须在 evaluator 中以不同的命名 signal 明确区分，而不是让消费者通过 status + count 自己推断。

### Canonical evaluator rule

当前实现的唯一 evaluator 为 `src/workflow/derived-state.ts`。它是纯函数，只接收已经持久化的 Investigation facts（包括 work-product status），输出命名的 derived signals；Mission Progress、Journey completion、Report Gate 和 Workflow facts 不再各自解释同一事实。`journey.ts` / `mission-progress.ts` 不得再拥有 `deriveModernizationFacts`、`flowReady = ...` 之类第二套完成语义。



对一个业务成果 X，系统应形成：

```text
Canonical source facts
        ↓
Deterministic evaluator
        ↓
Named derived signals
   ├── Mission Progress
   ├── Journey / Workflow completion
   ├── Result summary
   └── Gate input
```

消费者只能组合这些命名 signals，不得重新定义 X 的完成语义。

## Consequences

- 页面和状态机不会对同一成果给出相互矛盾的完成判断。
- Workflow DSL 保持业务规则无关。

## Related ADRs

ADR-001、ADR-011、ADR-014、ADR-018。