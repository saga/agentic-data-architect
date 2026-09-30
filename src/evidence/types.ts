/**
 * Evidence-first 核心对象（docs/architecture_0930.md §四）。
 *
 * 链：Claim → EvidenceRef → Source（文件+hash+行号+discoveryRun）。
 * Claim 只存 evidenceIds，不嵌完整 Evidence，保证共享与可复查。
 */

export type ClaimStatus = 'verified' | 'supported' | 'inferred' | 'unknown' | 'contradicted';

export type EvidenceType =
  | 'source_file'
  | 'sql_statement'
  | 'lineage'
  | 'metadata'
  | 'profiling'
  | 'query_result'
  | 'documentation'
  | 'runtime';

export interface EvidenceRef {
  id: string;
  type: EvidenceType;
  investigationId: string;
  discoveryRunId: string;
  /** 人可读的来源描述，如 "examples/legacy/a.sql:3-12" */
  source: string;
  file?: string;
  lineStart?: number;
  lineEnd?: number;
  /** 产生该证据的 SQL 文本（statement 级） */
  statement?: string;
  dataset?: string;
  column?: string;
  value?: unknown;
  /** 证据采集时源文件的 sha256，文件变了就能发现证据已过期 */
  sourceHash?: string;
  collectedAt: string;
}

export interface Claim {
  id: string;
  claim: string;
  status: ClaimStatus;
  evidenceIds: string[];
}

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high';

export type FindingType =
  | 'multiple_sources_of_truth'
  | 'duplicate_transformation'
  | 'identifier_fragmentation'
  | 'missing_lineage'
  | 'semantic_conflict'
  | 'possible_stale_documentation'
  | 'data_quality_issue'
  | 'temporal_risk';

export interface Finding {
  id: string;
  type: FindingType;
  title: string;
  description: string;
  severity: FindingSeverity;
  status: ClaimStatus;
  evidenceIds: string[];
  affectedAssets: string[];
  questions?: string[];
  createdAt: string;
}

export interface DiscoveryRun {
  id: string;
  root: string;
  startedAt: string;
  completedAt: string;
  parserVersion: string;
  filesScanned: number;
  datasetsFound: number;
  lineageEdgesFound: number;
}

/**
 * 状态校正规则（§十七）：LLM 自报的 status 不能直接信。
 * 无证据→unknown；只有弱证据→inferred；有确定性证据→supported；
 * verified 只保留给经过 deterministic validation 的（调用方显式传入）。
 */
export function calibrateStatus(evidenceCount: number, claimed: ClaimStatus): ClaimStatus {
  if (evidenceCount === 0) return 'unknown';
  if (claimed === 'verified') return 'inferred'; // Agent 无权自封 verified
  if (claimed === 'supported' && evidenceCount < 2) return 'inferred';
  if (claimed === 'contradicted') return 'contradicted';
  return claimed;
}

import { randomBytes } from 'node:crypto';

/** 全局唯一 id（进程重启也不碰撞；同一 investigation 多 run 追加不覆盖）。 */
export function nextId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}
