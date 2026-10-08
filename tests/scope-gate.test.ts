import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUserScopeValidation,
  evaluateInvestigationScopeGate,
  formatScopeGateFailure,
  isCurrentStateOnlyScope,
} from '../src/workflow/scope-gate.js';

function investigation(overrides: Record<string, unknown> = {}) {
  return {
    goal: '替换老的投票工作流',
    scope: ['Proxy Voting'],
    systems: ['ISS Portal', '内部持仓系统'],
    ...overrides,
  };
}

test('scope gate rejects missing mandatory fields', () => {
  const result = evaluateInvestigationScopeGate(
    investigation({ scope: [], systems: [] }) as never,
    new Set(),
  );

  assert.equal(result.passed, false);
  assert.ok(result.checks.some((item) => item.name === 'Goal / Scope / Systems 都已填写' && !item.passed));
});

test('scope gate rejects a stale validation snapshot', () => {
  const validation = createUserScopeValidation(
    '替换老的投票工作流',
    ['Proxy Voting'],
    ['ISS Portal', '内部持仓系统'],
  );

  const result = evaluateInvestigationScopeGate(
    investigation({
      scope: ['Proxy Voting', '投票结果'],
      scopeValidation: validation,
    }) as never,
    new Set(),
  );

  assert.equal(result.passed, false);
  assert.ok(result.checks.some((item) => item.name === '已确认内容与当前范围一致' && !item.passed));
});

test('explicit user-provided scope passes without fabricated evidence', () => {
  const validation = createUserScopeValidation(
    '替换老的投票工作流',
    ['Proxy Voting'],
    ['ISS Portal', '内部持仓系统'],
  );

  const result = evaluateInvestigationScopeGate(
    investigation({ scopeValidation: validation }) as never,
    new Set(),
  );

  assert.equal(result.passed, true);
  assert.ok(validation?.scopeFingerprint);
});

test('canonical scope identity ignores ordering and rejects legacy validation without a fingerprint', () => {
  const validation = createUserScopeValidation(
    '替换老的投票工作流',
    ['投票结果', 'Proxy Voting'],
    ['内部持仓系统', 'ISS Portal'],
  );
  assert.ok(validation?.scopeFingerprint);

  const result = evaluateInvestigationScopeGate(
    investigation({
      scope: ['Proxy Voting', '投票结果'],
      systems: ['ISS Portal', '内部持仓系统'],
      scopeValidation: validation,
    }) as never,
    new Set(),
  );
  assert.equal(result.passed, true);

  const legacy = { ...validation };
  delete legacy.scopeFingerprint;
  const legacyResult = evaluateInvestigationScopeGate(
    investigation({ scopeValidation: legacy }) as never,
    new Set(),
  );
  assert.equal(legacyResult.passed, false);
});

test('material-backed scope passes only with known evidence', () => {
  const validation = {
    status: 'validated' as const,
    goal: '替换老的投票工作流',
    scope: ['Proxy Voting'],
    systems: ['ISS Portal'],
    source: 'materials' as const,
    userConfirmed: false,
    evidenceIds: ['ev-001'],
    scopeFingerprint: createUserScopeValidation('替换老的投票工作流', ['Proxy Voting'], ['ISS Portal'])?.scopeFingerprint,
    validatedAt: new Date().toISOString(),
  };

  const investigationWithValidation = investigation({
    systems: ['ISS Portal'],
    scopeValidation: validation,
  });

  assert.equal(
    evaluateInvestigationScopeGate(investigationWithValidation as never, new Set(['ev-001'])).passed,
    true,
  );
  assert.equal(
    evaluateInvestigationScopeGate(investigationWithValidation as never, new Set()).passed,
    false,
  );
});


test('material-backed scope rejects evidence from an older scope generation', () => {
  const currentValidation = createUserScopeValidation(
    '替换老的投票工作流',
    ['Proxy Voting'],
    ['ISS Portal'],
  );
  const investigationWithOldEvidence = investigation({
    scopeValidation: {
      ...currentValidation,
      source: 'materials',
      userConfirmed: false,
      evidenceIds: ['ev-old'],
    },
    evidence: [{
      id: 'ev-old',
      discoveryRunId: 'run-old',
    }],
    discoveryRuns: [{
      id: 'run-old',
      scopeFingerprint: 'different-scope',
    }],
  });

  const result = evaluateInvestigationScopeGate(
    investigationWithOldEvidence as never,
    new Set(['ev-old']),
  );

  assert.equal(result.passed, false);
  assert.ok(result.checks.some((item) => item.name === '确认来源可以追溯' && !item.passed));
});

test('explicit current-state-only scope is recognized', () => {
  assert.equal(
    isCurrentStateOnlyScope(
      '梳理旧系统当前状态，不制定迁移计划',
      ['不设计目标架构、迁移步骤或新旧映射。'],
    ),
    true,
  );
  assert.equal(
    isCurrentStateOnlyScope(
      '为旧系统制定 replatform 方案',
      ['覆盖数据模型、数据源和数据流。'],
    ),
    false,
  );
});


test('formats incomplete scope confirmation as a human-readable message', () => {
  const result = evaluateInvestigationScopeGate(
    investigation() as never,
    new Set(),
  );

  const message = formatScopeGateFailure(result);

  assert.match(message, /已经整理出来，但还没有完成确认/);
  assert.doesNotMatch(message, /没有可比较的确认记录/);
  assert.doesNotMatch(message, /；/);
});
