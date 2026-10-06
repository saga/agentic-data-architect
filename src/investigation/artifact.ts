import { createHash } from 'node:crypto';
import { loadInvestigation, loadLatestSnapshot } from './store.js';
import { ArtifactProvenanceSchema, type ArtifactProvenance } from './schemas.js';

function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);
}

/**
 * 当前 Investigation 的 Artifact provenance。
 *
 * missionFingerprint / scopeFingerprint 分别绑定任务边界和正式调查前置条件；
 * sourceRevision 只反映调查事实，不包含 UI/config 更新时间。
 */
export async function buildCurrentArtifactProvenance(
  name: string,
  artifactVersion: number,
): Promise<ArtifactProvenance> {
  const investigation = await loadInvestigation(name);
  const snapshot = await loadLatestSnapshot<{
    run?: { id?: string };
  }>(name);

  const missionFingerprint = fingerprint(investigation.mission ?? null);
  const scopeFingerprint = fingerprint(investigation.scopeValidation ?? null);
  const sourceRevision = fingerprint({
    discoveryRuns: investigation.discoveryRuns.map((run) => run.id),
    evidence: investigation.evidence.map((item) => ({
      id: item.id,
      discoveryRunId: item.discoveryRunId,
      sourceHash: item.sourceHash,
    })),
    claims: investigation.claims.map((claim) => ({
      id: claim.id,
      status: claim.status,
      evidenceIds: claim.evidenceIds,
    })),
    findings: investigation.findings.map((finding) => ({
      id: finding.id,
      status: finding.status,
      evidenceIds: finding.evidenceIds,
    })),
    latestDiscoveryRunId: snapshot?.run?.id ?? null,
  });

  return ArtifactProvenanceSchema.parse({
    missionFingerprint,
    scopeFingerprint,
    sourceRevision,
    artifactVersion,
    generatedAt: new Date().toISOString(),
  });
}

export async function isArtifactCurrent(
  name: string,
  provenance: ArtifactProvenance | undefined,
): Promise<boolean> {
  if (!provenance) return false;
  const current = await buildCurrentArtifactProvenance(name, provenance.artifactVersion);
  return provenance.missionFingerprint === current.missionFingerprint
    && provenance.scopeFingerprint === current.scopeFingerprint
    && provenance.sourceRevision === current.sourceRevision;
}
