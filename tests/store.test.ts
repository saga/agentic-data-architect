import assert from 'node:assert/strict';
import { test } from 'node:test';
import { investigationRoot } from '../src/investigation/store.js';

test('investigation names cannot escape the data directory', () => {
  assert.throws(() => investigationRoot('../outside'));
  assert.throws(() => investigationRoot('a/b'));
  assert.doesNotThrow(() => investigationRoot('proxy-voting_2026'));
});
