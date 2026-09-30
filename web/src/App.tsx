import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
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
  CheckCircleOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GithubOutlined,
  HistoryOutlined,
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
  Welcome,
  XProvider,
} from '@ant-design/x';
import { XMarkdown } from '@ant-design/x-markdown';
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
}

interface SkillOption {
  name: string;
  description: string;
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

function documentReferences(context?: SessionContext): string[] {
  return (context?.inputs ?? [])
    .filter((input) => input.kind === 'document' && input.artifactPath)
    .map((input) => input.artifactPath as string);
}

function parseMcpJson(value: string): InvestigationControl['agent']['mcpServers'] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('MCP configuration must be a JSON array.');

  return parsed.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Each MCP server must be an object.');
    const server = item as Record<string, unknown>;
    const name = String(server.name ?? '').trim();
    const type = server.type === 'http' ? 'http' : 'local';
    if (!name) throw new Error('Each MCP server needs a name.');
    return {
      name,
      version: Number(server.version ?? 1) || 1,
      enabled: server.enabled !== false,
      type,
      ...(typeof server.command === 'string' ? { command: server.command } : {}),
      ...(Array.isArray(server.args) ? { args: server.args.filter((item): item is string => typeof item === 'string') } : {}),
      ...(typeof server.url === 'string' ? { url: server.url } : {}),
      ...(Array.isArray(server.tools) ? { tools: server.tools.filter((item): item is string => typeof item === 'string') } : {}),
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
  const { message: toast } = AntApp.useApp();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [active, setActive] = useState<string>();
  const [current, setCurrent] = useState<SessionData>();
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [error, setError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('research');
  const [draft, setDraft] = useState<InvestigationControl>();
  const [mcpDraft, setMcpDraft] = useState('[]');
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [attachments, setAttachments] = useState<UploadFile[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<Set<string>>(new Set());
  const [leftWidth, setLeftWidth] = useState(270);
  const [rightWidth, setRightWidth] = useState(330);
  const [resizing, setResizing] = useState<'left' | 'right' | null>(null);
  const [showLeftTip, setShowLeftTip] = useState(() => {
    try { return localStorage.getItem('ada.tip.left') !== 'dismissed'; } catch { return true; }
  });
  const [showRightTip, setShowRightTip] = useState(() => {
    try { return localStorage.getItem('ada.tip.right') !== 'dismissed'; } catch { return true; }
  });

  const reloadSessions = async (selectLatest = true) => {
    const result = await getJson<{ sessions: SessionSummary[] }>('/api/sessions');
    setSessions(result.sessions);
    if (selectLatest && !active && result.sessions[0]) {
      setActive(result.sessions[0].key);
    }
  };

  const loadSession = async (key: string) => {
    setError(undefined);
    const result = await getJson<SessionData>(`/api/sessions/${encodeURIComponent(key)}`);
    setCurrent(result);

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

  const loadSkills = async () => {
    try {
      const result = await getJson<{ skills: SkillOption[] }>('/api/skills');
      setSkillOptions(result.skills);
    } catch {
      // Skill discovery should not block the investigation UI.
    }
  };

  useEffect(() => {
    reloadSessions().catch((e) => setError(e.message));
    loadSkills().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (active) loadSession(active).catch((e) => setError(e.message));
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

  const bubbleItems = useMemo(
    () =>
      (current?.messages ?? []).map((message) => ({
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
      })),
    [current?.messages],
  );

  const send = async (text?: string) => {
    const message = (text ?? value).trim();
    if (!message || loading) return;

    setValue('');
    setLoading(true);
    setError(undefined);

    try {
      let key = active;
      if (!key) {
        const created = await getJson<{ context: SessionContext }>('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userPrompt: message }),
        });
        key = created.context.name;
        setActive(key);
      }

      const result = await getJson<{
        answer: string;
        claimIds: string[];
        warnings: string[];
        unknowns: string[];
      }>(`/api/sessions/${encodeURIComponent(key)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });

      await loadSession(key);
      await reloadSessions(false);

      if (result.warnings.length) {
        setError(result.warnings.join('; '));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
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
      setActive(created.context.name);
      setTimeout(() => setSettingsOpen(true), 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create session');
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
      toast.success(`Configuration saved as v${result.control.version}`);
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
      toast.success(`Uploaded ${result.file.name}`);
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
            <Text strong>Agentic Data Architect</Text>
            <div><Text type="secondary">Evidence-first investigation</Text></div>
          </div>
        </div>

        <div className="sider-actions">
          <Button icon={<PlusOutlined />} type="primary" block onClick={() => setNewSessionOpen(true)}>
            New investigation
          </Button>
          <Button
            icon={<ReloadOutlined />}
            type="text"
            block
            onClick={() => reloadSessions(false).catch((e) => setError(e.message))}
          >
            Refresh
          </Button>
        </div>

        {showLeftTip ? (
          <Alert
            className="sider-tip"
            type="info"
            showIcon
            closable
            icon={<InfoCircleOutlined />}
            message="Each investigation has its own research scope, files and agent configuration."
            onClose={() => {
              setShowLeftTip(false);
              try { localStorage.setItem('ada.tip.left', 'dismissed'); } catch {}
            }}
          />
        ) : null}

        <Conversations
          activeKey={active}
          onActiveChange={(key) => setActive(key)}
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
        aria-label="Resize session sidebar"
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
                {current?.context.userPrompt || current?.context.name || 'New investigation'}
              </Title>
              <Text type="secondary">
                {current?.context.name || 'Start with the question you need to answer'}
              </Text>
            </div>
            <Space>
              {current?.control ? <Tag>Config v{current.control.version}</Tag> : null}
              {current?.context.evidence.length ? <Tag color="blue">Evidence {current.context.evidence.length}</Tag> : null}
              {current?.context.findings.length ? <Tag color="gold">Findings {current.context.findings.length}</Tag> : null}
              {current?.context.unknowns.length ? <Tag color="orange">Unknowns {current.context.unknowns.length}</Tag> : null}
              <Tooltip title="Research and agent configuration">
                <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
                  Configure
                </Button>
              </Tooltip>
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
              <div className="welcome">
                <div className="welcome-inner">
                  <Welcome
                    variant="borderless"
                    icon={<FileTextOutlined />}
                    title="Start this investigation"
                    description="Tell the agent what you need to understand. You do not need to prepare a formal specification first."
                  />

                  <div className="investigation-guide">
                    <Card size="small" className="guide-card">
                      <Flex align="flex-start" gap={12}>
                        <CheckCircleOutlined className="guide-icon" />
                        <div>
                          <Text strong>1. Describe the goal</Text>
                          <div><Text type="secondary">What decision or data question are you trying to answer?</Text></div>
                        </div>
                      </Flex>
                    </Card>
                    <Card size="small" className="guide-card">
                      <Flex align="flex-start" gap={12}>
                        <FolderOpenOutlined className="guide-icon" />
                        <div>
                          <Text strong>2. Give it some context</Text>
                          <div><Text type="secondary">Mention the system, datasets, SQL, documents, or source paths you already know. Missing information can be discovered during the investigation.</Text></div>
                        </div>
                      </Flex>
                    </Card>
                    <Card size="small" className="guide-card">
                      <Flex align="flex-start" gap={12}>
                        <FileTextOutlined className="guide-icon" />
                        <div>
                          <Text strong>3. Ask the first question</Text>
                          <div><Text type="secondary">The agent will inspect available evidence, identify gaps, and suggest the next investigation step.</Text></div>
                        </div>
                      </Flex>
                    </Card>
                  </div>

                  <div className="quick-start">
                    <Text type="secondary">Try one of these:</Text>
                    <Flex wrap gap={8}>
                      {[
                        'Where does Position come from in the legacy platform?',
                        'Map the lineage of portfolio market value.',
                        'What do we know about the current data model?',
                      ].map((prompt) => (
                        <Button key={prompt} size="small" onClick={() => send(prompt)}>{prompt}</Button>
                      ))}
                    </Flex>
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
                  <Text type="secondary">Files in this investigation</Text>
                  <Flex wrap gap={6}>{attachmentItems}</Flex>
                </div>
              ) : null}
              <Sender
                value={value}
                onChange={setValue}
                loading={loading}
                onSubmit={send}
                onCancel={() => setLoading(false)}
                placeholder="Ask about the data estate, lineage, sources, transformations, findings, or next investigation step"
                prefix={
                  <Tooltip title="Upload files">
                    <Button
                      type="text"
                      icon={<PaperClipOutlined />}
                      onClick={() => setAttachmentsOpen((open) => !open)}
                    />
                  </Tooltip>
                }
                header={
                  <Sender.Header
                    title="Files"
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
                          ? { title: 'Drop files here' }
                          : {
                              icon: <FolderOpenOutlined />,
                              title: 'Upload investigation files',
                              description: 'Files are stored in this session workspace and indexed in context.json.',
                            }
                      }
                    />
                  </Sender.Header>
                }
                suffix={<SendOutlined />}
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
              aria-label="Resize investigation sidebar"
              onMouseDown={(event) => {
                event.preventDefault();
                setResizing('right');
              }}
            />
            <aside className="context-panel">
              <div className="panel-header">
                <div>
                  <Text className="eyebrow">INVESTIGATION</Text>
                  <Title level={5} style={{ margin: '3px 0 0' }}>{current?.context.name || '—'}</Title>
                </div>
                <Button type="text" icon={<SettingOutlined />} aria-label="Open investigation configuration" onClick={() => setSettingsOpen(true)} />
              </div>

              {showRightTip ? (
                <Alert
                  className="context-tip"
                  type="info"
                  showIcon
                  closable
                  icon={<FileSearchOutlined />}
                  message="Investigation controls"
                  description="Research sources, Skills, prompts and MCP are configured per investigation."
                  onClose={() => {
                    setShowRightTip(false);
                    try { localStorage.setItem('ada.tip.right', 'dismissed'); } catch {}
                  }}
                />
              ) : null}

              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <Text strong>Research</Text>
                    <Text type="secondary" className="section-subtitle">
                      {(current?.control?.research.githubRepositories.length ?? 0)} repositories · {(current?.control?.research.keywords.length ?? 0)} keywords
                    </Text>
                  </div>
                  <Button size="small" type="link" onClick={() => { setSettingsTab('research'); setSettingsOpen(true); }}>Configure</Button>
                </div>
                <div className="status-line">
                  <Text type="secondary">Search</Text>
                  <Text>
                    {current?.control?.research.githubRepositories.length
                      ? current.control.research.githubSearchMode === 'only_selected' ? 'Selected only' : 'Selected + broader'
                      : 'Not configured'}
                  </Text>
                </div>
                <div className="status-line">
                  <Text type="secondary">Important docs</Text>
                  <Text>{current?.control?.research.importantDocuments.length ?? 0}</Text>
                </div>
              </section>

              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <Text strong>Agent</Text>
                    <Text type="secondary" className="section-subtitle">Prompt v{current?.control?.agent.systemPrompt.version ?? 1}</Text>
                  </div>
                  <Button size="small" type="link" onClick={() => { setSettingsTab('agent'); setSettingsOpen(true); }}>Configure</Button>
                </div>
                <div className="status-line"><Text type="secondary">Skills</Text><Text>{current?.control?.agent.skills.length ?? 0}</Text></div>
                <div className="status-line"><Text type="secondary">MCP</Text><Text>{current?.control?.agent.mcpServers.filter((item) => item.enabled).length ?? 0} enabled</Text></div>
              </section>

              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <Text strong>Coverage</Text>
                    <Text type="secondary" className="section-subtitle">Current evidence state</Text>
                  </div>
                </div>
                <div className="coverage-grid">
                  <div><span>{current?.context.evidence.length ?? 0}</span><Text type="secondary">Evidence</Text></div>
                  <div><span>{current?.context.findings.length ?? 0}</span><Text type="secondary">Findings</Text></div>
                  <div><span>{current?.context.claims.length ?? 0}</span><Text type="secondary">Claims</Text></div>
                  <div><span>{current?.context.unknowns.length ?? 0}</span><Text type="secondary">Unknowns</Text></div>
                </div>
              </section>

              <section className="panel-section">
                <div className="section-heading">
                  <div>
                    <Text strong>Recent activity</Text>
                    <Text type="secondary" className="section-subtitle">Configuration and workspace changes</Text>
                  </div>
                  <Button size="small" type="link" icon={<HistoryOutlined />} onClick={() => setAuditOpen(true)}>All</Button>
                </div>
                <div className="activity-list">
                  {(current?.recentAudit ?? []).slice(0, 3).map((event) => (
                    <div key={event.id} className="activity-item">
                      <Text ellipsis>{event.summary}</Text>
                      <Text type="secondary">{formatTime(event.timestamp)}</Text>
                    </div>
                  ))}
                  {!current?.recentAudit.length ? <Text type="secondary">No activity recorded yet.</Text> : null}
                </div>
              </section>

              <Text type="secondary" className="panel-updated">Updated {current ? formatTime(current.context.updatedAt) : '—'}</Text>
            </aside>
          </div>>
        </Content>
      </Layout>

      <Modal
        title="New investigation"
        open={newSessionOpen}
        onCancel={() => setNewSessionOpen(false)}
        onOk={createSession}
        okButtonProps={{ disabled: !newSessionName.trim() }}
      >
        <Input
          autoFocus
          value={newSessionName}
          onChange={(event) => setNewSessionName(event.target.value)}
          placeholder="portfolio-analytics"
          onPressEnter={createSession}
        />
        <Alert
          className="modal-tip"
          type="info"
          showIcon
          message="After creation, you can configure repositories, research keywords, documents, Skills, MCP and additional system guidance."
        />
      </Modal>

      <Modal
        title={
          <Flex align="center" gap={8}>
            <SettingOutlined />
            <span>Investigation configuration</span>
            {draft ? <Tag>v{draft.version}</Tag> : null}
          </Flex>
        }
        open={settingsOpen}
        width={920}
        onCancel={() => setSettingsOpen(false)}
        onOk={saveSettings}
        okText="Save configuration"
        destroyOnClose
      >
        {draft ? (
          <Tabs
            activeKey={settingsTab}
            onChange={setSettingsTab}
            items={[
              {
                key: 'research',
                label: <span><GithubOutlined /> Research</span>,
                children: (
                  <Flex vertical gap={18}>
                    <Alert
                      type="info"
                      showIcon
                      message="Research constraints"
                      description="These settings guide discovery and search. They are instructions, not evidence. The agent still needs to verify facts against sources."
                    />
                    <div>
                      <Text strong>GitHub repositories</Text>
                      <Paragraph type="secondary">Add one or more repository URLs. The search mode below controls whether the agent may broaden the search beyond them.</Paragraph>
                      <Select
                        mode="tags"
                        style={{ width: '100%' }}
                        tokenSeparators={[',']}
                        value={draft.research.githubRepositories}
                        placeholder="https://github.com/org/repo"
                        onChange={(value) => updateDraft((next) => { next.research.githubRepositories = value; })}
                      />
                    </div>
                    <div>
                      <Text strong>GitHub search mode</Text>
                      <Radio.Group
                        value={draft.research.githubSearchMode}
                        onChange={(event) => updateDraft((next) => { next.research.githubSearchMode = event.target.value; })}
                        options={[
                          { value: 'only_selected', label: 'Only these repositories' },
                          { value: 'selected_and_broad', label: 'These first, then broader GitHub search' },
                        ]}
                      />
                    </div>
                    <div>
                      <Text strong>Research keywords</Text>
                      <Paragraph type="secondary">Terms the agent should actively look for across the configured sources.</Paragraph>
                      <Select
                        mode="tags"
                        style={{ width: '100%' }}
                        tokenSeparators={[',']}
                        value={draft.research.keywords}
                        placeholder="Position, Security Master, proxy voting..."
                        onChange={(value) => updateDraft((next) => { next.research.keywords = value; })}
                      />
                    </div>
                    <div>
                      <Text strong>Important documents</Text>
                      <Paragraph type="secondary">Uploaded files and URLs/paths that should receive priority during the investigation.</Paragraph>
                      <Select
                        mode="tags"
                        style={{ width: '100%' }}
                        tokenSeparators={[',']}
                        value={draft.research.importantDocuments.map((item) => item.reference)}
                        options={documentReferences(current?.context ? current.context : undefined).map((reference) => ({ label: reference, value: reference }))}
                        placeholder="Select uploaded documents or type a document URL/path"
                        onChange={(references) => updateDraft((next) => {
                          next.research.importantDocuments = references.map((reference) => ({
                            id: reference,
                            title: reference.split('/').pop() || reference,
                            reference,
                          }));
                        })}
                      />
                    </div>
                  </Flex>
                ),
              },
              {
                key: 'agent',
                label: <span><ToolOutlined /> Agent</span>,
                children: (
                  <Flex vertical gap={18}>
                    <Alert
                      type="warning"
                      showIcon
                      message="Core safety rules are not editable here"
                      description="The text below is additional system guidance appended to the built-in evidence/safety prompt. Changes create a new prompt version and are audit logged."
                    />
                    <div>
                      <Flex justify="space-between" align="center">
                        <Text strong>Skills</Text>
                        <Tag>versioned</Tag>
                      </Flex>
                      <Paragraph type="secondary">Choose the Skills available to the Lead Agent for this investigation.</Paragraph>
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
                    </div>
                    <div>
                      <Flex justify="space-between" align="center">
                        <Text strong>Additional system prompt</Text>
                        <Tag>v{draft.agent.systemPrompt.version}</Tag>
                      </Flex>
                      <Paragraph type="secondary">Use this for investigation-specific guidance, terminology or working style. Do not put security boundaries here.</Paragraph>
                      <Input.TextArea
                        rows={10}
                        value={draft.agent.systemPrompt.content}
                        placeholder="Example: Treat proxy voting policy documents as primary business context when interpreting vote instructions."
                        onChange={(event) => updateDraft((next) => { next.agent.systemPrompt.content = event.target.value; })}
                      />
                    </div>
                    <div>
                      <Flex justify="space-between" align="center">
                        <Text strong>MCP servers</Text>
                        <Tag>configuration is versioned</Tag>
                      </Flex>
                      <Paragraph type="secondary">
                        JSON array using Copilot SDK server settings. Secrets are intentionally not persisted here. Example: local server with command/args, or HTTP server with url.
                      </Paragraph>
                      <Input.TextArea
                        rows={12}
                        value={mcpDraft}
                        onChange={(event) => setMcpDraft(event.target.value)}
                        spellCheck={false}
                      />
                    </div>
                  </Flex>
                ),
              },
              {
                key: 'history',
                label: <span><HistoryOutlined /> Version history</span>,
                children: (
                  <Flex vertical gap={10}>
                    <Alert
                      type="info"
                      showIcon
                      message="Configuration versions"
                      description="Prompt, Skill and MCP changes receive explicit versions. The full configuration snapshot is retained for the latest 30 versions."
                    />
                    {[...draft.history].reverse().slice(0, 10).map((item) => (
                      <Card key={item.version} size="small">
                        <Flex justify="space-between">
                          <Text strong>Configuration v{item.version}</Text>
                          <Text type="secondary">{formatTime(item.updatedAt)}</Text>
                        </Flex>
                        <Text type="secondary">{item.reason}</Text>
                      </Card>
                    ))}
                  </Flex>
                ),
              },
            ]}
          />
        ) : null}
      </Modal>

      <Modal
        title="Investigation activity"
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
                  {event.configurationVersion ? <Tag className="audit-version">Config v{event.configurationVersion}</Tag> : null}
                </div>
                <Text type="secondary">{formatTime(event.timestamp)}</Text>
              </Flex>
            </Card>
          ))}
          {!current?.recentAudit.length ? <Empty description="No audit events yet." /> : null}
          <Text type="secondary">
            Structured audit records are stored in the session workspace as audit.jsonl.
          </Text>
        </Flex>
      </Modal>
    </Layout>
  );
}

export function App() {
  return (
    <XProvider>
      <AntApp>
        <AppInner />
      </AntApp>
    </XProvider>
  );
}
