/**
 * Discovery Workflow：把文件、数据库和分析结果汇总成可追溯的 Investigation 状态。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PARSER_VERSION } from '../analysis/sql-parser.js';
import { buildLineage, type LineageGraph } from '../analysis/lineage.js';
import { buildCurrentStateIntelligence } from '../analysis/current-state.js';
import { runAllFindings } from '../analysis/findings.js';
import { discoverDirectory, type Inventory } from '../discovery/scanner.js';
import { discoverDatabase } from '../discovery/database.js';
import { loadInvestigation, saveDiscoverySnapshot, saveInvestigation } from '../investigation/store.js';
import { appendContextInput, redactSensitiveUri } from '../investigation/workspace.js';
import { emptyEstate, nextEstateId, nodeId, type DataEstate } from '../model/estate.js';
import { nextId, type DiscoveryRun, type EvidenceRef, type GraphifyRunMetadata } from '../evidence/types.js';
import type { DataProfile } from '../adapters/database.js';
import type { SemanticAsset } from '../semantic/types.js';
import { getGraphifyRuntimeMetadata } from '../adapters/graphify.js';

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

/** 一次完整 Discovery 的不可变结果快照，供后续 Agent 问答检索。 */
export interface DiscoverySnapshot {
  run: DiscoveryRun;
  inventory: Inventory | null;
  lineage: LineageGraph | null;
  estate: DataEstate;
  profiles: DataProfile[];
  semanticAssets: SemanticAsset[];
  currentState: ReturnType<typeof buildCurrentStateIntelligence>;
  findingIds: string[];
}

/** Discovery workflow 给 CLI/UI 的轻量执行摘要。 */
export interface DiscoverSummary {
  runId: string;
  filesScanned: number;
  datasetsFound: number;
  lineageEdgesFound: number;
  columnsFound: number;
  findingsFound: number;
  parseFailures: number;
  semanticAssetsFound: number;
  unknowns: string[];
  snapshotPath: string;
}

