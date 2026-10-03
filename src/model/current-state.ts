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
  /** 出现在已发现血缘连接中的数据集占比；只是连接度指标，不代表业务事实或调查完成度。 */
  datasetLineageConnectionRate: number | null;
  columnLineageEdges: number;
  semanticAssets: number;
  profiledDatasets: number;
}

export interface SourceOfTruthCandidate {
  key: string;
  candidateDatasetIds: string[];
  candidateDatasets: string[];
  /** 仅表示“优先调查顺序”的 heuristic 分数，不是 source-of-truth 置信度。 */
  priorityScore: number;
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
