/**
 * Report Workflow 入口。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import { buildReport } from '../analysis/report.js';
import { reviewArtifact, saveArtifactReview, summarizeReviewFailure } from '../analysis/reviewer.js';
import { loadInvestigation, reportsDir } from '../investigation/store.js';
import { writeJsonAtomic } from '../investigation/workspace.js';
import * as z from 'zod';
import { createHash } from 'node:crypto';
import { ArtifactProvenanceSchema } from '../investigation/schemas.js';
import { buildCurrentArtifactProvenance, isArtifactCurrent } from '../investigation/artifact.js';
import { assertMissionGate } from './mission-gate.js';
const ReportArtifactMetaSchema = z.object({
  provenance: ArtifactProvenanceSchema,
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type ReportArtifactState =
  | { status: 'missing' }
  | { status: 'stale'; reason: string }
  | { status: 'blocked'; reason: string }
  | { status: 'available'; markdown: string; review: Awaited<ReturnType<typeof reviewArtifact>> };


/** report 的 workflow 入口（纯透传，保持 cli → workflow → analysis 分层）。 */
export async function runReport(
  name: string,
): Promise<{ markdown: string; path: string; review: Awaited<ReturnType<typeof reviewArtifact>> }> {
  const investigation = await loadInvestigation(name);
  assertMissionGate(investigation.mission);
  const report = await buildReport(name);
  const metaPath = path.join(reportsDir(name), 'report-meta.json');
  let artifactVersion = 1;
  try {
    const existingMeta = ReportArtifactMetaSchema.safeParse(JSON.parse(await fs.readFile(metaPath, 'utf8')));
    if (existingMeta.success) artifactVersion = existingMeta.data.provenance.artifactVersion + 1;
  } catch {
    // 首次生成或旧版本没有 provenance 时从 v1 开始。
  }
  const provenance = await buildCurrentArtifactProvenance(name, artifactVersion);
  const artifactHash = createHash('sha256').update(report.markdown).digest('hex');

  await writeJsonAtomic(metaPath, { provenance, artifactHash });

  const review = await reviewArtifact({
    investigationName: name,
    goal: investigation.mission?.purpose || investigation.goal || investigation.userPrompt,
    artifactType: 'report',
    artifact: report.markdown,
    artifactVersion,
    sourceRevision: provenance.sourceRevision,
    facts: JSON.stringify({
      findings: investigation.findings.slice(0, 20).map((finding) => ({
        title: finding.title,
        severity: finding.severity,
        affectedAssets: finding.affectedAssets,
      })),
      claims: investigation.claims.slice(0, 20).map((claim) => ({
        claim: claim.claim,
        status: claim.status,
      })),
    }, null, 2),
  });
  const reviewPath = await saveArtifactReview(name, review);
  if (review.status !== 'pass') {
    throw new Error(
      '报告已经生成，但独立质量检查没有通过：'
      + summarizeReviewFailure(review)
      + '。完整检查结果保存在 ' + reviewPath + '。',
    );
  }
  return { ...report, review };
}


/** 只读取已经生成并通过当前 provenance + Reviewer revision 校验的报告。 */
export async function loadReportArtifact(name: string): Promise<ReportArtifactState> {
  const reportPath = path.join(reportsDir(name), 'report.md');
  const metaPath = path.join(reportsDir(name), 'report-meta.json');
  const reviewPath = path.join(reportsDir(name), 'report-review.json');
  let markdown: string;
  try {
    markdown = await fs.readFile(reportPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    throw error;
  }

  let meta: z.infer<typeof ReportArtifactMetaSchema>;
  try {
    meta = ReportArtifactMetaSchema.parse(JSON.parse(await fs.readFile(metaPath, 'utf8')));
  } catch {
    return { status: 'stale', reason: '报告没有完整的 provenance，不能作为当前结果使用。' };
  }
  if (!(await isArtifactCurrent(name, meta.provenance))) {
    return { status: 'stale', reason: '报告对应的 Mission、Scope 或调查事实已经发生变化，需要重新生成。' };
  }

  const actualHash = createHash('sha256').update(markdown).digest('hex');
  if (actualHash !== meta.artifactHash) {
    return { status: 'blocked', reason: '报告内容与生成时记录的 hash 不一致，不能发布。' };
  }

  let review: Awaited<ReturnType<typeof reviewArtifact>>;
  try {
    review = (await import('../analysis/reviewer.js')).ArtifactReviewSchema.parse(
      JSON.parse(await fs.readFile(reviewPath, 'utf8')),
    );
  } catch {
    return { status: 'blocked', reason: '报告缺少可验证的独立质量审核结果。' };
  }
  if (review.artifactVersion !== meta.provenance.artifactVersion
    || review.artifactHash !== actualHash
    || review.sourceRevision !== meta.provenance.sourceRevision) {
    return { status: 'blocked', reason: '独立质量审核对应的报告版本已经过期。' };
  }
  if (review.status !== 'pass' || review.availability !== 'completed') {
    return { status: 'blocked', reason: '独立质量审核未通过，不能发布当前报告。' };
  }
  return { status: 'available', markdown, review };
}
