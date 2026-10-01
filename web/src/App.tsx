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
  Tabs,
  Tooltip,
  Typography,
} from 'antd';
import type { UploadFile } from 'antd';
import {
  FolderOpenOutlined,
  GithubOutlined,
  HistoryOutlined,
  LoadingOutlined,
  InfoCircleOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  SendOutlined,
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
    skills: Array<{ name: string; version: number }>;
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

type WorkflowId = 'legacy-modernization' | 'financial-ai-native-architecture';

interface SessionContext {
  name: string;
  workflow: WorkflowId;
  userPrompt: string;
  goal: string;
  scope: string[];
  systems: string[];
  evidence: unknown[];
  findings: Array<{ severity?: string; status?: string; title?: string }>;
  unknowns: string[];
  claims: unknown[];
  inputs: WorkspaceInput[];
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

interface SkillOption {
  name: string;
  description: string;
}

interface ModernizationGap {
  id: string;
  kind: string;
  title: string;
  description: string;
  severity: string;
  affectedAssets: string[];
  evidenceIds: string[];
  recommendation: string;
}

interface JourneyStage {
  id: string;
  title: string;
  objective: string;
  status: 'completed' | 'current' | 'locked' | 'future';
  nodeType: 'task' | 'gate' | 'review' | 'end' | 'stop';
  unlocked: boolean;
}

interface ModernizationPlan {
  id: string;
  title: string;
  status: string;
  goal: string;
  scope: string[];
  currentState: {
    datasets: number;
    lineageCoverage: number | null;
    parseFailures: number;
    semanticAssets: number;
    findings: number;
  };
  gaps: ModernizationGap[];
  analysisCases: Array<{
    title: string;
    question: string;
    steps: Array<{ title: string; status: string; action: string }>;
    conclusion?: string;
  }>;
  targetArchitecture: {
    principles: string[];
    components: Array<{ id: string; name: string; type: string; description: string; sourceAssets?: string[] }>;
    openQuestions: string[];
  };
  migrationStages: Array<{
    id: string;
    name: string;
    objective: string;
    outputs: string[];
    blockedByGapIds: string[];
  }>;
  mappings: Array<{
    id: string;
    title: string;
    sourceAsset: string;
    targetAsset: string;
    transformation?: string;
    businessRule?: string;
    validationRule?: string;
    status: string;
  }>;
  journey?: {
    workflowId: string;
    currentNodeId: string;
    completedNodeIds: string[];
    unlockedNodeIds: string[];
    stages: JourneyStage[];
  };
  validationPlan: {
    checks: Array<{
      id: string;
      type: string;
      name: string;
      description: string;
      status: string;
      blocking: boolean;
    }>;
    cutoverCriteria: string[];
    rollbackCriteria: string[];
  };
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

function cloneControl(control: InvestigationControl): InvestigationControl {
  return JSON.parse(JSON.stringify(control)) as InvestigationControl;
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

function parseMcpJson(value: string): InvestigationControl['agent']['mcpServers'] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('MCP 配置必须是 JSON 数组。');

  return parsed.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('每个 MCP Server 都必须是对象。');
    const server = item as Record<string, unknown>;
    const name = String(server.name ?? '').trim();
    const type = server.type === 'http' ? 'http' : 'local';
    if (!name) throw new Error('每个 MCP Server 都必须有名称。');
    return {
      name,
      version: Number(server.version ?? 1) || 1,
      enabled: server.enabled !== false,
      type,
      ...(typeof server.command === 'string' ? { command: server.command } : {}),
      ...(Array.isArray(server.args) ? { args: server.args.filter((item): item is string => typeof item === 'string') } : {}),
      ...(typeof server.url === 'string' ? { url: server.url } : {}),
      ...(Array.isArray(server.tools) ? { tools: server.tools.filter((item): item is string => typeof item === 'string') } : {}),
      ...(server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)
        ? { headers: Object.fromEntries(Object.entries(server.headers).filter(([key, value]) => typeof key === 'string' && typeof value === 'string')) }
        : {}),
    };
  });
}

function ChatMarkdown({ content }: { content: string }) {
  return (
    <XMarkdown
      content={content}
      components={markdownComponents}
      className="message-markdown x-markdown-light"
    />
  );
}

