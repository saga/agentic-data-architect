#!/usr/bin/env tsx
/**
 * Mission Script Gate CLI。
 *
 * 用法：
 *   npm run gate:mission -- <session>
 *
 * 这个脚本只读取持久化 Mission，不调用模型，也不会替用户确认。
 * exit code 0 = Mission 已确认且可执行；exit code 1 = 需要先确认 Mission。
 */
import { loadInvestigation } from '../src/investigation/store.js';
import { evaluateMissionGate, formatMissionGateFailure } from '../src/workflow/mission-gate.js';

const [name] = process.argv.slice(2);
if (!name) {
  console.error('用法：npm run gate:mission -- <session>');
  process.exit(2);
}

const investigation = await loadInvestigation(name);
const result = evaluateMissionGate(investigation.mission);

console.log('\n[' + (result.passed ? 'PASS' : 'FAIL') + '] Mission');
for (const item of result.checks) {
  console.log('  ' + (item.passed ? '✓' : '✗') + ' ' + item.name + ' — ' + item.detail);
}
if (!result.passed) {
  console.log('\n' + formatMissionGateFailure(result));
}
process.exitCode = result.passed ? 0 : 1;
