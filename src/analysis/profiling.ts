import type { DatabaseAdapter, DataProfile } from '../adapters/database.js';
import { nextId, type EvidenceRef } from '../evidence/types.js';

/**
 * Profiling（§十三）：只做 row count / null % / distinct % / min-max / sample。
 * 复杂统计学不做。每次 profile 发射 metadata + profiling 两类证据。
 */

export interface ProfileResult {
  profile: DataProfile;
  evidence: EvidenceRef[];
}

export async function profileDataset(
  adapter: DatabaseAdapter,
  table: string,
  investigationId: string,
  discoveryRunId: string,
  columns?: string[],
): Promise<ProfileResult> {
  const meta = await adapter.getTableMetadata(table);
  const profile = await adapter.profile(table, columns);
  const now = new Date().toISOString();
  const evidence: EvidenceRef[] = [
    {
      id: nextId('ev'),
      type: 'metadata',
      investigationId,
      discoveryRunId,
      source: `${adapter.type}:${meta.qualifiedName} (columns: ${meta.columns.map((c) => c.name).join(', ')})`,
      dataset: meta.qualifiedName,
      value: { columns: meta.columns },
      collectedAt: now,
    },
    {
      id: nextId('ev'),
      type: 'profiling',
      investigationId,
      discoveryRunId,
      source: `${adapter.type}:${meta.qualifiedName} rows=${profile.rowCount}`,
      dataset: meta.qualifiedName,
      value: { rowCount: profile.rowCount },
      collectedAt: now,
    },
  ];
  for (const col of profile.columns) {
    evidence.push({
      id: nextId('ev'),
      type: 'profiling',
      investigationId,
      discoveryRunId,
      source: `${adapter.type}:${meta.qualifiedName}.${col.column} null=${(col.nullRate * 100).toFixed(1)}% distinct=${(col.distinctRate * 100).toFixed(1)}%`,
      dataset: meta.qualifiedName,
      column: col.column,
      value: {
        nullRate: col.nullRate,
        distinctRate: col.distinctRate,
        min: col.min,
        max: col.max,
        sampleValues: col.sampleValues,
      },
      collectedAt: now,
    });
  }
  return { profile, evidence };
}
