import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calibrateStatus, DiscoveryRunSchema, type EvidenceRef } from '../src/evidence/types.js';
import { parseAgentAnswer, toClaims } from '../src/agent/result.js';

describe('calibrateStatus: 模型自报 status 只做输入', () => {
  it('no evidence -> unknown, even when claimed verified', () => {
    assert.equal(calibrateStatus(0, 'verified'), 'unknown');
    assert.equal(calibrateStatus(0, 'supported'), 'unknown');
  });
  it('verified is never granted to the agent', () => {
    assert.equal(calibrateStatus(3, 'verified'), 'inferred');
  });
  it('supported needs 2+ independent evidence sources', () => {
    assert.equal(calibrateStatus(1, 'supported'), 'inferred');
    assert.equal(calibrateStatus(2, 'supported'), 'supported');
    const sameFile = [
      { id: 'ev-a', type: 'sql_statement', source: 'a.sql:1-2', file: 'a.sql', sourceHash: 'hash-a', investigationId: 'i', discoveryRunId: 'r', collectedAt: 'now' },
      { id: 'ev-b', type: 'lineage', source: 'a.sql:3-4', file: 'a.sql', sourceHash: 'hash-a', investigationId: 'i', discoveryRunId: 'r', collectedAt: 'now' },
    ] as const;
    assert.equal(calibrateStatus([...sameFile], 'supported'), 'inferred');
    assert.equal(
      calibrateStatus(
        [...sameFile, { id: 'ev-c', type: 'metadata', source: 'snowflake:RAW.POSITIONS', investigationId: 'i', discoveryRunId: 'r', collectedAt: 'now' }],
        'supported',
      ),
      'supported',
    );
  });
  it('contradicted passes through', () => {
    assert.equal(calibrateStatus(2, 'contradicted'), 'contradicted');
  });
});

describe('DiscoveryRun scope generation', () => {
  it('accepts the scope fingerprint on new discovery runs', () => {
    const run = DiscoveryRunSchema.parse({
      id: 'run-1',
      root: '/tmp/source',
      startedAt: '2026-10-06T08:00:00.000Z',
      completedAt: '2026-10-06T08:01:00.000Z',
      parserVersion: '1',
      scopeFingerprint: 'scope-1',
      filesScanned: 2,
      datasetsFound: 1,
      lineageEdgesFound: 1,
    });
    assert.equal(run.scopeFingerprint, 'scope-1');
  });
});

describe('parseAgentAnswer', () => {
  const existing = new Set(['ev-a', 'ev-b']);
  const evidenceMap = new Map<string, EvidenceRef>([
    ['ev-a', { id: 'ev-a', type: 'sql_statement', source: 'a.sql:1-2', file: 'a.sql', sourceHash: 'hash-a', investigationId: 'i', discoveryRunId: 'r', collectedAt: 'now' }],
    ['ev-b', { id: 'ev-b', type: 'metadata', source: 'snowflake:RAW.POSITIONS', investigationId: 'i', discoveryRunId: 'r', collectedAt: 'now' }],
  ]);

  it('keeps valid claims, drops unknown evidence ids with warning', () => {
    const raw = JSON.stringify({
      answer: 'Position comes from IBOR.',
      claims: [{ claim: 'IBOR is the source', status: 'supported', evidenceIds: ['ev-a', 'ev-ghost'] }],
      unknowns: [],
      followUpQuestions: [],
    });
    const p = parseAgentAnswer(raw, existing);
    assert.equal(p.claims.length, 1);
    assert.deepEqual(p.claims[0]?.evidenceIds, ['ev-a']);
    assert.deepEqual(p.droppedEvidenceRefs, ['ev-ghost']);
    assert.ok(p.warnings.length > 0);
    // 只剩 1 个证据，supported 被降级为 inferred
    assert.equal(p.claims[0]?.status, 'inferred');
  });

  it('uses evidence provenance when calibrating supported claims', () => {
    const raw = JSON.stringify({
      answer: 'a',
      claims: [{ claim: 'c', status: 'supported', evidenceIds: ['ev-a', 'ev-b'] }],
      unknowns: [],
      followUpQuestions: [],
    });
    const p = parseAgentAnswer(raw, evidenceMap);
    assert.equal(p.claims[0]?.status, 'supported');
  });

  it('unparseable output yields no claims', () => {
    const p = parseAgentAnswer('just some prose, no json', existing);
    assert.equal(p.claims.length, 0);
    assert.ok(p.warnings.length > 0);
  });


});
