import crypto from 'node:crypto';
import type { Investigation } from './store.js';
import type { DiscoverySnapshot } from '../workflow/discover.js';
import type { ArtifactProvenance } from '../api/contracts.js';

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeScopeValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

/** Scope identity deliberately excludes Mission goal text; Mission and Scope have independent lifecycles. */
export function computeScopeFingerprint(
  investigation: Pick<Investigation, 'scope' | 'systems'>,
): string {
  return digest({
    scope: normalizeScopeValues(investigation.scope),
    systems: normalizeScopeValues(investigation.systems),
  });
}

/** Stable Mission identity used to reject stale Agent turns before they commit results. */
export function computeMissionFingerprint(
  investigation: Pick<Investigation, 'mission' | 'goal'>,
): string {
  return digest({
    purpose: investigation.mission?.purpose ?? investigation.goal,
    expectedResult: investigation.mission?.expectedResult ?? '',
    deliverables: investigation.mission?.deliverables.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      required: item.required,
    })) ?? [],
  });
}

/**
 * Computes the identity of the Investigation state that an artifact was built from.
 * Only deterministic, persisted inputs are included; timestamps that do not change facts
 * are intentionally excluded.
 */
export function isDiscoverySnapshotCompatible(
  investigation: Pick<Investigation, 'goal' | 'scope' | 'systems'>,
  snapshot: DiscoverySnapshot | null | undefined,
): boolean {
  if (!snapshot) return true;
  const scopeFingerprint = snapshot.generation?.scopeFingerprint ?? snapshot.run.scopeFingerprint;
  return Boolean(scopeFingerprint && scopeFingerprint === computeScopeFingerprint(investigation));
}

export class DiscoverySnapshotMismatchError extends Error {
  constructor() {
    super('最近的 Discovery Snapshot 不属于当前 Scope generation，请重新执行 Discovery。');
    this.name = 'DiscoverySnapshotMismatchError';
  }
}

export function assertDiscoverySnapshotCompatible(
  investigation: Pick<Investigation, 'goal' | 'scope' | 'systems'>,
  snapshot: DiscoverySnapshot | null | undefined,
): void {
  if (!isDiscoverySnapshotCompatible(investigation, snapshot)) {
    throw new DiscoverySnapshotMismatchError();
  }
}

export function computeArtifactProvenance(
  investigation: Pick<Investigation, 'mission' | 'goal' | 'scope' | 'systems' | 'discoveryRuns' | 'evidence' | 'claims' | 'findings'>,
  snapshot: DiscoverySnapshot | null | undefined,
  artifactVersion: number,
): ArtifactProvenance {
  const missionFingerprint = computeMissionFingerprint(investigation);

  const scopeFingerprint = computeScopeFingerprint(investigation);
  assertDiscoverySnapshotCompatible(investigation, snapshot);

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
    ...(snapshot?.generation?.id ?? snapshot?.run.id
      ? { discoveryRunId: snapshot?.generation?.id ?? snapshot?.run.id }
      : {}),
    ...(snapshot?.generation?.scopeFingerprint ?? snapshot?.run.scopeFingerprint
      ? { discoveryScopeFingerprint: snapshot?.generation?.scopeFingerprint ?? snapshot?.run.scopeFingerprint }
      : {}),
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
    && provenance.artifactVersion === current.artifactVersion
    && provenance.discoveryRunId === current.discoveryRunId
    && provenance.discoveryScopeFingerprint === current.discoveryScopeFingerprint,
  );
}

export function hashArtifact(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
