/**
 * Modernization Gap Analysis。
 *
 * 这里坚持 deterministic：只根据已发现的覆盖率、Lineage、Semantic Context 和 Finding
 * 生成“需要进一步处理的问题”，不让 LLM 凭空编造 legacy 系统事实。
 */
import type { Finding } from '../evidence/types.js';
import type { CurrentStateIntelligence } from '../model/current-state.js';
import type { DataEstate } from '../model/estate.js';
import type { ModernizationGap } from '../model/modernization.js';

let gapCounter = 0;

/** 生成稳定可读的 gap id；单次进程内即可满足工作产物要求。 */
function nextGapId(prefix: string): string {
  gapCounter += 1;
  return `gap-${prefix}-${gapCounter}`;
}

/** 从 Current-State 和 Findings 中生成 modernization 前置问题。 */
export function buildModernizationGaps(args: {
  currentState: CurrentStateIntelligence | null | undefined;
  estate: DataEstate | null | undefined;
  findings: Finding[];
}): ModernizationGap[] {
  const { currentState, estate, findings } = args;
  const gaps: ModernizationGap[] = [];

  if (!currentState) {
    gaps.push({
      id: nextGapId('discovery'),
      kind: 'discovery',
      title: '还没查清现有系统',
      description: '现在还没有足够的资料说明这个系统有哪些数据、怎么流转，以及关键业务定义是什么。',
      severity: 'high',
      affectedAssets: estate?.nodes.map((n) => n.id).slice(0, 20) ?? [],
      evidenceIds: [],
      recommendation: '先查现有系统：数据集、主要数据流、SQL/ETL 转换、数据来源和已有业务定义。',
    });
    return gaps;
  }

  if (currentState.coverage.sqlParseFailures > 0) {
    gaps.push({
      id: nextGapId('sql'),
      kind: 'discovery',
      title: '存在无法解析的 SQL',
      description: `有 ${currentState.coverage.sqlParseFailures} 个 SQL statement 没有进入 lineage 分析，Target 设计前需要知道这些黑洞。`,
      severity: 'high',
      affectedAssets: [],
      evidenceIds: [],
      recommendation: '优先定位 parse failure，对复杂语法增加 parser 支持或人工补充 Evidence。',
    });
  }

  const connectionRate = currentState.coverage.datasetLineageConnectionRate;
  if (connectionRate !== null && connectionRate < 1) {
    gaps.push({
      id: nextGapId('lineage'),
      kind: 'lineage',
      title: '仍有数据集没有进入已发现血缘',
      description: `当前有 ${currentState.coverage.datasets - currentState.coverage.connectedDatasets} 个数据集没有出现在已发现的 lineage 连接中；连接率为 ${(connectionRate * 100).toFixed(1)}%。`,
      severity: 'high',
      affectedAssets: [],
      evidenceIds: [],
      recommendation: '先确认这些数据集是否真的孤立、是否来自外部系统，或补齐关键上下游关系。',
    });
  }

  if (currentState.coverage.semanticAssets === 0) {
    gaps.push({
      id: nextGapId('semantic'),
      kind: 'semantic',
      title: '缺少可验证的业务语义来源',
      description: '当前没有发现 Semantic View、Data Product、Catalog Term、Metric 等语义资产。',
      severity: 'medium',
      affectedAssets: [],
      evidenceIds: [],
      recommendation: '接入现有语义来源；Snowflake Semantic View、Data Product、Catalog、BI 定义均可作为 provider。',
    });
  }

  if (currentState.sourceOfTruthCandidates.length > 0) {
    gaps.push({
      id: nextGapId('sot'),
      kind: 'source-of-truth',
      title: 'Source-of-Truth 仍是候选，不是确认事实',
      description: `发现 ${currentState.sourceOfTruthCandidates.length} 组 source-of-truth candidates；这些候选需要业务/数据负责人确认。`,
      severity: 'high',
      affectedAssets: currentState.sourceOfTruthCandidates.flatMap((c) => c.candidateDatasetIds).slice(0, 30),
      evidenceIds: currentState.sourceOfTruthCandidates.flatMap((c) => c.evidenceIds).slice(0, 30),
      recommendation: '建立 Analyst / SME review，把确认后的结果转成 approved business context 或 architecture decision。',
    });
  }

  for (const finding of findings.filter((f) => f.severity === 'high' || f.severity === 'medium')) {
    gaps.push({
      id: nextGapId('finding'),
      kind: finding.type === 'data_quality_issue' ? 'data_quality' : 'architecture',
      title: finding.title,
      description: finding.description,
      severity: finding.severity,
      affectedAssets: finding.affectedAssets,
      evidenceIds: finding.evidenceIds,
      recommendation: '在 target design 和 migration mapping 中显式处理该 finding，并定义验证规则。',
    });
  }

  return gaps;
}
