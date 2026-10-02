/**
 * Evidence-first 核心对象（docs/architecture_0930.md §四）。
 *
 * 链：Claim → EvidenceRef → Source（文件+hash+行号+discoveryRun）。
 * Claim 只存 evidenceIds，不嵌完整 Evidence，保证共享与可复查。
 */
import * as z from 'zod';

/** Claim 的可信状态枚举；verified 只允许 deterministic 校验阶段授予。 */
export const ClaimStatusSchema = z.enum(['verified', 'supported', 'inferred', 'unknown', 'contradicted']);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

/** Evidence 来源类型枚举，用于区分 SQL、metadata、profiling 等证据。 */
export const EvidenceTypeSchema = z.enum([
  'source_file', 'sql_statement', 'lineage', 'metadata',
  'profiling', 'query_result', 'documentation', 'runtime', 'semantic_context', 'parse_failure',
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

/** Evidence 持久化结构 Schema，保证每条证据都能关联 Investigation 和 DiscoveryRun。 */
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

/** Claim 持久化结构 Schema，只保存 evidenceIds，不嵌套完整 Evidence。 */
export const ClaimSchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  status: ClaimStatusSchema,
  evidenceIds: z.array(z.string()),
}).strict();
export type Claim = z.infer<typeof ClaimSchema>;

/** Finding 严重程度枚举。 */
export const FindingSeveritySchema = z.enum(['info', 'low', 'medium', 'high']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** 通用 Finding 类型枚举，领域专项规则由 Skill 负责。 */
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

/** Finding 持久化结构 Schema。 */
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

/** DiscoveryRun 持久化结构 Schema，用于记录一次扫描的范围和 parser 版本。 */
export const DiscoveryRunSchema = z.object({
  id: z.string().min(1),
  root: z.string(),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1),
  parserVersion: z.string().min(1),
  filesScanned: z.number().int().nonnegative(),
  datasetsFound: z.number().int().nonnegative(),
  lineageEdgesFound: z.number().int().nonnegative(),
  sqlParseFailures: z.number().int().nonnegative().optional(),
  semanticAssetsFound: z.number().int().nonnegative().optional(),
}).strict();
export type DiscoveryRun = z.infer<typeof DiscoveryRunSchema>;

/** 根据确定性 Evidence 数量校正 Agent 声称的 Claim 状态，防止模型自行授予 verified。 */
/**
 * 根据 Evidence 的来源独立性校正 Claim。
 * 两条 Evidence 如果来自同一个文件/同一个 source hash，不应仅因为记录数=2 就视为独立支持。
 * 兼容旧调用方传入 number，但新代码应传 EvidenceRef[]。
 */
export function calibrateStatus(evidence: number | EvidenceRef[], claimed: ClaimStatus): ClaimStatus {
  const evidenceCount = typeof evidence === 'number' ? evidence : evidence.length;
  if (evidenceCount === 0) return 'unknown';
  if (claimed === 'verified') return 'inferred';
  if (claimed === 'contradicted') return 'contradicted';
  if (claimed === 'supported') {
    const independent = typeof evidence === 'number'
      ? evidenceCount
      : new Set(evidence.map((item) => {
          if (item.sourceHash) return 'hash:' + item.sourceHash;
          if (item.file) return 'file:' + item.file;
          return item.type + ':' + item.source;
        })).size;
    if (independent < 2) return 'inferred';
  }
  return claimed;
}

import { randomBytes } from 'node:crypto';

/** 全局唯一 id（进程重启也不碰撞；同一 investigation 多 run 追加不覆盖）。 */
export function nextId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}
