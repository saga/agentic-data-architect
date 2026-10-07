import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import {
  listCodeBuddyModels,
  normalizeCodeBuddyModel,
} from '../src/agent/codebuddy.js';

test('CodeBuddy model filter preserves configured order', () => {
  const models = listCodeBuddyModels([
    'Glm-5.3-flash',
    'DeepSeek-V4.1-flash',
    'Space-Bunny',
  ]);

  assert.deepEqual(
    models.map((model) => model.id),
    [
      'codebuddy:Glm-5.3-flash',
      'codebuddy:DeepSeek-V4.1-flash',
      'codebuddy:Space-Bunny',
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
    'Glm-5.3-flash',
    'DeepSeek-V4.1-flash',
    'Space-Bunny',
  ]);
});
