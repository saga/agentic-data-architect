import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import type { UploadFile } from 'antd';
import { ApiRequestError, consumeSse, getJson, request } from './api';
import { workflowOptions } from './workflow-options';
import {
  AnswerSummarySchema,
  ControlResponseSchema,
  GlobalConfigurationResponseSchema,
  CreateSessionResponseSchema,
  ExecutionStatusSchema,
  FileUploadResponseSchema,
  MissionDraftSchema,
  MissionUpdateResponseSchema,
  ModelsResponseSchema,
  PermissionsResponseSchema,
  SessionsResponseSchema,
  SessionDataSchema,
  SimpleOkResponseSchema,
  UserInputsResponseSchema,
  WorkflowSnapshotSchema,
  WorkflowContextResponseSchema,
} from '../../../src/api/contracts.js';
import type { AnswerSummaryContract } from '../../../src/api/contracts.js';
import { buildInvestigationPath, parseRoute, type PageId } from './routing';
import {
  type AutoTier,
  type CopilotModelOption,
  type ExecutionStatus,
  type InvestigationCheckpoint,
  type GlobalConfiguration,
  type InvestigationControl,
  type JourneyState,
  type Message,
  type MissionContract,
  type MissionDraft,
  type PendingPermission,
  type PendingUserInput,
  type SessionContext,
  type SessionData,
  type SessionSummary,
  type WorkflowId,
} from './types';

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0
    ? `${seconds} 秒`
    : `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
}

export function useInvestigationController() {
  const routeSession = () => parseRoute()?.session;
  const [page, setPage] = useState<PageId>(() => parseRoute()?.page ?? 'chat');
  const navigatePage = (nextPage: PageId) => {
    if (!active) return;
    const nextPath = buildInvestigationPath(active, nextPage);
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ session: active, page: nextPage }, '', nextPath);
    }
    setPage(nextPage);
  };

  const navigateToSession = (key: string, replace = false) => {
    const nextPath = buildInvestigationPath(key);
    if (window.location.pathname !== nextPath) {
      if (replace) window.history.replaceState({ session: key, page: 'chat' }, '', nextPath);
      else window.history.pushState({ session: key, page: 'chat' }, '', nextPath);
    }
    setPage('chat');
    setActive(key);
  };

  const { message: toast } = AntApp.useApp();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [active, setActive] = useState<string>();
  const [current, setCurrent] = useState<SessionData>();
  const [globalConfiguration, setGlobalConfiguration] = useState<GlobalConfiguration>();
  const [availableModels, setAvailableModels] = useState<CopilotModelOption[]>([]);
  const [modelSaving, setModelSaving] = useState(false);
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [assistantCompanionNote, setAssistantCompanionNote] = useState('');
  const assistantCompanionNoteRef = useRef('');
  const [reasoningByMessage, setReasoningByMessage] = useState<Record<string, string>>({});
  // Server reload 期间保留尚未被服务器确认的用户消息，避免异步 session load 覆盖本地乐观更新。
  const pendingOutgoingMessagesRef = useRef<Record<string, Message>>({});
  // 每条回复固定一个随机头像。分配结果同时持久化到浏览器，避免上传新头像或刷新页面后旧消息全部换头像。
  const [assistantAvatarByMessage, setAssistantAvatarByMessage] = useState<Record<string, string>>({});
  useEffect(() => {
    const sessionName = current?.context.name;
    const configuredSources = current?.control.agent.avatarSources?.map((item) => item.src).filter(Boolean) ?? [];
    const avatarPaths = configuredSources.length > 0
      ? configuredSources
      : current?.control.agent.avatarPaths?.filter(Boolean) ?? [];
    if (!sessionName || !avatarPaths.length) {
      setAssistantAvatarByMessage({});
      return;
    }

    const storageKey = `ada.avatarAssignments.${sessionName}`;
    let stored: Record<string, string> = {};
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          stored = parsed as Record<string, string>;
        }
      }
    } catch {
      // 本地存储不可用时仍然允许当前页面正常显示头像。
    }

    // 删除已经从配置中移除的头像引用，否则旧消息会继续请求失效 URL。
    const allowed = new Set(avatarPaths);
    const next: Record<string, string> = Object.fromEntries(
      Object.entries(stored).filter(([, source]) => allowed.has(source)),
    );

    const assistantMessages = (current?.messages ?? []).filter((message) => message.role === 'assistant');
    for (const message of assistantMessages) {
      if (!next[message.id]) {
        next[message.id] = avatarPaths[Math.floor(Math.random() * avatarPaths.length)];
      }
    }

    setAssistantAvatarByMessage(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // 不影响聊天。
    }
  }, [current?.context.name, current?.control.agent.avatarPath, current?.control.agent.avatarPaths, current?.control.agent.avatarSources, current?.messages]);



  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus>({ state: 'idle', running: false, turnId: null, phase: null, startedAt: null, lastActivityAt: null, lastActivity: null, pendingPermissionCount: 0, pendingUserInputCount: 0 });
  const [turnStatus, setTurnStatus] = useState('助手正在处理你的问题，请稍候…');
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [pendingUserInputs, setPendingUserInputs] = useState<PendingUserInput[]>([]);
  const [userInputDrafts, setUserInputDrafts] = useState<Record<string, string>>({});
  const [streamingAnswer, setStreamingAnswer] = useState<{ key: string; content: string }>();
  const [nextGuidance, setNextGuidance] = useState<string[]>([]);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionCreating, setNewSessionCreating] = useState(false);
  const NEW_SESSION_GOAL_SAMPLE = '研究现有项目的数据架构设计，调查data model，data source，vendor input方式，重要的数据转换逻辑';
  const NEW_SESSION_EXPECTED_RESULT_SAMPLE = '生成一份深入浅出，详细的分析报告，分析报告应该包含mermaid形式的架构图、数据流图等等';
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionRuntime, setNewSessionRuntime] = useState<AgentRuntime>('copilot-sdk');
  const [newSessionWorkflow, setNewSessionWorkflow] = useState<WorkflowId | null>(null);
  const [newSessionGoal, setNewSessionGoal] = useState(NEW_SESSION_GOAL_SAMPLE);
  const [newSessionExpectedResult, setNewSessionExpectedResult] = useState(NEW_SESSION_EXPECTED_RESULT_SAMPLE);
  const [workflowSaving, setWorkflowSaving] = useState(false);
  // undefined = 尚未选择；'' = 明确选择“自主调查”；WorkflowId = 选择具体工作方式。
  const [workflowTarget, setWorkflowTarget] = useState<WorkflowId | '' | undefined>(undefined);
  const [workflowConfirmText, setWorkflowConfirmText] = useState('');
  const [unknownsOpen, setUnknownsOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [journey, setJourney] = useState<JourneyState>();
  const [missionOpen, setMissionOpen] = useState(false);
  const [missionDraft, setMissionDraft] = useState<MissionDraft>({
    purpose: '',
    expectedResult: '',
    deliverableIds: [],
  });
  const [missionSaving, setMissionSaving] = useState(false);
  const [missionError, setMissionError] = useState<string>();
  const [pendingMissionMessage, setPendingMissionMessage] = useState<string>();
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachments, setAttachments] = useState<UploadFile[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<Set<string>>(new Set());
  const [leftWidth, setLeftWidth] = useState(270);
  const [rightWidth, setRightWidth] = useState(350);
  const [resizing, setResizing] = useState<'left' | 'right' | null>(null);
  const [showLeftTip, setShowLeftTip] = useState(() => {
    try { return localStorage.getItem('ada.tip.left') !== 'dismissed'; } catch { return true; }
  });
  const activeRef = useRef<string | undefined>(undefined);
  // React state 更新在下一次 render 才可见；仅靠 newSessionCreating state 防不住同一事件循环内的快速双击。
  // 这个 ref 是即时互斥锁，保证一次“确定”只会进入一条创建链。
  const newSessionCreatingRef = useRef(false);
  const loadRequestRef = useRef(0);
  /** 新建调查时临时保存用户已经写好的 Mission 草稿，等 Session 加载完成后交给 Mission 确认窗口。 */
  const pendingInitialMissionDraftRef = useRef<MissionDraft | undefined>(undefined);
  /** 新建调查已经自动确认 Mission 后，等 Session 页面加载完成再启动第一轮 Agent。 */
  const pendingInitialAutoStartRef = useRef<{ sessionName: string; message: string } | undefined>(undefined);
  /** Mission Gate 暂时拦住的用户消息，对应的 turnId 要在确认 Mission 后原样重试。 */
  const [pendingMissionTurnId, setPendingMissionTurnId] = useState<string>();
  /** 新建调查 Mission 清晰度校验失败时，等 Session 加载完成再展示具体原因。 */
  const pendingInitialMissionErrorRef = useRef<string | undefined>(undefined);
  const activeTurnRef = useRef<{ key: string; turnId: string; controller: AbortController } | undefined>(undefined);
  const stopRequestedTurnRef = useRef<string | undefined>(undefined);
  const executionStatusRef = useRef<ExecutionStatus>({
    state: 'idle',
    running: false,
    turnId: null,
    phase: null,
    startedAt: null,
    lastActivityAt: null,
    lastActivity: null,
    pendingPermissionCount: 0,
    pendingUserInputCount: 0,
  });

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const reloadSessions = async (selectLatest = true) => {
    const result = await getJson('/api/sessions', SessionsResponseSchema);
    setSessions(result.sessions);
    const routed = routeSession();
    const routedExists = routed && result.sessions.some((session) => session.key === routed);

    if (routedExists && routed) {
      setActive(routed);
      return;
    }

    if (selectLatest && !active && result.sessions[0]) {
      navigateToSession(result.sessions[0].key, true);
    }
  };

  const loadSession = async (key: string, clearFirst = false): Promise<SessionData | undefined> => {
    const requestId = ++loadRequestRef.current;
    setError(undefined);
    if (clearFirst) {
      setCurrent(undefined);
      setValue('');
      setNextGuidance([]);
      setJourney(undefined);
      setAttachmentsOpen(false);
    }
    const result = await getJson(`/api/sessions/${encodeURIComponent(key)}`, SessionDataSchema);
    const workflowSnapshot = result.context.workflow
      ? await getJson(
          `/api/sessions/${encodeURIComponent(key)}/workflow`,
          WorkflowSnapshotSchema,
        )
      : undefined;
    if (requestId !== loadRequestRef.current || key !== activeRef.current) return;

    setCurrent((existing) => {
      const pending = pendingOutgoingMessagesRef.current[key];
      const serverMessages = result.messages;
      const serverIds = new Set(serverMessages.map((message) => message.id));
      if (pending && serverIds.has(pending.id)) {
        delete pendingOutgoingMessagesRef.current[key];
      }

      const preservedLocal = existing?.context.name === key
        ? existing.messages.filter((message) => !serverIds.has(message.id))
        : [];
      const preservedPending = pending && !serverIds.has(pending.id) ? [pending] : [];
      const mergedMessages = [...serverMessages, ...preservedLocal, ...preservedPending]
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

      // Conversation is durable on the server; this merge only protects messages that
      // are already visible locally but have not appeared in the latest HTTP snapshot.
      return mergedMessages.length === serverMessages.length
        ? result
        : { ...result, messages: mergedMessages };
    });
    setJourney(
      workflowSnapshot
        ? { ...workflowSnapshot.state, execution: workflowSnapshot.execution }
        : undefined,
    );

    // Mission 是正式调查的前置条件。旧 Session 如果还没有 Mission，
    // 首次打开就直接让用户确认，而不是先允许 Agent 自己猜目标。
    if (!result.context.mission) {
      const initialDraft = pendingInitialMissionDraftRef.current;
      if (initialDraft) {
        setMissionDraft(initialDraft);
        pendingInitialMissionDraftRef.current = undefined;
      } else {
        setMissionDraft({
          purpose: result.context.goal || result.context.userPrompt || '',
          expectedResult: '',
          deliverableIds: [],
        });
      }
      const initialMissionError = pendingInitialMissionErrorRef.current;
      if (initialMissionError) {
        setMissionError(initialMissionError);
        pendingInitialMissionErrorRef.current = undefined;
      }
      setMissionOpen(true);
    }

    const initialAutoStart = pendingInitialAutoStartRef.current;
    const initialConfigurationSaved = result.control.version > 1;
    const initialStartReady = Boolean(result.context.mission && initialConfigurationSaved);
    if (initialAutoStart?.sessionName === key) {
      if (initialStartReady) {
        pendingInitialAutoStartRef.current = undefined;
        // 等配置保存后的 render 完成后再调用 send，确保 send 使用的是最新 active Session。
        window.setTimeout(() => { void send(initialAutoStart.message); }, 0);
      } else if (result.context.mission) {
        // 保留分支结构；Mission 已存在时上面的条件会直接启动。
        setTurnStatus('调查已准备好，正在开始执行。');
      }
    }

    const existing = result.context.inputs
      .filter((input) => input.kind === 'document')
      .map((input) => ({
        uid: input.id,
        name: input.title,
        status: 'done' as const,
        size: input.sizeBytes,
        type: input.mimeType,
      }));
    setAttachments(existing);
    return result;
  };

  /** 查询当前 Node.js 进程的真实执行状态；不使用 trajectory 推断 live state。 */
  const loadExecutionStatus = async (key: string): Promise<ExecutionStatus> => {
    try {
      const status = await getJson(
        `/api/sessions/${encodeURIComponent(key)}/execution`,
        ExecutionStatusSchema,
      );
      const previous = executionStatusRef.current;
      executionStatusRef.current = status;

      if (key === activeRef.current) {
        setExecutionStatus(status);
        if (status.running) {
          setLoading(true);
          setStreamingAnswer((currentAnswer) =>
            currentAnswer?.key === key ? currentAnswer : { key, content: '' },
          );
          setTurnStatus(executionStatusText(status));
        } else if (previous.running && previous.turnId && !status.running) {
          setLoading(false);
          if (activeTurnRef.current?.turnId === previous.turnId) activeTurnRef.current = undefined;
          setStreamingAnswer((currentAnswer) =>
            currentAnswer?.key === key ? undefined : currentAnswer,
          );
          setTurnStatus('正在更新最新对话…');
          await loadSession(key);
          setTurnStatus('可以继续提问');
        }
      }

      return status;
    } catch {
      // Transport failure is not an execution-state transition.
      return executionStatusRef.current;
    }
  };
  /** 用统一的 live execution state 生成顶部状态文字。 */
  const executionStatusText = (status: ExecutionStatus): string => {
    switch (status.state) {
      case 'running': {
        const activity = status.lastActivity?.trim() || '助手正在执行调查';
        const startedAt = status.startedAt ? new Date(status.startedAt).getTime() : NaN;
        const elapsed = Number.isFinite(startedAt)
          ? ` · 已运行 ${formatDuration(Date.now() - startedAt)}`
          : '';
        return activity + elapsed;
      }
      case 'waiting_permission': return '等待你的授权';
      case 'waiting_user_input': return '等待你的回答';
      case 'committing': return '正在保存分析结果';
      default: return '可以继续提问';
    }
  };
  /** 刷新后如果服务端仍有真实 active turn，新问题先排队，避免第二个 turn 抢占当前 Investigation。 */
  const waitForExecutionIdle = async (key: string) => {
    for (;;) {
      const status = await loadExecutionStatus(key);
      if (!status.running) return;
      setTurnStatus(executionStatusText(status) + '，当前问题会在上一轮完成后自动继续。');
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  };

  /** SSE 断线后等待服务恢复；startup recovery 会把旧 turn 变成 durable aborted message。 */
  const recoverAfterStreamDisconnect = async (key: string, turnId: string): Promise<boolean> => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const status = await loadExecutionStatus(key);
      if (!status.running || status.turnId !== turnId) {
        try {
          await loadSession(key);
        } catch {
          await new Promise((resolve) => window.setTimeout(resolve, 800));
          continue;
        }
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
    return false;
  };

  /** 拉取当前 Agent 正在等待的权限/用户输入请求；这些都是短暂运行态，不写入调查配置。 */
  const loadPendingInteractions = async (key: string) => {
    try {
      const [permissionResult, inputResult] = await Promise.all([
        getJson(
          `/api/sessions/${encodeURIComponent(key)}/permissions`,
          PermissionsResponseSchema,
        ),
        getJson(
          `/api/sessions/${encodeURIComponent(key)}/user-inputs`,
          UserInputsResponseSchema,
        ),
      ]);
      if (key === activeRef.current) {
        setPendingPermissions(permissionResult.permissions);
        setPendingUserInputs(inputResult.requests);
      }
    } catch {
      // Agent 未运行或服务刚重启时这里可能暂时不可用，不打断主对话。
    }
  };

  useEffect(() => {
    void getJson('/api/copilot/models', ModelsResponseSchema)
      .then((result) => setAvailableModels(result.models ?? []))
      .catch(() => setAvailableModels([]));
    void getJson('/api/config/global', GlobalConfigurationResponseSchema)
      .then((result) => {
        setGlobalConfiguration(result.configuration);
        setNewSessionRuntime(result.configuration.agent.runtime);
      })
      .catch(() => setGlobalConfiguration(undefined));
  }, []);

  const updateGlobalConfiguration = async (agent: InvestigationControl['agent']) => {
    const result = await getJson('/api/config/global', GlobalConfigurationResponseSchema, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent }),
    });
    setGlobalConfiguration(result.configuration);
    setTurnStatus('工作台默认配置已更新；没有覆盖该设置的其它 Investigation 会自动继承新默认值。');
    return result.configuration;
  };

  useEffect(() => {
    if (!active) return;
    void loadExecutionStatus(active);
    void loadPendingInteractions(active);
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void loadExecutionStatus(active);
        void loadPendingInteractions(active);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    const onPopState = () => {
      const routed = parseRoute();
      if (routed) {
        setPage(routed.page);
        setActive(routed.session);
      }
    };
    window.addEventListener('popstate', onPopState);
    reloadSessions().catch((e) => setError(e.message));
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    setStreamingAnswer(undefined);
    setStreamingReasoning('');
    assistantCompanionNoteRef.current = '';
    setAssistantCompanionNote('');
    setNextGuidance([]);
    setJourney(undefined);
    setPendingPermissions([]);
    setPendingUserInputs([]);
    setUserInputDrafts({});
    setStreamingReasoning('');
    setReasoningByMessage({});
    setMissionOpen(false);
    setMissionError(undefined);
    setPendingMissionMessage(undefined);
    setPendingMissionTurnId(undefined);
    setMissionDraft({ purpose: '', expectedResult: '', deliverableIds: [] });
    const idleExecutionStatus: ExecutionStatus = {
      state: 'idle',
      running: false,
      turnId: null,
      phase: null,
      startedAt: null,
      lastActivityAt: null,
      lastActivity: null,
      pendingPermissionCount: 0,
      pendingUserInputCount: 0,
    };
    executionStatusRef.current = idleExecutionStatus;
    setExecutionStatus(idleExecutionStatus);
    if (active) {
      loadSession(active, true).catch((e) => setError(e.message));
    } else {
      ++loadRequestRef.current;
      setCurrent(undefined);
    }
  }, [active]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: MouseEvent) => {
      if (resizing === 'left') {
        setLeftWidth(Math.max(220, Math.min(380, event.clientX)));
      } else {
        setRightWidth(Math.max(280, Math.min(460, window.innerWidth - event.clientX)));
      }
    };
    const onUp = () => setResizing(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  /** 把当前对话复制成可直接留档的文本；每条消息都带说话人和时间，避免导出后分不清是谁说的。 */
  const modelOptions = useMemo(() => {
    const runtime = current?.control.agent.runtime;
    const scoped = availableModels.filter((item) => {
      if (!runtime) return true;
      if (runtime === 'codebuddy-sdk') return item.runtime === 'codebuddy' || item.id.startsWith('codebuddy:');
      if (runtime === 'opencode-run') return item.runtime === 'opencode' || item.id.startsWith('opencode:');
      return item.runtime !== 'codebuddy' && item.runtime !== 'opencode'
        && !item.id.startsWith('codebuddy:')
        && !item.id.startsWith('opencode:');
    });
    const values = [...scoped];
    if (current?.control.agent.model && !values.some((item) => item.id === current.control.agent.model)) {
      values.unshift({
        id: current.control.agent.model,
        name: current.control.agent.model,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        policyState: null,
      });
    }
    return values.sort((a, b) => a.id === 'auto' ? -1 : b.id === 'auto' ? 1 : a.name.localeCompare(b.name));
  }, [availableModels, current?.control.agent.model, current?.control.agent.runtime]);

  const updateModelSettings = async (model: string, autoTier: AutoTier | null) => {
    if (!active || !current || modelSaving || loading) return;
    setModelSaving(true);
    setError(undefined);
    try {
      const result = await getJson(
        `/api/sessions/${encodeURIComponent(active)}/agent/model`,
        ControlResponseSchema,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, autoTier }),
        },
      );
      setCurrent((existing) => existing ? { ...existing, control: result.control } : existing);
      setTurnStatus(
        model === 'auto'
          ? (autoTier ? '已调整自动选择方式，下一轮对话开始使用。' : '已恢复自动选择默认方式，下一轮对话开始使用。')
          : `已切换模型为 ${model}，下一轮对话开始使用。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法修改模型设置');
    } finally {
      setModelSaving(false);
    }
  };

  const copyConversation = async () => {
    const messages = current?.messages ?? [];
    if (!messages.length) return;

    const assistantName = current?.control.agent.displayName?.trim() || '秘书';
    const content = messages
      .map((message) => {
        const speaker = message.role === 'assistant' ? assistantName : '我';
        return `${speaker} · ${formatTime(message.capturedAt)}\n${message.content}`;
      })
      .join('\n\n');

    try {
      await navigator.clipboard.writeText(content);
      setTurnStatus('对话已复制，可直接粘贴到文档或消息中。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '复制对话失败，请检查浏览器剪贴板权限。');
    }
  };


  const cancelActiveTurn = () => {
    const activeTurn = activeTurnRef.current;
    const key = activeTurn?.key ?? active;
    const turnId = activeTurn?.turnId ?? executionStatus.turnId;
    if (!key || !turnId) return;

    stopRequestedTurnRef.current = turnId;
    setError(undefined);
    setTurnStatus('正在停止本轮调查…');

    void (async () => {
      try {
        await request(`/api/sessions/${encodeURIComponent(key)}/messages/abort`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId }),
        });
      } catch {
        // The SSE connection may already be gone during shutdown.
      } finally {
        activeTurn?.controller.abort();
        if (!activeTurn) {
          await waitForExecutionIdle(key);
          try {
            await loadSession(key);
          } catch {
            // The server may need one more poll after the abort completes.
          }
        }
      }
    })();
  };

  /** 处理权限请求；session scope 使用 Copilot SDK 原生的“当前会话继续允许”。 */
  const respondToPermission = async (
    permission: PendingPermission,
    allowed: boolean,
    scope: 'once' | 'session' = 'once',
  ) => {
    if (permission.sessionName !== active) return;
    try {
      await getJson(
        `/api/sessions/${encodeURIComponent(permission.sessionName)}/permissions/respond`,
        SimpleOkResponseSchema,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            turnId: permission.turnId,
            requestId: permission.requestId,
            allowed,
            scope,
          }),
        },
      );
      setPendingPermissions((items) => items.filter((item) => item.requestId !== permission.requestId));
      setTurnStatus(
        !allowed
          ? '已拒绝这次操作，助手会继续处理…'
          : scope === 'session'
            ? '已允许本次及当前会话后续操作，助手继续处理…'
            : '已允许这次操作，助手继续处理…',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法处理权限请求');
    }
  };

  /** 把回答提交给当前 ask_user 请求；按钮选择和自由输入共用一个接口。 */
  const respondToUserInput = async (
    request: PendingUserInput,
    answer: string,
    wasFreeform: boolean,
  ) => {
    if (request.sessionName !== active || !answer.trim()) return;
    try {
      await getJson(
        `/api/sessions/${encodeURIComponent(request.sessionName)}/user-inputs/respond`,
        SimpleOkResponseSchema,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            turnId: request.turnId,
            requestId: request.requestId,
            answer: answer.trim(),
            wasFreeform,
          }),
        },
      );
      setPendingUserInputs((items) => items.filter((item) => item.requestId !== request.requestId));
      setUserInputDrafts((drafts) => {
        const next = { ...drafts };
        delete next[request.requestId];
        return next;
      });
      setTurnStatus('已回答 Agent，助手继续处理…');
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法提交 Agent 的问题');
    }
  };

  const send = async (text?: string, routeId?: string, guided = false, turnIdOverride?: string) => {
    const selectedRoute = routeId
      ? current?.context.journeyPlan?.routes.find((route) => route.id === routeId)
      : undefined;
    const message = routeId
      ? selectedRoute
        ? '选择下一步：' + selectedRoute.title
        : ''
      : (text ?? value).trim();
    if (!message || loading) return;

    setValue('');
    setNextGuidance([]);
    setStreamingReasoning('');
    assistantCompanionNoteRef.current = '';
    setAssistantCompanionNote('');
    setLoading(true);
    setTurnStatus('助手正在处理你的问题，请稍候…');
    setError(undefined);
    const turnId = turnIdOverride ?? crypto.randomUUID();
    const controller = new AbortController();
    const optimisticMessage = {
      id: turnId + ':user',
      role: 'user' as const,
      content: message,
      capturedAt: new Date().toISOString(),
    };
    let missionBlocked = false;
    let executionFailed = false;
    let key = active;

    try {
      if (!key) {
        const created = await getJson('/api/sessions', CreateSessionResponseSchema, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userPrompt: message }),
        });
        key = created.context.name;
        activeRef.current = key;
        pendingOutgoingMessagesRef.current[key] = optimisticMessage;
        navigateToSession(key);
      }

      // 页面刷新后没有本地 activeTurnRef，但服务端可能仍有上一轮执行；等待真实 live turn 结束。
      // 在等待期间不要覆盖旧 turn 的 Stop 引用，否则用户将无法停止真正正在执行的上一轮。
      await waitForExecutionIdle(key as string);

      activeTurnRef.current = { key: key as string, turnId, controller };
      pendingOutgoingMessagesRef.current[key] = optimisticMessage;
      setCurrent((existing) => {
        if (!existing || existing.context.name !== key) return existing;
        if (existing.messages.some((item) => item.id === optimisticMessage.id)) return existing;
        return {
          ...existing,
          messages: [
            ...existing.messages,
            optimisticMessage,
          ],
        };
      });
      setStreamingAnswer({ key: key as string, content: '' });

      let response: Response;
      try {
        response = await request(`/api/sessions/${encodeURIComponent(key as string)}/messages/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(routeId ? { routeId, turnId } : { message, guided, turnId }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof ApiRequestError) {
          const apiError = error.apiError;
          const errorDetails = apiError.details;
          const missionDraft = errorDetails
            && typeof errorDetails === 'object'
            && 'draft' in errorDetails
            ? MissionDraftSchema.safeParse((errorDetails as { draft?: unknown }).draft).data
            : undefined;

          if (error.status === 409 && apiError.code === 'MISSION_REQUIRED') {
            setMissionDraft(missionDraft ?? {
              purpose: current?.context.mission?.purpose ?? '',
              expectedResult: current?.context.mission?.expectedResult ?? '',
              deliverableIds: current?.context.mission?.deliverables.map((item) => item.id) ?? [],
            });
            setPendingMissionMessage(message);
            setPendingMissionTurnId(turnId);
            setMissionOpen(true);
            missionBlocked = true;
            // Mission Gate 只阻止 Agent 执行，不能吞掉用户刚刚发送的消息。
            // 服务端已经以 turnId:user 持久化它；这里刷新一次让聊天区立即显示。
            await loadSession(key);
            setTurnStatus('开始调查前，请先确认任务目的和期望结果。');
            return;
          }
        }
        throw error;
      }

      let result: AnswerSummaryContract | undefined;

      let streamedReasoning = '';
      await consumeSse(response, ({ event, data }) => {
        if (event === 'started') {
          setTurnStatus('助手正在处理你的问题，请稍候…');
          return;
        }
        if (event === 'status') {
          if (data.status.trim()) setTurnStatus(data.status.trim());
          return;
        }
        if (event === 'companion_note') {
          const note = data.note.trim();
          if (note) {
            assistantCompanionNoteRef.current = note;
            setAssistantCompanionNote(note);
          }
          return;
        }
        if (event === 'checkpoint') {
          setTurnStatus('已形成阶段小结：' + data.title);
          return;
        }
        if (event === 'reasoning') {
          streamedReasoning += data.delta;
          setTurnStatus('助手正在分析你的问题，请稍候…');
          setStreamingReasoning(streamedReasoning);
          return;
        }
        if (event === 'delta') {
          setStreamingAnswer((currentAnswer) => currentAnswer?.key === key
            ? { ...currentAnswer, content: currentAnswer.content + data.delta }
            : currentAnswer);
          return;
        }
        if (event === 'error') {
          throw new Error(data.error);
        }
        if (event === 'completed') {
          result = AnswerSummarySchema.parse(data);
        }
      });

      if (!result) throw new Error('Agent stream ended without a completed result.');

      setTurnStatus('正在保存这次分析结果，请稍候…');
      let refreshed: SessionData | undefined;
      if (activeRef.current === key) {
        refreshed = await loadSession(key);
        await reloadSessions(false);
      }
      if (streamedReasoning.trim() && refreshed) {
        const lastAssistant = [...refreshed.messages].reverse().find((item) => item.role === 'assistant');
        if (lastAssistant) {
          setReasoningByMessage((items) => ({ ...items, [lastAssistant.id]: streamedReasoning }));
        }
      }

      const questions = Array.isArray(result.followUpQuestions)
        ? result.followUpQuestions
          .map((item) => typeof item === 'string' ? item.trim() : '')
          .filter(Boolean)
          .slice(0, 3)
        : [];
      setNextGuidance(questions);

      // 非阻断的结构化结果告警已经由服务端自动修正，并记录到 Agent 轨迹。
      // 不把这类内部校验信息显示成用户错误，否则会让用户误以为需要处理。
      if (result.warnings.length) {
        setTurnStatus('结果已保存，部分内部引用已自动修正。');
      }
    } catch (e) {
      const stoppedByUser = e instanceof DOMException
        && e.name === 'AbortError'
        && stopRequestedTurnRef.current === turnId;
      executionFailed = !stoppedByUser;

      if (stoppedByUser) {
        setError(undefined);
        setTurnStatus('正在停止本轮调查…');
        await waitForExecutionIdle(key as string);
        try {
          await loadSession(key as string);
        } catch {
          // The server may need one more poll after the abort completes.
        }
      } else {
        const errorText = e instanceof Error ? e.message : '请求失败';
        const isTransportError =
          e instanceof TypeError
          || /Failed to fetch|NetworkError|network error|Load failed/i.test(errorText);

        if (isTransportError) {
          setError(undefined);
          setTurnStatus('连接已中断，正在等待服务恢复并检查这次调查是否已经保存…');
          const recovered = key
            ? await recoverAfterStreamDisconnect(key as string, turnId)
            : false;
          if (recovered) {
            setError(undefined);
            setTurnStatus('连接已恢复，这次调查状态已经重新加载。');
            executionFailed = false;
          } else {
            setError('服务暂时不可连接。请重新启动服务；这次调查记录会从服务器恢复，不需要重新提交。');
          }
        } else {
          if (key && activeRef.current === key) {
            try {
              await loadSession(key);
            } catch {
              // Keep the optimistic message if the recovery reload itself fails.
            }
          }
          setError(errorText);
        }
      }
    } finally {
      setStreamingAnswer(undefined);
      setStreamingReasoning('');
      assistantCompanionNoteRef.current = '';
      setAssistantCompanionNote('');
      setTurnStatus(missionBlocked
        ? '开始调查前，请先确认任务目的和期望结果。'
        : stopRequestedTurnRef.current === turnId
          ? '本轮执行已停止，可以继续提问'
          : executionFailed
            ? '这次执行没有完成，详细原因已记录在 Agent 轨迹中。'
            : '可以继续提问');
      if (activeTurnRef.current?.turnId === turnId) activeTurnRef.current = undefined;
      if (stopRequestedTurnRef.current === turnId) stopRequestedTurnRef.current = undefined;
      setLoading(false);
    }
  };

  /** 打开 Mission 编辑/确认窗口；已确认 Mission 也可以从这里修改。 */
  const editMission = () => {
    setMissionError(undefined);
    const mission = current?.context.mission;
    setMissionDraft(mission
      ? {
          purpose: mission.purpose,
          expectedResult: mission.expectedResult,
          deliverableIds: mission.deliverables.map((item) => item.id),
        }
      : {
          purpose: current?.context.goal || current?.context.userPrompt || '',
          expectedResult: '',
          deliverableIds: [],
        });
    setMissionOpen(true);
  };

  /** 用户确认 Mission 后保存；若刚才有请求被 Gate 拦住，则自动继续执行。 */
  const confirmMission = async () => {
    if (!active || missionSaving) return;
    const purpose = missionDraft.purpose.trim();
    const expectedResult = missionDraft.expectedResult.trim();
    if (!purpose || !expectedResult) {
      setError('请先填写任务目的和期望结果。');
      return;
    }

    setMissionSaving(true);
    setError(undefined);
    setMissionError(undefined);
    try {
      const result = await getJson(
        '/api/sessions/' + encodeURIComponent(active) + '/mission',
        MissionUpdateResponseSchema,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purpose, expectedResult }),
        },
      );

      setCurrent((existing) => existing ? { ...existing, context: result.context } : existing);
      setMissionOpen(false);
      setMissionDraft({
        purpose: result.mission.purpose,
        expectedResult: result.mission.expectedResult,
        deliverableIds: result.mission.deliverables.map((item) => item.id),
      });

      const nextMessage = pendingMissionMessage;
      const nextTurnId = pendingMissionTurnId;
      setPendingMissionMessage(undefined);
      setPendingMissionTurnId(undefined);
      setTurnStatus('任务已确认，开始执行。');

      await loadSession(active);
      await reloadSessions(false);

      if (nextMessage) {
        void send(nextMessage, undefined, false, nextTurnId);
      }
    } catch (e) {
      if (e instanceof ApiRequestError) {
        const body = e.apiError;
        const details = body.details;
        const clarity = details && typeof details === 'object' && 'clarity' in details
          ? (details as { clarity?: { reason?: string } }).clarity
          : undefined;
        if (body.code === 'MISSION_CLARITY_REQUIRED') {
          setMissionError(body.error || clarity?.reason || '任务目的和期望结果还不够具体。');
          return;
        }
        if (body.code === 'MISSION_CHANGE_BLOCKED') {
          setMissionError(body.error || '当前调查正在执行，请先停止后再修改任务。');
          return;
        }
        setError(body.error);
        return;
      }
      setError(e instanceof Error ? e.message : '无法保存任务目标');
    } finally {
      setMissionSaving(false);
    }
  };

  const changeWorkflow = async (workflow: WorkflowId | null) => {
    if (!active || workflowSaving) return;

    setWorkflowSaving(true);
    setError(undefined);
    try {
      const result = await getJson(
        `/api/sessions/${encodeURIComponent(active)}/workflow`,
        WorkflowContextResponseSchema,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflow }),
        },
      );

      setCurrent((existing) => existing ? { ...existing, context: result.context } : existing);
      setJourney(undefined);
      await loadSession(active);
      await reloadSessions(false);
      setWorkflowTarget(undefined);
      setWorkflowConfirmText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法调整工作方式');
    } finally {
      setWorkflowSaving(false);
    }
  };

  const continueUnknown = (unknown: string) => {
    if (!active || loading) return;
    setUnknownsOpen(false);
    void send(
      [
        '重新评估这条未知是否真的影响本次 Mission：',
        '',
        unknown,
        '',
        '先对照本次任务的目的和期望结果判断它是否值得继续调查。只有会影响当前交付或下一阶段关键决定时才继续查；否则说明它可以暂时保留，不要为了清空 unknowns 而继续调查。能自动检索的直接执行，不要只给建议。',
      ].join('\n'),
    );
  };

  const createSession = async () => {
    const name = newSessionName.trim();
    if (!name || newSessionCreatingRef.current || newSessionCreating) return;
    newSessionCreatingRef.current = true;
    // 防止上一次创建失败留下的临时启动状态污染下一次新建调查。
    pendingInitialMissionDraftRef.current = undefined;
    pendingInitialAutoStartRef.current = undefined;
    pendingInitialMissionErrorRef.current = undefined;
    setNewSessionCreating(true);
    try {
      const purpose = newSessionGoal.trim();
      const expectedResult = newSessionExpectedResult.trim();
      pendingInitialMissionDraftRef.current = {
        purpose,
        expectedResult,
        deliverableIds: [],
      };

      const created = await getJson('/api/sessions', CreateSessionResponseSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          userPrompt: purpose || undefined,
          workflow: newSessionWorkflow,
          runtime: newSessionRuntime,
        }),
      });

      // 新建调查时如果两个核心输入都已经填写，它们本身就是用户确认的 Mission。
      // 自动启动意图先登记；即使 Mission 清晰度检查要求用户补充，也不能丢掉首次启动。
      if (purpose && expectedResult) {
        pendingInitialAutoStartRef.current = {
          sessionName: created.context.name,
          message: '请按照已经确认的任务目的和期望结果直接开始调查。',
        };
        try {
          await getJson(
            '/api/sessions/' + encodeURIComponent(created.context.name) + '/mission',
            MissionUpdateResponseSchema,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ purpose, expectedResult }),
            },
          );
          pendingInitialMissionDraftRef.current = undefined;
          pendingInitialMissionErrorRef.current = undefined;
        } catch (e) {
          if (e instanceof ApiRequestError && e.apiError.code === 'MISSION_CLARITY_REQUIRED') {
            pendingInitialMissionDraftRef.current = { purpose, expectedResult, deliverableIds: [] };
            pendingInitialMissionErrorRef.current = e.apiError.error || '任务目的和期望结果还不够具体。';
            return;
          }
          throw e;
        }
      }

      setNewSessionOpen(false);
      setNewSessionName('');
      setNewSessionGoal(NEW_SESSION_GOAL_SAMPLE);
      setNewSessionExpectedResult(NEW_SESSION_EXPECTED_RESULT_SAMPLE);
      setNewSessionWorkflow(null);
      setNewSessionRuntime(globalConfiguration?.agent.runtime ?? 'copilot-sdk');
      await reloadSessions(false);
      navigateToSession(created.context.name);
      // 新建调查先停在配置页；用户完成一次明确的配置保存后，才自动开始首次执行。
      // GitHub 是可选的，保存时可以只有其它配置变化。
      setPage('config');
      setTurnStatus('调查已创建，请检查调查配置；保存配置后会自动开始。');
    } catch (e) {
      // 创建失败时不得把临时 Mission/自动启动状态带入下一次新建调查。
      pendingInitialMissionDraftRef.current = undefined;
      pendingInitialAutoStartRef.current = undefined;
      pendingInitialMissionErrorRef.current = undefined;
      setError(e instanceof Error ? e.message : '无法创建调查');
    } finally {
      // 必须在所有异步步骤（尤其 Mission clarity review）结束后才允许再次点击“确定”。
      // 否则一次快速双击会创建两个并行 review，并把同一个 Investigation 推进两遍。
      newSessionCreatingRef.current = false;
      setNewSessionCreating(false);
    }
  };

  const uploadFile = async (file: UploadFile) => {
    const source = file.originFileObj;
    if (!source || !active || uploadingFiles.has(file.uid)) return;

    setUploadingFiles((currentSet) => new Set(currentSet).add(file.uid));
    setAttachments((items) => items.map((item) => item.uid === file.uid ? { ...item, status: 'uploading' } : item));

    try {
      const form = new FormData();
      form.append('file', source as Blob, file.name);
      const result = await getJson(
        `/api/sessions/${encodeURIComponent(active)}/files`,
        FileUploadResponseSchema,
        { method: 'POST', body: form },
      );
      setAttachments((items) => items.map((item) => item.uid === file.uid
        ? { ...item, uid: result.file.id, name: result.file.name, status: 'done' }
        : item));
      await loadSession(active);
      toast.success(`已上传 ${result.file.name}`);
    } catch (e) {
      setAttachments((items) => items.map((item) => item.uid === file.uid ? { ...item, status: 'error' } : item));
      toast.error(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUploadingFiles((currentSet) => {
        const next = new Set(currentSet);
        next.delete(file.uid);
        return next;
      });
    }
  };

  const onAttachmentChange = ({ fileList }: { fileList: UploadFile[] }) => {
    setAttachments(fileList);
    for (const file of fileList) {
      if (file.originFileObj && file.status !== 'done' && !uploadingFiles.has(file.uid)) {
        void uploadFile(file);
      }
    }
  };


  return {
    page,
    setPage,
    sessions,
    active,
    current,
    globalConfiguration,
    availableModels,
    modelOptions,
    modelSaving,
    streamingReasoning,
    assistantCompanionNote,
    reasoningByMessage,
    assistantAvatarByMessage,
    value,
    loading,
    executionStatus,
    turnStatus,
    pendingPermissions,
    pendingUserInputs,
    userInputDrafts,
    streamingAnswer,
    nextGuidance,
    newSessionOpen,
    newSessionCreating,
    newSessionName,
    newSessionRuntime,
    newSessionWorkflow,
    newSessionGoal,
    newSessionExpectedResult,
    workflowSaving,
    workflowTarget,
    workflowConfirmText,
    unknownsOpen,
    error,
    missionOpen,
    missionDraft,
    missionSaving,
    missionError,
    journey,
    attachmentsOpen,
    attachments,
    uploadingFiles,
    leftWidth,
    rightWidth,
    resizing,
    showLeftTip,
    activeRef,
    reloadSessions,
    loadSession,
    executionStatusText,
    updateModelSettings,
    updateGlobalConfiguration,
    copyConversation,
    cancelActiveTurn,
    respondToPermission,
    respondToUserInput,
    send,
    changeWorkflow,
    continueUnknown,
    createSession,
    uploadFile,
    onAttachmentChange,
    navigatePage,
    navigateToSession,
    setValue,
    setAttachmentsOpen,
    setUserInputDrafts,
    setNewSessionOpen,
    setNewSessionName,
    setNewSessionRuntime,
    setNewSessionGoal,
    setNewSessionExpectedResult,
    setNewSessionWorkflow,
    setWorkflowTarget,
    setWorkflowConfirmText,
    setUnknownsOpen,
    setError,
    editMission,
    confirmMission,
    setMissionOpen,
    setMissionDraft,
    setResizing,
    setShowLeftTip,
  };
}

export type InvestigationController = ReturnType<typeof useInvestigationController>;
