import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Card,
  ConfigProvider,
  Divider,
  Empty,
  Flex,
  Input,
  Layout,
  Modal,
  Radio,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { UploadFile } from 'antd';
import {
  FolderOpenOutlined,
  FullscreenOutlined,
  LoadingOutlined,
  InfoCircleOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  RobotOutlined,
  SettingOutlined,
  ToolOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import {
  Attachments,
  Bubble,
  Conversations,
  Mermaid,
  Sender,
  Think,
  XProvider,
} from '@ant-design/x';
import { XMarkdown } from '@ant-design/x-markdown';
// 这些页面不是首页聊天首屏必需内容，懒加载可以把 X6 / 轨迹 / 配置相关代码拆出去，避免首页主 chunk 过大。
const JourneyMap = lazy(() => import('./components/JourneyMap').then((module) => ({ default: module.JourneyMap })));
const InvestigationConfigPage = lazy(() => import('./components/InvestigationConfigPage').then((module) => ({ default: module.InvestigationConfigPage })));
const AgentTrajectoryPage = lazy(() => import('./components/AgentTrajectoryPage').then((module) => ({ default: module.AgentTrajectoryPage })));
import zhCN from 'antd/locale/zh_CN';
import '@ant-design/x-markdown/themes/light.css';

const { Sider, Header, Content } = Layout;
const { Text, Title, Paragraph } = Typography;

const pageLoadingFallback = (
  <div className="subpage-app" style={{ display: 'grid', placeItems: 'center' }}>
    <Text type="secondary">正在打开页面…</Text>
  </div>
);

interface SessionSummary {
  key: string;
  label: string;
  userPrompt: string;
  updatedAt: string;
}

interface WorkspaceInput {
  id: string;
  kind: string;
  title: string;
  artifactPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
}

type AutoTier = 'efficiency' | 'balance' | 'intelligence' | 'fast';

interface CopilotModelOption {
  id: string;
  name: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  policyState: string | null;
}

interface InvestigationControl {
  schemaVersion: number;
  version: number;
  updatedAt: string;
  research: {
    githubRepositories: string[];
    githubSearchMode: 'only_selected' | 'selected_and_broad';
    keywords: string[];
    importantDocuments: Array<{ id: string; title: string; reference: string }>;
  };
  agent: {
    model: string;
    autoTier?: AutoTier;
    permissionMode: 'permission' | 'allow_all';
    displayName: string;
    avatarPath?: string;
    avatarPaths?: string[];
    avatarMimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
    autoContinuationTurns: number;
    avatarWidth: number;
    avatarHeight: number;
    systemPrompt: {
      version: number;
      content: string;
    };
    mcpServers: Array<{
      name: string;
      version: number;
      enabled: boolean;
      type: 'local' | 'http';
      command?: string;
      args?: string[];
      url?: string;
      tools?: string[];
      headers?: Record<string, string>;
    }>;
  };
  history: Array<{
    version: number;
    updatedAt: string;
    reason: string;
  }>;
}

interface AuditEvent {
  id: string;
  timestamp: string;
  actor: 'user' | 'system';
  action: string;
  summary: string;
  configurationVersion?: number;
  details?: Record<string, unknown>;
}

interface PendingPermission {
  sessionName: string;
  turnId: string;
  sessionId: string;
  requestId: string;
  kind: string;
  requestedAt: string;
  intention?: string;
  fullCommandText?: string;
  fileName?: string;
  path?: string;
  serverName?: string;
  toolName?: string;
  toolTitle?: string;
  readOnly?: boolean;
  managedApprovalRequired?: boolean;
}

interface ExecutionStatus {
  state: 'idle' | 'running' | 'waiting_permission' | 'waiting_user_input' | 'committing';
  running: boolean;
  turnId: string | null;
  phase: 'executing' | 'committing' | null;
  pendingPermissionCount: number;
  pendingUserInputCount: number;
}

interface PendingUserInput {
  sessionName: string;
  turnId: string;
  sessionId: string;
  requestId: string;
  question: string;
  choices: string[];
  allowFreeform: boolean;
  requestedAt: string;
}

type WorkflowId = 'legacy-modernization' | 'financial-ai-native-architecture' | 'data-architecture-assessment';

const workflowOptions = [
  { value: '', label: '自主调查' },
  { value: 'legacy-modernization', label: '改造已有系统' },
  { value: 'financial-ai-native-architecture', label: '金融 AI / 数据架构设计' },
  { value: 'data-architecture-assessment', label: '数据架构评估' },
] as const;

interface SessionContext {
  name: string;
  workflow: WorkflowId | null;
  userPrompt: string;
  goal: string;
  scope: string[];
  systems: string[];
  evidence: unknown[];
  findings: Array<{ severity?: string; status?: string; title?: string }>;
  unknowns: string[];
  claims: unknown[];
  inputs: WorkspaceInput[];
  /** 最近一次 Agent 根据用户动作与证据重新规划的可选路线。 */
  journeyPlan?: {
    version: number;
    source: 'agent';
    generatedAt: string;
    turnId?: string;
    routes: Array<{
      id: string;
      title: string;
      reason: string;
      steps: string[];
    }>;
  };
  updatedAt: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  capturedAt: string;
}

interface SessionData {
  context: SessionContext;
  control: InvestigationControl;
  recentAudit: AuditEvent[];
  messages: Message[];
  currentState?: {
    coverage: {
      datasets: number;
      connectedDatasets: number;
      datasetLineageConnectionRate: number | null;
      sqlParseFailures: number;
      semanticAssets: number;
      profiledDatasets: number;
    };
    sourceOfTruthCandidates: unknown[];
    semanticCandidates: unknown[];
    highValueAssets: string[];
  } | null;
  semanticAssets?: unknown[];
}

interface JourneyState {
  workflowId: string;
  currentNodeId: string;
  completedNodeIds: string[];
  unlockedNodeIds: string[];
  stages: Array<{
    id: string;
    title: string;
    objective: string;
    status: 'completed' | 'current' | 'locked' | 'future';
    nodeType: 'task' | 'gate' | 'review' | 'end' | 'stop';
    unlocked: boolean;
  }>;
}
const markdownComponents = {
  mermaid: Mermaid as React.ComponentType<any>,
};

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || response.statusText);
  }
  return response.json() as Promise<T>;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}


