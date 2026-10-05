/**
 * Report Workflow 入口。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import { buildReport } from '../analysis/report.js';
import { reviewArtifact, saveArtifactReview, summarizeReviewFailure } from '../analysis/reviewer.js';
import { loadInvestigation } from '../investigation/store.js';
import { assertMissionGate } from './mission-gate.js';

/** report 的 workflow 入口（纯透传，保持 cli → workflow → analysis 分层）。 */
export async function runReport(
  name: string,
): Promise<{ markdown: string; path: string; review: Awaited<ReturnType<typeof reviewArtifact>> }> {
  const report = await buildReport(name);
  const investigation = await loadInvestigation(name);
  assertMissionGate(investigation.mission);
  const review = await reviewArtifact({
    investigationName: name,
    goal: investigation.userPrompt || investigation.goal,
    artifactType: 'report',
    artifact: report.markdown,
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
  if (review.status !== 'pass' && review.availability !== 'unavailable') {
    throw new Error(
      '报告已经生成，但独立质量检查没有通过：'
      + summarizeReviewFailure(review)
      + '。完整检查结果保存在 ' + reviewPath + '。',
    );
  }
  return { ...report, review };
}
