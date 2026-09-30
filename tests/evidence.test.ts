import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calibrateStatus } from '../src/evidence/types.js';
import { parseAgentAnswer, toClaims } from '../src/agent/result.js';

describe('calibrateStatus: 模型自报 status 只做输入', () => {
  it('no evidence -> unknown, even when claimed verified', () => {
    assert.equal(calibrateStatus(0, 'verified'), 'unknown');
    assert.equal(calibrateStatus(0, 'supported'), 'unknown');
  });
  it('verified is never granted to the agent', () => {
    assert.equal(calibrateStatus(3, 'verified'), 'inferred');
  });
  it('supported needs 2+ evidence', () => {
    assert.equal(calibrateStatus(1, 'supported'), 'inferred');
    assert.equal(calibrateStatus(2, 'supported'), 'supported');
  });
  it('contradicted passes through', () => {
    assert.equal(calibrateStatus(2, 'contradicted'), 'contradicted');
  });
});

describe('parseAgentAnswer', () => {
  const existing = new Set(['ev-a', 'ev-b']);

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

  it('unparseable output yields no claims', () => {
    const p = parseAgentAnswer('just some prose, no json', existing);
    assert.equal(p.claims.length, 0);
    assert.ok(p.warnings.length > 0);
  });

  it('toClaims assigns ids', () => {
    const p = parseAgentAnswer(
      JSON.stringify({ answer: 'a', claims: [{ claim: 'c', status: 'inferred', evidenceIds: ['ev-a'] }], unknowns: [], followUpQuestions: [] }),
      existing,
    );
    const claims = toClaims(p, () => 'c-1');
    assert.equal(claims[0]?.id, 'c-1');
  });
});
