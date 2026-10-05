import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Flex, Space, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, HistoryOutlined, SettingOutlined, ToolOutlined } from '@ant-design/icons';
import { XMarkdown } from '@ant-design/x-markdown';

const { Title, Text, Paragraph } = Typography;

interface Checkpoint {
  id: string;
  turnId: string;
  timestamp: string;
  execution: number;
  title: string;
  summary: string;
  confirmed: string[];
  evidenceIds: string[];
  unknowns: string[];
  nextStep?: string;
}

interface TrajectoryEvent {
  type: string;
  timestamp: string;
  details?: unknown;
}

interface SessionSnapshot {
  context: { workflow: string | null };
  control: { version: number; agent: { model: string; displayName: string } };
}

function asCheckpoint(event: TrajectoryEvent): Checkpoint | undefined {
  if (event.type !== 'checkpoint' || !event.details || typeof event.details !== 'object') return undefined;
  const value = event.details as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.summary !== 'string') return undefined;
  return {
    id: value.id,
    turnId: typeof value.turnId === 'string' ? value.turnId : '',
    timestamp: event.timestamp,
    execution: typeof value.execution === 'number' ? value.execution : 0,
    title: value.title,
    summary: value.summary,
    confirmed: Array.isArray(value.confirmed) ? value.confirmed.filter((item): item is string => typeof item === 'string') : [],
    evidenceIds: Array.isArray(value.evidenceIds) ? value.evidenceIds.filter((item): item is string => typeof item === 'string') : [],
    unknowns: Array.isArray(value.unknowns) ? value.unknowns.filter((item): item is string => typeof item === 'string') : [],
    ...(typeof value.nextStep === 'string' ? { nextStep: value.nextStep } : {}),
  };
}

export function InvestigationResultsPage(props: {
  sessionName: string;
  onBack: () => void;
  onOpenConfig: () => void;
  onOpenTrajectory: () => void;
}) {
  const [report, setReport] = useState('');
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [session, setSession] = useState<SessionSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [reportResponse, trajectoryResponse, sessionResponse] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(props.sessionName)}/report`),
        fetch(`/api/sessions/${encodeURIComponent(props.sessionName)}/trajectory?limit=5000`),
        fetch(`/api/sessions/${encodeURIComponent(props.sessionName)}`),
      ]);
      if (!reportResponse.ok) throw new Error((await reportResponse.text()) || reportResponse.statusText);
      if (!trajectoryResponse.ok) throw new Error((await trajectoryResponse.text()) || trajectoryResponse.statusText);
      if (!sessionResponse.ok) throw new Error((await sessionResponse.text()) || sessionResponse.statusText);

      const [reportText, trajectoryData, sessionData] = await Promise.all([
        reportResponse.text(),
        trajectoryResponse.json() as Promise<{events?: TrajectoryEvent[]}>,
        sessionResponse.json() as Promise<SessionSnapshot>,
      ]);

      const unique = new Map<string, Checkpoint>();
      for (const event of trajectoryData.events ?? []) {
        const checkpoint = asCheckpoint(event);
        if (checkpoint) unique.set(checkpoint.id, checkpoint);
      }
      setReport(reportText);
      setCheckpoints([...unique.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      setSession(sessionData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取调查结果');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [props.sessionName]);

  const workflowLabel = useMemo(() => {
    switch (session?.context.workflow) {
      case 'legacy-modernization': return '改造已有系统';
      case 'financial-ai-native-architecture': return '金融 AI / 数据架构设计';
      case 'data-architecture-assessment': return '数据架构评估';
      default: return '自主调查';
    }
  }, [session?.context.workflow]);

  return (
    <div className='subpage-app investigation-results-page'>
      <header className='results-page-header'>
        <Flex align='center' gap={10}>
          <Button type='text' icon={<ArrowLeftOutlined />} onClick={props.onBack}>返回调查</Button>
          <Title level={4} style={{ margin: 0 }}>调查结果</Title>
          <Tag>{workflowLabel}</Tag>
        </Flex>
        <Space>
          <Button icon={<SettingOutlined />} onClick={props.onOpenConfig}>调查配置</Button>
          <Button icon={<ToolOutlined />} onClick={props.onOpenTrajectory}>Agent 轨迹</Button>
          <Button icon={<HistoryOutlined />} onClick={() => void load()} loading={loading}>刷新</Button>
        </Space>
      </header>

      <main className='investigation-results-body'>
        <section className='results-checkpoints'>
          <Flex align='center' justify='space-between' className='results-section-heading'>
            <div>
              <Title level={5} style={{ margin: 0 }}>阶段小结</Title>
              <Text type='secondary'>每一阶段形成的关键结论都留在这里，方便回头看调查是怎么推进的。</Text>
            </div>
            <Tag>{checkpoints.length} 个阶段</Tag>
          </Flex>

          {error ? <Card className='results-error'><Text type='danger'>{error}</Text></Card> : null}

          {!loading && !checkpoints.length ? (
            <Card><Empty description='还没有形成阶段小结。完成一次调查后，这里会保留每个阶段的结果。' /></Card>
          ) : (
            <div className='results-checkpoint-list'>
              {checkpoints.map((checkpoint, index) => (
                <Card key={checkpoint.id} className='results-checkpoint-card'>
                  <Flex align='center' justify='space-between' gap={10} wrap>
                    <Flex align='center' gap={8}>
                      <Tag color='blue'>阶段 {index + 1}</Tag>
                      <Text strong className='results-checkpoint-title'>{checkpoint.title}</Text>
                    </Flex>
                    <Text type='secondary'>{new Date(checkpoint.timestamp).toLocaleString()}</Text>
                  </Flex>
                  <Paragraph className='results-checkpoint-summary'>{checkpoint.summary}</Paragraph>
                  {checkpoint.confirmed.length ? (
                    <div>
                      <Text type='secondary'>已确认</Text>
                      <div className='results-checkpoint-items'>
                        {checkpoint.confirmed.map(item => <div key={item}>· {item}</div>)}
                      </div>
                    </div>
                  ) : null}
                  <Flex wrap gap={8}>
                    <Tag>Evidence {checkpoint.evidenceIds.length} 条</Tag>
                    {checkpoint.unknowns.length ? <Tag color='orange'>未确认 {checkpoint.unknowns.length} 项</Tag> : null}
                  </Flex>
                  {checkpoint.nextStep ? (
                    <div className='results-checkpoint-next'>
                      <Text type='secondary'>下一步：</Text>{checkpoint.nextStep}
                    </div>
                  ) : null}
                </Card>
              ))}
            </div>
          )}
        </section>

        <section className='results-report'>
          <Flex align='center' justify='space-between' className='results-section-heading'>
            <div>
              <Title level={5} style={{ margin: 0 }}>结果报告</Title>
              <Text type='secondary'>根据当前调查资料生成的完整报告。</Text>
            </div>
            <Flex gap={8}>
              <Tag>{session ? `配置 v${session.control.version}` : '配置'}</Tag>
              <Tag>{session?.control.agent.displayName ?? '秘书'}</Tag>
            </Flex>
          </Flex>
          <Card className='results-report-card'>
            {loading ? <Text type='secondary'>正在读取结果…</Text> : report ? (
              <XMarkdown content={report} className='result-report-markdown x-markdown-light' />
            ) : (
              <Empty description='还没有可展示的结果报告。' />
            )}
          </Card>
        </section>
      </main>
    </div>
  );
}
