import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProviderFailure } from '../src/agent/provider-health.js';

test('classifies Copilot monthly quota exhaustion as a durable provider failure', () => {
  assert.equal(
    classifyProviderFailure(new Error('You have exceeded your monthly quota (Request ID: AF32:16A175:5842F8:68D670:6AC81DD5)')),
    'quota_exhausted',
  );
});

test('does not misclassify local Skill/manifest errors as provider failures', () => {
  assert.equal(
    classifyProviderFailure(new Error('Skill structural-analysis 缺少有效的文件头（--- ... ---）')),
    undefined,
  );
});

test('classifies provider connection and authentication errors', () => {
  assert.equal(classifyProviderFailure(new Error('fetch failed: ECONNREFUSED')), 'connection_error');
  assert.equal(classifyProviderFailure(new Error('HTTP 401 unauthorized')), 'authentication_error');
});
