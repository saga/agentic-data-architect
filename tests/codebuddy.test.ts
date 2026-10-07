import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import {
  listCodeBuddyModels,
  normalizeCodeBuddyModel,
} from '../src/agent/codebuddy.js';

test('CodeBuddy model filter preserves configured order', () => {
  const models = listCodeBuddyModels([
    'glm-5.3-flash',
    'deepseek-v4.1-flash',
    'space-bunny',
  ]);

  assert.deepEqual(
    models.map((model) => model.id),
    [
      'codebuddy:glm-5.3-flash',
      'codebuddy:deepseek-v4.1-flash',
      'codebuddy:space-bunny',
    ],
  );
});

test('CodeBuddy model normalization accepts runtime-prefixed models', () => {
  assert.equal(
    normalizeCodeBuddyModel('codebuddy:DeepSeek-V4.1-flash'),
    'DeepSeek-V4.1-flash',
  );
});

test('CodeBuddy deployment defaults are configuration driven', () => {
  assert.equal(config.codeBuddyDefaultModel, 'Glm-5.3-flash');
  assert.deepEqual(config.codeBuddyModelAllowlist, [
    'glm-5.3-flash',
    'deepseek-v4.1-flash',
    'space-bunny',
  ]);
});
