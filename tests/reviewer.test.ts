import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ArtifactReviewSchema,
  summarizeReviewFailure,
} from '../src/analysis/reviewer.js';


const revisionFields = {
  artifactVersion: 1,
  artifactHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  sourceRevision: '0123456789abcdef01234567',
};

const review = {
  artifactType: 'report' as const,
  status: 'fail' as const,
  availability: 'completed' as const,
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
  ...revisionFields,
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


test('unavailable review can be persisted as a valid review record', () => {
  const unavailable = {
    artifactType: 'report' as const,
    status: 'fail' as const,
    availability: 'unavailable' as const,
    score: 0,
    summary: '独立 Reviewer 暂时没有返回可验证的审核结果。',
    issues: [{
      category: 'consistency' as const,
      severity: 'high' as const,
      description: 'Reviewer 没有返回可验证的结构化审核结果。',
      suggestion: '稍后重新生成并审核结果；原始调查内容没有因此被修改。',
    }],
    reviewedAt: new Date().toISOString(),
    ...revisionFields,
  };

  assert.equal(ArtifactReviewSchema.parse(unavailable).availability, 'unavailable');
});
