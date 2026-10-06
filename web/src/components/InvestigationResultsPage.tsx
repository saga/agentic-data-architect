import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Divider, Empty, Flex, Space, Table, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, HistoryOutlined, SettingOutlined, ToolOutlined } from '@ant-design/icons';
import { XMarkdown } from '@ant-design/x-markdown';
import type { ResultAssessment, ResultModernization, ResultSection, ResultViewModel } from '../../../src/api/results.js';

const { Title, Text, Paragraph } = Typography;

function workflowLabel(workflow: ResultViewModel['session']['workflow']): string {
  switch (workflow) {
    case 'legacy-modernization': return '改造已有系统';
    case 'financial-ai-native-architecture': return '金融 AI / 数据架构设计';
    case 'data-architecture-assessment': return '数据架构评估';
    default: return '自主调查';
  }
}

function sectionMessage<T>(section: ResultSection<T>, fallback: string): string {
  if ('message' in section && section.message) return section.message;
  return fallback;
}

function ResultSectionState(props: {
  section: ResultSection<unknown>;
  emptyMessage: string;
  onBack?: () => void;
}) {
  if (props.section.status === 'blocked') {
    return (
      <Alert
        type='warning'
        showIcon
        message='当前结果还不能生成'
        description={sectionMessage(props.section, props.emptyMessage)}
        action={props.onBack ? <Button type='link' onClick={props.onBack}>回调查确认范围</Button> : undefined}
      />
    );
  }
  if (props.section.status === 'error') {
    return <Alert type='error' showIcon message='读取结果失败' description={sectionMessage(props.section, props.emptyMessage)} />;
  }
  if (props.section.status === 'empty') {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={sectionMessage(props.section, props.emptyMessage)} />;
  }
  if (props.section.status === 'not_applicable') return null;
  return null;
}

function renderModernization(
  section: ResultViewModel['modernization'],
  onBack: () => void,
) {
  if (section.status !== 'available') {
    return <ResultSectionState section={section} emptyMessage='还没有形成改造工作成果。' onBack={onBack} />;
  }
  const modernization: ResultModernization = section.data;
  return (
    <>
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
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (value: string, record: ResultModernization['validationPlan']['checks'][number]) => (
                <Tag color={value === 'passed' ? 'green' : value === 'failed' ? 'red' : record.blocking ? 'orange' : undefined}>{value}</Tag>
              ),
            },
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
    </>
  );
}