function FollowUpCard(props: {
  questions: string[];
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const primaryQuestion = props.questions[0];
  const suggestions = props.questions.slice(1, 3);

  return (
    <Card size="small" className="agent-guidance-card">
      <Flex vertical gap={8}>
        <Text strong className="agent-guidance-title">下一步</Text>
        <Text type="secondary" className="agent-guidance-question">{primaryQuestion}</Text>
        <Input.TextArea
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
          autoSize={{ minRows: 2, maxRows: 5 }}
          placeholder="把需要补充的信息写在这里，例如代码库地址、目录、文件名或业务定义。"
          disabled={props.loading}
        />
        <Flex justify="space-between" align="center" gap={8} wrap>
          <Space size={4} wrap>
            {suggestions.map((question) => (
              <Button
                key={question}
                type="link"
                size="small"
                className="agent-guidance-suggestion"
                onClick={() => props.onChange(question)}
                disabled={props.loading}
              >
                {question}
              </Button>
            ))}
          </Space>
          <Button
            type="primary"
            size="small"
            icon={<SendOutlined />}
            onClick={props.onSubmit}
            disabled={!props.value.trim() || props.loading}
          >
            继续
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}

function AppInner() {
  const routeSession = () => {
    const match = window.location.pathname.match(/^\/investigations\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : undefined;
  };

  const navigateToSession = (key: string, replace = false) => {
    const nextPath = `/investigations/${encodeURIComponent(key)}`;
    if (window.location.pathname !== nextPath) {
      if (replace) window.history.replaceState({ session: key }, '', nextPath);
      else window.history.pushState({ session: key }, '', nextPath);
    }
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
  const [nextGuidance, setNextGuidance] = useState<{ questions: string[]; value: string }>();
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionWorkflow, setNewSessionWorkflow] = useState<WorkflowId>('legacy-modernization');
  const [error, setError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('research');
  const [draft, setDraft] = useState<InvestigationControl>();
  const [mcpDraft, setMcpDraft] = useState('[]');
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);
  const [modernizationOpen, setModernizationOpen] = useState(false);
  const [modernizationLoading, setModernizationLoading] = useState(false);
  const [modernizationPlan, setModernizationPlan] = useState<ModernizationPlan>();
  const [journey, setJourney] = useState<ModernizationPlan['journey']>();
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
      setNextGuidance(undefined);
      setJourney(undefined);
      setAttachmentsOpen(false);
    }
    const [result, modernization, journeyResult] = await Promise.all([
      getJson<SessionData>(`/api/sessions/${encodeURIComponent(key)}`),
      getJson<{ plan: ModernizationPlan | null }>(`/api/sessions/${encodeURIComponent(key)}/modernization`),
      getJson<{ journey: ModernizationPlan['journey'] }>(`/api/sessions/${encodeURIComponent(key)}/journey`),
    ]);
    if (requestId !== loadRequestRef.current || key !== activeRef.current) return;
    setCurrent(result);
    setModernizationPlan(modernization.plan ?? undefined);
    setJourney(journeyResult.journey ?? modernization.plan?.journey);

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

  const loadModernization = async (key: string) => {
    setModernizationLoading(true);
    try {
      const result = await getJson<{ plan: ModernizationPlan }>(
        `/api/sessions/${encodeURIComponent(key)}/modernization?rebuild=true`,
      );
      setModernizationPlan(result.plan);
      setJourney(result.plan.journey);
      setModernizationOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法生成改造计划');
    } finally {
      setModernizationLoading(false);
    }
  };

  const handleModernizationAction = (gap?: ModernizationGap) => {
    setModernizationOpen(false);

    if (!gap) {
      void send(
        '先帮我查清楚这个系统现在的数据架构。重点查数据集、主要数据流、来源、SQL/ETL 转换和已有业务定义。先告诉我查到了什么、哪里还不知道，不要先设计新架构。',
      );
      return;
    }

    void send(
      [
        '先处理这个问题：',
        gap.title,
        '',
        gap.description,
        '',
        '建议先做：' + gap.recommendation,
        '',
        '请先做能自动完成的检查；需要我或业务人员确认的地方明确告诉我。完成后告诉我查到了什么、还缺什么，以及下一步做什么。',
      ].join('\n'),
    );
  };
  const loadSkills = async () => {
    try {
      const result = await getJson<{ skills: SkillOption[] }>('/api/skills');
      setSkillOptions(result.skills);
    } catch {
      // Skill discovery should not block the investigation UI.
    }
  };

  useEffect(() => {
    const onPopState = () => {
      const key = routeSession();
      if (key) setActive(key);
    };
    window.addEventListener('popstate', onPopState);
    reloadSessions().catch((e) => setError(e.message));
    loadSkills().catch(() => undefined);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    setStreamingAnswer(undefined);
    setNextGuidance(undefined);
    setModernizationPlan(undefined);
    setJourney(undefined);
    if (active) {
      loadSession(active, true).catch((e) => setError(e.message));
    } else {
      ++loadRequestRef.current;
      setCurrent(undefined);
    }
  }, [active]);

  useEffect(() => {
    if (settingsOpen && current?.control) {
      const next = cloneControl(current.control);
      setDraft(next);
      setMcpDraft(JSON.stringify(next.agent.mcpServers, null, 2));
    }
  }, [settingsOpen, current?.control]);

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
              {guidance?.questions.length ? (
                <FollowUpCard
                  questions={guidance.questions}
                  value={guidance.value}
                  loading={loading}
                  onChange={(value) => setNextGuidance((currentGuidance) => currentGuidance
                    ? { ...currentGuidance, value }
                    : currentGuidance)}
                  onSubmit={() => {
                    const nextValue = guidance.value.trim();
                    if (nextValue) void send(nextValue);
                  }}
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
        content: currentStreamingAnswer.content
          ? <ChatMarkdown content={currentStreamingAnswer.content} />
          : <Text type="secondary">助手正在处理你的问题，请稍候…</Text>,
        footer: undefined,
      });
    }
    return items;
  }, [active, current?.messages, loading, nextGuidance, streamingAnswer]);

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

  const send = async (text?: string) => {
    const message = (text ?? value).trim();
    if (!message || loading) return;

    setValue('');
    setNextGuidance(undefined);
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
            content: message,
            capturedAt: new Date().toISOString(),
          },
        ],
      } : existing);

      const response = await fetch(`/api/sessions/${encodeURIComponent(key as string)}/messages/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, turnId }),
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
      if (questions.length) {
        setNextGuidance({ questions, value: '' });
      }

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

  const createSession = async () => {
    const name = newSessionName.trim();
    if (!name) return;
    try {
      const created = await getJson<{ context: SessionContext }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, workflow: newSessionWorkflow }),
      });
      setNewSessionOpen(false);
      setNewSessionName('');
      setNewSessionWorkflow('legacy-modernization');
      await reloadSessions(false);
      navigateToSession(created.context.name);
      setTimeout(() => setSettingsOpen(true), 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法创建调查');
    }
  };

  const updateDraft = (mutator: (next: InvestigationControl) => void) => {
    setDraft((currentDraft) => {
      if (!currentDraft) return currentDraft;
      const next = cloneControl(currentDraft);
      mutator(next);
      return next;
    });
  };

  const saveSettings = async () => {
    if (!draft || !active) return;

    try {
      const mcpServers = parseMcpJson(mcpDraft);
      const result = await getJson<{ control: InvestigationControl }>(
        `/api/sessions/${encodeURIComponent(active)}/config`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            research: draft.research,
            agent: { ...draft.agent, mcpServers },
          }),
        },
      );

      setCurrent((existing) => existing ? { ...existing, control: result.control } : existing);
      setDraft(result.control);
      setMcpDraft(JSON.stringify(result.control.agent.mcpServers, null, 2));
      setSettingsOpen(false);
      await loadSession(active);
      toast.success(`配置已保存为 v${result.control.version}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Unable to save configuration');
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
              {current?.control ? <Tag bordered={false}>配置 v{current.control.version}</Tag> : null}
              {current?.context.evidence.length ? <Tag bordered={false} color="blue">证据 {current.context.evidence.length}</Tag> : null}
              {current?.context.findings.length ? <Tag bordered={false} color="gold">发现问题 {current.context.findings.length}</Tag> : null}
              {current?.context.unknowns.length ? <Tag bordered={false} color="orange">待查内容 {current.context.unknowns.length}</Tag> : null}

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
                    onClick={() => setSettingsOpen(true)}
                  />
                </Tooltip>
              </div>

              {current?.context.workflow === 'legacy-modernization' && journey?.stages.length ? (
                <section className="right-section right-journey">
                  <div className="right-section-heading">
                    <Text strong>路线</Text>
                  </div>
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

              <section className="right-section right-blocked">
                <div className="right-section-heading">
                  <Text strong>现在卡在哪里</Text>
                </div>
                {!current?.currentState ? (
                  <div className="right-blocked-card">
                    <Text strong>还没查清现有系统</Text>
                    <Text type="secondary">
                      先把数据、数据流、来源和已有业务定义查清楚，再决定怎么改。
                    </Text>
                    <Button
                      type="primary"
                      size="small"
                      loading={loading}
                      disabled={!active || loading}
                      onClick={() => handleModernizationAction()}
                    >
                      开始查现状
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="right-facts">
                      <span>数据集 {current.currentState.coverage.datasets}</span>
                      <span>
                        数据来路 {current.currentState.coverage.datasetLineageCoverage == null
                          ? "未统计"
                          : `${Math.round(current.currentState.coverage.datasetLineageCoverage * 100)}%`}
                      </span>
                      <span>业务定义 {current.currentState.coverage.semanticAssets ?? current.semanticAssets?.length ?? 0}</span>
                      <span>待查 {current.context.unknowns.length}</span>
                    </div>
                    {modernizationPlan?.gaps.length ? (
                      <div className="right-issues">
                        {modernizationPlan.gaps.slice(0, 2).map((gap) => (
                          <div key={gap.id} className="right-issue">
                            <Text strong ellipsis={{ tooltip: gap.title }}>{gap.title}</Text>
                            <Text type="secondary" ellipsis={{ tooltip: gap.recommendation }}>
                              {gap.recommendation}
                            </Text>
                            <Button
                              className="gap-action"
                              size="small"
                              type={gap.severity === "high" ? "primary" : "default"}
                              onClick={() => handleModernizationAction(gap)}
                            >
                              {gap.kind === "semantic" ? "去找业务定义" : gap.kind === "lineage" ? "去查数据流" : "去处理"}
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : current.context.findings.length ? (
                      <div className="right-issues">
                        {current.context.findings.slice(0, 2).map((finding, index) => (
                          <div key={finding.title ?? index} className="right-issue">
                            <Text strong>{finding.title || "有一个问题还需要确认"}</Text>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Text type="secondary">目前没有明显卡点，可以继续分析。</Text>
                    )}
                  </>
                )}
              </section>

              {current?.currentState ? (
                <section className="right-next">
                  <div className="right-section-heading">
                    <Text strong>下一步</Text>
                  </div>
                  {(() => {
                    const nextStage = journey?.stages.find(
                      (stage) => stage.status === 'current',
                    ) ?? journey?.stages.find((stage) => stage.status === 'future');

                    if (!nextStage) {
                      return <Text type="secondary">先完成当前检查，再决定下一步。</Text>;
                    }

                    return (
                      <div className="right-next-content">
                        <Text strong>{nextStage.title}</Text>
                        <Text type="secondary">{nextStage.objective}</Text>
                        <Button
                          size="small"
                          loading={modernizationLoading}
                          onClick={() => {
                            if (modernizationPlan) {
                              setModernizationOpen(true);
                            } else if (active) {
                              void loadModernization(active);
                            }
                          }}
                        >
                          {modernizationPlan ? '看完整方案' : '生成完整方案'}
                        </Button>
                      </div>
                    );
                  })()}
                </section>
              ) : null}
            </aside>
          </div>
        </Content>
      </Layout>

                  <Modal
        className="modernization-modal"
        title="完整改造方案"
        open={modernizationOpen}
        width={760}
        centered
        onCancel={() => setModernizationOpen(false)}
        footer={<Button onClick={() => setModernizationOpen(false)}>关闭</Button>}
      >
        {modernizationPlan && current?.currentState ? (
          <div className="plain-plan">
            <Text type="secondary">
              这里是详细方案。右侧已经显示当前卡点和直接操作，这里只看完整步骤和方案内容。
            </Text>

            <Card size="small" title="路线图">
              <div className="plan-stage-list">
                {(journey?.stages ?? modernizationPlan.journey?.stages ?? []).map((stage, index) => (
                  <div key={stage.id} className="plan-stage">
                    <Flex justify="space-between" gap={8}>
                      <Text strong>{index + 1}. {stage.title}</Text>
                      <Tag color={
                        stage.status === 'completed'
                          ? 'green'
                          : stage.status === 'current'
                            ? 'blue'
                            : stage.status === 'future'
                              ? 'default'
                              : 'default'
                      }>
                        {stage.status === 'completed' ? '已完成' : stage.status === 'current' ? '现在' : stage.status === 'future' ? '下一步' : '未解锁'}
                      </Tag>
                    </Flex>
                    <Text type="secondary">{stage.objective}</Text>
                  </div>
                ))}
              </div>
            </Card>

            <Card size="small" title="改造步骤">
              <div className="plan-stage-list">
                {modernizationPlan.migrationStages.map((stage, index) => (
                  <div key={stage.id} className="plan-stage">
                    <Text strong>{index + 1}. {stage.name}</Text>
                    <Text type="secondary">{stage.objective}</Text>
                    {stage.outputs.length ? (
                      <Text type="secondary">会产出：{stage.outputs.join("、")}</Text>
                    ) : null}
                  </div>
                ))}
              </div>
            </Card>

            <Card size="small" title="新的方案">
              <div className="plain-summary">
                {modernizationPlan.targetArchitecture.principles.slice(0, 5).map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
              {modernizationPlan.targetArchitecture.openQuestions.length ? (
                <div className="plan-open-questions">
                  <Text strong>还需要确认</Text>
                  {modernizationPlan.targetArchitecture.openQuestions.slice(0, 5).map((item) => (
                    <Text key={item} type="secondary">· {item}</Text>
                  ))}
                </div>
              ) : null}
            </Card>

            <Card size="small" title="后面还会做什么">
              <div className="plain-summary">
                <span>旧数据对应关系：<strong>{modernizationPlan.mappings.length}</strong> 条建议</span>
                <span>改造前检查：<strong>{modernizationPlan.validationPlan.checks.length}</strong> 项</span>
                <span>当前方案状态：<strong>草案</strong></span>
              </div>
            </Card>
          </div>
        ) : (
          <div className="plain-plan-empty">
            <Text strong>还不能查看完整方案</Text>
            <Text type="secondary">先在右侧把现有系统查清楚，再回来查看完整改造方案。</Text>
            <Button onClick={() => setModernizationOpen(false)}>回到调查</Button>
          </div>
        )}
      </Modal>
      <Modal
        title="新建工作"

        open={newSessionOpen}
        onCancel={() => setNewSessionOpen(false)}
        onOk={createSession}
        okButtonProps={{ disabled: !newSessionName.trim() }}
      >
        <Radio.Group
          value={newSessionWorkflow}
          onChange={(event) => setNewSessionWorkflow(event.target.value as WorkflowId)}
          className="new-workflow-choice"
        >
          <Space direction="vertical" size={8}>
            <Radio value="legacy-modernization">改造已有系统</Radio>
            <Radio value="financial-ai-native-architecture">从零设计金融 AI / 数据架构</Radio>
          </Space>
        </Radio.Group>
        <Divider />
        <Input
          autoFocus
          value={newSessionName}
          onChange={(event) => setNewSessionName(event.target.value)}
          placeholder="例如：portfolio-research-agent"
          onPressEnter={createSession}
        />
        <Alert
          className="modal-tip"
          type="info"
          showIcon
          message="路线只决定工作的大阶段；每一阶段里，助手仍会自己调查、分析和调用工具。"
        />
      </Modal>

      <Modal
        className="settings-modal"
        title={
          <Flex align="center" gap={8}>
            <SettingOutlined />
            <span>调查配置</span>
            {draft ? <Tag>v{draft.version}</Tag> : null}
          </Flex>
        }
        open={settingsOpen}
        width={1000}
        centered
        onCancel={() => setSettingsOpen(false)}
        onOk={saveSettings}
        okText="保存修改"
        destroyOnClose
      >
        {draft ? (
          <Tabs
            tabPosition="left"
            activeKey={settingsTab}
            onChange={setSettingsTab}
            className="settings-tabs"
            items={[
              {
                key: 'research',
                label: <span><GithubOutlined /> 研究范围</span>,
                children: (
                  <div className="settings-page">
                    <div className="settings-page-header">
                      <Title level={4}>研究范围</Title>
                      <Paragraph type="secondary">
                        定义调查范围，以及哪些资料应该优先使用。
                      </Paragraph>
                    </div>

                    <Card className="settings-card" title="GitHub 仓库">
                      <Paragraph type="secondary">
                        添加与调查相关的仓库；可以只搜索这些仓库，也可以在必要时扩大范围。
                      </Paragraph>
                      <Select
                        mode="tags"
                        style={{ width: '100%' }}
                        tokenSeparators={[',']}
                        value={draft.research.githubRepositories}
                        placeholder="https://github.com/org/repo"
                        onChange={(value) => updateDraft((next) => { next.research.githubRepositories = value; })}
                      />
                      <div className="field-label">搜索范围</div>
                      <Radio.Group
                        value={draft.research.githubSearchMode}
                        onChange={(event) => updateDraft((next) => { next.research.githubSearchMode = event.target.value; })}
                        optionType="button"
                        buttonStyle="solid"
                        options={[
                          { value: 'only_selected', label: '仅搜索已选仓库' },
                          { value: 'selected_and_broad', label: '先搜索已选仓库，再扩大范围' },
                        ]}
                      />
                    </Card>

                    <Card className="settings-card" title="研究关键词">
                      <Paragraph type="secondary">希望 Agent 主动关注的重要业务或技术术语。</Paragraph>
                      <Select
                        mode="tags"
                        style={{ width: '100%' }}
                        tokenSeparators={[',']}
                        value={draft.research.keywords}
                        placeholder="例如：持仓、证券主数据、代理投票..."
                        onChange={(value) => updateDraft((next) => { next.research.keywords = value; })}
                      />
                    </Card>

                    <Card className="settings-card" title="重要文档">
                      <Paragraph type="secondary">文档 that should receive priority when interpreting the investigation.</Paragraph>
                      <Select
                        mode="tags"
                        style={{ width: '100%' }}
                        tokenSeparators={[',']}
                        value={draft.research.importantDocuments.map((item) => item.reference)}
                        options={documentReferences(current?.context).map((reference) => ({ label: reference, value: reference }))}
                        placeholder="选择已上传文件，或输入 URL / 路径"
                        onChange={(references) => updateDraft((next) => {
                          next.research.importantDocuments = references.map((reference) => ({
                            id: reference,
                            title: reference.split('/').pop() || reference,
                            reference,
                          }));
                        })}
                      />
                    </Card>
                  </div>
                ),
              },
              {
                key: 'agent',
                label: <span><ToolOutlined /> 技能与指导</span>,
                children: (
                  <div className="settings-page">
                    <div className="settings-page-header">
                      <Title level={4}>技能与指导</Title>
                      <Paragraph type="secondary">
                        选择可复用技能，并补充本次调查特有的指导信息。
                      </Paragraph>
                    </div>

                    <Card className="settings-card" title="技能">
                      <Flex justify="space-between" align="center" className="settings-card-heading">
                        <Text strong>已启用技能</Text>
                        <Tag>有版本管理</Tag>
                      </Flex>
                      <Paragraph type="secondary">
                        技能是独立、可复用的任务模块；选择本次调查需要使用的技能。
                      </Paragraph>
                      <Select
                        mode="multiple"
                        style={{ width: '100%' }}
                        value={draft.agent.skills.map((item) => item.name)}
                        options={skillOptions.map((skill) => ({
                          label: skill.name,
                          value: skill.name,
                          title: skill.description,
                        }))}
                        onChange={(names) => updateDraft((next) => {
                          next.agent.skills = names.map((name) => ({
                            name,
                            version: next.agent.skills.find((item) => item.name === name)?.version ?? 1,
                          }));
                        })}
                      />
                      <div className="selected-skill-list">
                        {draft.agent.skills.map((skill) => {
                          const option = skillOptions.find((item) => item.name === skill.name);
                          return (
                            <div key={skill.name} className="selected-skill">
                              <div className="selected-skill-main">
                                <Text strong>{skill.name}</Text>
                                {option?.description ? <Text type="secondary">{option.description}</Text> : null}
                              </div>
                              <Tag>v{skill.version}</Tag>
                            </div>
                          );
                        })}
                      </div>
                    </Card>

                    <Card className="settings-card" title="额外指导">
                      <Flex justify="space-between" align="center" className="settings-card-heading">
                        <Text strong>本次调查指导</Text>
                        <Tag>v{draft.agent.systemPrompt.version}</Tag>
                      </Flex>
                      <Paragraph type="secondary">
                        可以补充术语、工作方式和调查背景；内置的 Evidence 与安全规则不在这里修改。
                      </Paragraph>
                      <Input.TextArea
                        autoSize={{ minRows: 8, maxRows: 18 }}
                        value={draft.agent.systemPrompt.content}
                        placeholder="例如：解释投票指令时，把代理投票政策文档作为主要业务依据。"
                        onChange={(event) => updateDraft((next) => { next.agent.systemPrompt.content = event.target.value; })}
                      />
                    </Card>
                  </div>
                ),
              },
              {
                key: 'mcp',
                label: <span><ToolOutlined /> MCP</span>,
                children: (
                  <div className="settings-page">
                    <div className="settings-page-header">
                      <Title level={4}>MCP 连接</Title>
                      <Paragraph type="secondary">
                        Add MCP servers used by this investigation. 修改会保留版本，并记录操作记录。
                      </Paragraph>
                    </div>
                    <Card className="settings-card" title="服务器">
                      <Alert
                        type="warning"
                        showIcon
                        message="密钥不会保存到 control.json"
                        description="请把访问令牌和凭证保存在运行环境或 MCP 服务的安全配置中。"
                      />
                      <Input.TextArea
                        className="mcp-editor"
                        rows={18}
                        value={mcpDraft}
                        onChange={(event) => setMcpDraft(event.target.value)}
                        spellCheck={false}
                      />
                    </Card>
                  </div>
                ),
              },
              {
                key: 'history',
                label: <span><HistoryOutlined /> 版本历史</span>,
                children: (
                  <div className="settings-page">
                    <div className="settings-page-header">
                      <Title level={4}>版本历史</Title>
                      <Paragraph type="secondary">
                        查看影响本次调查的历史配置版本。
                      </Paragraph>
                    </div>
                    <div className="version-list">
                      {[...draft.history].reverse().slice(0, 12).map((item) => (
                        <Card key={item.version} size="small" className="version-card">
                          <Flex justify="space-between" gap={12}>
                            <div>
                              <Text strong>配置 v{item.version}</Text>
                              <div><Text type="secondary">{item.reason}</Text></div>
                            </div>
                            <Text type="secondary">{formatTime(item.updatedAt)}</Text>
                          </Flex>
                        </Card>
                      ))}
                    </div>
                  </div>
                ),
              },
            ]}
          />
        ) : null}
      </Modal>

      <Modal
        title="调查活动"
        open={auditOpen}
        width={760}
        footer={null}
        onCancel={() => setAuditOpen(false)}
      >
        <Flex vertical gap={12}>
          {(current?.recentAudit ?? []).map((event) => (
            <Card key={event.id} size="small">
              <Flex justify="space-between" align="start" gap={16}>
                <div>
                  <Text strong>{event.summary}</Text>
                  <div><Text type="secondary">{event.action}</Text></div>
                  {event.configurationVersion ? <Tag className="audit-version">配置 v{event.configurationVersion}</Tag> : null}
                </div>
                <Text type="secondary">{formatTime(event.timestamp)}</Text>
              </Flex>
            </Card>
          ))}
          {!current?.recentAudit.length ? <Empty description="暂无审计记录。" /> : null}
          <Text type="secondary">
            结构化审计记录保存在当前调查工作区的 audit.jsonl。
          </Text>
        </Flex>
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
