/**
 * 工作地图 AI。
 *
 * 这是独立的“工作地图设计助手”，只负责提出 Workflow Patch。
 * 服务端应用 Patch、校验后返回候选 Definition；不会直接保存。
 */
import * as z from 'zod';
import { askCopilot } from '../agent/copilot.js';
import { loadWorkspaceContext, workspaceRoot } from '../investigation/workspace.js';
import type { WorkflowId } from '../investigation/schemas.js';
import {
  JourneyDefinitionSchema,
  validateJourneyDefinition,
  type JourneyDefinition,
} from './journey.js';
import {
  applyJourneyWorkflowChanges,
  describeJourneyWorkflowChange,
  diffJourneyWorkflowDefinitions,
  validateJourneyChangeScope,
  JourneyWorkflowChangesSchema,
  JourneyWorkflowChangeSchema,
  type JourneyWorkflowChange,
} from './journey-edit.js';
import { getJourneySnapshot } from './journey-editor.js';

const JourneyAiOutputSchema = z.object({
  message: z.string().trim().optional(),
  changes: JourneyWorkflowChangesSchema,
}).strict();

export interface JourneyAiConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 工作地图 AI 只需要最近的少量上下文。
 * 限制总字符数，避免长时间多轮对话把 Workflow Definition 之外的历史撑得过大。
 */
const MAX_HISTORY_CHARS = 18000;
const MAX_HISTORY_MESSAGE_CHARS = 3000;

function limitConversationHistory(
  history: JourneyAiConversationMessage[],
): JourneyAiConversationMessage[] {
  const result: JourneyAiConversationMessage[] = [];
  let total = 0;

  for (const item of history.slice(-12).reverse()) {
    const content = item.content.trim();
    if (!content) continue;

    const remaining = MAX_HISTORY_CHARS - total;
    if (remaining <= 0) break;

    const limited = content.slice(0, Math.min(MAX_HISTORY_MESSAGE_CHARS, remaining));
    result.unshift({ role: item.role, content: limited });
    total += limited.length;
  }

  return result;
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/);
  const text = fenced?.[1]?.trim() ?? raw.trim();

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI 没有返回可识别的工作地图。');
    return JSON.parse(text.slice(start, end + 1));
  }
}

function buildSystemPrompt(workflowId: WorkflowId): string {
  return [
    '你是“工作地图 AI 助手”。你的唯一工作是设计和修改一张可执行的业务 Workflow 图。',
    '不要分析数据，不要做数据血缘、SQL、业务数据查询，也不要回答普通调查问题。',
    '你的输出必须是严格 JSON，不要输出 Markdown、解释文字或代码围栏。',
    '',
    'JSON 格式：',
    '{"message":"用一句到两句话说明你改了什么","changes":[...]}',
    '',
    'changes 允许：',
    '{"type":"add-node","node":{...}}',
    '{"type":"update-node","nodeId":"...","patch":{...}}',
    '{"type":"remove-node","nodeId":"..."}',
    '{"type":"add-route","nodeId":"...","route":{"outcome":"...","target":"...","condition":"..."}}',
    '{"type":"update-route","nodeId":"...","outcome":"...","patch":{"target":"...","condition":"..."}}',
    '{"type":"remove-route","nodeId":"...","outcome":"..."}',
    '{"type":"replace-definition","definition":{...}}',
    '',
    'definition 必须符合当前 Workflow 的结构：',
    '- id 必须等于 "' + workflowId + '"；',
    '- start 必须指向 nodes 中存在的节点；',
    '- node.type 只能是 task、gate、review、end、stop；',
    '- 非终点节点至少有一条 routes；终点不能有 routes；',
    '- routes.target 必须指向存在的节点；',
    '- 同一个节点的 outcome 不能重复；',
    '- 每个节点都必须从 start 可到达，并最终能到达 end 或 stop；',
    '- deterministic 节点必须有合法 completeWhen；',
    '- actor 只能是 agent、human、system；review 默认由 human 执行；',
    '- route 可以写 condition，但只能使用已知 completeWhen 条件；',
    '- route condition 的 DSL 写法是“- success -> target if goal”，命中的条件出口优先；',
    '- visible、completion、actor、objective 等字段要完整填写；requires / produces 使用字符串数组。',
    '- replace-definition 只允许在 generate 模式使用；modify 模式必须返回局部 changes。',
    '',
    '修改已有地图时：',
    '- 尽量保留已有节点 ID，只有确实需要时才新增或删除；',
    '- 不要为了重排版修改没有必要修改的业务语义；',
    '- 优先做小而明确的结构修改，保持路线容易理解。',
    '',
    '当前工作方式：' + workflowId,
  ].join('\n');
}

