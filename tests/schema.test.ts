import { strict as assert } from 'node:assert';
import test from 'node:test';
import { parseAgentAnswer } from '../src/agent/result.js';
import { ClaimSchema } from '../src/evidence/types.js';
import { WorkspaceContextSchema } from '../src/investigation/schemas.js';
import { SemanticAssetSchema } from '../src/semantic/types.js';
import { MessageBodySchema, parseRequest, RequestValidationError } from '../src/api/schemas.js';

test('Zod validates persisted investigation context and nested evidence', () => {
  const result = WorkspaceContextSchema.safeParse({
    schemaVersion: 3,
    name: 'demo',
    userPrompt: '',
    goal: '',
    scope: [],
    systems: [],
    questions: [],
    discoveryRuns: [],
    evidence: [],
    claims: [{ id: 'c1', claim: 'valid', status: 'supported', evidenceIds: [] }],
    findings: [],
    unknowns: [],
    importantInformation: [],
    inputs: [],
    updatedAt: new Date().toISOString(),
  });
  assert.equal(result.success, true);
  assert.equal(ClaimSchema.safeParse({ id: 'c1', claim: 'x', status: 'bad', evidenceIds: [] }).success, false);
});

test('Agent output uses schema defaults and evidence ownership validation', () => {
  const parsed = parseAgentAnswer(JSON.stringify({
    answer: 'ok',
    claims: [
      { claim: 'supported by evidence', status: 'supported', evidenceIds: ['ev-1', 'missing'] },
      { claim: '', status: 'supported', evidenceIds: ['ev-1'] },
      { claim: 'bad status becomes inferred', status: 'nonsense', evidenceIds: [] },
    ],
    unknowns: ['unknown'],
    followUpQuestions: [],
  }), new Set(['ev-1']));

  assert.equal(parsed.claims.length, 2);
  assert.deepEqual(parsed.claims[0].evidenceIds, ['ev-1']);
  assert.equal(parsed.claims[0].status, 'inferred');
  assert.equal(parsed.claims[1].status, 'unknown');
  assert.equal(parsed.droppedEvidenceRefs.length, 1);
});

test('API request bodies are schema validated before workflow code', () => {
  assert.deepEqual(parseRequest(MessageBodySchema, { message: ' hello ', turnId: 't1' }), {
    message: 'hello',
    guided: false,
    turnId: 't1',
  });
  assert.throws(
    () => parseRequest(MessageBodySchema, { turnId: 't1' }),
    (error) => error instanceof RequestValidationError && error.message.includes('请求参数不正确'),
  );
});


test('Semantic assets are runtime validated', () => {
  assert.equal(SemanticAssetSchema.safeParse({ id: 'sv:1', kind: 'semantic_view', provider: 'snowflake', name: 'Position' }).success, true);
  assert.equal(SemanticAssetSchema.safeParse({ id: 'sv:1', kind: 'unknown', provider: 'snowflake', name: 'Position' }).success, false);
});
