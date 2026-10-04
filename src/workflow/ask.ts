/**
 * 问答 Workflow：把概率性 Agent 执行包在确定性的状态机和持久化边界内。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import { askCopilot, hasActiveCopilotTurn, type AskInput } from '../agent/copilot.js';
import { extractGitHubRepositories, researchGitHubRepository } from '../agent/research-github.js';
import { getGraphifyRuntimeMetadata } from '../adapters/graphify.js';
import { buildQuestionPrompt, LEAD_SYSTEM_PROMPT } from '../agent/prompts.js';
import { parseAgentAnswer, toClaims } from '../agent/result.js';
import { buildQuestionContext } from '../analysis/context.js';
import { nextId } from '../evidence/types.js';
import { abortStaleConversationTurn, beginConversationTurn, finishConversationTurn, getRunningConversationTurn, listConversationMessages, saveConversationMessage, searchConversation } from '../investigation/conversation.js';
import {
  appendAuditEvent,
  buildResearchConfigPrompt,
  loadInvestigationControl,
  toCopilotMcpServers,
} from '../investigation/control.js';
import { loadInvestigation, loadLatestSnapshot, saveInvestigation, updateInvestigationJourneyPlan } from '../investigation/store.js';
import { appendTrajectoryEvent } from '../investigation/trajectory.js';
import { workspaceRoot } from '../investigation/workspace.js';
import type { DiscoverySnapshot } from './discover.js';
import { renderArchitectureKnowledge, searchArchitectureKnowledge } from '../knowledge/catalog.js';
import type { JourneyRouteOption } from '../investigation/schemas.js';

// 进程内的 Investigation 执行保留。phase=executing 时允许 Stop，进入 committing 后保护整个提交事务。
const activeInvestigationTurns = new Map<string, { turnId: string; phase: 'executing' | 'committing' }>();
// 用户已经发出 Stop 的 turn 集合；只用于执行阶段的协作式取消检查。
const abortRequestedTurns = new Set<string>();

/** 请求取消指定 Investigation 的当前 turn；commit 阶段故意拒绝取消，避免留下半提交状态。 */
export function requestAbort(investigationName: string, turnId: string): boolean {
  const active = activeInvestigationTurns.get(investigationName);
  if (!active || active.turnId !== turnId || active.phase !== 'executing') return false;
  abortRequestedTurns.add(turnId);
  return true;
}

/** workflow 返回给 API/UI 的稳定答案摘要，不把 Copilot 原始运行时对象泄漏出去。 */
export interface AnswerSummary {
  answer: string;
  claimIds: string[];
  warnings: string[];
  unknowns: string[];
  /** 回答后的下一步问题；前端用它生成主动引导输入卡片。 */
  followUpQuestions: string[];
  /** Agent 根据当前目标、证据和动作生成的可选路线；只是导引，不是强制流程。 */
  routeOptions: Array<{ id: string; title: string; reason: string; steps: string[] }>;
}

