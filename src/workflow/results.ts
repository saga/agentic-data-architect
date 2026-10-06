/**
 * “调查结果” View Model 组装器。
 *
 * 这里是 server → web 的唯一聚合边界：
 * - trajectory / work product / report 各自读取；
 * - 单个成果失败只影响自己的 section；
 * - workflow 决定哪些成果适用，避免显示其它 workflow 的陈旧文件。
 */
import {
  ResultViewModelSchema,
  type ResultViewModel,
  type ResultSection,
} from '../api/results.js';
import { loadInvestigation } from '../investigation/store.js';
import { loadWorkspaceContext } from '../investigation/workspace.js';
import { listTrajectoryCheckpoints, readTrajectory } from '../investigation/trajectory.js';
import { loadInvestigationControl } from '../investigation/control.js';
import { runReport } from './report.js';
import { loadModernizationPlan } from './modernization.js';
import { loadArchitectureAssessmentPlan } from './assessment.js';
import { ScopeGateError } from './scope-gate.js';
import { MissionGateError } from './mission-gate.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureSection(error: unknown): ResultSection<never> {
  const message = errorMessage(error);
  if (error instanceof ScopeGateError || error instanceof MissionGateError) {
    return { status: 'blocked', message };
  }
  return { status: 'error', message };
}

function emptySection(message: string): ResultSection<never> {
  return { status: 'empty', message };
}

function notApplicableSection(): ResultSection<never> {
  return { status: 'not_applicable' };
}

export async function buildResultViewModel(name: string): Promise<ResultViewModel> {
  // 这三个是结果页面本身必须存在的基础状态；它们失败才让整个 API 失败。
  const [context, control, investigation, trajectory] = await Promise.all([
    loadWorkspaceContext(name),
    loadInvestigationControl(name),
    loadInvestigation(name),
    readTrajectory(name, { limit: 5000 }),
  ]);

  const checkpoints = listTrajectoryCheckpoints(trajectory, 100);

  const modernizationPromise = context.workflow === 'legacy-modernization'
    ? loadModernizationPlan(name)
    : Promise.resolve(null);

  const assessmentPromise = context.workflow === 'data-architecture-assessment'
    ? loadArchitectureAssessmentPlan(name)
    : Promise.resolve(null);

  // 三类正式结果独立读取/生成。一个失败不能让其它结果一起消失。
  const [reportResult, modernizationResult, assessmentResult] = await Promise.allSettled([
    runReport(name),
    modernizationPromise,
    assessmentPromise,
  ]);

  let report: ResultViewModel['report'];
  if (reportResult.status === 'fulfilled') {
    report = {
      status: 'available',
      data: {
        markdown: reportResult.value.markdown,
        review: {
          status: reportResult.value.review.status,
          availability: reportResult.value.review.availability,
          score: reportResult.value.review.score,
          summary: reportResult.value.review.summary,
          issueCount: reportResult.value.review.issues.length,
        },
      },
    };
  } else {
    report = failureSection(reportResult.reason);
  }

  let modernization: ResultViewModel['modernization'];
  if (context.workflow !== 'legacy-modernization') {
    modernization = notApplicableSection();
  } else if (modernizationResult.status === 'rejected') {
    modernization = failureSection(modernizationResult.reason);
  } else if (!modernizationResult.value) {
    modernization = emptySection('还没有形成改造工作成果。');
  } else {
    const plan = modernizationResult.value;
    modernization = {
      status: 'available',
      data: {
        version: plan.version,
        status: plan.status,
        targetArchitecture: {
          title: plan.targetArchitecture.title,
          status: plan.targetArchitecture.status,
          principles: plan.targetArchitecture.principles,
          components: plan.targetArchitecture.components.map((component) => ({
            id: component.id,
            name: component.name,
            description: component.description,
            sourceAssets: component.sourceAssets,
          })),
          openQuestions: plan.targetArchitecture.openQuestions,
          evidenceIds: plan.targetArchitecture.evidenceIds,
        },
        mappings: plan.mappings.map((mapping) => ({
          id: mapping.id,
          title: mapping.title,
          status: mapping.status,
          sourceAsset: mapping.sourceAsset,
          targetAsset: mapping.targetAsset,
          ...(mapping.transformation !== undefined ? { transformation: mapping.transformation } : {}),
          ...(mapping.businessRule !== undefined ? { businessRule: mapping.businessRule } : {}),
          ...(mapping.validationRule !== undefined ? { validationRule: mapping.validationRule } : {}),
          evidenceIds: mapping.evidenceIds,
        })),
        ...(plan.mappingCoverage ? {
          mappingCoverage: {
            sourceAssets: plan.mappingCoverage.sourceAssets,
            unmappedAssets: plan.mappingCoverage.unmappedAssets,
          },
        } : {}),
        validationPlan: {
          checks: plan.validationPlan.checks.map((check) => ({
            id: check.id,
            name: check.name,
            status: check.status,
            blocking: check.blocking,
            evidenceIds: check.evidenceIds,
            ...(check.result !== undefined ? { result: check.result } : {}),
          })),
          cutoverCriteria: plan.validationPlan.cutoverCriteria,
          rollbackCriteria: plan.validationPlan.rollbackCriteria,
        },
      },
    };
  }

  let assessment: ResultViewModel['assessment'];
  if (context.workflow !== 'data-architecture-assessment') {
    assessment = notApplicableSection();
  } else if (assessmentResult.status === 'rejected') {
    assessment = failureSection(assessmentResult.reason);
  } else if (!assessmentResult.value) {
    assessment = emptySection('还没有形成架构评估成果。');
  } else {
    const plan = assessmentResult.value;
    assessment = {
      status: 'available',
      data: {
        id: plan.id,
        title: plan.title,
        status: plan.status,
        version: plan.version,
        updatedAt: plan.updatedAt,
        goal: plan.goal,
        scope: plan.scope,
        currentState: plan.currentState,
        findings: plan.findings,
        recommendations: plan.recommendations,
        roadmap: plan.roadmap,
        evidenceIds: plan.evidenceIds,
      },
    };
  }

  // investigation 目前用于保证 session 确实可读取，并让这个聚合边界与核心 Investigation 对齐。
  void investigation;

  return ResultViewModelSchema.parse({
    schemaVersion: 1,
    session: {
      name,
      workflow: context.workflow,
      controlVersion: control.version,
      agentDisplayName: control.agent.displayName,
    },
    checkpoints,
    modernization,
    assessment,
    report,
  });
}