interface StreamEvent {
  event: string;
  data: unknown;
}

async function consumeSse(
  response: Response,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('当前环境不支持流式响应。');

  const decoder = new TextDecoder();
  let buffer = '';

  const processBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    let event = 'message';
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    onEvent({ event, data: JSON.parse(data.join('\n')) });
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      if (block.trim()) processBlock(block);
    }
    if (done) break;
  }

  const tail = buffer.trim();
  if (tail) processBlock(tail);
}

function documentReferences(context?: SessionContext): string[] {
  return (context?.inputs ?? [])
    .filter((input) => input.kind === 'document' && input.artifactPath)
    .map((input) => input.artifactPath as string);
}


/** 只把给用户看的 answer 渲染出来；Agent 的结构化 JSON 属于内部协议，不应该出现在聊天气泡里。 */
function displayAssistantContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';

  // Agent 的结构化输出可能是裸 JSON，也可能被 Markdown 的 json code fence 包住。
  // 这些字段是内部协议，不应该原样出现在聊天气泡里。
  const candidates = [
    trimmed,
    trimmed.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim(),
  ];

  // 某些运行时会在 JSON 前后带少量说明文字；只取最外层 JSON 对象再解析。
  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        parsed
        && typeof parsed === 'object'
        && 'answer' in parsed
        && typeof parsed.answer === 'string'
      ) {
        return parsed.answer.trim();
      }
    } catch {
      // 尝试下一个可能的 JSON 包装形式。
    }
  }

  // 流式阶段 JSON 尚未收完整时，不把内部协议刷到屏幕上。
  if (/"answer"\s*:/.test(trimmed) && /[{}]/.test(trimmed)) return '';

  return content;
}

function ChatMarkdown({ content }: { content: string }) {
  return (
    <XMarkdown
      content={displayAssistantContent(content)}
      components={markdownComponents}
      className="message-markdown x-markdown-light"
    />
  );
}

function ChatMessageMeta(props: { speaker: string; capturedAt: string }) {
  return (
    <div className="chat-message-meta">
      <Text strong>{props.speaker}</Text>
      <Text type="secondary">{formatTime(props.capturedAt)}</Text>
    </div>
  );
}

/** Agent 头像单独放在 Bubble 的 avatar 插槽，不进入回答气泡内容。
 * 这样头像可以按原始配置比例显示更大，而回答正文仍保持独立、可读的内容区域。
 */
function AssistantAvatar(props: {
  sessionName: string;
  control: InvestigationControl;
  avatarPath?: string;
}) {
  const width = Math.max(40, props.control.agent.avatarWidth || 180);
  const height = Math.max(40, props.control.agent.avatarHeight || 240);
  const avatarPath = props.avatarPath ?? props.control.agent.avatarPath;
  // avatarPath 是 workspace 相对路径；这里只取 UUID，不能把 .png 一起传给后端。
  const avatarId = avatarPath?.split('/').pop()?.replace(/\.png$/i, '');
  const avatarUrl = avatarPath === 'assistant/avatar.png'
    ? `/api/sessions/${encodeURIComponent(props.sessionName)}/assistant/avatar?v=${props.control.version}`
    : avatarId
      ? `/api/sessions/${encodeURIComponent(props.sessionName)}/assistant/avatar/${avatarId}?v=${props.control.version}`
      : undefined;
  return (
    <Avatar
      shape="square"
      src={avatarUrl}
      icon={<RobotOutlined />}
      style={{ width, height, objectFit: 'cover', flex: '0 0 auto' }}
    />
  );
}

