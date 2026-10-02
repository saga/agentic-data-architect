import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreateSessionBodySchema, UpdateWorkflowBodySchema } from '../src/api/schemas.js';

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
