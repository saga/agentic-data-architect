/**
 * Jev-like Smart Function：把“判断”从普通 Agent 对话里拆出来。
 *
 * 设计目标：
 * - 输入是 prompt + context + 一组有界问题；
 * - 一次模型调用可以同时回答多个 choice / score / noul；
 * - 输出是机器可以直接消费的结构化结果，而不是自然语言；
 * - 当前底层使用 Copilot SDK structured output，未来可以无痛替换成真正的 Jev / 其它 Decision Model。
 *
 * 重要边界：
 * - Smart Function 负责“判断”，不负责 Workflow / 权限 / 数据安全边界；
 * - 它不能替代确定性 Script Gate。凡是必须确定通过/拒绝的规则，仍然由代码判断；
 * - choice / score 的概率是模型提供的判断信号，应用必须自己定义最终 threshold 和 fallback。
 */
import * as z from 'zod';
import { askAgentWithFallback } from './runtime.js';
import type { AskInput } from './copilot.js';
import { config } from '../config.js';

/** 有界分类问题：从明确的候选项里选一个。 */
export interface JevChoiceQuestion {
  type: 'choice';
  /** 如何判断；写成直接、可执行的判断标准。 */
  instructions: string;
  /** option key -> 该选项的含义；可以包含“other / unknown”。 */
  options: Record<string, string>;
}

/** 有序评分问题：从低到高定义评分等级。 */
export interface JevScoreQuestion {
  type: 'score';
  /** 如何判断。 */
  instructions: string;
  /** 从低到高排列的评分等级，至少 2 个。 */
  levels: Array<{
    name: string;
    description: string;
  }>;
}

/** Yes / No 判断；返回 true 的概率。 */
export interface JevNoulQuestion {
  type: 'noul';
  /** 要判断的命题。 */
  instructions: string;
  /** 可选的 true / false 判定口径。 */
  criteria?: {
    true: string;
    false: string;
  };
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

interface ScoreAnswer {
  type: 'score';
  score: number;
  probabilities: Array<{
    level: string;
    probability: number;
  }>;
  confidence: number;
}

interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export type JevSmartAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/** Mission Alignment 的语义判断结果；只提供判断信号，不替代确定性 Gate。 */
export interface MissionAlignmentReview {
  aligned: boolean;
  alignment: number;
  worthContinuing: boolean;
  continuationValue: number;
  reason: string;
}

export interface MissionAlignmentInput {
  mission: {
    purpose: string;
    expectedResult: string;
    deliverables: Array<{ id: string; title: string; description: string; required: boolean }>;
  };
  candidate: string;
  context?: string | string[] | Record<string, unknown>;
  model?: string;
  workingDirectory?: string;
  onTrajectory?: AskInput['onTrajectory'];

}

/** Mission 行动前检查结果；只回答“这个动作该不该现在做”。 */
export interface MissionActionReview {
  allowed: boolean;
  aligned: boolean;
  necessary: boolean;
  alignment: number;
  necessity: number;
  targetDeliverableId: string | null;
  reason: string;
}

export interface MissionActionInput {
  mission: {
    purpose: string;
    expectedResult: string;
    deliverables: Array<{ id: string; title: string; description: string; required: boolean }>;
  };
  candidate: {
    toolName: string;
    toolArgs?: unknown;
  };
  context?: string | string[] | Record<string, unknown>;
  model?: string;
  workingDirectory?: string;
  onTrajectory?: AskInput['onTrajectory'];

}

/** Unknown 不再只是文字；结构化判断明确它是否影响 Mission，以及谁能解决。 */
export interface MissionUnknownReview {
  unknown: string;
  affectsMission: boolean;
  worthInvestigating: boolean;
  canAgentResolve: boolean;
  action: 'ignore' | 'investigate' | 'ask_user';
  reason: string;
}

export interface MissionUnknownInput {
  mission: {
    purpose: string;
    expectedResult: string;
    deliverables: Array<{ id: string; title: string; description: string; required: boolean }>;
  };
  unknowns: string[];
  context?: string | string[] | Record<string, unknown>;
  model?: string;
  workingDirectory?: string;
  onTrajectory?: AskInput['onTrajectory'];

}

export interface JevSmartFuncInput {
  /** 这次要做什么判断；不要把状态内容重复写进 prompt。 */
  prompt: string;
  /**
   * 被判断的 state/context。
   * 字符串适合简单情况；数组适合多个独立材料；对象适合结构化状态。
   */
  context: string | string[] | Record<string, unknown>;
  /** 可以共享同一个 context 一次完成多个原子判断。 */
  questions: Record<string, JevQuestion>;
  /** 不传则使用应用默认模型。 */
  model?: string;
  /** 这次判断在人类可读轨迹中的名称。 */
  modelCallName?: string;
  /** 让 Smart Function 在正确的工作目录运行；默认使用应用 workspace。 */
  workingDirectory?: string;
  onTrajectory?: AskInput['onTrajectory'];

}

const probabilitySchema = z.array(
  z.object({
    key: z.string().min(1),
    probability: z.number().min(0).max(1),
  }).strict(),
);

const scoreProbabilitySchema = z.array(
  z.object({
    level: z.string().min(1),
    probability: z.number().min(0).max(1),
  }).strict(),
);

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string().min(1),
  probabilities: probabilitySchema,
  confidence: z.number().min(0).max(1),
}).strict();

const scoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  probabilities: scoreProbabilitySchema,
  confidence: z.number().min(0).max(1),
}).strict();

const noulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number().min(0).max(1),
}).strict();

/**
 * 根据 questions 动态生成严格 JSON Schema。
 *
 * 每个 question 都有自己的固定答案类型；这样模型不能漏掉某个判断，
 * 也不能在输出里混入额外字段。Copilot SDK 会把这个 Zod Schema 转成 JSON Schema。
 */
export function buildJevSmartFuncResponseSchema(
  questions: Record<string, JevQuestion>,
): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (!/^[_a-zA-Z][_a-zA-Z0-9-]*$/.test(key)) {
      throw new Error('Smart Function question key 不合法：' + key);
    }
    shape[key] =
      question.type === 'choice'
        ? choiceAnswerSchema
        : question.type === 'score'
          ? scoreAnswerSchema
          : noulAnswerSchema;
  }
  return z.object(shape).strict();
}

function renderContext(context: JevSmartFuncInput['context']): string {
  if (typeof context === 'string') return context;
  if (Array.isArray(context)) {
    return context.map((item, index) => '【材料 ' + String(index + 1) + '】\n' + item).join('\n\n');
  }
  return JSON.stringify(context, null, 2);
}

function renderQuestions(questions: Record<string, JevQuestion>): string {
  return Object.entries(questions).map(([key, question]) => {
    if (question.type === 'choice') {
      return [
        '问题 key：' + key,
        '类型：choice',
        '判断标准：' + question.instructions,
        '候选项：',
        ...Object.entries(question.options).map(([option, description]) => '- ' + option + '：' + description),
      ].join('\n');
    }

    if (question.type === 'score') {
      return [
        '问题 key：' + key,
        '类型：score',
        '判断标准：' + question.instructions,
        '评分等级（从低到高）：',
        ...question.levels.map((level, index) =>
          '- ' + String(index) + ' / ' + level.name + '：' + level.description),
      ].join('\n');
    }

    return [
      '问题 key：' + key,
      '类型：noul',
      '判断命题：' + question.instructions,
      ...(question.criteria
        ? [
            '判定口径：',
            '- true：' + question.criteria.true,
            '- false：' + question.criteria.false,
          ]
        : []),
    ].join('\n');
  }).join('\n\n');
}

