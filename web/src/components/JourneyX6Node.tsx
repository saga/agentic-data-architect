import { type ReactNode } from 'react';
import { Button, Flex, Space, Tag, Tooltip, Typography } from 'antd';
import {
  AimOutlined,
  BranchesOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  DeleteOutlined,
  LockOutlined,
  PlusOutlined,
  RobotOutlined,
  UserOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import type { Node } from '@antv/x6';
import { register } from '@antv/x6-react-shape';
import { JOURNEY_NODE_SIZE } from './journey-map-types.js';
import type { FlowNodeData, JourneyMapStage, WorkflowNodeType } from './journey-map-types.js';

const { Text } = Typography;

const JOURNEY_X6_SHAPE = 'journey-x6-react-node';

const NODE_TYPE_LABEL: Record<WorkflowNodeType, string> = {
  task: '任务',
  gate: '判断点',
  review: '评审',
  end: '结束事件',
  stop: '终止事件',
};

const ACTOR_META = {
  agent: { label: 'Agent', icon: <RobotOutlined /> },
  human: { label: '人工', icon: <UserOutlined /> },
  system: { label: '系统', icon: <ApiOutlined /> },
} as const;

const STATUS_META: Record<JourneyMapStage['status'], { label: string; icon: ReactNode }> = {
  completed: { label: '已完成', icon: <CheckCircleFilled /> },
  current: { label: '当前', icon: <AimOutlined /> },
  future: { label: '待进入', icon: <ClockCircleOutlined /> },
  locked: { label: '暂不可走', icon: <LockOutlined /> },
};

interface JourneyX6NodeProps {
  node: Node;
}

/**
 * X6 节点内容。
 *
 * X6 负责节点位置、端口、边和 viewport；这里仅负责业务卡片的 React UI。
 * outcome 不再是悬浮 EdgeLabel，而是 X6 原生 Port Label，跟随对应出口连接桩定位。
 */
export function JourneyX6Node({ node }: JourneyX6NodeProps) {
  const data = node.getData<FlowNodeData>();
  const meta = STATUS_META[data.status];
  const terminal = data.nodeType === 'end' || data.nodeType === 'stop';
  const selected = Boolean(data.selected);

  const className = [
    'journey-x6-node',
    'journey-flow-node',
    'journey-flow-node-stage',
    'journey-flow-node-' + data.status,
    'journey-flow-node-type-' + data.nodeType,
    'journey-flow-node-actor-' + data.actor,
    data.connectionIssue ? 'journey-flow-node-connection-' + data.connectionIssue : '',
    data.isNew ? 'journey-flow-node-new' : '',
    selected ? 'journey-x6-node-selected' : '',
    data.visible ? '' : 'journey-flow-node-deemphasized',
  ].filter(Boolean).join(' ');

  if (terminal) {
    return (
      <div className={className + ' journey-x6-node-terminal'}>
        <div className="journey-flow-event-symbol">
          {data.nodeType === 'end' ? '✓' : '×'}
        </div>
        <div className="journey-flow-node-title">{data.title}</div>
        <Text type="secondary">
          {data.nodeType === 'end' ? '正常完成' : '停止并结束'}
        </Text>
      </div>
    );
  }

  return (
    <div className={className}>
      {selected ? (
        <div className="journey-x6-node-actions">
          <Space size={4}>
            <Tooltip title="在当前 success 出口后插入一步">
              <Button
                size="small"
                icon={<PlusOutlined />}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onAddStep?.(node.id);
                }}
              />
            </Tooltip>
            <Tooltip title="从当前节点添加一条新分支">
              <Button
                size="small"
                icon={<BranchesOutlined />}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onAddBranch?.(node.id);
                }}
              />
            </Tooltip>
            <Tooltip title="删除节点">
              <Button
                danger
                size="small"
                icon={<DeleteOutlined />}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onDelete?.(node.id);
                }}
              />
            </Tooltip>
          </Space>
        </div>
      ) : null}

      <div className="journey-flow-node-content journey-flow-stage-content">
        <div className={'journey-flow-node-kicker journey-flow-node-kicker-' + data.status}>
          {meta.icon}
          <span>{meta.label}</span>
          <span className="journey-flow-node-type">
            {NODE_TYPE_LABEL[data.nodeType]}
          </span>
          <span className="journey-flow-node-actor">
            {ACTOR_META[data.actor].icon}
            {ACTOR_META[data.actor].label}
          </span>
          {data.status === 'current' && data.actor === 'human' ? (
            <span className="journey-flow-node-waiting-label">等待人工</span>
          ) : null}
          {data.connectionIssue ? (
            <Tooltip title={data.connectionIssueText}>
              <span className="journey-flow-node-connection-indicator">
                {data.connectionIssue === 'error' ? '连接有问题' : '建议检查'}
              </span>
            </Tooltip>
          ) : null}
        </div>

        <div className="journey-flow-node-title">{data.title}</div>

        <div className="journey-flow-node-subtitle">
          {data.objective || '未设置步骤目标'}
        </div>

        {data.connectionIssue ? (
          <Tag
            color={data.connectionIssue === 'error' ? 'error' : 'warning'}
            className="journey-flow-node-connection-tag"
          >
            {data.connectionIssue === 'error' ? '需要修正连接' : '建议检查连接'}
          </Tag>
        ) : null}

        {data.isNew ? (
          <Tag color="warning" className="journey-flow-node-new-tag">
            新建步骤
          </Tag>
        ) : null}

        <div className="journey-flow-node-config">
          <Tag bordered={false}>
            {data.completion === 'deterministic' ? '确定性完成' : 'Agent 判断'}
          </Tag>

          {data.completeWhen ? (
            <Text type="secondary">条件：{data.completeWhen}</Text>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** X6 React Shape 的固定注册入口。 */
register({
  shape: JOURNEY_X6_SHAPE,
  width: JOURNEY_NODE_SIZE.regular.width,
  height: JOURNEY_NODE_SIZE.regular.height,
  effect: ['data'],
  component: JourneyX6Node,
});

export { JOURNEY_X6_SHAPE };
