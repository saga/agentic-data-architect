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
  ClockCircleOutlined,
  DollarOutlined,
  ReloadOutlined,
  RobotOutlined,
  ToolOutlined,
  WarningOutlined,
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

interface TrajectoryEvent {
  id: string;
  turnId: string;
  timestamp: string;
  type: 'user_input' | 'turn_start' | 'intent' | 'model_call' | 'tool_call' | 'tool_result' | 'permission' | 'compaction' | 'turn_end' | 'error' | 'status';
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

function eventLabel(event: TrajectoryEvent) {
  switch (event.type) {
    case 'user_input': return '用户提出问题';
    case 'turn_start': return '开始处理';
    case 'intent': return '当前动作';
    case 'model_call': return '模型调用';
    case 'tool_call': return '调用工具';
    case 'tool_result': return '工具返回';
    case 'permission': return '等待确认';
    case 'compaction': return '整理上下文';
    case 'turn_end': return '本轮完成';
    case 'error': return '执行失败';
    case 'status': return event.name;
    default: return event.name;
  }
}

function eventColor(event: TrajectoryEvent) {
  if (event.status === 'failed' || event.type === 'error') return 'red';
  if (event.status === 'waiting' || event.type === 'permission') return 'orange';
  if (event.type === 'model_call') return 'blue';
  if (event.type === 'tool_call' || event.type === 'tool_result') return 'blue';
  if (event.type === 'turn_end') return 'green';
  return undefined;
}

function eventDetail(event: TrajectoryEvent) {
  if (event.type === 'model_call') {
    const cached = typeof event.details.cachedInputTokens === 'number' ? event.details.cachedInputTokens : undefined;
    const reasoning = typeof event.details.reasoningTokens === 'number' ? event.details.reasoningTokens : undefined;
    return (
      <Space direction="vertical" size={4}>
        <Flex wrap gap={6}>
          {event.model ? <Tag>{event.model}</Tag> : null}
          <Tag>输入 {formatTokens(event.inputTokens ?? 0)}</Tag>
          <Tag>输出 {formatTokens(event.outputTokens ?? 0)}</Tag>
          <Tag>合计 {formatTokens((event.inputTokens ?? 0) + (event.outputTokens ?? 0))}</Tag>
          {event.premiumRequestCost !== undefined ? <Tag>Premium Request Cost {formatCost(event.premiumRequestCost)}</Tag> : null}
          {event.durationMs !== undefined ? <Tag>{formatDuration(event.durationMs)}</Tag> : null}
        </Flex>
        {cached !== undefined || reasoning !== undefined ? (
          <Text type="secondary">
            {cached !== undefined ? `缓存命中 ${formatTokens(cached)}` : ''}
            {cached !== undefined && reasoning !== undefined ? ' · ' : ''}
            {reasoning !== undefined ? `推理 Token ${formatTokens(reasoning)}` : ''}
          </Text>
        ) : null}
      </Space>
    );
  }

  if (event.type === 'tool_call' || event.type === 'tool_result') {
    const server = typeof event.details.mcpServerName === 'string' ? event.details.mcpServerName : undefined;
    const error = typeof event.details.error === 'string' ? event.details.error : undefined;
    return (
      <Flex vertical gap={3}>
        {server ? <Text type="secondary">MCP：{server}</Text> : null}
        {event.durationMs !== undefined ? <Text type="secondary">耗时：{formatDuration(event.durationMs)}</Text> : null}
        {error ? <Text type="danger">{error}</Text> : null}
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
  const summary = turn.summary;
  const status = turn.failedEvents ? '异常' : summary.finishedAt ? '已完成' : '处理中';

  return (
    <Card className="trajectory-turn-card">
      <Flex justify="space-between" align="flex-start" gap={16} wrap>
        <div className="trajectory-turn-heading">
          <Flex align="center" gap={8} wrap>
            <Badge status={turn.failedEvents ? 'error' : summary.finishedAt ? 'success' : 'processing'} />
            <Text strong className="trajectory-turn-title">
              {turn.userQuestion || '本轮 Agent 执行'}
            </Text>
            <Tag>{status}</Tag>
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
        items={events
          .filter((event) => event.type !== 'intent')
          .map((event) => ({
            label: formatTime(event.timestamp),
            color: eventColor(event),
            dot:
              event.type === 'model_call' ? <RobotOutlined /> :
              event.type === 'tool_call' || event.type === 'tool_result' ? <ToolOutlined /> :
              event.type === 'permission' ? <WarningOutlined /> :
              event.type === 'turn_end' ? <CheckCircleOutlined /> :
              undefined,
            children: (
              <div className="trajectory-event-row">
                <Flex justify="space-between" gap={12} wrap>
                  <Text strong>{eventLabel(event)}</Text>
                  {event.durationMs !== undefined ? <Text type="secondary">{formatDuration(event.durationMs)}</Text> : null}
                </Flex>
                {eventDetail(event)}
              </div>
            ),
          }))}
      />

      {!events.some((event) => event.type === 'model_call') ? (
        <Alert
          type="info"
          showIcon
          message="本轮没有记录到模型调用"
          description="如果这是旧的执行记录，运行时细节可能还没有被采集；从下一轮开始会记录模型调用、Token、工具调用和上下文整理。"
        />
      ) : null}
    </Card>
  );
}

export function AgentTrajectoryPage(props: { sessionName: string; onBack: () => void }) {
  const [events, setEvents] = useState<TrajectoryEvent[]>([]);
  const [summary, setSummary] = useState<TrajectorySummary | null>(null);
  const [turns, setTurns] = useState<TrajectoryTurnSummary[]>([]);
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
      };
      setEvents(data.events);
      setSummary(data.summary);
      setTurns(data.turns);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
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

  const totalToolCalls = turns.reduce((sum, turn) => sum + turn.toolCalls, 0);
  const totalModelCalls = turns.reduce((sum, turn) => sum + turn.modelCalls, 0);
  const contextEvents = events.filter((event) => event.type === 'status' && event.name === '上下文占用');
  const latestContext = contextEvents.at(-1);

  return (
    <div className="trajectory-page-shell">
      <header className="subpage-header">
        <Flex align="center" gap={10}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={props.onBack}>返回调查</Button>
          <Title level={4} style={{ margin: 0 }}>Agent 执行轨迹</Title>
          <Tag color="blue">Copilot</Tag>
        </Flex>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
      </header>

      <div className="trajectory-page-body">
        {!events.length ? (
          <Empty description="还没有执行轨迹。下一轮 Agent 执行后，这里会记录模型调用、工具调用、上下文整理和用量。" />
        ) : (
          <>
            <Row gutter={[12, 12]} className="trajectory-stat-row">
              <Col xs={12} lg={6}><Card><Statistic title="总 Token" value={summary?.totalTokens ?? 0} /></Card></Col>
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
                  <Tag>{turns.length} 轮</Tag>
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
                这里只展示可观察的执行事件，不展示模型隐藏推理过程。Token 来自 Copilot SDK 的模型调用用量；Premium Request Cost 是计费乘数，不是货币金额。GitHub Copilot SDK 提供的累计 AI 额度使用 nano-AIU 表示。
              </Paragraph>
            </Card>

            <Collapse
              className="trajectory-turn-list"
              defaultActiveKey={turns.length ? [turns.at(-1)!.turnId] : []}
              items={turns.slice().reverse().map((turn) => ({
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
              }))}
            />
          </>
        )}
      </div>
    </div>
  );
}
