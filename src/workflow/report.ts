import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { buildReport } from '../analysis/report.js';
import { ArtifactReviewSchema, reviewArtifact, saveArtifactReview, summarizeReviewFailure } from '../analysis/reviewer.js';
import { loadInvestigation, loadLatestSnapshot, reportsDir } from '../investigation/store.js';
import { assertInvestigationArtifactSourceScope, captureInvestigationArtifactSource } from '../investigation/artifact-source.js';
import { assertMissionGate } from './mission-gate.js';
import { assertInvestigationReportGate } from './report-gate.js';
import { readModernizationArtifact } from './modernization.js';
import { computeArtifactProvenance, artifactProvenanceMatches, hashArtifact, isDiscoverySnapshotCompatible } from '../investigation/artifact-provenance.js';
import { withWorkspaceContextLock } from '../investigation/workspace.js';
import { readArchitectureAssessmentArtifact } from './assessment.js';
import { ReportArtifactStateSchema, ArtifactProvenanceSchema, type ReportArtifactState } from '../api/contracts.js';
import type { DiscoverySnapshot } from './discover.js';

const ReportMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  artifactHash: z.string().min(1),
  provenance: ArtifactProvenanceSchema,
}).strict();
type ReportMetadata = z.infer<typeof ReportMetadataSchema>;

export class ReportQualityGateError extends Error {
  readonly review: Awaited<ReturnType<typeof reviewArtifact>>;
  constructor(review: Awaited<ReturnType<typeof reviewArtifact>>) {
    super(review.availability === 'unavailable'
      ? '报告已经生成，但独立质量检查暂时无法完成。'
      : '报告已经生成，但独立质量检查没有通过：' + summarizeReviewFailure(review));
    this.name = 'ReportQualityGateError';
    this.review = review;
  }
}

function reportFile(name: string): string {
  return path.join(reportsDir(name), 'report.md');
}

function reportMetadataFile(name: string): string {
  return path.join(reportsDir(name), 'report-meta.json');
}

async function countAnalysisArtifacts(name: string): Promise<number> {
  const dir = path.join(path.dirname(reportsDir(name)), 'artifacts', 'analysis');
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 读取报告只做 read；不会调用 LLM、Reviewer 或写文件。 */
export async function readReport(name: string): Promise<ReportArtifactState> {
  const markdown = await readOptional(reportFile(name));
  if (markdown === null) {
    return ReportArtifactStateSchema.parse({ status: 'missing' });
  }

  const metaRaw = await readOptional(reportMetadataFile(name));
  if (metaRaw === null) {
    return ReportArtifactStateSchema.parse({ status: 'stale' });
  }

  let metadata: ReportMetadata;
  try {
    metadata = ReportMetadataSchema.parse(JSON.parse(metaRaw));
  } catch {
    return ReportArtifactStateSchema.parse({ status: 'error' });
  }

  const investigation = await loadInvestigation(name);
  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);
  if (!isDiscoverySnapshotCompatible(investigation, snapshot)) {
    return ReportArtifactStateSchema.parse({
      status: 'stale',
      generatedAt: metadata.generatedAt,
      sourceRevision: metadata.provenance.sourceRevision,
    });
  }
  const currentProvenance = computeArtifactProvenance(investigation, snapshot, metadata.version);
  if (!artifactProvenanceMatches(metadata.provenance, currentProvenance)) {
    return ReportArtifactStateSchema.parse({
      status: 'stale',
      generatedAt: metadata.generatedAt,
      sourceRevision: metadata.provenance.sourceRevision,
    });
  }

  if (hashArtifact(markdown) !== metadata.artifactHash) {
    return ReportArtifactStateSchema.parse({
      status: 'stale',
      generatedAt: metadata.generatedAt,
      sourceRevision: metadata.provenance.sourceRevision,
    });
  }

  const reviewRaw = await readOptional(path.join(reportsDir(name), 'report-review.json'));
  let reviewedAt: string | undefined;
  let reviewStatus: 'pass' | 'fail' | 'unavailable' | undefined;
  if (reviewRaw) {
    try {
      const review = ArtifactReviewSchema.parse(JSON.parse(reviewRaw));
      if (
        review.artifactHash === metadata.artifactHash
        && review.sourceRevision === metadata.provenance.sourceRevision
        && review.artifactVersion === metadata.version
      ) {
        reviewedAt = review.reviewedAt;
        reviewStatus = review.availability === 'completed' ? review.status : 'unavailable';
      }
    } catch {
      // A malformed review must not make a readable report disappear.
    }
  }

  if (reviewStatus !== 'pass') {
    return ReportArtifactStateSchema.parse({
      status: 'blocked',
      generatedAt: metadata.generatedAt,
      sourceRevision: metadata.provenance.sourceRevision,
      ...(reviewedAt ? { reviewedAt } : {}),
      ...(reviewStatus ? { reviewStatus } : {}),
    });
  }

  return ReportArtifactStateSchema.parse({
    status: 'current',
    generatedAt: metadata.generatedAt,
    sourceRevision: metadata.provenance.sourceRevision,
    ...(reviewedAt ? { reviewedAt } : {}),
    reviewStatus: 'pass',
    markdown,
  });
}

