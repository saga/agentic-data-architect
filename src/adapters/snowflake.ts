import {
  assertReadOnly,
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

export class SnowflakeAdapter implements DatabaseAdapter {
  readonly type = 'snowflake';
  private conn: SfConn | null = null;

  constructor(private readonly connectionString: string) {}

  async connect(): Promise<void> {
    const sdk = await loadDriver();
    const connection = sdk.createConnection(parseUrl(this.connectionString));
    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => (err ? reject(err) : resolve()));
    });
    this.conn = connection;
  }

  async close(): Promise<void> {
    if (!this.conn) return;
    const c = this.conn;
    this.conn = null;
    await new Promise<void>((resolve) => c.destroy(() => resolve()));
  }

  private q(text: string, binds: unknown[] = []): Promise<Record<string, unknown>[]> {
    if (!this.conn) throw new Error('未连接：先调用 connect()');
    const conn = this.conn;
    return new Promise((resolve, reject) => {
      conn.execute({ sqlText: text, binds, complete: (err, _stmt, rows) => (err ? reject(err) : resolve(rows ?? [])) });
    });
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    const rows = await this.q(`SHOW DATABASES`);
    return rows.map((r) => ({ name: String(r['name'] ?? r['NAME']) }));
  }

  async listSchemas(database?: string): Promise<SchemaInfo[]> {
    const rows = await this.q(
      `SELECT SCHEMA_NAME AS name FROM ${database ? `${database}.` : ''}INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME NOT IN ('INFORMATION_SCHEMA') ORDER BY 1`,
    );
    return rows.map((r) => ({ name: String(r['NAME'] ?? r['name']), ...(database ? { database } : {}) }));
  }

  async listTables(database?: string, schema = 'PUBLIC'): Promise<TableInfo[]> {
    const scope = database ? `${database}.` : '';
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

  async getTableMetadata(table: string): Promise<TableMetadata> {
    const parts = table.split('.');
    const name = parts.pop() as string;
    const schema = parts.pop() ?? 'PUBLIC';
    const database = parts.pop();
    const scope = database ? `${database}.` : '';
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
    const qualifiedName = `${database ? `${database}.` : ''}${schema}.${name}`;
    return { ...(database ? { database } : {}), schema, name, qualifiedName, columns };
  }

  async sample(table: string, limit: number): Promise<Record<string, unknown>[]> {
    const n = Math.min(Math.max(Math.floor(limit), 1), 1000);
    return this.q(`SELECT * FROM ${table} LIMIT ${n}`);
  }

  async profile(table: string, columns?: string[]): Promise<DataProfile> {
    const meta = await this.getTableMetadata(table);
    const [c] = await this.q(`SELECT COUNT(*) AS C FROM ${table}`);
    const rowCount = Number(c?.['C'] ?? 0);
    const wanted = columns?.length ? new Set(columns.map((x) => x.toUpperCase())) : null;
    const profiles: ColumnProfile[] = [];
    for (const col of meta.columns) {
      if (wanted && !wanted.has(col.name.toUpperCase())) continue;
      const id = `"${col.name.replace(/"/g, '""')}"`;
      const [agg] = await this.q(
        `SELECT COUNT(*) AS N, COUNT(${id}) AS NN, COUNT(DISTINCT ${id}) AS D FROM ${table}`,
      );
      const n = Number(agg?.['N'] ?? 0);
      const nonNull = Number(agg?.['NN'] ?? 0);
      let min: string | undefined;
      let max: string | undefined;
      try {
        const [mm] = await this.q(`SELECT MIN(${id})::STRING AS LO, MAX(${id})::STRING AS HI FROM ${table}`);
        if (mm?.['LO'] != null) min = String(mm['LO']);
        if (mm?.['HI'] != null) max = String(mm['HI']);
      } catch {
        /* 半结构化类型跳过 min/max */
      }
      profiles.push({
        column: col.name,
        dataType: col.dataType,
        nullable: col.nullable,
        rowCount: n,
        nullCount: n - nonNull,
        nullRate: n === 0 ? 0 : (n - nonNull) / n,
        distinctCount: Number(agg?.['D'] ?? 0),
        distinctRate: n === 0 ? 0 : Number(agg?.['D'] ?? 0) / n,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
      });
    }
    return { dataset: meta.qualifiedName, rowCount, columns: profiles, profiledAt: new Date().toISOString() };
  }

  async query(sql: string): Promise<QueryResult> {
    assertReadOnly(sql);
    const rows = await this.q(sql);
    const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];
    return { columns, rows: rows.slice(0, 1000), rowCount: rows.length, truncated: rows.length >= 1000 };
  }
}
