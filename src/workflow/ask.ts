/**
 * 问答 Workflow：把概率性 Agent 执行包在确定性的状态机和持久化边界内。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import { askCopilot, hasActiveCopilotTurn, type AskInput } from '../agent/copilot.js';
import { extractGitHubRepositories, researchGitHubRepository } from '../agent/research-github.js';
import { getGraphifyRuntimeMetadata } from '../adapters/graphify.js';
import { buildMissionContractPrompt, buildQuestionPrompt, LEAD_SYSTEM_PROMPT } from '../agent/prompts.js';
import { parseAgentAnswer, toClaims } from '../agent/result.js';
import type { AgentCheckpoint } from '../investigation/schemas.js';
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
import { appendContextInput, appendTranscript, setCopilotSessionId, workspaceRoot } from '../investigation/workspace.js';
import type { DiscoverySnapshot } from './discover.js';
import { renderArchitectureKnowledge, searchArchitectureKnowledge } from '../knowledge/catalog.js';
import type { JourneyRouteOption } from '../investigation/schemas.js';
import { persistAgentIntake } from './scope-gate.js';
import { assertMissionGate } from './mission-gate.js';
import {
  buildStageCheckpoint,
  evaluateInvestigationStageGate,
  snapshotInvestigationForStageGate,
} from './stage-gate.js';
import { buildMissionProgress, missionHasOpenDeliverables } from './mission-progress.js';

// 进程内的 Investigation 执行保留。phase=executing 时允许 Stop，进入 committing 后保护整个提交事务。
const activeInvestigationTurns = new Map<string, { turnId: string; phase: 'executing' | 'committing' }>();
// 用户已经发出 Stop 的 turn 集合；只用于执行阶段的协作式取消检查。
const abortRequestedTurns = new Set<string>();

/** 返回当前进程真正持有的 active turn；不要用持久化 trajectory 状态代替这个 live 状态。 */
export function getActiveInvestigationTurn(investigationName: string): {
  turnId: string;
  phase: 'executing' | 'committing';
} | null {
  return activeInvestigationTurns.get(investigationName) ?? null;
}

/** 请求取消指定 Investigation 的当前 turn；commit 阶段故意拒绝取消，避免留下半提交状态。 */
export function requestAbort(investigationName: string, turnId: string): boolean {
  const active = activeInvestigationTurns.get(investigationName);
  if (!active || active.turnId !== turnId || active.phase !== 'executing') return false;
  abortRequestedTurns.add(turnId);
  return true;
}

export interface AnswerSummary {
  answer: string;
  claimIds: string[];
  warnings: string[];
  unknowns: string[];
  followUpQuestions: string[];
  routeOptions: Array<{ id: string; title: string; reason: string; steps: string[] }>;
}

