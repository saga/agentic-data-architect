import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeMissionCompletion,
  reviewMissionCompletion,
} from '../src/workflow/mission-completion.js';
import type { MissionContract } from '../src/investigation/schemas.js';
import type { MissionProgress } from '../src/workflow/mission-progress.js';

const mission: MissionContract = {
  version: 1,
  purpose: '理解 IBM 老系统当前的数据架构，为 replatform 决策提供依据。',
  expectedResult: '形成当前 Data Source、Data Flow、Data Model 的可靠说明。',
  deliverables: [
    {
      id: 'data-source',
      title: 'Data Source',
      description: '关键数据来源。',
      required: true,
    },
    {
      id: 'data-flow',
      title: 'Data Flow',
      description: '关键数据流向。',
      required: true,
    },
  ],
  status: 'confirmed',
  confirmedAt: '2026-10-05T00:00:00.000Z',
  confirmedBy: 'user',
};

function progress(statusA: 'not_started' | 'in_progress' | 'covered' | 'not_tracked'): MissionProgress {
  return {
    covered: statusA === 'covered' ? 2 : 1,
    total: 2,
    percent: statusA === 'covered' ? 100 : 50,
    deliverables: [
      {
        id: 'data-source',
        title: 'Data Source',
        description: '关键数据来源。',
        required: true,
        status: statusA,
        detail: statusA,
      },
      {
        id: 'data-flow',
        title: 'Data Flow',
        description: '关键数据流向。',
        required: true,
        status: statusA === 'covered' ? 'covered' : 'in_progress',
        detail: statusA,
      },
    ],
  };
}

test('Mission Completion blocks when a required deliverable is still open', async () => {
  const result = await reviewMissionCompletion({
    mission,
    progress: progress('in_progress'),
    resultSummary: {
      evidenceCount: 4,
      findingCount: 2,
      claimCount: 3,
      unknowns: [],
    },
  });

  assert.equal(result.completed, false);
  assert.equal(result.requiredDeliverablesResolved, false);
  assert.match(result.reason, /必需交付物/);
});

test('Mission Completion blocks when an affected unknown needs the user', async () => {
  const result = await reviewMissionCompletion({
    mission,
    progress: progress('covered'),
    resultSummary: {
      evidenceCount: 6,
      findingCount: 3,
      claimCount: 4,
      unknowns: ['业务规则需要业务方决定。'],
    },
    unknownReviews: [{
      unknown: '业务规则需要业务方决定。',
      affectsMission: true,
      worthInvestigating: true,
      canAgentResolve: false,
      action: 'ask_user',
      reason: '需要用户决策。',
    }],
  });

  assert.equal(result.completed, false);
  assert.equal(result.blockedByUser, true);
  assert.match(result.reason, /用户补充输入/);
});

test('Mission Completion normalizes semantic result support conservatively', () => {
  assert.deepEqual(
    normalizeMissionCompletion({
      result_supported: { type: 'noul', noul: 0.9 },
    }),
    { resultSupported: true, support: 0.9 },
  );
  assert.deepEqual(
    normalizeMissionCompletion({
      result_supported: { type: 'noul', noul: 0.3 },
    }),
    { resultSupported: false, support: 0.3 },
  );
});
