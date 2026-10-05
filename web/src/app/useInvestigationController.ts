import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import type { UploadFile } from 'antd';
import { consumeSse, getJson } from './api';
import { buildInvestigationPath, parseRoute, type PageId } from './routing';
import {
  workflowOptions,
  type AutoTier,
  type CopilotModelOption,
  type ExecutionStatus,
  type InvestigationCheckpoint,
  type InvestigationControl,
  type JourneyState,
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
  const [availableModels, setAvailableModels] = useState<CopilotModelOption[]>([]);
  const [modelSaving, setModelSaving] = useState(false);
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [reasoningByMessage, setReasoningByMessage] = useState<Record<string, string>>({});
  // 每条回复固定一个随机头像。分配结果同时持久化到浏览器，避免上传新头像或刷新页面后旧消息全部换头像。
  const [assistantAvatarByMessage, setAssistantAvatarByMessage] = useState<Record<string, string>>({});
  useEffect(() => {
    const sessionName = current?.context.name;
    // avatarSources 为空数组时不能屏蔽旧版 avatarPaths；只有真正有来源时才优先使用 avatarSources。
    const configuredSources = current?.control.agent.avatarSources?.map((item) => item.src).filter(Boolean) ?? [];
    const avatarPaths = configuredSources.length > 0
      ? configuredSources
      : current?.control.agent.avatarPaths?.filter(Boolean)
        ?? (current?.control.agent.avatarPath ? [current.control.agent.avatarPath] : []);
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
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus>({ state: 'idle', running: false, turnId: null, phase: null, pendingPermissionCount: 0, pendingUserInputCount: 0 });
  const [turnStatus, setTurnStatus] = useState('助手正在处理你的问题，请稍候…');
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [pendingUserInputs, setPendingUserInputs] = useState<PendingUserInput[]>([]);
  const [userInputDrafts, setUserInputDrafts] = useState<Record<string, string>>({});
  const [streamingAnswer, setStreamingAnswer] = useState<{ key: string; content: string }>();
  const [nextGuidance, setNextGuidance] = useState<string[]>([]);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionWorkflow, setNewSessionWorkflow] = useState<WorkflowId | null>(null);
  const [newSessionGoal, setNewSessionGoal] = useState('');
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
  const [pendingMissionMessage, setPendingMissionMessage] = useState<string>();
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachments, setAttachments] = useState<UploadFile[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<Set<string>>(new Set());
  const [leftWidth, setLeftWidth] = useState(270);
  const [rightWidth, setRightWidth] = useState(330);
  const [resizing, setResizing] = useState<'left' | 'right' | null>(null);
  const [showLeftTip, setShowLeftTip] = useState(() => {
    try { return localStorage.getItem('ada.tip.left') !== 'dismissed'; } catch { return true; }
  });
  const activeRef = useRef<string | undefined>(undefined);
  const loadRequestRef = useRef(0);
  const activeTurnRef = useRef<{ key: string; turnId: string; controller: AbortController } | undefined>(undefined);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const reloadSessions = async (selectLatest = true) => {
    const result = await getJson<{ sessions: SessionSummary[] }>('/api/sessions');
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
    const [result, journeyResult] = await Promise.all([
      getJson<SessionData>(`/api/sessions/${encodeURIComponent(key)}`),
      getJson<{ journey: JourneyState | null }>(`/api/sessions/${encodeURIComponent(key)}/journey`),
    ]);
    if (requestId !== loadRequestRef.current || key !== activeRef.current) return;
    setCurrent(result);
    setJourney(journeyResult.journey ?? undefined);

    // Mission 是正式调查的前置条件。旧 Session 如果还没有 Mission，
    // 首次打开就直接让用户确认，而不是先允许 Agent 自己猜目标。
    if (!result.context.mission) {
      setMissionDraft({
        purpose: result.context.goal || result.context.userPrompt || '',
        expectedResult: '',
        deliverableIds: [],
      });
      setMissionOpen(true);
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
      const status = await getJson<ExecutionStatus>(
        `/api/sessions/${encodeURIComponent(key)}/execution`,
      );
      if (key === activeRef.current) setExecutionStatus(status);
      return status;
    } catch {
      const idle: ExecutionStatus = { state: 'idle', running: false, turnId: null, phase: null, pendingPermissionCount: 0, pendingUserInputCount: 0 };
      if (key === activeRef.current) setExecutionStatus(idle);
      return idle;
    }
  };

  /** 用统一的 live execution state 生成顶部状态文字。 */
  const executionStatusText = (status: ExecutionStatus): string => {
    switch (status.state) {
      case 'running': return '上一轮任务仍在执行';
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

  /** 拉取当前 Agent 正在等待的权限/用户输入请求；这些都是短暂运行态，不写入调查配置。 */
  const loadPendingInteractions = async (key: string) => {
    try {
      const [permissionResult, inputResult] = await Promise.all([
        getJson<{ permissions: PendingPermission[] }>(
          `/api/sessions/${encodeURIComponent(key)}/permissions`,
        ),
        getJson<{ requests: PendingUserInput[] }>(
          `/api/sessions/${encodeURIComponent(key)}/user-inputs`,
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
    void getJson<{ models: CopilotModelOption[] }>('/api/copilot/models')
      .then((result) => setAvailableModels(result.models ?? []))
      .catch(() => setAvailableModels([]));
  }, []);

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
    setNextGuidance([]);
    setJourney(undefined);
    setPendingPermissions([]);
    setPendingUserInputs([]);
    setUserInputDrafts({});
    setStreamingReasoning('');
    setReasoningByMessage({});
    setMissionOpen(false);
    setPendingMissionMessage(undefined);
    setMissionDraft({ purpose: '', expectedResult: '', deliverableIds: [] });
    setExecutionStatus({ state: 'idle', running: false, turnId: null, phase: null, pendingPermissionCount: 0, pendingUserInputCount: 0 });
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
    const values = [...availableModels];
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
  }, [availableModels, current?.control.agent.model]);

  const updateModelSettings = async (model: string, autoTier: AutoTier | null) => {
    if (!active || !current || modelSaving || loading) return;
    setModelSaving(true);
    setError(undefined);
    try {
      const result = await getJson<{ control: InvestigationControl }>(
        `/api/sessions/${encodeURIComponent(active)}/agent/model`,
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

    void fetch(`/api/sessions/${encodeURIComponent(key)}/messages/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId }),
    }).catch(() => undefined);

    activeTurn?.controller.abort();
  };

  /** 处理权限请求；session scope 使用 Copilot SDK 原生的“当前会话继续允许”。 */
  const respondToPermission = async (
    permission: PendingPermission,
    allowed: boolean,
    scope: 'once' | 'session' = 'once',
  ) => {
    if (permission.sessionName !== active) return;
    try {
      await getJson<{ ok: true }>(
        `/api/sessions/${encodeURIComponent(permission.sessionName)}/permissions/respond`,
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
      await getJson<{ ok: true }>(
        `/api/sessions/${encodeURIComponent(request.sessionName)}/user-inputs/respond`,
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

  const send = async (text?: string, routeId?: string, guided = false) => {
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
    setLoading(true);
    setTurnStatus('助手正在处理你的问题，请稍候…');
    setError(undefined);
    const turnId = crypto.randomUUID();
    const controller = new AbortController();
    let missionBlocked = false;

    try {
      let key = active;
      if (!key) {
        const created = await getJson<{ context: SessionContext }>('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userPrompt: message }),
        });
        key = created.context.name;
        activeRef.current = key;
        navigateToSession(key);
      }

      // 页面刷新后没有本地 activeTurnRef，但服务端可能仍有上一轮执行；等待真实 live turn 结束。
      // 在等待期间不要覆盖旧 turn 的 Stop 引用，否则用户将无法停止真正正在执行的上一轮。
      await waitForExecutionIdle(key as string);

      activeTurnRef.current = { key: key as string, turnId, controller };
      setStreamingAnswer({ key: key as string, content: '' });

      const response = await fetch(`/api/sessions/${encodeURIComponent(key as string)}/messages/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(routeId ? { routeId, turnId } : { message, guided, turnId }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        let parsedBody: { code?: string; error?: string; draft?: MissionDraft } | undefined;
        try {
          parsedBody = JSON.parse(body) as typeof parsedBody;
        } catch {
          parsedBody = undefined;
        }

        if (response.status === 409 && parsedBody?.code === 'MISSION_REQUIRED') {
          setMissionDraft(parsedBody.draft ?? {
            purpose: current?.context.mission?.purpose ?? '',
            expectedResult: current?.context.mission?.expectedResult ?? '',
            deliverableIds: current?.context.mission?.deliverables.map((item) => item.id) ?? [],
          });
          setPendingMissionMessage(message);
          setMissionOpen(true);
          missionBlocked = true;
          setTurnStatus('开始调查前，请先确认任务目的和期望结果。');
          return;
        }

        throw new Error(parsedBody?.error || body || response.statusText);
      }

      let result: {
        answer: string;
        claimIds: string[];
        warnings: string[];
        unknowns: string[];
        followUpQuestions: string[];
      } | undefined;

      let streamedReasoning = '';
      await consumeSse(response, ({ event, data }) => {
        if (event === 'started') {
          setTurnStatus('助手正在处理你的问题，请稍候…');
          return;
        }
        if (event === 'status') {
          const status = (data as { status?: unknown }).status;
          if (typeof status === 'string' && status.trim()) {
            setTurnStatus(status.trim());
          }
          return;
        }
        if (event === 'checkpoint') {
          const checkpoint = data as InvestigationCheckpoint;
          if (checkpoint && typeof checkpoint.id === 'string' && typeof checkpoint.title === 'string') {
            setTurnStatus('已形成阶段小结：' + checkpoint.title);
          }
          return;
        }
        if (event === 'reasoning') {
          const delta = (data as { delta?: unknown }).delta;
          if (typeof delta === 'string') {
            streamedReasoning += delta;
            setTurnStatus('助手正在分析你的问题，请稍候…');
            setStreamingReasoning(streamedReasoning);
          }
          return;
        }
        if (event === 'delta') {
          setTurnStatus('助手正在整理答案，请稍候…');
          const delta = (data as { delta?: unknown }).delta;
          if (typeof delta === 'string') setStreamingAnswer((currentAnswer) => currentAnswer?.key === key
            ? { ...currentAnswer, content: currentAnswer.content + delta }
            : currentAnswer);
          return;
        }
        if (event === 'error') {
          throw new Error(String((data as { error?: unknown }).error ?? '请求失败'));
        }
        if (event === 'completed') {
          result = data as typeof result;
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
      if (e instanceof DOMException && e.name === 'AbortError') {
        setError('本轮执行已停止。');
      } else {
        setError(e instanceof Error ? e.message : '请求失败');
      }
    } finally {
      setStreamingAnswer(undefined);
      setStreamingReasoning('');
      setTurnStatus(missionBlocked
        ? '开始调查前，请先确认任务目的和期望结果。'
        : '助手正在处理你的问题，请稍候…');
      if (activeTurnRef.current?.turnId === turnId) activeTurnRef.current = undefined;
      setLoading(false);
    }
  };

  /** 打开 Mission 编辑/确认窗口；已确认 Mission 也可以从这里修改。 */
  const editMission = () => {
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
    try {
      const result = await getJson<{ context: SessionContext; mission: MissionContract }>(
        '/api/sessions/' + encodeURIComponent(active) + '/mission',
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
      setPendingMissionMessage(undefined);
      setTurnStatus('任务已确认，开始执行。');

      await loadSession(active);
      await reloadSessions(false);

      if (nextMessage) {
        void send(nextMessage);
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : '无法保存任务目标';
      try {
        const body = JSON.parse(raw) as {
          code?: string;
          error?: string;
          clarity?: { reason?: string };
        };
        if (body.code === 'MISSION_CLARITY_REQUIRED') {
          setError(body.error || body.clarity?.reason || '任务目的和期望结果还不够具体。');
        } else {
          setError(body.error || raw);
        }
      } catch {
        setError(raw);
      }
    } finally {
      setMissionSaving(false);
    }
  };

  const changeWorkflow = async (workflow: WorkflowId | null) => {
    if (!active || workflowSaving) return;

    setWorkflowSaving(true);
    setError(undefined);
    try {
      const result = await getJson<{ context: SessionContext }>(
        `/api/sessions/${encodeURIComponent(active)}/workflow`,
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
    if (!name) return;
    try {
      const created = await getJson<{ context: SessionContext }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          userPrompt: newSessionGoal.trim() || undefined,
          workflow: newSessionWorkflow,
        }),
      });
      setNewSessionOpen(false);
      setNewSessionName('');
      setNewSessionGoal('');
      setNewSessionWorkflow(null);
      await reloadSessions(false);
      navigateToSession(created.context.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法创建调查');
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
      const result = await getJson<{ file: { id: string; name: string } }>(
        `/api/sessions/${encodeURIComponent(active)}/files`,
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
    availableModels,
    modelOptions,
    modelSaving,
    streamingReasoning,
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
    newSessionName,
    newSessionWorkflow,
    newSessionGoal,
    workflowSaving,
    workflowTarget,
    workflowConfirmText,
    unknownsOpen,
    error,
    missionOpen,
    missionDraft,
    missionSaving,
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
    setNewSessionGoal,
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
