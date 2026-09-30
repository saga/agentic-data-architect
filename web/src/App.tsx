import React, { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp,
  Badge,
  Button,
  Card,
  Divider,
  Empty,
  Flex,
  Input,
  Layout,
  Modal,
  Space,
  Tag,
  Typography,
} from 'antd';
import { FileTextOutlined, PlusOutlined, ReloadOutlined, SendOutlined } from '@ant-design/icons';
import {
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
const { Text, Title } = Typography;

interface SessionSummary {
  key: string;
  label: string;
  userPrompt: string;
  updatedAt: string;
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
  messages: Message[];
}

const markdownComponents = {
  mermaid: Mermaid,
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
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [active, setActive] = useState<string>();
  const [current, setCurrent] = useState<SessionData>();
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [error, setError] = useState<string>();

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
  };

  useEffect(() => {
    reloadSessions().catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (active) loadSession(active).catch((e) => setError(e.message));
  }, [active]);

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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create session');
    }
  };

  return (
    <Layout className="app-shell">
      <Sider width={280} theme="light" className="session-sider">
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

      <Layout>
        <Header className="topbar">
          <Flex justify="space-between" align="center" style={{ width: '100%' }}>
            <div>
              <Title level={4} style={{ margin: 0 }}>
                {current?.context.userPrompt || current?.context.name || 'New investigation'}
              </Title>
              <Text type="secondary">
                {current?.context.name || 'Start with the question you need to answer'}
              </Text>
            </div>
            <Space>
              {current?.context.evidence.length ? (
                <Tag color="blue">Evidence {current.context.evidence.length}</Tag>
              ) : null}
              {current?.context.findings.length ? (
                <Tag color="gold">Findings {current.context.findings.length}</Tag>
              ) : null}
              {current?.context.unknowns.length ? (
                <Tag color="orange">Unknowns {current.context.unknowns.length}</Tag>
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
              <div className="welcome">
                <Welcome
                  variant="borderless"
                  icon={<FileTextOutlined />}
                  title="What do you need to understand?"
                  description="Start with a data question. The agent will keep the investigation context in the session workspace and ground claims in available evidence."
                />
              </div>
            )}

            {error ? (
              <Card size="small" className="error-card">
                <Text type="danger">{error}</Text>
              </Card>
            ) : null}

            <div className="composer">
              <Sender
                value={value}
                onChange={setValue}
                loading={loading}
                onSubmit={send}
                onCancel={() => setLoading(false)}
                placeholder="Ask about the data estate, lineage, sources, transformations, findings, or next investigation step"
                suffix={<SendOutlined />}
              />
            </div>
          </div>

          <Divider type="vertical" className="content-divider" />

          <aside className="context-panel">
            <Flex vertical gap={12}>
              <div>
                <Text type="secondary">SESSION</Text>
                <Title level={5}>{current?.context.name || '—'}</Title>
              </div>
              <Card size="small" title="Goal">
                <Text>{current?.context.goal || 'Not set yet'}</Text>
              </Card>
              <Card size="small" title="Scope">
                <Space wrap>
                  {(current?.context.scope ?? []).map((item) => <Tag key={item}>{item}</Tag>)}
                  {!current?.context.scope.length ? <Text type="secondary">No scope defined</Text> : null}
                </Space>
              </Card>
              <Card size="small" title="Coverage">
                <Flex vertical gap={6}>
                  <Text>Evidence: {current?.context.evidence.length ?? 0}</Text>
                  <Text>Findings: {current?.context.findings.length ?? 0}</Text>
                  <Text>Claims: {current?.context.claims.length ?? 0}</Text>
                  <Text>Unknowns: {current?.context.unknowns.length ?? 0}</Text>
                </Flex>
              </Card>
              <Text type="secondary">
                Updated {current ? formatTime(current.context.updatedAt) : '—'}
              </Text>
            </Flex>
          </aside>
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
