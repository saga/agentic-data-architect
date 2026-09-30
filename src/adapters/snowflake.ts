/**
 * Snowflake 数据库适配器。
 *
 * 实现 DatabaseAdapter 的只读能力，面向企业数据发现和 profiling，并隔离 Snowflake SDK 细节。
 */
import {
  boundedReadOnlyQuery,
  type ColumnInfo,
  type ColumnProfile,
  type DatabaseAdapter,
  type DatabaseInfo,
  type DataProfile,
  type QueryResult,
  type SchemaInfo,
  type TableInfo,
  type TableMetadata,
} from './database.js';
import type { SemanticAsset } from '../semantic/types.js';

/**
 * Snowflake 只读实现（企业侧 target 用）。驱动懒加载，没装时报错指路。
 * 连接串：snowflake://user:password@account/db/schema?warehouse=WH&role=ROLE
 */

type SfConn = {
  execute: (opts: {
    sqlText: string;
    binds?: unknown[];
    complete: (err: Error | undefined, stmt: unknown, rows: Record<string, unknown>[] | undefined) => void;
  }) => void;
  destroy: (cb: (err: Error | undefined) => void) => void;
};

/** 延迟加载 Snowflake SDK；不做数据库发现时不要求驱动已经加载。 */
async function loadDriver(): Promise<{
  createConnection: (opts: Record<string, string>) => { connect: (cb: (err: Error | undefined) => void) => void } & SfConn;
}> {
  try {
    return (await import('snowflake-sdk')) as unknown as {
      createConnection: (opts: Record<string, string>) => { connect: (cb: (err: Error | undefined) => void) => void } & SfConn;
    };
  } catch {
    throw new Error('Snowflake 驱动未安装：npm install snowflake-sdk 后再用（文件发现不受影响）');
  }
}

/** 把 snowflake:// 连接串拆成 SDK 所需的 account、用户、数据库、Schema、warehouse 和 role。 */
function parseUrl(conn: string): Record<string, string> {
  const u = new URL(conn);
  if (u.protocol !== 'snowflake:') throw new Error('非法 snowflake 连接串');
  const parts = u.pathname.split('/').filter(Boolean);
  return {
    account: u.hostname,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ...(parts[0] ? { database: parts[0] } : {}),
    ...(parts[1] ? { schema: parts[1] } : {}),
    ...(u.searchParams.get('warehouse') ? { warehouse: u.searchParams.get('warehouse') as string } : {}),
    ...(u.searchParams.get('role') ? { role: u.searchParams.get('role') as string } : {}),
  };
}

/** 校验并转义 Snowflake 标识符，禁止任意字符串直接进入 SQL。 */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`非法 Snowflake 标识符：${name}`);
  }
  return '"' + name.replace(/"/g, '""') + '"';
}

/** 将数据库表名拆成 database/schema/table 三段并校验格式。 */
function splitTable(table: string): { database?: string; schema: string; name: string } {
  const parts = table.split('.').map((p) => p.replace(/^"|"$/g, ''));
  if (parts.length > 3 || parts.length < 1 || parts.some((p) => !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(p))) {
    throw new Error(`非法表名（只允许 [db.][schema.]table）：${table}`);
  }
  const name = parts.pop() as string;
  const schema = parts.pop() ?? 'PUBLIC';
  const database = parts.pop();
  return { ...(database ? { database } : {}), schema, name };
}

/** 根据拆分后的结构重新生成安全的全限定表名。 */
function qualifiedTable(table: string): string {
  const parts = splitTable(table);
  return [parts.database, parts.schema, parts.name].filter((part): part is string => Boolean(part)).map(ident).join('.');
}

/** Snowflake 只读适配器，实现统一 DatabaseAdapter 契约。 */
export class SnowflakeAdapter implements DatabaseAdapter {
  readonly type = 'snowflake';
  private conn: SfConn | null = null;

  /** 保存 Snowflake 连接串，实际连接在 connect() 中建立。 */
constructor(private readonly connectionString: string) {}

  /** 创建 Snowflake SDK 连接并等待连接完成。 */
async connect(): Promise<void> {
    const sdk = await loadDriver();
    const connection = sdk.createConnection(parseUrl(this.connectionString));
    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => (err ? reject(err) : resolve()));
    });
    this.conn = connection;
  }

  /** 销毁现有 Snowflake 连接并清空引用。 */
