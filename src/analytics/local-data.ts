/**
 * Local Data Workbench：Dataset Registry + DuckDB analytical engine。
 *
 * 这里故意不把 DuckDB 做成整个应用的主数据库：
 * - SQLite 继续保存应用状态、对话、Dataset Registry 和分析运行记录；
 * - 每个 Investigation 有自己的 analysis.duckdb，负责分析计算；
 * - 原始 CSV/JSON/JSONL/Parquet 文件仍保留在 workspace 中；
 * - Agent 只能通过受限 local_* 工具使用已登记的数据集。
 *
 * 这样做的好处是“应用状态”和“数据分析”互不抢职责，而且整个工作台仍然是
 * 单机、单用户、无需数据库服务的本地应用。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { config } from '../config.js';
import { conversationDbFile } from '../investigation/conversation.js';
import { appendInvestigationEvidence, workspaceRoot } from '../investigation/workspace.js';
import { nextId, type EvidenceRef } from '../evidence/types.js';

export type LocalDatasetFormat = 'csv' | 'json' | 'jsonl' | 'parquet';

export interface LocalDataset {
  id: string;
  sessionName: string;
  name: string;
  relativePath: string;
  format: LocalDatasetFormat;
  relation: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface LocalAnalysisRun {
  id: string;
  sessionName: string;
  operation: 'catalog' | 'describe' | 'sample' | 'profile' | 'query';
  datasetId?: string;
  sql: string;
  sqlHash: string;
  rowCount?: number;
  durationMs: number;
  evidenceId?: string;
  createdAt: string;
}

export interface LocalQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  sql: string;
  analysisRunId: string;
  evidenceId: string;
  dataset?: {
    id: string;
    version: number;
    sha256: string;
  };
}

interface DatasetRow {
  id: string;
  session_name: string;
  name: string;
  relative_path: string;
  format: LocalDatasetFormat;
  relation: string;
  version: number;
  sha256: string;
  size_bytes: number;
  updated_at: string;
}

let registryDb: DatabaseSync | undefined;
let registryPath: string | undefined;
const engines = new Map<string, Promise<LocalDuckDBEngine>>();

const SUPPORTED_EXTENSIONS: Record<string, LocalDatasetFormat> = {
  '.csv': 'csv',
  '.json': 'json',
  '.jsonl': 'jsonl',
  '.ndjson': 'jsonl',
  '.parquet': 'parquet',
};

function getRegistryDatabase(): DatabaseSync {
  const file = conversationDbFile();
  if (registryDb && registryPath === file) return registryDb;

  registryDb?.close();
  fsSyncMkdir(path.dirname(file));
  registryDb = new DatabaseSync(file);
  registryPath = file;
  registryDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS local_datasets (
      id TEXT PRIMARY KEY,
      session_name TEXT NOT NULL,
      name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      format TEXT NOT NULL CHECK (format IN ('csv','json','jsonl','parquet')),
      relation TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_name, relative_path)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_local_datasets_session
      ON local_datasets(session_name, updated_at);

    CREATE TABLE IF NOT EXISTS local_analysis_runs (
      id TEXT PRIMARY KEY,
      session_name TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('catalog','describe','sample','profile','query')),
      dataset_id TEXT,
      sql TEXT NOT NULL,
      sql_hash TEXT NOT NULL,
      row_count INTEGER,
      duration_ms INTEGER NOT NULL,
      evidence_id TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_local_analysis_runs_session
      ON local_analysis_runs(session_name, created_at);
  `);
  return registryDb;
}

function fsSyncMkdir(directory: string): void {
  const fsSync = requireNodeFsSync();
  fsSync.mkdirSync(directory, { recursive: true });
}

function requireNodeFsSync(): typeof import('node:fs') {
  return require('node:fs') as typeof import('node:fs');
}

function datasetRowToModel(row: DatasetRow): LocalDataset {
  return {
    id: row.id,
    sessionName: row.session_name,
    name: row.name,
    relativePath: row.relative_path,
    format: row.format,
    relation: row.relation,
    version: row.version,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    updatedAt: row.updated_at,
  };
}

function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll('\\\\', '/'));
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error('本地数据路径必须位于当前 Investigation workspace 内。');
  }
  return normalized;
}

function absoluteDatasetPath(sessionName: string, relativePath: string): string {
  const root = path.resolve(workspaceRoot(sessionName));
  const normalized = normalizeRelativePath(relativePath);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('本地数据路径超出当前 Investigation workspace。');
  }
  return resolved;
}

function inferFormat(relativePath: string): LocalDatasetFormat | undefined {
  return SUPPORTED_EXTENSIONS[path.extname(relativePath).toLowerCase()];
}

async function statDatasetFile(sessionName: string, relativePath: string) {
  const absolute = absoluteDatasetPath(sessionName, relativePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error('本地数据源不是文件：' + relativePath);
  return { absolute, sizeBytes: stat.size, updatedAt: stat.mtime.toISOString() };
}

async function hashFile(file: string): Promise<string> {
  const raw = await fs.readFile(file);
  return createHash('sha256').update(raw).digest('hex');
}

/** 登记一个本地数据文件；只有第一次或文件确实变了才重新计算完整 SHA-256。 */
export async function registerLocalDataset(
  sessionName: string,
  relativePath: string,
  displayName?: string,
): Promise<LocalDataset> {
  const normalized = normalizeRelativePath(relativePath);
  const format = inferFormat(normalized);
  if (!format) throw new Error('不支持的本地数据格式：' + relativePath + '。支持 CSV、JSON、JSONL、Parquet。');

  const file = await statDatasetFile(sessionName, normalized);
  const db = getRegistryDatabase();
  const existing = db.prepare(`
    SELECT id, session_name, name, relative_path, format, relation, version, sha256, size_bytes, updated_at
    FROM local_datasets
    WHERE session_name = ? AND relative_path = ?
  `).get(sessionName, normalized) as DatasetRow | undefined;

  const unchanged = existing
    && existing.format === format
    && Number(existing.size_bytes) === file.sizeBytes
    && existing.updated_at === file.updatedAt;

  const sha256 = unchanged ? existing.sha256 : await hashFile(file.absolute);
  const now = new Date().toISOString();
  const id = existing?.id
    ?? 'ds-' + createHash('sha256').update(sessionName + '\\0' + normalized).digest('hex').slice(0, 16);
  const name = displayName?.trim() || existing?.name || path.basename(normalized, path.extname(normalized));
  const relation = existing?.relation || 'raw.ds_' + id.slice(3);
  const version = existing
    ? (unchanged ? existing.version : existing.version + 1)
    : 1;

  db.prepare(`
    INSERT INTO local_datasets
      (id, session_name, name, relative_path, format, relation, version, sha256, size_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      format=excluded.format,
      relation=excluded.relation,
      version=excluded.version,
      sha256=excluded.sha256,
      size_bytes=excluded.size_bytes,
      updated_at=excluded.updated_at
  `).run(id, sessionName, name, normalized, format, relation, version, sha256, file.sizeBytes, now);

  return datasetRowToModel(db.prepare(`
    SELECT id, session_name, name, relative_path, format, relation, version, sha256, size_bytes, updated_at
    FROM local_datasets WHERE id = ?
  `).get(id) as DatasetRow);
}

