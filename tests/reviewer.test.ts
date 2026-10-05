import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ArtifactReviewSchema,
  summarizeReviewFailure,
} from '../src/analysis/reviewer.js';

const review = {
  artifactType: 'report' as const,
  status: 'fail' as const,
  score: 62,
  summary: '报告没有形成清晰的结论。',
  issues: [
    {
      category: 'goal_alignment' as const,
      severity: 'high' as const,
      description: '用户要求 replatform 方案，但报告只描述现状。',
      suggestion: '明确当前已经完成的部分以及下一步目标架构工作。',
    },
    {
      category: 'readability' as const,
      severity: 'medium' as const,
      description: '报告暴露了内部对象名称。',
      suggestion: '改成面向用户的自然语言。',
    },
  ],
  reviewedAt: new Date().toISOString(),
};

test('artifact review schema accepts a valid review result', () => {
  assert.deepEqual(ArtifactReviewSchema.parse(review), review);
});

test('review failure summary keeps concrete issues and avoids empty advice', () => {
  assert.equal(
    summarizeReviewFailure(review),
    '用户要求 replatform 方案，但报告只描述现状。；报告暴露了内部对象名称。',
  );
});