export async function answerQuestion(
  investigationName: string,
  question: string,
  onDelta?: (delta: string) => void,
  turnId?: string,
  onStatus?: (status: string) => void,
  options?: {
    selectedRoute?: JourneyRouteOption;
    selectedGuidance?: string;
    onReasoningDelta?: (delta: string) => void;
    /** 阶段小结完成后立即推送给主聊天区。 */
    onCheckpoint?: (checkpoint: AgentCheckpoint & { turnId: string; execution: number; createdAt: string }) => void;
  },
): Promise<AnswerSummary> {
  const selectedRoute = options?.selectedRoute;
  // Route 只是为了完成 Mission 选择的一个调查动作，不能覆盖用户原始任务。
  const effectiveQuestion = selectedRoute
    ? [
        '请执行用户选定的调查动作，并始终围绕本次 Mission：',
        selectedRoute.title,
      ].join('\n')
    : question;

  if (!turnId) turnId = nextId('turn');

  // API 层已有 Mission Gate；这里再做一次内部防线，防止其它调用方绕过 HTTP 直接执行 Agent。
  const missionPreflight = await loadInvestigation(investigationName);
  assertMissionGate(missionPreflight.mission);

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

  activeInvestigationTurns.set(investigationName, { turnId, phase: 'executing' });
  try {
    if (abortRequestedTurns.has(turnId)) throw new Error('Turn aborted.');

    const userMessage = saveConversationMessage({
      id: turnId + ':user',
      sessionName: investigationName,
      role: 'user',
      content: effectiveQuestion,
    });
    // SQLite 用于全文检索；Workspace 同步保留用户输入和 transcript，导出后仍能还原调查过程。
    await appendContextInput(investigationName, {
      kind: 'user_message',
      title: '用户问题',
      content: effectiveQuestion,
      source: 'conversation',
      important: false,
    });
    await appendTranscript(investigationName, 'user', effectiveQuestion);
    let inv = await loadInvestigation(investigationName);
    const control = await loadInvestigationControl(investigationName);

    const githubRepositories = [...new Set([
      ...control.research.githubRepositories,
      ...extractGitHubRepositories([
        inv.mission?.purpose,
        inv.mission?.expectedResult,
        inv.goal,
        inv.userPrompt,
        effectiveQuestion,
      ].filter(Boolean).join('\n')),
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
            details: { repository, error: error instanceof Error ? error.message : String(error) },
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
      details: { questionLength: effectiveQuestion.length, ...(selectedRoute ? { selectedRouteId: selectedRoute.id } : {}) },
    });

    const snapshot = await loadLatestSnapshot<DiscoverySnapshot>(investigationName);
    const contextQuestion = [
      inv.mission?.purpose,
      inv.mission?.expectedResult,
      effectiveQuestion,
    ].filter(Boolean).join('\n');
    const ctx = buildQuestionContext({
      question: contextQuestion,
      estate: snapshot?.estate ?? { nodes: [], edges: [] },
      hasSqlLineage: snapshot?.lineage != null,
      profiles: snapshot?.profiles ?? [],
      findings: inv.findings,
      evidence: inv.evidence,
      currentState: snapshot?.currentState ?? null,
      semanticAssets: snapshot?.semanticAssets ?? [],
      inventory: snapshot?.inventory ?? null,
    });
    const isContinuationRequest = /^(继续|接着|下一步|继续查|继续调查|往下查|然后呢)[。！!？?\s]*$/i.test(effectiveQuestion.trim());
    const priorConversation = isContinuationRequest
      ? listConversationMessages(investigationName, 8).filter((item) => item.id !== userMessage.id).slice(-6)
      : searchConversation(investigationName, effectiveQuestion, { limit: 6, beforeRowId: userMessage.rowId });
    const conversationText = priorConversation.length > 0
      ? [
          '## Relevant conversation history',
          isContinuationRequest
            ? 'This is a continuation request. Use the recent durable conversation below as context; it is conversation context, not evidence.'
            : 'The following earlier messages were retrieved by full-text search. Treat them as conversation context, not as evidence; current evidence and verified findings take precedence.',
          '',
          ...priorConversation.map((item) => `[${item.role}] ${item.content.length > 1200 ? item.content.slice(0, 1200) + '…' : item.content}`),
        ].join('\n')
      : '';
    const questionContextText = [ctx.text, conversationText].filter(Boolean).join('\n\n');
    const knowledge = await searchArchitectureKnowledge([
      inv.mission?.purpose,
      inv.mission?.expectedResult,
      inv.goal,
      effectiveQuestion,
    ].filter(Boolean).join('\n'), { workflow: inv.workflow, limit: 6 });
    const knowledgeText = renderArchitectureKnowledge(knowledge);
    const missionProgress = await buildMissionProgress(inv.name, inv.mission);
    const missionPrompt = buildMissionContractPrompt(inv.mission!, missionProgress ?? undefined);
    const prompt = buildQuestionPrompt({
      investigationName: inv.name,
      mission: inv.mission!,
      missionProgress: missionProgress ?? undefined,
      goal: inv.goal,
      scope: inv.scope,
      systems: inv.systems,
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
    if (selectedRoute) {
      await appendAuditEvent(investigationName, {
        actor: 'user',
        action: 'investigation.route.selected',
        summary: '用户选择了一个下一步调查动作。',
        configurationVersion: control.version,
        details: { routeId: selectedRoute.id, title: selectedRoute.title, steps: selectedRoute.steps },
      });
    }

    // Stage Gate 的基线必须建立在本次 Agent turn 真正开始前；这样每个自动续跑阶段
    // 都只能因为本阶段新增的 Evidence / Finding / Discovery 等真实结果而形成小结。
    let stageGateBaseline = snapshotInvestigationForStageGate(inv);
    let stageMissionProgressBaseline = missionProgress ?? {
      covered: 0,
      total: inv.mission!.deliverables.length,
      percent: 0,
      deliverables: inv.mission!.deliverables.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        required: item.required,
        status: 'not_started' as const,
        detail: '本轮开始前还没有形成可观察成果。',
      })),
    };

    const graphifyBefore = await getGraphifyRuntimeMetadata(workspaceRoot(inv.name));
    await appendAuditEvent(investigationName, {
      actor: 'system',
      action: 'investigation.graphify.runtime.started',
      summary: 'Captured Graphify runtime metadata before Agent execution.',
      configurationVersion: control.version,
      details: { runtime: graphifyBefore, platformCapabilities: control.agent.platformCapabilities },
    });

    let trajectoryWrite: Promise<void> = Promise.resolve();
    let sessionPersistence: Promise<void> = Promise.resolve();
    type TrajectoryCallbackEvent = NonNullable<AskInput['onTrajectory']> extends (event: infer T) => void ? T : never;
    const recordTrajectory = (event: TrajectoryCallbackEvent): void => {
      trajectoryWrite = trajectoryWrite
        .then(async () => {
          await appendTrajectoryEvent(investigationName, { ...event, turnId, details: event.details ?? {} });
        })
        .catch(() => undefined);
    };

    recordTrajectory({ type: 'user_input', name: '用户问题', status: 'info', details: { question } });

    const raw = await askCopilot({
      prompt,
      systemPrompt: [
        LEAD_SYSTEM_PROMPT,
        inv.workflow
          ? '当前工作方式：' + inv.workflow + '。它是当前 Investigation 的可执行工作流；Agent 必须围绕当前节点工作，并且只能使用工作流定义中存在的 outcome 推进。是否推进由本轮实际结果和证据决定，不能猜。'
          : '当前没有固定工作方式。根据目标、Evidence、未知项和最有价值的下一步自主推进；可以建议工作方式，但不能假定必须使用某一条路线。',
        knowledgeText,
        buildResearchConfigPrompt(control),
        control.agent.personality?.trim()
          ? [
              '## Assistant Soul / 人格',
              '这段人格只影响用户可见的表达方式，不改变调查方法、Evidence 规则、权限或 Workflow。',
              control.agent.personality.trim(),
            ].join('\n')
          : '',
        repositoryPrompt,
      ].filter(Boolean).join('\n\n'),
      ...(inv.copilotConfigurationVersion === control.version && inv.copilotSessionId ? { sessionId: inv.copilotSessionId } : {}),
      onSessionId: (sessionId) => {
        inv.copilotSessionId = sessionId;
        inv.copilotConfigurationVersion = control.version;
        // onSessionId 本身是同步回调；把实际写盘串起来，确保下一轮真的可以复用 Session。
        sessionPersistence = sessionPersistence
          .then(() => setCopilotSessionId(investigationName, sessionId, control.version))
          .catch(() => undefined);
      },
      workingDirectory: workspaceRoot(inv.name),
      model: control.agent.model,
      ...(control.agent.autoTier ? { autoTier: control.agent.autoTier } : {}),
      ...(inv.workflow ? { workflowSkill: inv.workflow } : {}),
      platformCapabilities: control.agent.platformCapabilities,
      permissionMode: control.agent.permissionMode,
      autoContinuationTurns: control.agent.autoContinuationTurns,
      mcpServers: toCopilotMcpServers(control) as NonNullable<Parameters<typeof askCopilot>[0]['mcpServers']>,
      ...(onDelta ? { onDelta } : {}),
      ...(onStatus ? { onStatus } : {}),
      onTrajectory: recordTrajectory,
      onStageResult: async ({ content, execution }) => {
        const latestStage = await loadInvestigation(investigationName);
        const stageEvidenceMap = new Map(latestStage.evidence.map((item) => [item.id, item]));
        const stageParsed = parseAgentAnswer(content, stageEvidenceMap);
        const stageAfter = snapshotInvestigationForStageGate(latestStage);
        const missionProgressAfterStage = await buildMissionProgress(
          investigationName,
          inv.mission!,
        );
        const stageGateInput = {
          execution,
          mission: inv.mission!,
          before: stageGateBaseline,
          after: stageAfter,
          missionProgressBefore: stageMissionProgressBaseline,
          missionProgressAfter: missionProgressAfterStage,
          parsed: {
            answer: stageParsed.answer,
            claims: stageParsed.claims,
            unknowns: stageParsed.unknowns,
            followUpQuestions: stageParsed.followUpQuestions,
            routeOptions: stageParsed.routeOptions,
          },
        };
        const gate = evaluateInvestigationStageGate(stageGateInput);

        // Gate 失败也要留下记录，方便轨迹明确告诉用户“为什么没有形成阶段成果”。
        recordTrajectory({
          type: 'stage_gate',
          name: gate.passed ? '阶段成果检查通过' : '阶段成果检查未通过',
          status: gate.passed ? 'completed' : 'info',
          details: {
            ...gate,
            missionProgress: missionProgressAfterStage,
            input: stageGateInput,
          },
        });

        // 只有 Script Gate 通过，才能生成 checkpoint。Agent 返回的 checkpoint 字段不参与决定。
        if (gate.passed) {
          const checkpoint = buildStageCheckpoint(stageGateInput, gate);
          const createdAt = new Date().toISOString();
          recordTrajectory({
            type: 'checkpoint',
            name: '阶段小结：' + checkpoint.title,
            status: 'completed',
            details: {
              execution,
              gatePassed: true,
              ...checkpoint,
            },
          });
          options?.onCheckpoint?.({
            ...checkpoint,
            turnId,
            execution,
            createdAt,
          });
          onStatus?.('阶段小结：' + checkpoint.title);
        }

        stageGateBaseline = stageAfter;
        stageMissionProgressBaseline = missionProgressAfterStage;
      },
      onBeforeWorkflowTransition: async ({ content }) => {
        // 每个阶段在 Gate 前先把本轮已经形成的、且通过 Evidence 校验的 intake 写入 context。
        const latest = await loadInvestigation(investigationName);
        const evidenceMap = new Map(latest.evidence.map((item) => [item.id, item]));
        const stageParsed = parseAgentAnswer(content, evidenceMap);
        if (stageParsed.intake) {
          await persistAgentIntake(investigationName, stageParsed.intake);
        }
      },
      ...(options?.onReasoningDelta ? { onReasoningDelta: options.onReasoningDelta } : {}),
      missionPrompt,
      refreshMissionPrompt: async () => {
        const latest = await loadInvestigation(investigationName);
        assertMissionGate(latest.mission);
        const progress = await buildMissionProgress(investigationName, latest.mission);
        return buildMissionContractPrompt(latest.mission, progress ?? undefined);
      },
      shouldContinueMission: async () => {
        const latest = await loadInvestigation(investigationName);
        assertMissionGate(latest.mission);
        const progress = await buildMissionProgress(investigationName, latest.mission);
        if (!progress) return true;
        return missionHasOpenDeliverables(progress);
      },
      turnId,
      shouldAbort: () => abortRequestedTurns.has(turnId),
    });
    await sessionPersistence;
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

    const activeAfterExecution = activeInvestigationTurns.get(investigationName);
    if (activeAfterExecution?.turnId === turnId) activeAfterExecution.phase = 'committing';
    abortRequestedTurns.delete(turnId);

    // Agent 在 Gate 前可能刚刚确认了 Scope；重新加载最新 Investigation，避免旧内存快照把新范围覆盖回去。
    inv = await loadInvestigation(investigationName);
    const evidenceAfterTools = new Map(inv.evidence.map((e) => [e.id, e]));
    const parsed = parseAgentAnswer(raw, evidenceAfterTools);
    if (parsed.warnings.length) {
      recordTrajectory({
        type: 'status',
        name: '结构化结果已自动修正',
        status: 'info',
        details: {
          warnings: parsed.warnings,
          droppedEvidenceRefs: parsed.droppedEvidenceRefs,
        },
      });
    }
    const claims = toClaims(parsed, () => nextId('c'));
    inv.claims.push(...claims);
    if (!inv.questions.includes(effectiveQuestion)) inv.questions.push(effectiveQuestion);
    const currentUnknowns = [...new Set(parsed.unknowns.map((item) => item.trim()).filter(Boolean).filter((item) => item.length <= 500))].slice(0, 12);
    inv.unknowns = currentUnknowns;

    const answer = parsed.answer || raw.slice(0, 2000);
    await saveInvestigation(inv);
    const journeyPlan = { version: 1 as const, source: 'agent' as const, generatedAt: new Date().toISOString(), turnId, routes: parsed.routeOptions };
    await updateInvestigationJourneyPlan(investigationName, journeyPlan, inv.workflow);
    await appendAuditEvent(investigationName, {
      actor: 'system',
      action: 'investigation.route.replanned',
      summary: 'Replanned optional investigation routes after the latest Agent turn.',
      configurationVersion: control.version,
      details: { turnId, workflow: inv.workflow, routeCount: parsed.routeOptions.length },
    });

    saveConversationMessage({ sessionName: investigationName, role: 'assistant', content: answer });
    await appendTranscript(investigationName, 'assistant', answer);
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
      details: { claimCount: claims.length, unknownCount: parsed.unknowns.length, routeCount: parsed.routeOptions.length, followUpCount: parsed.followUpQuestions.length },
    });
    await trajectoryWrite;
    finishConversationTurn(turnId, 'completed', JSON.stringify(result));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishConversationTurn(turnId, /abort/i.test(message) ? 'aborted' : 'failed', undefined, message);
    throw error;
  } finally {
    if (activeInvestigationTurns.get(investigationName)?.turnId === turnId) activeInvestigationTurns.delete(investigationName);
    abortRequestedTurns.delete(turnId);
  }
}