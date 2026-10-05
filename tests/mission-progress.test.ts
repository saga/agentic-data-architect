import assert from 'node:assert/strict';
import test from 'node:test';

import {
  missionHasOpenDeliverables,
  type MissionProgress,
} from '../src/workflow/mission-progress.js';

function progress(statuses: Array<'covered' | 'in_progress' | 'not_started' | 'not_tracked'>): MissionProgress {
  return {
    covered: statuses.filter((status) => status === 'covered').length,
    total: statuses.length,
    percent: 0,
    deliverables: statuses.map((status, index) => ({
      id: 'd-' + index,
      title: 'Deliverable ' + index,
      description: 'test',
      required: true,
      status,
      detail: status,
    })),
  };
}

test('mission has open work while a required deliverable is not covered', () => {
  assert.equal(missionHasOpenDeliverables(progress(['covered', 'in_progress'])), true);
  assert.equal(missionHasOpenDeliverables(progress(['covered', 'not_started'])), true);
});

test('mission stops auto-continuation when the remaining result cannot be measured automatically', () => {
  assert.equal(missionHasOpenDeliverables(progress(['covered', 'covered'])), false);
  assert.equal(missionHasOpenDeliverables(progress(['covered', 'not_tracked'])), false);
});
