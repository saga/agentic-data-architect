import { PARSER_VERSION } from '../analysis/sql-parser.js';
import { buildLineage, type LineageGraph } from '../analysis/lineage.js';
import { runAllFindings } from '../analysis/findings.js';
import { checkDomainGaps } from '../analysis/finance-rules.js';
import { discoverDirectory, type Inventory } from '../discovery/scanner.js';
import { discoverDatabase } from '../discovery/database.js';
import { loadInvestigation, saveDiscoverySnapshot, saveInvestigation } from '../investigation/store.js';
import { appendContextInput, redactSensitiveUri } from '../investigation/workspace.js';
import { emptyEstate, nextEstateId, nodeId, type DataEstate } from '../model/estate.js';
import type { DiscoveryRun } from '../evidence/types.js';
import type { DataProfile } from '../adapters/database.js';

/**
 * runDiscovery：瘦 CLI 背后的真实逻辑（§三十四），以后 UI / API 直接复用。
 * 每次 discover 产生一个 run（run-001…），不覆盖旧快照。
 */

export interface DiscoverOptions {
  path?: string;
  database?: string;
  schema?: string;
  profile?: boolean;
}

export interface DiscoverySnapshot {
  run: DiscoveryRun;
  inventory: Inventory | null;
  lineage: LineageGraph | null;
  estate: DataEstate;
  profiles: DataProfile[];
  findingIds: string[];
}

export interface DiscoverSummary {
  runId: string;
  filesScanned: number;
  datasetsFound: number;
  lineageEdgesFound: number;
  columnsFound: number;
  findingsFound: number;
  unknowns: string[];
  snapshotPath: string;
}

export async function runDiscovery(name: string, opts: DiscoverOptions): Promise<DiscoverSummary> {
  const inv = await loadInvestigation(name);
  await appendContextInput(name, {
    kind: 'discovery',
    title: 'Discovery run',
    content: JSON.stringify({ ...opts, ...(opts.database ? { database: redactSensitiveUri(opts.database) } : {}) }),
    source: 'agentic-data-architect discover',
    important: true,
  });
  if (!opts.path && !opts.database) {
    throw new Error('usage: discover <name> [--path ./dir] [--database postgres://...]（至少给一个来源）');
  }
  const startedAt = new Date().toISOString();
  const runId = `run-${String(inv.discoveryRuns.length + 1).padStart(3, '0')}`;

  const estate = emptyEstate();
  let inventory: Inventory | null = null;
  let lineage: LineageGraph | null = null;
  const profiles: DataProfile[] = [];
  const unknowns: string[] = [];

  if (opts.path) {
    inventory = await discoverDirectory(opts.path, runId);
    unknowns.push(...inventory.unknowns);
    lineage = await buildLineage(
      inventory.files
        .filter((f) => f.kind === 'sql')
        .map((f) => ({
          path: f.path,
          sha256: f.sha256,
          investigationId: name,
          discoveryRunId: runId,
        })),
    );
    inv.evidence.push(...lineage.evidence);
    mergeEstateFromLineage(estate, lineage, inventory);
  }

  if (opts.database) {
    const db = await discoverDatabase({
      connectionString: opts.database,
      investigationId: name,
      discoveryRunId: runId,
      ...(opts.schema ? { schema: opts.schema } : {}),
      ...(opts.profile ? { profile: true } : {}),
    });
    inv.evidence.push(...db.evidence);
    unknowns.push(...db.unknowns);
    profiles.push(...db.profiles);
    mergeEstate(estate, db.estate);
  }

  const tables = [...new Set([
    ...(lineage?.tables.filter((t) => !t.startsWith('file:')) ?? []),
    ...estate.nodes.filter((n) => n.type === 'dataset').map((n) => n.name),
  ])].sort();
  const run: DiscoveryRun = {
    id: runId,
    root: opts.path ?? (opts.database ? redactSensitiveUri(opts.database) : ''),
    startedAt,
    completedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
    filesScanned: inventory?.files.length ?? 0,
    datasetsFound: tables.length,
    lineageEdgesFound: lineage?.edges.length ?? 0,
  };
  inv.discoveryRuns.push(run);

  // findings（deterministic，有证据才建）
  if (lineage || opts.database) {
    const findingLineage = lineage ?? lineageFromEstate(estate);
    const newFindings = runAllFindings({
      investigationId: name,
      lineage: findingLineage,
      profiles,
      inventory: inventory ?? undefined,
      evidence: inv.evidence,
    });
    const known = new Set(inv.findings.map((f) => `${f.type}:${f.title}`));
    for (const f of newFindings) {
      if (!known.has(`${f.type}:${f.title}`)) {
        known.add(`${f.type}:${f.title}`);
        inv.findings.push(f);
      }
    }
    // 金融清单缺口 → unknowns（证据不足时提问，不硬判）
    // 目标列和源列都计入：只当过源的表（如 security_price）否则列清单为空、乱问一气
    const colsByDs = new Map<string, string[]>();
    const addCols = (ds: string, ...cols: string[]) => {
      const list = colsByDs.get(ds) ?? [];
      list.push(...cols);
      colsByDs.set(ds, list);
    };
    for (const c of findingLineage.columns) {
      addCols(c.targetDataset, c.targetColumn);
      addCols(c.sourceDataset, c.sourceColumn);
    }
    for (const g of checkDomainGaps(tables.map((t) => ({ name: t, columns: colsByDs.get(t) ?? [] })))) {
      if (!inv.unknowns.includes(g.question)) inv.unknowns.push(g.question);
    }
  }

  for (const u of unknowns) {
    if (!inv.unknowns.includes(u)) inv.unknowns.push(u);
  }

  const snapshot: DiscoverySnapshot = {
    run,
    inventory,
    lineage,
    estate,
    profiles,
    findingIds: inv.findings.map((f) => f.id),
  };
  const snapshotPath = await saveDiscoverySnapshot(name, runId, snapshot);
  await saveInvestigation(inv);
  return {
    runId,
    filesScanned: run.filesScanned,
    datasetsFound: run.datasetsFound,
    lineageEdgesFound: run.lineageEdgesFound,
    columnsFound: lineage?.columns.length ?? estate.nodes.filter((n) => n.type === 'column').length,
    findingsFound: inv.findings.length,
    unknowns: inv.unknowns,
    snapshotPath,
  };
}

