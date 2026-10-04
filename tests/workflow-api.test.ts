import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CreateSessionBodySchema,
  JourneyAiRequestSchema,
  MessageBodySchema,
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
         routes: [{ outcome: 'success', target: 'done' }],
      }],
    },
    selectedNodeId: 'intake',
  });
  assert.equal(parsed.messages?.length, 2);
  assert.equal(parsed.selectedNodeId, 'intake');
  assert.throws(() => JourneyAiRequestSchema.parse({
    prompt: '继续',
    messages: Array.from({ length: 13 }, () => ({ role: 'user', content: 'x' })),
  }));
});

test('journey map AI request has no user-visible mode or scope contract', () => {
  assert.deepEqual(
    JourneyAiRequestSchema.parse({
      prompt: '把资料核对和评审之间增加一个人工确认步骤。',
    }),
    {
      prompt: '把资料核对和评审之间增加一个人工确认步骤。',
    },
  );
  assert.throws(() => JourneyAiRequestSchema.parse({ mode: 'modify', prompt: 'hello' }));
  assert.throws(() => JourneyAiRequestSchema.parse({ prompt: '' }));
});


test('message requests accept either a user message or a structured route selection', () => {
  assert.deepEqual(MessageBodySchema.parse({ message: '继续查 Position' }), { message: '继续查 Position', guided: false });
  assert.deepEqual(MessageBodySchema.parse({ routeId: 'route-lineage' }), { routeId: 'route-lineage', guided: false });
  assert.throws(() => MessageBodySchema.parse({}));
});