/** 执行文件/数据库发现、lineage、estate、profiling 和 deterministic findings，并持久化本次 run。 */
export async function runDiscovery(name: string, opts: DiscoverOptions): Promise<DiscoverSummary> {
  // Validate before recording the run in workspace state; a rejected request
  // should not leave a misleading discovery entry behind.
  if (!opts.path && !opts.database) {
    throw new Error('usage: discover <name> [--path ./dir] [--database postgres://...]（至少给一个来源）');
  }

  const inv = await loadInvestigation(name);
  const startedAt = new Date().toISOString();
  // 路径 Discovery 先做当前文件指纹，再判断是否真的需要产生新的 run。
  // 同一目录、同一批文件 hash、同一 parser 版本不会再次制造数千条重复 Evidence。
  let inventory: Inventory | null = null;
  if (opts.path && !opts.database) {
    inventory = await discoverDirectory(opts.path, 'pending');
    const reusable = await findReusablePathDiscoveryRun(name, inv, opts.path, inventory);
    if (reusable) {
      const snapshotPath = path.join(discoveryDir(name), reusable.id + '.json');
      let columnsFound = 0;
      try {
        const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as DiscoverySnapshot;
        columnsFound = snapshot.lineage?.columns.length
          ?? snapshot.estate.nodes.filter((node) => node.type === 'column').length;
      } catch {
        // 旧 snapshot 损坏时不阻塞调用；下一次文件变化会触发新的 Discovery。
      }
      return {
        runId: reusable.id,
        filesScanned: reusable.filesScanned,
        datasetsFound: reusable.datasetsFound,
        lineageEdgesFound: reusable.lineageEdgesFound,
        columnsFound,
        findingsFound: inv.findings.length,
        parseFailures: reusable.sqlParseFailures ?? 0,
        semanticAssetsFound: reusable.semanticAssetsFound ?? 0,
        unknowns: inv.unknowns,
        snapshotPath,
      };
    }
  }

  await appendContextInput(name, {
    kind: 'discovery',
    title: 'Discovery run',
    content: JSON.stringify({ ...opts, ...(opts.database ? { database: redactSensitiveUri(opts.database) } : {}) }),
    source: 'agentic-data-architect discover',
    important: true,
  });
  // runId 按 Investigation 顺序递增，用于把本轮 Evidence、snapshot 和审计范围关联起来。
  const runId = 'run-' + String(inv.discoveryRuns.length + 1).padStart(3, '0');
  if (inventory) inventory.discoveryRunId = runId;

  const estate = emptyEstate();
  let lineage: LineageGraph | null = null;
  const profiles: DataProfile[] = [];
  const semanticAssets: SemanticAsset[] = [];
  const unknowns: string[] = [];

  let graphify: GraphifyRunMetadata | undefined;

  if (opts.path && inventory) {
    // Source-file Evidence 建立 Graphify → source provenance 的桥：Graphify 只负责定位候选文件。
    const sourceEvidence: EvidenceRef[] = inventory.files.map((file) => ({
      id: nextId('ev'),
      type: 'source_file',
      investigationId: name,
      discoveryRunId: runId,
      source: `${file.path} (${file.kind}, ${file.lineCount} lines)`,
      file: file.path,
      sourceHash: file.sha256,
      value: { kind: file.kind, sizeBytes: file.sizeBytes, lineCount: file.lineCount, modifiedAt: file.modifiedAt },
      collectedAt: new Date().toISOString(),
    }));
    inv.evidence.push(...sourceEvidence);
    graphify = await getGraphifyRuntimeMetadata(opts.path);
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
    unknowns.push(...lineage.parseFailures.map((failure) => 'SQL 无法解析：' + failure.file + ':' + failure.lineStart + '-' + failure.lineEnd + '：' + failure.error));
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
    semanticAssets.push(...db.semanticAssets);
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
    sqlParseFailures: lineage?.parseFailures.length ?? 0,
    semanticAssetsFound: semanticAssets.length,
    ...(graphify ? { graphify } : {}),
  };
  inv.discoveryRuns.push(run);

  // findings（deterministic，有证据才建）
  if (lineage || opts.database) {
    const findingLineage = lineage ?? lineageFromEstate(estate);
    const newFindings = runAllFindings({
      investigationId: name,
      lineage: findingLineage,
      profiles,
      ...(inventory ? { inventory } : {}),
      evidence: inv.evidence,
    });
    const known = new Set(inv.findings.map((f) => `${f.type}:${f.title}`));
    for (const f of newFindings) {
      if (!known.has(`${f.type}:${f.title}`)) {
        known.add(`${f.type}:${f.title}`);
        inv.findings.push(f);
      }
    }
    // 领域专项检查不在 discovery core 中硬编码。
    // 对金融场景，financial-data-review Skill 会按需运行 deterministic review script。
  }

  for (const u of unknowns) {
    if (!inv.unknowns.includes(u)) inv.unknowns.push(u);
  }

  const currentState = buildCurrentStateIntelligence({ inventory, estate, lineage, profiles, semanticAssets });

  const snapshot: DiscoverySnapshot = {
    run,
    inventory,
    lineage,
    estate,
    profiles,
    semanticAssets,
    currentState,
    findingIds: inv.findings.map((f) => f.id),
  };
  // snapshot 先独立原子写入，再保存 Investigation context；二者共同组成本次 Discovery 的可恢复状态。
const snapshotPath = await saveDiscoverySnapshot(name, runId, snapshot);
  await saveInvestigation(inv);
  return {
    runId,
    filesScanned: run.filesScanned,
    datasetsFound: run.datasetsFound,
    lineageEdgesFound: run.lineageEdgesFound,
    columnsFound: lineage?.columns.length ?? estate.nodes.filter((n) => n.type === 'column').length,
    findingsFound: inv.findings.length,
    parseFailures: lineage?.parseFailures.length ?? 0,
    semanticAssetsFound: semanticAssets.length,
    unknowns: inv.unknowns,
    snapshotPath,
  };
}

/** 判断一次本地路径 Discovery 是否与已有 run 完全一致；一致时直接复用旧 snapshot。 */
async function findReusablePathDiscoveryRun(
  name: string,
  investigation: Awaited<ReturnType<typeof loadInvestigation>>,
  root: string,
  inventory: Inventory,
): Promise<Awaited<ReturnType<typeof loadInvestigation>>['discoveryRuns'][number] | null> {
  const normalizedRoot = path.resolve(root);
  for (const run of [...investigation.discoveryRuns].reverse()) {
    if (run.parserVersion !== PARSER_VERSION || path.resolve(run.root) !== normalizedRoot) continue;

    const sourceEvidence = investigation.evidence.filter(
      (item) => item.discoveryRunId === run.id && item.type === 'source_file' && item.file && item.sourceHash,
    );
    if (sourceEvidence.length !== inventory.files.length) continue;

    const previousHashes = new Map(
      sourceEvidence.map((item) => [item.file as string, item.sourceHash as string]),
    );
    const sameFiles = inventory.files.every((file) => previousHashes.get(file.path) === file.sha256);
    if (!sameFiles) continue;

    try {
      await fs.access(path.join(discoveryDir(name), run.id + '.json'));
      return run;
    } catch {
      // 没有可恢复 snapshot 的旧 run 不能复用。
    }
  }
  return null;
}

