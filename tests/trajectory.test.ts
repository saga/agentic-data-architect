import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrajectory, type TrajectoryEvent } from '../src/investigation/trajectory.js';

function event(overrides: Partial<TrajectoryEvent>): TrajectoryEvent {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    turnId: overrides.turnId ?? 'turn-1',
    timestamp: overrides.timestamp ?? '2026-10-04T10:00:00.000Z',
    type: overrides.type ?? 'status',
    name: overrides.name ?? '测试事件',
    status: overrides.status,
    ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.inputTokens !== undefined ? { inputTokens: overrides.inputTokens } : {}),
    ...(overrides.outputTokens !== undefined ? { outputTokens: overrides.outputTokens } : {}),
    ...(overrides.premiumRequestCost !== undefined ? { premiumRequestCost: overrides.premiumRequestCost } : {}),
    details: overrides.details ?? {},
  };
}

test('trajectory overall metrics include history but runtime state only follows latest turn', () => {
  const events: TrajectoryEvent[] = [
    event({
      id: 'old-permission',
      turnId: 'turn-old',
      timestamp: '2026-10-04T09:00:00.000Z',
      type: 'permission',
      name: '等待确认：shell',
      status: 'waiting',
      details: { requestId: 'permission-old', kind: 'shell' },
    }),
    event({
      id: 'old-error',
      turnId: 'turn-old',
      timestamp: '2026-10-04T09:01:00.000Z',
      type: 'error',
      name: 'Agent 执行失败',
      status: 'failed',
      details: { error: 'old timeout' },
    }),
    event({
      id: 'new-model',
      turnId: 'turn-new',
      timestamp: '2026-10-04T10:00:00.000Z',
      type: 'model_call',
      name: '模型调用 #1',
      status: 'completed',
      model: 'gpt-6-luna',
      inputTokens: 100,
      outputTokens: 20,
      details: {},
    }),
    event({
      id: 'new-end',
      turnId: 'turn-new',
      timestamp: '2026-10-04T10:00:02.000Z',
      type: 'turn_end',
      name: 'Agent 本轮结束',
      status: 'completed',
      details: {},
    }),
    event({
      id: 'new-save',
      turnId: 'turn-new',
      timestamp: '2026-10-04T10:00:03.000Z',
      type: 'status',
      name: '结果已保存',
      status: 'completed',
      details: {},
    }),
  ];

  const summary = summarizeTrajectory(events);
  assert.ok(summary);
  assert.equal(summary.state, 'completed');
  assert.equal(summary.waitingOn, undefined);
  assert.equal(summary.pendingPermissionCount, 0);
  assert.equal(summary.lastActivity, '结果已保存');
  assert.equal(summary.totalTokens, 120);
  assert.equal(summary.model, 'gpt-6-luna');
});
