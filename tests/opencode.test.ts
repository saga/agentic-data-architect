import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod';
import { buildOpenCodeCliPrompt, parseOpenCodeModel } from '../src/agent/opencode.js';

test('OpenCode CLI prompt preserves system instructions before the user task', () => {
  const prompt = buildOpenCodeCliPrompt(
    {
      missionPrompt: 'Mission: inspect the current data architecture.',
      systemPrompt: 'System rule: use evidence-backed conclusions only.',
    },
    'Explain the current lineage for customer_id.',
    'Workflow: inspect current state first.',
    false,
    true,
  );

  const systemIndex = prompt.indexOf('System rule: use evidence-backed conclusions only.');
  const userIndex = prompt.indexOf('当前用户任务：');
  const questionIndex = prompt.indexOf('Explain the current lineage for customer_id.');

  assert.ok(systemIndex >= 0);
  assert.ok(userIndex > systemIndex);
  assert.ok(questionIndex > userIndex);
  assert.match(prompt, /Graphify/);
});

test('OpenCode CLI prompt includes structured-output guidance when schema is supplied', () => {
  const prompt = buildOpenCodeCliPrompt(
    {
      missionPrompt: 'Mission',
      systemPrompt: 'System',
    },
    'Return the stage result.',
    '',
    false,
    false,
    z.object({ answer: z.string() }),
  );

  assert.match(prompt, /JSON Schema/);
  assert.match(prompt, /"answer"/);
});

test('OpenCode model references are converted to CLI provider/model format', () => {
  assert.deepEqual(parseOpenCodeModel('opencode:opencode/muse-spark-1.3-contributor-free'), {
    providerId: 'opencode',
    modelId: 'muse-spark-1.3-contributor-free',
  });
});