function validateAndNormalize(
  questions: Record<string, JevQuestion>,
  raw: Record<string, unknown>,
): Record<string, JevSmartAnswer> {
  const result: Record<string, JevSmartAnswer> = {};

  for (const [key, question] of Object.entries(questions)) {
    const answer = raw[key];
    if (question.type === 'choice') {
      const parsed = choiceAnswerSchema.parse(answer);
      const allowed = new Set(Object.keys(question.options));
      if (!allowed.has(parsed.choice)) {
        throw new Error('Smart Function choice 超出候选项：' + key + ' -> ' + parsed.choice);
      }
      const probabilities = normalizeProbabilities(
        parsed.probabilities.map((item) => [item.key, item.probability]),
        Object.keys(question.options),
        key,
      );
      result[key] = {
        type: 'choice',
        choice: parsed.choice,
        probabilities,
        confidence: parsed.confidence,
      };
      continue;
    }

    if (question.type === 'score') {
      const parsed = scoreAnswerSchema.parse(answer);
      const maxScore = question.levels.length - 1;
      if (parsed.score < 0 || parsed.score > maxScore) {
        throw new Error('Smart Function score 超出评分范围：' + key);
      }
      const allowed = new Set(question.levels.map((level) => level.name));
      if (parsed.probabilities.some((item) => !allowed.has(item.level))) {
        throw new Error('Smart Function score 概率包含未知等级：' + key);
      }
      const probabilities = normalizeScoreProbabilities(
        parsed.probabilities,
        question.levels.map((level) => level.name),
        key,
      );
      result[key] = {
        type: 'score',
        score: parsed.score,
        probabilities,
        confidence: parsed.confidence,
      };
      continue;
    }

    const parsed = noulAnswerSchema.parse(answer);
    result[key] = {
      type: 'noul',
      noul: parsed.noul,
    };
  }

  return result;
}

/**
 * Smart Function 要的是 JSON，不要求底层模型一定使用同一种输出格式。
 * 允许模型偶尔包一层 Markdown 代码围栏或附带少量前后说明，避免一次格式偏差直接让 Gate 失效。
 */
function extractStructuredJson(raw: string): string {
  const value = raw.trim();
  const fenced = value.match(new RegExp('\\x60{3}(?:json)?\\s*([\\s\\S]*?)\\x60{3}', 'i'));
  if (fenced?.[1]) return fenced[1].trim();

  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) return value.slice(start, end + 1).trim();

  return value;
}

function normalizeProbabilities(
  values: Array<[string, number]>,
  expectedKeys: string[],
  questionKey: string,
): Record<string, number> {
  const map = new Map(values);
  if (map.size !== expectedKeys.length || expectedKeys.some((key) => !map.has(key))) {
    throw new Error('Smart Function choice 概率必须覆盖全部候选项：' + questionKey);
  }

  const total = expectedKeys.reduce((sum, key) => sum + (map.get(key) ?? 0), 0);
  if (Math.abs(total - 1) > 0.03) {
    throw new Error('Smart Function choice 概率和必须约等于 1：' + questionKey);
  }

  return Object.fromEntries(expectedKeys.map((key) => [key, map.get(key)!]));
}

function normalizeScoreProbabilities(
  values: Array<{ level: string; probability: number }>,
  expectedLevels: string[],
  questionKey: string,
): Array<{ level: string; probability: number }> {
  if (
    values.length !== expectedLevels.length
    || expectedLevels.some((level) => !values.some((item) => item.level === level))
  ) {
    throw new Error('Smart Function score 概率必须覆盖全部等级：' + questionKey);
  }

  const total = values.reduce((sum, item) => sum + item.probability, 0);
  if (Math.abs(total - 1) > 0.03) {
    throw new Error('Smart Function score 概率和必须约等于 1：' + questionKey);
  }

  return expectedLevels.map((level) => ({
    level,
    probability: values.find((item) => item.level === level)!.probability,
  }));
}

/**
 * 构造通用 Mission Alignment 判断 Prompt。
 *
 * 这个判断只回答两个问题：本轮成果是否直接服务 Mission，以及如果当前结果已经足够，
 * 是否还有继续深挖的价值。最终是否允许推进仍由 Script Gate 决定。
 */
export function buildMissionAlignmentPrompt(input: MissionAlignmentInput): string {
  return [
    "判断本轮 Investigation 成果是否真正服务于已经确认的 Mission。",
    "",
    "Mission：",
    "任务目的：" + input.mission.purpose.trim(),
    "期望结果：" + input.mission.expectedResult.trim(),
    "必须交付：",
    ...input.mission.deliverables.map((item) =>
      "- " + item.title + "：" + item.description + (item.required ? "（必须）" : "（可选）")),
    "",
    "本轮候选成果：",
    input.candidate.trim(),
    ...(input.context !== undefined ? ["", "补充状态：", renderContext(input.context)] : []),
    "",
    "判断标准：",
    "1. aligned=true：本轮成果直接帮助完成 Mission 的目的、期望结果或明确交付物。",
    "2. aligned=false：主要是在追逐局部发现、无关 unknown、漂亮总结或与 Mission 无直接关系的旁支。",
    "3. worth_continuing=true：仍有明确的 Mission 交付物未完成，或者现有结果还不足以支持用户最终需要的判断。",
    "4. worth_continuing=false：Mission 已经得到足够支持，继续调查主要是在填充无关细节。",
  ].join("\n");
}

