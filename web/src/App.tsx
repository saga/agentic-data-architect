import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
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
  SettingOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import {
  Attachments,
  Bubble,
  Conversations,
  Mermaid,
  Sender,
  XProvider,
} from '@ant-design/x';
import { XMarkdown } from '@ant-design/x-markdown';
import { JourneyMap } from './components/JourneyMap';
import { InvestigationConfigPage } from './components/InvestigationConfigPage';
import { AgentTrajectoryPage } from './components/AgentTrajectoryPage';
import zhCN from 'antd/locale/zh_CN';
import '@ant-design/x-markdown/themes/light.css';

const { Sider, Header, Content } = Layout;
const { Text, Title, Paragraph } = Typography;

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
      datasetLineageCoverage: number | null;
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
          <Text type="secondary" className="assistant-action-label">需要确认</Text>
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
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [turnStatus, setTurnStatus] = useState('助手正在处理你的问题，请稍候…');
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

  const loadSession = async (key: string, clearFirst = false) => {
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
  };

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

      return {
        key: message.id,
        role: message.role,
        content:
          message.role === 'assistant' ? (
            <div className="assistant-message-content">
              <ChatMarkdown content={message.content} />
              {guidance?.length || current?.context.journeyPlan?.routes.length ? (
                <AssistantActionBar
                  routeOptions={current?.context.journeyPlan?.routes ?? []}
                  followUpQuestions={guidance ?? []}
                  loading={loading}
                  onSelectRoute={(routeId) => void send(undefined, routeId)}
                  onAsk={(question) => void send(question)}
                />
              ) : null}
            </div>
          ) : (
            <Typography.Text>{message.content}</Typography.Text>
          ),
        footer:
          message.role === 'assistant'
            ? <Text type="secondary">{formatTime(message.capturedAt)}</Text>
            : undefined,
      };
    });

    const currentStreamingAnswer = streamingAnswer;
    if (currentStreamingAnswer && currentStreamingAnswer.key === active) {
      items.push({
        key: 'streaming-assistant',
        role: 'assistant',
        content: displayAssistantContent(currentStreamingAnswer.content)
          ? <ChatMarkdown content={currentStreamingAnswer.content} />
          : <Text type="secondary">助手正在整理答案，请稍候…</Text>,
        footer: undefined,
      });
    }
    return items;
  }, [active, current?.context.journeyPlan?.routes, current?.messages, loading, nextGuidance, streamingAnswer]);

  const cancelActiveTurn = () => {
    const activeTurn = activeTurnRef.current;
    if (!activeTurn) return;

    void fetch(`/api/sessions/${encodeURIComponent(activeTurn.key)}/messages/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: activeTurn.turnId }),
    }).catch(() => undefined);

    activeTurn.controller.abort();
  };

  const send = async (text?: string, routeId?: string) => {
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
        body: JSON.stringify(routeId ? { routeId, turnId } : { message, turnId }),
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
      if (activeRef.current === key) {
        await loadSession(key);
        await reloadSessions(false);
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
    );
  }

  if (page === 'trajectory') {
    return (
      <div className="subpage-app">
        <AgentTrajectoryPage sessionName={active} onBack={() => navigatePage('chat')} />
      </div>
    );
  }
  if (page === 'journey') {
    return (
      <div className="subpage-app journey-map-subpage">
        <JourneyMap onBack={() => navigatePage('chat')} />
      </div>
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
            message="每个调查都有自己的资料和设置。"
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
              <Tag className="workspace-status" bordered={false} icon={loading ? <LoadingOutlined spin /> : undefined}>
                {loading ? turnStatus : '可以继续提问'}
              </Tag>
              <Button type="text" size="small" icon={<ToolOutlined />} onClick={() => navigatePage('trajectory')}>
                Agent 轨迹
              </Button>
              <Button type="text" size="small" icon={<SettingOutlined />} onClick={() => navigatePage('config')}>
                调查配置
              </Button>
              {current?.context.unknowns.length ? (
                <Tag
                  bordered={false}
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
          <div className="chat-main">            {bubbleItems.length ? (
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

          <Divider type="vertical" className="content-divider" />

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
                  <Text className="eyebrow">工作进展</Text>
                  <Text strong>当前情况与下一步</Text>
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
                      <Tag bordered={false}>{current?.context.workflow ? '当前 Workflow' : '自主调查'}</Tag>
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
                <div className="right-section-heading"><Text strong>当前事实</Text></div>
                {!current?.currentState ? (
                  <Text type="secondary">还没有形成完整的事实地图。主区会优先展示 Agent 建议，你也可以直接提出真正想解决的问题。</Text>
                ) : (
                  <>
                    <div className="right-facts">
                      <span>数据集 {current.currentState.coverage.datasets}</span>
                      <span>数据来路 {current.currentState.coverage.datasetLineageCoverage == null ? '未统计' : Math.round(current.currentState.coverage.datasetLineageCoverage * 100) + '%'}</span>
                      <span>业务定义 {current.currentState.coverage.semanticAssets ?? current.semanticAssets?.length ?? 0}</span>
                      <span>待查 {current.context.unknowns.length}</span>
                    </div>                  </>
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
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
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
            message="默认自主调查。路线是可选的工作方法；开始后不会在首页随手切换，确需改变时到“调查配置 → 工作方式”执行明确调整。"
          />
        </Space>
      </Modal>

      <Modal
        title={
          <Flex align="center" gap={8}>
            <span>待查内容</span>
            <Tag bordered={false} color="orange">{current?.context.unknowns.length ?? 0} 项</Tag>
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