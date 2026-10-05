import React from 'react';
import { Button, Flex, Space, Tag, Typography } from 'antd';
import { CopyOutlined, FileTextOutlined, LoadingOutlined, SettingOutlined, ToolOutlined } from '@ant-design/icons';
import type { ExecutionStatus, SessionData } from '../app/types';

const { Text } = Typography;

export function InvestigationTopbar(props: {
  current: SessionData;
  loading: boolean;
  turnStatus: string;
  executionStatus: ExecutionStatus;
  executionStatusText: (status: ExecutionStatus) => string;
  onCopyConversation: () => void;
  onOpenResults: () => void;
  onOpenTrajectory: () => void;
  onOpenConfig: () => void;
  onOpenUnknowns: () => void;
}) {
  const running = props.loading || props.executionStatus.running;
  return (
    <div className="topbar-inner">
      <Flex justify="space-between" align="center" style={{ width: '100%' }}>
        <div className="topbar-title">
          <Text strong className="topbar-label">调查工作区</Text>
        </div>
        <Space>
          <Tag
            className={`workspace-status${running ? ' workspace-status-active' : ''}`}
            variant="filled"
            icon={running ? <LoadingOutlined spin /> : undefined}
          >
            {props.loading ? props.turnStatus : props.executionStatusText(props.executionStatus)}
          </Tag>
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            disabled={!props.current.messages.length}
            onClick={props.onCopyConversation}
          >
            复制对话
          </Button>
          <Button type="text" size="small" icon={<FileTextOutlined />} onClick={props.onOpenResults}>
            调查结果
          </Button>
          <Button type="text" size="small" icon={<ToolOutlined />} onClick={props.onOpenTrajectory}>
            Agent 轨迹
          </Button>
          <Button type="text" size="small" icon={<SettingOutlined />} onClick={props.onOpenConfig}>
            调查配置
          </Button>
          {props.current.context.unknowns.length ? (
            <Tag
              variant="filled"
              color="orange"
              className="clickable-status-tag"
              role="button"
              tabIndex={0}
              onClick={props.onOpenUnknowns}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  props.onOpenUnknowns();
                }
              }}
            >
              待查内容 {props.current.context.unknowns.length}
            </Tag>
          ) : null}
        </Space>
      </Flex>
    </div>
  );
}