/** 把 Smart Function 的概率信号转换为工作台可消费的保守结果。 */
export function normalizeMissionAlignment(
  raw: Record<string, { type: string; noul?: number }>,
): MissionAlignmentReview {
  const alignment = raw.aligned?.noul ?? 0;
  const continuationValue = raw.worth_continuing?.noul ?? 0;
  const aligned = alignment >= 0.72;
  const worthContinuing = continuationValue >= 0.72;

  let reason = aligned
    ? "本轮成果与 Mission 直接相关。"
    : "本轮成果与 Mission 的直接关系不足。";
  if (aligned && !worthContinuing) {
    reason += "当前结果已经接近足够，没有必要为了清空未知项继续深挖。";
  } else if (aligned && worthContinuing) {
    reason += "当前仍有值得完成的工作。";
  }

  return {
    aligned,
    alignment,
    worthContinuing,
    continuationValue,
    reason,
  };
}


/**
 * 把工具参数压成适合 Smart Function 的有限上下文。
 * 参数可能包含很长的查询或敏感值；这里只用于“这个动作是否值得做”的判断，不需要完整 payload。
 */
function summarizeToolArgs(value: unknown): string {
  const sensitive = /password|secret|token|authorization|api[_-]?key|credential/i;
  const replacer = (key: string, item: unknown): unknown => {
    if (sensitive.test(key)) return '[REDACTED]';
    return item;
  };

  try {
    const rendered = JSON.stringify(value, replacer, 2);
    if (!rendered) return '（无参数）';
    return rendered.length > 3500 ? rendered.slice(0, 3500) + '\n…（参数已截断）' : rendered;
  } catch {
    return String(value).slice(0, 3500);
  }
}

/**
 * 构造“行动前”检查 Prompt。
 *
 * 这个判断发生在工具真正执行之前。它不要求模型预测完整执行计划，只判断当前这个动作
 * 是否直接服务某个 Mission 交付物，以及现在做它是否有必要。
 */
export function buildMissionActionPrompt(input: MissionActionInput): string {
  return [
    '判断 Agent 准备执行的这一个工具动作，是否应该在当前 Investigation 中执行。',
    '',
    'Mission（最高优先级）：',
    '任务目的：' + input.mission.purpose.trim(),
    '期望结果：' + input.mission.expectedResult.trim(),
    '交付物：',
    ...input.mission.deliverables.map((item) =>
      '- ' + item.id + '：' + item.title + '；' + item.description + (item.required ? '（必须）' : '（可选）')),
    '',
    '准备执行的动作：',
    '工具：' + input.candidate.toolName,
    '参数：' + summarizeToolArgs(input.candidate.toolArgs),
    ...(input.context !== undefined ? ['', '当前状态：', renderContext(input.context)] : []),
    '',
    '判断标准：',
    '1. aligned=true：这个动作能直接帮助完成 Mission 的目的、期望结果或某个明确交付物。',
    '2. aligned=false：主要是在追逐局部发现、无关 unknown、旁支细节，或者只是“顺便看看”。',
    '3. necessary=true：现在不做这个动作，当前剩余结果会受到实际影响，而且没有更直接的替代动作。',
    '4. necessary=false：可以不做、可以稍后做，或者有更直接的方式完成结果。',
    '5. target_deliverable 必须选择这个动作实际服务的交付物；如果没有直接服务对象，选择 none。',
    '不要因为工具本身看起来有用就允许；只看它对 Mission 是否有直接、当前的价值。',
  ].join('\n');
}

