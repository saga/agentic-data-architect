#!/usr/bin/env tsx
/**
 * Legacy Modernization Script Gate CLI。
 *
 * 用法：
 *   npm run gate:modernization -- <session> <target|mapping|validation|all>
 *
 * exit code 0 = 所有指定 Gate 通过；exit code 1 = 至少一个 Gate 未通过。
 */
import { runModernizationGate, type ModernizationGateStage } from '../src/workflow/modernization-gate.js';

const [name, requestedStage] = process.argv.slice(2);
const stages: ModernizationGateStage[] = ['target', 'mapping', 'validation'];

if (!name) {
  console.error('用法：npm run gate:modernization -- <session> <target|mapping|validation|all>');
  process.exit(2);
}

const selected = requestedStage === 'all' || !requestedStage
  ? stages
  : stages.includes(requestedStage as ModernizationGateStage)
    ? [requestedStage as ModernizationGateStage]
    : [];

if (!selected.length) {
  console.error('stage 必须是 target、mapping、validation 或 all。');
  process.exit(2);
}

let failed = false;
for (const stage of selected) {
  const result = await runModernizationGate(name, stage);
  console.log('\\n[' + (result.passed ? 'PASS' : 'FAIL') + '] ' + stage);
  for (const item of result.checks) {
    console.log('  ' + (item.passed ? '✓' : '✗') + ' ' + item.name + ' — ' + item.detail);
  }
  if (!result.passed) failed = true;
}

process.exitCode = failed ? 1 : 0;