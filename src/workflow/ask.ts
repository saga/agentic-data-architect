/**
 * 问答 Workflow：把概率性 Agent 执行包在确定性的状态机和持久化边界内。
 *
 * 本文件的注释说明职责、输入输出、状态变化和关键并发边界，方便后续维护。
 */
import { randomUUID } from 'node:crypto';
import { askCopilot, hasActiveCopilotTurn, type AskInput } from '../agent/copilot.js';
import { askAgentWithFallback } from '../agent/runtime.js';
import { extractGitHubRepositories, researchGitHubRepository } from '../agent/research-github.js';
import { getGraphifyRuntimeMetadata } from '../adapters/graphify.js';
import { computeMissionFingerprint, computeScopeFingerprint } from '../investigation/artifact-provenance.js';
import { buildAssistantAnswerPrompt, buildAssistantCompanionPrompt, buildMissionContractPrompt, buildQuestionPrompt, LEAD_SYSTEM_PROMPT } from '../agent/prompts.js';
import { parseAgentAnswer, toClaims } from '../agent/result.js';
import { persistModernizationAgentResult } from './modernization.js';
import {
  reviewMissionAction,
  reviewMissionAlignment,
  reviewUnknownImpact,
  type MissionUnknownReview,
} from '../agent/jev-smart-func.js';
import { reviewMissionCompletion } from './mission-completion.js';
import type { AgentCheckpoint } from '../investigation/schemas.js';
import { buildQuestionContext } from '../analysis/context.js';
import { captureExplicitRelationshipMemories, getRelevantRelationshipMemories } from '../relationship/memory.js';
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
import { appendReasoningLog } from '../investigation/run-recorder.js';
import { appendContextInput, appendTranscript, setAgentSessionId, workspaceRoot } from '../investigation/workspace.js';
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
import { runReport } from './report.js';
import { saveInvestigationAnalysisArtifact } from '../investigation/analysis-artifact.js';

// 进程内的 Investigation 执行保留。phase=executing 时允许 Stop，进入 committing 后保护整个提交事务。
interface ActiveInvestigationTurn {
  turnId: string;
  phase: 'executing' | 'committing';
  startedAt: string;
  lastActivityAt: string;
  lastActivity: string;
}

const activeInvestigationTurns = new Map<string, ActiveInvestigationTurn>();
// 用户已经发出 Stop 的 turn 集合；只用于执行阶段的协作式取消检查。
const abortRequestedTurns = new Set<string>();

/** 返回当前进程真正持有的 active turn；不要用持久化 trajectory 状态代替这个 live 状态。 */
export function getActiveInvestigationTurn(investigationName: string): ActiveInvestigationTurn | null {
  return activeInvestigationTurns.get(investigationName) ?? null;
}

/** 返回当前进程持有的全部 active turn；Server shutdown 必须先停止这些 turn，再关闭 HTTP/DB。 */
export function listActiveInvestigationTurns(): Array<ActiveInvestigationTurn & { investigationName: string }> {
  return [...activeInvestigationTurns.entries()].map(([investigationName, turn]) => ({
    investigationName,
    ...turn,
  }));
}

