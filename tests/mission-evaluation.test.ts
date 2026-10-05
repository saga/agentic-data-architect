import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMissionClarityPrompt,
  normalizeMissionClarity,
} from '../src/workflow/mission-evaluation.js';

test('mission clarity prompt keeps purpose and expected result explicit', () => {
  const prompt = buildMissionClarityPrompt(
    '理解旧系统，为迁移决策提供依据。',
    '形成当前 Data Source、Data Flow、Data Model 的说明。',
  );
  assert.match(prompt, /任务目的：/);
  assert.match(prompt, /期望结果：/);
  assert.match(prompt, /两者应该一致/);
});

test('mission clarity requires all three semantic checks to be strong enough', () => {
  const clear = normalizeMissionClarity({
    purpose_clarity: { type: 'noul', noul: 0.9 },
    expected_result_clarity: { type: 'noul', noul: 0.88 },
    alignment: { type: 'noul', noul: 0.91 },
  });
  assert.equal(clear.clear, true);

  const unclear = normalizeMissionClarity({
    purpose_clarity: { type: 'noul', noul: 0.9 },
    expected_result_clarity: { type: 'noul', noul: 0.55 },
    alignment: { type: 'noul', noul: 0.9 },
  });
  assert.equal(unclear.clear, false);
  assert.match(unclear.reason, /期望结果/);
});