/** 把行动前 Smart Function 输出转成保守的确定性允许/拒绝结果。 */
export function normalizeMissionAction(
  raw: Record<string, { type: string; noul?: number; choice?: string }>,
): MissionActionReview {
  const alignment = raw.aligned?.noul ?? 0;
  const necessity = raw.necessary?.noul ?? 0;
  const targetDeliverableId = raw.target_deliverable?.choice && raw.target_deliverable.choice !== 'none'
    ? raw.target_deliverable.choice
    : null;
  const aligned = alignment >= 0.72;
  const necessary = necessity >= 0.68;
  const allowed = aligned && necessary && Boolean(targetDeliverableId);

  let reason = allowed
    ? '这个动作直接服务当前 Mission，并且现在有必要执行。'
    : '这个动作没有同时满足“直接服务 Mission”和“现在确有必要”两个条件。';
  if (!targetDeliverableId) reason += ' 没有识别到明确的 Mission 交付物。';

  return {
    allowed,
    aligned,
    necessary,
    alignment,
    necessity,
    targetDeliverableId,
    reason,
  };
}

/** 行动前只调用一次 Smart Function，避免每个工具调用都增加一轮模型成本。 */
export async function reviewMissionAction(
  input: MissionActionInput,
): Promise<MissionActionReview | null> {
  try {
    const options = Object.fromEntries([
      ...input.mission.deliverables.map((item) => [
        item.id,
        item.title + '：' + item.description,
      ]),
      ['none', '没有一个明确的 Mission 交付物被这个动作直接推进。'],
    ]);

    const raw = await jevSmartFunc({
      modelCallName: '检查这一步是否有必要',
      prompt: buildMissionActionPrompt(input),
      context: {
        mission: input.mission,
        candidate: {
          toolName: input.candidate.toolName,
          toolArgs: summarizeToolArgs(input.candidate.toolArgs),
        },
        ...(input.context !== undefined ? { state: input.context } : {}),
      },
      questions: {
        aligned: {
          type: 'noul',
          instructions: '这个工具动作是否直接服务 Mission？',
          criteria: {
            true: '直接推进用户明确需要的结果或交付物。',
            false: '主要是旁支、好奇性检索、无关 unknown 或不影响最终结果的细节。',
          },
        },
        necessary: {
          type: 'noul',
          instructions: '现在执行这个动作是否有明确必要性？',
          criteria: {
            true: '不执行会实际阻碍当前 Mission，且没有更直接的替代动作。',
            false: '可以不做、可以延后，或者存在更直接的完成方式。',
          },
        },
        target_deliverable: {
          type: 'choice',
          instructions: '这个动作实际服务哪个 Mission 交付物？',
          options,
        },
      },
      ...(input.model ? { model: input.model } : {}),
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    });

    return normalizeMissionAction(
      raw as Record<string, { type: string; noul?: number; choice?: string }>,
    );
  } catch {
    // Smart Function 不是权限边界；不可用时不伪装成“业务判断通过”，交给 Stage Gate 做最终兜底。
    return null;
  }
}

/**
 * 构造 Unknown 影响判断。
 *
 * 所有 unknown 一次性判断，避免“每个 unknown 一个模型调用”。输出再由 Script 按 action 执行：
 * ignore = 不追；investigate = Agent 自己查；ask_user = 需要用户补输入/做决定。
 */
export function buildMissionUnknownPrompt(input: MissionUnknownInput): string {
  return [
    '判断这些 Unknown 是否值得为了本次 Mission 继续调查。',
    '',
    'Mission：',
    '任务目的：' + input.mission.purpose.trim(),
    '期望结果：' + input.mission.expectedResult.trim(),
    '必须交付：',
    ...input.mission.deliverables.map((item) =>
      '- ' + item.id + '：' + item.title + '；' + item.description + (item.required ? '（必须）' : '（可选）')),
    '',
    'Unknown：',
    ...input.unknowns.map((unknown, index) => 'unknown_' + index + ': ' + unknown),
    ...(input.context !== undefined ? ['', '补充状态：', renderContext(input.context)] : []),
    '',
    '对每个 Unknown 分别判断：',
    '1. affects_mission=true：它如果长期未知，会影响用户最终要拿到的结果或重要决策。',
    '2. worth_investigating=true：即使影响 Mission，也值得现在投入调查成本；不是理论上有关系就一直查。',
    '3. can_agent_resolve=true：Agent 可以仅凭已有工具、代码、SQL、配置、文档或已授权资料解决，不需要用户提供信息或做业务选择。',
    '4. 三项判断合并成 action：',
    '   - affects_mission=false 或 worth_investigating=false -> ignore',
    '   - affects_mission=true 且 worth_investigating=true 且 can_agent_resolve=true -> investigate',
    '   - affects_mission=true 且 worth_investigating=true 且 can_agent_resolve=false -> ask_user',
    'Unknown 是状态，不是待办清单；ignore 不代表删除事实，只代表不能让它驱动下一步行动。',
  ].join('\n');
}

