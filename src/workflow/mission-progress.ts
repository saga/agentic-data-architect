/**
 * Mission Deliverable Coverage。
 *
 * 这里回答一个很实际的问题：
 *
 *   “用户想要的结果，现在已经覆盖到什么程度？”
 *
 * 它是导航信号，不是审批 Gate。覆盖率/状态只能帮助 Agent 和人选择下一步，
 * 不能代替 Evidence、权限或 Workflow 的确定性校验。
 */
import type { MissionContract, MissionDeliverable } from '../investigation/schemas.js';
import type { DiscoverySnapshot } from './discover.js';
import { loadArchitectureAssessmentPlan } from './assessment.js';
import { loadInvestigation } from '../investigation/store.js';
import { loadModernizationPlan } from './modernization.js';

export type MissionDeliverableStatus =
  | 'covered'
  | 'in_progress'
  | 'not_started'
  | 'not_tracked';

export interface MissionDeliverableProgress {
  id: string;
  title: string;
  description: string;
  required: boolean;
  status: MissionDeliverableStatus;
  detail: string;
}

export interface MissionProgress {
  covered: number;
  total: number;
  percent: number;
  deliverables: MissionDeliverableProgress[];
}

/** 只根据 Mission 交付物状态判断是否还有必要自动继续，不看 Agent 自己的“完成”声明。 */
export function missionHasOpenDeliverables(progress: MissionProgress): boolean {
  // not_tracked 表示平台无法自动量化这个结果，不能拿它作为继续跑 Agent 的理由。
  // 自动续跑只追踪明确的未开始 / 进行中交付物；自定义结果在一次 Agent 执行里自行判断，
  // 避免因为一个无法量化的结果把 Investigation 无意义地延长到最大轮次。
  return progress.deliverables.some(
    (item) => item.required && (item.status === 'not_started' || item.status === 'in_progress'),
  );
}

interface ProgressSignals {
  currentState: DiscoverySnapshot['currentState'] | null;
  estateNodeCount: number;
  estateColumnCount: number;
  findingsCount: number;
  sourceOfTruthCount: number;
  lineageEdgeCount: number;
  modernization?: {
    targetComponentCount: number;
    mappingCount: number;
    validationCount: number;
    blockingValidationReady: number;
    blockingValidationTotal: number;
  } | null;
  assessment?: {
    findingsCount: number;
    recommendationCount: number;
    roadmapCount: number;
  } | null;
}

function covered(
  item: MissionDeliverable,
  status: MissionDeliverableStatus,
  detail: string,
): MissionDeliverableProgress {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    required: item.required,
    status,
    detail,
  };
}

