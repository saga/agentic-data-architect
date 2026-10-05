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
import { askCopilot } from './copilot.js';
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
  /** 让 Smart Function 在正确的工作目录运行；默认使用应用 workspace。 */
  workingDirectory?: string;
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
  const shape: z.ZodRawShape = {};
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

  const raw = await askCopilot({
    prompt,
    systemPrompt,
    purpose: 'review',
    model: input.model ?? config.model,
    workingDirectory: input.workingDirectory ?? config.workspaceDir,
    autoContinuationTurns: 0,
    responseSchema,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Smart Function 返回的 structured output 不是合法 JSON。');
  }

  const validated = responseSchema.parse(parsed);
  return validateAndNormalize(input.questions, validated as Record<string, unknown>);
}
