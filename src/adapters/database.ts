/**
 * 只读数据库适配器（§十一、§二十二）。
 * 全部只读：没有 write / ddl / dml 入口。profiling 永远先 metadata，
 * 再小 sample，最后才 targeted 聚合，禁止 SELECT * 大表。
 */

export interface DatabaseInfo {
  name: string;
}

export interface SchemaInfo {
  database?: string;
  name: string;
}

export interface TableInfo {
  database?: string;
  schema?: string;
  name: string;
  qualifiedName: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
}

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
  /** 只允许 SELECT / WITH 开头的只读语句，由 query() 自检。 */
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

const READ_ONLY = /^\s*(select|with|values|explain)\b/i;

/** query() 入口统一守卫：非只读语句直接拒绝。 */
export function assertReadOnly(sql: string): void {
  const stripped = sql.replace(/^--[^\n]*\n/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (!READ_ONLY.test(stripped) || /;\s*\S/.test(stripped)) {
    throw new Error(`只允许单条只读查询（SELECT/WITH 开头），拒绝执行：${sql.slice(0, 120)}`);
  }
}