/** 把一个 Unknown 的三个 Smart Function 结果归一成确定动作。 */
export function normalizeUnknownImpact(
  unknown: string,
  raw: Record<string, { type: string; noul?: number }>,
): MissionUnknownReview {
  const affectsMission = (raw.affects_mission?.noul ?? 0) >= 0.72;
  const worthInvestigating = (raw.worth_investigating?.noul ?? 0) >= 0.72;
  const canAgentResolve = (raw.can_agent_resolve?.noul ?? 0) >= 0.68;

  const action: MissionUnknownReview['action'] =
    !affectsMission || !worthInvestigating
      ? 'ignore'
      : canAgentResolve
        ? 'investigate'
        : 'ask_user';

  const reason =
    action === 'ignore'
      ? '这个 Unknown 不足以影响当前 Mission 的继续执行。'
      : action === 'investigate'
        ? '它影响 Mission，而且 Agent 可以自己通过现有资料继续查清。'
        : '它影响 Mission，但现有资料不足，需要用户补输入或做决定。';

  return {
    unknown: unknown.trim(),
    affectsMission,
    worthInvestigating,
    canAgentResolve,
    action,
    reason,
  };
}

/** 一次性判断当前最多 6 个 Unknown，避免把 Unknown 变成连续模型调用队列。 */
export async function reviewUnknownImpact(
  input: MissionUnknownInput,
): Promise<MissionUnknownReview[] | null> {
  const unknowns = input.unknowns.map((item) => item.trim()).filter(Boolean).slice(0, 6);
  if (!unknowns.length) return [];

  try {
    const questions: Record<string, JevQuestion> = {};
    unknowns.forEach((_unknown, index) => {
      questions['unknown_' + index + '_affects'] = {
        type: 'noul',
        instructions: 'unknown_' + index + ' 是否会影响 Mission 的最终结果或重要决策？',
      };
      questions['unknown_' + index + '_worth'] = {
        type: 'noul',
        instructions: 'unknown_' + index + ' 是否值得现在投入调查成本？',
      };
      questions['unknown_' + index + '_resolve'] = {
        type: 'noul',
        instructions: 'unknown_' + index + ' 是否可以仅凭 Agent 当前已有工具、代码、SQL、配置、文档和授权资料自行解决？',
      };
    });

    const raw = await jevSmartFunc({
      modelCallName: '检查未知项是否需要继续调查',
      prompt: buildMissionUnknownPrompt(input),
      context: {
        mission: input.mission,
        unknowns,
        ...(input.context !== undefined ? { state: input.context } : {}),
      },
      questions,
      ...(input.model ? { model: input.model } : {}),
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    });

    return unknowns.map((unknown, index) =>
      normalizeUnknownImpact(unknown, {
        affects_mission: raw['unknown_' + index + '_affects'] as { type: string; noul?: number },
        worth_investigating: raw['unknown_' + index + '_worth'] as { type: string; noul?: number },
        can_agent_resolve: raw['unknown_' + index + '_resolve'] as { type: string; noul?: number },
      }),
    );
  } catch {
    // Smart Function 不可用时保留原 Unknown；本轮不擅自把它升级成 ask_user。
    return null;
  }
}

/**
 * 通用 Mission Alignment：供阶段 Gate、自动续跑等需要“有没有价值”判断的地方复用。
 */
