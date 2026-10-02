import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-data-architect-routes-'));
process.env.WORKSPACE_DIR = workspaceDir;

const { parseAgentAnswer } = await import('../src/agent/result.js');
const {
  newInvestigation,
  saveInvestigation,
  loadInvestigation,
  updateInvestigationJourneyPlan,
  updateInvestigationWorkflow,
} = await import('../src/investigation/store.js');

test('Agent can return multiple optional route suggestions', () => {
  const parsed = parseAgentAnswer(JSON.stringify({
    answer: '可以从血缘或业务定义两个方向继续。',
    claims: [],
    unknowns: ['Position source of truth'],
    followUpQuestions: [],
    routeOptions: [
      {
        id: 'route-lineage',
        title: '先追 Position 数据血缘',
        reason: '先确认真实来源和中间转换。',
        steps: ['查 Position 来源', '核对关键 SQL/ETL', '确认下游使用'],
      },
      {
        id: 'route-semantic',
        title: '先确认 Position 业务定义',
        reason: '先解决同名数据是否代表同一个业务对象。',
        steps: ['查业务定义', '比较候选来源', '确认 source of truth'],
      },
    ],
  }), new Set());

  assert.equal(parsed.routeOptions.length, 2);
  assert.equal(parsed.routeOptions[0]?.title, '先追 Position 数据血缘');
  assert.deepEqual(parsed.routeOptions[1]?.steps, ['查业务定义', '比较候选来源', '确认 source of truth']);
});

test('dynamic route plan persists independently from investigation facts', async () => {
  const investigation = newInvestigation('adaptive-routes', 'Trace Position');
  investigation.goal = 'Find the source of Position';
  await saveInvestigation(investigation);

  await updateInvestigationJourneyPlan('adaptive-routes', {
    version: 1,
    source: 'agent',
    generatedAt: new Date().toISOString(),
    routes: [{
      id: 'route-1',
      title: '先查血缘',
      reason: '确认真实来源。',
      steps: ['查来源', '查转换'],
    }],
  }, null);

  const stale = await loadInvestigation('adaptive-routes');
  stale.goal = 'A stale Agent turn changed the goal';
  await saveInvestigation(stale);

  const reloaded = await loadInvestigation('adaptive-routes');
  assert.equal(reloaded.goal, 'A stale Agent turn changed the goal');
  assert.equal(reloaded.journeyPlan?.routes[0]?.title, '先查血缘');

  const changed = await updateInvestigationWorkflow('adaptive-routes', 'data-architecture-assessment');
  assert.equal(changed.journeyPlan, undefined);
});

test.after(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});
