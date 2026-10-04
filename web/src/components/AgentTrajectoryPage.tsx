import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  Empty,
  Flex,
  Progress,
  Row,
  Space,
  Statistic,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  DollarOutlined,
  ReloadOutlined,
  RobotOutlined,
  ToolOutlined,
  WarningOutlined,
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

/**
 * 轨迹页只把最近几轮作为主视图。
 * 更早的轮次统一放进一个可展开的折叠区，避免对话很长以后需要滚动很久才能看到最新执行。
 */
const RECENT_TURN_COUNT = 5;
/** 每轮默认只展示最新事件；更早事件按需展开。 */
const RECENT_EVENT_COUNT = 30;

interface TrajectoryEvent {
  id: string;
  turnId: string;
  timestamp: string;
  type: 'user_input' | 'turn_start' | 'assistant_turn_start' | 'assistant_turn_end' | 'intent' | 'model_call' | 'tool_call' | 'tool_result' | 'tool_progress' | 'permission' | 'permission_completed' | 'user_input_requested' | 'user_input_completed' | 'compaction' | 'session_idle' | 'session_error' | 'context_changed' | 'turn_end' | 'error' | 'status';
  name: string;
  status?: 'started' | 'completed' | 'failed' | 'waiting' | 'info';
  durationMs?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  premiumRequestCost?: number;
  details: Record<string, unknown>;
}

interface TrajectorySummary {
  turnId?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalNanoAiu?: number;
  totalPremiumRequestCost?: number;
  models: Record<string, { inputTokens: number; outputTokens: number; totalNanoAiu?: number }>;
  eventCount: number;
  state?: 'running' | 'waiting' | 'completed' | 'failed';
  waitingOn?: 'permission' | 'user_input' | 'tool' | 'model' | 'session';
  lastActivityAt?: string;
  lastActivity?: string;
  lastActivityType?: string;
  idleObserved?: boolean;
  assistantTurnEnded?: boolean;
  pendingToolCount?: number;
  pendingPermissionCount?: number;
  pendingUserInputCount?: number;
}

interface TrajectoryTurnSummary {
  turnId: string;
  summary: TrajectorySummary;
  userQuestion?: string;
  modelCalls: number;
  toolCalls: number;
  failedEvents: number;
  compactions: number;
}

