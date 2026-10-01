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

interface SessionContext {
  name: string;
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
  const [turnStatus, setTurnStatus] = useState('思考中…');
  const [streamingAnswer, setStreamingAnswer] = useState<{ key: string; content: string }>();
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
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
      setAttachmentsOpen(false);
    }
    const [result, modernization] = await Promise.all([
      getJson<SessionData>(`/api/sessions/${encodeURIComponent(key)}`),
      getJson<{ plan: ModernizationPlan | null }>(`/api/sessions/${encodeURIComponent(key)}/modernization`),
    ]);
    if (requestId !== loadRequestRef.current || key !== activeRef.current) return;
    setCurrent(result);
    setModernizationPlan(modernization.plan ?? undefined);

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
      setModernizationOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法生成改造计划');
    } finally {
      setModernizationLoading(false);
    }
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
    setModernizationPlan(undefined);
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
    const items = (current?.messages ?? []).map((message) => ({
      key: message.id,
      role: message.role,
      content:
        message.role === 'assistant' ? (
          <ChatMarkdown content={message.content} />
        ) : (
          <Typography.Text>{message.content}</Typography.Text>
        ),
      footer:
        message.role === 'assistant'
          ? <Text type="secondary">{formatTime(message.capturedAt)}</Text>
          : undefined,
    }));

    const currentStreamingAnswer = streamingAnswer;
    if (currentStreamingAnswer && currentStreamingAnswer.key === active) {
      items.push({
        key: 'streaming-assistant',
        role: 'assistant',
        content: currentStreamingAnswer.content
          ? <ChatMarkdown content={currentStreamingAnswer.content} />
          : <Text type="secondary">思考中…</Text>,
        footer: undefined,
      });
    }
    return items;
  }, [active, current?.messages, streamingAnswer]);

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
    setLoading(true);
    setTurnStatus('思考中…');
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
            id: `local-user-${turnId}`,
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
      } | undefined;

      await consumeSse(response, ({ event, data }) => {
        if (event === 'started') {
          setTurnStatus('思考中…');
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
          setTurnStatus('正在生成答案…');
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

      setTurnStatus('正在保存结果…');
      if (activeRef.current === key) {
        await loadSession(key);
        await reloadSessions(false);
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
      setTurnStatus('思考中…');
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
        body: JSON.stringify({ name }),
      });
      setNewSessionOpen(false);
      setNewSessionName('');
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
      toast.error(e instanceof Error ? e.message : 'Upload failed');
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
              <Title level={4} style={{ margin: 0 }}>
                {current?.context.userPrompt || current?.context.name || '新建调查'}
              </Title>
              <Text type="secondary">
                {current?.context.name || '直接输入你想查清楚的问题'}
              </Text>
            </div>
            <Space>
              <Tag className="workspace-status" bordered={false} icon={loading ? <LoadingOutlined spin /> : undefined}>
                {loading ? turnStatus : '就绪'}
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
                              description: '文件会保存到当前调查工作区，并登记到 context.json。',
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
                  <Text className="eyebrow">调查</Text>
                  <Title level={5} style={{ margin: '3px 0 0' }}>{current?.context.name || '—'}</Title>
                </div>
                <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
                  设置
                </Button>
              </div>

              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <Text strong>目标</Text>
                    <Text type="secondary" className="section-subtitle">这次调查要回答什么</Text>
                  </div>
                </div>
                <Paragraph
                  ellipsis={{ rows: 5, tooltip: current?.context.goal || current?.context.userPrompt }}
                  style={{ marginBottom: 0 }}
                >
                  {current?.context.goal || current?.context.userPrompt || '还没有定义目标。'}
                </Paragraph>
              </section>

              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <Text strong>资料来源</Text>
                    <Text type="secondary" className="section-subtitle">Agent 当前可用的上下文</Text>
                  </div>
                </div>
                <div className="status-line">
                  <Text type="secondary">文档</Text>
                  <Text>{current?.context.inputs.filter((input) => input.kind === 'document').length ?? 0}</Text>
                </div>
                <div className="status-line">
                  <Text type="secondary">仓库</Text>
                  <Text>{current?.control?.research.githubRepositories.length ?? 0}</Text>
                </div>
                <div className="status-line">
                  <Text type="secondary">关键词</Text>
                  <Text>{current?.control?.research.keywords.length ?? 0}</Text>
                </div>
              </section>

              <section className="panel-section modern-panel-card">
                <div className="section-heading">
                  <div>
                    <Text strong>改造计划</Text>
                    <Text type="secondary" className="section-subtitle">帮你看清现在的情况，再决定下一步做什么</Text>
                  </div>
                </div>
                <Flex vertical gap={9}>
                  <Text type="secondary">
                    这里不讲一堆技术名词，只告诉你：现在知道什么、先解决什么、下一步做什么。
                  </Text>
                  <Button
                    type="primary"
                    ghost
                    loading={modernizationLoading}
                    disabled={!active}
                    onClick={() => active && void loadModernization(active)}
                  >
                    {modernizationPlan ? '看下一步' : '生成改造计划'}
                  </Button>

                </Flex>
              </section>

              <section className="panel-section modern-panel-card">
                <div className="section-heading">
                  <div>
                    <Text strong>现在知道什么</Text>
                    <Text type="secondary" className="section-subtitle">哪些已经查清，哪些还不知道</Text>
                  </div>
                </div>
                <div className="coverage-grid compact">
                  <div><span>{current?.currentState?.coverage.datasets ?? 0}</span><Text type="secondary">数据集</Text></div>
                  <div><span>{current?.context.findings.length ?? 0}</span><Text type="secondary">发现问题</Text></div>
                  <div><span>{current?.context.unknowns.length ?? 0}</span><Text type="secondary">待查内容</Text></div>
                  <div>
                    <span>{current?.currentState?.coverage.datasetLineageCoverage == null ? '—' : `${(current.currentState.coverage.datasetLineageCoverage * 100).toFixed(0)}%`}</span>
                    <Text type="secondary">数据来路</Text>
                  </div>
                  <div><span>{current?.currentState?.coverage.semanticAssets ?? current?.semanticAssets?.length ?? 0}</span><Text type="secondary">业务定义</Text></div>
                  <div><span>{current?.currentState?.coverage.sqlParseFailures ?? 0}</span><Text type="secondary">SQL 解析失败</Text></div>
                </div>
              </section>

              <section className="panel-section modern-panel-card">
                <div className="section-heading">
                  <div>
                    <Text strong>下一步要解决</Text>
                    <Text type="secondary" className="section-subtitle">优先处理会阻塞目标设计的问题</Text>
                  </div>
                </div>
                {modernizationPlan?.gaps.length ? (
                  <Flex vertical gap={8}>
                    {modernizationPlan.gaps.slice(0, 5).map((gap) => (
                      <div key={gap.id} className="modern-gap-row">
                        <Flex justify="space-between" gap={8}>
                          <Text strong>{gap.title}</Text>
                          <Tag color={gap.severity === 'high' ? 'red' : gap.severity === 'medium' ? 'orange' : undefined}>
                            {gap.severity === 'high' ? '高' : gap.severity === 'medium' ? '中' : '低'}
                          </Tag>
                        </Flex>
                        <Text type="secondary">{gap.recommendation}</Text>
                      </div>
                    ))}
                  </Flex>
                ) : (
                  <Text type="secondary">
                    目前还没有整理出下一步要处理的问题。先把现有系统查清楚。
                  </Text>
                )}
              </section>

              <section className="panel-section modern-panel-card">
                <div className="section-heading">
                  <div>
                    <Text strong>资料与能力</Text>
                    <Text type="secondary" className="section-subtitle">Agent 当前能够使用的上下文</Text>
                  </div>
                </div>
                <div className="status-line"><Text type="secondary">文档</Text><Text>{current?.context.inputs.filter((input) => input.kind === 'document').length ?? 0}</Text></div>
                <div className="status-line"><Text type="secondary">GitHub 仓库</Text><Text>{current?.control?.research.githubRepositories.length ?? 0}</Text></div>
                <div className="status-line"><Text type="secondary">关键词</Text><Text>{current?.control?.research.keywords.length ?? 0}</Text></div>
                <div className="status-line"><Text type="secondary">技能</Text><Text>{current?.control?.agent.skills.length ?? 0}</Text></div>
                <div className="status-line"><Text type="secondary">MCP</Text><Text>{current?.control?.agent.mcpServers.filter((item) => item.enabled).length ?? 0}</Text></div>
              </section>

              <Text type="secondary" className="panel-updated">
                配置 v{current?.control?.version ?? 1}
                {' · '}
                最近更新 {current ? formatTime(current.context.updatedAt) : '—'}
              </Text>
            </aside>
          </div>
        </Content>
      </Layout>

      <Modal
        className="modernization-modal"
        title="改造计划"
        open={modernizationOpen}
        width={760}
        centered
        onCancel={() => setModernizationOpen(false)}
        footer={[
          <Button key="close" onClick={() => setModernizationOpen(false)}>关闭</Button>,
          <Button
            key="refresh"
            type="primary"
            loading={modernizationLoading}
            onClick={() => active && void loadModernization(active)}
          >
            重新看看现在的情况
          </Button>,
        ]}
      >
        {modernizationPlan ? (
          <div className="plain-plan">
            <div className="plain-plan-intro">
              <Title level={4} style={{ marginBottom: 4 }}>{modernizationPlan.title}</Title>
              <Text type="secondary">
                {modernizationPlan.goal || '这次要把现有的数据系统查清楚，再决定怎么改。'}
              </Text>
            </div>

            <Card size="small" title="现在知道什么">
              <div className="plain-summary">
                <span>已经找到 <strong>{modernizationPlan.currentState.datasets}</strong> 个数据集</span>
                <span>发现了 <strong>{modernizationPlan.currentState.findings}</strong> 个问题</span>
                <span>还有 <strong>{modernizationPlan.currentState.parseFailures}</strong> 个 SQL 没有看懂</span>
                <span>
                  血缘覆盖
                  <strong>
                    {modernizationPlan.currentState.lineageCoverage === null ? '还不知道' : ` ${Math.round(modernizationPlan.currentState.lineageCoverage * 100)}%`}
                  </strong>
                </span>
                <span>找到 <strong>{modernizationPlan.currentState.semanticAssets}</strong> 条业务定义或指标信息</span>
              </div>
            </Card>

            <Card size="small" title="先解决什么">
              {modernizationPlan.gaps.length ? (
                <Flex vertical gap={10}>
                  {modernizationPlan.gaps.slice(0, 4).map((gap, index) => (
                    <div key={gap.id} className="plain-plan-item">
                      <Flex justify="space-between" align="start" gap={10}>
                        <Text strong>{index + 1}. {gap.title}</Text>
                        <Tag color={gap.severity === 'high' ? 'red' : gap.severity === 'medium' ? 'orange' : undefined}>
                          {gap.severity === 'high' ? '先处理' : gap.severity === 'medium' ? '需要确认' : '可以后做'}
                        </Tag>
                      </Flex>
                      <Text type="secondary">{gap.recommendation}</Text>
                    </div>
                  ))}
                </Flex>
              ) : (
                <Text>目前没有发现明显的阻塞问题，可以开始讨论怎么改。</Text>
              )}
            </Card>

            <Card size="small" title="下一步怎么做">
              {(() => {
                const nextStage = modernizationPlan.migrationStages.find((stage) => stage.blockedByGapIds.length === 0)
                  ?? modernizationPlan.migrationStages[0];
                if (!nextStage) {
                  return <Text>暂时没有下一步建议。</Text>;
                }
                return (
                  <div className="plain-plan-next">
                    <Text strong>{nextStage.name}</Text>
                    <Paragraph style={{ margin: "4px 0 8px" }}>{nextStage.objective}</Paragraph>
                    {nextStage.outputs.length ? (
                      <Text type="secondary">这一步会产出：{nextStage.outputs.join("、")}</Text>
                    ) : null}
                  </div>
                );
              })()}
            </Card>

            <Text type="secondary" className="plain-plan-note">
              这里的内容是系统根据已经查到的资料整理出来的草案，不是最终决定。确认后再进入下一步。
            </Text>
          </div>
        ) : (
          <Empty description="还没有生成改造计划。先完成一次调查。" />
        )}
      </Modal>
      <Modal
        title="新建调查"
        open={newSessionOpen}
        onCancel={() => setNewSessionOpen(false)}
        onOk={createSession}
        okButtonProps={{ disabled: !newSessionName.trim() }}
      >
        <Input
          autoFocus
          value={newSessionName}
          onChange={(event) => setNewSessionName(event.target.value)}
          placeholder="例如：portfolio-modernization"
          onPressEnter={createSession}
        />
        <Alert
          className="modal-tip"
          type="info"
          showIcon
          message="创建后可以继续配置仓库、研究关键词、文档、技能、MCP 和额外指导。"
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
