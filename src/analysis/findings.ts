import { nextId, type EvidenceRef, type Finding, type FindingType } from '../evidence/types.js';
import type { DataProfile } from '../adapters/database.js';
import type { LineageGraph } from './lineage.js';
import type { Inventory } from '../discovery/scanner.js';

/**
 * Findings Engine（§十五）：先 deterministic rules，不让 LLM 自由发挥。
 * 每条 finding 必须引用已存在的 evidenceIds，找不到证据就不建 finding。
 */

export interface FindingContext {
  investigationId: string;
  lineage: LineageGraph;
  profiles: DataProfile[];
  inventory: Inventory;
  evidence: EvidenceRef[];
}

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

const CONCEPT_ALIASES: Record<string, string[]> = {
  position: ['position', 'pos_qty', 'posqty', 'holding'],
  price: ['price', 'px_', '_px', 'quote'],
  security: ['security', 'instrument'],
  portfolio: ['portfolio', 'pf_'],
  transaction: ['transaction', 'txn', 'trade'],
  performance: ['performance', 'perf_', 'return'],
};

export function findMultipleSourcesOfTruth(ctx: FindingContext): Finding[] {
  const out: Finding[] = [];
  for (const [concept, aliases] of Object.entries(CONCEPT_ALIASES)) {
    const candidates = ctx.lineage.tables.filter((t) => {
      const l = t.toLowerCase();
      if (l.startsWith('file:')) return false;
      return aliases.some((a) => l.includes(a));
    });
    const unique = [...new Set(candidates)];
    if (unique.length >= 2) {
      const f = mk(
        ctx,
        'multiple_sources_of_truth',
        `多个候选数据源都声称提供 ${concept}`,
        `发现 ${unique.length} 个疑似 ${concept} 的 dataset：${unique.join('、')}。需要确认哪个是权威源，哪些只是缓存或派生。`,
        'high',
        unique,
        [`${concept} 的权威源是哪个？`, '这些候选之间是派生关系还是各自独立计算？'],
      );
      if (f) out.push(f);
    }
  }
  return out;
}

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

const IDENTIFIER_PATTERNS = [
  'security_id',
  'sec_id',
  'ticker',
  'isin',
  'cusip',
  'sedol',
  'figi',
  'bloomberg_id',
  'internal_id',
];

export function findIdentifierFragmentation(ctx: FindingContext): Finding[] {
  const variants = new Map<string, Set<string>>(); // 归一化列名 -> 实际写法
  for (const c of ctx.lineage.columns) {
    const norm = c.sourceColumn.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const p of IDENTIFIER_PATTERNS) {
      if (norm.includes(p.replace(/[^a-z0-9]/g, ''))) {
        const set = variants.get(p) ?? new Set<string>();
        set.add(c.sourceColumn);
        variants.set(p, set);
      }
    }
  }
  const out: Finding[] = [];
  const distinctSpellings = [...new Set([...variants.values()].flatMap((s) => [...s]).map((x) => x.toLowerCase()))];
  if (distinctSpellings.length >= 2 || variants.size >= 2) {
    const assets = [...new Set(ctx.lineage.columns.map((c) => c.sourceDataset))].slice(0, 10);
    const f = mk(
      ctx,
      'identifier_fragmentation',
      '证券标识在多处写法不一致',
      `发现标识写法：${distinctSpellings.join('、')}。跨源 join 依赖隐式映射，建议收敛到 Security Master 的标准 ID。`,
      'medium',
      assets,
      ['哪个是标准证券 ID？', '标识映射表在哪里维护？'],
    );
    if (f) out.push(f);
  }
  return out;
}

export function findMissingLineage(ctx: FindingContext): Finding[] {
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

const TIME_HINTS = ['date', 'time', '_at', 'asof', 'as_of', 'effective', 'knowledge', 'publication', 'vintage', 'fiscal'];

export function findTemporalRisks(ctx: FindingContext): Finding[] {
  const colsByDataset = new Map<string, string[]>();
  const addCols = (ds: string, ...cols: string[]) => {
    const list = colsByDataset.get(ds) ?? [];
    list.push(...cols);
    colsByDataset.set(ds, list);
  };
  for (const c of ctx.lineage.columns) {
    addCols(c.targetDataset, c.targetColumn, c.sourceColumn);
    addCols(c.sourceDataset, c.sourceColumn);
  }
  for (const p of ctx.profiles) {
    for (const c of p.columns) {
      const list = colsByDataset.get(p.dataset) ?? [];
      list.push(c.column);
      colsByDataset.set(p.dataset, list);
    }
  }
  const out: Finding[] = [];
  for (const [ds, cols] of colsByDataset) {
    if (ds.startsWith('file:')) continue;
    const hasTime = cols.some((c) => TIME_HINTS.some((h) => c.toLowerCase().includes(h)));
    if (!hasTime) {
      const f = mk(
        ctx,
        'temporal_risk',
        `${ds} 看不到时间语义列`,
        '没有日期/生效时间/发布时间之类的列，无法判断这是当前真相、历史快照还是 point-in-time 数据。研究类使用会有前视风险。',
        'medium',
        [ds],
        ['这张表的时间语义是什么？as-of / knowledge time 分别是哪个字段？'],
      );
      if (f) out.push(f);
    }
  }
  return out;
}

/** 8 类规则全跑一遍，去重后返回。 */
export function runAllFindings(ctx: FindingContext): Finding[] {
  const all = [
    ...findMultipleSourcesOfTruth(ctx),
    ...findDuplicateTransformations(ctx),
    ...findIdentifierFragmentation(ctx),
    ...findMissingLineage(ctx),
    ...findSemanticConflicts(ctx),
    ...findDataQualityIssues(ctx),
    ...findTemporalRisks(ctx),
  ];
  const seen = new Set<string>();
  return all.filter((f) => {
    const key = `${f.type}:${f.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