interface ConversationTurnSummary {
  turnId: string;
  sessionName: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  createdAt: string;
  updatedAt: string;
  question?: string;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function formatDuration(ms?: number) {
  if (ms === undefined) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatTokens(value: number) {
  return value.toLocaleString();
}

function formatCost(value?: number) {
  return value === undefined ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatJson(value: unknown, maxLength = 900) {
  if (value === undefined) return '';
  let text = '';
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

function eventLabel(event: TrajectoryEvent) {
  switch (event.type) {
    case 'user_input': return '用户提出问题';
    case 'turn_start': return '开始处理';
    case 'assistant_turn_start': return '模型处理开始';
    case 'assistant_turn_end': return '模型处理完成';
    case 'intent': return '当前动作';
    case 'model_call': return '模型调用';
    case 'tool_call': return '调用工具';
    case 'tool_result': return '工具返回';
    case 'tool_progress': return '工具进度';
    case 'permission': return '等待确认';
    case 'permission_completed': return '确认已处理';
    case 'user_input_requested': return '等待用户输入';
    case 'user_input_completed': return '用户输入已提供';
    case 'compaction': return '整理上下文';
    case 'session_idle': return 'Session 已 idle';
    case 'session_error': return 'Session 错误';
    case 'context_changed': return '运行上下文变化';
    case 'turn_end': return '本轮完成';
    case 'error': return '执行失败';
    case 'status': return event.name;
    default: return event.name;
  }
}

function eventColor(event: TrajectoryEvent) {
  if (event.status === 'failed' || event.type === 'error' || event.type === 'session_error') return 'red';
  if (event.status === 'waiting' && (event.type === 'permission' || event.type === 'user_input_requested')) return 'orange';
  if (event.type === 'model_call') return 'blue';
  if (event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'tool_progress') return 'blue';
  if (event.type === 'session_idle' || event.type === 'turn_end' || event.type === 'permission_completed' || event.type === 'user_input_completed') return 'green';
  return undefined;
}

function eventMarker(event: TrajectoryEvent): 'error' | 'warning' | undefined {
  if (event.status === 'failed' || event.type === 'error' || event.type === 'session_error') return 'error';
  if (event.status === 'waiting' && (event.type === 'permission' || event.type === 'user_input_requested')) return 'warning';
  return undefined;
}
function eventDetail(event: TrajectoryEvent) {
  if (event.type === 'model_call') {
    const cached = typeof event.details.cachedInputTokens === 'number' ? event.details.cachedInputTokens : undefined;
    const reasoning = typeof event.details.reasoningTokens === 'number' ? event.details.reasoningTokens : undefined;
    return (
      <Space orientation="vertical" size={4}>
        <Flex wrap gap={6}>
          {event.model ? <Tag>{event.model}</Tag> : null}
          <Tag>输入 {formatTokens(event.inputTokens ?? 0)}</Tag>
          <Tag>输出 {formatTokens(event.outputTokens ?? 0)}</Tag>
          <Tag>合计 {formatTokens((event.inputTokens ?? 0) + (event.outputTokens ?? 0))}</Tag>
          {typeof event.details.newInputTokens === 'number' ? <Tag>新增输入 {formatTokens(event.details.newInputTokens)}</Tag> : null}
          {event.premiumRequestCost !== undefined ? <Tag>Premium Request Cost {formatCost(event.premiumRequestCost)}</Tag> : null}
          {event.durationMs !== undefined ? <Tag>{formatDuration(event.durationMs)}</Tag> : null}
          {typeof event.details.contextPercentAtCall === 'number' ? <Tag>调用时上下文 {event.details.contextPercentAtCall}%</Tag> : null}
          {typeof event.details.availableToolCount === 'number' ? <Tag>可用工具 {event.details.availableToolCount}</Tag> : null}
          {typeof event.details.finishReason === 'string' ? <Tag>结束 {event.details.finishReason}</Tag> : null}
          {typeof event.details.reasoningEffort === 'string' ? <Tag>推理强度 {event.details.reasoningEffort}</Tag> : null}
        </Flex>
        {cached !== undefined || reasoning !== undefined || typeof event.details.cacheWriteTokens === 'number' ? (
          <Text type="secondary">
            {cached !== undefined ? `缓存命中 ${formatTokens(cached)}` : ''}
            {cached !== undefined && typeof event.details.cacheWriteTokens === 'number' ? ' · ' : ''}
            {typeof event.details.cacheWriteTokens === 'number' ? `缓存写入 ${formatTokens(event.details.cacheWriteTokens)}` : ''}
            {(cached !== undefined || typeof event.details.cacheWriteTokens === 'number') && reasoning !== undefined ? ' · ' : ''}
            {reasoning !== undefined ? `推理 Token ${formatTokens(reasoning)}` : ''}
          </Text>
        ) : null}
        {typeof event.details.timeToFirstTokenMs === 'number' || typeof event.details.interTokenLatencyMs === 'number' ? (
          <Text type="secondary">
            {typeof event.details.timeToFirstTokenMs === 'number' ? `首 Token ${formatDuration(event.details.timeToFirstTokenMs)}` : ''}
            {typeof event.details.timeToFirstTokenMs === 'number' && typeof event.details.interTokenLatencyMs === 'number' ? ' · ' : ''}
            {typeof event.details.interTokenLatencyMs === 'number' ? `Token 间隔 ${formatDuration(event.details.interTokenLatencyMs)}` : ''}
          </Text>
        ) : null}
        {typeof event.details.contextTokensAtCall === 'number' || typeof event.details.contextTokenLimitAtCall === 'number' ? (
          <Text type="secondary">
            调用时上下文：{formatTokens(Number(event.details.contextTokensAtCall) || 0)}
            {typeof event.details.contextTokenLimitAtCall === 'number' ? ` / ${formatTokens(event.details.contextTokenLimitAtCall)} Token` : ' Token'}
            {typeof event.details.contextMessagesAtCall === 'number' ? ` · ${event.details.contextMessagesAtCall} 条消息` : ''}
          </Text>
        ) : null}
        {typeof event.details.apiEndpoint === 'string' || typeof event.details.providerCallId === 'string' || typeof event.details.serviceRequestId === 'string' ? (
          <Text type="secondary">
            {typeof event.details.apiEndpoint === 'string' ? `API ${event.details.apiEndpoint}` : ''}
            {typeof event.details.providerCallId === 'string' ? ` · provider ${event.details.providerCallId}` : ''}
            {typeof event.details.serviceRequestId === 'string' ? ` · service ${event.details.serviceRequestId}` : ''}
          </Text>
        ) : null}
      </Space>
    );
  }

  if (event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'tool_progress') {
    const server = typeof event.details.mcpServerName === 'string' ? event.details.mcpServerName : undefined;
    const mcpTool = typeof event.details.mcpToolName === 'string' ? event.details.mcpToolName : undefined;
    const error = typeof event.details.error === 'string' ? event.details.error : formatJson(event.details.error, 500);
    const args = event.details.arguments;
    const resultPreview = typeof event.details.resultPreview === 'string' ? event.details.resultPreview : undefined;
    const progress = typeof event.details.progressMessage === 'string' ? event.details.progressMessage : undefined;
    return (
      <Flex vertical gap={5}>
        {server ? <Text type="secondary">MCP：{server}{mcpTool ? ` / ${mcpTool}` : ''}</Text> : null}
        {event.durationMs !== undefined ? <Text type="secondary">耗时：{formatDuration(event.durationMs)}</Text> : null}
        {progress ? <Text>{progress}</Text> : null}
        {event.type === 'tool_call' && args !== undefined ? (
          <Text type="secondary">参数：<code>{formatJson(args, 700)}</code></Text>
        ) : null}
        {resultPreview ? (
          <Text type="secondary">结果摘要：<code>{formatJson(resultPreview, 700)}</code></Text>
        ) : null}
        {typeof event.details.resultLength === 'number' ? <Text type="secondary">结果长度：{event.details.resultLength.toLocaleString()} 字符</Text> : null}
        {error ? <Text type="danger">{error}</Text> : null}
      </Flex>
    );
  }

  if (event.type === 'permission') {
    const kind = typeof event.details.kind === 'string' ? event.details.kind : 'unknown';
    const intention = typeof event.details.intention === 'string' ? event.details.intention : undefined;
    const command = typeof event.details.fullCommandText === 'string' ? event.details.fullCommandText : undefined;
    const file = typeof event.details.path === 'string'
      ? event.details.path
      : typeof event.details.fileName === 'string' ? event.details.fileName : undefined;
    const tool = typeof event.details.toolName === 'string' ? event.details.toolName : undefined;
    return (
      <Flex vertical gap={4}>
        <Flex wrap gap={6}>
          <Tag color="orange">{kind}</Tag>
          {tool ? <Tag>{tool}</Tag> : null}
          {typeof event.details.readOnly === 'boolean' ? <Tag>{event.details.readOnly ? '只读' : '可能修改'}</Tag> : null}
        </Flex>
        {intention ? <Text>用途：{intention}</Text> : null}
        {command ? <Text type="secondary">命令：<code>{formatJson(command, 1000)}</code></Text> : null}
        {file ? <Text type="secondary">目标：<code>{formatJson(file, 800)}</code></Text> : null}
        {event.durationMs !== undefined ? <Text type="secondary">等待时长：{formatDuration(event.durationMs)}</Text> : null}
        {typeof event.details.managedApprovalRequired === 'boolean' ? <Text type="secondary">需要受管审批：{event.details.managedApprovalRequired ? '是' : '否'}</Text> : null}
      </Flex>
    );
  }

  if (event.type === 'permission_completed' || event.type === 'user_input_completed') {
    return (
      <Flex vertical gap={3}>
        {typeof event.details.kind === 'string' ? <Text type="secondary">类型：{event.details.kind}</Text> : null}
        {typeof event.details.resultKind === 'string' ? <Text type="secondary">结果：{event.details.resultKind}</Text> : null}
        {event.durationMs !== undefined ? <Text type="secondary">等待时长：{formatDuration(event.durationMs)}</Text> : null}
      </Flex>
    );
  }

  if (event.type === 'user_input_requested') {
    return (
      <Flex vertical gap={4}>
        {typeof event.details.question === 'string' ? <Text>{event.details.question}</Text> : null}
        {Array.isArray(event.details.choices) && event.details.choices.length ? (
          <Text type="secondary">选项：{event.details.choices.map(String).join(' / ')}</Text>
        ) : null}
      </Flex>
    );
  }

  if (event.type === 'session_idle') {
    return (
      <Text type="secondary">
        aborted={event.details.aborted ? 'true' : 'false'} ·
        待处理工具 {Number(event.details.pendingTools) || 0} ·
        待确认 {Number(event.details.pendingPermissions) || 0} ·
        待用户输入 {Number(event.details.pendingUserInputs) || 0}
      </Text>
    );
  }

  if (event.type === 'session_error') {
    return (
      <Flex vertical gap={3}>
        {typeof event.details.errorType === 'string' ? <Text type="danger">类型：{event.details.errorType}</Text> : null}
        {typeof event.details.message === 'string' ? <Text type="danger">{event.details.message}</Text> : null}
        {typeof event.details.statusCode === 'number' ? <Text type="secondary">HTTP {event.details.statusCode}</Text> : null}
        {typeof event.details.providerCallId === 'string' ? <Text type="secondary">providerCallId：{event.details.providerCallId}</Text> : null}
      </Flex>
    );
  }

  if (event.type === 'context_changed') {
    return (
      <Text type="secondary">
        {typeof event.details.repository === 'string' ? event.details.repository : ''}
        {typeof event.details.branch === 'string' ? ` / ${event.details.branch}` : ''}
        {typeof event.details.cwd === 'string' ? ` · ${event.details.cwd}` : ''}
      </Text>
    );
  }

  if (event.type === 'status' && event.name === 'Agent 状态') {
    return (
      <Flex vertical gap={3}>
        <Text>已运行 {formatDuration(Number(event.details.elapsedMs) || 0)}</Text>
        <Text type="secondary">
          最后活动：{typeof event.details.lastActivity === 'string' ? event.details.lastActivity : '—'}
          {typeof event.details.lastActivityAt === 'string' ? ` · ${formatTime(event.details.lastActivityAt)}` : ''}
        </Text>
        <Text type="secondary">
          工具 {Number(event.details.pendingTools) || 0} ·
          确认 {Number(event.details.pendingPermissions) || 0} ·
          用户输入 {Number(event.details.pendingUserInputs) || 0} ·
          模型调用 {Number(event.details.modelCallCount) || 0}
        </Text>
      </Flex>
    );
  }

  if (event.type === 'status' && event.name === '上下文占用') {
    const current = typeof event.details.currentTokens === 'number' ? event.details.currentTokens : 0;
    const limit = typeof event.details.tokenLimit === 'number' ? event.details.tokenLimit : 0;
    const percent = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
    return (
      <Flex vertical gap={4} style={{ minWidth: 220 }}>
        <Text type="secondary">上下文 {formatTokens(current)} / {formatTokens(limit)} Token</Text>
        {limit > 0 ? <Progress percent={percent} size="small" showInfo={false} /> : null}
      </Flex>
    );
  }

  if (event.type === 'turn_end') {
    const turnUsage = event.details.turnUsage;
    if (turnUsage && typeof turnUsage === 'object') {
      const usage = turnUsage as Record<string, unknown>;
      return (
        <Flex wrap gap={6}>
          {typeof usage.totalNanoAiu === 'number' ? <Tag>本轮 AI 额度 {formatCost(usage.totalNanoAiu)} nano-AIU</Tag> : null}
          {typeof usage.totalPremiumRequestCost === 'number' ? <Tag>本轮 Premium Request Cost {formatCost(usage.totalPremiumRequestCost)}</Tag> : null}
        </Flex>
      );
    }
  }

  if (event.type === 'compaction' && event.details.preCompactionTokens !== undefined) {
    return <Text type="secondary">整理前约 {formatTokens(Number(event.details.preCompactionTokens) || 0)} Token</Text>;
  }

  if (event.type === 'error') {
    const message = typeof event.details.error === 'string' ? event.details.error : undefined;
    return message ? <Text type="danger">{message}</Text> : null;
  }

  return null;
}

function TurnCard({ turn, events }: { turn: TrajectoryTurnSummary; events: TrajectoryEvent[] }) {
  const [showOlderEvents, setShowOlderEvents] = useState(false);
  const visibleEvents = events.filter((event) => event.type !== 'intent').slice().reverse();
  const recentEvents = visibleEvents.slice(0, RECENT_EVENT_COUNT);
  const olderEvents = visibleEvents.slice(RECENT_EVENT_COUNT);
  const summary = turn.summary;

  return (
    <Card className="trajectory-turn-card">
      <Flex justify="space-between" align="flex-start" gap={16} wrap>
        <div className="trajectory-turn-heading">
          <Flex align="center" gap={8} wrap>
            <Badge status={summary.finishedAt ? 'success' : 'processing'} />
            <Text strong className="trajectory-turn-title">
              {turn.userQuestion || '本轮 Agent 执行'}
            </Text>
          </Flex>
          <Text type="secondary">{formatTime(summary.startedAt)} · {turn.turnId}</Text>
        </div>
        <Space wrap>
          {summary.model ? <Tag icon={<RobotOutlined />}>{summary.model}</Tag> : null}
          <Tag>Token {formatTokens(summary.totalTokens)}</Tag>
          <Tag>模型 {turn.modelCalls} 次</Tag>
          <Tag>工具 {turn.toolCalls} 次</Tag>
          <Tag>{formatDuration(summary.durationMs)}</Tag>
        </Space>
      </Flex>

      <div className="trajectory-turn-metrics">
        <span>输入 {formatTokens(summary.inputTokens)}</span>
        <span>输出 {formatTokens(summary.outputTokens)}</span>
        {summary.totalPremiumRequestCost !== undefined ? <span>Premium Request Cost {formatCost(summary.totalPremiumRequestCost)}</span> : null}
        {summary.totalNanoAiu !== undefined ? <span>AI 额度 {formatCost(summary.totalNanoAiu)} nano-AIU</span> : null}
        {turn.compactions ? <span>上下文整理 {turn.compactions} 次</span> : null}
      </div>

      <Timeline
        className="trajectory-turn-timeline"
        titleSpan="20%"
        items={recentEvents.map((event) => {
            const marker = eventMarker(event);
            return {
              label: formatTime(event.timestamp),
              color: eventColor(event),
              dot:
                event.type === 'model_call' ? <RobotOutlined /> :
                event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'tool_progress' ? <ToolOutlined /> :
                event.type === 'permission' || event.type === 'permission_completed' || event.type === 'user_input_requested' ? <WarningOutlined /> :
                event.type === 'session_idle' || event.type === 'turn_end' ? <CheckCircleOutlined /> :
                undefined,
              children: (
                <div className={`trajectory-event-row${marker ? ` trajectory-event-row--${marker}` : ''}`}>
                  <Flex justify="space-between" align="center" gap={12} wrap>
                    <Flex align="center" gap={6} wrap>
                      {marker === 'error' ? <Tag color="red">异常</Tag> : null}
                      {marker === 'warning' ? <Tag color="orange">需处理</Tag> : null}
                      <Text strong>{eventLabel(event)}</Text>
                    </Flex>
                    {event.durationMs !== undefined ? <Text type="secondary">{formatDuration(event.durationMs)}</Text> : null}
                  </Flex>
                  {eventDetail(event)}
                </div>
              ),
            };
          })}
      />

      {olderEvents.length > 0 ? (
        <Collapse
          ghost
          className="trajectory-older-event-collapse"
          activeKey={showOlderEvents ? ['older-events'] : []}
          onChange={(keys) => setShowOlderEvents(keys.includes('older-events'))}
          items={[{
            key: 'older-events',
            label: showOlderEvents ? `更早的 ${olderEvents.length} 个事件` : `更早的 ${olderEvents.length} 个事件（已折叠）`,
            children: (
              <Timeline
                className="trajectory-turn-timeline trajectory-turn-timeline--older"
                titleSpan="20%"
                items={olderEvents.map((event) => {
                  const marker = eventMarker(event);
                  return {
                    label: formatTime(event.timestamp),
                    color: eventColor(event),
                    dot: event.type === 'model_call' ? <RobotOutlined /> : event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'tool_progress' ? <ToolOutlined /> : event.type === 'permission' || event.type === 'permission_completed' || event.type === 'user_input_requested' ? <WarningOutlined /> : event.type === 'session_idle' || event.type === 'turn_end' ? <CheckCircleOutlined /> : undefined,
                    children: (
                      <div className={`trajectory-event-row${marker ? ` trajectory-event-row--${marker}` : ''}`}>
                        <Flex justify="space-between" align="center" gap={12} wrap>
                          <Flex align="center" gap={6} wrap>
                            {marker === 'error' ? <Tag color="red">异常</Tag> : null}
                            {marker === 'warning' ? <Tag color="orange">需处理</Tag> : null}
                            <Text strong>{eventLabel(event)}</Text>
                          </Flex>
                          {event.durationMs !== undefined ? <Text type="secondary">{formatDuration(event.durationMs)}</Text> : null}
                        </Flex>
                        {eventDetail(event)}
                      </div>
                    ),
                  };
                })}
              />
            ),
          }]}
        />
      ) : null}

      {!events.some((event) => event.type === 'model_call') ? (
        <Alert
          type="info"
          showIcon
          title="本轮没有记录到模型调用"
          description="如果这是旧的执行记录，运行时细节可能还没有被采集；从下一轮开始会记录模型调用、Token、工具调用和上下文整理。"
        />
      ) : null}
    </Card>
  );
}

/**
 * 统一生成某一轮的折叠项，保证“最近轮次”和“更早轮次”使用完全一致的摘要信息。
 */
function turnCollapseItem(turn: TrajectoryTurnSummary, turnEvents: Map<string, TrajectoryEvent[]>) {
  return {
    key: turn.turnId,
    label: (
      <Flex justify="space-between" align="center" gap={12} wrap>
        <span className="trajectory-collapse-question">{turn.userQuestion || '本轮 Agent 执行'}</span>
        <Space size={6} wrap>
          <Tag>Token {formatTokens(turn.summary.totalTokens)}</Tag>
          <Tag>模型 {turn.modelCalls}</Tag>
          <Tag>工具 {turn.toolCalls}</Tag>
        </Space>
      </Flex>
    ),
    children: <TurnCard turn={turn} events={turnEvents.get(turn.turnId) ?? []} />,
  };
}

export function AgentTrajectoryPage(props: { sessionName: string; onBack: () => void }) {
  const [events, setEvents] = useState<TrajectoryEvent[]>([]);
  const [summary, setSummary] = useState<TrajectorySummary | null>(null);
  const [turns, setTurns] = useState<TrajectoryTurnSummary[]>([]);
  const [conversationTurns, setConversationTurns] = useState<ConversationTurnSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(props.sessionName)}/trajectory?limit=5000`);
      if (!response.ok) throw new Error((await response.text()) || response.statusText);
      const data = await response.json() as {
        events: TrajectoryEvent[];
        summary: TrajectorySummary | null;
        turns: TrajectoryTurnSummary[];
        conversationTurns: ConversationTurnSummary[];
      };
      setEvents(data.events);
      setSummary(data.summary);
      setTurns(data.turns);
      setConversationTurns(data.conversationTurns);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // 执行中的 Turn 需要自动刷新，否则“等待确认/卡住”只能靠手动刷新才能看到。
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [props.sessionName]);

  const turnEvents = useMemo(() => {
    const grouped = new Map<string, TrajectoryEvent[]>();
    for (const event of events) {
      const items = grouped.get(event.turnId) ?? [];
      items.push(event);
      grouped.set(event.turnId, items);
    }
    return grouped;
  }, [events]);

  const displayTurns = useMemo<TrajectoryTurnSummary[]>(() => {
    const byId = new Map(turns.map((turn) => [turn.turnId, turn]));
    for (const turn of conversationTurns) {
      if (byId.has(turn.turnId)) continue;
      byId.set(turn.turnId, {
        turnId: turn.turnId,
        userQuestion: turn.question,
        summary: {
          turnId: turn.turnId,
          startedAt: turn.createdAt,
          ...(turn.status === 'completed' ? { finishedAt: turn.updatedAt } : {}),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          models: {},
          eventCount: 0,
        },
        modelCalls: 0,
        toolCalls: 0,
        failedEvents: turn.status === 'failed' ? 1 : 0,
        compactions: 0,
      });
    }
    return [...byId.values()].sort((a, b) => a.summary.startedAt.localeCompare(b.summary.startedAt));
  }, [conversationTurns, turns]);

  const totalToolCalls = displayTurns.reduce((sum, turn) => sum + turn.toolCalls, 0);

  const totalModelCalls = displayTurns.reduce((sum, turn) => sum + turn.modelCalls, 0);
  const contextEvents = events.filter((event) => event.type === 'status' && event.name === '上下文占用');
  const latestContext = contextEvents.at(-1);

  // 页面按“最新 → 最旧”展示。只保留最近几轮作为一级列表，避免历史很长时页面不断变高。
  const recentTurns = useMemo(() => displayTurns.slice().reverse().slice(0, RECENT_TURN_COUNT), [displayTurns]);
  const olderTurns = useMemo(() => displayTurns.slice().reverse().slice(RECENT_TURN_COUNT), [displayTurns]);
  const latestTurnId = recentTurns[0]?.turnId;

  return (
    <div className="trajectory-page-shell">
      <header className="subpage-header">
        <Flex align="center" gap={10}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={props.onBack}>返回调查</Button>
          <Title level={4} style={{ margin: 0 }}>Agent 执行轨迹</Title>
          <Tag color="blue">Copilot · 实时</Tag>
        </Flex>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
      </header>

      <div className="trajectory-page-body">
        {!events.length ? (
          <Empty description="还没有执行轨迹。下一轮 Agent 执行后，这里会记录模型调用、工具调用、上下文整理和用量。" />
        ) : (
          <>
            <Row gutter={[12, 12]} className="trajectory-stat-row">
              <Col xs={12} lg={6}><Card><Statistic title="已采集总 Token" value={summary?.totalTokens ?? 0} /></Card></Col>
              <Col xs={12} lg={6}><Card><Statistic title="输入 Token" value={summary?.inputTokens ?? 0} /></Card></Col>
              <Col xs={12} lg={6}><Card><Statistic title="输出 Token" value={summary?.outputTokens ?? 0} /></Card></Col>
              <Col xs={12} lg={6}>
                <Card>
                  <Statistic
                    title="AI 额度（nano-AIU）"
                    value={summary?.totalNanoAiu ?? 0}
                  />
                </Card>
              </Col>
            </Row>

            <Card className="trajectory-overview-card">
              <Flex justify="space-between" align="center" gap={12} wrap>
                <Space wrap>
                  <Tag>{displayTurns.length} 轮</Tag>
                  <Tag icon={<RobotOutlined />}>{totalModelCalls} 次模型调用</Tag>
                  <Tag icon={<ToolOutlined />}>{totalToolCalls} 次工具调用</Tag>
                  {summary?.totalPremiumRequestCost !== undefined ? (
                    <Tag icon={<DollarOutlined />}>Premium Request Cost {formatCost(summary.totalPremiumRequestCost)}</Tag>
                  ) : null}
                </Space>
                {latestContext ? (() => {
                  const current = typeof latestContext.details.currentTokens === 'number' ? latestContext.details.currentTokens : 0;
                  const limit = typeof latestContext.details.tokenLimit === 'number' ? latestContext.details.tokenLimit : 0;
                  const percent = limit > 0 ? Math.min(100, Math.round(current / limit * 100)) : 0;
                  return (
                    <div className="trajectory-context-meter">
                      <Text type="secondary">当前上下文 {formatTokens(current)} / {formatTokens(limit)}</Text>
                      {limit > 0 ? <Progress percent={percent} size="small" showInfo={false} /> : null}
                    </div>
                  );
                })() : null}
              </Flex>
              <Paragraph type="secondary" className="trajectory-note">
                这里只展示可观察的执行事件，不展示模型隐藏推理过程。除了模型 Token/额度，还会记录工具参数摘要、工具返回摘要、权限请求、Session idle、Session error、上下文变化和最后活动，方便定位“为什么一直没结束”。
              </Paragraph>
            </Card>

            <Collapse
              className="trajectory-turn-list"
              defaultActiveKey={latestTurnId ? [latestTurnId] : []}
              items={[
                ...recentTurns.map((turn) => turnCollapseItem(turn, turnEvents)),
                ...(olderTurns.length > 0 ? [{
                  key: "older-turns",
                  label: <Text type="secondary">更早的 {olderTurns.length} 轮</Text>,
                  children: (
                    <Collapse
                      className="trajectory-older-turn-list"
                      items={olderTurns.map((turn) => turnCollapseItem(turn, turnEvents))}
                    />
                  ),
                }] : []),
              ]}
            />
          </>
        )}
      </div>
    </div>
  );
}