function mergeEstate(estate: DataEstate, extra: DataEstate): void {
  const nodeIds = new Set(estate.nodes.map((n) => n.id));
  for (const n of extra.nodes) {
    if (!nodeIds.has(n.id)) {
      nodeIds.add(n.id);
      estate.nodes.push(n);
    }
  }
  estate.edges.push(...extra.edges);
}

function mergeEstateFromLineage(estate: DataEstate, lineage: LineageGraph, inventory: Inventory): void {
  const filesByPath = new Map(inventory.files.map((f) => [f.path, f]));
  const ensure = (id: string, type: Parameters<typeof nodeId>[0], name: string, attributes: Record<string, unknown> = {}) => {
    if (!estate.nodes.some((n) => n.id === id)) estate.nodes.push({ id, type, name, attributes });
  };
  for (const st of lineage.statements) {
    const f = filesByPath.get(st.file);
    const fileId = nodeId('file', st.file);
    ensure(fileId, 'file', st.file, f ? { sha256: f.sha256, lineCount: f.lineCount } : {});
    if (st.target) {
      const dsId = nodeId('dataset', st.target);
      ensure(dsId, 'dataset', st.target);
      const ev = lineage.evidence.find((e) => e.type === 'sql_statement' && e.file === st.file && e.lineStart === st.lineStart && e.lineEnd === st.lineEnd);
      estate.edges.push({ id: nextEstateId(), from: fileId, to: dsId, type: 'writes_to', evidenceIds: ev ? [ev.id] : [] });
    }
  }
  for (const e of lineage.edges) {
    const from = nodeId('dataset', e.source);
    const to = nodeId('dataset', e.target);
    ensure(from, 'dataset', e.source);
    ensure(to, 'dataset', e.target);
    estate.edges.push({ id: nextEstateId(), from, to, type: 'derived_from', evidenceIds: [e.evidenceId] });
  }
  for (const c of lineage.columns) {
    const from = nodeId('column', `${c.sourceDataset}.${c.sourceColumn}`);
    const to = nodeId('column', `${c.targetDataset}.${c.targetColumn}`);
    ensure(from, 'column', `${c.sourceDataset}.${c.sourceColumn}`, { ...(c.expression ? { expression: c.expression } : {}) });
    ensure(to, 'column', `${c.targetDataset}.${c.targetColumn}`);
    estate.edges.push({ id: nextEstateId(), from, to, type: 'derived_from', evidenceIds: c.evidenceId ? [c.evidenceId] : [] });
    estate.edges.push({
      id: nextEstateId(),
      from: nodeId('dataset', c.targetDataset),
      to,
      type: 'contains',
      evidenceIds: [],
    });
  }
}


function lineageFromEstate(estate: DataEstate): LineageGraph {
  const tables = estate.nodes.filter((n) => n.type === 'dataset').map((n) => n.name);
  const columns = estate.nodes
    .filter((n) => n.type === 'column')
    .map((n) => {
      const dot = n.name.lastIndexOf('.');
      const dataset = dot > 0 ? n.name.slice(0, dot) : n.name;
      const column = dot > 0 ? n.name.slice(dot + 1) : n.name;
      return {
        sourceDataset: dataset,
        sourceColumn: column,
        targetDataset: dataset,
        targetColumn: column,
        statementId: `metadata:${n.id}`,
      };
    });
  return { edges: [], tables, columns, statements: [], evidence: [] };
}
