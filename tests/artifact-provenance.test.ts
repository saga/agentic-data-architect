import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactProvenanceMatches,
  computeArtifactProvenance,
  computeScopeFingerprint,
  isDiscoverySnapshotCompatible,
} from '../src/investigation/artifact-provenance.js';

const investigation = {
  mission: {
    version: 1 as const,
    purpose: 'Define the target architecture for the platform.',
    expectedResult: 'A reviewed target architecture and migration direction.',
    deliverables: [{
      id: 'target',
      title: 'Target architecture',
      description: 'Describe the approved target architecture.',
      required: true,
    }],
    status: 'confirmed' as const,
    confirmedAt: '2026-10-06T08:00:00.000Z',
    confirmedBy: 'user' as const,
  },
  goal: 'Define the target architecture for the platform.',
  scope: ['positions', 'orders'],
  systems: ['legacy-platform'],
  discoveryRuns: [{ id: 'run-1', parserVersion: '1', completedAt: '2026-10-06T08:01:00.000Z' }],
  evidence: [{ id: 'ev-1', discoveryRunId: 'run-1', sourceHash: 'abc' }],
  claims: [{ id: 'claim-1', status: 'supported', evidenceIds: ['ev-1'] }],
  findings: [{ id: 'finding-1', status: 'open', severity: 'high', evidenceIds: ['ev-1'] }],
} as Parameters<typeof computeArtifactProvenance>[0];

function snapshot(estateName: string) {
  return {
    generation: { id: 'run-1', scopeFingerprint: computeScopeFingerprint(investigation) },
    run: { id: 'run-1', scopeFingerprint: computeScopeFingerprint(investigation) },
    currentState: {
      coverage: { datasets: 2 },
      estate: estateName,
    },
  } as Parameters<typeof computeArtifactProvenance>[1];
}

test('scope identity does not change when only Mission goal changes', () => {
  const first = computeScopeFingerprint(investigation);
  const changedGoal = {
    ...investigation,
    goal: 'A different wording for the same confirmed scope.',
  };
  assert.equal(computeScopeFingerprint(changedGoal), first);
});

test('scope identity is canonicalized', () => {
  const first = computeScopeFingerprint(investigation);
  const reordered = {
    ...investigation,
    scope: ['orders', 'positions', 'positions'],
    systems: ['legacy-platform', 'legacy-platform'],
  };
  assert.equal(computeScopeFingerprint(reordered), first);
});

test('mission provenance changes when a deliverable changes semantically', () => {
  const first = computeArtifactProvenance(investigation, snapshot('legacy-a'), 1);
  const changedMission = {
    ...investigation,
    mission: {
      ...investigation.mission!,
      deliverables: [{
        ...investigation.mission!.deliverables[0],
        description: 'Describe the reviewed target architecture and its decision boundaries.',
      }],
    },
  };
  const second = computeArtifactProvenance(changedMission, snapshot('legacy-a'), 1);
  assert.notEqual(first.missionFingerprint, second.missionFingerprint);
});

test('source provenance changes when the persisted discovery snapshot changes', () => {
  const first = computeArtifactProvenance(investigation, snapshot('legacy-a'), 1);
  const second = computeArtifactProvenance(investigation, snapshot('legacy-b'), 1);
  assert.notEqual(first.sourceRevision, second.sourceRevision);
});

test('artifact freshness requires the same source and artifact version', () => {
  const first = computeArtifactProvenance(investigation, snapshot('legacy-a'), 3);
  assert.equal(artifactProvenanceMatches(first, first), true);
  assert.equal(artifactProvenanceMatches(first, { ...first, artifactVersion: 4 }), false);
  assert.equal(
    artifactProvenanceMatches(first, { ...first, discoveryRunId: 'run-2' }),
    false,
  );
});

test('discovery snapshot compatibility is bound to the current scope generation', () => {
  const currentSnapshot = snapshot('legacy-a');
  assert.equal(isDiscoverySnapshotCompatible(investigation, currentSnapshot), true);
  const changedScope = { ...investigation, scope: ['positions', 'trades'] };
  assert.equal(isDiscoverySnapshotCompatible(changedScope, currentSnapshot), false);
});


test('artifact provenance records the explicit Discovery generation identity', () => {
  const value = computeArtifactProvenance(investigation, snapshot('legacy-a'), 1);
  assert.equal(value.discoveryRunId, 'run-1');
  assert.equal(value.discoveryScopeFingerprint, value.scopeFingerprint);
});

test('Discovery generation scope overrides legacy run fingerprint for compatibility checks', () => {
  const current = computeScopeFingerprint(investigation);
  const different = computeScopeFingerprint({ ...investigation, scope: ['positions', 'trades'] });
  const mismatched = {
    ...snapshot('legacy-a'),
    generation: { id: 'run-1', scopeFingerprint: different },
    run: { id: 'run-1', scopeFingerprint: current },
  } as Parameters<typeof computeArtifactProvenance>[1];
  assert.equal(isDiscoverySnapshotCompatible(investigation, mismatched), false);
});
