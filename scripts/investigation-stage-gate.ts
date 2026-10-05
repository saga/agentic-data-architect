#!/usr/bin/env tsx
/**
 * Investigation Stage Script Gate CLI。
 *
 * 用法：
 *   npm run gate:stage -- <session>
 *
 * 这个脚本重新检查最近一次已记录的 Stage Gate 输入，而不是重新相信 Agent 的“阶段小结”。
 * exit code 0 = 最近阶段通过；exit code 1 = 最近阶段未通过或没有 Stage Gate 记录。
 */
import { readTrajectory } from '../src/investigation/trajectory.js';
import { evaluateInvestigationStageGate, type StageGateInput } from '../src/workflow/stage-gate.js';

const [name] = process.argv.slice(2);
if (!name) {
  console.error('用法：npm run gate:stage -- <session>');
  process.exit(2);
}

const events = await readTrajectory(name, { limit: 5000 });
const stageEvents = events.filter((event) => event.type === 'stage_gate');
const latest = stageEvents.at(-1);

if (!latest || !latest.details.input || typeof latest.details.input !== 'object') {
  console.error('[FAIL] 没有可重新检查的 Stage Gate 记录。');
  process.exitCode = 1;
} else {
  const result = evaluateInvestigationStageGate(latest.details.input as StageGateInput);
  console.log('\n[' + (result.passed ? 'PASS' : 'FAIL') + '] investigation stage');
  for (const item of result.checks) {
    console.log('  ' + (item.passed ? '✓' : '✗') + ' ' + item.name + ' — ' + item.detail);
  }
  process.exitCode = result.passed ? 0 : 1;
}