async close(): Promise<void> {
    if (!this.conn) return;
    const c = this.conn;
    this.conn = null;
    await new Promise<void>((resolve) => c.destroy(() => resolve()));
  }

  /** 将 Snowflake callback 风格 execute 转换成 Promise，并统一返回 rows。 */
private q(text: string, binds: unknown[] = []): Promise<Record<string, unknown>[]> {
    if (!this.conn) throw new Error('未连接：先调用 connect()');
    const conn = this.conn;
    return new Promise((resolve, reject) => {
      conn.execute({ sqlText: text, binds, complete: (err, _stmt, rows) => (err ? reject(err) : resolve(rows ?? [])) });
    });
  }

  /** 查询当前账号可访问的数据库。 */
async listDatabases(): Promise<DatabaseInfo[]> {
    const rows = await this.q(`SHOW DATABASES`);
    return rows.map((r) => ({ name: String(r['name'] ?? r['NAME']) }));
  }

  /** 查询指定数据库下可访问的 Schema。 */
async listSchemas(database?: string): Promise<SchemaInfo[]> {
    const scope = database ? `${ident(database)}.` : '';
    const rows = await this.q(
      `SELECT SCHEMA_NAME AS name FROM ${scope}INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME NOT IN ('INFORMATION_SCHEMA') ORDER BY 1`,
    );
    return rows.map((r) => ({ name: String(r['NAME'] ?? r['name']), ...(database ? { database } : {}) }));
  }

  /** 查询指定 Schema 下的基础表。 */
async listTables(database?: string, schema = 'PUBLIC'): Promise<TableInfo[]> {
    const scope = database ? `${ident(database)}.` : '';
    const rows = await this.q(
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n FROM ${scope}INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_SCHEMA = ? ORDER BY 1,2`,
      [schema.toUpperCase()],
    );
    return rows.map((r) => {
      const s = String(r['S'] ?? r['s']);
      const n = String(r['N'] ?? r['n']);
      return {
        ...(database ? { database } : {}),
        schema: s,
        name: n,
        qualifiedName: `${database ? `${database}.` : ''}${s}.${n}`,
      };
    });
  }

  /** 查询表的列结构并转换成统一 TableMetadata。 */
async getTableMetadata(table: string): Promise<TableMetadata> {
    const parts = splitTable(table);
    const name = parts.name;
    const schema = parts.schema;
    const database = parts.database;
    const scope = database ? `${ident(database)}.` : '';
    const rows = await this.q(
      `SELECT COLUMN_NAME AS n, DATA_TYPE AS t, IS_NULLABLE AS nu FROM ${scope}INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema.toUpperCase(), name.toUpperCase()],
    );
    const columns: ColumnInfo[] = rows.map((r) => ({
      name: String(r['N'] ?? r['n']),
      dataType: String(r['T'] ?? r['t']),
      nullable: String(r['NU'] ?? r['nu']) !== 'NO',
    }));
    if (columns.length === 0) throw new Error(`表不存在或无权访问：${table}`);
    const qualifiedName = [database, schema, name].filter(Boolean).join('.');
    return { ...(database ? { database } : {}), schema, name, qualifiedName, columns };
  }

  /** 对指定表执行受限采样，避免把大量原始数据拉到 Agent。 */
async sample(table: string, limit: number): Promise<Record<string, unknown>[]> {
    const n = Math.min(Math.max(Math.floor(limit), 1), 1000);
    return this.q(`SELECT * FROM ${qualifiedTable(table)} LIMIT ${n}`);
  }

  /** 聚合计算行数、空值率、distinct 比率、min/max，并收集少量样本值。 */
