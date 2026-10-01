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

  const coverage = currentState.coverage.datasetLineageCoverage;
  if (coverage !== null && coverage < 0.8) {
    gaps.push({
      id: nextGapId('lineage'),
      kind: 'lineage',
      title: 'Dataset lineage 覆盖不足',
      description: `当前 lineage coverage 为 ${(coverage * 100).toFixed(1)}%，不足以直接支撑完整迁移影响分析。`,
      severity: 'high',
      affectedAssets: [],
      evidenceIds: [],
      recommendation: '优先补齐关键数据集上下游关系，再确定迁移边界和切换顺序。',
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
      kind: 'architecture',
      title: 'Source-of-Truth 仍是候选，不是确认事实',
      description: `发现 ${currentState.sourceOfTruthCandidates.length} 组 source-of-truth candidates，至少部分需要业务确认。`,
      severity: 'medium',
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
