import test from 'node:test';
import assert from 'node:assert/strict';
import { listTrajectoryCheckpoints, summarizeTrajectory, type TrajectoryEvent } from '../src/investigation/trajectory.js';

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

test('recoverable tool failure does not make the completed turn look failed', () => {
  const events: TrajectoryEvent[] = [
    event({
      turnId: 'turn-2',
      timestamp: '2026-10-04T11:00:00.000Z',
      type: 'tool_call',
      name: '调用工具 #1',
      status: 'started',
      details: { toolCallId: 'tool-1' },
    }),
    event({
      turnId: 'turn-2',
      timestamp: '2026-10-04T11:00:01.000Z',
      type: 'tool_result',
      name: '工具失败后返回',
      status: 'failed',
      details: { toolCallId: 'tool-1', error: 'temporary failure' },
    }),
    event({
      turnId: 'turn-2',
      timestamp: '2026-10-04T11:00:02.000Z',
      type: 'turn_end',
      name: 'Agent 本轮结束',
      status: 'completed',
      details: {},
    }),
  ];

  const summary = summarizeTrajectory(events);
  assert.ok(summary);
  assert.equal(summary.state, 'completed');
  assert.equal(summary.waitingOn, undefined);
  assert.equal(summary.pendingToolCount, 0);
});

test('user input request and completion use the same runtime request id', () => {
  const events: TrajectoryEvent[] = [
    event({
      turnId: 'turn-3',
      timestamp: '2026-10-04T12:00:00.000Z',
      type: 'user_input_requested',
      name: 'Agent 请求用户输入',
      status: 'waiting',
      details: {
        requestId: 'runtime-ui-1',
        question: '请选择环境',
      },
    }),
    event({
      turnId: 'turn-3',
      timestamp: '2026-10-04T12:00:02.000Z',
      type: 'user_input_completed',
      name: '用户输入已提供',
      status: 'completed',
      details: {
        requestId: 'runtime-ui-1',
      },
    }),
    event({
      turnId: 'turn-3',
      timestamp: '2026-10-04T12:00:03.000Z',
      type: 'turn_end',
      name: 'Agent 本轮结束',
      status: 'completed',
      details: {},
    }),
  ];

  const summary = summarizeTrajectory(events);
  assert.ok(summary);
  assert.equal(summary.state, 'completed');
  assert.equal(summary.pendingUserInputCount, 0);
});


test('trajectory checkpoints can be listed without affecting runtime state', () => {
  const events: TrajectoryEvent[] = [
    event({
      id: 'checkpoint-1',
      turnId: 'turn-4',
      timestamp: '2026-10-04T13:00:00.000Z',
      type: 'checkpoint',
      name: '阶段小结：Position 来源',
      status: 'completed',
      details: {
        execution: 0,
        title: 'Position 来源',
        summary: '已经确认 Position 主来源及批处理入口。',
        confirmed: ['PositionSnapshot 是主要输入表。'],
        evidenceIds: ['ev-1', 'ev-2'],
        unknowns: ['Market Value 的计算位置'],
        nextStep: '继续追踪 Market Value 的转换逻辑。',
      },
    }),
    event({
      id: 'checkpoint-2',
      turnId: 'turn-4',
      timestamp: '2026-10-04T13:05:00.000Z',
      type: 'checkpoint',
      name: '阶段小结：Market Value',
      status: 'completed',
      details: {
        execution: 1,
        title: 'Market Value',
        summary: '已经找到从 Position 到 Market Value 的主要转换。',
        confirmed: ['转换发生在 valuation service。'],
        evidenceIds: ['ev-3'],
        unknowns: [],
      },
    }),
  ];

  const checkpoints = listTrajectoryCheckpoints(events);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0]?.execution, 0);
  assert.equal(checkpoints[1]?.title, 'Market Value');
});
