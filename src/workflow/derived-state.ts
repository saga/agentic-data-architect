/**
 * Canonical Derived State evaluator.
 *
 * 所有 Mission / Workflow / Gate / Result 消费者都通过这里解释“事实是否足够形成某种结果”。
 * 这里只做纯函数计算，不做 I/O，不创建 Artifact，不推进 Workflow。
 */
export interface DerivedStateInput {
  goal: string;
  currentState: {
    coverage: {
      sqlFiles: number;
      sqlParsedStatements: number;
      sqlParseFailures: number;
      datasets: number;
      connectedDatasets: number;
      semanticAssets: number;
    };
  } | null;
  estateColumnCount: number;
  sourceOfTruthCandidateCount: number;
  lineageEdgeCount: number;
  findingsCount: number;
  scopeReady: boolean;
  highGapKinds: readonly string[];
  modernization?: {
    targetStatus: string;
    targetComponentCount: number;
    mappingStatuses: readonly string[];
    validationStatuses: readonly { status: string; blocking: boolean }[];
  } | null;
  assessment?: {
    exists: boolean;
    findingsCount: number;
    recommendationCount: number;
    roadmapCount: number;
  } | null;
}

export interface DerivedStateSignals {
  goalReady: boolean;
  scopeReady: boolean;
  currentStateAvailable: boolean;
  dataSourceReady: boolean;
  dataFlowReady: boolean;
  dataModelReady: boolean;
  transformationReady: boolean;
  currentStateReady: boolean;
  currentDataArchitectureReady: boolean;
  dataTruthReady: boolean;
  investigationReady: boolean;
  targetArchitectureReady: boolean;
  targetComponentCount: number;
  mappingReady: boolean;
  mappingCount: number;
  validationReady: boolean;
  validationCount: number;
  blockingValidationReady: number;
  blockingValidationTotal: number;
  findingsReady: boolean;
  assessmentCurrentStateReady: boolean;
  assessmentFindingsReady: boolean;
  assessmentRecommendationReady: boolean;
  assessmentRoadmapReady: boolean;
}

const hasAny = (values: readonly string[], targets: readonly string[]): boolean =>
  targets.some((target) => values.includes(target));

export function evaluateDerivedState(input: DerivedStateInput): DerivedStateSignals {
  const coverage = input.currentState?.coverage;
  const currentStateAvailable = Boolean(coverage && coverage.datasets > 0);

  // Source-of-Truth candidate 是待确认事实，不能直接当成 data-source 已完成。
  const dataSourceReady = currentStateAvailable && input.sourceOfTruthCandidateCount === 0;

  // Flow 是否成立只看有没有 lineage 边：connectedDatasets 本身就是从 lineage
  // 关系里数出来的，再拿它当备选条件等于自己证明自己，还会让“0 条边也算有 Flow”
  // 这种自相矛盾的输入通过门禁。
  const dataFlowReady = currentStateAvailable && input.lineageEdgeCount > 0;

  const dataModelReady = currentStateAvailable && input.estateColumnCount > 0;

  // 当前范围没有 SQL 时，不需要为了“转换”虚构一条 SQL 完成条件。
  const transformationReady = currentStateAvailable
    && (
      coverage!.sqlFiles === 0
      || (coverage!.sqlParsedStatements > 0 && coverage!.sqlParseFailures === 0)
    );

  const currentStateReady = currentStateAvailable
    && !hasAny(input.highGapKinds, ['discovery', 'lineage']);

  // “Current Data Architecture”允许保留业务上尚未确认的候选项；
  // 真正要求数据真相时，由 dataTruthReady 单独收紧。
  const currentDataArchitectureReady = currentStateReady
    && dataFlowReady
    && dataModelReady
    && transformationReady;

  const dataTruthReady = currentStateReady
    && dataSourceReady
    && transformationReady
    && coverage!.sqlParseFailures === 0
    && !hasAny(input.highGapKinds, ['source-of-truth', 'data_quality']);

  const modernization = input.modernization;
  const targetComponentCount = modernization?.targetComponentCount ?? 0;
  const mappingCount = modernization
    ? modernization.mappingStatuses.filter((status) => status === 'reviewed' || status === 'approved').length
    : 0;
  const validationCount = modernization?.validationStatuses.length ?? 0;
  const blockingValidationReady = modernization
    ? modernization.validationStatuses.filter((item) => item.blocking && item.status === 'passed').length
    : 0;
  const blockingValidationTotal = modernization
    ? modernization.validationStatuses.filter((item) => item.blocking).length
    : 0;
  const targetArchitectureReady = Boolean(
    modernization
      && modernization.targetStatus !== 'draft'
      && targetComponentCount > 0,
  );
  const mappingReady = Boolean(modernization && mappingCount > 0);
  const validationReady = Boolean(
    modernization
      && blockingValidationTotal > 0
      && blockingValidationReady >= blockingValidationTotal,
  );

  // Assessment 是一种“有效结果”，零个 Finding 也是合法结果；不能把它当成失败。
  const findingsReady = input.findingsCount > 0 || Boolean(input.assessment?.exists);

  const assessment = input.assessment;
  const assessmentFindingsReady = Boolean(assessment?.exists);
  const assessmentRecommendationReady = Boolean(
    assessment
      && (assessment.findingsCount === 0 || assessment.recommendationCount > 0),
  );
  const assessmentRoadmapReady = Boolean(
    assessmentRecommendationReady
      && (!assessment || assessment.recommendationCount === 0 || assessment.roadmapCount > 0),
  );

  return {
    goalReady: input.goal.trim().length > 0,
    scopeReady: input.scopeReady,
    currentStateAvailable,
    dataSourceReady,
    dataFlowReady,
    dataModelReady,
    transformationReady,
    currentStateReady,
    currentDataArchitectureReady,
    dataTruthReady,
    investigationReady: currentStateReady,
    targetArchitectureReady,
    targetComponentCount,
    mappingReady,
    mappingCount,
    validationReady,
    validationCount,
    blockingValidationReady,
    blockingValidationTotal,
    findingsReady,
    assessmentCurrentStateReady: currentDataArchitectureReady,
    assessmentFindingsReady,
    assessmentRecommendationReady,
    assessmentRoadmapReady,
  };
}
