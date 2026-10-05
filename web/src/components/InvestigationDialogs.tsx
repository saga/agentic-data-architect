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
  newSessionWorkflow: WorkflowId | null;
  unknownsOpen: boolean;
  userInputDrafts: Record<string, string>;
  setNewSessionName: (value: string) => void;
  setNewSessionGoal: (value: string) => void;
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
          <Input.TextArea
            value={props.newSessionGoal}
            onChange={(event) => props.setNewSessionGoal(event.target.value)}
            placeholder="先说清楚你想解决什么，例如：为什么两个系统的 Position 不一致？（可选）"
            autoSize={{ minRows: 3, maxRows: 6 }}
          />
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
            title="默认自主调查。路线是可选的工作方法；开始后不会在首页随手切换，确需改变时到“调查配置 → 工作方式”执行明确调整。"
          />
        </Space>
      </Modal>

      <Modal
        title={
          <Flex align="center" gap={8}>
            <span>待查内容</span>
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
                  导引：让 Agent 直接围绕这条未知项继续检索、核对 Evidence，并在完成后重新判断它是否已经查清。
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
