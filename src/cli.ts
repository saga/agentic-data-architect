#!/usr/bin/env tsx
/**
 * V1 闭环 CLI：
 *   init <name> [--goal "..."] [--scope a,b]   建 Investigation
 *   discover <name> <path>                     扫 SQL → inventory + L1 lineage → 存快照
 *   ask <name> "question"                      Evidence 上下文 → Copilot 回答 → 存 Claim
 *   report <name>                               输出 Current-State markdown
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { askCopilot, stopClient } from './agent/copilot.js';
import { discoverDirectory } from './discovery/scanner.js';
import { buildLineage } from './analysis/lineage.js';
import { profileSqlFiles } from './analysis/profiling.js';
import { loadInvestigation, newInvestigation, saveInvestigation } from './investigation/store.js';

const LEAD_SYSTEM_PROMPT = `You are the Lead Data Agent for a Data Modernization Workbench.
Rules:
- LLM reasons over facts; it does not invent facts. Every conclusion must cite evidence.
- Status values: verified (deterministic proof), supported (multiple evidence), inferred (single/weak signal), unknown (no evidence), contradicted (conflicting evidence).
- If evidence is missing, say UNKNOWN and state what discovery step would resolve it.
- Prefer point-in-time / source-of-truth / identifier-fragmentation checks for investment-data questions.
- Answer concisely in the user's language.`;

function discoveryPath(name: string): string {
  return path.join(config.investigationDir, `${name}.discovery.json`);
}

async function cmdInit(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) throw new Error('usage: init <name> [--goal "..."] [--scope a,b] [--system s1,s2]');
  const inv = newInvestigation(name);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--goal') inv.goal = rest[++i] ?? '';
    if (rest[i] === '--scope') inv.scope = (rest[++i] ?? '').split(',').filter(Boolean);
    if (rest[i] === '--system') inv.systems = (rest[++i] ?? '').split(',').filter(Boolean);
  }
  const fp = await saveInvestigation(inv);
  console.log(`investigation created: ${fp}`);
}

async function cmdDiscover(args: string[]): Promise<void> {
  const [name, target] = args;
  if (!name || !target) throw new Error('usage: discover <name> <path>');
  const inv = await loadInvestigation(name);
  const inventory = await discoverDirectory(target);
  const lineage = await buildLineage(inventory.sqlFiles);
  const refCounts = new Map<string, number>();
  for (const e of lineage.edges) refCounts.set(e.viaFile, (refCounts.get(e.viaFile) ?? 0) + 1);
  const profiles = await profileSqlFiles(inventory.sqlFiles, refCounts);
  await fs.mkdir(config.investigationDir, { recursive: true });
  await fs.writeFile(discoveryPath(name), JSON.stringify({ inventory, lineage, profiles }, null, 2));
  inv.unknowns = [...new Set([...inv.unknowns, ...inventory.unknowns])];
  await saveInvestigation(inv);
  console.log(`scanned ${inventory.files.length} files (${inventory.sqlFiles.length} sql)`);
  console.log(`lineage: ${lineage.tables.length} tables, ${lineage.edges.length} edges`);
  console.log(`snapshot: ${discoveryPath(name)}`);
}

async function cmdAsk(args: string[]): Promise<void> {
  const [name, ...q] = args;
  const question = q.join(' ').trim();
  if (!name || !question) throw new Error('usage: ask <name> "question"');
  const inv = await loadInvestigation(name);
  let snapshot = 'no discovery snapshot yet (run discover first)';
  try {
    const raw = await fs.readFile(discoveryPath(name), 'utf-8');
    snapshot = raw.length > 12000 ? raw.slice(0, 12000) + '\n...[truncated]' : raw;
  } catch {
    /* keep hint */
  }
  const prompt = `Investigation: ${inv.name}\nGoal: ${inv.goal || '(unset)'}\nScope: ${inv.scope.join(', ') || '(unset)'}\nKnown unknowns:\n${inv.unknowns.map((u) => '- ' + u).join('\n') || '(none)'}\n\nDiscovery snapshot (deterministic, trust it over guesses):\n${snapshot}\n\nQuestion:\n${question}\n\nReturn: 1) direct answer 2) evidence bullets 3) status (one of verified/supported/inferred/unknown/contradicted) 4) open unknowns.`;
  const answer = await askCopilot({ prompt, systemPrompt: LEAD_SYSTEM_PROMPT });
  inv.claims.push({
    claim: `Q: ${question}\nA: ${answer}`,
    status: 'inferred',
    evidence: [{ type: 'documentation', document: discoveryPath(name) }],
  });
  await saveInvestigation(inv);
  console.log(answer);
}

async function cmdReport(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) throw new Error('usage: report <name>');
  const inv = await loadInvestigation(name);
  let disc: { inventory?: { files?: unknown[] }; lineage?: { edges?: { source: string; target: string }[] } } = {};
  try {
    disc = JSON.parse(await fs.readFile(discoveryPath(name), 'utf-8'));
  } catch {
    /* no snapshot */
  }
  const edges = disc.lineage?.edges ?? [];
  const lines = [
    `# Current-State Report: ${inv.name}`,
    ``,
    `- Goal: ${inv.goal || '(unset)'}`,
    `- Scope: ${inv.scope.join(', ') || '(unset)'}`,
    `- Files: ${(disc.inventory?.files ?? []).length}, Lineage edges: ${edges.length}`,
    ``,
    `## Dependency Graph (L1)`,
    ...(edges.length ? edges.map((e) => `- ${e.source} → ${e.target}`) : ['(no edges)']),
    ``,
    `## Claims (${inv.claims.length})`,
    ...(inv.claims.length
      ? inv.claims.map((c, i) => `### ${i + 1}. [${c.status}] ${c.claim.split('\n')[0]}`)
      : ['(none yet — run ask)']),
    ``,
    `## Unknowns`,
    ...(inv.unknowns.length ? inv.unknowns.map((u) => `- ${u}`) : ['(none)']),
  ];
  console.log(lines.join('\n'));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'init') await cmdInit(args);
    else if (cmd === 'discover') await cmdDiscover(args);
    else if (cmd === 'ask') await cmdAsk(args);
    else if (cmd === 'report') await cmdReport(args);
    else {
      console.log('usage: cli.ts <init|discover|ask|report> ...');
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