function buildPrompt(
  mode: 'generate' | 'modify',
  userPrompt: string,
  goal: string,
  current: JourneyDefinition,
  history: JourneyAiConversationMessage[],
  scope: 'workflow' | 'selection',
  selectedNodeId?: string,
): string {
  return [
    mode === 'generate' ? '请重新设计当前工作地图。' : '请修改当前工作地图。',
    '用户要求：',
    userPrompt.trim(),
    '',
    '这次 Investigation 的目标：',
    goal.trim() || '未填写目标，请根据当前工作地图保持合理结构。',
    '',
    '修改范围：' + (scope === 'selection'
      ? '只允许修改选中步骤及其直接相邻步骤/分支。选中节点：' + (selectedNodeId ?? '未提供')
      : '可以修改整张 Workflow。'),
    '',
    '当前工作地图 JSON：',
    JSON.stringify(current, null, 2),
    '',
    ...(() => {
      const limitedHistory = limitConversationHistory(history);
      return limitedHistory.length
        ? [
            '之前的工作地图 AI 对话（这些内容只是上下文，当前画布才是真实状态）：',
            ...limitedHistory.map((item) => (
              (item.role === 'user' ? '用户：' : 'AI：') + item.content
            )),
            '',
          ]
        : [];
    })(),
    '请只返回严格 JSON。',
  ].join('\n');
}

export async function generateJourneyFlow(
  name: string,
  workflowId: WorkflowId,
  mode: 'generate' | 'modify',
  prompt: string,
  history: JourneyAiConversationMessage[] = [],
  baseDefinition?: JourneyDefinition,
  scope: 'workflow' | 'selection' = 'workflow',
  selectedNodeId?: string,
): Promise<{
  definition: JourneyDefinition;
  message: string;
  changes: JourneyWorkflowChange[];
  summary: string[];
}> {
  const snapshot = await getJourneySnapshot(name, workflowId);
  const context = await loadWorkspaceContext(name);
  const currentDefinition = baseDefinition
    ? JourneyDefinitionSchema.parse(baseDefinition)
    : snapshot.definition;

  if (currentDefinition.id !== workflowId) {
    throw new Error('AI 使用的工作地图与当前工作方式不一致，请刷新后重试。');
  }

  const raw = await askCopilot({
    prompt: buildPrompt(
      mode,
      prompt,
      context.goal || context.userPrompt,
      currentDefinition,
      history,
      scope,
      selectedNodeId,
    ),
    systemPrompt: buildSystemPrompt(workflowId),
    purpose: 'journey-map',
    workingDirectory: workspaceRoot(name),
  });

  let parsed: z.infer<typeof JourneyAiOutputSchema>;
  try {
    parsed = JourneyAiOutputSchema.parse(extractJson(raw));
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'AI 返回的工作地图修改格式不正确，请重试。',
    );
  }

  const changes = parsed.changes.map((change) => JourneyWorkflowChangeSchema.parse(change));

  if (mode === 'generate') {
    if (changes.length !== 1 || changes[0]?.type !== 'replace-definition') {
      throw new Error('重新设计模式必须返回一个 replace-definition 修改。');
    }
  } else if (changes.some((change) => change.type === 'replace-definition')) {
    throw new Error('修改模式只能返回局部 Workflow changes。');
  }

  if (scope === 'selection') {
    const scopeIssues = validateJourneyChangeScope(currentDefinition, changes, selectedNodeId);
    if (scopeIssues.length) {
      throw new Error('AI 修改范围超出当前选中步骤：\n' + scopeIssues.join('\n'));
    }
  }

  let nextDefinition: JourneyDefinition;
  try {
    nextDefinition = applyJourneyWorkflowChanges(currentDefinition, changes);
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'AI 修改无法应用到当前工作地图。',
    );
  }

  if (nextDefinition.id !== workflowId) {
    throw new Error('AI 不能把当前 Workflow 修改成另一个工作方式。');
  }

  const issues = validateJourneyDefinition(nextDefinition);
  if (issues.length) {
    throw new Error('AI 生成的工作地图还不能使用：\n' + issues.join('\n'));
  }

  const canonicalChanges = diffJourneyWorkflowDefinitions(currentDefinition, nextDefinition);
  return {
    definition: nextDefinition,
    message: parsed.message?.trim() || 'AI 已提出一版工作地图修改，请检查变更后应用。',
    changes: canonicalChanges,
    summary: canonicalChanges.map(describeJourneyWorkflowChange),
  };
}
