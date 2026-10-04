import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionResponseBodySchema } from '../src/api/schemas.js';

test('permission response defaults to one-time approval', () => {
  const result = PermissionResponseBodySchema.parse({
    turnId: 'turn-1',
    requestId: 'request-1',
    allowed: true,
  });

  assert.equal(result.scope, 'once');
});

test('permission response accepts session-scoped approval', () => {
  const result = PermissionResponseBodySchema.parse({
    turnId: 'turn-1',
    requestId: 'request-1',
    allowed: true,
    scope: 'session',
  });

  assert.equal(result.scope, 'session');
});

test('permission response rejects session scope when denying', () => {
  const result = PermissionResponseBodySchema.safeParse({
    turnId: 'turn-1',
    requestId: 'request-1',
    allowed: false,
    scope: 'session',
  });

  assert.equal(result.success, false);
});
