/**
 * Local Data Workbench：Dataset Registry + DuckDB analytical engine。
 *
 * 这里故意不把 DuckDB 做成整个应用的主数据库：
 * - SQLite 继续保存应用状态、对话、Dataset Registry 和分析运行记录；
 * - 每个 Investigation 有自己的 analysis.duckdb，负责分析计算；
 * - 原始 CSV/JSON/JSONL/Parquet/XLSX 文件仍保留在 workspace 中；
 * - Agent 只能通过受限 local_* 工具使用已登记的数据集；分析结果继续绑定 Dataset 版本和 Evidence。
 *
 * 这样做的好处是“应用状态”和“数据分析”互不抢职责，而且整个工作台仍然是
 * 单机、单用户、无需数据库服务的本地应用。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { config } from '../config.js';
import { conversationDbFile } from '../investigation/conversation.js';
import { appendInvestigationEvidence, workspaceRoot } from '../investigation/workspace.js';
import { nextId, type EvidenceRef } from '../evidence/types.js';

export type LocalDatasetFormat = 'csv' | 'json' | 'jsonl' | 'parquet' | 'xlsx';

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
  operation: 'catalog' | 'describe' | 'sample' | 'profile' | 'query' | 'transform' | 'export' | 'explain' | 'reconcile';
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

export interface LocalTransformResult {
  schema: 'analysis' | 'scratch';
  name: string;
  relation: string;
  rowCount: number;
  replaced: boolean;
  analysisRunId: string;
  evidenceId: string;
}

export interface LocalReconcileMeasureResult {
  name: string;
  sourceSum: number | null;
  targetSum: number | null;
  difference: number | null;
  mismatchKeys: number;
}

export interface LocalReconcileResult {
  source: { id: string; name: string; relation: string; rowCount: number };
  target: { id: string; name: string; relation: string; rowCount: number };
  keys: string[];
  sourceDuplicateGroups: number;
  targetDuplicateGroups: number;
  missingRows: number;
  extraRows: number;
  matchRate: number | null;
  measures: LocalReconcileMeasureResult[];
  analysisRunId: string;
  evidenceId: string;
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
  '.xlsx': 'xlsx',
};

function getRegistryDatabase(): DatabaseSync {
  const file = conversationDbFile();
  if (registryDb && registryPath === file) return registryDb;

  registryDb?.close();
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
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
      format TEXT NOT NULL CHECK (format IN ('csv','json','jsonl','parquet','xlsx')),
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
      operation TEXT NOT NULL CHECK (operation IN ('catalog','describe','sample','profile','query','transform','export','explain','reconcile')),
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

  // SQLite 不会因为 CREATE TABLE IF NOT EXISTS 自动更新旧 CHECK constraint。
  // 已有用户的 conversations.db 可能还只允许 csv/json/jsonl/parquet，或旧的 analysis_runs operation 集合。
  // 因此这里做一次很小的兼容迁移，避免新版本第一次读取 XLSX / reconcile / explain 时才爆错。
  migrateLocalAnalyticsSchema(registryDb);
  return registryDb;
}

/** 把历史 Dataset Registry / Analysis Run 表迁移到当前 CHECK constraint；只执行一次。 */
function migrateLocalAnalyticsSchema(db: DatabaseSync): void {
  const datasetSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_datasets'").get() as { sql?: string } | undefined;
  const runsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_analysis_runs'").get() as { sql?: string } | undefined;
  const datasetNeedsMigration = Boolean(datasetSchema?.sql && !datasetSchema.sql.includes("'xlsx'"));
  const runsNeedsMigration = Boolean(runsSchema?.sql && (!runsSchema.sql.includes("'explain'") || !runsSchema.sql.includes("'reconcile'")));

  if (!datasetNeedsMigration && !runsNeedsMigration) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (datasetNeedsMigration) {
      db.exec("CREATE TABLE local_datasets_migrating (id TEXT PRIMARY KEY, session_name TEXT NOT NULL, name TEXT NOT NULL, relative_path TEXT NOT NULL, format TEXT NOT NULL CHECK (format IN ('csv','json','jsonl','parquet','xlsx')), relation TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, updated_at TEXT NOT NULL, UNIQUE(session_name, relative_path)) STRICT");
      db.exec("INSERT INTO local_datasets_migrating SELECT id, session_name, name, relative_path, format, relation, version, sha256, size_bytes, updated_at FROM local_datasets");
      db.exec('DROP TABLE local_datasets');
      db.exec('ALTER TABLE local_datasets_migrating RENAME TO local_datasets');
    }
    if (runsNeedsMigration) {
      db.exec("CREATE TABLE local_analysis_runs_migrating (id TEXT PRIMARY KEY, session_name TEXT NOT NULL, operation TEXT NOT NULL CHECK (operation IN ('catalog','describe','sample','profile','query','transform','export','explain','reconcile')), dataset_id TEXT, sql TEXT NOT NULL, sql_hash TEXT NOT NULL, row_count INTEGER, duration_ms INTEGER NOT NULL, evidence_id TEXT, created_at TEXT NOT NULL) STRICT");
      db.exec('INSERT INTO local_analysis_runs_migrating SELECT id, session_name, operation, dataset_id, sql, sql_hash, row_count, duration_ms, evidence_id, created_at FROM local_analysis_runs');
      db.exec('DROP TABLE local_analysis_runs');
      db.exec('ALTER TABLE local_analysis_runs_migrating RENAME TO local_analysis_runs');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_local_datasets_session ON local_datasets(session_name, updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_local_analysis_runs_session ON local_analysis_runs(session_name, created_at)');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
    throw error;
  }
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
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
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

function absoluteDatasetPath(sessionName: string, relativePath: string, allowMissing = false): string {
  const root = path.resolve(workspaceRoot(sessionName));
  const normalized = normalizeRelativePath(relativePath);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('本地数据路径超出当前 Investigation workspace。');
  }

  const realRoot = fsSync.realpathSync(root);
  if (!allowMissing) {
    // 输入文件必须检查最终 realpath，防止 workspace 内的符号链接指向外部文件。
    const realPath = fsSync.realpathSync(resolved);
    if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
      throw new Error('本地数据路径不能通过符号链接离开当前 Investigation workspace。');
    }
    return realPath;
  }

  // 输出文件可能尚不存在，只检查它最近的已存在父目录，防止 exports/parquet
  // 本身是指向 workspace 外部的符号链接。
  let existingParent = resolved;
  while (!fsSync.existsSync(existingParent) && path.dirname(existingParent) !== existingParent) {
    existingParent = path.dirname(existingParent);
  }
  const realParent = fsSync.realpathSync(existingParent);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
    throw new Error('本地数据输出路径不能通过符号链接离开当前 Investigation workspace。');
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
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fsSync.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** 登记一个本地数据文件；只有第一次或文件确实变了才重新计算完整 SHA-256。 */
export async function registerLocalDataset(
  sessionName: string,
  relativePath: string,
  displayName?: string,
): Promise<LocalDataset> {
  const normalized = normalizeRelativePath(relativePath);
  const format = inferFormat(normalized);
  if (!format) throw new Error('不支持的本地数据格式：' + relativePath + '。支持 CSV、JSON、JSONL、Parquet、XLSX。');

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

  const sha256 = unchanged ? existing!.sha256 : await hashFile(file.absolute);
  const id = existing?.id
    ?? 'ds-' + createHash('sha256').update(sessionName + '\0' + normalized).digest('hex').slice(0, 16);
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
  `).run(id, sessionName, name, normalized, format, relation, version, sha256, file.sizeBytes, file.updatedAt);

  return datasetRowToModel(db.prepare(`
    SELECT id, session_name, name, relative_path, format, relation, version, sha256, size_bytes, updated_at
    FROM local_datasets WHERE id = ?
  `).get(id) as unknown as DatasetRow);
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
    } catch (error) {
      console.warn('[local-data] Unable to scan directory; skipping it.', {
        directory,
        error,
      });
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
    } catch (error) {
      console.warn('[local-data] Unable to register a discovered dataset; continuing with the rest.', {
        sessionName,
        relativePath: relative,
        error,
      });
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
    case 'xlsx':
      return `SELECT * FROM read_xlsx(${source})`;
  }
}

function validObjectName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function outputRelativePath(value: string): string {
  const normalized = normalizeRelativePath(value);
  if (!(normalized.startsWith('exports/') || normalized.startsWith('parquet/'))) {
    throw new Error('Parquet 输出文件必须放在当前 Investigation 的 exports/ 或 parquet/ 目录中。');
  }
  if (path.posix.extname(normalized).toLowerCase() !== '.parquet') {
    throw new Error('Parquet 输出文件必须使用 .parquet 扩展名。');
  }
  return normalized;
}

function escapeIdentifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

/** 只允许 SELECT/WITH，且严禁 Agent 绕过 Dataset Registry 直接读文件、网络或其它数据库。 */
export function validateLocalReadOnlySql(sql: string): string {
  const sanitized = sql.replace(/--[^\n]*(?:\n|$)/g, ' ')
    .replace(/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ')
    .trim();

  if (!/^(select|with)\b/i.test(sanitized)) {
    throw new Error('本地分析只允许执行 SELECT 或 WITH 查询。');
  }

  const dangerous = /\b(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy|attach|detach|install|load|export|import|call|execute|pragma|set|vacuum)\b/i;
  if (
    dangerous.test(sanitized)
    || /\bFOR\s+(UPDATE|SHARE)\b/i.test(sanitized)
    || /^\s*SELECT\b[\s\S]*\bINTO\s+/i.test(sanitized)
  ) {
    throw new Error('本地分析查询包含不允许的写入、文件或扩展操作。');
  }

  if (
    /\b(read_csv_auto|read_csv|read_parquet|read_json_auto|read_json|read_xlsx|read_text|read_blob|read_csv_objects|parquet_scan|glob|httpfs|sqlite_scan|postgres_scan)\s*\(/i.test(sanitized)
    || /https?:\/\//i.test(sanitized)
  ) {
    throw new Error('本地分析查询必须使用已经登记的数据集，不能自己读取文件、网络或其它数据库。');
  }

  const trimmed = sql.trim().replace(/;\s*$/g, '');
  if (sanitized.replace(/;\s*$/g, '').includes(';')) throw new Error('本地分析一次只能执行一条查询。');
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
    readonly connection: DuckDBConnection,
  ) {}

  static async create(sessionName: string): Promise<LocalDuckDBEngine> {
    const root = workspaceRoot(sessionName);
    await fs.mkdir(root, { recursive: true });

    // DuckDB uses the database filename as the default catalog name. If the
    // catalog is also called "analysis", references such as analysis.table are
    // ambiguous because "analysis" is both catalog and schema.
    // Keep the schema name "analysis", but use a different database filename.
    const legacyDbFile = path.join(root, 'analysis.duckdb');
    const dbFile = path.join(root, 'local.duckdb');
    try {
      await fs.access(legacyDbFile);
      try {
        await fs.access(dbFile);
      } catch {
        await fs.rename(legacyDbFile, dbFile);
      }
    } catch {
      // No legacy database to migrate.
    }

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
      const started = Date.now();
      const sql = "DESCRIBE SELECT * FROM " + dataset.relation;
      const reader = await this.connection.runAndReadAll(sql);
      const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
      return this.recordResult(
        'describe',
        sql,
        dataset,
        {
          columns: reader.columnNames(),
          rows: rows.slice(0, 200),
          rowCount: rows.length,
          truncated: rows.length > 200,
          sql,
          analysisRunId: '',
          evidenceId: '',
          dataset: { id: dataset.id, version: dataset.version, sha256: dataset.sha256 },
        },
        started,
      );
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

  /**
   * 使用 DuckDB 原生 SUMMARIZE 完成列级 profiling。它一次扫描即可返回 count、NULL 比例、
   * approx_unique、min/max、均值、标准差和近似分位数，比逐列执行多个聚合更适合大文件。
   */
  async summarize(datasetRef: string): Promise<LocalQueryResult> {
    return this.exclusive(async () => {
      await this.refreshViews();
      const dataset = getDataset(this.sessionName, datasetRef);
      const started = Date.now();
      const sql = 'SUMMARIZE ' + dataset.relation;
      const reader = await this.connection.runAndReadAll(sql);
      const summarized = reader.getRowObjectsJson() as Array<Record<string, unknown>>;
      const rows = summarized.map((row) => {
        const count = Number(row.count ?? 0);
        const nullPercentage = Number(row.null_percentage ?? 0);
        const approxUnique = Number(row.approx_unique ?? 0);
        return {
          column: row.column_name,
          type: row.column_type,
          rowCount: count,
          nullCount: Math.max(0, Math.round(count * nullPercentage / 100)),
          nullRate: nullPercentage / 100,
          distinctCount: approxUnique,
          distinctRate: count > 0 ? approxUnique / count : 0,
          min: row.min ?? null,
          max: row.max ?? null,
          avg: row.avg ?? null,
          std: row.std ?? null,
          q25: row.q25 ?? null,
          q50: row.q50 ?? null,
          q75: row.q75 ?? null,
        };
      });
      const result: LocalQueryResult = {
        columns: ['column','type','rowCount','nullCount','nullRate','distinctCount','distinctRate','min','max','avg','std','q25','q50','q75'],
        rows,
        rowCount: rows.length ? Number(rows[0]?.rowCount ?? 0) : 0,
        truncated: false,
        sql,
        analysisRunId: '',
        evidenceId: '',
        dataset: { id: dataset.id, version: dataset.version, sha256: dataset.sha256 },
      };
      return this.recordResult('profile', sql, dataset, result, started);
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

  /**
   * 对两个已登记数据集执行确定性的迁移对账：记录数、重复主键、缺失/多余记录和 measure 汇总差异。
   * 该操作直接使用 DuckDB 做全量计算，并把 source/target 版本、SQL 和结果写成 Evidence。
   */
  async reconcile(
    sourceRef: string,
    targetRef: string,
    keys: string[],
    measures: string[] = [],
    tolerance = 0,
  ): Promise<LocalReconcileResult> {
    return this.exclusive(async () => {
      await this.refreshViews();
      const source = getDataset(this.sessionName, sourceRef);
      const target = getDataset(this.sessionName, targetRef);
      const normalizedKeys = [...new Set(keys.map((value) => value.trim()).filter(Boolean))];
      const normalizedMeasures = [...new Set(measures.map((value) => value.trim()).filter(Boolean))];
      if (normalizedKeys.length === 0) throw new Error('reconciliation 至少需要一个业务主键。');
      if (normalizedKeys.length > 12) throw new Error('reconciliation 最多支持 12 个主键列。');
      if (normalizedMeasures.length > 20) throw new Error('reconciliation 最多支持 20 个 measure。');
      if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('reconciliation tolerance 必须是 >= 0 的数字。');

      const sourceMetaReader = await this.connection.runAndReadAll('DESCRIBE SELECT * FROM ' + source.relation);
      const targetMetaReader = await this.connection.runAndReadAll('DESCRIBE SELECT * FROM ' + target.relation);
      const sourceMeta = sourceMetaReader.getRowObjectsJson() as Array<{ column_name: string; column_type: string }>;
      const targetMeta = targetMetaReader.getRowObjectsJson() as Array<{ column_name: string; column_type: string }>;
      const sourceColumns = new Map(sourceMeta.map((item) => [String(item.column_name).toLowerCase(), item]));
      const targetColumns = new Map(targetMeta.map((item) => [String(item.column_name).toLowerCase(), item]));
      for (const key of normalizedKeys) {
        if (!sourceColumns.has(key.toLowerCase()) || !targetColumns.has(key.toLowerCase())) {
          throw new Error('reconciliation 主键列必须同时存在于 source 和 target：' + key);
        }
      }
      const numericTypes = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL|REAL|NUMERIC)/i;
      for (const measure of normalizedMeasures) {
        const sourceType = sourceColumns.get(measure.toLowerCase())?.column_type;
        const targetType = targetColumns.get(measure.toLowerCase())?.column_type;
        if (!sourceType || !targetType) throw new Error('reconciliation measure 必须同时存在于 source 和 target：' + measure);
        if (!numericTypes.test(String(sourceType)) || !numericTypes.test(String(targetType))) {
          throw new Error('reconciliation measure 必须是数值类型：' + measure);
        }
      }

      const keySql = normalizedKeys.map(escapeIdentifier).join(', ');
      const joinSql = normalizedKeys.map((key) =>
        's.' + escapeIdentifier(key) + ' IS NOT DISTINCT FROM t.' + escapeIdentifier(key),
      ).join(' AND ');
      const started = Date.now();
      const rowCountSql = 'SELECT (SELECT count(*) FROM ' + source.relation + ') AS source_rows, ' +
        '(SELECT count(*) FROM ' + target.relation + ') AS target_rows';
      const rowCountReader = await this.connection.runAndReadAll(rowCountSql);
      const rowCount = (rowCountReader.getRowObjectsJson() as Record<string, unknown>[])[0] ?? {};
      const sourceRows = Number(rowCount.source_rows ?? 0);
      const targetRows = Number(rowCount.target_rows ?? 0);

      const duplicateSql = 'SELECT ' +
        '(SELECT count(*) FROM (SELECT ' + keySql + ', count(*) AS __n FROM ' + source.relation + ' GROUP BY ' + keySql + ' HAVING count(*) > 1) q) AS source_duplicate_groups, ' +
        '(SELECT count(*) FROM (SELECT ' + keySql + ', count(*) AS __n FROM ' + target.relation + ' GROUP BY ' + keySql + ' HAVING count(*) > 1) q) AS target_duplicate_groups';
      const duplicateReader = await this.connection.runAndReadAll(duplicateSql);
      const duplicateRow = (duplicateReader.getRowObjectsJson() as Record<string, unknown>[])[0] ?? {};
      const sourceDuplicateGroups = Number(duplicateRow.source_duplicate_groups ?? 0);
      const targetDuplicateGroups = Number(duplicateRow.target_duplicate_groups ?? 0);

      const missingSql = 'SELECT count(*) AS missing_rows FROM ' + source.relation + ' s WHERE NOT EXISTS ' +
        '(SELECT 1 FROM ' + target.relation + ' t WHERE ' + joinSql + ')';
      const extraSql = 'SELECT count(*) AS extra_rows FROM ' + target.relation + ' t WHERE NOT EXISTS ' +
        '(SELECT 1 FROM ' + source.relation + ' s WHERE ' + joinSql + ')';
      const missingReader = await this.connection.runAndReadAll(missingSql);
      const extraReader = await this.connection.runAndReadAll(extraSql);
      const missingRows = Number(((missingReader.getRowObjectsJson() as Record<string, unknown>[])[0] ?? {}).missing_rows ?? 0);
      const extraRows = Number(((extraReader.getRowObjectsJson() as Record<string, unknown>[])[0] ?? {}).extra_rows ?? 0);

      const measureResults: LocalReconcileMeasureResult[] = [];
      for (const measure of normalizedMeasures) {
        const sourceMeasure = escapeIdentifier(String(sourceColumns.get(measure.toLowerCase())!.column_name));
        const targetMeasure = escapeIdentifier(String(targetColumns.get(measure.toLowerCase())!.column_name));
        const aggregateSql = 'SELECT ' +
          '(SELECT sum(CAST(' + sourceMeasure + ' AS DOUBLE)) FROM ' + source.relation + ') AS source_sum, ' +
          '(SELECT sum(CAST(' + targetMeasure + ' AS DOUBLE)) FROM ' + target.relation + ') AS target_sum';
        const aggregateReader = await this.connection.runAndReadAll(aggregateSql);
        const aggregate = (aggregateReader.getRowObjectsJson() as Record<string, unknown>[])[0] ?? {};
        const sourceSum = aggregate.source_sum === null || aggregate.source_sum === undefined ? null : Number(aggregate.source_sum);
        const targetSum = aggregate.target_sum === null || aggregate.target_sum === undefined ? null : Number(aggregate.target_sum);
        const mismatchSql = 'WITH source_groups AS (' +
          ' SELECT ' + keySql + ', sum(CAST(' + sourceMeasure + ' AS DOUBLE)) AS value FROM ' + source.relation + ' GROUP BY ' + keySql + '),' +
          ' target_groups AS (' +
          ' SELECT ' + keySql + ', sum(CAST(' + targetMeasure + ' AS DOUBLE)) AS value FROM ' + target.relation + ' GROUP BY ' + keySql + ')' +
          ' SELECT count(*) AS mismatch_keys FROM source_groups s JOIN target_groups t ON ' + joinSql +
          ' WHERE CASE WHEN s.value IS NULL AND t.value IS NULL THEN false' +
          ' WHEN s.value IS NULL OR t.value IS NULL THEN true ELSE abs(s.value - t.value) > ' + String(Number(tolerance)) + ' END';
        const mismatchReader = await this.connection.runAndReadAll(mismatchSql);
        const mismatchKeys = Number(((mismatchReader.getRowObjectsJson() as Record<string, unknown>[])[0] ?? {}).mismatch_keys ?? 0);
        measureResults.push({
          name: measure,
          sourceSum,
          targetSum,
          difference: sourceSum !== null && targetSum !== null ? targetSum - sourceSum : null,
          mismatchKeys,
        });
      }

      const denominator = Math.max(sourceRows, targetRows);
      const matchRate = denominator === 0 ? null : Math.max(0, 1 - (missingRows + extraRows) / denominator);
      const runId = nextId('analysis');
      const evidenceId = nextId('ev');
      const statement = JSON.stringify({ rowCountSql, duplicateSql, missingSql, extraSql, normalizedKeys, normalizedMeasures, tolerance });
      const evidence: EvidenceRef = {
        id: evidenceId,
        type: 'query_result',
        investigationId: this.sessionName,
        discoveryRunId: 'local:' + runId,
        source: 'duckdb:reconcile:' + source.name + ' → ' + target.name,
        statement,
        value: {
          source: { id: source.id, version: source.version, sha256: source.sha256, relation: source.relation, rows: sourceRows },
          target: { id: target.id, version: target.version, sha256: target.sha256, relation: target.relation, rows: targetRows },
          keys: normalizedKeys,
          sourceDuplicateGroups,
          targetDuplicateGroups,
          missingRows,
          extraRows,
          matchRate,
          measures: measureResults,
          tolerance,
        },
        collectedAt: new Date().toISOString(),
      };
      await appendInvestigationEvidence(this.sessionName, evidence);
      const sqlHash = createHash('sha256').update(statement).digest('hex');
      getRegistryDatabase().prepare(
        "INSERT INTO local_analysis_runs (id, session_name, operation, dataset_id, sql, sql_hash, row_count, duration_ms, evidence_id, created_at) VALUES (?, ?, 'reconcile', NULL, ?, ?, ?, ?, ?, ?)"
      ).run(runId, this.sessionName, statement, sqlHash, denominator, Date.now() - started, evidenceId, new Date().toISOString());
      return {
        source: { id: source.id, name: source.name, relation: source.relation, rowCount: sourceRows },
        target: { id: target.id, name: target.name, relation: target.relation, rowCount: targetRows },
        keys: normalizedKeys,
        sourceDuplicateGroups,
        targetDuplicateGroups,
        missingRows,
        extraRows,
        matchRate,
        measures: measureResults,
        analysisRunId: runId,
        evidenceId,
      };
    });
  }

  /**
   * 输出 DuckDB 的实际执行计划和运行时间，专用于复杂 SQL 的性能排查。
   * 用户 SQL 仍先经过只读/file-access guard，因此 Agent 不能借 explain 绕过本地数据边界。
   */
  async explain(sql: string): Promise<LocalQueryResult> {
    return this.exclusive(async () => {
      await this.refreshViews();
      const safeSql = validateLocalReadOnlySql(sql);
      const statement = 'EXPLAIN ANALYZE ' + safeSql;
      const started = Date.now();
      const reader = await this.connection.runAndReadAll(statement);
      const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
      const explainDatasets = listLocalDatasets(this.sessionName)
        .filter((item) => safeSql.includes(item.relation));
      const explainDataset = explainDatasets.length === 1 ? explainDatasets[0] : undefined;
      const result: LocalQueryResult = {
        columns: reader.columnNames(),
        rows: rows.slice(0, 50),
        rowCount: rows.length,
        truncated: rows.length > 50,
        sql: statement,
        analysisRunId: '',
        evidenceId: '',
        ...(explainDataset ? {
          dataset: {
            id: explainDataset.id,
            version: explainDataset.version,
            sha256: explainDataset.sha256,
          },
        } : {}),
      };
      return this.recordResult('explain', statement, explainDataset, result, started);
    });
  }
  async transform(
    schema: 'analysis' | 'scratch',
    table: string,
    sql: string,
    replace = true,
  ): Promise<LocalTransformResult> {
    return this.exclusive(async () => {
      await this.refreshViews();
      const safeSql = validateLocalReadOnlySql(sql);
      if (!validObjectName(table)) {
        throw new Error('分析表名称只能使用字母、数字和下划线，并且不能数字开头。');
      }

      const relation = schema + '.' + escapeIdentifier(table);
      const statement = (replace ? 'CREATE OR REPLACE TABLE ' : 'CREATE TABLE ') + relation + ' AS ' + safeSql;
      const started = Date.now();
      await this.connection.run(statement);

      const countReader = await this.connection.runAndReadAll('SELECT count(*) AS row_count FROM ' + relation);
      const row = (countReader.getRowObjectsJson() as Record<string, unknown>[])[0] ?? {};
      const rowCount = Number(row.row_count ?? 0);

      const runId = nextId('analysis');
      const evidenceId = nextId('ev');
      const sqlHash = createHash('sha256').update(safeSql).digest('hex');
      const referencedDatasets = listLocalDatasets(this.sessionName)
        .filter((item) => safeSql.includes(item.relation));

    const evidence: EvidenceRef = {
        id: evidenceId,
        type: 'metadata',
        investigationId: this.sessionName,
        discoveryRunId: 'local:' + runId,
        source: 'duckdb:derived',
        statement: safeSql,
        value: {
          target: relation,
          schema,
          table,
          rowCount,
          replaced: replace,
          datasets: referencedDatasets.map((item) => ({
            id: item.id,
            version: item.version,
            sha256: item.sha256,
            relation: item.relation,
          })),
        },
        collectedAt: new Date().toISOString(),
      };
      await appendInvestigationEvidence(this.sessionName, evidence);

      getRegistryDatabase().prepare(
        "INSERT INTO local_analysis_runs " +
        "(id, session_name, operation, dataset_id, sql, sql_hash, row_count, duration_ms, evidence_id, created_at) " +
        "VALUES (?, ?, 'transform', NULL, ?, ?, ?, ?, ?, ?)"
      ).run(
        runId,
        this.sessionName,
        safeSql,
        sqlHash,
        rowCount,
        Date.now() - started,
        evidenceId,
        new Date().toISOString(),
      );

      return {
        schema,
        name: table,
        relation,
        rowCount,
        replaced: replace,
        analysisRunId: runId,
        evidenceId,
      };
    });
  }

  async exportParquet(sql: string, relativePath: string): Promise<LocalDataset> {
    return this.exclusive(async () => {
      await this.refreshViews();
      const safeSql = validateLocalReadOnlySql(sql);
      const output = outputRelativePath(relativePath);
      const absolute = absoluteDatasetPath(this.sessionName, output, true);
      await fs.mkdir(path.dirname(absolute), { recursive: true });

      const started = Date.now();
      const outputSql = sqlLiteral(absolute);
      await this.connection.run(
        "COPY (" + safeSql + ") TO " + outputSql + " (FORMAT PARQUET, COMPRESSION ZSTD)",
      );

      const dataset = await registerLocalDataset(
        this.sessionName,
        output,
        path.basename(output, '.parquet'),
      );

      const runId = nextId('analysis');
      const evidenceId = nextId('ev');
      const sqlHash = createHash('sha256').update(safeSql).digest('hex');
      const evidence: EvidenceRef = {
        id: evidenceId,
        type: 'metadata',
        investigationId: this.sessionName,
        discoveryRunId: 'local:' + runId,
        source: 'duckdb:export',
        dataset: dataset.relation,
        statement: safeSql,
        sourceHash: dataset.sha256,
        value: {
          outputPath: output,
          datasetId: dataset.id,
          datasetVersion: dataset.version,
          sizeBytes: dataset.sizeBytes,
        },
        collectedAt: new Date().toISOString(),
      };
      await appendInvestigationEvidence(this.sessionName, evidence);

      getRegistryDatabase().prepare(
        "INSERT INTO local_analysis_runs " +
        "(id, session_name, operation, dataset_id, sql, sql_hash, row_count, duration_ms, evidence_id, created_at) " +
        "VALUES (?, ?, 'export', ?, ?, ?, NULL, ?, ?, ?)"
      ).run(
        runId,
        this.sessionName,
        dataset.id,
        safeSql,
        sqlHash,
        Date.now() - started,
        evidenceId,
        new Date().toISOString(),
      );

      return dataset;
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
    const referencedDatasets = dataset
      ? [dataset]
      : listLocalDatasets(this.sessionName).filter((item) => sql.includes(item.relation));
    const evidenceDataset = referencedDatasets.length === 1 ? referencedDatasets[0] : undefined;

    return this.recordResult(operation, sql, evidenceDataset, result, started);
  }

  private async recordResult(
    operation: 'describe' | 'sample' | 'profile' | 'query' | 'explain',
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
      ...(dataset ? { dataset: dataset.relation, sourceHash: dataset.sha256 } : {}),
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

/** 返回当前 Investigation 的 DuckDB engine；每个 session 对应一个 local.duckdb。 */
export async function getLocalAnalytics(sessionName: string): Promise<LocalDuckDBEngine> {
  return ensureEngine(sessionName);
}

export async function localReconcile(
  sessionName: string,
  source: string,
  target: string,
  keys: string[],
  measures: string[] = [],
  tolerance = 0,
): Promise<LocalReconcileResult> {
  return (await ensureEngine(sessionName)).reconcile(source, target, keys, measures, tolerance);
}

export async function localExplain(sessionName: string, sql: string): Promise<LocalQueryResult> {
  return (await ensureEngine(sessionName)).explain(sql);
}
export async function localDescribe(sessionName: string, dataset: string): Promise<LocalQueryResult> {
  return (await ensureEngine(sessionName)).describe(dataset);
}

export async function localSample(sessionName: string, dataset: string, limit = 20): Promise<LocalQueryResult> {
  return (await ensureEngine(sessionName)).sample(dataset, limit);
}

export async function localProfile(sessionName: string, dataset: string): Promise<LocalQueryResult> {
  return (await ensureEngine(sessionName)).summarize(dataset);
}

export async function localTransform(
  sessionName: string,
  schema: 'analysis' | 'scratch',
  table: string,
  sql: string,
  replace = true,
): Promise<LocalTransformResult> {
  return (await ensureEngine(sessionName)).transform(schema, table, sql, replace);
}

export async function localExportParquet(
  sessionName: string,
  sql: string,
  relativePath: string,
): Promise<LocalDataset> {
  return (await ensureEngine(sessionName)).exportParquet(sql, relativePath);
}

export async function localQuery(sessionName: string, sql: string, limit = 1000): Promise<LocalQueryResult> {
  return (await ensureEngine(sessionName)).query(sql, limit);
}

/** 停止服务时释放 DuckDB connections，并关闭 Dataset Registry 所在的 SQLite 连接。 */
export async function closeLocalAnalytics(): Promise<void> {
  const pendingEngines = [...engines.values()];
  engines.clear();

  const closeResults = await Promise.allSettled(
    pendingEngines.map(async (pending) => {
      const engine = await pending;
      engine.connection.disconnectSync();
    }),
  );
  for (const result of closeResults) {
    if (result.status === 'rejected') {
      console.error('[local-data] Failed to close DuckDB connection during shutdown.', result.reason);
    }
  }
  registryDb?.close();
  registryDb = undefined;
  registryPath = undefined;
}
