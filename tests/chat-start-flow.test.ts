import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const controller = await fs.readFile(new URL('../web/src/app/useInvestigationController.ts', import.meta.url), 'utf8');
const dialog = await fs.readFile(new URL('../web/src/components/InvestigationDialogs.tsx', import.meta.url), 'utf8');

test('new investigation auto-starts when both mission inputs are complete', () => {
  assert.match(controller, /if \(purpose && expectedResult\)/);
  assert.match(controller, /pendingInitialAutoStartRef\.current =/);
  assert.match(controller, /message: '请按照已经确认的任务目的和期望结果直接开始调查。'/);
  assert.match(controller, /const hasInitialStartRepository = result\.control\.research\.githubRepositories/);
  assert.match(controller, /void send\(initialAutoStart\.message\)/);
  assert.match(controller, /const send = async \(text\?: string, routeId\?: string, guided = false, turnIdOverride\?: string\)/);
});

test('new-investigation dialog no longer tells users to type a separate start prompt', () => {
  assert.match(dialog, /创建调查会直接开始/);
  assert.doesNotMatch(dialog, /创建工作空间不会直接开始调查/);
});


test('results page does not expose the obsolete report response variable', async () => {
  const results = await fs.readFile(new URL('../web/src/components/InvestigationResultsPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(results, /if \(reportResponse\.ok\)/);
  assert.match(results, /reportPayload !== undefined/);
  assert.match(results, /结果页面的一部分暂时无法读取/);
});

test('important report regeneration requires confirmation', async () => {
  const results = await fs.readFile(new URL('../web/src/components/InvestigationResultsPage.tsx', import.meta.url), 'utf8');
  assert.match(results, /Modal\.confirm\(/);
  assert.match(results, /重新生成报告？/);
});

test('Work Map remains reachable from the workspace and results navigation', async () => {
  const topbar = await fs.readFile(new URL('../web/src/components/InvestigationTopbar.tsx', import.meta.url), 'utf8');
  const workspace = await fs.readFile(new URL('../web/src/components/InvestigationWorkspace.tsx', import.meta.url), 'utf8');
  const results = await fs.readFile(new URL('../web/src/components/InvestigationResultsPage.tsx', import.meta.url), 'utf8');
  assert.match(topbar, /工作地图/);
  assert.match(workspace, /onOpenJourney=\{\(\) => navigatePage\('journey'\)\}/);
  assert.match(results, /onOpenJourney: \(\) => void/);
});
