import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateQueryPlan } from '../src/analysis/query.js';

test('targeted query validation uses table boundaries', () => {
  assert.doesNotThrow(() => validateQueryPlan({
    reason: 'sample orders',
    dataset: 'orders',
    sql: 'SELECT * FROM orders LIMIT 10',
    expectedEvidence: [],
  }));
  assert.throws(() => validateQueryPlan({
    reason: 'wrong table',
    dataset: 'orders',
    sql: 'SELECT * FROM my_orders LIMIT 10',
    expectedEvidence: [],
  }));
});
