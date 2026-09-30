/**
 * Current-State Intelligence 数据模型。
 *
 * 这些对象描述“目前发现了什么”，不是 Target Architecture。
 * candidate 一律保留 evidenceIds，便于 Agent 解释和人工确认。
 */
import type { SemanticAsset } from '../semantic/types.js';

export interface CurrentStateCoverage {
  filesScanned: number;
  sqlFiles: number;
  sqlParsedStatements: number;
  sqlParseFailures: number;
  datasets: number;
  connectedDatasets: number;
  datasetLineageCoverage: number | null;
  columnLineageEdges: number;
  semanticAssets: number;
  profiledDatasets: number;
}

export interface SourceOfTruthCandidate {
  key: string;
  candidateDatasetIds: string[];
  candidateDatasets: string[];
  score: number;
  reasons: string[];
  evidenceIds: string[];
}

export interface SemanticCandidate {
  key: string;
  kind: 'business_concept' | 'entity' | 'identifier' | 'metric' | 'temporal_dimension';
  names: string[];
  physicalAssets: string[];
  semanticAssets: string[];
  evidenceIds: string[];
}

export interface CurrentStateIntelligence {
  generatedAt: string;
  coverage: CurrentStateCoverage;
  sourceOfTruthCandidates: SourceOfTruthCandidate[];
  semanticCandidates: SemanticCandidate[];
  semanticAssets: SemanticAsset[];
  highValueAssets: string[];
}
