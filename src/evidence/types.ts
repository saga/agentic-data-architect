/**
 * 核心对象 Evidence（docs/architecture_0930.md §四）。
 *
 * 规则：Agent 的每个结论（Claim）必须能回指 Evidence；
 * 状态只有 5 种，不搞 confidence score。
 */

export type ClaimStatus = 'verified' | 'supported' | 'inferred' | 'unknown' | 'contradicted';

export interface LineageEvidence {
  type: 'lineage';
  source: string;
  target: string;
  transform?: string;
}

export interface SqlEvidence {
  type: 'sql';
  file: string;
  query: string;
  result?: string;
}

export interface DocEvidence {
  type: 'documentation';
  document: string;
  excerpt?: string;
}

export interface ProfilingEvidence {
  type: 'profiling';
  dataset: string;
  metric: string;
  value: string;
}

export type Evidence = LineageEvidence | SqlEvidence | DocEvidence | ProfilingEvidence;

export interface Claim {
  claim: string;
  status: ClaimStatus;
  evidence: Evidence[];
}

export function makeClaim(claim: string, evidence: Evidence[], status?: ClaimStatus): Claim {
  return { claim, evidence, status: status ?? inferStatus(evidence) };
}

/** 无证据 → unknown；有确定性证据（profiling/sql结果）→ supported；纯文档/lineage → inferred */
function inferStatus(evidence: Evidence[]): ClaimStatus {
  if (evidence.length === 0) return 'unknown';
  if (evidence.some((e) => e.type === 'profiling' || (e.type === 'sql' && e.result))) return 'supported';
  return 'inferred';
}