/** 扫描当前 Investigation workspace，自动发现可分析文件并更新 Dataset Registry。 */
export async function discoverLocalDatasets(sessionName: string): Promise<LocalDataset[]> {
  const root = workspaceRoot(sessionName);
  const candidates: string[] = [];

  async function visit(directory: string, relative: string, depth: number): Promise<void> {
    if (depth > 5) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (['copilot', 'graphify-out', 'node_modules'].includes(entry.name)) continue;

      const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await visit(absolute, nextRelative, depth + 1);
      } else if (entry.isFile() && inferFormat(nextRelative)) {
        candidates.push(nextRelative);
      }
    }
  }

  await visit(root, '', 0);

  for (const relative of candidates.slice(0, 200)) {
    try {
      await registerLocalDataset(sessionName, relative);
    } catch {
      // 一个损坏或正在上传的文件不能让整个本地数据目录失效。
    }
  }

  return listLocalDatasets(sessionName);
}

export function listLocalDatasets(sessionName: string): LocalDataset[] {
  const db = getRegistryDatabase();
  const rows = db.prepare(`
    SELECT id, session_name, name, relative_path, format, relation, version, sha256, size_bytes, updated_at
    FROM local_datasets
    WHERE session_name = ?
    ORDER BY name, relative_path
  `).all(sessionName) as unknown as DatasetRow[];
  return rows.map(datasetRowToModel);
}

