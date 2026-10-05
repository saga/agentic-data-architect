import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Divider, Empty, Flex, Space, Table, Tag, Typography } from 'antd';
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

interface ModernizationPlan {
  version: number;
  status: string;
  targetArchitecture: {
    title: string;
    status: string;
    principles: string[];
    components: Array<{ id: string; name: string; description: string; sourceAssets: string[] }>;
    openQuestions: string[];
    evidenceIds: string[];
  };
  mappings: Array<{
    id: string;
    title: string;
    status: string;
    sourceAsset: string;
    targetAsset: string;
    transformation?: string;
    businessRule?: string;
    validationRule?: string;
    evidenceIds: string[];
  }>;
  mappingCoverage?: { sourceAssets: string[]; unmappedAssets: string[] };
  validationPlan: {
    checks: Array<{
      id: string;
      name: string;
      status: string;
      blocking: boolean;
      evidenceIds: string[];
      result?: string;
    }>;
    cutoverCriteria: string[];
    rollbackCriteria: string[];
  };
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
  const [modernization, setModernization] = useState<ModernizationPlan>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [reportResponse, trajectoryResponse, sessionResponse, modernizationResponse] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(props.sessionName)}/report`),
        fetch(`/api/sessions/${encodeURIComponent(props.sessionName)}/trajectory?limit=5000`),
        fetch(`/api/sessions/${encodeURIComponent(props.sessionName)}`),
        fetch(`/api/sessions/${encodeURIComponent(props.sessionName)}/modernization`),
      ]);
      if (!reportResponse.ok) throw new Error((await reportResponse.text()) || reportResponse.statusText);
      if (!trajectoryResponse.ok) throw new Error((await trajectoryResponse.text()) || trajectoryResponse.statusText);
      if (!sessionResponse.ok) throw new Error((await sessionResponse.text()) || sessionResponse.statusText);
      if (!modernizationResponse.ok) throw new Error((await modernizationResponse.text()) || modernizationResponse.statusText);

      const [reportText, trajectoryData, sessionData, modernizationData] = await Promise.all([
        reportResponse.text(),
        trajectoryResponse.json() as Promise<{events?: TrajectoryEvent[]}>,
        sessionResponse.json() as Promise<SessionSnapshot>,
        modernizationResponse.json() as Promise<{plan?: ModernizationPlan | null}>,
      ]);

      const unique = new Map<string, Checkpoint>();
      for (const event of trajectoryData.events ?? []) {
        const checkpoint = asCheckpoint(event);
        if (checkpoint) unique.set(checkpoint.id, checkpoint);
      }
      setReport(reportText);
      setCheckpoints([...unique.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      setSession(sessionData);
      setModernization(modernizationData.plan ?? undefined);
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

        {modernization ? (
          <section className='results-modernization'>
            <Flex align='center' justify='space-between' className='results-section-heading'>
              <div>
                <Title level={5} style={{ margin: 0 }}>改造工作成果</Title>
                <Text type='secondary'>这里显示已经写入工作区的目标架构、新旧对应和验证结果，不以 Agent 的 success 回复代替成果。</Text>
              </div>
              <Space wrap>
                <Tag>目标组件 {modernization.targetArchitecture.components.length}</Tag>
                <Tag>新旧对应 {modernization.mappings.length}</Tag>
                <Tag color={modernization.validationPlan.checks.some((check) => check.blocking && check.status !== 'passed') ? 'orange' : 'green'}>
                  验证通过 {modernization.validationPlan.checks.filter((check) => check.status === 'passed').length}/{modernization.validationPlan.checks.length}
                </Tag>
              </Space>
            </Flex>

            <Card className='results-modernization-card' title='目标架构'>
              {modernization.targetArchitecture.components.length ? (
                <>
                  <Flex wrap gap={8} style={{ marginBottom: 12 }}>
                    {modernization.targetArchitecture.principles.map((principle) => <Tag key={principle}>{principle}</Tag>)}
                  </Flex>
                  {modernization.targetArchitecture.components.map((component) => (
                    <Card key={component.id} size='small' style={{ marginBottom: 8 }}>
                      <Text strong>{component.name}</Text>
                      <Paragraph style={{ marginBottom: 6 }}>{component.description}</Paragraph>
                      <Text type='secondary'>来源：{component.sourceAssets.join('、') || '未记录'}</Text>
                    </Card>
                  ))}
                </>
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description='目标架构还没有实际组件。' />}
              {modernization.targetArchitecture.openQuestions.length ? (
                <div>
                  <Divider style={{ margin: '14px 0' }} />
                  <Text type='secondary'>还未解决</Text>
                  {modernization.targetArchitecture.openQuestions.map((item) => <div key={item}>· {item}</div>)}
                </div>
              ) : null}
            </Card>

            <Card className='results-modernization-card' title='新旧对应'>
              {modernization.mappings.length ? (
                <>
                  <Flex wrap gap={8} style={{ marginBottom: 12 }}>
                    <Tag>已保存 {modernization.mappings.length} 条</Tag>
                    <Tag color={modernization.mappingCoverage?.unmappedAssets.length ? 'orange' : 'green'}>
                      未对应 {modernization.mappingCoverage?.unmappedAssets.length ?? '未记录'}
                    </Tag>
                  </Flex>
                  <Table
                    size='small'
                    rowKey='id'
                    scroll={{ x: 1100 }}
                    dataSource={modernization.mappings}
                    columns={[
                      { title: '旧数据', dataIndex: 'sourceAsset', width: 180 },
                      { title: '新数据', dataIndex: 'targetAsset', width: 180 },
                      { title: '怎么改', dataIndex: 'transformation', width: 230, render: (value: string | undefined) => value || '未记录' },
                      { title: '业务规则', dataIndex: 'businessRule', width: 230, render: (value: string | undefined) => value || '未记录' },
                      { title: '怎么验证', dataIndex: 'validationRule', width: 230, render: (value: string | undefined) => value || '未记录' },
                      { title: '状态', dataIndex: 'status', width: 90, render: (value: string) => <Tag>{value}</Tag> },
                      { title: 'Evidence', dataIndex: 'evidenceIds', width: 80, render: (value: string[]) => <Tag>{value?.length ?? 0}</Tag> },
                    ]}
                    pagination={false}
                  />
                </>
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description='还没有保存新旧对应结果。' />}
            </Card>

            <Card className='results-modernization-card' title='验证结果'>
              <Table
                size='small'
                rowKey='id'
                dataSource={modernization.validationPlan.checks}
                columns={[
                  { title: '检查项', dataIndex: 'name', width: 220 },
                  { title: '状态', dataIndex: 'status', width: 90, render: (value: string, record: ModernizationPlan['validationPlan']['checks'][number]) => (
                    <Tag color={value === 'passed' ? 'green' : value === 'failed' ? 'red' : record.blocking ? 'orange' : undefined}>{value}</Tag>
                  )},
                  { title: '实际结果', dataIndex: 'result', render: (value: string | undefined) => value || '尚未执行' },
                  { title: 'Evidence', dataIndex: 'evidenceIds', width: 80, render: (value: string[]) => <Tag>{value?.length ?? 0}</Tag> },
                ]}
                pagination={false}
              />
              <Divider style={{ margin: '16px 0' }} />
              <Flex gap={24} wrap>
                <div><Text strong>切换条件</Text>{modernization.validationPlan.cutoverCriteria.map((item) => <div key={item}>· {item}</div>)}</div>
                <div><Text strong>回退条件</Text>{modernization.validationPlan.rollbackCriteria.map((item) => <div key={item}>· {item}</div>)}</div>
              </Flex>
            </Card>
          </section>
        ) : null}
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