/** 等待当前 turn 走完 abort/failure/completed finally；超时则让 Server 继续关闭，下一次启动仍可依靠 durable recovery。 */
export async function waitForInvestigationTurnsToFinish(timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (activeInvestigationTurns.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return activeInvestigationTurns.size === 0;
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
    onCheckpoint?: (checkpoint: AgentCheckpoint & { id: string; turnId: string; timestamp: string; execution: number }) => void;
    /** 长任务中偶尔显示给用户的 Soul 陪伴性提示，不写入持久化对话。 */
    onCompanionNote?: (note: string) => void;
  },
): Promise<AnswerSummary> {
  const selectedRoute = options?.selectedRoute;
  // Route 只是为了完成 Mission 选择的一个调查动作，不能覆盖用户原始任务。
  const effectiveQuestion = selectedRoute
    ? [
        question.trim(),
        '',
        '用户选择的当前调查动作：' + selectedRoute.title,
        selectedRoute.reason,
        ...selectedRoute.steps.map((step, index) => '步骤 ' + String(index + 1) + '：' + step),
        '请把这个动作作为当前子任务执行，但始终以本次 Mission 的任务目的和期望结果为最高优先级。',
      ].filter(Boolean).join('\n')
    : question;

  if (!turnId) turnId = nextId('turn');

  // API 层已有 Mission Gate；这里再做一次内部防线，防止其它调用方绕过 HTTP 直接执行 Agent。
  const missionPreflight = await loadInvestigation(investigationName);
  assertMissionGate(missionPreflight.mission);

  const reservedTurn = activeInvestigationTurns.get(investigationName);
  if (reservedTurn && reservedTurn.turnId !== turnId) {
    throw new Error('助手正在处理上一轮问题，请等它完成，或先点击“停止”。');
  }

  // Durable running 只表示“上一次执行没有完成”，不表示当前进程仍然有 Agent
  // 在执行。进程内 live turn 才是唯一可信的运行态；没有 live owner 的 running
  // turn 必须先回收，避免把一次新的“继续”永久卡在旧 turn 上。
  const persistedRunning = getRunningConversationTurn(investigationName);
  if (persistedRunning) {
    const liveOwner =
      activeInvestigationTurns.get(investigationName)?.turnId === persistedRunning.turnId
      || hasActiveCopilotTurn(persistedRunning.turnId);
    if (liveOwner) {
      throw new Error('助手正在处理上一轮问题，请等它完成，或先点击“停止”。');
    }

    if (persistedRunning.turnId !== turnId) {
      abortStaleConversationTurn(persistedRunning.turnId);
    }
    // 同一个 stale turnId 直接重新认领执行；新的 turnId 则在上面的回收后创建。
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
    // 到这里的 running turn 必然是本进程没有 live owner 的旧 turn。
    // 不再把 stale recovery 当成一次失败；允许当前请求继续执行并完成这个 turn。
  }

  if (turn.status === 'failed' || turn.status === 'aborted') {
    throw new Error('这次请求已经结束，不能重复执行，请重新发送问题。');
  }

  const turnStartedAt = new Date().toISOString();
  activeInvestigationTurns.set(investigationName, {
    turnId,
    phase: 'executing',
    startedAt: turnStartedAt,
    lastActivityAt: turnStartedAt,
    lastActivity: '正在准备调查上下文',
  });

  const updateLiveActivity = (activity: string): void => {
    const active = activeInvestigationTurns.get(investigationName);
    if (!active || active.turnId !== turnId) return;
    active.lastActivityAt = new Date().toISOString();
    active.lastActivity = activity;
  };
  let reasoningWrite: Promise<void> = Promise.resolve();
  const emitStatus = (status: string): void => {
    updateLiveActivity(status);
    onStatus?.(status);
  };
  let assistantDraft = '';
  let latestCompanionNote = '';
  const emitDelta = (delta: string): void => {
    updateLiveActivity('正在生成回答');
    assistantDraft += delta;
    onDelta?.(delta);
  };
  const emitReasoning = (delta: string, source = '执行当前调查'): void => {
    updateLiveActivity('正在分析问题');
    if (delta.trim()) {
      reasoningWrite = reasoningWrite.then(() => appendReasoningLog(investigationName, turnId, delta, source));
    }
    options?.onReasoningDelta?.(delta);
    emitStatus('助手正在分析你的问题，请稍候…');
  };

  const liveHeartbeat = setInterval(() => {
    const active = activeInvestigationTurns.get(investigationName);
    if (!active || active.turnId !== turnId) return;
    const elapsedMs = Date.now() - new Date(active.startedAt).getTime();
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const elapsed = minutes > 0
      ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
      : `${seconds} 秒`;
    emitStatus(`${active.lastActivity} · 已运行 ${elapsed}`);
  }, 15_000);
  liveHeartbeat.unref?.();
  let companionTimer: ReturnType<typeof setTimeout> | undefined;
  let trajectoryWrite: Promise<void> = Promise.resolve();
  let trajectoryWriteError: unknown;
  type TrajectoryCallbackEvent = NonNullable<AskInput['onTrajectory']> extends (event: infer T) => void ? T : never;
  const recordTrajectory = (event: TrajectoryCallbackEvent): void => {
    trajectoryWrite = trajectoryWrite
      .then(async () => {
        await appendTrajectoryEvent(investigationName, { ...event, turnId, details: event.details ?? {} });
      })
      .catch((error) => {
        trajectoryWriteError ??= error;
        emitStatus('调查过程记录保存失败，当前结果不会当成可靠的已保存结果。');
      });
  };
  let lastExecution = 0;
  try {
    if (abortRequestedTurns.has(turnId)) throw new Error('Turn aborted.');

    const userVisibleQuestion = selectedRoute
      ? '选择下一步：' + selectedRoute.title
      : question;
    const userMessage = saveConversationMessage({
      id: turnId + ':user',
      sessionName: investigationName,
      role: 'user',
      content: userVisibleQuestion,
    });
    // SQLite 用于全文检索；Workspace 同步保留用户输入和 transcript，导出后仍能还原调查过程。
    await appendContextInput(investigationName, {
      kind: 'user_message',
      title: '用户问题',
      content: userVisibleQuestion,
      source: 'conversation',
      important: false,
    });
    await appendTranscript(investigationName, 'user', userVisibleQuestion);
    let inv = await loadInvestigation(investigationName);
    const control = await loadInvestigationControl(investigationName);
    // Relationship Memory is updated only from explicit user instructions. It is deliberately
    // not added to the Task Agent prompt; it is presentation/continuity state only.
    await captureExplicitRelationshipMemories(userVisibleQuestion);
    const mission = inv.mission!;
    const turnMissionFingerprint = computeMissionFingerprint({
      mission,
      goal: mission.purpose,
    });
    let turnScopeFingerprint = computeScopeFingerprint(inv);

    const assertTurnStillCurrent = async (): Promise<Awaited<ReturnType<typeof loadInvestigation>>> => {
      const latest = await loadInvestigation(investigationName);
      const currentMissionFingerprint = computeMissionFingerprint(latest);
      const currentScopeFingerprint = computeScopeFingerprint(latest);
      if (currentMissionFingerprint !== turnMissionFingerprint) {
        throw new Error('任务目标在本轮执行期间发生了变化，当前结果不会覆盖新的任务。请重新开始这一轮调查。');
      }
      if (currentScopeFingerprint !== turnScopeFingerprint) {
        throw new Error('调查范围在本轮执行期间发生了变化，当前结果不会覆盖新的范围。请重新开始这一轮调查。');
      }
      return latest;
    };

    // Companion Note 是独立的人格层输出，不参与任务 Agent 的判断；只在长任务中偶尔出现。
    let companionMemories: Array<{ category: string; key: string; value: string }> = [];
    try {
      companionMemories = await getRelevantRelationshipMemories(userVisibleQuestion, 4);
    } catch (error) {
      // Relationship Memory 只影响表达方式；读取失败不影响正式调查，但必须留下诊断。
      console.warn('[relationship-memory] Failed to load optional memories.', {
        sessionName: investigationName,
        error,
      });
    }
    let companionNoteCount = 0;
    let lastCompanionNoteAt = 0;
    let companionNoteTask: Promise<void> = Promise.resolve();
    const requestCompanionNote = (activity: string, force = false): void => {
      const now = Date.now();
      const minimumFirstDelay = 12_000;
      const minimumGap = 45_000;
      if (!options?.onCompanionNote || companionNoteCount >= 2) return;
      if (!force && companionNoteCount === 0 && now - new Date(turnStartedAt).getTime() < minimumFirstDelay) return;
      if (!force && companionNoteCount > 0 && now - lastCompanionNoteAt < minimumGap) return;

      companionNoteCount += 1;
      lastCompanionNoteAt = now;
      companionNoteTask = companionNoteTask.then(async () => {
        if (abortRequestedTurns.has(turnId)) return;
        try {
          const note = await askAgentWithFallback({
            prompt: buildAssistantCompanionPrompt(control.agent.personality, activity, companionMemories),
            systemPrompt: '这是人格陪伴层。只生成一句自然、克制的陪伴性话语，不做任务分析，不调用工具，不汇报顶部状态，也不输出角色名或标题。',
            model: control.agent.model,
            modelCallName: '生成陪伴提示',
            workingDirectory: workspaceRoot(investigationName),
            onTrajectory: recordTrajectory,
            onReasoningDelta: (delta) => emitReasoning(delta, '生成陪伴提示'),
            purpose: 'review',
          });
          const value = note.trim();
          if (!abortRequestedTurns.has(turnId) && value && value.length <= 120) {
            latestCompanionNote = value;
            try {
              await appendTranscript(investigationName, 'assistant', value);
            } catch (logError) {
              console.error('[companion-note] Failed to persist visible companion note to transcript.', {
                sessionName: investigationName,
                turnId,
                error: logError,
              });
            }
            options.onCompanionNote?.(value);
          }
        } catch (error) {
          await appendAuditEvent(investigationName, {
            actor: 'system',
            action: 'assistant.companion_note_failed',
            summary: 'Soul 陪伴提示生成失败，不影响正式调查。',
            details: { error: error instanceof Error ? error.message : String(error) },
          });
        }
      }).catch((error) => {
        console.warn('[companion-note] Optional companion note failed.', {
          sessionName: investigationName,
          turnId,
          error,
        });
      });
    };

    companionTimer = setTimeout(() => {
      requestCompanionNote('长时间调查进行中，用户不需要跟随内部执行细节。');
    }, 12_000);
    companionTimer.unref?.();

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
      emitStatus('正在准备代码仓库并建立初始调查资料，请稍候…');
      for (const repository of githubRepositories) {
        const startedAt = Date.now();
        recordTrajectory({
          type: 'status',
          name: '准备代码仓库：' + repository,
          status: 'started',
          details: { operation: 'github_repository_bootstrap', repository },
        });
        try {
          await researchGitHubRepository(investigationName, repository);
          recordTrajectory({
            type: 'status',
            name: '代码仓库已准备好：' + repository,
            status: 'completed',
            durationMs: Math.max(0, Date.now() - startedAt),
            details: { operation: 'github_repository_bootstrap', repository },
          });
        } catch (error) {
          recordTrajectory({
            type: 'status',
            name: '代码仓库准备失败：' + repository,
            status: 'failed',
            durationMs: Math.max(0, Date.now() - startedAt),
            details: { operation: 'github_repository_bootstrap', repository, error: error instanceof Error ? error.message : String(error) },
          });
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
    const missionProgress = await buildMissionProgress(inv.name, mission);
    const missionPrompt = buildMissionContractPrompt(mission, missionProgress ?? undefined);
    const prompt = buildQuestionPrompt({
      investigationName: inv.name,
      mission,
      ...(missionProgress ? { missionProgress } : {}),
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
      total: mission.deliverables.length,
      percent: 0,
      deliverables: mission.deliverables.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        required: item.required,
        status: 'not_started' as const,
        detail: '本轮开始前还没有形成可观察成果。',
      })),
    };

    // Smart Alignment 只在本阶段确实产生状态变化时调用，避免每个空回答都多做一次模型判断。

    // 当前 turn 最近一阶段的 Unknown 结构化判断；Unknown 仍是状态，不是独立任务队列。
    let unknownReviewsForTurn: MissionUnknownReview[] = [];

    /** 把 Unknown 判断翻译成下一阶段真正可执行的指令。 */
    const buildUnknownContinuationGuidance = (): string => {
      if (!unknownReviewsForTurn.length) return '';
      const investigate = unknownReviewsForTurn
        .filter((item) => item.action === 'investigate')
        .map((item) => '- 自己继续查：' + item.unknown);
      const askUser = unknownReviewsForTurn
        .filter((item) => item.action === 'ask_user')
        .map((item) => '- 必须向用户确认：' + item.unknown);
      const ignored = unknownReviewsForTurn
        .filter((item) => item.action === 'ignore')
        .map((item) => '- 不要为了这个 Unknown 继续调查：' + item.unknown);

      return [
        '### Unknown 行动约束（服务器已做结构化判断）',
        ...investigate,
        ...askUser,
        ...ignored,
        askUser.length
          ? '存在需要用户输入的 Mission 相关 Unknown：下一阶段先用 ask_user 问清楚，不要继续猜测或绕开这个缺口。'
          : '',
        investigate.length
          ? '以上“自己继续查”的 Unknown 仍需 Agent 自行处理；不要把它写成 followUpQuestions 交给用户。'
          : '',
        ignored.length
          ? '以上“不需要继续调查”的 Unknown 只是状态记录，不能驱动下一步工具动作。'
          : '',
      ].filter(Boolean).join('\n');
    };

    const graphifyBefore = await getGraphifyRuntimeMetadata(workspaceRoot(inv.name));
    await appendAuditEvent(investigationName, {
      actor: 'system',
      action: 'investigation.graphify.runtime.started',
      summary: 'Captured Graphify runtime metadata before Agent execution.',
      configurationVersion: control.version,
      details: { runtime: graphifyBefore, platformCapabilities: control.agent.platformCapabilities },
    });

    let sessionPersistence: Promise<void> = Promise.resolve();
    let sessionPersistenceError: unknown;
    // The execution number belongs to the current turn, while each stage callback receives it locally.
    // Keep the last completed execution for the final analysis artifact.

    recordTrajectory({ type: 'user_input', name: '用户问题', status: 'info', details: { question } });

    const raw = await askAgentWithFallback({
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
      ...(inv.agentConfigurationVersion === control.version
        && inv.agentSessionRuntime === control.agent.runtime
        && inv.agentSessionId
        ? { sessionId: inv.agentSessionId }
        : inv.copilotConfigurationVersion === control.version && inv.copilotSessionId
          ? { sessionId: inv.copilotSessionId }
          : {}),
      runtime: control.agent.runtime,
      onSessionId: (sessionId) => {
        inv.agentSessionId = sessionId;
        inv.agentSessionRuntime = control.agent.runtime;
        inv.agentConfigurationVersion = control.version;
        // onSessionId 本身是同步回调；把实际写盘串起来，确保下一轮真的可以复用对应 Runtime Session。
        sessionPersistence = sessionPersistence
          .then(() => setAgentSessionId(
            investigationName,
            sessionId,
            control.version,
            control.agent.runtime,
          ))
          .catch((error) => {
            sessionPersistenceError ??= error;
            emitStatus('助手的继续执行信息没有保存成功，这一轮结果不会当成可以安全继续的结果。');
          });
      },
      workingDirectory: workspaceRoot(inv.name),
      onTrajectory: recordTrajectory,
      model: control.agent.model,
      modelCallName: '执行当前调查',
      ...(control.agent.autoTier ? { autoTier: control.agent.autoTier } : {}),
      ...(inv.workflow ? { workflowSkill: inv.workflow } : {}),
      platformCapabilities: control.agent.platformCapabilities,
      permissionMode: control.agent.permissionMode,
      autoContinuationTurns: control.agent.autoContinuationTurns,
      mcpServers: toCopilotMcpServers(control) as NonNullable<Parameters<typeof askCopilot>[0]['mcpServers']>,
      missionActionGate: async ({ execution, toolName, toolArgs }) => {
        const latest = await loadInvestigation(investigationName);
        assertMissionGate(latest.mission);
        const latestMission = latest.mission!;
        const progress = await buildMissionProgress(investigationName, latestMission);

        const review = await reviewMissionAction({
          mission: latestMission,
          candidate: { toolName, toolArgs },
          context: {
            execution,
            currentQuestion: effectiveQuestion,
            progress,
            unknownReviews: unknownReviewsForTurn,
            ignoredUnknowns: unknownReviewsForTurn
              .filter((item) => item.action === 'ignore')
              .map((item) => item.unknown),
          },
          model: control.agent.model,
          workingDirectory: workspaceRoot(inv.name),
          onTrajectory: recordTrajectory,
        });

        // 行动前检查属于 Mission 执行约束；语义判断不可用时宁可停下来，
        // 也不能在“没有目标校准”的情况下继续调用调查工具。
        if (!review) {
          recordTrajectory({
            type: 'status',
            name: '这一步暂时无法执行，已经暂停',
            status: 'failed',
            details: { execution, toolName },
          });
          return {
            allowed: false,
            reason: '助手暂时无法确认这一步是否有助于完成当前任务，因此先停在这里。',
          };
        }

        return review;
      },
      onDelta: emitDelta,
      onStatus: emitStatus,
      onStageResult: async ({ content, execution }) => {
        lastExecution = execution;
        const latestStage = await assertTurnStillCurrent();
        const stageEvidenceMap = new Map(latestStage.evidence.map((item) => [item.id, item]));
        const stageParsed = parseAgentAnswer(content, stageEvidenceMap);
        const stageAfter = snapshotInvestigationForStageGate(latestStage);
        const missionProgressAfterStage = (await buildMissionProgress(
          investigationName,
          mission,
        )) ?? stageMissionProgressBaseline;
        const hasRealStateChange =
          stageAfter.evidenceIds.length > stageGateBaseline.evidenceIds.length
          || stageAfter.findingIds.length > stageGateBaseline.findingIds.length
          || stageAfter.discoveryRunCount > stageGateBaseline.discoveryRunCount
          || stageAfter.scopeValidatedAt !== stageGateBaseline.scopeValidatedAt
          || missionProgressAfterStage.percent !== stageMissionProgressBaseline.percent;

        const missionUnknownReviews = stageParsed.unknowns.length
          ? await reviewUnknownImpact({
              mission,
              unknowns: stageParsed.unknowns,
              context: {
                execution,
                progressBefore: stageMissionProgressBaseline,
                progressAfter: missionProgressAfterStage,
                newEvidenceIds: stageAfter.evidenceIds.filter((id) => !stageGateBaseline.evidenceIds.includes(id)),
                newFindingIds: stageAfter.findingIds.filter((id) => !stageGateBaseline.findingIds.includes(id)),
              },
              model: control.agent.model,
              workingDirectory: workspaceRoot(inv.name),
              onTrajectory: recordTrajectory,
            })
          : [];

        unknownReviewsForTurn = missionUnknownReviews ?? [];
        recordTrajectory({
          type: 'status',
          name: 'Unknown 影响检查',
          status: missionUnknownReviews ? 'completed' : 'info',
          details: {
            execution,
            reviews: missionUnknownReviews ?? [],
            fallback: missionUnknownReviews === null,
          },
        });

        const missionAlignment = hasRealStateChange
          ? await reviewMissionAlignment({
              mission,
              candidate: [
                '本轮回答：' + stageParsed.answer,
                '本轮 Claims：' + JSON.stringify(stageParsed.claims),
                '本轮 Unknowns：' + JSON.stringify(stageParsed.unknowns),
              ].join('\\n'),
              context: {
                execution,
                workflow: inv.workflow,
                progressBefore: stageMissionProgressBaseline,
                progressAfter: missionProgressAfterStage,
                newEvidenceIds: stageAfter.evidenceIds.filter((id) => !stageGateBaseline.evidenceIds.includes(id)),
                newFindingIds: stageAfter.findingIds.filter((id) => !stageGateBaseline.findingIds.includes(id)),
              },
              model: control.agent.model,
              workingDirectory: workspaceRoot(inv.name),
              onTrajectory: recordTrajectory,
            })
          : null;

        const stageGateInput = {
          execution,
          mission,
          before: stageGateBaseline,
          // legacy-modernization 的结构化工作成果由 onBeforeWorkflowTransition 刚刚持久化；
          // 它本身就是本阶段真实成果，即使没有新增 Evidence/Finding 也不能被 Gate 忽略。
          persistedWorkProductChanged: Boolean(stageParsed.modernization),
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
          missionAlignment,
        };
        const gate = evaluateInvestigationStageGate(stageGateInput);

        // Agent 提交 workflow.completed 只是“完成申请”；真正完成 Mission 必须再经过 Completion Gate。
        if (stageParsed.workflow?.outcome === 'completed') {
          const completion = await reviewMissionCompletion({
            mission,
            progress: missionProgressAfterStage,
            resultSummary: {
              evidenceCount: latestStage.evidence.length,
              findingCount: latestStage.findings.length,
              claimCount: latestStage.claims.length,
              unknowns: missionUnknownReviews
                ? missionUnknownReviews.filter((item) => item.action !== 'ignore').map((item) => item.unknown)
                : stageParsed.unknowns,
            },
            unknownReviews: missionUnknownReviews ?? undefined,
            model: control.agent.model,
            workingDirectory: workspaceRoot(inv.name),
            onTrajectory: recordTrajectory,
          });
          recordTrajectory({
            type: 'status',
            name: completion.completed ? '已确认可以结束这次调查' : '还不能结束这次调查',
            status: completion.completed ? 'completed' : 'info',
            details: { execution, completion },
          });

          if (!completion.completed) {
            return {
              passed: false,
              error: '还不能结束这次调查：' + completion.reason,
            };
          }
        }

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
          // SSE 和 trajectory 共用同一份 checkpoint 事件体：id/timestamp 在这里生成一次，
          // 两边看到的是同一条记录。字段必须贴着 TrajectoryCheckpointSchema，
          // 多一个（createdAt/gatePassed）少一个（id/timestamp）都会被 strict schema 拦下。
          // gate 通过本身就是 gatePassed=true，不需要再写一个冗余字段。
          const checkpointEvent = {
            id: randomUUID(),
            turnId,
            timestamp: new Date().toISOString(),
            execution,
            ...checkpoint,
          };
          recordTrajectory({
            type: 'checkpoint',
            name: '阶段小结：' + checkpoint.title,
            status: 'completed',
            details: {
              execution: checkpointEvent.execution,
              title: checkpointEvent.title,
              summary: checkpointEvent.summary,
              confirmed: checkpointEvent.confirmed,
              evidenceIds: checkpointEvent.evidenceIds,
              unknowns: checkpointEvent.unknowns,
              ...(checkpointEvent.nextStep !== undefined ? { nextStep: checkpointEvent.nextStep } : {}),
            },
          });
          options?.onCheckpoint?.(checkpointEvent);
          emitStatus('阶段小结：' + checkpoint.title);
          requestCompanionNote('阶段成果已经形成，接下来继续把剩余问题处理干净。');
        }

        stageGateBaseline = stageAfter;
        stageMissionProgressBaseline = missionProgressAfterStage;

        return gate.passed
          ? { passed: true }
          : {
              passed: false,
              error: 'Stage Gate 未通过：'
                + gate.checks.filter((item) => !item.passed).map((item) => item.name + '：' + item.detail).join('；'),
            };
      },
      onBeforeWorkflowTransition: async ({ content }) => {
        // Gate 前先确认本轮仍属于同一个 Mission / Scope，避免旧 turn 把新任务的状态写回去。
        let latest = await assertTurnStillCurrent();
        const evidenceMap = new Map(latest.evidence.map((item) => [item.id, item]));
        const stageParsed = parseAgentAnswer(content, evidenceMap);
        if (stageParsed.intake) {
          await persistAgentIntake(investigationName, stageParsed.intake);
          latest = await loadInvestigation(investigationName);
          turnScopeFingerprint = computeScopeFingerprint(latest);
          // Scope 更新属于本轮自己完成的正式范围整理，更新本轮提交基线。
          if (computeMissionFingerprint(latest) !== turnMissionFingerprint) {
            throw new Error('调查任务在本轮范围整理期间发生了变化，当前结果不会继续写入。请重新开始这一轮调查。');
          }
        }
        if (latest.workflow === 'legacy-modernization' && stageParsed.modernization) {
          // 先保存结构化 work product，Stage Gate 才能用真实状态判断交付物是否前进。
          await persistModernizationAgentResult(investigationName, stageParsed.modernization);
        }
      },
      onReasoningDelta: emitReasoning,
      missionPrompt,
      refreshMissionPrompt: async () => {
        const latest = await loadInvestigation(investigationName);
        assertMissionGate(latest.mission);
        const latestMission = latest.mission!;
        const progress = await buildMissionProgress(investigationName, latestMission);
        return [
          buildMissionContractPrompt(latestMission, progress ?? undefined),
          buildUnknownContinuationGuidance(),
        ].filter(Boolean).join('\n\n');
      },
      shouldContinueMission: async () => {
        const latest = await loadInvestigation(investigationName);
        assertMissionGate(latest.mission);
        const latestMission = latest.mission!;
        const progress = await buildMissionProgress(investigationName, latestMission);
        if (!progress) return true;

        // 先执行确定性的结构判断；有明确未完成交付物，不能提前停止。
        if (missionHasOpenDeliverables(progress)) return true;

        // Unknown 只有在结构化判断明确要求“自己查 / 问用户”时才驱动继续。
        if (unknownReviewsForTurn.some((item) => item.action === 'investigate' || item.action === 'ask_user')) {
          return true;
        }

        // 必需交付物都没有可量化缺口后，最终是否停止交给 Completion Gate。
        const completion = await reviewMissionCompletion({
          mission: latestMission,
          progress,
          resultSummary: {
            evidenceCount: latest.evidence.length,
            findingCount: latest.findings.length,
            claimCount: latest.claims.length,
            unknowns: unknownReviewsForTurn.length
              ? unknownReviewsForTurn.filter((item) => item.action !== 'ignore').map((item) => item.unknown)
              : latest.unknowns,
          },
          unknownReviews: unknownReviewsForTurn,
          model: control.agent.model,
          workingDirectory: workspaceRoot(inv.name),
          onTrajectory: recordTrajectory,
        });
        recordTrajectory({
          type: 'status',
          name: completion.completed ? 'Mission Completion 检查通过' : 'Mission Completion 检查未通过',
          status: completion.completed ? 'completed' : 'info',
          details: { completion },
        });

        return !completion.completed;
      },
      turnId,
      shouldAbort: () => abortRequestedTurns.has(turnId),
    });
    await reasoningWrite;
    await sessionPersistence;
    await trajectoryWrite;
    if (sessionPersistenceError) {
      throw new Error(
        '本轮结果已经生成，但继续执行所需的会话信息没有保存成功，请重新执行。'
        + '（' + (sessionPersistenceError instanceof Error ? sessionPersistenceError.message : String(sessionPersistenceError)) + '）',
      );
    }
    if (trajectoryWriteError) {
      throw new Error(
        '本轮调查过程没有完整保存，因此这次结果不能作为可靠结果返回。'
        + '（' + (trajectoryWriteError instanceof Error ? trajectoryWriteError.message : String(trajectoryWriteError)) + '）',
      );
    }
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
    if (activeAfterExecution?.turnId === turnId) {
      activeAfterExecution.phase = 'committing';
      activeAfterExecution.lastActivityAt = new Date().toISOString();
      activeAfterExecution.lastActivity = '正在保存分析结果';
    }
    abortRequestedTurns.delete(turnId);

    // Agent 在 Gate 前可能刚刚确认了 Scope；但最终提交前仍必须再次确认 Mission / Scope 没有被其它操作改动。
    inv = await assertTurnStillCurrent();
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
    // 只保留仍会影响 Mission 的 Unknown；无关 Unknown 不再作为后续调查入口。
    inv.unknowns = unknownReviewsForTurn.length
      ? [...new Set(unknownReviewsForTurn.filter((item) => item.affectsMission).map((item) => item.unknown))].slice(0, 12)
      : currentUnknowns;

    const taskAnswer = parsed.answer || raw.slice(0, 2000);
    let answer = taskAnswer;
    const relationshipMemories = await getRelevantRelationshipMemories(effectiveQuestion + '\n' + taskAnswer);
    if (control.agent.personality.trim() || relationshipMemories.length > 0) {
      try {
        const rendered = await askAgentWithFallback({
          prompt: buildAssistantAnswerPrompt(control.agent.personality, taskAnswer, relationshipMemories),
          modelCallName: '整理最终回答',
          systemPrompt: [
            '你是最终回答渲染器，不是任务 Agent。',
            '只负责表达，不得调查、调用工具、重新判断任务或修改事实、结论、不确定性和建议。',
            '输出直接展示给用户。不要加角色名或标题，不要提 Mission、阶段、覆盖率、unknown、Agent、Workflow、Gate、Evidence 或内部调查过程，除非这些词本身就是用户必须知道的业务内容。',
            '不要写“重新对着 Mission”“这一轮”“阶段性成果”“为了把覆盖率做满”等自我过程叙述。',
            '直接从结论和事实开始，像熟悉业务的同事正常说话；短而自然，不要公文腔，不要模板腔。',
          ].join('\\n'),
          model: control.agent.model,
          workingDirectory: workspaceRoot(inv.name),
          onTrajectory: recordTrajectory,
          onReasoningDelta: (delta) => emitReasoning(delta, '整理最终回答'),
          purpose: 'review',
        });
        if (rendered.trim()) answer = rendered.trim();
      } catch (error) {
        await appendAuditEvent(investigationName, {
          actor: 'system',
          action: 'assistant.persona.render_failed',
          summary: '人格渲染失败，保留任务 Agent 原始答案。',
          configurationVersion: control.version,
          details: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    await saveInvestigation(inv);

    await saveInvestigationAnalysisArtifact(investigationName, {
      turnId,
      execution: lastExecution,
      question: effectiveQuestion,
      purpose: mission.purpose,
      expectedResult: mission.expectedResult,
      answer: taskAnswer,
      evidenceIds: [...new Set(claims.flatMap((claim) => claim.evidenceIds))],
      claimSummaries: claims.map((claim) => claim.claim.split('\n')[0].trim()).filter(Boolean),
      unknowns: currentUnknowns,
      nextSteps: [
        ...parsed.followUpQuestions.slice(0, 3),
        ...parsed.routeOptions.slice(0, 2).map((route) => route.title + '：' + route.steps[0]),
      ],
    });

    const missionProgressAtEnd = await buildMissionProgress(investigationName, mission);
    if (missionProgressAtEnd && !missionHasOpenDeliverables(missionProgressAtEnd)) {
      try {
        const completion = await reviewMissionCompletion({
          mission,
          progress: missionProgressAtEnd,
          resultSummary: {
            evidenceCount: inv.evidence.length,
            findingCount: inv.findings.length,
            claimCount: inv.claims.length,
            unknowns: inv.unknowns,
          },
          unknownReviews: unknownReviewsForTurn,
          model: control.agent.model,
          workingDirectory: workspaceRoot(inv.name),
          onTrajectory: recordTrajectory,
        });
        if (completion.completed) {
          try {
            await runReport(investigationName, { onTrajectory: recordTrajectory });
            await appendAuditEvent(investigationName, {
              actor: 'system',
              action: 'investigation.report.generated',
              summary: '调查完成后已生成最终阅读报告。',
              configurationVersion: control.version,
              details: { turnId },
            });
          } catch (error) {
            await appendAuditEvent(investigationName, {
              actor: 'system',
              action: 'investigation.report.generation_failed',
              summary: '调查结果已经保存，但最终阅读报告暂时没有通过生成或审核。',
              configurationVersion: control.version,
              details: { turnId, error: error instanceof Error ? error.message : String(error) },
            });
          }
        }
      } catch (error) {
        await appendAuditEvent(investigationName, {
          actor: 'system',
          action: 'investigation.report.completion_check_failed',
          summary: '调查结果已经保存，但暂时无法确认是否应该生成最终阅读报告。',
          configurationVersion: control.version,
          details: { turnId, error: error instanceof Error ? error.message : String(error) },
        });
      }
    }

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
    if (trajectoryWriteError) {
      throw new Error(
        '本轮调查过程没有完整保存，因此这次结果不能作为可靠结果返回。'
        + '（' + (trajectoryWriteError instanceof Error ? trajectoryWriteError.message : String(trajectoryWriteError)) + '）',
      );
    }
    finishConversationTurn(turnId, 'completed', JSON.stringify(result));
    return result;
  } catch (error) {
    await reasoningWrite;
    const message = error instanceof Error ? error.message : String(error);
    const activeFailure = activeInvestigationTurns.get(investigationName);
    const detailedError = [
      message,
      error instanceof Error && error.name && error.name !== 'Error' ? '错误类型：' + error.name : '',
      error instanceof Error && error.stack && error.stack !== message ? 'Stack:\n' + error.stack : '',
    ].filter(Boolean).join('\n\n');
    const failureDetails = {
      error: detailedError,
      elapsedMs: Math.max(0, Date.now() - new Date(turnStartedAt).getTime()),
      ...(activeFailure?.lastActivityAt ? { lastActivityAt: activeFailure.lastActivityAt } : {}),
      ...(activeFailure?.lastActivity ? { lastActivity: activeFailure.lastActivity } : {}),
      pendingTools: 0,
      pendingPermissions: 0,
      pendingUserInputs: 0,
      assistantTurnEnded: false,
      sessionIdleObserved: false,
      modelCallCount: 0,
    };
    recordTrajectory({
      type: 'error',
      name: '这次调查没有完成：' + message,
      status: 'failed',
      details: failureDetails,
    });
    await trajectoryWrite;
    try {
      await appendAuditEvent(investigationName, {
        actor: 'system',
        action: 'investigation.execution_failed',
        summary: '这次调查没有完成，详细错误已经保存到执行记录。',
        details: {
          turnId,
          execution: lastExecution,
          ...failureDetails,
        },
      });
    } catch (diagnosticError) {
      console.error('[investigation] Failed to persist execution failure audit; original error is preserved.', {
        sessionName: investigationName,
        turnId,
        error: diagnosticError,
      });
    }
    const failureContent = [
      latestCompanionNote.trim(),
      assistantDraft.trim(),
      '这次调查没有完成，我已经保留刚才得到的内容。你可以继续提问。',
    ].filter(Boolean).join('\n\n');
    try {
      saveConversationMessage({
        id: turnId + ':assistant:failure',
        sessionName: investigationName,
        role: 'assistant',
        content: failureContent,
      });
      await appendTranscript(investigationName, 'assistant', failureContent);
    } catch (persistenceError) {
      console.error('[investigation] Failed to persist assistant failure message; the original execution error is preserved.', {
        sessionName: investigationName,
        turnId,
        error: persistenceError,
      });
      recordTrajectory({
        type: 'status',
        name: '这次调查没有完成，而且失败提示没有保存成功',
        status: 'failed',
        details: {
          persistenceError: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
        },
      });
    }
    finishConversationTurn(turnId, /abort/i.test(message) ? 'aborted' : 'failed', undefined, message);
    throw error;
  } finally {
    if (companionTimer) clearTimeout(companionTimer);
    clearInterval(liveHeartbeat);
    if (activeInvestigationTurns.get(investigationName)?.turnId === turnId) activeInvestigationTurns.delete(investigationName);
    abortRequestedTurns.delete(turnId);
  }
}