function getDataset(sessionName: string, ref: string): LocalDataset {
  const db = getRegistryDatabase();
  const row = db.prepare(`
    SELECT id, session_name, name, relative_path, format, relation, version, sha256, size_bytes, updated_at
    FROM local_datasets
    WHERE session_name = ? AND (id = ? OR relation = ? OR name = ? OR relative_path = ?)
    ORDER BY CASE
      WHEN id = ? THEN 0
      WHEN relation = ? THEN 1
      WHEN relative_path = ? THEN 2
      ELSE 3 END
    LIMIT 1
  `).get(sessionName, ref, ref, ref, ref, ref, ref, ref) as DatasetRow | undefined;

  if (!row) throw new Error('找不到本地数据集：' + ref + '。先调用 local_catalog。');
  return datasetRowToModel(row);
}

function sqlLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function viewSql(dataset: LocalDataset): string {
  const absolute = absoluteDatasetPath(dataset.sessionName, dataset.relativePath);
  const source = sqlLiteral(absolute);
  switch (dataset.format) {
    case 'csv':
      return `SELECT * FROM read_csv_auto(${source})`;
    case 'json':
      return `SELECT * FROM read_json_auto(${source})`;
    case 'jsonl':
      return `SELECT * FROM read_json_auto(${source}, format='newline_delimited')`;
    case 'parquet':
      return `SELECT * FROM read_parquet(${source})`;
  }
}

function escapeIdentifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

