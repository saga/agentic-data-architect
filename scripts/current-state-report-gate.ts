#!/usr/bin/env tsx
/** Current-State Report Script Gate；exit 0 才允许把调查结果当成正式报告。 */
import { runCurrentStateReportGate } from '../src/workflow/report-gate.js';

const [name] = process.argv.slice(2);
if (!name) {
  console.error('用法：npm run gate:report -- <session>');
  process.exit(2);
}

const result = await runCurrentStateReportGate(name);
console.log('\n[' + (result.passed ? 'PASS' : 'FAIL') + '] current-state report');
for (const item of result.checks) {
  console.log('  ' + (item.passed ? '✓' : '✗') + ' ' + item.name + ' — ' + item.detail);
}
process.exitCode = result.passed ? 0 : 1;
