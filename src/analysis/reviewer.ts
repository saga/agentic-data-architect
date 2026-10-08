/**
 * 独立工作成果 Reviewer。
 *
 * Reviewer 不参与调查、不修改结果，也不共享主 Agent 的 Session。
 * 它只判断已经生成的用户可见报告或 Modernization 工作成果：
 * 是否回答了原始目标、是否容易读懂、是否自洽、是否有实际结论。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { askAgentWithFallback } from '../agent/runtime.js';
import type { AskInput } from '../agent/ask-input.js';
import { config } from '../config.js';
import { reportsDir } from '../investigation/store.js';
import type { AgentRuntime, MissionContract } from '../investigation/schemas.js';
import { workspaceRoot, writeJsonAtomic } from '../investigation/workspace.js';
import {
  ArtifactReviewContractSchema as ArtifactReviewSchema,
  ReviewArtifactTypeSchema,
  ReviewIssueSchema,
  type ArtifactReviewContract as ArtifactReview,
  type ReviewArtifactType,
} from '../api/contracts.js';

export {
  ArtifactReviewSchema,
  ReviewArtifactTypeSchema,
  ReviewIssueSchema,
};
export type { ArtifactReview, ReviewArtifactType };

const REVIEWER_SYSTEM_PROMPT = [
  '你是一个独立的 Data Architect 工作成果 Reviewer。',
  '你的职责只有一个：判断别人刚生成的工作成果是否已经达到可以交给架构师/分析师阅读和继续决策的质量。',
  '你不是原来的调查 Agent，不要继续调查，不要调用工具，不要补充新的事实，不要替作者重写成果。',
  '必须以原始用户目标作为第一判断标准。',
  '只评价输入中已经提供的内容；不要因为你自己知道某个系统而添加外部事实。',
  '重点检查：是否真的回答了目标、是否说人话、是否把内部实现结构泄漏给用户、是否有明确结论、是否存在前后矛盾、是否把指标堆砌成结论。',
  '对于架构工作成果，还要检查内容是否足够支持下一步决策，但不能把“应该采用某技术”当成事实要求。',
  'Evidence 的真假和 Evidence ID 的有效性由确定性 Gate 检查；你只检查报告有没有正确使用这些信息和是否出现明显越界。',
  '只有没有 high severity 问题，并且整体已经达到可直接阅读和使用的水平时才能 pass。',
  '输出必须是严格 JSON，不要输出 Markdown 或代码围栏。',
].join('\n');

/** 普通文本兜底解析；正常路径优先使用 Copilot SDK 的 responseSchema。 */
function extractJson(raw: string): unknown | undefined {
  const fenced = raw.match(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/);
  const text = fenced?.[1]?.trim() ?? raw.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function artifactLabel(type: ReviewArtifactType): string {
  switch (type) {
    case 'report': return 'Current-State Report';
    case 'target_architecture': return 'Target Architecture';
    case 'mapping': return 'Source-to-Target Mapping';
    case 'validation': return 'Validation Plan / Validation Result';
  }
}

function trimArtifact(value: string, maxChars = 36000): string {
  return value.length <= maxChars
    ? value
    : value.slice(0, maxChars) + '\n\n[内容过长，后半部分未提供给 Reviewer]';
}

function buildReviewPrompt(input: {
  mission: MissionContract;
  artifactType: ReviewArtifactType;
  artifact: string;
  facts?: string;
  artifactHash?: string;
  sourceRevision?: string;
  artifactVersion?: number;
}): string {
  return [
    '原始 Mission：',
    '任务目的：' + input.mission.purpose.trim(),
    '期望结果：' + input.mission.expectedResult.trim(),
    '必须交付：',
    ...input.mission.deliverables.filter((item) => item.required).map((item) =>
      '- ' + item.title + '：' + item.description),
    '',
    '待审核成果类型：',
    artifactLabel(input.artifactType),
    '',
    ...(input.facts?.trim()
      ? ['确定性事实摘要（只用于检查成果是否自洽，不要求 Reviewer 重新计算）：', trimArtifact(input.facts, 12000), '']
      : []),
    '待审核成果：',
    trimArtifact(input.artifact),
    '',
    '请只返回以下 JSON：',
    JSON.stringify({
      artifactType: input.artifactType,
      status: 'pass',
      score: 85,
      summary: '一句话说明整体质量。',
      issues: [{
        category: 'readability',
        severity: 'low',
        description: '具体问题。',
        suggestion: '具体怎么改。',
      }],
      reviewedAt: new Date().toISOString(),
    }),
    '',
    '判定要求：',
    '- status=fail：存在至少一个 high 问题，或者成果整体明显不能支持用户理解/决策。',
    '- status=pass：没有 high 问题，medium 问题不会实质影响理解和决策。',
    '- score 只是整体质量分，不替代上述 pass/fail 规则。',
    '- 问题必须具体到这份成果，不要写“可以更好”“建议进一步完善”之类空话。',
  ].join('\n');
}

async function runReviewerOnce(
  input: {
    investigationName: string;
    mission: MissionContract;
    runtime: AgentRuntime;
    model: string;
    artifactType: ReviewArtifactType;
    artifact: string;
    facts?: string;
    artifactHash?: string;
    sourceRevision?: string;
    artifactVersion?: number;
    onTrajectory?: AskInput['onTrajectory'];
  },
  structured: boolean,
): Promise<ArtifactReview> {
  const prompt = structured
    ? buildReviewPrompt(input)
    : buildReviewPrompt(input)
      + '\\n\\n再次提醒：只返回 JSON 对象，不要 Markdown、不要解释、不要前后加任何文字。';

  const raw = await askAgentWithFallback({
    prompt,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    purpose: 'review',
    runtime: input.runtime,
    model: input.model || config.model,
    workingDirectory: workspaceRoot(input.investigationName),
    modelCallName: structured ? '检查最终报告质量' : '再次检查最终报告质量',
    ...(input.onTrajectory ? { onTrajectory: input.onTrajectory } : {}),
    autoContinuationTurns: 0,
    ...(structured ? { responseSchema: ArtifactReviewSchema } : {}),
  });

  const candidate = extractJson(raw);
  if (candidate === undefined) {
    throw new Error('Reviewer 没有返回可解析的审核结果。');
  }

  const parsed = ArtifactReviewSchema.parse(candidate);
  if (parsed.artifactType !== input.artifactType) {
    throw new Error('Reviewer 返回的成果类型与当前审核对象不一致。');
  }

  const hasHigh = parsed.issues.some((issue) => issue.severity === 'high');
  // Score is a quality signal only; the prompt defines pass/fail by status and severity.
  // Do not turn an arbitrary model score into another hard gate.
  const normalizedStatus = !hasHigh && parsed.status === 'pass' ? 'pass' : 'fail';
  return {
    ...parsed,
    ...(input.artifactHash ? { artifactHash: input.artifactHash } : {}),
    ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
    ...(input.artifactVersion ? { artifactVersion: input.artifactVersion } : {}),
    availability: 'completed',
    status: normalizedStatus,
    reviewedAt: new Date().toISOString(),
  };
}

export async function reviewArtifact(input: {
  investigationName: string;
  mission: MissionContract;
  runtime: AgentRuntime;
  model: string;
  artifactType: ReviewArtifactType;
  artifact: string;
  facts?: string;
  artifactHash?: string;
  sourceRevision?: string;
  artifactVersion?: number;
  onTrajectory?: AskInput['onTrajectory'];
}): Promise<ArtifactReview> {
  try {
    return await runReviewerOnce(input, true);
  } catch (structuredError) {
    try {
      return await runReviewerOnce(input, false);
    } catch {
      return {
        artifactType: input.artifactType,
        status: 'fail',
        availability: 'unavailable',
        score: 0,
        summary: '独立质量检查暂时没有返回可验证的结果。',
        issues: [{
          category: 'consistency',
          severity: 'high',
          description: '独立质量检查没有返回可验证的结构化结果。',
          suggestion: '稍后重新生成并审核结果；原始调查内容没有因此被修改。',
        }],
        reviewedAt: new Date().toISOString(),
        ...(input.artifactHash ? { artifactHash: input.artifactHash } : {}),
        ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
        ...(input.artifactVersion ? { artifactVersion: input.artifactVersion } : {}),
      };
    }
  }
}

export async function saveArtifactReview(
  investigationName: string,
  review: ArtifactReview,
): Promise<string> {
  const fileName = review.artifactType === 'report'
    ? 'report-review.json'
    : `${review.artifactType.replaceAll('_', '-')}-review.json`;
  const filePath = path.join(reportsDir(investigationName), fileName);
  await fs.mkdir(reportsDir(investigationName), { recursive: true });
  await writeJsonAtomic(filePath, review);
  return filePath;
}

export function summarizeReviewFailure(review: ArtifactReview, maxIssues = 4): string {
  const issues = review.issues
    .filter((issue) => issue.severity !== 'low')
    .slice(0, maxIssues)
    .map((issue) => issue.description)
    .join('；');
  return issues || review.summary;
}
