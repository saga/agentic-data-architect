/**
 * Mission Completion Review。
 *
 * Stage Gate 只判断“这一阶段有没有形成真实、相关成果”；这里专门判断整个 Mission
 * 是否已经可以停止自动调查。两者故意分开，避免“阶段完成”误等于“用户目标完成”。
 *
 * Script 负责可验证的结构条件，Smart Function 负责“现有结果是否足够支撑用户期望结果”。
 * 最终 completed 由代码组合两类结果，不由 Agent 自己宣布。
 */
import type { MissionUnknownReview } from '../agent/jev-smart-func.js';
import { jevSmartFunc } from '../agent/jev-smart-func.js';
import type { MissionContract } from '../investigation/schemas.js';
import type { MissionProgress } from './mission-progress.js';

export interface MissionCompletionInput {
  mission: MissionContract;
  progress: MissionProgress;
  resultSummary: {
    evidenceCount: number;
    findingCount: number;
    claimCount: number;
    unknowns: string[];
  };
  unknownReviews?: MissionUnknownReview[];
  model?: string;
  workingDirectory?: string;
}

export interface MissionCompletionReview {
  completed: boolean;
  requiredDeliverablesResolved: boolean;
  resultSupported: boolean;
  blockedByUser: boolean;
  support: number;
  reason: string;
}

function renderContext(input: MissionCompletionInput): string {
  return JSON.stringify({
    progress: input.progress,
    resultSummary: input.resultSummary,
    unknownReviews: input.unknownReviews ?? [],
  }, null, 2);
}

/**
 * 构造最终 Completion 判断 Prompt。
 *
 * 注意这里问的是“用户真正要的结果够不够”，而不是“还有没有 unknown”。
 */
export function buildMissionCompletionPrompt(input: MissionCompletionInput): string {
  return [
    '判断整个 Mission 是否已经得到足够支持，可以停止自动调查。',
    '',
    'Mission：',
    '任务目的：' + input.mission.purpose.trim(),
    '期望结果：' + input.mission.expectedResult.trim(),
    '必须交付：',
    ...input.mission.deliverables.map((item) =>
      '- ' + item.id + '：' + item.title + '；' + item.description + (item.required ? '（必须）' : '（可选）')),
    '',
    '当前结果状态：',
    renderContext(input),
    '',
    '判断标准：',
    '1. result_supported=true：现有 Evidence / Finding / Claim 和调查结果已经足以支持用户真正需要的期望结果。',
    '2. result_supported=false：核心结果仍缺关键事实、关键验证或关键业务判断，继续调查会实质提升最终交付质量。',
    '3. 不要因为还有无关 unknown 就判定未完成。',
    '4. 不要因为交付物覆盖数字看起来完整，就忽略关键证据缺口。',
    '5. 如果一个影响 Mission 的 Unknown 已经明确需要用户补输入/做决定，它会阻止完成；Agent 能自己解决的 Unknown 不应阻止完成，只应该在有价值时继续调查。',
  ].join('\n');
}

/** 把 Smart Function 的最终支持概率转成有限结果。 */
export function normalizeMissionCompletion(
  raw: Record<string, { type: string; noul?: number }>,
): { resultSupported: boolean; support: number } {
  const support = raw.result_supported?.noul ?? 0;
  return {
    resultSupported: support >= 0.72,
    support,
  };
}

/**
 * 最终 Mission Completion Gate。
 *
 * requiredDeliverablesResolved 是 Script 条件：
 * - not_started / in_progress 明确表示还有可量化工作，不能完成；
 * - covered 已解决；
 * - not_tracked 无法自动量化，但交给 result_supported 的 Smart Review 判断最终结果是否已足够。
 */
export async function reviewMissionCompletion(
  input: MissionCompletionInput,
): Promise<MissionCompletionReview> {
  const requiredDeliverablesResolved = !input.progress.deliverables.some(
    (item) => item.required && (item.status === 'not_started' || item.status === 'in_progress'),
  );

  const blockedByUser = (input.unknownReviews ?? []).some(
    (item) => item.action === 'ask_user',
  );

  if (blockedByUser) {
    return {
      completed: false,
      requiredDeliverablesResolved,
      resultSupported: false,
      blockedByUser: true,
      support: 0,
      reason: '有影响 Mission 的未知项明确需要用户补充输入或做业务决定，当前不能宣告 Mission 完成。',
    };
  }

  try {
    const raw = await jevSmartFunc({
      prompt: buildMissionCompletionPrompt(input),
      context: {
        mission: input.mission,
        progress: input.progress,
        resultSummary: input.resultSummary,
        unknownReviews: input.unknownReviews ?? [],
      },
      questions: {
        result_supported: {
          type: 'noul',
          instructions: '现有调查结果是否已经足以支持用户最终需要拿到的期望结果？',
          criteria: {
            true: '关键结果已经有足够可靠证据支持；剩余 unknown 不影响最终交付。',
            false: '仍缺关键事实、关键验证或关键业务判断，继续调查会明显改善最终结果。',
          },
        },
      },
      ...(input.model ? { model: input.model } : {}),
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    });
    const { resultSupported, support } = normalizeMissionCompletion(raw);
    const completed = requiredDeliverablesResolved && resultSupported;
    return {
      completed,
      requiredDeliverablesResolved,
      resultSupported,
      blockedByUser: false,
      support,
      reason: completed
        ? 'Mission 的必需交付物已经解决，现有结果也足以支撑用户期望结果。'
        : requiredDeliverablesResolved
          ? '交付物结构上已经齐，但现有结果还不足以支撑期望结果，需要继续调查。'
          : '仍有必需交付物没有完成，不能停止调查。',
    };
  } catch {
    // Completion 属于业务停止判断，不把 Smart Function 故障伪装成“已完成”。
    return {
      completed: false,
      requiredDeliverablesResolved,
      resultSupported: false,
      blockedByUser: false,
      support: 0,
      reason: 'Mission Completion 的语义检查暂不可用，不能安全地宣告任务完成。',
    };
  }
}
