import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUserScopeValidation,
  evaluateInvestigationScopeGate,
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
