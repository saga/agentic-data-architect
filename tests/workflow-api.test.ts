import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CreateSessionBodySchema,
  JourneyAiRequestSchema,
  UpdateWorkflowBodySchema,
} from '../src/api/schemas.js';

test('empty workflow selection means autonomous mode', () => {
  assert.equal(CreateSessionBodySchema.parse({ name: 'demo', workflow: '' }).workflow, null);
  assert.equal(UpdateWorkflowBodySchema.parse({ workflow: '' }).workflow, null);
});

test('explicit null workflow means autonomous mode', () => {
  assert.equal(CreateSessionBodySchema.parse({ workflow: null }).workflow, null);
  assert.equal(UpdateWorkflowBodySchema.parse({ workflow: null }).workflow, null);
});

test('known workflow ids remain supported', () => {
  assert.equal(
    CreateSessionBodySchema.parse({ workflow: 'legacy-modernization' }).workflow,
    'legacy-modernization',
  );
});


test('journey map AI request accepts bounded multi-turn history', () => {
  const parsed = JourneyAiRequestSchema.parse({
    mode: 'modify',
    prompt: '再增加一个人工评审。',
    messages: [
      { role: 'user', content: '先保留当前路线。' },
      { role: 'assistant', content: '好的，保持现有结构。' },
    ],
    definition: {
      id: 'demo',
      start: 'intake',
      nodes: [{
        id: 'intake',
        type: 'task',
        title: '明确目标',
        visible: true,
        completion: 'agent',
        routes: [{ outcome: 'success', target: 'done' }],
      }],
    },
  });
  assert.equal(parsed.messages?.length, 2);
  assert.throws(() => JourneyAiRequestSchema.parse({
    mode: 'modify',
    prompt: '继续',
    messages: Array.from({ length: 13 }, () => ({ role: 'user', content: 'x' })),
  }));
});

test('journey map AI request only accepts the two map operations', () => {
  assert.deepEqual(
    JourneyAiRequestSchema.parse({
      mode: 'modify',
      prompt: '把资料核对和评审之间增加一个人工确认步骤。',
    }),
    {
      mode: 'modify',
      prompt: '把资料核对和评审之间增加一个人工确认步骤。',
      scope: 'workflow',
    },
  );
  assert.throws(() => JourneyAiRequestSchema.parse({ mode: 'chat', prompt: 'hello' }));
  assert.throws(() => JourneyAiRequestSchema.parse({ mode: 'generate', prompt: '' }));
});
