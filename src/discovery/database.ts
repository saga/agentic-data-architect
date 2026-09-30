/**
 * 数据库 Discovery 编排。
 *
 * 本文件的注释说明职责、输入输出和关键设计原因，方便后续维护。
 */
import { createAdapter } from '../adapters/postgres.js';
import { SnowflakeAdapter } from '../adapters/snowflake.js';
import { profileDataset } from '../analysis/profiling.js';
import type { DatabaseAdapter, DataProfile } from '../adapters/database.js';
import type { SemanticAsset } from '../semantic/types.js';
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

/** 数据库 Discovery 输出，包括 Data Estate、profiles、Evidence 和未知项。 */
export interface DatabaseDiscoveryResult {
  adapterType: string;
  estate: DataEstate;
  profiles: DataProfile[];
  semanticAssets: SemanticAsset[];
  evidence: EvidenceRef[];
  unknowns: string[];
}

/** 根据连接串选择 PostgreSQL 或 Snowflake 适配器。 */
export function openAdapter(connectionString: string): DatabaseAdapter {
  if (/^snowflake:\/\//.test(connectionString)) return new SnowflakeAdapter(connectionString);
  return createAdapter(connectionString);
}

/** 执行数据库发现：先 metadata，再按需 profiling，并把无法确认的事项记录为 unknown。 */
export async function discoverDatabase(input: DatabaseDiscoveryInput): Promise<DatabaseDiscoveryResult> {
  const adapter = openAdapter(input.connectionString);
  const estate = emptyEstate();
  const evidence: EvidenceRef[] = [];
  const unknowns: string[] = [];
  const profiles: DataProfile[] = [];
  const semanticAssets: SemanticAsset[] = [];
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
      const schemaName = t.schema ?? 'PUBLIC';
      const schemaKey = (t.database ? t.database + '.' : '') + schemaName;
      const schemaId = nodeId('schema', schemaKey);
      if (!estate.nodes.some((n) => n.id === schemaId)) {
        estate.nodes.push({
          id: schemaId,
          type: 'schema',
          name: schemaKey,
          attributes: { adapter: adapter.type, database: t.database },
        });
      }
      if (t.database) {
        const databaseId = nodeId('database', t.database);
        if (!estate.nodes.some((n) => n.id === databaseId)) {
          estate.nodes.push({
            id: databaseId,
            type: 'database',
            name: t.database,
            attributes: { adapter: adapter.type },
          });
        }
        if (!estate.edges.some((e) => e.from === databaseId && e.to === schemaId && e.type === 'contains')) {
          estate.edges.push({ id: nextId('e'), from: databaseId, to: schemaId, type: 'contains', evidenceIds: [] });
        }
      }
      estate.nodes.push({
        id: dsId,
        type: 'dataset',
        name: t.qualifiedName,
        attributes: { adapter: adapter.type, schema: t.schema },
      });
      estate.edges.push({ id: nextId('e'), from: schemaId, to: dsId, type: 'contains', evidenceIds: [] });
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
          const p = await profileDataset(adapter, t.qualifiedName, input.investigationId, input.discoveryRunId);
          profiles.push(p.profile);
          evidence.push(...p.evidence);
        } catch (e) {
          unknowns.push(`profile 失败 ${t.qualifiedName}：${e instanceof Error ? e.message : e}`);
        }
      }
      if (picked.length > limit) unknowns.push(`只 profile 前 ${limit} 张表，其余需要定向指定`);
    } else {
      unknowns.push('本次只扫了 metadata，没有做 profiling（加 --profile 才做）');
    }
    if (adapter.listSemanticAssets) {
      try {
        const discovered = await adapter.listSemanticAssets(input.schema);
        for (const asset of discovered) {
          const evidenceId = nextId('ev');
          const enriched = {
            ...asset,
            evidenceIds: [...new Set([...(asset.evidenceIds ?? []), evidenceId])],
          };
          semanticAssets.push(enriched);
          evidence.push({
            id: evidenceId,
            type: 'semantic_context',
            investigationId: input.investigationId,
            discoveryRunId: input.discoveryRunId,
            source: asset.provider + ':' + (asset.qualifiedName ?? asset.name),
            value: asset,
            collectedAt: now(),
          });
        }
      } catch (error) {
        unknowns.push(
          '读取业务语义资产失败：' +
          (error instanceof Error ? error.message : String(error)) +
          '。这不会影响表和列的发现。',
        );
      }
    }

  } finally {
    await adapter.close();
  }
  return { adapterType: adapter.type, estate, profiles, semanticAssets, evidence, unknowns };
}