function AssistantActionBar(props: {
  routeOptions: NonNullable<SessionContext['journeyPlan']>['routes'];
  followUpQuestions: string[];
  loading: boolean;
  onSelectRoute: (routeId: string) => void;
  onAsk: (question: string) => void;
}) {
  const routes = props.routeOptions.slice(0, 3);
  const questions = props.followUpQuestions.slice(0, 3);
  if (!routes.length && !questions.length) return null;

  return (
    <div className="assistant-action-bar">
      {routes.length ? (
        <>
          <Text type="secondary" className="assistant-action-label">下一步</Text>
          <Flex wrap gap={6}>
            {routes.map((route) => (
              <Button
                key={route.id}
                size="small"
                className="assistant-action-button"
                disabled={props.loading}
                onClick={() => props.onSelectRoute(route.id)}
              >
                {route.title}
              </Button>
            ))}
          </Flex>
        </>
      ) : null}
      {questions.length ? (
        <>
          <Text type="secondary" className="assistant-action-label">继续调查</Text>
          <Flex wrap gap={6}>
            {questions.map((question) => (
              <Button
                key={question}
                size="small"
                type="link"
                className="assistant-action-question"
                disabled={props.loading}
                onClick={() => props.onAsk(question)}
              >
                {question}
              </Button>
            ))}
          </Flex>
        </>
      ) : null}
    </div>
  );
}

