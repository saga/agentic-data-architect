import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApiErrorSchema,
  ArtifactReviewContractSchema,
  ArtifactLifecycleStatusSchema,
  ArchitectureAssessmentResponseSchema,
  ModernizationResponseSchema,
  ConversationTurnSummarySchema,
  JourneyPlanSchema,
  JourneyWorkflowChangeSchema,
  SessionContextViewSchema,
  SseEventSchema,
  TrajectoryEventSchema,
} from '../src/api/contracts.js';

test('SSE contract rejects malformed status payloads', () => {
  assert.throws(
    () => SseEventSchema.parse({ event: 'status', data: { status: { state: 'running' } } }),
  );
});

test('SSE contract validates checkpoint payloads at the transport boundary', () => {
  assert.throws(
    () => SseEventSchema.parse({
      event: 'checkpoint',
      data: {
        id: 'checkpoint-1',
        turnId: 'turn-1',
        timestamp: '2026-10-06T08:00:00.000Z',
        execution: 0,
        title: '阶段',
        summary: '完成',
        confirmed: [],
        evidenceIds: [],
      },
    }),
    /unknowns|checkpoint/,
  );
});

test('SSE completed event must use the canonical answer summary shape', () => {
  assert.throws(
    () => SseEventSchema.parse({ event: 'completed', data: { answer: 'ok' } }),
  );
});

test('Session context is an explicit API projection, not the persistence object', () => {
  assert.throws(
    () => SessionContextViewSchema.parse({
      name: 'session-1',
      workflow: null,
      userPrompt: '',
      goal: '',
      scope: [],
      systems: [],
      evidence: [],
      findings: [],
      unknowns: [],
      claims: [],
      inputs: [],
      updatedAt: '2026-10-06T08:00:00.000Z',
      discoveryRuns: [],
    }),
    /discoveryRuns/,
  );
});

test('JourneyPlan and workflow edit changes are runtime validated', () => {
  assert.equal(JourneyPlanSchema.parse({
    version: 1,
    source: 'agent',
    generatedAt: '2026-10-06T08:00:00.000Z',
    routes: [{
      id: 'r1',
      title: '继续调查',
      reason: '还有一项直接影响交付的未知。',
      steps: ['检查来源'],
    }],
  }).version, 1);

  assert.equal(JourneyWorkflowChangeSchema.parse({
    type: 'remove-node',
    nodeId: 'target',
  }).type, 'remove-node');
});

test('error contract always carries a stable code and human-readable message', () => {
  assert.deepEqual(
    ApiErrorSchema.parse({ code: 'SCOPE_REQUIRED', error: 'scope is required' }),
    { code: 'SCOPE_REQUIRED', error: 'scope is required' },
  );
});

test('artifact review is revision-aware when metadata is present', () => {
  const review = ArtifactReviewContractSchema.parse({
    artifactType: 'report',
    status: 'pass',
    availability: 'completed',
    score: 90,
    summary: '通过。',
    issues: [],
    reviewedAt: '2026-10-06T08:00:00.000Z',
    artifactHash: 'hash',
    sourceRevision: 'revision',
    artifactVersion: 2,
  });
  assert.equal(review.artifactVersion, 2);
});

test('conversation turn summary is a shared transport contract', () => {
  const turn = ConversationTurnSummarySchema.parse({
    turnId: 'turn-1',
    sessionName: 'session-1',
    status: 'completed',
    createdAt: '2026-10-06T08:00:00.000Z',
    updatedAt: '2026-10-06T08:00:01.000Z',
    question: '检查数据来源',
  });
  assert.equal(turn.status, 'completed');
});


test('artifact lifecycle exposes one shared contract for all result types', () => {
  assert.equal(ArtifactLifecycleStatusSchema.parse('missing'), 'missing');
  assert.equal(ArtifactLifecycleStatusSchema.parse('stale'), 'stale');
  assert.equal(ArtifactLifecycleStatusSchema.parse('current'), 'current');
  assert.equal(ModernizationResponseSchema.parse({ status: 'stale', plan: null, path: null }).status, 'stale');
  assert.equal(ArchitectureAssessmentResponseSchema.parse({ status: 'missing', plan: null, path: null }).status, 'missing');
  assert.equal(ModernizationResponseSchema.parse({ status: 'blocked', plan: null, path: null }).status, 'blocked');
});

test('previously generic trajectory detail payloads now use strict nested contracts', () => {
  assert.throws(() => TrajectoryEventSchema.parse({
    id: 'start-1', turnId: 'turn-1', timestamp: '2026-10-06T08:00:00.000Z',
    type: 'turn_start', name: '开始', details: { sessionId: 's1', unexpected: true },
  }));
  assert.throws(() => TrajectoryEventSchema.parse({
    id: 'assistant-start-1', turnId: 'turn-1', timestamp: '2026-10-06T08:00:00.000Z',
    type: 'assistant_turn_start', name: '模型开始', details: { turnId: 'turn-1', unexpected: true },
  }));
  assert.throws(() => TrajectoryEventSchema.parse({
    id: 'assistant-end-1', turnId: 'turn-1', timestamp: '2026-10-06T08:00:00.000Z',
    type: 'assistant_turn_end', name: '模型完成', details: { turnId: 'turn-1', unexpected: true },
  }));
  assert.throws(() => TrajectoryEventSchema.parse({
    id: 'user-1', turnId: 'turn-1', timestamp: '2026-10-06T08:00:00.000Z',
    type: 'user_input', name: '用户问题', details: { question: '检查', unexpected: true },
  }));
});

test('known trajectory nested payloads reject undeclared fields', () => {
  assert.throws(
    () => TrajectoryEventSchema.parse({
      id: 'tool-1',
      turnId: 'turn-1',
      timestamp: '2026-10-06T08:00:00.000Z',
      type: 'tool_call',
      name: '调用工具',
      details: {
        toolCallId: 'tool-1',
        startedAt: '2026-10-06T08:00:00.000Z',
        unexpectedField: true,
      },
    }),
  );

  assert.doesNotThrow(() => TrajectoryEventSchema.parse({
    id: 'model-1',
    turnId: 'turn-1',
    timestamp: '2026-10-06T08:00:00.000Z',
    type: 'model_call',
    name: '模型调用',
    details: {
      cachedInputTokens: 10,
      contextPercentAtCall: 42,
    },
  }));
});