/** 完整执行一轮 Investigation 问答：抢占 turn → 固定 Control → 构造证据上下文 → 执行 Agent → 解析答案 → 原子提交结果。 */
export async function answerQuestion(
  investigationName: string,
  question: string,
  onDelta?: (delta: string) => void,
  turnId?: string,
  onStatus?: (status: string) => void,
  options?: {
    selectedRoute?: JourneyRouteOption;
    /** 用户点击了上一轮 Agent 的“继续调查”引导；这次调用应直接执行，而不是重新询问。 */
    selectedGuidance?: string;
  },
): Promise<AnswerSummary> {
  const selectedRoute = options?.selectedRoute;
  const effectiveQuestion = selectedRoute
    ? '选择下一步：' + selectedRoute.title
    : question;

  if (!turnId) turnId = nextId('turn');

  // 第一层并发保护：同一 Investigation 在进程内只能有一个活动 turn。
const reservedTurn = activeInvestigationTurns.get(investigationName);
  if (reservedTurn && reservedTurn.turnId !== turnId) {
    throw new Error('这个 Investigation 正在处理上一轮问题，请等它完成，或者先点 Stop。');
  }

  let turn;
  try {
    turn = beginConversationTurn(investigationName, turnId);
  } catch (error) {
    const running = getRunningConversationTurn(investigationName);
    if (running) throw new Error('This investigation already has an active turn.');
    throw error;
  }

  if (turn.status === 'completed' && turn.result) return JSON.parse(turn.result) as AnswerSummary;

  if (turn.status === 'running') {
    const sameTurnActive =
      activeInvestigationTurns.get(investigationName)?.turnId === turn.turnId ||
      hasActiveCopilotTurn(turn.turnId);
    if (sameTurnActive) {
      throw new Error('This investigation already has an active turn.');
    }
    abortStaleConversationTurn(turn.turnId);
  }

  if (turn.status === 'failed' || turn.status === 'aborted') {
    throw new Error('这次请求已经结束，不能重复执行，请重新发送问题。');
  }

  // Reserve before the first await so another request cannot mistake this turn
  // for stale work while the Copilot session is still being created.
  activeInvestigationTurns.set(investigationName, { turnId, phase: 'executing' });
  try {
    if (abortRequestedTurns.has(turnId)) throw new Error('Turn aborted.');

    // 先写 durable user message，再创建 Agent 上下文；这样重复请求/恢复时仍有稳定的 turn/message 标识。
const userMessage = saveConversationMessage({
    id: turnId + ':user',
    sessionName: investigationName,
    role: 'user',
    content: effectiveQuestion,
  });
  let inv = await loadInvestigation(investigationName);
  const control = await loadInvestigationControl(investigationName);

  // 用户明确给了 GitHub repository 时，先把源码变成当前 Investigation 的真实研究输入。
  // 这样 Agent 不需要自己记住“先 clone 再 discover”这条隐藏流程；失败时仍保留 GitHub Tool 兜底。
  const githubRepositories = [...new Set([
    ...control.research.githubRepositories,
    ...extractGitHubRepositories([inv.goal, inv.userPrompt, effectiveQuestion].filter(Boolean).join('\n')),
  ])].slice(0, 5);
  if (githubRepositories.length) {
    onStatus?.('正在准备代码仓库并建立初始调查资料，请稍候…');
    for (const repository of githubRepositories) {
      try {
        await researchGitHubRepository(investigationName, repository);
      } catch (error) {
        await appendAuditEvent(investigationName, {
          actor: 'system',
          action: 'research.github.bootstrap_failed',
          summary: 'GitHub 仓库自动准备失败，后续 Agent 仍可直接使用 GitHub 工具调查。',
          configurationVersion: control.version,
          details: {
            repository,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    inv = await loadInvestigation(investigationName);
  }
  await appendAuditEvent(investigationName, {
    actor: 'user',
    action: 'investigation.question',
    summary: 'Asked investigation question.',
    configurationVersion: control.version,
    details: {
      questionLength: effectiveQuestion.length,
      ...(selectedRoute ? { selectedRouteId: selectedRoute.id } : {}),
    },
  });

  // 本轮只读取一个固定的 Discovery snapshot；后续 UI/Discovery 变化不应影响已经开始的模型请求。
const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(investigationName);
  const ctx = buildQuestionContext({
    question: effectiveQuestion,
    lineage: snapshot?.lineage ?? null,
    profiles: snapshot?.profiles ?? [],
    findings: inv.findings,
    evidence: inv.evidence,
    currentState: snapshot?.currentState ?? null,
    semanticAssets: snapshot?.semanticAssets ?? [],
    inventory: snapshot?.inventory ?? null,
  });
  // 历史对话只作为 conversation context，不提升成 Evidence，避免旧模型回答污染当前事实来源。
  // “继续/接着/下一步”属于续聊动作，不适合走 FTS：中文短词很可能没有足够 trigram。
  // 即使 Copilot Session 因重启或运行时异常无法恢复，也要依靠 durable SQLite 对话继续工作。
  const isContinuationRequest = /^(继续|接着|下一步|继续查|继续调查|往下查|然后呢)[。！!？?\s]*$/i.test(effectiveQuestion.trim());
  const priorConversation = isContinuationRequest
    ? listConversationMessages(investigationName, 8).filter((item) => item.id !== userMessage.id).slice(-6)
    : searchConversation(investigationName, effectiveQuestion, {
        limit: 6,
        beforeRowId: userMessage.rowId,
      });
  const conversationText = priorConversation.length > 0
    ? [
        '## Relevant conversation history',
        isContinuationRequest
          ? 'This is a continuation request. Use the recent durable conversation below as context; it is conversation context, not evidence.'
          : 'The following earlier messages were retrieved by full-text search. Treat them as conversation context, not as evidence; current evidence and verified findings take precedence.',
        '',
        ...priorConversation.map((item) => {
          const excerpt = item.content.length > 1200 ? item.content.slice(0, 1200) + '…' : item.content;
          return `[${item.role}] ${excerpt}`;
        }),
      ].join('\n')
    : '';
  const questionContextText = [ctx.text, conversationText].filter(Boolean).join('\n\n');

  // 通用知识用于“怎么做”的参考，不得冒充当前 Investigation 的事实证据。
  const knowledge = await searchArchitectureKnowledge(
    [inv.goal, effectiveQuestion].filter(Boolean).join('\n'),
    { workflow: inv.workflow, limit: 6 },
  );
  const knowledgeText = renderArchitectureKnowledge(knowledge);

  // Evidence ownership 边界：模型只能引用当前 Investigation 已存在的 Evidence ID。
const existingEvidence = new Map(inv.evidence.map((e) => [e.id, e]));
  // Prompt 在本次 turn 内固定；之后用户修改配置只影响下一轮，避免 TOCTOU。
const prompt = buildQuestionPrompt({
    investigationName: inv.name,
    goal: inv.goal,
    scope: inv.scope,
    question: effectiveQuestion,
    contextText: questionContextText,
    ...(selectedRoute ? { selectedRoute } : {}),
    ...(options?.selectedGuidance ? { selectedGuidance: options.selectedGuidance } : {}),
    evidenceIds: ctx.evidenceIds,
    unknowns: inv.unknowns,
  });

  const repositoryPrompt = githubRepositories.length
    ? [
        '## Primary code research sources',
        '本次架构任务明确包含以下 GitHub repository，它们是首要研究对象：',
        ...githubRepositories.map((repository) => '- ' + repository),
        '优先研究这些仓库本身。代码、配置、SQL、DDL、REST、Service、Entity 和数据访问逻辑都应优先从仓库里自己查；某个局部证据暂时无法确认时，换其它可查方向，不要先问用户。',
      ].join('\n')
    : '';
    // The prompt and configuration snapshot are fixed for this turn; later
    // UI changes apply only to the next turn.
    if (selectedRoute) {
    await appendAuditEvent(investigationName, {
      actor: 'user',
      action: 'investigation.route.selected',
      summary: '用户选择了一个下一步调查动作。',
      configurationVersion: control.version,
      details: {
        routeId: selectedRoute.id,
        title: selectedRoute.title,
        steps: selectedRoute.steps,
      },
    });
  }

  // 到这里才进入概率性的模型执行阶段；前面的状态和配置已经全部确定。
  // Workflow is a work mode, not a user-configurable capability. In the selected mode load only that workflow Skill; in autonomous mode load none.
  // Capability Skills remain discoverable to Copilot. The selected Workflow is the
  // only Workflow Skill left eligible, so the Agent does not mix routes.
  const graphifyBefore = await getGraphifyRuntimeMetadata(workspaceRoot(inv.name));
  await appendAuditEvent(investigationName, {
    actor: 'system',
    action: 'investigation.graphify.runtime.started',
    summary: 'Captured Graphify runtime metadata before Agent execution.',
    configurationVersion: control.version,
    details: { runtime: graphifyBefore, platformCapabilities: control.agent.platformCapabilities },
  });

let trajectoryWrite: Promise<void> = Promise.resolve();
  type TrajectoryCallbackEvent =
    NonNullable<AskInput['onTrajectory']> extends (event: infer T) => void ? T : never;
  const recordTrajectory = (event: TrajectoryCallbackEvent): void => {
    trajectoryWrite = trajectoryWrite
      .then(async () => {
        await appendTrajectoryEvent(investigationName, {
          ...event,
          turnId,
          details: event.details ?? {},
        });
      })
      .catch(() => undefined);
  };

  recordTrajectory({
    type: 'user_input',
    name: '用户问题',
    status: 'info',
    details: { question },
  });

  const raw = await askCopilot({
    prompt,
    systemPrompt: [
      LEAD_SYSTEM_PROMPT,
      inv.workflow
        ? '当前工作方式：' + inv.workflow + '。它是当前 Investigation 的可执行工作流；Agent 必须围绕当前节点工作，并且只能使用工作流定义中存在的 outcome 推进。是否推进由本轮实际结果和证据决定，不能猜。'
        : '当前没有固定工作方式。根据目标、Evidence、未知项和最有价值的下一步自主推进；可以建议工作方式，但不能假定必须使用某一条路线。',
      knowledgeText,
      buildResearchConfigPrompt(control),
      repositoryPrompt,
    ].filter(Boolean).join('\n\n'),
    ...(inv.copilotConfigurationVersion === control.version && inv.copilotSessionId
      ? { sessionId: inv.copilotSessionId }
      : {}),
    onSessionId: (sessionId) => {
      if (sessionId !== inv.copilotSessionId) {
        inv.copilotSessionId = sessionId;
      }
      inv.copilotConfigurationVersion = control.version;
    },
    workingDirectory: workspaceRoot(inv.name),
    ...(inv.workflow ? { workflowSkill: inv.workflow } : {}),
    platformCapabilities: control.agent.platformCapabilities,
    // 每轮执行读取并固定当前 Investigation 的权限模式；配置修改后会创建新的 Copilot Session。
    permissionMode: control.agent.permissionMode,
    autoContinuationTurns: control.agent.autoContinuationTurns,
    mcpServers: toCopilotMcpServers(control) as NonNullable<Parameters<typeof askCopilot>[0]['mcpServers']>,
    ...(onDelta ? { onDelta } : {}),
    ...(onStatus ? { onStatus } : {}),
    onTrajectory: recordTrajectory,
    turnId,
    shouldAbort: () => abortRequestedTurns.has(turnId),
  });
  await trajectoryWrite;
  if (abortRequestedTurns.has(turnId)) throw new Error('Turn aborted.');

  const graphifyAfter = await getGraphifyRuntimeMetadata(workspaceRoot(inv.name));
  await appendAuditEvent(investigationName, {
    actor: 'system',
    action: 'investigation.graphify.runtime.completed',
    summary: 'Captured Graphify runtime and graph hash after Agent execution.',
    configurationVersion: control.version,
    details: { runtime: graphifyAfter, platformCapabilities: control.agent.platformCapabilities },
  });

  // Once the model has returned, move into a non-cancelable commit phase.
  // This prevents a Stop request from leaving context state and conversation
  // history half-committed.
  const activeAfterExecution = activeInvestigationTurns.get(investigationName);
  if (activeAfterExecution?.turnId === turnId) {
    // 一旦模型返回，切换到不可取消的 commit 阶段，保证 context/claims/conversation 一致落盘。
activeAfterExecution.phase = 'committing';
  }
  abortRequestedTurns.delete(turnId);

  // local_* 工具可能在模型执行期间新增 Evidence。重新读取最新 Investigation，
  // 让模型刚刚使用真实数据得到的 Evidence ID 也能通过 ownership 校验。
  const latestAfterTools = await loadInvestigation(investigationName);
  const evidenceAfterTools = new Map(latestAfterTools.evidence.map((e) => [e.id, e]));
  for (const evidence of latestAfterTools.evidence) {
    if (!inv.evidence.some((item) => item.id === evidence.id)) inv.evidence.push(evidence);
  }
  const parsed = parseAgentAnswer(raw, evidenceAfterTools);
  const claims = toClaims(parsed, () => nextId('c'));
  inv.claims.push(...claims);
  if (!inv.questions.includes(effectiveQuestion)) inv.questions.push(effectiveQuestion);
  // unknowns 表示“当前这一刻最值得保留的事实缺口”，不是历史累计日志。
  // 每轮直接用模型重新整理后的结果替换，避免几十轮之后变成 40+ 条过时待查项。
  const currentUnknowns = [...new Set(
    parsed.unknowns
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => item.length <= 500),
  )].slice(0, 12);
  inv.unknowns = currentUnknowns;

  const answer = parsed.answer || raw.slice(0, 2000);
  await saveInvestigation(inv);

  // 每轮回答后重新生成动态路线。它是“导航建议”，不是状态机跳转；
  // 下一轮用户动作、Evidence 或 Unknown 改变后，会再次生成新的路线。
  const journeyPlan = {
    version: 1 as const,
    source: 'agent' as const,
    generatedAt: new Date().toISOString(),
    turnId,
    routes: parsed.routeOptions,
  };
  await updateInvestigationJourneyPlan(investigationName, journeyPlan, inv.workflow);
  await appendAuditEvent(investigationName, {
    actor: 'system',
    action: 'investigation.route.replanned',
    summary: 'Replanned optional investigation routes after the latest Agent turn.',
    configurationVersion: control.version,
    details: {
      turnId,
      workflow: inv.workflow,
      routeCount: parsed.routeOptions.length,
    },
  });

  saveConversationMessage({
    sessionName: investigationName,
    role: 'assistant',
    content: answer,
  });
  const result: AnswerSummary = {
    answer,
    claimIds: claims.map((c) => `${c.id}[${c.status}]`),
    warnings: parsed.warnings,
    unknowns: parsed.unknowns,
    followUpQuestions: parsed.followUpQuestions,
    routeOptions: parsed.routeOptions,
  };
  recordTrajectory({
    type: 'status',
    name: '结果已保存',
    status: 'completed',
    details: {
      claimCount: claims.length,
      unknownCount: parsed.unknowns.length,
      routeCount: parsed.routeOptions.length,
      followUpCount: parsed.followUpQuestions.length,
    },
  });
  await trajectoryWrite;
  // durable turn 最后才标记 completed，保证数据库状态代表已经真正写完结果。
finishConversationTurn(turnId, 'completed', JSON.stringify(result));
  return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishConversationTurn(turnId, /abort/i.test(message) ? 'aborted' : 'failed', undefined, message);
    throw error;
  } finally {
    if (activeInvestigationTurns.get(investigationName)?.turnId === turnId) {
      activeInvestigationTurns.delete(investigationName);
    }
    abortRequestedTurns.delete(turnId);
  }
}
