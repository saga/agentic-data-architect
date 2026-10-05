/**
 * Current-State Intelligence 构建器。
 *
 * 这里只根据结构化发现结果生成候选，不让 LLM 自己宣布 source of truth。
 */
import type { DataProfile } from '../adapters/database.js';
import type { Inventory } from '../discovery/scanner.js';
import type { SemanticAsset } from '../semantic/types.js';
import type { DataEstate } from '../model/estate.js';
import type { LineageGraph } from './lineage.js';
import {
  datasetLineageRelations,
  incidentEdges,
  nodesOfType,
  upstreamDatasetRelations,
  downstreamDatasetRelations,
} from '../model/estate-query.js';
import type {
  CurrentStateCoverage,
  CurrentStateIntelligence,
  SemanticCandidate,
  SourceOfTruthCandidate,
} from '../model/current-state.js';

function semanticKey(name: string): string {
  const last = name.replace(/"/g, '').split('.').filter(Boolean).at(-1) || name;
  return last
    .toLowerCase()
    .replace(/^(stg_|raw_|ods_|dw_|dwh_|dim_|fact_)/, '')
    .replace(/(_stg|_raw|_ods|_dw|_dwh|_snapshot|_history|_archive|_legacy)$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function columnKind(name: string): SemanticCandidate['kind'] | null {
  const n = name.toLowerCase();
  if (/_id$/.test(n) || /^id$/.test(n)) return 'identifier';
  if (/(date|time|timestamp|as_of|effective|valid_from|valid_to)/.test(n)) return 'temporal_dimension';
  if (/(qty|quantity|amount|value|price|count|rate|pct|percent|balance)/.test(n)) return 'metric';
  return null;
}

/**
 * Source-of-Truth candidates are calculated from the canonical DataEstate.
 * LineageGraph remains an analysis result for parser-specific details, but is
 * no longer queried here for graph traversal.
 */
function buildSourceCandidates(estate: DataEstate): SourceOfTruthCandidate[] {
  const datasets = nodesOfType(estate, 'dataset');
  const grouped = new Map<string, typeof datasets>();

  for (const dataset of datasets) {
    const key = semanticKey(dataset.name);
    if (!key) continue;
    const list = grouped.get(key) || [];
    list.push(dataset);
    grouped.set(key, list);
  }

  const result: SourceOfTruthCandidate[] = [];

  for (const [key, items] of grouped) {
    // 只有同一业务键存在多个物理 dataset 时才生成 Source-of-Truth candidate。
    // 单一 dataset 只是“已发现资产”，不能因为它存在就宣称需要选 source of truth。
    if (items.length < 2) continue;

    const scored = items.map((dataset) => {
      const upstream = upstreamDatasetRelations(estate, dataset.id).length;
      const downstream = downstreamDatasetRelations(estate, dataset.id).length;
      const metadataSignals = Object.keys(dataset.attributes).length;
      const priorityScore = downstream * 3 - upstream + Math.min(metadataSignals, 3);

      const reasons: string[] = [];
      if (downstream > 0) reasons.push('下游有 ' + downstream + ' 条已发现依赖');
      if (upstream > 0) reasons.push('上游有 ' + upstream + ' 条已发现依赖');
      if (metadataSignals > 0) reasons.push('已有数据元信息');

      const evidenceIds = incidentEdges(estate, dataset.id).flatMap((edge) => edge.evidenceIds);

      return { dataset, priorityScore, reasons, evidenceIds };
    }).sort((a, b) => b.priorityScore - a.priorityScore);

    const top = scored.slice(0, 5);
    result.push({
      key,
      candidateDatasetIds: top.map((item) => item.dataset.id),
      candidateDatasets: top.map((item) => item.dataset.name),
      priorityScore: top[0]?.priorityScore ?? 0,
      reasons: top[0]?.reasons || [],
      evidenceIds: [...new Set(top.flatMap((item) => item.evidenceIds))],
    });
  }

  return result
    .filter((item) => item.candidateDatasets.length > 0)
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

function buildSemanticCandidates(estate: DataEstate, semanticAssets: SemanticAsset[]): SemanticCandidate[] {
  const candidates = new Map<string, SemanticCandidate>();

  for (const node of estate.nodes) {
    if (node.type !== 'column' && node.type !== 'dataset') continue;
    const key = semanticKey(node.name);
    if (!key) continue;

    const kind = node.type === 'column' ? columnKind(node.name) : 'business_concept' as const;
    if (!kind) continue;

    const candidateKey = kind + ':' + key;
    const candidate = candidates.get(candidateKey) || {
      key,
      kind,
      names: [],
      physicalAssets: [],
      semanticAssets: [],
      evidenceIds: [],
    };

    if (!candidate.names.includes(node.name)) candidate.names.push(node.name);
    if (!candidate.physicalAssets.includes(node.id)) candidate.physicalAssets.push(node.id);
    candidates.set(candidateKey, candidate);
  }

  for (const asset of semanticAssets) {
    const key = semanticKey(asset.name);
    if (!key) continue;

    const candidateKey = 'business_concept:' + key;
    const candidate = candidates.get(candidateKey) || {
      key,
      kind: 'business_concept' as const,
      names: [],
      physicalAssets: [],
      semanticAssets: [],
      evidenceIds: [],
    };

    if (!candidate.names.includes(asset.name)) candidate.names.push(asset.name);
    if (!candidate.semanticAssets.includes(asset.id)) candidate.semanticAssets.push(asset.id);
    candidate.evidenceIds.push(...(asset.evidenceIds || []));
    candidates.set(candidateKey, candidate);
  }

  return [...candidates.values()]
    .map((item) => ({ ...item, evidenceIds: [...new Set(item.evidenceIds)] }))
    .filter((item) => item.physicalAssets.length > 0 || item.semanticAssets.length > 0)
    .sort(
      (a, b) =>
        b.physicalAssets.length + b.semanticAssets.length -
        (a.physicalAssets.length + a.semanticAssets.length),
    );
}

export function buildCurrentStateIntelligence(args: {
  inventory: Inventory | null;
  estate: DataEstate;
  lineage: LineageGraph | null;
  profiles: DataProfile[];
  semanticAssets?: SemanticAsset[];
}): CurrentStateIntelligence {
  const semanticAssets = args.semanticAssets || [];
  const datasetNodes = nodesOfType(args.estate, 'dataset');
  const datasets = datasetNodes.map((node) => node.name);

  // 这里只统计当前 estate 中已知 dataset 的连接，避免把外部/未建模对象算进 datasets。
  const connected = new Set<string>();
  for (const relation of datasetLineageRelations(args.estate)) {
    connected.add(relation.source.id);
    connected.add(relation.target.id);
  }

  const sourceOfTruthCandidates = buildSourceCandidates(args.estate);
  const semanticCandidates = buildSemanticCandidates(args.estate, semanticAssets);

  const coverage: CurrentStateCoverage = {
    filesScanned: args.inventory?.files.length || 0,
    sqlFiles: args.inventory?.sqlFiles.length || 0,
    sqlParsedStatements: args.lineage?.statements.length || 0,
    sqlParseFailures: args.lineage?.parseFailures.length || 0,
    datasets: datasets.length,
    connectedDatasets: connected.size,
    datasetLineageConnectionRate: datasets.length === 0
      ? null
      : connected.size / datasets.length,
    columnLineageEdges: args.lineage?.columns.length || 0,
    semanticAssets: semanticAssets.length,
    profiledDatasets: args.profiles.length,
  };

  return {
    generatedAt: new Date().toISOString(),
    coverage,
    sourceOfTruthCandidates,
    semanticCandidates,
    semanticAssets,
    highValueAssets: [...new Set(
      sourceOfTruthCandidates.slice(0, 10).flatMap((item) => item.candidateDatasets),
    )],
  };
}
