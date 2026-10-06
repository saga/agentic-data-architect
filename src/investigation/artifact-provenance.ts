import crypto from 'node:crypto';
import type { Investigation } from './store.js';
import type { DiscoverySnapshot } from '../workflow/discover.js';
import type { ArtifactProvenance } from '../api/contracts.js';

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Computes the identity of the Investigation state that an artifact was built from.
 * Only deterministic, persisted inputs are included; timestamps that do not change facts
 * are intentionally excluded.
 */
export function computeArtifactProvenance(
  investigation: Pick<Investigation, 'mission' | 'goal' | 'scope' | 'systems' | 'discoveryRuns' | 'evidence' | 'claims' | 'findings'>,
  snapshot: DiscoverySnapshot | null | undefined,
  artifactVersion: number,
): ArtifactProvenance {
  const missionFingerprint = digest({
    purpose: investigation.mission?.purpose ?? investigation.goal,
    expectedResult: investigation.mission?.expectedResult ?? '',
    deliverables: investigation.mission?.deliverables.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      required: item.required,
    })) ?? [],
  });

  const scopeFingerprint = digest({
    goal: investigation.goal,
    scope: investigation.scope,
    systems: investigation.systems,
  });

  const sourceRevision = digest({
    snapshot: snapshot ?? null,
    discoveryRuns: investigation.discoveryRuns.map((run) => ({
      id: run.id,
      parserVersion: run.parserVersion,
      completedAt: run.completedAt,
    })),
    evidence: investigation.evidence.map((item) => ({
      id: item.id,
      discoveryRunId: item.discoveryRunId,
      sourceHash: item.sourceHash ?? null,
    })),
    claims: investigation.claims.map((item) => ({
      id: item.id,
      status: item.status,
      evidenceIds: item.evidenceIds,
    })),
    findings: investigation.findings.map((item) => ({
      id: item.id,
      status: item.status,
      severity: item.severity,
      evidenceIds: item.evidenceIds,
    })),
    snapshotCurrentState: snapshot?.currentState ?? null,
  });

  return {
    missionFingerprint,
    scopeFingerprint,
    sourceRevision,
    artifactVersion,
  };
}

export function artifactProvenanceMatches(
  provenance: ArtifactProvenance | undefined,
  current: ArtifactProvenance,
): boolean {
  return Boolean(
    provenance
    && provenance.missionFingerprint === current.missionFingerprint
    && provenance.scopeFingerprint === current.scopeFingerprint
    && provenance.sourceRevision === current.sourceRevision
    && provenance.artifactVersion === current.artifactVersion,
  );
}

export function hashArtifact(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
