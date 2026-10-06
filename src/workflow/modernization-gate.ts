/**
 * Legacy Modernization 的确定性 Gate。
 *
 * Agent 只能提交结构化结果，不能自己宣布阶段完成。
 * Gate 只读取已经落盘的 modernization-plan.json 和 Investigation Evidence，
 * 服务器与命令行脚本共用这一套规则，避免规则漂移。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadInvestigation, reportsDir } from '../investigation/store.js';
import { loadModernizationPlan } from './modernization.js';
import { runInvestigationScopeGate } from './scope-gate.js';
import type { ModernizationPlan } from '../model/modernization.js';
import { reviewArtifact, saveArtifactReview, summarizeReviewFailure } from '../analysis/reviewer.js';
import { hashArtifact } from '../investigation/artifact-provenance.js';

export type ModernizationGateStage = 'target' | 'mapping' | 'validation';

export interface ModernizationGateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ModernizationGateResult {
  stage: ModernizationGateStage;
  passed: boolean;
  artifactPath: string;
  checks: ModernizationGateCheck[];
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function allEvidenceKnown(ids: string[], evidenceIds: Set<string>): boolean {
  return ids.length > 0 && ids.every((id) => evidenceIds.has(id));
}

/**
 * 纯函数 Gate，便于单元测试，也方便以后把相同规则移到其它运行入口。
 */
export function evaluateModernizationGate(
  plan: ModernizationPlan | null,
  evidenceIds: Set<string>,
  stage: ModernizationGateStage,
  artifactPath: string,
): ModernizationGateResult {
  const checks: ModernizationGateCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => {
    checks.push({ name, passed, detail });
  };

  add(
    '工作成果文件已存在',
    Boolean(artifactPath),
    artifactPath || '找不到 reports/modernization-plan.json。',
  );

  if (!plan) {
    add('Modernization Plan 可读取', false, '没有找到已经保存的 Modernization Plan。');
    return {
      stage,
      passed: checks.every((item) => item.passed),
      artifactPath,
      checks,
    };
  }

  add('Modernization Plan 可读取', true, 'version=' + String(plan.version));

  if (stage === 'target') {
    add(
      '目标架构已经不是空草案',
      plan.targetArchitecture.status !== 'draft'
        && plan.targetArchitecture.components.length > 0,
      'status=' + plan.targetArchitecture.status
        + ', components=' + String(plan.targetArchitecture.components.length),
    );
    add(
      '目标架构有真实 Evidence',
      allEvidenceKnown(plan.targetArchitecture.evidenceIds, evidenceIds),
      'evidence=' + String(plan.targetArchitecture.evidenceIds.length),
    );
  }

  if (stage === 'mapping') {
    const coverage = plan.mappingCoverage;
    add(
      '新旧对应有实际记录',
      plan.mappings.length > 0,
      'mappings=' + String(plan.mappings.length),
    );
    add(
      'Mapping 覆盖范围已经明确且没有未对应来源',
      Boolean(
        coverage
        && coverage.sourceAssets.length > 0
        && coverage.unmappedAssets.length === 0,
      ),
      coverage
        ? 'sources=' + String(coverage.sourceAssets.length)
          + ', unmapped=' + String(coverage.unmappedAssets.length)
        : '没有 Mapping coverage 记录。',
    );

    const incomplete = plan.mappings.filter((mapping) =>
      mapping.status === 'rejected'
      || !nonEmpty(mapping.transformation)
      || !nonEmpty(mapping.businessRule)
      || !nonEmpty(mapping.validationRule)
      || !allEvidenceKnown(mapping.evidenceIds, evidenceIds),
    );
    add(
      '每条 Mapping 都有转换、业务规则、验证规则和 Evidence',
      plan.mappings.length > 0 && incomplete.length === 0,
      incomplete.length > 0
        ? '不完整 Mapping=' + String(incomplete.length)
        : '完整 Mapping=' + String(plan.mappings.length),
    );
  }

  if (stage === 'validation') {
    const blocking = plan.validationPlan.checks.filter((item) => item.blocking);
    const incomplete = blocking.filter((item) =>
      item.status !== 'passed'
      || !nonEmpty(item.result)
      || !allEvidenceKnown(item.evidenceIds, evidenceIds),
    );
    add(
      '所有阻塞性验证都已经实际执行并通过',
      blocking.length > 0 && incomplete.length === 0,
      incomplete.length > 0
        ? '未通过、无结果或无 Evidence=' + String(incomplete.length)
        : 'blocking checks=' + String(blocking.length),
    );

    const reconciliation = plan.validationPlan.checks.find(
      (item) => item.type === 'reconciliation' && item.blocking,
    );
    add(
      '已有新旧结果对比（reconciliation）',
      Boolean(
        reconciliation
        && reconciliation.status === 'passed'
        && nonEmpty(reconciliation.result)
        && allEvidenceKnown(reconciliation.evidenceIds, evidenceIds),
      ),
      reconciliation
        ? 'status=' + reconciliation.status
          + ', evidence=' + String(reconciliation.evidenceIds.length)
        : '没有 reconciliation check。',
    );
    add(
      '切换条件已经留下记录',
      plan.validationPlan.cutoverCriteria.length > 0,
      'cutoverCriteria=' + String(plan.validationPlan.cutoverCriteria.length),
    );
  }

  return {
    stage,
    passed: checks.every((item) => item.passed),
    artifactPath,
    checks,
  };
}

