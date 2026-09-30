import { assertReadOnly, type DatabaseAdapter } from '../adapters/database.js';
import { nextId, type EvidenceRef } from '../evidence/types.js';

/**
 * Targeted Query（§十四）：Agent 先产 query plan → 确定性校验 → 只读执行 → 证据。
 * 不是让 LLM 直连数据库。
 */

export interface QueryPlan {
  reason: string;
  dataset: string;
  sql: string;
  expectedEvidence: string[];
}

/** 校验：只读 + 单条 + 必须提到目标 dataset。 */
export function validateQueryPlan(plan: QueryPlan): void {
  assertReadOnly(plan.sql);
  const table = (plan.dataset.split('.').pop() ?? '').replace(/^"|"$/g, '');
  if (!table || !new RegExp('(?<![A-Za-z0-9_$])' + table.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\  if (!plan.sql.toLowerCase().includes(plan.dataset.toLowerCase().split('.').pop() as string)) {') + '(?![A-Za-z0-9_$])', 'i').test(plan.sql)) {
    throw new Error(`查询没有引用目标表 ${plan.dataset}，拒绝执行：${plan.sql.slice(0, 120)}`);
  }
}

export async function runQueryPlan(
  adapter: DatabaseAdapter,
  plan: QueryPlan,
  ctx: { investigationId: string; discoveryRunId: string },
): Promise<EvidenceRef> {
  validateQueryPlan(plan);
  const result = await adapter.query(plan.sql);
  return {
    id: nextId('ev'),
    type: 'query_result',
    investigationId: ctx.investigationId,
    discoveryRunId: ctx.discoveryRunId,
    source: `${adapter.type}:${plan.dataset} query rows=${result.rowCount}${result.truncated ? ' (truncated)' : ''} — ${plan.reason}`,
    dataset: plan.dataset,
    statement: plan.sql,
    value: { columns: result.columns, rows: result.rows.slice(0, 20), rowCount: result.rowCount },
    collectedAt: new Date().toISOString(),
  };
}
