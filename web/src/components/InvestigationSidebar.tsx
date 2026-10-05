import React from 'react';
import { Alert, Button, Conversations, Flex, Layout, Typography } from 'antd';
import { InfoCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { SessionSummary } from '../app/types';

const { Sider } = Layout;
const { Text } = Typography;

export function InvestigationSidebar(props: {
  sessions: SessionSummary[];
  active?: string;
  width: number;
  showTip: boolean;
  onNewSession: () => void;
  onRefresh: () => void;
  onDismissTip: () => void;
  onSelectSession: (key: string) => void;
  onResizeStart: () => void;
}) {
  return (
    <>
      <Sider width={props.width} theme="light" className="session-sider">
        <div className="brand">
          <div className="brand-mark">DA</div>
          <div>
            <Text strong>现代化数据工作台</Text>
            <div><Text type="secondary">基于证据的调查</Text></div>
          </div>
        </div>

        <div className="sider-actions">
          <Button icon={<PlusOutlined />} type="primary" block onClick={props.onNewSession}>
            新建调查
          </Button>
          <Button icon={<ReloadOutlined />} type="text" block onClick={props.onRefresh}>
            刷新
          </Button>
        </div>

        {props.showTip ? (
          <Alert
            className="sider-tip"
            type="info"
            showIcon
            closable
            icon={<InfoCircleOutlined />}
            title="每个调查都有自己的资料和设置。"
            onClose={props.onDismissTip}
          />
        ) : null}

        <Conversations
          activeKey={props.active}
          onActiveChange={props.onSelectSession}
          items={props.sessions.map((session) => ({
            key: session.key,
            label: session.label,
          }))}
          className="conversations"
        />
      </Sider>

      <div
        className="resize-handle resize-handle-left"
        role="separator"
        aria-label="调整会话栏宽度"
        onMouseDown={(event) => {
          event.preventDefault();
          props.onResizeStart();
        }}
      />
    </>
  );
}