/** 把不同 Discovery 来源得到的 Estate 节点/边合并到当前 Investigation 的统一图。 */
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

/** 把 SQL lineage 转成 Data Estate 节点和关系，并把 SQL Evidence 绑定到这些关系。 */
function mergeEstateFromLineage(estate: DataEstate, lineage: LineageGraph, inventory: Inventory): void {
  const filesByPath = new Map(inventory.files.map((f) => [f.path, f]));
  const ensure = (id: string, type: Parameters<typeof nodeId>[0], name: string, attributes: Record<string, unknown> = {}) => {
    if (!estate.nodes.some((n) => n.id === id)) estate.nodes.push({ id, type, name, attributes });
  };
  const jobs = new Map<string, string>();

  for (const st of lineage.statements) {
    const f = filesByPath.get(st.file);
    const fileId = nodeId('file', st.file);
    const jobId = nodeId('job', 'sql-file:' + st.file);
    const jobName = 'SQL file: ' + st.file;

    ensure(fileId, 'file', st.file, f ? { sha256: f.sha256, lineCount: f.lineCount } : {});
    ensure(jobId, 'job', jobName, { kind: 'sql_file', sourceFile: st.file });

    if (!jobs.has(st.file)) {
      jobs.set(st.file, jobId);
      estate.edges.push({
        id: nextEstateId(),
        from: fileId,
        to: jobId,
        type: 'implements',
        evidenceIds: [],
        relationMode: 'static',
      });
    }

    const evidence = lineage.evidence.find(
      (item) =>
        item.type === 'sql_statement' &&
        item.file === st.file &&
        item.lineStart === st.lineStart &&
        item.lineEnd === st.lineEnd,
    );

    for (const source of st.sources) {
      const sourceId = nodeId('dataset', source);
      ensure(sourceId, 'dataset', source);
      estate.edges.push({
        id: nextEstateId(),
        from: sourceId,
        to: jobId,
        type: 'reads_from',
        evidenceIds: evidence ? [evidence.id] : [],
        relationMode: 'static',
      });
    }

    if (st.target) {
      const targetId = nodeId('dataset', st.target);
      ensure(targetId, 'dataset', st.target);
      estate.edges.push({
        id: nextEstateId(),
        from: jobId,
        to: targetId,
        type: 'writes_to',
        evidenceIds: evidence ? [evidence.id] : [],
        relationMode: 'static',
      });
    }
  }
  for (const e of lineage.edges) {
    const from = nodeId('dataset', e.source);
    const to = nodeId('dataset', e.target);
    ensure(from, 'dataset', e.source);
    ensure(to, 'dataset', e.target);
    estate.edges.push({ id: nextEstateId(), from, to, type: 'derived_from', evidenceIds: [e.evidenceId], relationMode: 'static' });
  }
  for (const c of lineage.columns) {
    const from = nodeId('column', `${c.sourceDataset}.${c.sourceColumn}`);
    const to = nodeId('column', `${c.targetDataset}.${c.targetColumn}`);
    ensure(from, 'column', `${c.sourceDataset}.${c.sourceColumn}`, { ...(c.expression ? { expression: c.expression } : {}) });
    ensure(to, 'column', `${c.targetDataset}.${c.targetColumn}`);
    estate.edges.push({
      id: nextEstateId(),
      from,
      to,
      type: 'derived_from',
      evidenceIds: c.evidenceId ? [c.evidenceId] : [],
      relationMode: 'static',
      ...(c.expression ? { expression: c.expression } : {}),
    });
    estate.edges.push({
      id: nextEstateId(),
      from: nodeId('dataset', c.targetDataset),
      to,
      type: 'contains',
      evidenceIds: c.evidenceId ? [c.evidenceId] : [],
      relationMode: 'static',
    });
  }
}


/** 在只有 metadata/estate 没有 SQL lineage 时构造最小 LineageGraph，供通用 Finding 规则继续运行。 */
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
  return { edges: [], tables, columns, statements: [], parseFailures: [], evidence: [] };
}
