import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultViewModelSchema } from '../src/api/results.js';

function baseResult() {
  return {
    schemaVersion: 1,
    session: {
      name: 'test-session',
      workflow: 'legacy-modernization' as const,
      controlVersion: 3,
      agentDisplayName: '秘书',
    },
    checkpoints: [{
      id: 'checkpoint-1',
      turnId: 'turn-1',
      timestamp: '2026-10-06T10:00:00.000Z',
      execution: 0,
      title: '第 1 阶段',
      summary: '已经确认关键数据来源。',
      confirmed: ['PositionSnapshot 是主要输入。'],
      evidenceIds: ['ev-1'],
      unknowns: [],
    }],
    modernization: {
      status: 'available' as const,
      data: {
        version: 2,
        status: 'in_review',
        targetArchitecture: {
          title: '目标架构',
          status: 'draft',
          principles: ['Evidence-backed design'],
          components: [{
            id: 'component-1',
            name: 'Domain Data',
            description: '业务域数据层。',
            sourceAssets: ['legacy_position'],
          }],
          openQuestions: [],
          evidenceIds: ['ev-1'],
        },
        mappings: [],
        validationPlan: {
          checks: [],
          cutoverCriteria: [],
          rollbackCriteria: [],
        },
      },
    },
    assessment: {
      status: 'not_applicable' as const,
    },
    report: {
      status: 'available' as const,
      data: {
        markdown: '# Report',
        review: {
          status: 'pass' as const,
          availability: 'completed' as const,
          score: 90,
          summary: '可直接阅读。',
          issueCount: 0,
        },
      },
    },
  };
}

test('result view model treats checkpoint identity as trajectory metadata', () => {
  const result = ResultViewModelSchema.parse(baseResult());
  assert.equal(result.checkpoints[0]?.id, 'checkpoint-1');
  assert.equal(result.checkpoints[0]?.turnId, 'turn-1');
});

test('one failed result section does not invalidate other results', () => {
  const value = baseResult();
  value.report = {
    status: 'error',
    message: '独立 Reviewer 没有通过。',
  };
  value.modernization = {
    status: 'available',
    data: value.modernization.data,
  };
  const result = ResultViewModelSchema.parse(value);

  assert.equal(result.report.status, 'error');
  assert.equal(result.modernization.status, 'available');
  assert.equal(result.checkpoints.length, 1);
});

test('workflow-specific result sections can be explicitly not applicable', () => {
  const value = baseResult();
  value.session.workflow = 'data-architecture-assessment';
  value.modernization = { status: 'not_applicable' };
  value.assessment = {
    status: 'empty',
    message: '还没有形成架构评估成果。',
  };
  const result = ResultViewModelSchema.parse(value);

  assert.equal(result.modernization.status, 'not_applicable');
  assert.equal(result.assessment.status, 'empty');
});
