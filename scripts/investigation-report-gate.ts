#!/usr/bin/env tsx
/** 调查最终报告的确定性检查；exit 0 才表示当前结果具备生成条件。 */
import { runInvestigationReportGate } from '../src/workflow/report-gate.js';

const [name] = process.argv.slice(2);
if (!name) {
  console.error('用法：npm run gate:report -- <session>');
  process.exit(2);
}

const result = await runInvestigationReportGate(name);
console.log('\n[' + (result.passed ? 'PASS' : 'FAIL') + '] investigation report');
for (const item of result.checks) {
  console.log('  ' + (item.passed ? '✓' : '✗') + ' ' + item.name + ' — ' + item.detail);
}
process.exitCode = result.passed ? 0 : 1;