/**
 * Mission Clarity Review。
 *
 * Mission Gate 负责确定“用户有没有确认”，这里负责一个更窄的语义检查：
 * 用户填写的 purpose / expectedResult 是否已经具体到足以开始工作。
 *
 * 这不是安全 Gate，也不是最终任务判断。Smart Function 只提供语义判断信号；
 * 真正的“必须由用户确认”仍然由 Mission API + Mission Contract 状态决定。
 */
import { jevSmartFunc } from '../agent/jev-smart-func.js';

export interface MissionClarityReview {
  clear: boolean;
  purposeClarity: number;
  expectedResultClarity: number;
  alignment: number;
  reason: string;
}

export function buildMissionClarityPrompt(purpose: string, expectedResult: string): string {
  return [
    '判断下面这份 Mission 是否已经清楚到可以开始一次专业的数据架构调查。',
    '',
    '任务目的：',
    purpose.trim(),
    '',
    '期望结果：',
    expectedResult.trim(),
    '',
    '判断标准：',
    '1. 任务目的应该说明为什么做，而不是只说“分析一下/看看这个系统”。',
    '2. 期望结果应该说明最后需要什么结果或交付物，而不是只说“给我一些建议”。',
    '3. 两者应该一致，不能一个说做现状分析、另一个却要求完全不同的产出。',
    '4. 不要求写完整方案；用户可以使用自然语言，只要专业人员可以据此开始工作即可。',
  ].join('\n');
}

/** 把 Smart Function 的概率转成一个保守的 Mission clarity 结果。 */
export function normalizeMissionClarity(raw: Record<string, { type: string; noul?: number }>): MissionClarityReview {
  const purpose = raw.purpose_clarity?.noul ?? 0;
  const expected = raw.expected_result_clarity?.noul ?? 0;
  const alignment = raw.alignment?.noul ?? 0;
  const clear = purpose >= 0.72 && expected >= 0.72 && alignment >= 0.72;

  let reason = '任务目的和期望结果已经足够清楚，可以开始调查。';
  if (purpose < 0.72 && expected < 0.72) {
    reason = '任务目的和期望结果都比较笼统，需要再具体一点。';
  } else if (purpose < 0.72) {
    reason = '任务目的还不够具体，需要说明为什么要做这次调查。';
  } else if (expected < 0.72) {
    reason = '期望结果还不够具体，需要说明最后希望拿到什么。';
  } else if (alignment < 0.72) {
    reason = '任务目的和期望结果没有完全对上，需要确认这次调查最终到底要交付什么。';
  }

  return {
    clear,
    purposeClarity: purpose,
    expectedResultClarity: expected,
    alignment,
    reason,
  };
}

/**
 * 对一次用户提交的 Mission 做轻量语义检查。
 *
 * Smart Function 出错时返回 null：用户的明确确认仍然是有效事实，
 * 不能因为辅助判断服务暂时不可用而让整个工作台无法使用。
 */
export async function reviewMissionClarity(
  purpose: string,
  expectedResult: string,
  options: { model?: string; workingDirectory?: string; investigationName?: string } = {},
): Promise<MissionClarityReview | null> {
  try {
    const raw = await jevSmartFunc({
      prompt: buildMissionClarityPrompt(purpose, expectedResult),
      context: { purpose: purpose.trim(), expectedResult: expectedResult.trim() },
      questions: {
        purpose_clarity: {
          type: 'noul',
          instructions: '任务目的是否具体到可以让 Data Architect 理解为什么做这次调查？',
        },
        expected_result_clarity: {
          type: 'noul',
          instructions: '期望结果是否具体到可以让 Data Architect 知道最后需要交付什么？',
        },
        alignment: {
          type: 'noul',
          instructions: '任务目的和期望结果是否彼此一致，能组成一份明确的任务契约？',
        },
      },
      ...(options.model ? { model: options.model } : {}),
      modelCallName: 'Mission 清晰度检查',
      ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      ...(options.investigationName ? { investigationName: options.investigationName } : {}),
    });

    return normalizeMissionClarity(raw as Record<string, { type: string; noul?: number }>);
  } catch (error) {
    console.warn('[mission] Mission clarity review failed; returning unavailable instead of hiding the failure.', {
      investigationName: options.investigationName,
      modelCallName: 'Mission 清晰度检查',
      error,
    });
    return null;
  }
}