function AppInner() {
  const routeInfo = () => {
    const match = window.location.pathname.match(/^\/investigations\/([^/]+)(?:\/(config|trajectory|journey))?\/?$/);
    return match
      ? { session: decodeURIComponent(match[1]), page: (match[2] ?? 'chat') as 'chat' | 'config' | 'trajectory' | 'journey' }
      : undefined;
  };

  const routeSession = () => routeInfo()?.session;
  const [page, setPage] = useState<'chat' | 'config' | 'trajectory' | 'journey'>(() => routeInfo()?.page ?? 'chat');
  const navigatePage = (nextPage: 'chat' | 'config' | 'trajectory' | 'journey') => {
    if (!active) return;
    const suffix = nextPage === 'chat' ? '' : '/' + nextPage;
    const nextPath = '/investigations/' + encodeURIComponent(active) + suffix;
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ session: active, page: nextPage }, '', nextPath);
    }
    setPage(nextPage);
  };

  const navigateToSession = (key: string, replace = false) => {
    const nextPath = '/investigations/' + encodeURIComponent(key);
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
    const avatarPaths = current?.control.agent.avatarPaths ?? (current?.control.agent.avatarPath ? [current.control.agent.avatarPath] : []);
    if (!sessionName || !avatarPaths.length) return;

    const storageKey = `ada.avatarAssignments.${sessionName}`;
    let stored: Record<string, string> = {};
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, string>;
      }
    } catch {
      // 本地存储不可用时仍然允许当前页面正常显示头像。
    }

    const assistantMessages = (current?.messages ?? []).filter((message) => message.role === 'assistant');
    const next = { ...stored };
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
  }, [current?.context.name, current?.control.agent.avatarPath, current?.control.agent.avatarPaths, current?.messages]);



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
      const routed = routeInfo();
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

  const bubbleItems = useMemo(() => {
    const messages = current?.messages ?? [];
    const lastAssistantIndex = messages.reduce(
      (lastIndex, message, index) => message.role === 'assistant' ? index : lastIndex,
      -1,
    );
    const items = messages.map((message, index) => {
      const guidance = message.role === 'assistant' && index === lastAssistantIndex
        ? nextGuidance
        : undefined;

      // 选了正式 Workflow 后，工作地图负责主导航；这里不再额外给一组可能互相冲突的小路线。
      // 没有 Workflow 的自主调查才显示 Agent 临时生成的少量建议。
      const showActions = !current?.context.workflow
        && message.role === 'assistant'
        && index === lastAssistantIndex
        && Boolean(guidance?.length || current?.context.journeyPlan?.routes.length);

      return {
        key: message.id,
        role: message.role,
        ...(message.role === 'assistant'
          ? {
              avatar: <AssistantAvatar sessionName={current!.context.name} control={current!.control} avatarPath={assistantAvatarByMessage[message.id]} />,
              // Bubble 的 avatar 外层默认有自己的尺寸；这里一起覆盖，否则大头像会被外层压缩。
              styles: {
                avatar: {
                  width: Math.max(40, current!.control.agent.avatarWidth || 180),
                  height: Math.max(40, current!.control.agent.avatarHeight || 240),
                  flex: '0 0 auto',
                  alignSelf: 'flex-start',
                },
              },
            }
          : {}),
        content:
          message.role === 'assistant' ? (
            <div className="assistant-message-content">
              <ChatMessageMeta
                speaker={current!.control.agent.displayName?.trim() || '秘书'}
                capturedAt={message.capturedAt}
              />
              {reasoningByMessage[message.id] ? (
                <Think
                  title="思考过程"
                  defaultExpanded={false}
                  loading={false}
                  className="assistant-think"
                >
                  <XMarkdown content={reasoningByMessage[message.id]} className="message-markdown x-markdown-light" />
                </Think>
              ) : null}
              <ChatMarkdown content={message.content} />
              {showActions ? (
                <AssistantActionBar
                  routeOptions={current?.context.journeyPlan?.routes ?? []}
                  followUpQuestions={guidance ?? []}
                  loading={loading}
                  onSelectRoute={(routeId) => void send(undefined, routeId)}
                  onAsk={(question) => void send(question, undefined, true)}
                />
              ) : null}
            </div>
          ) : (
            <div className="user-message-content">
              <ChatMessageMeta speaker="我" capturedAt={message.capturedAt} />
              <Typography.Text>{message.content}</Typography.Text>
            </div>
          ),
      };
    });

    const currentStreamingAnswer = streamingAnswer;
    if (currentStreamingAnswer && currentStreamingAnswer.key === active) {
      items.push({
        key: 'streaming-assistant',
        role: 'assistant',
        avatar: <AssistantAvatar sessionName={current!.context.name} control={current!.control} />,
        // 流式回答还没有持久化 message.id；显示当前配置中的随机头像即可。
        // 流式回答也必须同步调整 Bubble 的 avatar 外层尺寸。
        styles: {
          avatar: {
            width: Math.max(40, current!.control.agent.avatarWidth || 180),
            height: Math.max(40, current!.control.agent.avatarHeight || 240),
            flex: '0 0 auto',
            alignSelf: 'flex-start',
          },
        },
        content: (
          <div className="assistant-message-content">
            <ChatMessageMeta
              speaker={current!.control.agent.displayName?.trim() || '秘书'}
              capturedAt={new Date().toISOString()}
            />
            {streamingReasoning ? (
              <Think
                title="助手正在分析问题"
                loading
                defaultExpanded
                blink
                className="assistant-think"
              >
                <XMarkdown content={streamingReasoning} className="message-markdown x-markdown-light" />
              </Think>
            ) : null}
            {displayAssistantContent(currentStreamingAnswer.content)
              ? <ChatMarkdown content={currentStreamingAnswer.content} />
              : !streamingReasoning ? <Text type="secondary">助手正在整理答案，请稍候…</Text> : null}
          </div>
        ),
        footer: undefined,
      });
    }
    return items;
  }, [active, assistantAvatarByMessage, current?.context.journeyPlan?.routes, current?.messages, executionStatus.state, loading, nextGuidance, streamingAnswer]);

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

      setCurrent((existing) => existing ? {
        ...existing,
        messages: [
          ...existing.messages,
          {
            id: `${turnId}:user`,
            role: 'user',
            content: routeId
              ? '选择下一步：' + (selectedRoute?.title ?? routeId)
              : message,
            capturedAt: new Date().toISOString(),
          },
        ],
      } : existing);

      const response = await fetch(`/api/sessions/${encodeURIComponent(key as string)}/messages/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(routeId ? { routeId, turnId } : { message, guided, turnId }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || response.statusText);
      }

      let result: {
        answer: string;
        claimIds: string[];
        warnings: string[];
        unknowns: string[];
        followUpQuestions: string[];
      } | undefined;

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
        if (event === 'reasoning') {
          const delta = (data as { delta?: unknown }).delta;
          if (typeof delta === 'string') {
            setTurnStatus('助手正在分析你的问题，请稍候…');
            setStreamingReasoning((currentReasoning) => currentReasoning + delta);
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
      if (streamingReasoning.trim() && refreshed) {
        const lastAssistant = [...refreshed.messages].reverse().find((item) => item.role === 'assistant');
        if (lastAssistant) {
          setReasoningByMessage((items) => ({ ...items, [lastAssistant.id]: streamingReasoning }));
        }
      }

      const questions = Array.isArray(result.followUpQuestions)
        ? result.followUpQuestions
          .map((item) => typeof item === 'string' ? item.trim() : '')
          .filter(Boolean)
          .slice(0, 3)
        : [];
      setNextGuidance(questions);

      if (result.warnings.length) {
        setError(result.warnings.join('; '));
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
      setTurnStatus('助手正在处理你的问题，请稍候…');
      if (activeTurnRef.current?.turnId === turnId) activeTurnRef.current = undefined;
      setLoading(false);
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
        '请继续处理这条待查内容：',
        '',
        unknown,
        '',
        '请把它当成当前调查中的一个明确待办事项：先判断最有价值的下一步，能自动检索或检查的直接执行，不要只给我建议；把查到的证据纳入当前调查，明确哪些已经查清、哪些仍然未知，并根据结果重新给出下一步导引。',
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
      navigatePage('config');
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

  const attachmentItems = current?.context.inputs
    .filter((input) => input.kind === 'document')
    .map((input) => (
      <Tag key={input.id}>{input.title}</Tag>
    )) ?? [];

  if (!active || !current) {
    return (
      <Layout className="app-shell">
        <Content className="empty-app-page">
          <Empty description="还没有选择调查。请先从左侧创建或选择一个 Investigation。" />
        </Content>
      </Layout>
    );
  }

  if (page === 'config') {
    return (
      <Suspense fallback={pageLoadingFallback}>
        <div className="subpage-app">
          <InvestigationConfigPage
            sessionName={active}
            control={current.control}
            workflow={current.context.workflow ?? ''}
            onBack={() => navigatePage('chat')}
            onWorkflowChange={async (workflow) => {
              await changeWorkflow(workflow === '' ? null : workflow);
            }}
            onSaved={async () => {
              await loadSession(active);
            }}
          />
        </div>
      </Suspense>
    );
  }

  if (page === 'trajectory') {
    return (
      <Suspense fallback={pageLoadingFallback}>
        <div className="subpage-app">
          <AgentTrajectoryPage
            sessionName={active}
            onBack={() => navigatePage('chat')}
          />
        </div>
      </Suspense>
    );
  }

  if (page === 'journey') {
    return (
      <Suspense fallback={pageLoadingFallback}>
        <div className="subpage-app journey-map-subpage">
          <JourneyMap onBack={() => navigatePage('chat')} />
        </div>
      </Suspense>
    );
  }

  return (
    <Layout className={`app-shell${resizing ? ' is-resizing' : ''}`}>
      <Sider width={leftWidth} theme="light" className="session-sider">
        <div className="brand">
          <div className="brand-mark">DA</div>
          <div>
            <Text strong>现代化数据工作台</Text>
            <div><Text type="secondary">基于证据的调查</Text></div>
          </div>
        </div>

        <div className="sider-actions">
          <Button icon={<PlusOutlined />} type="primary" block onClick={() => setNewSessionOpen(true)}>
            新建调查
          </Button>
          <Button
            icon={<ReloadOutlined />}
            type="text"
            block
            onClick={() => reloadSessions(false).catch((e) => setError(e.message))}
          >
            刷新
          </Button>
        </div>

        {showLeftTip ? (
          <Alert
            className="sider-tip"
            type="info"
            showIcon
            closable
            icon={<InfoCircleOutlined />}
            title="每个调查都有自己的资料和设置。"
            onClose={() => {
              setShowLeftTip(false);
              try { localStorage.setItem('ada.tip.left', 'dismissed'); } catch {}
            }}
          />
        ) : null}

        <Conversations
          activeKey={active}
          onActiveChange={(key) => navigateToSession(key)}
          items={sessions.map((session) => ({
            key: session.key,
            label: session.label,
          }))}
          className="conversations"
        />
      </Sider>

      <div
        className="resize-handle resize-handle-left"
        role="separator"
        aria-label="调整会话栏宽度"
        onMouseDown={(event) => {
          event.preventDefault();
          setResizing('left');
        }}
      />

      <Layout>
        <Header className="topbar">
          <Flex justify="space-between" align="center" style={{ width: '100%' }}>
            <div className="topbar-title">
              <Text strong className="topbar-label">调查工作区</Text>
            </div>
            <Space>
              <Tag
                className="workspace-status"
                variant="filled"
                icon={(loading || executionStatus.running) ? <LoadingOutlined spin /> : undefined}
              >
                {loading ? turnStatus : executionStatusText(executionStatus)}
              </Tag>
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                disabled={!current?.messages.length}
                onClick={() => void copyConversation()}
              >
                复制对话
              </Button>
              <Button type="text" size="small" icon={<ToolOutlined />} onClick={() => navigatePage('trajectory')}>
                Agent 轨迹
              </Button>
              <Button type="text" size="small" icon={<SettingOutlined />} onClick={() => navigatePage('config')}>
                调查配置
              </Button>
              {current?.context.unknowns.length ? (
                <Tag
                  variant="filled"
                  color="orange"
                  className="clickable-status-tag"
                  role="button"
                  tabIndex={0}
                  onClick={() => setUnknownsOpen(true)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setUnknownsOpen(true);
                    }
                  }}
                >
                  待查内容 {current.context.unknowns.length}
                </Tag>
              ) : null}

            </Space>
          </Flex>
        </Header>

        <Content className="chat-layout">
          <div className="chat-main">
            {bubbleItems.length ? (
              <Bubble.List
                role={{
                  assistant: { placement: 'start' },
                  user: { placement: 'end' },
                }}
                items={bubbleItems}
                className="bubble-list"
              />
            ) : (
              <div className="empty-chat">
                <div className="empty-chat-inner">
                  <Text className="empty-chat-title">开始调查</Text>
                  <Text className="empty-chat-description">
                    直接写下你想查清楚的问题。需要时再上传资料或补充信息。
                  </Text>

                  <div className="starter-prompts">
                    {[
                      'Position 最终来自哪里？',
                      '梳理 Portfolio Market Value 的数据来源和转换过程。',
                      '这个系统现在有哪些地方还没查清楚？',
                    ].map((prompt) => (
                      <Button
                        key={prompt}
                        className="starter-prompt"
                        size="small"
                        onClick={() => send(prompt)}
                      >
                        {prompt}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {error ? (
              <Card size="small" className="error-card">
                <Text type="danger">{error}</Text>
              </Card>
            ) : null}

            {pendingPermissions.length ? (
              <div className="pending-permission-list">
                {pendingPermissions.map((permission) => {
                  const target =
                    permission.fullCommandText
                    ?? permission.fileName
                    ?? permission.path
                    ?? (permission.serverName && permission.toolName
                      ? `${permission.serverName} / ${permission.toolName}`
                      : permission.toolName
                        ?? permission.toolTitle);
                  return (
                    <Alert
                      key={permission.requestId}
                      type="warning"
                      showIcon
                      title={
                        <Flex align="center" justify="space-between" gap={8} wrap>
                          <span>Agent 需要执行操作</span>
                          <Tag color="orange">{permission.kind}</Tag>
                        </Flex>
                      }
                      description={
                        <Flex vertical gap={6}>
                          {permission.intention ? <Text>{permission.intention}</Text> : null}
                          {target ? <Text type="secondary"><code>{target}</code></Text> : null}
                          {permission.readOnly !== undefined ? (
                            <Text type="secondary">{permission.readOnly ? '只读操作' : '可能修改文件或数据'}</Text>
                          ) : null}
                          <Space>
                            <Button
                              type="primary"
                              size="small"
                              onClick={() => void respondToPermission(permission, true)}
                            >
                              允许这次
                            </Button>
                            {!permission.managedApprovalRequired ? (
                              <Button
                                size="small"
                                onClick={() => void respondToPermission(permission, true, 'session')}
                              >
                                后续都允许
                              </Button>
                            ) : null}
                            <Button
                              size="small"
                              danger
                              onClick={() => void respondToPermission(permission, false)}
                            >
                              拒绝
                            </Button>
                          </Space>
                        </Flex>
                      }
                    />
                  );
                })}
              </div>
            ) : null}
            {pendingUserInputs.length ? (
              <div className="pending-user-input-list">
                {pendingUserInputs.map((request) => {
                  const draft = userInputDrafts[request.requestId] ?? '';
                  return (
                    <Alert
                      key={request.requestId}
                      type="info"
                      showIcon
                      title="Agent 需要你的回答"
                      description={
                        <Flex vertical gap={8}>
                          <Text>{request.question}</Text>
                          {request.choices.length ? (
                            <Flex wrap gap={6}>
                              {request.choices.map((choice) => (
                                <Button
                                  key={choice}
                                  size="small"
                                  onClick={() => void respondToUserInput(request, choice, false)}
                                >
                                  {choice}
                                </Button>
                              ))}
                            </Flex>
                          ) : null}
                          {request.allowFreeform ? (
                            <Space.Compact style={{ width: '100%' }}>
                              <Input
                                value={draft}
                                onChange={(event) => setUserInputDrafts((values) => ({
                                  ...values,
                                  [request.requestId]: event.target.value,
                                }))}
                                onPressEnter={(event) => {
                                  event.preventDefault();
                                  void respondToUserInput(request, draft, true);
                                }}
                                placeholder="输入你的回答"
                              />
                              <Button
                                type="primary"
                                disabled={!draft.trim()}
                                onClick={() => void respondToUserInput(request, draft, true)}
                              >
                                提交
                              </Button>
                            </Space.Compact>
                          ) : null}
                        </Flex>
                      }
                    />
                  );
                })}
              </div>
            ) : null}
            <div className="composer">
              {attachmentItems.length ? (
                <div className="composer-files">
                  <Text type="secondary">本次调查中的文件</Text>
                  <Flex wrap gap={6}>{attachmentItems}</Flex>
                </div>
              ) : null}
              <Sender
                key={active ?? 'new-investigation'}
                value={value}
                onChange={(nextValue) => setValue(nextValue)}
                loading={loading}
                submitType="enter"
                onSubmit={(message) => { void send(message); }}
                onCancel={cancelActiveTurn}
                placeholder="可以询问数据资产、血缘、来源、转换、发现的问题或下一步分析"
                prefix={
                  <Tooltip title="上传文件">
                    <Button
                      type="text"
                      icon={<PaperClipOutlined />}
                      onClick={() => setAttachmentsOpen((open) => !open)}
                    />
                  </Tooltip>
                }
                footer={() => (
                  <Flex align="center" justify="space-between" gap={8} wrap className="sender-model-controls">
                    <Space size={4} wrap>
                      <Text type="secondary" className="sender-model-label">模型</Text>
                      <Select
                        size="small"
                        variant="borderless"
                        value={current.control.agent.model}
                        loading={!availableModels.length}
                        disabled={modelSaving || loading}
                        showSearch
                        optionFilterProp="label"
                        options={modelOptions.map((model) => ({
                          value: model.id,
                          label: model.id === 'auto' ? 'Auto（自动选择模型）' : model.name || model.id,
                        }))}
                        onChange={(model) => void updateModelSettings(model, model === 'auto' ? (current.control.agent.autoTier ?? null) : null)}
                        style={{ minWidth: 175 }}
                      />
                      {current.control.agent.model === 'auto' ? (
                        <>
                          <Text type="secondary" className="sender-model-label">自动选择</Text>
                          <Select
                            size="small"
                            variant="borderless"
                            value={current.control.agent.autoTier ?? ''}
                            disabled={modelSaving || loading}
                            options={[
                              { value: '', label: '默认' },
                              { value: 'efficiency', label: '省资源' },
                              { value: 'balance', label: '均衡' },
                              { value: 'intelligence', label: '能力优先' },
                              { value: 'fast', label: '最快' },
                            ]}
                            onChange={(tier: AutoTier | '') => void updateModelSettings('auto', tier || null)}
                            style={{ minWidth: 92 }}
                          />
                        </>
                      ) : null}
                    </Space>
                  </Flex>
                )}
                header={
                  <Sender.Header
                    title="文件"
                    open={attachmentsOpen}
                    onOpenChange={setAttachmentsOpen}
                    forceRender
                  >
                    <Attachments
                      beforeUpload={() => false}
                      items={attachments}
                      multiple
                      onChange={onAttachmentChange}
                      placeholder={(type) =>
                        type === 'drop'
                          ? { title: '把文件拖到这里' }
                          : {
                              icon: <FolderOpenOutlined />,
                              title: '上传调查文件',
                              description: '文件会保存在当前调查里，后面可以继续使用。',
                            }
                      }
                    />
                  </Sender.Header>
                }
                suffix={(_, { components }) => (
                  <components.SendButton
                    type="primary"
                    disabled={!value.trim() || loading}
                  />
                )}
              />
            </div>
          </div>

          <Divider orientation="vertical" className="content-divider" />

          <div
            className="right-panel-shell"
            style={{ width: rightWidth, flex: `0 0 ${rightWidth}px` }}
          >
            <div
              className="resize-handle resize-handle-right"
              role="separator"
              aria-label="调整工作区栏宽度"
              onMouseDown={(event) => {
                event.preventDefault();
                setResizing('right');
              }}
            />
            <aside className="context-panel">
              <div className="panel-header">
                <div>
                  <Text className="eyebrow">调查进展</Text>
                  <Text strong>当前阶段</Text>
                </div>
                <Tooltip title="调查设置">
                  <Button
                    type="text"
                    icon={<SettingOutlined />}
                    aria-label="调查设置"
                    onClick={() => navigatePage('config')}
                  />
                </Tooltip>
              </div>

              {journey?.stages.length ? (
                <section className="right-section right-journey">
                  <Flex className="right-section-heading" justify="space-between" align="center">
                    <Space size={6}>
                      <Text strong>地图导引</Text>
                      <Tag variant="filled">{current?.context.workflow ? '当前 Workflow' : '自主调查'}</Tag>
                    </Space>
                    <Button
                      type="link"
                      size="small"
                      icon={<FullscreenOutlined />}
                      disabled={loading}
                      onClick={() => navigatePage('journey')}
                    >
                      展开地图
                    </Button>
                  </Flex>
                  <div className="journey-map">
                    {journey.stages.map((stage, index) => (
                      <div
                        key={stage.id}
                        className={"journey-map-item journey-map-item-" + stage.status}
                      >
                        <div className="journey-map-rail" aria-hidden="true">
                          <span className="journey-map-dot" />
                          {index < journey.stages.length - 1 ? (
                            <span className="journey-map-line" />
                          ) : null}
                        </div>
                        <div className="journey-map-copy">
                          <Text
                            strong={stage.status === 'current'}
                            type={stage.status === 'locked' ? 'secondary' : undefined}
                          >
                            {stage.title}
                          </Text>
                          {stage.status === 'current' ? (
                            <Text type="secondary">{stage.objective}</Text>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="right-section right-current-state">
                <Flex className="right-section-heading" justify="space-between" align="center">
                  <Text strong>当前事实</Text>
                  {current?.context.unknowns.length ? (
                    <Button type="link" size="small" onClick={() => setUnknownsOpen(true)}>
                      查看待查
                    </Button>
                  ) : null}
                </Flex>
                {!current?.currentState ? (
                  <Text type="secondary">还没有形成完整的事实地图。主区会直接展示你和 Agent 的调查过程。</Text>
                ) : (
                  <>
                    <div className="right-facts">
                      <div className="right-fact">
                        <span className="right-fact-label">数据集</span>
                        <strong className="right-fact-value">{current.currentState.coverage.datasets}</strong>
                      </div>
                      <div className="right-fact">
                        <span className="right-fact-label">已连上线</span>
                        <strong className="right-fact-value">
                          {current.currentState.coverage.connectedDatasets}/{current.currentState.coverage.datasets}
                        </strong>
                      </div>
                      <div className="right-fact">
                        <span className="right-fact-label">业务定义</span>
                        <strong className="right-fact-value">
                          {current.currentState.coverage.semanticAssets ?? current.semanticAssets?.length ?? 0}
                        </strong>
                      </div>
                      <div className="right-fact">
                        <span className="right-fact-label">待查</span>
                        <strong className="right-fact-value">{current.context.unknowns.length}</strong>
                      </div>
                    </div>
                  </>
                )}
              </section>
            </aside>
          </div>
        </Content>
      </Layout>

      <Modal
        title="新建工作"
        open={newSessionOpen}
        onCancel={() => setNewSessionOpen(false)}
        onOk={createSession}
        okButtonProps={{ disabled: !newSessionName.trim() }}
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Input
            autoFocus
            value={newSessionName}
            onChange={(event) => setNewSessionName(event.target.value)}
            placeholder="工作名称，例如：portfolio-position-lineage"
          />
          <Input.TextArea
            value={newSessionGoal}
            onChange={(event) => setNewSessionGoal(event.target.value)}
            placeholder="先说清楚你想解决什么，例如：为什么两个系统的 Position 不一致？（可选）"
            autoSize={{ minRows: 3, maxRows: 6 }}
          />
          <Select
            value={newSessionWorkflow ?? ''}
            onChange={(value) => {
              setNewSessionWorkflow(value ? value as WorkflowId : null);
            }}
            options={workflowOptions.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            style={{ width: '100%' }}
          />
          <Alert
            className="modal-tip"
            type="info"
            showIcon
            title="默认自主调查。路线是可选的工作方法；开始后不会在首页随手切换，确需改变时到“调查配置 → 工作方式”执行明确调整。"
          />
        </Space>
      </Modal>

      <Modal
        title={
          <Flex align="center" gap={8}>
            <span>待查内容</span>
            <Tag variant="filled" color="orange">{current?.context.unknowns.length ?? 0} 项</Tag>
          </Flex>
        }
        open={unknownsOpen}
        onCancel={() => setUnknownsOpen(false)}
        footer={null}
        width={720}
        centered
      >
        <div className="unknown-items">
          {(current?.context.unknowns ?? []).map((unknown, index) => (
            <Card key={unknown + index} size="small" className="unknown-item-card">
              <div className="unknown-item-copy">
                <div className="unknown-item-index">待查 {index + 1}</div>
                <Text strong className="unknown-item-title">{unknown}</Text>
                <Text type="secondary" className="unknown-item-guidance">
                  导引：让 Agent 直接围绕这条未知项继续检索、核对 Evidence，并在完成后重新判断它是否已经查清。
                </Text>
              </div>
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                disabled={!active || loading}
                onClick={() => continueUnknown(unknown)}
              >
                让 Agent 继续查
              </Button>
            </Card>
          ))}
        </div>
      </Modal>

    </Layout>
  );
}

export function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <XProvider>
      <AntApp>
        <AppInner />
      </AntApp>
      </XProvider>
    </ConfigProvider>
  );
}