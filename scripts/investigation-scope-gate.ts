#!/usr/bin/env tsx
/**
 * Investigation Scope Script Gate。
 *
 * 用法：
 *   npm run gate:scope -- <session>
 *
 * exit code 0 = Goal / Scope / Systems 均已确认且可追溯；
 * exit code 1 = 至少一个检查未通过。
 */
import { runInvestigationScopeGate } from '../src/workflow/scope-gate.js';

const [name] = process.argv.slice(2);
if (!name) {
  console.error('用法：npm run gate:scope -- <session>');
  process.exit(2);
}

const result = await runInvestigationScopeGate(name);
console.log('\n[' + (result.passed ? 'PASS' : 'FAIL') + '] investigation scope');
for (const item of result.checks) {
  console.log('  ' + (item.passed ? '✓' : '✗') + ' ' + item.name + ' — ' + item.detail);
}
process.exitCode = result.passed ? 0 : 1;
