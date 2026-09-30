/**
 * Evidence-first 核心对象（docs/architecture_0930.md §四）。
 *
 * 链：Claim → EvidenceRef → Source（文件+hash+行号+discoveryRun）。
 * Claim 只存 evidenceIds，不嵌完整 Evidence，保证共享与可复查。
 */
import * as z from 'zod';

export const ClaimStatusSchema = z.enum(['verified', 'supported', 'inferred', 'unknown', 'contradicted']);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const EvidenceTypeSchema = z.enum([
  'source_file', 'sql_statement', 'lineage', 'metadata',
  'profiling', 'query_result', 'documentation', 'runtime',
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const EvidenceRefSchema = z.object({
  id: z.string().min(1),
  type: EvidenceTypeSchema,
  investigationId: z.string().min(1),
  discoveryRunId: z.string().min(1),
  source: z.string().min(1),
  file: z.string().optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  statement: z.string().optional(),
  dataset: z.string().optional(),
  column: z.string().optional(),
  value: z.unknown().optional(),
  sourceHash: z.string().optional(),
  collectedAt: z.string().min(1),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ClaimSchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  status: ClaimStatusSchema,
  evidenceIds: z.array(z.string()),
}).strict();
export type Claim = z.infer<typeof ClaimSchema>;

export const FindingSeveritySchema = z.enum(['info', 'low', 'medium', 'high']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingTypeSchema = z.enum([
  'multiple_sources_of_truth',
  'duplicate_transformation',
  'identifier_fragmentation',
  'missing_lineage',
  'semantic_conflict',
  'possible_stale_documentation',
  'data_quality_issue',
  'temporal_risk',
]);
export type FindingType = z.infer<typeof FindingTypeSchema>;

export const FindingSchema = z.object({
  id: z.string().min(1),
  type: FindingTypeSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  severity: FindingSeveritySchema,
  status: ClaimStatusSchema,
  evidenceIds: z.array(z.string()),
  affectedAssets: z.array(z.string()),
  questions: z.array(z.string()).optional(),
  createdAt: z.string().min(1),
}).strict();
export type Finding = z.infer<typeof FindingSchema>;

export const DiscoveryRunSchema = z.object({
  id: z.string().min(1),
  root: z.string(),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1),
  parserVersion: z.string().min(1),
  filesScanned: z.number().int().nonnegative(),
  datasetsFound: z.number().int().nonnegative(),
  lineageEdgesFound: z.number().int().nonnegative(),
}).strict();
export type DiscoveryRun = z.infer<typeof DiscoveryRunSchema>;

export function calibrateStatus(evidenceCount: number, claimed: ClaimStatus): ClaimStatus {
  if (evidenceCount === 0) return 'unknown';
  if (claimed === 'verified') return 'inferred';
  if (claimed === 'supported' && evidenceCount < 2) return 'inferred';
  if (claimed === 'contradicted') return 'contradicted';
  return claimed;
}

import { randomBytes } from 'node:crypto';

/** 全局唯一 id（进程重启也不碰撞；同一 investigation 多 run 追加不覆盖）。 */
export function nextId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}
