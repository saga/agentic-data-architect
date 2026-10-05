import React from 'react';
import { Button, Card, Flex, Input, Modal, Progress, Tag, Typography } from 'antd';
import type { MissionContract, MissionDraft, MissionProgress } from '../app/types';

const { Text, Paragraph } = Typography;

export function MissionContractPanel(props: {
  mission?: MissionContract;
  progress?: MissionProgress | null;
  draft: MissionDraft;
  open: boolean;
  saving: boolean;
  loading?: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (draft: MissionDraft) => void;
  onConfirm: () => void;
}) {
  const confirmed = props.mission;

  return (
    <>
      <Card
        size="small"
        className="mission-contract-card"
        styles={{ body: { padding: '10px 14px' } }}
      >
        <Flex align="flex-start" justify="space-between" gap={12}>
          <div style={{ minWidth: 0 }}>
            <Flex align="center" gap={6} wrap>
              <Text strong>本次任务</Text>
              {confirmed ? <Tag color="green">已确认</Tag> : <Tag color="orange">待确认</Tag>}
            </Flex>
            <Paragraph ellipsis={{ rows: 2 }} style={{ margin: '4px 0 0' }}>
              {confirmed?.purpose || props.draft.purpose || '开始调查前先说明为什么做这件事。'}
            </Paragraph>
            {confirmed ? (
              <Text type="secondary">
                期望结果：{confirmed.expectedResult}
              </Text>
            ) : (
              <Text type="secondary">
                还需要确认“为什么做”和“最后希望拿到什么”。
              </Text>
            )}
            {confirmed && props.progress ? (
              <div style={{ marginTop: 8, maxWidth: 640 }}>
                <Flex align="center" justify="space-between" gap={12}>
                  <Text type="secondary">
                    已覆盖 {props.progress.covered}/{props.progress.total} 项交付物
                  </Text>
                  <Text type="secondary">{props.progress.percent}%</Text>
                </Flex>
                <Progress
                  percent={props.progress.percent}
                  size="small"
                  showInfo={false}
                  status={props.progress.percent >= 100 ? 'success' : 'active'}
                  style={{ margin: '2px 0 0' }}
                />
              </div>
            ) : null}
          </div>
          <Button size="small" disabled={props.loading} onClick={props.onOpen}>
            {confirmed ? '修改' : '确认任务'}
          </Button>
        </Flex>
      </Card>

      <Modal
        title="确认本次任务"
        open={props.open}
        onCancel={props.onClose}
        onOk={props.onConfirm}
        okText="确认并开始"
        cancelText="取消"
        confirmLoading={props.saving}
        width={720}
        destroyOnHidden
      >
        <Flex vertical gap={16}>
          <div>
            <Text strong>任务目的</Text>
            <Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
              为什么要做这次调查？说清楚这次调查要支持什么工作或决定。
            </Text>
            <Input.TextArea
              value={props.draft.purpose}
              onChange={(event) => props.onChange({
                ...props.draft,
                purpose: event.target.value,
              })}
              autoSize={{ minRows: 3, maxRows: 6 }}
              placeholder="例如：弄清 IBM 老系统当前的数据架构，为 replatform 方案提供依据。"
              style={{ marginTop: 8 }}
            />
          </div>

          <div>
            <Text strong>期望结果</Text>
            <Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
              最后你希望拿到什么？尽量说清楚要看什么、要做什么、需要哪些结果。
            </Text>
            <Input.TextArea
              value={props.draft.expectedResult}
              onChange={(event) => props.onChange({
                ...props.draft,
                expectedResult: event.target.value,
              })}
              autoSize={{ minRows: 4, maxRows: 8 }}
              placeholder="例如：给出当前 Data Source、Data Flow、Data Model，并形成可落地的 replatform 方案。"
              style={{ marginTop: 8 }}
            />
          </div>

          {confirmed?.deliverables.length ? (
            <div>
              <Text strong>系统会围绕这些结果工作</Text>
              <Flex wrap gap={6} style={{ marginTop: 8 }}>
                {confirmed.deliverables.map((item) => {
                  const current = props.progress?.deliverables.find((progressItem) => progressItem.id === item.id);
                  const statusLabel =
                    current?.status === 'covered' ? '已覆盖'
                      : current?.status === 'in_progress' ? '进行中'
                        : current?.status === 'not_started' ? '未开始'
                          : '未自动追踪';
                  return (
                    <Tag
                      key={item.id}
                      color={current?.status === 'covered' ? 'green' : current?.status === 'in_progress' ? 'blue' : undefined}
                    >
                      {item.title} · {statusLabel}
                    </Tag>
                  );
                })}
              </Flex>
              <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                这些只是任务结果的覆盖情况。未知项不会因为没有解决就自动变成下一项任务。
              </Text>
            </div>
          ) : (
            <Text type="secondary">
              保存后系统会从你的期望结果中拆出主要交付物，用来持续检查调查有没有跑偏。
            </Text>
          )}
        </Flex>
      </Modal>
    </>
  );
}
