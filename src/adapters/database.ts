/**
 * 只读数据库适配器。
 * 默认先 metadata，再 profile / targeted query；所有查询都做只读校验并限制结果量。
 */

export interface DatabaseInfo { name: string; }
export interface SchemaInfo { database?: string; name: string; }
export interface TableInfo {
  database?: string;
  schema?: string;
  name: string;
  qualifiedName: string;
}
export interface ColumnInfo { name: string; dataType: string; nullable: boolean; }
export interface TableMetadata extends TableInfo {
  columns: ColumnInfo[];
  rowCountEstimate?: number;
}
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}
export interface DatabaseAdapter {
  readonly type: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  listDatabases(): Promise<DatabaseInfo[]>;
  listSchemas(database?: string): Promise<SchemaInfo[]>;
  listTables(database?: string, schema?: string): Promise<TableInfo[]>;
  getTableMetadata(table: string): Promise<TableMetadata>;
  sample(table: string, limit: number): Promise<Record<string, unknown>[]>;
  profile(table: string, columns?: string[]): Promise<DataProfile>;
  query(sql: string): Promise<QueryResult>;
}
export interface ColumnProfile {
  column: string;
  dataType: string;
  nullable: boolean;
  rowCount: number;
  nullCount: number;
  nullRate: number;
  distinctCount: number;
  distinctRate: number;
  min?: string;
  max?: string;
  sampleValues?: unknown[];
}
export interface DataProfile {
  dataset: string;
  rowCount: number;
  columns: ColumnProfile[];
  profiledAt: string;
}

function sanitizeSqlForGuard(sql: string): string {
  return sql
    .replace(/--[^\n]*(?:\n|$)/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ')
    .replace(/"(?:\\"|[^"])*"/g, ' ')
    .replace(/\`(?:\\`|[^\`])*\`/g, ' ');
}

/** query() 入口统一守卫：只允许单条 SELECT/WITH，禁止 DML/DDL/执行命令。 */
export function assertReadOnly(sql: string): void {
  const safe = sanitizeSqlForGuard(sql).trim();
  if (!/^(select|with)\b/i.test(safe)) {
    throw new Error(`只允许单条只读查询（SELECT/WITH 开头），拒绝执行：${sql.slice(0, 120)}`);
  }

  const dangerous = /\b(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy|call|execute|put|get|remove)\b/i;
  if (dangerous.test(safe) || /\bFOR\s+(UPDATE|SHARE)\b/i.test(safe) || /^\s*SELECT\b[\s\S]*\bINTO\s+/i.test(safe)) {
    throw new Error(`查询包含不允许的写入或执行命令，已拒绝：${sql.slice(0, 120)}`);
  }

  const semicolonPositions: number[] = [];
  for (let i = 0; i < safe.length; i++) if (safe[i] === ';') semicolonPositions.push(i);
  if (semicolonPositions.some((p) => safe.slice(p + 1).trim().length > 0)) {
    throw new Error(`只允许单条只读查询，不能拼接多条 SQL：${sql.slice(0, 120)}`);
  }
}

export function boundedReadOnlyQuery(sql: string, limit = 1000): string {
  assertReadOnly(sql);
  const trimmed = sql.trim().replace(/;\s*$/g, '');
  return `SELECT * FROM (${trimmed}) AS __agent_result LIMIT ${Math.min(Math.max(Math.floor(limit), 1), 1000)}`;
}
