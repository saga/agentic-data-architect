/**
 * Deterministic Findings Engine。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import { nextId, type EvidenceRef, type Finding, type FindingType } from '../evidence/types.js';
import type { DataProfile } from '../adapters/database.js';
import type { LineageGraph } from './lineage.js';
import type { Inventory } from '../discovery/scanner.js';

/**
 * Findings Engine：只保留与具体业务领域无关的 deterministic rules；领域规则放到对应 Skill/script。
 * 每条 finding 必须引用已存在的 evidenceIds，找不到证据就不建 finding。
 */

export interface FindingContext {
  investigationId: string;
  lineage: LineageGraph;
  profiles: DataProfile[];
  inventory?: Inventory;
  evidence: EvidenceRef[];
}

/** 查找能够证明某个业务资产相关 Finding 的 Evidence ID。 */
function evidenceFor(ctx: FindingContext, asset: string): string[] {
  const lower = asset.toLowerCase();
  return ctx.evidence
    .filter((e) => {
      const ds = (e.dataset ?? '').toLowerCase();
      if (!ds) return false;
      // asset 可能是 "表.列" 限定名，证据按表名绑定：前缀匹配
      return lower === ds || lower.startsWith(ds + '.') || (e.source ?? '').toLowerCase().includes(lower);
    })
    .map((e) => e.id);
}

/** 创建一个带 Evidence 的 Finding；没有任何证据时返回 null，避免生成无依据的问题。 */
function mk(
  ctx: FindingContext,
  type: FindingType,
  title: string,
  description: string,
  severity: Finding['severity'],
  affectedAssets: string[],
  questions?: string[],
): Finding | null {
  const ids = [...new Set(affectedAssets.flatMap((a) => evidenceFor(ctx, a)))];
  if (ids.length === 0) return null; // 无证据不建 finding
  return {
    id: nextId('f'),
    type,
    title,
    description,
    severity,
    status: 'supported',
    evidenceIds: ids,
    affectedAssets,
    ...(questions?.length ? { questions } : {}),
    createdAt: new Date().toISOString(),
  };
}

/** 找出多个目标列重复使用同一转换表达式的情况。 */
export function findDuplicateTransformations(ctx: FindingContext): Finding[] {
  const byExpr = new Map<string, { target: string; file: string }[]>();
  for (const st of ctx.lineage.statements) {
    const target = st.target ?? `file:${st.file}`;
    for (const c of st.columns) {
      const norm = (c.expression ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!norm || norm === c.sourceColumn.toLowerCase()) continue; // 直通列不算重复逻辑
      const list = byExpr.get(norm) ?? [];
      list.push({ target: `${target}.${c.targetColumn}`, file: st.file });
      byExpr.set(norm, list);
    }
  }
  const out: Finding[] = [];
  for (const [expr, uses] of byExpr) {
    const targets = [...new Set(uses.map((u) => u.target))];
    if (targets.length >= 2) {
      const f = mk(
        ctx,
        'duplicate_transformation',
        '同一转换逻辑在多处重复实现',
        `表达式 \`${expr}\` 同时出现在：${targets.join('、')}。改一处容易漏另一处，建议收敛到单一实现。`,
        'medium',
        targets,
      );
      if (f) out.push(f);
    }
  }
  return out;
}

/** 找出扫描到但没有上下游连接的孤立数据集。 */
export function findMissingLineage(ctx: FindingContext): Finding[] {
  if (ctx.lineage.statements.length === 0) return [];
  const connected = new Set<string>();
  for (const e of ctx.lineage.edges) {
    connected.add(e.source.toLowerCase());
    connected.add(e.target.toLowerCase());
  }
  const isolated = ctx.lineage.tables.filter((t) => !t.startsWith('file:') && !connected.has(t.toLowerCase()));
  if (isolated.length === 0) return [];
  const f = mk(
    ctx,
    'missing_lineage',
    '部分表没有血缘连接',
    `这些表在扫描到的 SQL 里没有上下游：${isolated.join('、')}。可能是动态 SQL、ETL 工具或未扫描到的目录。`,
    'low',
    isolated,
    ['这些表的数据从哪里来、被谁消费？'],
  );
  return f ? [f] : [];
}

/** 找出表达式结构相似但定义在不同目标列上的潜在语义冲突。 */
export function findSemanticConflicts(ctx: FindingContext): Finding[] {
  // 不同目标列用了同构的派生表达式（去标识符后的形状相同）→ 可能是同一业务定义被各说各话
  // 裸列直通不算（那是 rename/lineage，不是语义冲突）
  const shapeOf = (expr: string): string | null => {
    const body = expr
      .replace(/\s+AS\s+\w+\s*$/i, '')
      .trim();
    if (!/[+\-*/%]|\(/.test(body)) return null;
    return body
      .toLowerCase()
      .replace(/[a-z_][\w.]*/g, '?')
      .replace(/\d+(\.\d+)?/g, '?')
      .replace(/\s+/g, ' ')
      .trim();
  };
  const byShape = new Map<string, { target: string; expr: string }[]>();
  for (const c of ctx.lineage.columns) {
    const shape = shapeOf(c.expression ?? '');
    if (!shape) continue;
    const list = byShape.get(shape) ?? [];
    list.push({ target: `${c.targetDataset}.${c.targetColumn}`, expr: c.expression ?? '' });
    byShape.set(shape, list);
  }
  const out: Finding[] = [];
  for (const [shape, uses] of byShape) {
    const targets = [...new Set(uses.map((u) => u.target.toLowerCase()))];
    if (targets.length >= 2) {
      const display = [...new Set(uses.map((u) => u.target))];
      const f = mk(
        ctx,
        'semantic_conflict',
        `不同列用了同构的计算逻辑：${display.join('、')}`,
        `表达式形状 \`${shape}\` 同时定义了 ${display.join('、')}。文档可能声称它们可互换，需要确认是不是同一个业务定义。`,
        'medium',
        display,
      );
      if (f) out.push(f);
    }
  }
  return out;
}

/** 根据 profiling 结果识别空表、高空值率等基础数据质量问题。 */
export function findDataQualityIssues(ctx: FindingContext): Finding[] {
  const out: Finding[] = [];
  for (const p of ctx.profiles) {
    if (p.rowCount === 0) {
      const f = mk(ctx, 'data_quality_issue', `${p.dataset} 是空表`, 'profile 时行数为 0，下游基于它的结论都不可信。', 'high', [p.dataset]);
      if (f) out.push(f);
      continue;
    }
    for (const c of p.columns) {
      if (c.nullRate === 1) {
        const f = mk(ctx, 'data_quality_issue', `${p.dataset}.${c.column} 全为空`, '该列 100% 为空，可能是废弃字段或上游断裂。', 'medium', [p.dataset]);
        if (f) out.push(f);
      } else if (c.nullRate > 0.5) {
        const f = mk(ctx, 'data_quality_issue', `${p.dataset}.${c.column} 空值过半`, `空值率 ${(c.nullRate * 100).toFixed(1)}%，使用前需要确认口径。`, 'low', [p.dataset]);
        if (f) out.push(f);
      }
    }
  }
  return out;
}

/** Generic deterministic rules only; domain-specific checks are delegated to Skills. */
export function runAllFindings(ctx: FindingContext): Finding[] {
  const all = [
    ...findDuplicateTransformations(ctx),
    ...findMissingLineage(ctx),
    ...findSemanticConflicts(ctx),
    ...findDataQualityIssues(ctx),
  ];
  const seen = new Set<string>();
  return all.filter((f) => {
    const key = `${f.type}:${f.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
