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


test('journey map AI request only accepts the two map operations', () => {
  assert.deepEqual(
    JourneyAiRequestSchema.parse({
      mode: 'modify',
      prompt: '把资料核对和评审之间增加一个人工确认步骤。',
    }),
    {
      mode: 'modify',
      prompt: '把资料核对和评审之间增加一个人工确认步骤。',
    },
  );
  assert.throws(() => JourneyAiRequestSchema.parse({ mode: 'chat', prompt: 'hello' }));
  assert.throws(() => JourneyAiRequestSchema.parse({ mode: 'generate', prompt: '' }));
});