function renderAssessment(
  section: ResultViewModel['assessment'],
  onBack: () => void,
) {
  if (section.status !== 'available') {
    return <ResultSectionState section={section} emptyMessage='还没有形成架构评估成果。' onBack={onBack} />;
  }
  const assessment: ResultAssessment = section.data;
  return (
    <>
      <Card className='results-assessment-card' title='当前状态'>
        <Flex wrap gap={8} style={{ marginBottom: 12 }}>
          <Tag>数据集 {assessment.currentState.datasets}</Tag>
          <Tag>语义资产 {assessment.currentState.semanticAssets}</Tag>
          <Tag>Finding {assessment.currentState.findings}</Tag>
          <Tag>Unknown {assessment.currentState.unknowns}</Tag>
          <Tag>
            血缘覆盖 {assessment.currentState.lineageCoverage === null
              ? '未记录'
              : Math.round(assessment.currentState.lineageCoverage * 100) + '%'}
          </Tag>
        </Flex>
        <Paragraph>{assessment.goal}</Paragraph>
        <Text type='secondary'>范围：{assessment.scope.join('、') || '未记录'}</Text>
      </Card>

      <Card className='results-assessment-card' title='主要问题'>
        {assessment.findings.length ? (
          assessment.findings.map((finding) => (
            <Card key={finding.id} size='small' style={{ marginBottom: 8 }}>
              <Flex align='center' gap={8} wrap>
                <Text strong>{finding.title}</Text>
                <Tag color={finding.severity === 'high' ? 'red' : undefined}>{finding.severity}</Tag>
              </Flex>
              <Paragraph style={{ marginBottom: 6 }}>{finding.description}</Paragraph>
              <Text>建议：{finding.recommendation}</Text>
              <div style={{ marginTop: 6 }}>
                <Text type='secondary'>Evidence {finding.evidenceIds.length} 条</Text>
              </div>
            </Card>
          ))
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description='当前还没有形成可单独展示的 Finding。' />}
      </Card>

      <Card className='results-assessment-card' title='建议与路线'>
        {assessment.recommendations.length ? (
          <>
            <Text strong>建议</Text>
            {assessment.recommendations.map((item) => <div key={item}>· {item}</div>)}
          </>
        ) : null}
        {assessment.roadmap.length ? (
          <>
            <Divider style={{ margin: '14px 0' }} />
            <Text strong>路线</Text>
            {assessment.roadmap.map((item) => (
              <Card key={item.id} size='small' style={{ marginTop: 8 }}>
                <Text strong>{item.title}</Text>
                <Paragraph style={{ marginBottom: 6 }}>{item.objective}</Paragraph>
                <Text type='secondary'>关联 Finding {item.findingIds.length} 项</Text>
              </Card>
            ))}
          </>
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description='还没有形成评估路线。' />}
      </Card>
    </>
  );
}

export function InvestigationResultsPage(props: {
  sessionName: string;
  onBack: () => void;
  onOpenConfig: () => void;
  onOpenTrajectory: () => void;
}) {
  const [result, setResult] = useState<ResultViewModel>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch('/api/sessions/' + encodeURIComponent(props.sessionName) + '/results');
      if (!response.ok) throw new Error((await response.text()) || response.statusText);
      setResult(await response.json() as ResultViewModel);
    } catch (cause) {
      setResult(undefined);
      setError(cause instanceof Error ? cause.message : '无法读取调查结果');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [props.sessionName]);

  const workflow = useMemo(() => workflowLabel(result?.session.workflow ?? null), [result?.session.workflow]);

  return (
    <div className='subpage-app investigation-results-page'>
      <header className='results-page-header'>
        <Flex align='center' gap={10}>
          <Button type='text' icon={<ArrowLeftOutlined />} onClick={props.onBack}>返回调查</Button>
          <Title level={4} style={{ margin: 0 }}>调查结果</Title>
          <Tag>{workflow}</Tag>
        </Flex>
        <Space>
          <Button icon={<SettingOutlined />} onClick={props.onOpenConfig}>调查配置</Button>
          <Button icon={<ToolOutlined />} onClick={props.onOpenTrajectory}>Agent 轨迹</Button>
          <Button icon={<HistoryOutlined />} onClick={() => void load()} loading={loading}>刷新</Button>
        </Space>
      </header>

      {error ? (
        <Card className='results-error'>
          <Text type='danger'>{error}</Text>
        </Card>
      ) : null}

      {loading && !result ? (
        <Card><Text type='secondary'>正在读取调查结果…</Text></Card>
      ) : result ? (
        <main className='investigation-results-body'>
          <section className='results-checkpoints'>
            <Flex align='center' justify='space-between' className='results-section-heading'>
              <div>
                <Title level={5} style={{ margin: 0 }}>阶段小结</Title>
                <Text type='secondary'>每一阶段形成的关键结论都留在这里，方便回头看调查是怎么推进的。</Text>
              </div>
              <Tag>{result.checkpoints.length} 个阶段</Tag>
            </Flex>

            {!result.checkpoints.length ? (
              <Card><Empty description='还没有形成阶段小结。完成一次调查后，这里会保留每个阶段的结果。' /></Card>
            ) : (
              <div className='results-checkpoint-list'>
                {result.checkpoints.map((checkpoint, index) => (
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

          {result.modernization.status !== 'not_applicable' ? (
            <section className='results-modernization'>
              <Flex align='center' justify='space-between' className='results-section-heading'>
                <div>
                  <Title level={5} style={{ margin: 0 }}>改造工作成果</Title>
                  <Text type='secondary'>这里显示已经写入工作区的目标架构、新旧对应和验证结果，不以 Agent 的 success 回复代替成果。</Text>
                </div>
                {result.modernization.status === 'available' ? (
                  <Space wrap>
                    <Tag>目标组件 {result.modernization.data.targetArchitecture.components.length}</Tag>
                    <Tag>新旧对应 {result.modernization.data.mappings.length}</Tag>
                    <Tag color={result.modernization.data.validationPlan.checks.some((check) => check.blocking && check.status !== 'passed') ? 'orange' : 'green'}>
                      验证通过 {result.modernization.data.validationPlan.checks.filter((check) => check.status === 'passed').length}/{result.modernization.data.validationPlan.checks.length}
                    </Tag>
                  </Space>
                ) : null}
              </Flex>
              {renderModernization(result.modernization, props.onBack)}
            </section>
          ) : null}

          {result.assessment.status !== 'not_applicable' ? (
            <section className='results-assessment'>
              <Flex align='center' justify='space-between' className='results-section-heading'>
                <div>
                  <Title level={5} style={{ margin: 0 }}>架构评估成果</Title>
                  <Text type='secondary'>这里显示基于当前调查事实和 Finding 形成的评估、建议和路线。</Text>
                </div>
                {result.assessment.status === 'available' ? (
                  <Space wrap>
                    <Tag>Finding {result.assessment.data.findings.length}</Tag>
                    <Tag>建议 {result.assessment.data.recommendations.length}</Tag>
                    <Tag>路线 {result.assessment.data.roadmap.length}</Tag>
                  </Space>
                ) : null}
              </Flex>
              {renderAssessment(result.assessment, props.onBack)}
            </section>
          ) : null}

          <section className='results-report'>
            <Flex align='center' justify='space-between' className='results-section-heading'>
              <div>
                <Title level={5} style={{ margin: 0 }}>结果报告</Title>
                <Text type='secondary'>根据当前调查资料生成的完整报告。</Text>
              </div>
              {result.session ? (
                <Flex gap={8}>
                  <Tag>配置 v{result.session.controlVersion}</Tag>
                  <Tag>{result.session.agentDisplayName}</Tag>
                  {result.report.status === 'available' ? (
                    <Tag color={result.report.data.review.status === 'pass' ? 'green' : 'orange'}>
                      Reviewer {result.report.data.review.score}
                    </Tag>
                  ) : null}
                </Flex>
              ) : null}
            </Flex>

            <Card className='results-report-card'>
              {result.report.status === 'available' ? (
                <XMarkdown content={result.report.data.markdown} className='result-report-markdown x-markdown-light' />
              ) : (
                <ResultSectionState section={result.report} emptyMessage='还没有可展示的结果报告。' onBack={props.onBack} />
              )}
            </Card>
          </section>
        </main>
      ) : null}
    </div>
  );
}
