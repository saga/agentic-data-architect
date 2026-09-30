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

/**
 * PostgreSQL 只读实现（本地开发用）。`pg` 懒加载：没装也能跑文件发现，
 * 用到 DB 时才报错提示安装。
 *
 * 连接：PG_URL（libpq 连接串），如 postgres://user:pass@localhost:5432/db
 */

type PgClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};

async function loadPg(): Promise<{ Client: new (conn: string) => PgClient }> {
  try {
    return (await import('pg')) as unknown as { Client: new (conn: string) => PgClient };
  } catch {
    throw new Error('PostgreSQL 驱动未安装：npm install pg 后再用 discover-db（文件发现不受影响）');
  }
}

function ident(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** 只接受 [table] / [schema.table] / [db.schema.table]，防止注入。 */
function splitTable(table: string): { schema: string; name: string } {
  const parts = table.split('.').map((p) => p.replace(/^"|"$/g, ''));
  if (parts.length > 3 || parts.some((p) => !/^[A-Za-z_][\w$]*$/.test(p))) {
    throw new Error(`非法表名（只允许 [db.][schema.]table）：${table}`);
  }
  const name = parts.pop() as string;
  const schema = parts.pop() ?? 'public';
  return { schema, name };
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly type = 'postgres';
  private client: PgClient | null = null;

  constructor(private readonly connectionString: string) {}

  async connect(): Promise<void> {
    if (!this.connectionString) throw new Error('缺少连接串：设置 PG_URL');
    const { Client } = await loadPg();
    this.client = new Client(this.connectionString);
    await (this.client as unknown as { connect: () => Promise<void> }).connect();
  }

  async close(): Promise<void> {
    await this.client?.end();
    this.client = null;
  }

  private q(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    if (!this.client) throw new Error('未连接：先调用 connect()');
    return this.client.query(text, params).then((r) => r.rows);
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    const rows = await this.q(`SELECT datname AS name FROM pg_database WHERE datistemplate = false ORDER BY 1`);
    return rows.map((r) => ({ name: String(r['name']) }));
  }

  async listSchemas(): Promise<SchemaInfo[]> {
    const rows = await this.q(
      `SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY 1`,
    );
    return rows.map((r) => ({ name: String(r['name']) }));
  }

  async listTables(_database?: string, schema?: string): Promise<TableInfo[]> {
    const rows = await this.q(
      `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables WHERE table_type='BASE TABLE' AND ($1::text IS NULL OR table_schema = $1) ORDER BY 1,2`,
      [schema ?? null],
    );
    return rows.map((r) => {
      const s = String(r['schema']);
      const n = String(r['name']);
      return { schema: s, name: n, qualifiedName: `${s}.${n}` };
    });
  }

  async getTableMetadata(table: string): Promise<TableMetadata> {
    const { schema, name } = splitTable(table);
    const rows = await this.q(
      `SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, name],
    );
    const columns: ColumnInfo[] = rows.map((r) => ({
      name: String(r['name']),
      dataType: String(r['type']),
      nullable: String(r['nullable']) !== 'NO',
    }));
    if (columns.length === 0) throw new Error(`表不存在或无权访问：${table}`);
    let rowCountEstimate: number | undefined;
    try {
      const est = await this.q(`SELECT reltuples::bigint AS est FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, name]);
      const v = Number(est[0]?.['est']);
      if (Number.isFinite(v) && v >= 0) rowCountEstimate = v;
    } catch {
      /* 估计值拿不到不致命 */
    }
    return {
      schema,
      name,
      qualifiedName: `${schema}.${name}`,
      columns,
      ...(rowCountEstimate !== undefined ? { rowCountEstimate } : {}),
    };
  }

  async sample(table: string, limit: number): Promise<Record<string, unknown>[]> {
    const { schema, name } = splitTable(table);
    const n = Math.min(Math.max(Math.floor(limit), 1), 1000);
    return this.q(`SELECT * FROM ${ident(schema)}.${ident(name)} LIMIT ${n}`);
  }

  async profile(table: string, columns?: string[]): Promise<DataProfile> {
    const meta = await this.getTableMetadata(table);
    const { schema, name } = splitTable(table);
    const from = ident(schema) + '.' + ident(name);
    const wanted = columns?.length ? new Set(columns) : null;
    const selected = meta.columns.filter((col) => !wanted || wanted.has(col.name));
    const supportsMinMax = (type: string): boolean => {
      const t = type.toLowerCase();
      return [
        'smallint', 'integer', 'bigint', 'numeric', 'decimal', 'real', 'double precision',
        'date', 'timestamp without time zone', 'timestamp with time zone',
        'time without time zone', 'time with time zone', 'character varying', 'character', 'text',
      ].includes(t);
    };
    const aggregateParts = selected.flatMap((col, i) => {
      const c = ident(col.name);
      const parts = [
        'COUNT(' + c + ')::bigint AS "nn_' + i + '"',
        'COUNT(DISTINCT ' + c + ')::bigint AS "d_' + i + '"',
      ];
      if (supportsMinMax(col.dataType)) {
        parts.push('MIN(' + c + ')::text AS "lo_' + i + '"', 'MAX(' + c + ')::text AS "hi_' + i + '"');
      }
      return parts;
    });
    const aggregateSql = 'SELECT COUNT(*)::bigint AS "__row_count__"' +
      (aggregateParts.length ? ', ' + aggregateParts.join(', ') : '') +
      ' FROM ' + from;
    const [agg] = await this.q(aggregateSql);
    const rowCount = Number(agg?.['__row_count__'] ?? 0);
    const sampleRows = await this.sample(table, 100);
    const profiles: ColumnProfile[] = selected.map((col, i) => {
      const nonNull = Number(agg?.['nn_' + i] ?? 0);
      const distinctCount = Number(agg?.['d_' + i] ?? 0);
      const samples: unknown[] = [];
      for (const row of sampleRows) {
        const value = row[col.name];
        if (value == null || samples.some((v) => Object.is(v, value))) continue;
        samples.push(value);
        if (samples.length >= 5) break;
      }
      const lo = agg?.['lo_' + i];
      const hi = agg?.['hi_' + i];
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
  async query(sql: string): Promise<QueryResult> {
    const rows = await this.q(boundedReadOnlyQuery(sql));
    const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];
    const truncated = rows.length >= 1000;
    return { columns, rows: rows.slice(0, 1000), rowCount: rows.length, truncated };
  }
}

/** 连接串路由（postgres 同步可用；snowflake 请直接 new SnowflakeAdapter）。 */
export function createAdapter(connectionString: string): DatabaseAdapter {
  if (/^postgres(ql)?:\/\//.test(connectionString)) return new PostgresAdapter(connectionString);
  throw new Error(`不支持的连接串（V1.1：postgres:// 走这里，snowflake:// 请用 SnowflakeAdapter）：${connectionString.split('://')[0] ?? ''}://...`);
}

export type { TableInfo, TableMetadata };
