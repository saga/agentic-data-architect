import React from 'react';
import { Alert, Button, Card, Flex, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { workflowOptions } from '../app/types';
import type { PendingUserInput } from '../app/types';
import type { SessionData, WorkflowId } from '../app/types';

const { Text } = Typography;

export function InvestigationDialogs(props: {
  current?: SessionData;
  active?: string;
  loading: boolean;
  newSessionOpen: boolean;
  newSessionName: string;
  newSessionGoal: string;
  newSessionExpectedResult: string;
  newSessionWorkflow: WorkflowId | null;
  unknownsOpen: boolean;
  userInputDrafts: Record<string, string>;
  setNewSessionName: (value: string) => void;
  setNewSessionGoal: (value: string) => void;
  setNewSessionExpectedResult: (value: string) => void;
  setNewSessionWorkflow: (value: WorkflowId | null) => void;
  setNewSessionOpen: (value: boolean) => void;
  setUnknownsOpen: (value: boolean) => void;
  setUserInputDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onCreateSession: () => void;
  onContinueUnknown: (unknown: string) => void;
}) {
  return (
    <>
      <Modal
        title="新建工作"
        open={props.newSessionOpen}
        onCancel={() => props.setNewSessionOpen(false)}
        onOk={props.onCreateSession}
        okButtonProps={{ disabled: !props.newSessionName.trim() }}
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Input
            autoFocus
            value={props.newSessionName}
            onChange={(event) => props.setNewSessionName(event.target.value)}
            placeholder="工作名称，例如：portfolio-position-lineage"
          />
          <div>
            <Text strong>任务目的</Text>
            <Input.TextArea
              value={props.newSessionGoal}
              onChange={(event) => props.setNewSessionGoal(event.target.value)}
              placeholder="为什么要做这次调查，例如：弄清老系统的数据架构，为 replatform 提供依据。"
              autoSize={{ minRows: 3, maxRows: 6 }}
              style={{ marginTop: 6 }}
            />
          </div>
          <div>
            <Text strong>期望结果</Text>
            <Input.TextArea
              value={props.newSessionExpectedResult}
              onChange={(event) => props.setNewSessionExpectedResult(event.target.value)}
              placeholder="最后希望拿到什么，例如：当前 Data Source、Data Flow、Data Model，以及 replatform 方案。"
              autoSize={{ minRows: 3, maxRows: 6 }}
              style={{ marginTop: 6 }}
            />
          </div>
          <Select
            value={props.newSessionWorkflow ?? ''}
            onChange={(value) => props.setNewSessionWorkflow(value ? value as WorkflowId : null)}
            options={workflowOptions.map((option) => ({ value: option.value, label: option.label }))}
            style={{ width: '100%' }}
          />
          <Alert
            className="modal-tip"
            type="info"
            showIcon
            title="填写“任务目的”和“期望结果”后，创建调查会直接开始。无需再输入“开始”；如果内容还不够清楚，系统才会要求你补充确认。"
          />
        </Space>
      </Modal>

      <Modal
        title={
          <Flex align="center" gap={8}>
            <span>尚未查清的事项</span>
            <Tag variant="filled" color="orange">{props.current?.context.unknowns.length ?? 0} 项</Tag>
          </Flex>
        }
        open={props.unknownsOpen}
        onCancel={() => props.setUnknownsOpen(false)}
        footer={null}
        width={720}
        centered
      >
        <div className="unknown-items">
          {(props.current?.context.unknowns ?? []).map((unknown, index) => (
            <Card key={unknown + index} size="small" className="unknown-item-card">
              <div className="unknown-item-copy">
                <div className="unknown-item-index">待查 {index + 1}</div>
                <Text strong className="unknown-item-title">{unknown}</Text>
                <Text type="secondary" className="unknown-item-guidance">
                  这只是当前的未知，不代表一定要继续查。让助手先判断它是否会影响本次任务的最终结果。
                </Text>
              </div>
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                disabled={!props.active || props.loading}
                onClick={() => props.onContinueUnknown(unknown)}
              >
                让 Agent 继续查
              </Button>
            </Card>
          ))}
        </div>
      </Modal>
    </>
  );
}
