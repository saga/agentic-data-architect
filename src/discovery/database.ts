import { createAdapter } from '../adapters/postgres.js';
import { SnowflakeAdapter } from '../adapters/snowflake.js';
import type { DatabaseAdapter, DataProfile } from '../adapters/database.js';
import { nextId, type EvidenceRef } from '../evidence/types.js';
import { emptyEstate, nodeId, type DataEstate } from '../model/estate.js';

/**
 * Database discovery（§十二）：metadata → 定向 metadata → 最后才 profiling。
 * 默认只扫 metadata；--profile 才对表做聚合（仍然只读、有行数上限守卫）。
 */

export interface DatabaseDiscoveryInput {
  connectionString: string;
  investigationId: string;
  discoveryRunId: string;
  schema?: string;
  maxTables?: number;
  profile?: boolean;
  maxProfileTables?: number;
}

export interface DatabaseDiscoveryResult {
  adapterType: string;
  estate: DataEstate;
  profiles: DataProfile[];
  evidence: EvidenceRef[];
  unknowns: string[];
}

export function openAdapter(connectionString: string): DatabaseAdapter {
  if (/^snowflake:\/\//.test(connectionString)) return new SnowflakeAdapter(connectionString);
  return createAdapter(connectionString);
}

export async function discoverDatabase(input: DatabaseDiscoveryInput): Promise<DatabaseDiscoveryResult> {
  const adapter = openAdapter(input.connectionString);
  const estate = emptyEstate();
  const evidence: EvidenceRef[] = [];
  const unknowns: string[] = [];
  const profiles: DataProfile[] = [];
  const now = () => new Date().toISOString();
  const maxTables = input.maxTables ?? 200;

  await adapter.connect();
  try {
    const tables = await adapter.listTables(undefined, input.schema);
    const picked = tables.slice(0, maxTables);
    if (tables.length > maxTables) {
      unknowns.push(`表太多（${tables.length}），只收前 ${maxTables} 张；缩小 schema 后再扫`);
    }
    for (const t of picked) {
      const dsId = nodeId('dataset', t.qualifiedName);
      estate.nodes.push({
        id: dsId,
        type: 'dataset',
        name: t.qualifiedName,
        attributes: { adapter: adapter.type, schema: t.schema },
      });
      let meta;
      try {
        meta = await adapter.getTableMetadata(t.qualifiedName);
      } catch (e) {
        unknowns.push(`读不到 ${t.qualifiedName} 的列信息：${e instanceof Error ? e.message : e}`);
        continue;
      }
      evidence.push({
        id: nextId('ev'),
        type: 'metadata',
        investigationId: input.investigationId,
        discoveryRunId: input.discoveryRunId,
        source: `${adapter.type}:${t.qualifiedName} (${meta.columns.length} columns)`,
        dataset: t.qualifiedName,
        value: { columns: meta.columns },
        collectedAt: now(),
      });
      for (const col of meta.columns) {
        estate.nodes.push({
          id: nodeId('column', `${t.qualifiedName}.${col.name}`),
          type: 'column',
          name: `${t.qualifiedName}.${col.name}`,
          attributes: { dataType: col.dataType, nullable: col.nullable },
        });
        estate.edges.push({
          id: nextId('e'),
          from: dsId,
          to: nodeId('column', `${t.qualifiedName}.${col.name}`),
          type: 'contains',
          evidenceIds: [evidence[evidence.length - 1]?.id ?? ''],
        });
      }
    }
    if (input.profile) {
      const limit = input.maxProfileTables ?? 20;
      for (const t of picked.slice(0, limit)) {
        try {
          const p = await adapter.profile(t.qualifiedName);
          profiles.push(p);
          evidence.push({
            id: nextId('ev'),
            type: 'profiling',
            investigationId: input.investigationId,
            discoveryRunId: input.discoveryRunId,
            source: `${adapter.type}:${t.qualifiedName} rows=${p.rowCount}`,
            dataset: t.qualifiedName,
            value: { rowCount: p.rowCount },
            collectedAt: now(),
          });
        } catch (e) {
          unknowns.push(`profile 失败 ${t.qualifiedName}：${e instanceof Error ? e.message : e}`);
        }
      }
      if (picked.length > limit) unknowns.push(`只 profile 前 ${limit} 张表，其余需要定向指定`);
    } else {
      unknowns.push('本次只扫了 metadata，没有做 profiling（加 --profile 才做）');
    }
  } finally {
    await adapter.close();
  }
  return { adapterType: adapter.type, estate, profiles, evidence, unknowns };
}
