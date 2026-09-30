/**
 * Targeted Query 的安全执行入口。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import { assertReadOnly, type DatabaseAdapter } from '../adapters/database.js';
import { nextId, type EvidenceRef } from '../evidence/types.js';

/**
 * Targeted Query：Agent 先产 query plan → 确定性校验 → 只读执行 → 证据。
 * 不是让 LLM 直连数据库。
 */

export interface QueryPlan {
  reason: string;
  dataset: string;
  sql: string;
  expectedEvidence: string[];
}

/** 校验：只读 + 单条 + 必须引用目标表名。 */
export function validateQueryPlan(plan: QueryPlan): void {
  assertReadOnly(plan.sql);
  const table = (plan.dataset.split('.').pop() ?? '').replace(/^"|"$/g, '');
  const escaped = table.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
  const tablePattern = escaped ? new RegExp('(?<![A-Za-z0-9_$])' + escaped + '(?![A-Za-z0-9_$])', 'i') : null;
  if (!tablePattern || !tablePattern.test(plan.sql)) {
    throw new Error(`查询没有引用目标表 ${plan.dataset}，拒绝执行：${plan.sql.slice(0, 120)}`);
  }
}

/** 执行已经通过安全校验的查询，并把结果包装成可追溯 Evidence。 */
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
