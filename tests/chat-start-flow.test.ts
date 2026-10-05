import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const controller = await fs.readFile(new URL('../web/src/app/useInvestigationController.ts', import.meta.url), 'utf8');
const dialog = await fs.readFile(new URL('../web/src/components/InvestigationDialogs.tsx', import.meta.url), 'utf8');

test('new investigation auto-starts when both mission inputs are complete', () => {
  assert.match(controller, /if \(purpose && expectedResult\)/);
  assert.match(controller, /pendingInitialAutoStartRef\.current =/);
  assert.match(controller, /message: '为什么做：' \+ purpose/);
  assert.match(controller, /void send\(initialAutoStart\.message\)/);
});

test('new-investigation dialog no longer tells users to type a separate start prompt', () => {
  assert.match(dialog, /创建调查会直接开始/);
  assert.doesNotMatch(dialog, /创建工作空间不会直接开始调查/);
});
