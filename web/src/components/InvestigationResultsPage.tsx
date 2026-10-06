import { useEffect, useMemo, useState } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Divider, Empty, Flex, Space, Table, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, HistoryOutlined, ReloadOutlined, SettingOutlined, ToolOutlined } from '@ant-design/icons';
import { TrajectoryResponseSchema, ModernizationResponseSchema, type TrajectoryEvent, type ModernizationPlanView } from '../../../src/api/contracts.js';
import type { InvestigationCheckpoint } from '../app/types.js';
import { XMarkdown } from '@ant-design/x-markdown';

type Checkpoint = InvestigationCheckpoint;
type ModernizationPlan = ModernizationPlanView;

interface SessionSnapshot {
  context: { workflow: string | null };
  control: { version: number; agent: { model: string; displayName: string } };
}


const { Title, Text, Paragraph } = Typography;

function asCheckpoint(event: TrajectoryEvent): InvestigationCheckpoint | undefined {
  if (event.type !== 'checkpoint' || !event.details || typeof event.details !== 'object') return undefined;
  const value = event.details as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.summary !== 'string') return undefined;
  return {
    id: value.id,
    turnId: event.turnId,
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
  const [reportGateError, setReportGateError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    setReportGateError(undefined);
    try {
      const sessionPath = '/api/sessions/' + encodeURIComponent(props.sessionName);
      const [reportResponse, trajectoryResponse, sessionResponse, modernizationResponse] = await Promise.all([
        fetch(sessionPath + '/report'),
        fetch(sessionPath + '/trajectory?limit=5000'),
        fetch(sessionPath),
        fetch(sessionPath + '/modernization'),
      ]);
      if (!reportResponse.ok && reportResponse.status !== 404 && reportResponse.status !== 409) {
        throw new Error((await reportResponse.text()) || reportResponse.statusText);
      }
      if (!trajectoryResponse.ok) throw new Error((await trajectoryResponse.text()) || trajectoryResponse.statusText);
      if (!sessionResponse.ok) throw new Error((await sessionResponse.text()) || sessionResponse.statusText);
      if (!modernizationResponse.ok && modernizationResponse.status !== 409) throw new Error((await modernizationResponse.text()) || modernizationResponse.statusText);

      const [reportPayload, trajectoryData, sessionData, modernizationData] = await Promise.all([
        reportResponse.ok
          ? reportResponse.text()
          : reportResponse.json() as Promise<{error?: string; code?: string}>,
        trajectoryResponse.json().then((payload: unknown) => TrajectoryResponseSchema.parse(payload)),
        sessionResponse.json() as Promise<SessionSnapshot>,
        modernizationResponse.ok
          ? modernizationResponse.json().then((payload: unknown) => ModernizationResponseSchema.parse(payload))
          : Promise.resolve({ plan: null }),
      ]);

      const unique = new Map<string, Checkpoint>();
      for (const event of trajectoryData.events) {
        const checkpoint = asCheckpoint(event);
        if (checkpoint) unique.set(checkpoint.id, checkpoint);
      }
      if (reportResponse.ok) {
        setReport(reportPayload as string);
      } else {
        setReport('');
        setReportGateError(
          typeof reportPayload === 'object' && reportPayload && typeof reportPayload.error === 'string'
            ? reportPayload.error
            : '范围还没有确认完整，正式报告暂时不能生成。',
        );
      }
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
          <Button
            icon={<ReloadOutlined />}
            type='primary'
            onClick={async () => {
              setLoading(true);
              setError(undefined);
              setReportGateError(undefined);
              try {
                const response = await fetch('/api/sessions/' + encodeURIComponent(props.sessionName) + '/report/regenerate', { method: 'POST' });
                if (!response.ok) throw new Error((await response.text()) || response.statusText);
                const payload = await response.json() as { markdown?: string };
                setReport(payload.markdown ?? '');
                await load();
              } catch (cause) {
                setReportGateError(cause instanceof Error ? cause.message : '报告重新生成失败');
                setLoading(false);
              }
            }}
            loading={loading}
          >重新生成报告</Button>
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
          {reportGateError ? (
            <Alert
              type='warning'
              showIcon
              message='结果报告暂时不能生成'
              description={reportGateError}
              action={<Button type='link' onClick={props.onBack}>回调查确认范围</Button>}
              style={{ marginBottom: 12 }}
            />
          ) : null}
          <Card className='results-report-card'>
            {loading ? <Text type='secondary'>正在读取结果…</Text> : report ? (
              <XMarkdown content={report} className='result-report-markdown x-markdown-light' />
            ) : reportGateError ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description='完成范围确认后再生成正式报告。' />
            ) : (
              <Empty description='还没有可展示的结果报告。' />
            )}
          </Card>
        </section>
      </main>
    </div>
  );
}