async profile(table: string, columns?: string[]): Promise<DataProfile> {
    const meta = await this.getTableMetadata(table);
    const from = qualifiedTable(table);
    const wanted = columns?.length ? new Set(columns.map((x) => x.toUpperCase())) : null;
    const selected = meta.columns.filter((col) => !wanted || wanted.has(col.name.toUpperCase()));
    const supportsMinMax = (type: string): boolean => {
      const t = type.toUpperCase();
      return [
        'NUMBER', 'DECIMAL', 'NUMERIC', 'INT', 'INTEGER', 'BIGINT', 'SMALLINT',
        'FLOAT', 'DOUBLE', 'DOUBLE PRECISION', 'VARCHAR', 'CHAR', 'CHARACTER', 'TEXT',
        'DATE', 'TIMESTAMP', 'TIMESTAMP_LTZ', 'TIMESTAMP_NTZ', 'TIMESTAMP_TZ', 'TIME',
      ].includes(t);
    };
    const aggregateParts = selected.flatMap((col, i) => {
      const id = ident(col.name);
      const parts = [
        'COUNT(' + id + ') AS "nn_' + i + '"',
        'COUNT(DISTINCT ' + id + ') AS "d_' + i + '"',
      ];
      if (supportsMinMax(col.dataType)) {
        parts.push('TO_VARCHAR(MIN(' + id + ')) AS "lo_' + i + '"', 'TO_VARCHAR(MAX(' + id + ')) AS "hi_' + i + '"');
      }
      return parts;
    });
    const aggregateSql = 'SELECT COUNT(*) AS "__row_count__"' +
      (aggregateParts.length ? ', ' + aggregateParts.join(', ') : '') +
      ' FROM ' + from;
    const [agg] = await this.q(aggregateSql);
    const rowCount = Number(agg?.['__row_count__'] ?? agg?.['__ROW_COUNT__'] ?? 0);
    const sampleRows = await this.sample(table, 100);
    const profiles: ColumnProfile[] = selected.map((col, i) => {
      const nonNull = Number(agg?.['nn_' + i] ?? agg?.['NN_' + i] ?? 0);
      const distinctCount = Number(agg?.['d_' + i] ?? agg?.['D_' + i] ?? 0);
      const samples: unknown[] = [];
      for (const row of sampleRows) {
        const value = row[col.name] ?? row[col.name.toUpperCase()];
        if (value == null || samples.some((v) => Object.is(v, value))) continue;
        samples.push(value);
        if (samples.length >= 5) break;
      }
      const lo = agg?.['lo_' + i] ?? agg?.['LO_' + i];
      const hi = agg?.['hi_' + i] ?? agg?.['HI_' + i];
      return {
        column: col.name,
        dataType: col.dataType,
        nullable: col.nullable,
        rowCount,
        nullCount: rowCount - nonNull,
        nullRate: rowCount === 0 ? 0 : (rowCount - nonNull) / rowCount,
        distinctCount,
        distinctRate: rowCount === 0 ? 0 : distinctCount / rowCount,
        ...(lo != null ? { min: String(lo) } : {}),
        ...(hi != null ? { max: String(hi) } : {}),
        ...(samples.length ? { sampleValues: samples } : {}),
      };
    });
    return { dataset: meta.qualifiedName, rowCount, columns: profiles, profiledAt: new Date().toISOString() };
  }
  /** 执行只读定向 SQL，并统一把结果控制在最多 1000 行。 */
async query(sql: string): Promise<QueryResult> {
    const rows = await this.q(boundedReadOnlyQuery(sql));
    const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];
    return { columns, rows: rows.slice(0, 1000), rowCount: rows.length, truncated: rows.length >= 1000 };
  }
  /**
   * 发现当前账号可见的 Semantic View。
   * 返回通用 SemanticAsset，不让核心 workflow 依赖 Snowflake。
   */
  async listSemanticAssets(schema?: string): Promise<SemanticAsset[]> {
    const rows = await this.q('SHOW SEMANTIC VIEWS');
    return rows
      .filter((row) => {
        const rowSchema = String(row['schema_name'] ?? row['SCHEMA_NAME'] ?? '');
        return !schema || rowSchema.toUpperCase() === schema.toUpperCase();
      })
      .map((row) => {
        const database = String(row['database_name'] ?? row['DATABASE_NAME'] ?? '');
        const rowSchema = String(row['schema_name'] ?? row['SCHEMA_NAME'] ?? '');
        const name = String(row['name'] ?? row['NAME'] ?? '');
        const qualifiedName = [database, rowSchema, name].filter(Boolean).join('.');
        const description = String(row['comment'] ?? row['COMMENT'] ?? '').trim();
        return {
          id: 'snowflake:semantic_view:' + qualifiedName.toLowerCase(),
          kind: 'semantic_view' as const,
          provider: 'snowflake',
          name,
          qualifiedName,
          ...(description ? { description } : {}),
          attributes: { database, schema: rowSchema },
        };
      })
      .filter((asset) => Boolean(asset.name));
  }
}