/** 根据已经落盘的结构化状态推算交付物覆盖；不阅读 Agent 自己的“完成声明”。 */
function evaluateDeliverable(
  item: MissionDeliverable,
  signals: ProgressSignals,
): MissionDeliverableProgress {
  const current = signals.currentState;
  const datasets = current?.coverage.datasets ?? 0;
  const connectedDatasets = current?.coverage.connectedDatasets ?? 0;
  const parsedSql = current?.coverage.sqlParsedStatements ?? 0;

  switch (item.id) {
    case 'current-state-architecture': {
      const sourceReady = datasets > 0;
      const flowReady = connectedDatasets > 0;
      const modelReady = signals.estateColumnCount > 0 || (current?.coverage.semanticAssets ?? 0) > 0;
      const coveredCount = Number(sourceReady) + Number(flowReady) + Number(modelReady) + Number(parsedSql > 0);
      return covered(
        item,
        coveredCount >= 3 ? 'covered' : coveredCount > 0 ? 'in_progress' : 'not_started',
        '当前架构覆盖 Source=' + (sourceReady ? '是' : '否')
          + '、Flow=' + (flowReady ? '是' : '否')
          + '、Model=' + (modelReady ? '是' : '否')
          + '、Transformation=' + (parsedSql > 0 ? '是' : '否') + '。',
      );
    }

    case 'data-source': {
      const hasAssets = datasets > 0;
      const sourceCandidate = signals.sourceOfTruthCount > 0;
      return covered(
        item,
        sourceCandidate ? 'covered' : hasAssets ? 'in_progress' : 'not_started',
        sourceCandidate
          ? '已经形成数据来源候选，可以继续核对可信来源。'
          : hasAssets
            ? '已经发现数据集，但还没有形成明确的数据来源候选。'
            : '还没有发现可用于当前任务的数据来源。',
      );
    }

    case 'data-flow': {
      const flowReady = signals.lineageEdgeCount > 0 || connectedDatasets >= 2;
      return covered(
        item,
        flowReady ? 'covered' : datasets > 0 ? 'in_progress' : 'not_started',
        flowReady
          ? '已经形成可追踪的数据流关系。'
          : datasets > 0
            ? '已经发现数据集，但数据流关系还没有形成。'
            : '还没有足够的资产来判断数据流。',
      );
    }

    case 'data-model': {
      const modelReady = datasets > 0 && signals.estateColumnCount > 0;
      return covered(
        item,
        modelReady ? 'covered' : datasets > 0 ? 'in_progress' : 'not_started',
        modelReady
          ? '已经发现数据集和列级结构，可以整理核心实体与关系。'
          : datasets > 0
            ? '已经发现数据集，但列级模型还需要继续整理。'
            : '还没有发现数据模型资产。',
      );
    }

    case 'transformation':
      return covered(
        item,
        parsedSql > 0 ? 'covered' : datasets > 0 ? 'in_progress' : 'not_started',
        parsedSql > 0
          ? '已经解析到 ' + String(parsedSql) + ' 条 SQL statement。'
          : '还没有解析到可用于判断转换逻辑的 SQL。',
      );

    case 'findings':
      return covered(
        item,
        signals.findingsCount > 0 ? 'covered' : 'not_started',
        signals.findingsCount > 0
          ? '已经形成 ' + String(signals.findingsCount) + ' 个 Finding。'
          : '还没有形成结构化 Finding。',
      );

    case 'target-architecture': {
      const count = signals.modernization?.targetComponentCount ?? 0;
      return covered(
        item,
        count > 0 ? 'covered' : signals.currentState ? 'in_progress' : 'not_started',
        count > 0 ? '已经形成 ' + String(count) + ' 个目标架构组件。' : '目标架构还没有形成实际组件。',
      );
    }

    case 'mapping': {
      const count = signals.modernization?.mappingCount ?? 0;
      return covered(
        item,
        count > 0 ? 'covered' : 'not_started',
        count > 0 ? '已经形成 ' + String(count) + ' 条新旧对应关系。' : '还没有形成新旧对应关系。',
      );
    }

    case 'validation': {
      const total = signals.modernization?.blockingValidationTotal ?? 0;
      const ready = signals.modernization?.blockingValidationReady ?? 0;
      const count = signals.modernization?.validationCount ?? 0;
      return covered(
        item,
        total > 0 && ready >= total ? 'covered' : count > 0 || total > 0 ? 'in_progress' : 'not_started',
        total > 0
          ? '已有 ' + String(ready) + '/' + String(total) + ' 个阻断性检查通过。'
          : count > 0
            ? '已经形成验证检查，但还没有足够的通过结果。'
            : '还没有形成验证检查。',
      );
    }

    case 'recommendations': {
      const count = signals.assessment?.recommendationCount ?? 0;
      return covered(
        item,
        count > 0 ? 'covered' : 'not_started',
        count > 0 ? '已经形成 ' + String(count) + ' 条建议。' : '还没有形成结构化改进建议。',
      );
    }

    case 'roadmap': {
      const count = signals.assessment?.roadmapCount ?? 0;
      return covered(
        item,
        count > 0 ? 'covered' : 'not_started',
        count > 0 ? '已经形成 ' + String(count) + ' 个实施阶段。' : '还没有形成实施顺序。',
      );
    }

    case 'custom-result':
      return covered(
        item,
        'not_tracked',
        '这个结果没有通用的确定性覆盖指标；不会为了追一个数字而自动延长调查。',
      );

    default:
      return covered(item, 'not_tracked', '这个交付物没有配置自动覆盖指标。');
  }
}

/** 生成某个 Investigation 当前的 Mission 覆盖情况。 */
export async function buildMissionProgress(
  name: string,
  mission: MissionContract | undefined,
): Promise<MissionProgress | null> {
  if (!mission) return null;

  const investigation = await loadInvestigation(name);
  const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(name);
  const estate = snapshot?.estate;

  const signals: ProgressSignals = {
    currentState: snapshot?.currentState ?? null,
    estateNodeCount: estate?.nodes.length ?? 0,
    estateColumnCount: estate?.nodes.filter((node) => node.type === 'column').length ?? 0,
    findingsCount: investigation.findings.length,
    sourceOfTruthCount: snapshot?.currentState?.sourceOfTruthCandidates.length ?? 0,
    lineageEdgeCount: snapshot?.lineage?.edges.length ?? estate?.edges.length ?? 0,
  };

  if (investigation.workflow === 'legacy-modernization') {
    const plan = await loadModernizationPlan(name);
    if (plan) {
      signals.modernization = {
        targetComponentCount: plan.targetArchitecture.components.length,
        mappingCount: plan.mappings.length,
        validationCount: plan.validationPlan.checks.length,
        blockingValidationReady: plan.validationPlan.checks.filter((item) => item.blocking && item.status === 'passed').length,
        blockingValidationTotal: plan.validationPlan.checks.filter((item) => item.blocking).length,
      };
    }
  }

  if (investigation.workflow === 'data-architecture-assessment') {
    const plan = await loadArchitectureAssessmentPlan(name);
    if (plan) {
      signals.assessment = {
        findingsCount: plan.findings.length,
        recommendationCount: plan.recommendations.length,
        roadmapCount: plan.roadmap.length,
      };
    }
  }

  const deliverables = mission.deliverables.map((item) => evaluateDeliverable(item, signals));
  const coveredCount = deliverables.filter((item) => item.status === 'covered').length;

  return {
    covered: coveredCount,
    total: deliverables.length,
    percent: deliverables.length ? Math.round(coveredCount / deliverables.length * 100) : 0,
    deliverables,
  };
}
