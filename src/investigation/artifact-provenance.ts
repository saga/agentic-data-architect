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

/**
 * Scope identity 只由 scope + systems 决定，不把 Mission goal 混进去。
 * 原因是 Mission 与 Scope 有独立生命周期：改任务目标不应该伪装成范围变化，反之亦然。
 * 这个 fingerprint 会被 Discovery、Artifact 和旧 turn 防护共同使用，因此一旦字段组成改变，必须同步更新相关 ADR 和测试。
 */
export function computeScopeFingerprint(
  investigation: Pick<Investigation, 'scope' | 'systems'>,
): string {
  return digest({
    scope: normalizeScopeValues(investigation.scope),
    systems: normalizeScopeValues(investigation.systems),
  });
}

/**
 * 计算 Mission 的稳定 identity，用来判断一个正在执行的 Agent turn 是否已经过期。
 * purpose、expectedResult 和 deliverable 契约都会影响结果解释，因此全部纳入 fingerprint；
 * confirmedAt、version 等只描述确认过程的元数据不纳入 identity。
 */
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
 * 计算一个结果产物所依据的 Investigation 来源版本。
 * 这里只放会影响事实内容的确定性持久化输入；单纯的时间戳不参与计算，否则每次读取都会让
 * 旧报告无意义地变成 stale。调用方通过它判断报告/Assessment/Modernization 是否仍对应当前事实。
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
