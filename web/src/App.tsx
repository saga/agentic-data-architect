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
  FullscreenOutlined,
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

interface ArchitectureAssessmentPlan {
  id: string;
  title: string;
  status: string;
  goal: string;
  scope: string[];
  currentState: {
    datasets: number;
    lineageCoverage: number | null;
    semanticAssets: number;
    findings: number;
    unknowns: number;
  };
  findings: Array<{
    id: string;
    title: string;
    severity: string;
    description: string;
    recommendation: string;
    evidenceIds: string[];
  }>;
  recommendations: string[];
  roadmap: Array<{
    id: string;
    title: string;
    objective: string;
    findingIds: string[];
  }>;
  journey?: {
    workflowId: string;
    currentNodeId: string;
    completedNodeIds: string[];
    unlockedNodeIds: string[];
    stages: JourneyStage[];
  };
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

function AgentRecommendationCard(props: {
  routes: NonNullable<SessionContext['journeyPlan']>['routes'];
  workflow: WorkflowId | null;
  loading: boolean;
  active: boolean;
  onChooseRoute: (route: NonNullable<SessionContext['journeyPlan']>['routes'][number]) => void;
  onOpenMap: () => void;
  onUseDefault: () => void;
}) {
  const workflowLabel = workflowOptions.find((option) => option.value === (props.workflow ?? ''))?.label ?? '自主调查';
  const hasRoutes = props.routes.length > 0;
  return (
    <Card className={'agent-recommendation-card' + (hasRoutes ? ' agent-recommendation-card-routes' : '')}>
      <Flex justify="space-between" align="flex-start" gap={16} wrap>
        <div className="agent-recommendation-head">
          <div className="agent-recommendation-eyebrow">Agent 建议</div>
          <Text strong className="agent-recommendation-title">
            {hasRoutes ? '根据刚才的行动，下一步可以这样走' : '当前还没有锁定下一步，先给你一个可选起点'}
          </Text>
          <Text type="secondary" className="agent-recommendation-note">
            {hasRoutes
              ? '这些是导航建议，不是固定流程。你可以直接问别的问题，也可以让 Agent 随新证据重新规划。'
              : props.workflow
                ? '当前工作方式：' + workflowLabel + '。它提供一个参考骨架，不要求你按固定顺序执行。'
                : '当前是自主调查，Agent 会根据你的目标、证据和新信息动态决定调查方向。'}
          </Text>
        </div>
        <Button size="small" icon={<FullscreenOutlined />} onClick={props.onOpenMap} disabled={props.loading}>工作地图</Button>
      </Flex>
      {hasRoutes ? (
        <div className="agent-recommendation-routes">
          {props.routes.slice(0, 3).map((route, index) => (
            <div className="agent-recommendation-route" key={route.id}>
              <Flex justify="space-between" align="flex-start" gap={10}>
                <div className="agent-recommendation-route-copy">
                  <Text strong>{index + 1}. {route.title}</Text>
                  <Text type="secondary">{route.reason}</Text>
                </div>
                <Button type="primary" ghost size="small" disabled={!props.active || props.loading} onClick={() => props.onChooseRoute(route)}>采用</Button>
              </Flex>
              <div className="agent-recommendation-route-steps">
                {route.steps.slice(0, 4).map((step, stepIndex) => (
                  <Text key={stepIndex} type="secondary">{stepIndex + 1}. {step}</Text>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Flex gap={8} wrap className="agent-recommendation-actions">
          <Button type="primary" ghost size="small" disabled={!props.active || props.loading} onClick={props.onUseDefault}>采用这个起点</Button>
          <Text type="secondary">也可以直接在下面输入你真正想解决的问题。</Text>
        </Flex>
      )}
    </Card>
  );
}
function AppInner() {
  const routeInfo = () => {
    const match = window.location.pathname.match(/^\/investigations\/([^/]+)(?:\/(config|trajectory))?\/?$/);
    return match
      ? { session: decodeURIComponent(match[1]), page: (match[2] ?? 'chat') as 'chat' | 'config' | 'trajectory' }
      : undefined;
  };

  const routeSession = () => routeInfo()?.session;
  const [page, setPage] = useState<'chat' | 'config' | 'trajectory'>(() => routeInfo()?.page ?? 'chat');

  const navigatePage = (nextPage: 'chat' | 'config' | 'trajectory') => {
    if (!active) return;
    const suffix = nextPage === 'chat' ? '' : '/' + nextPage;
    const nextPath = '/investigations/' + encodeURIComponent(active) + suffix;
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ session: active, page: nextPage }, '', nextPath);
    }
    setPage(nextPage);
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
  const [newSessionWorkflow, setNewSessionWorkflow] = useState<WorkflowId | null>(null);
  const [newSessionGoal, setNewSessionGoal] = useState('');
  const [workflowSaving, setWorkflowSaving] = useState(false);
  // undefined = 尚未选择；'' = 明确选择“自主调查”；WorkflowId = 选择具体工作方式。
  const [workflowTarget, setWorkflowTarget] = useState<WorkflowId | '' | undefined>(undefined);
  const [workflowConfirmText, setWorkflowConfirmText] = useState('');
  const [unknownsOpen, setUnknownsOpen] = useState(false);
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
  const [assessmentPlan, setAssessmentPlan] = useState<ArchitectureAssessmentPlan>();
  const [journey, setJourney] = useState<ModernizationPlan['journey']>();
  /** 工作地图全屏视图是否打开。*/
  const [journeyMapOpen, setJourneyMapOpen] = useState(false);
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
      setModernizationPlan(undefined);
      setAssessmentPlan(undefined);
      setJourney(undefined);
      setAttachmentsOpen(false);
    }
    const [result, modernization, assessment, journeyResult] = await Promise.all([
      getJson<SessionData>(`/api/sessions/${encodeURIComponent(key)}`),
      getJson<{ plan: ModernizationPlan | null }>(`/api/sessions/${encodeURIComponent(key)}/modernization`),
      getJson<{ plan: ArchitectureAssessmentPlan | null }>(`/api/sessions/${encodeURIComponent(key)}/assessment`),
      getJson<{ journey: ModernizationPlan['journey'] }>(`/api/sessions/${encodeURIComponent(key)}/journey`),
    ]);
    if (requestId !== loadRequestRef.current || key !== activeRef.current) return;
    setCurrent(result);
    setModernizationPlan(modernization.plan ?? undefined);
    setAssessmentPlan(assessment.plan ?? undefined);
    setJourney(journeyResult.journey ?? modernization.plan?.journey ?? assessment.plan?.journey);

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

  const loadAssessment = async (key: string) => {
    setModernizationLoading(true);
    try {
      const result = await getJson<{ plan: ArchitectureAssessmentPlan }>(
        `/api/sessions/${encodeURIComponent(key)}/assessment?rebuild=true`,
      );
      setAssessmentPlan(result.plan);
      setJourney(result.plan.journey);
      setModernizationOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法生成架构评估');
    } finally {
      setModernizationLoading(false);
    }
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
      const workflowNames = new Set<string>(workflowOptions.map((option) => option.value).filter(Boolean));
      setSkillOptions(result.skills.filter((skill) => !workflowNames.has(skill.name)));
    } catch {
      // Skill discovery should not block the investigation UI.
    }
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
    loadSkills().catch(() => undefined);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    setStreamingAnswer(undefined);
    setNextGuidance(undefined);
    setModernizationPlan(undefined);
    setAssessmentPlan(undefined);
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
      setModernizationPlan(undefined);
      setAssessmentPlan(undefined);
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

  const chooseRoute = (route: NonNullable<SessionContext['journeyPlan']>['routes'][number]) => {
    if (!active || loading) return;
    const message = [
      `我选择这条路线：“${route.title}”。`,
      route.reason,
      '',
      `建议方向：${route.steps.join(' → ')}`,
      '',
      '请按这个方向推进，但把它当成导航建议而不是固定流程；如果新证据或我的后续动作表明另一条路更合适，请重新规划。',
    ].join('\n');
    void send(message);
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
      setWorkflowTarget(undefined);
      setWorkflowConfirmText('');
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
          control={current.control}
          skills={skillOptions}
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
          <div className="chat-main">
            {current ? (
              <AgentRecommendationCard
                routes={current.context.journeyPlan?.routes ?? []}
                workflow={current.context.workflow}
                loading={loading}
                active={Boolean(active)}
                onChooseRoute={chooseRoute}
                onOpenMap={() => setJourneyMapOpen(true)}
                onUseDefault={() => void send('请先帮我快速建立当前问题需要的事实基础，再根据查到的证据决定下一步；不要假定必须按照固定顺序执行。')}
              />
            ) : null}
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
                    onClick={() => navigatePage('config')}
                  />
                </Tooltip>
              </div>

              {current ? (
                <section className="right-section right-work-mode">
                  <div className="right-section-heading"><Text strong>工作方式</Text></div>
                  <Tag color={current.context.workflow ? 'blue' : undefined} bordered={false}>
                    {workflowOptions.find((option) => option.value === (current.context.workflow ?? ''))?.label ?? '自主调查'}
                  </Tag>
                  <Text type="secondary">
                    工作方式进入调查后不在首页随手切换。需要改变时，到调查设置里的“工作方式”执行一次明确的调整。
                  </Text>
                  <Button type="link" size="small" onClick={() => navigatePage('config')}>
                    打开工作方式设置
                  </Button>
                </section>
              ) : null}

              {journey?.stages.length ? (
                <section className="right-section right-journey">
                  <Flex className="right-section-heading" justify="space-between" align="center">
                    <Space size={6}>
                      <Text strong>地图导引</Text>
                      <Tag bordered={false}>参考</Tag>
                    </Space>
                    <Button
                      type="link"
                      size="small"
                      icon={<FullscreenOutlined />}
                      disabled={loading}
                      onClick={() => setJourneyMapOpen(true)}
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
                    </div>
                    {modernizationPlan?.gaps.length ? (
                      <div className="right-issues">
                        {modernizationPlan.gaps.slice(0, 2).map((gap) => (
                          <div key={gap.id} className="right-issue">
                            <Text strong ellipsis={{ tooltip: gap.title }}>{gap.title}</Text>
                            <Text type="secondary" ellipsis={{ tooltip: gap.recommendation }}>{gap.recommendation}</Text>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </section>
            </aside>
          </div>
        </Content>
      </Layout>

                  <Modal
        className="journey-map-modal"
        title={
          <Flex align="center" gap={8}>
            <span>工作地图</span>
            {current?.context.workflow ? <Tag bordered={false}>地图骨架：{workflowOptions.find((item) => item.value === current.context.workflow)?.label}</Tag> : <Tag bordered={false}>自主调查</Tag>}
          </Flex>
        }
        open={journeyMapOpen}
        width="100%"
        centered
        destroyOnHidden
        styles={{
          container: { padding: 0, overflow: 'hidden' },
          header: { margin: 0, padding: '14px 18px' },
          body: { height: 'calc(100vh - 150px)', minHeight: 520 },
        }}
        onCancel={() => setJourneyMapOpen(false)}
        footer={null}
      >
        <JourneyMap
          journey={journey ?? modernizationPlan?.journey ?? assessmentPlan?.journey}
          routes={current?.context.journeyPlan?.routes ?? []}
          loading={loading}
          onChooseRoute={chooseRoute}
          onAskStage={(stage) => {
            void send(
              [
                `请继续推进工作地图中的“${stage.title}”。`,
                `当前阶段目标：${stage.objective}`,
                '',
                '请直接判断最有价值的下一步；能自动检索、检查或分析的就直接执行。',
                '完成后更新相关 Evidence / Unknown，并告诉我这一步查清了什么，以及下一步怎么走。',
              ].join('\n'),
            );
          }}
        />
      </Modal>
      <Modal
        className="modernization-modal"
        title={current?.context.workflow === 'data-architecture-assessment' ? '架构评估结果' : '完整改造方案'}
        open={modernizationOpen}
        width={760}
        centered
        onCancel={() => setModernizationOpen(false)}
        footer={<Button onClick={() => setModernizationOpen(false)}>关闭</Button>}
      >
        {current?.context.workflow === 'data-architecture-assessment' && assessmentPlan ? (
          <div className="plain-plan">
            <Text type="secondary">
              这是基于当前调查证据整理出的评估草案。问题、建议和实施顺序仍需要负责人确认。
            </Text>
            <Card size="small" title="评估范围">
              <div className="plain-summary">
                <span>{assessmentPlan.goal || '尚未明确目标'}</span>
                <span>数据集：<strong>{assessmentPlan.currentState.datasets}</strong></span>
                <span>数据来路：<strong>{assessmentPlan.currentState.lineageCoverage == null ? '未统计' : Math.round(assessmentPlan.currentState.lineageCoverage * 100) + '%'}</strong></span>
                <span>发现问题：<strong>{assessmentPlan.currentState.findings}</strong></span>
              </div>
            </Card>
            <Card size="small" title="主要问题">
              <div className="plan-stage-list">
                {assessmentPlan.findings.slice(0, 12).map((finding) => (
                  <div key={finding.id} className="plan-stage">
                    <Text strong>{finding.title}</Text>
                    <Text type="secondary">{finding.description}</Text>
                    <Text type="secondary">建议：{finding.recommendation}</Text>
                  </div>
                ))}
              </div>
            </Card>
            <Card size="small" title="建议">
              <div className="plain-summary">
                {assessmentPlan.recommendations.map((item) => <span key={item}>{item}</span>)}
              </div>
            </Card>
            <Card size="small" title="实施顺序">
              <div className="plan-stage-list">
                {assessmentPlan.roadmap.map((item, index) => (
                  <div key={item.id} className="plan-stage">
                    <Text strong>{index + 1}. {item.title}</Text>
                    <Text type="secondary">{item.objective}</Text>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        ) : modernizationPlan && current?.currentState ? (
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
            message="默认自主调查。路线是可选的工作方法，开始后也可以切换，不会丢失已有调查资料。"
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
        width="min(1000px, calc(100vw - 40px))"
        centered
        onCancel={() => {
          setWorkflowTarget(undefined);
          setWorkflowConfirmText('');
          setSettingsOpen(false);
        }}
        onOk={saveSettings}
        okText="保存修改"
        destroyOnHidden
        styles={{
          container: {
            height: 'min(840px, calc(100vh - 48px))',
            maxHeight: 'calc(100vh - 48px)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
          header: {
            flex: '0 0 auto',
            margin: 0,
          },
          body: {
            flex: '1 1 auto',
            minHeight: 0,
            padding: 0,
            overflow: 'hidden',
            display: 'flex',
          },
          footer: {
            flex: '0 0 auto',
          },
        }}
      >
        {draft ? (
          <Tabs
            tabPlacement="start"
            style={{ height: '100%', minHeight: 0 }}
            activeKey={settingsTab}
            onChange={setSettingsTab}
            className="settings-tabs"
            animated={false}
            items={[
              {
                key: 'workflow',
                label: <span><SettingOutlined /> 工作方式</span>,
                children: (
                  <div className="settings-page">
                    <div className="settings-page-header">
                      <Title level={4}>工作方式</Title>
                      <Paragraph type="secondary">工作方式是本次调查的导航骨架，不是普通筛选项。改变它会清除旧的 Agent 会话与动态路线建议，但会保留消息、Evidence、发现和调查资料。</Paragraph>
                    </div>
                    <Card className="settings-card workflow-danger-zone" title="危险区域">
                      <Alert type="warning" showIcon message="不要为了试试看而切换" description="只有当你的真实目标已经发生变化，或者你明确决定采用另一套调查/设计方法时，才应该在这里调整。模糊表达不会自动触发切换。" />
                      <div className="workflow-danger-grid">
                        <div>
                          <div className="field-label">当前工作方式</div>
                          <Tag bordered={false}>{workflowOptions.find((option) => option.value === (current?.context.workflow ?? ''))?.label ?? '自主调查'}</Tag>
                        </div>
                        <div>
                          <div className="field-label">调整为</div>
                          <Select
                            value={workflowTarget}
                            style={{ width: '100%' }}
                            options={workflowOptions
                              .filter((option) => option.value !== (current?.context.workflow ?? ''))
                              .map((option) => ({ value: option.value, label: option.label }))}
                            onChange={(value) => setWorkflowTarget(value as WorkflowId | '')}
                            placeholder="选择新的工作方式"
                          />
                        </div>
                      </div>
                      <div className="workflow-confirm-block">
                        <div className="field-label">确认这次调整</div>
                        <Input value={workflowConfirmText} onChange={(event) => setWorkflowConfirmText(event.target.value)} placeholder="输入：我确认调整工作方式" />
                        <Flex justify="space-between" align="center" gap={12} wrap>
                          <Text type="secondary">不会删除调查资料，但 Agent 会从新的工作方式重新开始导航。</Text>
                          <Button
                            danger
                            type="primary"
                            loading={workflowSaving}
                            disabled={
                              !active ||
                              workflowTarget === undefined ||
                              (workflowTarget === ''
                                ? current?.context.workflow === null
                                : workflowTarget === current?.context.workflow) ||
                              workflowConfirmText.trim() !== '我确认调整工作方式'
                            }
                            onClick={() => {
                              if (workflowTarget === undefined) return;
                              void changeWorkflow(workflowTarget === '' ? null : workflowTarget);
                            }}
                          >
                            确认调整工作方式
                          </Button>
                        </Flex>
                      </div>
                    </Card>
                    <Card className="settings-card" title="如何改变更自然">
                      <Paragraph type="secondary">最自然的方式仍然是直接告诉 Agent 你的目标发生了什么变化。当前 Agent 只把明确的工作方式调整当作用户意图；不会因为一句模糊的“换个思路”就替你修改调查状态。</Paragraph>
                    </Card>
                  </div>
                ),
              },
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
                      <Paragraph type="secondary">Agent 理解本次调查时，应该优先参考哪些文档。</Paragraph>
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
                        填写本次调查要用的 MCP 服务器；每次修改都会存成一个新版本，并记进操作记录。
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