/** 只允许 SELECT/WITH，且严禁 Agent 绕过 Dataset Registry 直接读文件、网络或其它数据库。 */
export function validateLocalReadOnlySql(sql: string): string {
  const sanitized = sql
    .replace(/--[^\\n]*(?:\\n|$)/g, ' ')
    .replace(/\\*[\\s\\S]*?\\*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ')
    .trim();

  if (!/^(select|with)\\b/i.test(sanitized)) {
    throw new Error('本地分析只允许执行 SELECT 或 WITH 查询。');
  }

  const dangerous = /\\b(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy|attach|detach|install|load|export|import|call|execute|pragma|set|vacuum)\\b/i;
  if (
    dangerous.test(sanitized)
    || /\\bFOR\\s+(UPDATE|SHARE)\\b/i.test(sanitized)
    || /^\\s*SELECT\\b[\\s\\S]*\\bINTO\\s+/i.test(sanitized)
  ) {
    throw new Error('本地分析查询包含不允许的写入、文件或扩展操作。');
  }

  if (
    /\\b(read_csv_auto|read_csv|read_parquet|read_json_auto|read_json|read_text|read_blob|read_csv_objects|parquet_scan|glob|httpfs|sqlite_scan|postgres_scan)\\s*\\(/i.test(sanitized)
    || /https?:\\/\\//i.test(sanitized)
  ) {
    throw new Error('本地分析查询必须使用已经登记的数据集，不能自己读取文件、网络或其它数据库。');
  }

  const trimmed = sanitized.replace(/;\\s*$/g, '');
  if (trimmed.includes(';')) throw new Error('本地分析一次只能执行一条查询。');
  return trimmed;
}

async function ensureEngine(sessionName: string): Promise<LocalDuckDBEngine> {
  const current = engines.get(sessionName);
  if (current) return current;

  const pending = LocalDuckDBEngine.create(sessionName);
  engines.set(sessionName, pending);
  try {
    return await pending;
  } catch (error) {
    engines.delete(sessionName);
    throw error;
  }
}

class LocalDuckDBEngine {
  private constructor(
    readonly sessionName: string,
    readonly dbFile: string,
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
  ) {}

  static async create(sessionName: string): Promise<LocalDuckDBEngine> {
    const root = workspaceRoot(sessionName);
    await fs.mkdir(root, { recursive: true });
    const dbFile = path.join(root, 'analysis.duckdb');
    const instance = await DuckDBInstance.fromCache(dbFile);
    const connection = await instance.connect();

    await connection.run('CREATE SCHEMA IF NOT EXISTS raw');
    await connection.run('CREATE SCHEMA IF NOT EXISTS analysis');
    await connection.run('CREATE SCHEMA IF NOT EXISTS semantic');
    await connection.run('CREATE SCHEMA IF NOT EXISTS scratch');

    return new LocalDuckDBEngine(sessionName, dbFile, instance, connection);
  }

  private queue: Promise<unknown> = Promise.resolve();

  /** DuckDB 是本进程的分析引擎；所有操作串行化，避免同一个 connection 被 Agent 并发使用。 */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** 根据 Registry 把数据文件注册成稳定 view；不把原始文件复制进 DuckDB。 */
  private async refreshViews(): Promise<LocalDataset[]> {
    const datasets = await discoverLocalDatasets(this.sessionName);
    for (const dataset of datasets) {
      await this.connection.run(
        `CREATE OR REPLACE VIEW ${dataset.relation} AS ${viewSql(dataset)}`,
      );
    }
    return datasets;
  }

  async catalog(): Promise<LocalDataset[]> {
    return this.exclusive(() => discoverLocalDatasets(this.sessionName));
  }

  async describe(datasetRef: string): Promise<LocalQueryResult> {
    return this.exclusive(async () => {
      await this.refreshViews();
      const dataset = getDataset(this.sessionName, datasetRef);
      const sql = `DESCRIBE SELECT * FROM ${dataset.relation}`;
      return this.runAndRecord('describe', sql, dataset, 200);
    });
  }

  async sample(datasetRef: string, limit: number): Promise<LocalQueryResult> {
    return this.exclusive(async () => {
      await this.refreshViews();
      const dataset = getDataset(this.sessionName, datasetRef);
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
      const sql = `SELECT * FROM ${dataset.relation} LIMIT ${safeLimit}`;
      return this.runAndRecord('sample', sql, dataset, safeLimit);
    });
  }

  async profile(datasetRef: string): Promise<LocalQueryResult> {
    return this.exclusive(async () => {
      await this.refreshViews();
      const dataset = getDataset(this.sessionName, datasetRef);
      const describeReader = await this.connection.runAndReadAll(`DESCRIBE SELECT * FROM ${dataset.relation}`);
      const columns = describeReader.getRowObjectsJson() as Array<{column_name:string;column_type:string}>;
      const selected = columns.slice(0, 80);
      const profiles: Record<string, unknown>[] = [];
      let rowCount = 0;

      for (const column of selected) {
        const col = escapeIdentifier(String(column.column_name));
        const sql = `SELECT
          count(*) AS row_count,
          count(${col}) AS non_null_count,
          count(DISTINCT ${col}) AS distinct_count,
          min(${col}) AS min_value,
          max(${col}) AS max_value
        FROM ${dataset.relation}`;

        let row: Record<string, unknown> = {};
        try {
          const reader = await this.connection.runAndReadAll(sql);
          row = (reader.getRowObjectsJson() as Record<string, unknown>[])[0] ?? {};
        } catch {
          // Nested/complex data types may not support min/max; keep the useful counts.
          const fallback = await this.connection.runAndReadAll(`
            SELECT
              count(*) AS row_count,
              count(${col}) AS non_null_count,
              count(DISTINCT ${col}) AS distinct_count
            FROM ${dataset.relation}
          `);
          row = (fallback.getRowObjectsJson() as Record<string, unknown>[])[0] ?? {};
        }

        rowCount = Number(row.row_count ?? rowCount);
        const total = Number(row.row_count ?? 0);
        const nonNull = Number(row.non_null_count ?? 0);
        profiles.push({
          column: column.column_name,
          type: column.column_type,
          rowCount: total,
          nullCount: Math.max(0, total - nonNull),
          nullRate: total ? (total - nonNull) / total : 0,
          distinctCount: Number(row.distinct_count ?? 0),
          min: row.min_value ?? null,
          max: row.max_value ?? null,
        });
      }

      const result: LocalQueryResult = {
        columns: ['column','type','rowCount','nullCount','nullRate','distinctCount','min','max'],
        rows: profiles,
        rowCount,
        truncated: columns.length > selected.length,
        sql: 'PROFILE ' + dataset.relation,
        analysisRunId: '',
        evidenceId: '',
        dataset: { id: dataset.id, version: dataset.version, sha256: dataset.sha256 },
      };
      return this.recordResult('profile', result.sql, dataset, result);
    });
  }

  async query(sql: string, limit: number): Promise<LocalQueryResult> {
    return this.exclusive(async () => {
      await this.refreshViews();
      const safeSql = validateLocalReadOnlySql(sql);
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
      return this.runAndRecord('query', safeSql, undefined, safeLimit);
    });
  }

  private async runAndRecord(
    operation: 'describe' | 'sample' | 'query',
    sql: string,
    dataset: LocalDataset | undefined,
    limit: number,
  ): Promise<LocalQueryResult> {
    const started = Date.now();
    const wrapped = `SELECT * FROM (${sql}) AS __agent_result LIMIT ${limit}`;
    const reader = await this.connection.runAndReadAll(wrapped);
    const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
    const result: LocalQueryResult = {
      columns: reader.columnNames(),
      rows,
      rowCount: rows.length,
      truncated: rows.length >= limit,
      sql,
      analysisRunId: '',
      evidenceId: '',
      ...(dataset ? { dataset: { id: dataset.id, version: dataset.version, sha256: dataset.sha256 } } : {}),
    };
    return this.recordResult(operation, sql, dataset, result, started);
  }

  private async recordResult(
    operation: 'describe' | 'sample' | 'profile' | 'query',
    originalSql: string,
    dataset: LocalDataset | undefined,
    result: LocalQueryResult,
    started = Date.now(),
  ): Promise<LocalQueryResult> {
    const durationMs = Date.now() - started;
    const runId = nextId('analysis');
    const evidenceId = nextId('ev');
    const sqlHash = createHash('sha256').update(originalSql).digest('hex');
    const evidenceType = operation === 'profile'
      ? 'profiling'
      : operation === 'describe'
        ? 'metadata'
        : 'query_result';

    const evidence: EvidenceRef = {
      id: evidenceId,
      type: evidenceType,
      investigationId: this.sessionName,
      discoveryRunId: 'local:' + runId,
      source: `duckdb:${dataset?.name ?? 'local-analysis'}`,
      ...(dataset ? { dataset: dataset.relation } : {}),
      statement: originalSql,
      value: {
        dataset: dataset
          ? { id: dataset.id, version: dataset.version, sha256: dataset.sha256, path: dataset.relativePath }
          : undefined,
        columns: result.columns,
        rows: result.rows.slice(0, 20),
        rowCount: result.rowCount,
        truncated: result.truncated,
      },
      collectedAt: new Date().toISOString(),
    };

    await appendInvestigationEvidence(this.sessionName, evidence);

    getRegistryDatabase().prepare(`
      INSERT INTO local_analysis_runs
        (id, session_name, operation, dataset_id, sql, sql_hash, row_count, duration_ms, evidence_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      this.sessionName,
      operation,
      dataset?.id ?? null,
      originalSql,
      sqlHash,
      result.rowCount,
      durationMs,
      evidenceId,
      new Date().toISOString(),
    );

    return {
      ...result,
      analysisRunId: runId,
      evidenceId,
    };
  }
}

/** 返回当前 Investigation 的 DuckDB engine；每个 session 对应一个 analysis.duckdb。 */
export async function getLocalAnalytics(sessionName: string): Promise<LocalDuckDBEngine> {
  return ensureEngine(sessionName);
}

export async function localDescribe(sessionName: string, dataset: string): Promise<LocalQueryResult> {
  return (await ensureEngine(sessionName)).describe(dataset);
}

export async function localSample(sessionName: string, dataset: string, limit = 20): Promise<LocalQueryResult> {
  return (await ensureEngine(sessionName)).sample(dataset, limit);
}

export async function localProfile(sessionName: string, dataset: string): Promise<LocalQueryResult> {
  return (await ensureEngine(sessionName)).profile(dataset);
}

export async function localQuery(sessionName: string, sql: string, limit = 1000): Promise<LocalQueryResult> {
  return (await ensureEngine(sessionName)).query(sql, limit);
}

/** 停止服务时释放 DuckDB connections，并关闭 Dataset Registry 所在的 SQLite 连接。 */
export function closeLocalAnalytics(): void {
  for (const pending of engines.values()) {
    void pending.then((engine) => engine.connection.disconnectSync()).catch(() => undefined);
  }
  engines.clear();
  registryDb?.close();
  registryDb = undefined;
  registryPath = undefined;
}