export async function runModernizationGate(
  name: string,
  stage: ModernizationGateStage,
): Promise<ModernizationGateResult> {
  const scopeGate = await runInvestigationScopeGate(name);
  if (!scopeGate.passed) {
    return {
      stage,
      passed: false,
      checks: [{
        name: 'Investigation Scope',
        passed: false,
        detail: scopeGate.checks
          .filter((item) => !item.passed)
          .map((item) => item.name + '：' + item.detail)
          .join('；'),
      }],
      artifactPath: path.join(reportsDir(name), 'modernization-plan.json'),
    };
  }
  const plan = await loadModernizationPlan(name);
  const inv = await loadInvestigation(name);
  const artifactPath = path.join(reportsDir(name), 'modernization-plan.json');

  let exists = false;
  try {
    const stat = await fs.stat(artifactPath);
    exists = stat.isFile() && stat.size > 0;
  } catch {
    exists = false;
  }

  const result = evaluateModernizationGate(
    plan,
    new Set(inv.evidence.map((item) => item.id)),
    stage,
    exists ? artifactPath : '',
  );

  // 先通过确定性检查，再让独立 Reviewer 检查内容是否真的可读、可用。
  if (!result.passed || !plan) return result;

  const artifact = stage === 'target'
    ? JSON.stringify(plan.targetArchitecture, null, 2)
    : stage === 'mapping'
      ? JSON.stringify({
          mappingCoverage: plan.mappingCoverage,
          mappings: plan.mappings,
        }, null, 2)
      : JSON.stringify({ validationPlan: plan.validationPlan }, null, 2);

  const facts = JSON.stringify({
    currentState: plan.currentState,
    findings: inv.findings.slice(0, 20).map((finding) => ({
      title: finding.title,
      severity: finding.severity,
      affectedAssets: finding.affectedAssets,
    })),
  }, null, 2);

  try {
    const review = await reviewArtifact({
      investigationName: name,
      goal: inv.userPrompt || inv.goal || plan.goal,
      artifactType: stage === 'target'
        ? 'target_architecture'
        : stage === 'mapping'
          ? 'mapping'
          : 'validation',
      artifact,
      facts,
      ...(plan.provenance ? {
        artifactHash: hashArtifact(artifact),
        sourceRevision: plan.provenance.sourceRevision,
        artifactVersion: plan.version,
      } : {}),
    });
    await saveArtifactReview(name, review);

    const reviewPassed = review.availability === 'completed' && review.status === 'pass';
    return {
      ...result,
      passed: result.passed && reviewPassed,
      checks: [
        ...result.checks,
        {
          name: '独立质量审核',
          passed: reviewPassed,
          detail: reviewPassed
            ? '内容已经通过独立 Reviewer 检查，score=' + String(review.score) + '。'
            : summarizeReviewFailure(review),
        },
      ],
    };
  } catch (error) {
    return {
      ...result,
      passed: false,
      checks: [
        ...result.checks,
        {
          name: '独立质量审核',
          passed: false,
          detail: 'Reviewer 无法完成这次检查：' + (error instanceof Error ? error.message : String(error)),
        },
      ],
    };
  }
}