export async function reviewMissionAlignment(
  input: MissionAlignmentInput,
): Promise<MissionAlignmentReview | null> {
  try {
    const raw = await jevSmartFunc({
      modelCallName: '检查阶段成果是否符合任务',
      prompt: buildMissionAlignmentPrompt(input),
      context: {
        mission: input.mission,
        candidate: input.candidate,
        ...(input.context !== undefined ? { state: input.context } : {}),
      },
      questions: {
        aligned: {
          type: "noul",
          instructions: "本轮成果是否直接服务于 Mission 的任务目的、期望结果或明确交付物？",
          criteria: {
            true: "结果直接帮助完成用户明确要求的结果。",
            false: "结果主要是旁支发现、无关 unknown、局部细节或与 Mission 无直接关系的工作。",
          },
        },
        worth_continuing: {
          type: "noul",
          instructions: "完成本轮结果后，是否仍然值得继续调查？",
          criteria: {
            true: "仍有明确的 Mission 交付物未完成，或者现有结果还不足以支持用户最终需要的判断。",
            false: "Mission 已经得到足够支持，继续调查主要只是在寻找更多细节。",
          },
        },
      },
      ...(input.model ? { model: input.model } : {}),
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    });

    return normalizeMissionAlignment(raw as Record<string, { type: string; noul?: number }>);
  } catch {
    // Smart Function 只是语义判断辅助；服务异常时由确定性 Stage Script Gate 继续裁决。
    return null;
  }
}

/**
 * Jev-like Smart Function 主入口。
 *
 * 不创建长期 Session，不调用工具，不进入自动续跑；每次调用都是一个独立判断。
 * 这正是它和普通 Agent 的区别：输入有限状态，输出有限决策。
 */
export async function jevSmartFunc(
  input: JevSmartFuncInput,
): Promise<Record<string, JevSmartAnswer>> {
  const questionEntries = Object.entries(input.questions);
  if (!questionEntries.length) {
    throw new Error('Smart Function 至少需要一个 question。');
  }

  for (const [key, question] of questionEntries) {
    if (!question.instructions.trim()) {
      throw new Error('Smart Function question 缺少 instructions：' + key);
    }
    if (question.type === 'choice' && Object.keys(question.options).length < 2) {
      throw new Error('choice 至少需要两个候选项：' + key);
    }
    if (question.type === 'score' && (question.levels.length < 2 || question.levels.length > 10)) {
      throw new Error('score 需要 2～10 个从低到高排列的等级：' + key);
    }
  }

  const responseSchema = buildJevSmartFuncResponseSchema(input.questions);
  const systemPrompt = [
    '你是一个 Decision Function，不是聊天助手。',
    '你的工作只有一个：根据给定 context，对已经定义好的问题做有限、明确的判断。',
    '不要调用工具，不要继续调查，不要输出解释性文章。',
    '只能使用 context 中提供的信息，不要补充外部事实。',
    'choice 必须从给定候选项中选一个；probabilities 覆盖全部候选项，概率之和应为 1。',
    'score 必须落在给定等级的最低值到最高值之间；不要自己改变评分尺度。',
    'noul 返回 0 到 1，表示判断命题为 true 的概率。',
    'confidence 表示你对 choice / score 这个判断的把握程度，不要把它当成业务风险分数。',
  ].join('\n');

  const prompt = [
    '判断任务：',
    input.prompt.trim(),
    '',
    'Context / State：',
    renderContext(input.context),
    '',
    '问题：',
    renderQuestions(input.questions),
    '',
    '只返回符合 Schema 的结果，不要返回 Markdown，不要解释。',
  ].join('\n');

  const raw = await askAgentWithFallback({
    prompt,
    systemPrompt,
    purpose: 'review',
    model: input.model ?? config.model,
    ...(input.modelCallName ? { modelCallName: input.modelCallName } : {}),
    workingDirectory: input.workingDirectory ?? config.workspaceDir,
    ...(input.onTrajectory ? { onTrajectory: input.onTrajectory } : {}),
    autoContinuationTurns: 0,
    responseSchema,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractStructuredJson(raw));
  } catch {
    throw new Error('Smart Function 返回的 structured output 不是合法 JSON。');
  }

  const validated = responseSchema.parse(parsed);
  return validateAndNormalize(input.questions, validated as Record<string, unknown>);
}