/** report 的生成入口；生成、Reviewer 和持久化只从显式 regenerate 调用。 */
export async function runReport(
  name: string,
): Promise<{ markdown: string; path: string; review: Awaited<ReturnType<typeof reviewArtifact>> }> {
  return withWorkspaceContextLock(name, async () => {
  const source = await captureInvestigationArtifactSource(name);
  const investigation = source.investigation;
  const snapshot = source.snapshot;
  assertMissionGate(investigation.mission);
  assertInvestigationArtifactSourceScope(source);
  await assertInvestigationReportGate(name, {
    investigation: {
      ...source.investigation,
      resultArtifactCount: await countAnalysisArtifacts(name),
      workflow: source.investigation.workflow,
      assessmentPlanAvailable: Boolean(assessment),
      assessmentRecommendationCount: assessment?.recommendations.length ?? 0,
      assessmentRoadmapCount: assessment?.roadmap.length ?? 0,
    },
    snapshot: source.snapshot,
  });
  const modernizationResult = source.investigation.workflow === 'legacy-modernization'
    ? await readModernizationArtifact(name, source)
    : { status: 'blocked' as const, plan: null };
  const modernization = modernizationResult.status === 'current' ? modernizationResult.plan : null;
  const assessmentResult = source.investigation.workflow === 'data-architecture-assessment'
    ? await readArchitectureAssessmentArtifact(name)
    : { status: 'blocked' as const, plan: null };
  const assessment = assessmentResult.status === 'current' ? assessmentResult.plan : null;
  const existingRaw = await readOptional(reportMetadataFile(name));
  let nextVersion = 1;
  if (existingRaw) {
    try {
      const existing = ReportMetadataSchema.parse(JSON.parse(existingRaw));
      nextVersion = existing.version + 1;
    } catch {
      nextVersion = 1;
    }
  }

  const report = await buildReport(name, { investigation, snapshot, modernization, assessment });
  const provenance = computeArtifactProvenance(investigation, snapshot, nextVersion);
  const artifactHash = hashArtifact(report.markdown);
  const review = await reviewArtifact({
    investigationName: name,
    goal: investigation.mission?.purpose || investigation.goal || investigation.userPrompt,
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
    artifactHash,
    sourceRevision: provenance.sourceRevision,
    artifactVersion: nextVersion,
  });
  const metadata: ReportMetadata = ReportMetadataSchema.parse({
    schemaVersion: 1,
    version: nextVersion,
    generatedAt: new Date().toISOString(),
    artifactHash,
    provenance,
  });
  await fs.mkdir(reportsDir(name), { recursive: true });
  await fs.writeFile(reportMetadataFile(name), JSON.stringify(metadata, null, 2) + '\n', 'utf8');

  const reviewPath = await saveArtifactReview(name, review);
  if (review.availability !== 'completed' || review.status !== 'pass') {
    throw new ReportQualityGateError(review);
  }

  return { ...report, review };
  });
}
