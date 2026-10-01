#!/usr/bin/env tsx
/**
 * CLI 命令行入口。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import { stopClient } from './agent/copilot.js';
import { investigationExists, newInvestigation, saveInvestigation } from './investigation/store.js';
import { runDiscovery } from './workflow/discover.js';
import { answerQuestion } from './workflow/ask.js';
import { runReport } from './workflow/report.js';
import { buildModernizationPlan } from './workflow/modernization.js';
import type { WorkflowId } from './investigation/schemas.js';

/** CLI init 命令：创建一个新的 Investigation，并解析最基础的 goal/scope/system 参数。 */
async function cmdInit(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) throw new Error('usage: init <name> [--prompt "..."] [--goal "..."] [--scope a,b] [--system s1,s2] [--workflow legacy-modernization|financial-ai-native-architecture|data-architecture-assessment]');
  let userPrompt = '';
  let workflow: WorkflowId = 'legacy-modernization';
  const inv = newInvestigation(name, userPrompt, workflow);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--prompt') { userPrompt = rest[++i] ?? ''; inv.userPrompt = userPrompt; }
    if (rest[i] === '--goal') inv.goal = rest[++i] ?? '';
    if (rest[i] === '--scope') inv.scope = (rest[++i] ?? '').split(',').filter(Boolean);
    if (rest[i] === '--system') inv.systems = (rest[++i] ?? '').split(',').filter(Boolean);
    if (rest[i] === '--workflow') {
      const value = rest[++i] as WorkflowId;
      if (!['legacy-modernization', 'financial-ai-native-architecture', 'data-architecture-assessment'].includes(value)) {
        throw new Error('workflow 只能是 legacy-modernization、financial-ai-native-architecture 或 data-architecture-assessment');
      }
      workflow = value;
      inv.workflow = value;
    }
  }
  console.log('session created: ' + await saveInvestigation(inv));
}

/** CLI discover 命令：校验 Session、解析发现参数，并调用共享 discovery workflow。 */
async function cmdDiscover(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) throw new Error('usage: discover <name> [--path ./dir] [--database URL] [--schema S] [--profile]');
  if (!(await investigationExists(name))) throw new Error('session 不存在：' + name + '（直接 npm run start ' + name + ' 开始）');
  const opts: { path?: string; database?: string; schema?: string; profile?: boolean } = {};
  const maybePath = rest[0];
  if (maybePath !== undefined && !maybePath.startsWith('--')) { opts.path = maybePath; rest.shift(); }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--path') opts.path = rest[++i];
    else if (rest[i] === '--database') opts.database = rest[++i];
    else if (rest[i] === '--schema') opts.schema = rest[++i];
    else if (rest[i] === '--profile') opts.profile = true;
  }
  const s = await runDiscovery(name, opts);
  console.log('run ' + s.runId + ': ' + s.filesScanned + ' files, ' + s.datasetsFound + ' datasets, ' + s.lineageEdgesFound + ' edges, ' + s.columnsFound + ' column edges');
  console.log('findings: ' + s.findingsFound + ', unknowns: ' + s.unknowns.length);
  console.log('snapshot: ' + s.snapshotPath);
}

/** CLI ask 命令：把命令行问题交给统一的 Agent workflow，输出答案和结构化 Claim。 */
async function cmdAsk(args: string[]): Promise<void> {
  const [name, ...q] = args;
  const question = q.join(' ').trim();
  if (!name || !question) throw new Error('usage: ask <name> "question"');
  const r = await answerQuestion(name, question);
  console.log(r.answer);
  console.log('claims: ' + (r.claimIds.join(', ') || '(none)'));
  for (const w of r.warnings) console.log('warning: ' + w);
}

/** CLI modernize 命令：把 Discovery 结果组织成可继续编辑/审核的 modernization work package。 */
async function cmdModernize(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) throw new Error('usage: modernize <name>');
  if (!(await investigationExists(name))) throw new Error('session 不存在：' + name);
  const result = await buildModernizationPlan(name);
  console.log(JSON.stringify(result.plan, null, 2));
  console.error('written: ' + result.path);
}

/** CLI report 命令：生成当前 Investigation 报告并打印，同时写入报告文件。 */
async function cmdReport(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) throw new Error('usage: report <name>');
  const r = await runReport(name);
  console.log(r.markdown);
  console.error('written: ' + r.path);
}

/** CLI 主入口：根据第一个参数选择 init/discover/ask/report，并保证退出时停止 CopilotClient。 */
async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (!cmd) { console.log('usage: npm run start | init | discover | ask | report | modernize'); return; }
    if (cmd === 'init') await cmdInit(args);
    else if (cmd === 'discover') await cmdDiscover(args);
    else if (cmd === 'ask') await cmdAsk(args);
    else if (cmd === 'report') await cmdReport(args);
    else if (cmd === 'modernize') await cmdModernize(args);
    else {
      console.log('usage: npm run start | init | discover | ask | report');
      process.exitCode = 2;
    }
  } finally {
    await stopClient();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});