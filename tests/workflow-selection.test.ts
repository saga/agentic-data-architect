import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-data-architect-workflow-'));
process.env.WORKSPACE_DIR = workspaceDir;

const {
  newInvestigation,
  saveInvestigation,
  loadInvestigation,
  updateInvestigationWorkflow,
} = await import('../src/investigation/store.js');

test('new investigations default to autonomous mode', () => {
  const investigation = newInvestigation('autonomous');
  assert.equal(investigation.workflow, null);
});

test('current data architecture workflow can be selected', async () => {
  const investigation = newInvestigation('current-data', '分析当前数据架构');
  await saveInvestigation(investigation);
  const selected = await updateInvestigationWorkflow('current-data', 'current-data-architecture');
  assert.equal(selected.workflow, 'current-data-architecture');
});
test('workflow can be changed without replacing investigation state', async () => {
  const investigation = newInvestigation('switchable', 'Trace Position');
  investigation.goal = 'Find the source of Position';
  investigation.scope = ['Position'];
  investigation.unknowns = ['source of truth'];
  investigation.copilotSessionId = 'old-session';
  investigation.copilotConfigurationVersion = 4;
  await saveInvestigation(investigation);

  const assessment = await updateInvestigationWorkflow('switchable', 'data-architecture-assessment');
  assert.equal(assessment.workflow, 'data-architecture-assessment');
  assert.equal(assessment.goal, 'Find the source of Position');
  assert.deepEqual(assessment.scope, ['Position']);
  assert.deepEqual(assessment.unknowns, ['source of truth']);
  assert.equal(assessment.copilotSessionId, undefined);
  assert.equal(assessment.copilotConfigurationVersion, undefined);

  const staleAgentSnapshot = await loadInvestigation('switchable');
  const autonomous = await updateInvestigationWorkflow('switchable', null);
  assert.equal(autonomous.workflow, null);
  assert.equal(autonomous.goal, 'Find the source of Position');

  // A stale Agent turn must not restore the old workflow when it saves its state.
  staleAgentSnapshot.importantInformation.push('agent completed a turn');
  await saveInvestigation(staleAgentSnapshot);

  const reloaded = await loadInvestigation('switchable');
  assert.equal(reloaded.workflow, null);
  assert.equal(reloaded.goal, 'Find the source of Position');
});

test.after(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});
