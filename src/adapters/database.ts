/**
 * 只读数据库适配器。
 * 默认先 metadata，再 profile / targeted query；所有查询都做只读校验并限制结果量。
 */

export interface DatabaseInfo { name: string; }
/** 数据库 Schema 的最小描述，用于发现和过滤范围。 */
export interface SchemaInfo { database?: string; name: string; }
/** 表/数据集的统一元数据，屏蔽不同数据库驱动的差异。 */
export interface TableInfo {
  database?: string;
  schema?: string;
  name: string;
  qualifiedName: string;
}
/** 数据库列的基本结构信息。 */
export interface ColumnInfo { name: string; dataType: string; nullable: boolean; }
/** 一张表的完整 metadata，包括列和可选的行数估计。 */
export interface TableMetadata extends TableInfo {
  columns: ColumnInfo[];
  rowCountEstimate?: number;
}
/** 只读 SQL 的标准化执行结果，避免上层依赖具体驱动返回值。 */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}
/** 数据库适配器统一契约：连接、metadata、sample、profiling 和只读查询。 */
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
/** 单列 profiling 结果，记录空值、distinct、范围和少量样本。 */
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
/** 单个数据集的 profiling 汇总结果。 */
export interface DataProfile {
  dataset: string;
  rowCount: number;
  columns: ColumnProfile[];
  profiledAt: string;
}

/** 清理注释和字符串字面量，避免 SQL 只读守卫被字符串内容误导。 */
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

/** 在只读校验后统一增加结果行数上限，防止一次读取过多数据。 */
export function boundedReadOnlyQuery(sql: string, limit = 1000): string {
  assertReadOnly(sql);
  const trimmed = sql.trim().replace(/;\s*$/g, '');
  return `SELECT * FROM (${trimmed}) AS __agent_result LIMIT ${Math.min(Math.max(Math.floor(limit), 1), 1000)}`;
}
