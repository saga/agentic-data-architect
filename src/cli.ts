#!/usr/bin/env tsx
import { stopClient } from './agent/copilot.js';
import { investigationExists, newInvestigation, saveInvestigation } from './investigation/store.js';
import { runDiscovery } from './workflow/discover.js';
import { answerQuestion } from './workflow/ask.js';
import { runReport } from './workflow/report.js';

async function cmdInit(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) throw new Error('usage: init <name> [--prompt "..."] [--goal "..."] [--scope a,b] [--system s1,s2]');
  let userPrompt = '';
  const inv = newInvestigation(name, userPrompt);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--prompt') { userPrompt = rest[++i] ?? ''; inv.userPrompt = userPrompt; }
    if (rest[i] === '--goal') inv.goal = rest[++i] ?? '';
    if (rest[i] === '--scope') inv.scope = (rest[++i] ?? '').split(',').filter(Boolean);
    if (rest[i] === '--system') inv.systems = (rest[++i] ?? '').split(',').filter(Boolean);
  }
  console.log('session created: ' + await saveInvestigation(inv));
}

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

async function cmdAsk(args: string[]): Promise<void> {
  const [name, ...q] = args;
  const question = q.join(' ').trim();
  if (!name || !question) throw new Error('usage: ask <name> "question"');
  const r = await answerQuestion(name, question);
  console.log(r.answer);
  console.log('claims: ' + (r.claimIds.join(', ') || '(none)'));
  for (const w of r.warnings) console.log('warning: ' + w);
}

async function cmdReport(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) throw new Error('usage: report <name>');
  const r = await runReport(name);
  console.log(r.markdown);
  console.error('written: ' + r.path);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (!cmd) { console.log('usage: npm run start | init | discover | ask | report'); return; }
    if (cmd === 'init') await cmdInit(args);
    else if (cmd === 'discover') await cmdDiscover(args);
    else if (cmd === 'ask') await cmdAsk(args);
    else if (cmd === 'report') await cmdReport(args);
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