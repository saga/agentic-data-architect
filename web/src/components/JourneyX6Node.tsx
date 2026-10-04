import { type ReactNode } from 'react';
import { Button, Flex, Space, Tooltip, Typography } from 'antd';
import {
   BranchesOutlined,
  DeleteOutlined,
  PlusOutlined,
  RobotOutlined,
  UserOutlined,
  CheckCircleOutlined,
   AimOutlined,
} from '@ant-design/icons';
import type { Node } from '@antv/x6';
import { register } from '@antv/x6-react-shape';
import { JOURNEY_NODE_SIZE } from './journey-map-types.js';
import type {
  FlowNodeData,
  JourneyMapStage,
  WorkflowNodeType,
} from './journey-map-types.js';

const { Text } = Typography;

const JOURNEY_X6_SHAPE = 'journey-x6-react-node';

const NODE_TYPE_META: Record<
  WorkflowNodeType,
  { label: string; icon: ReactNode }
> = {
  task: { label: '任务', icon: <AimOutlined /> },
   review: { label: '评审', icon: <UserOutlined /> },
  end: { label: '完成', icon: <CheckCircleOutlined /> },
 };

const ACTOR_META = {
  agent: { label: 'Agent', icon: <RobotOutlined /> },
  human: { label: '人工', icon: <UserOutlined /> },
 } as const;

function statusClass(status: JourneyMapStage['status']): string {
  return 'journey-flow-node-status-' + status;
}

interface JourneyX6NodeProps {
  node: Node;
}

/**
 * 工作地图节点只保留 Agent Flow 式的三层信息：
 * 图标 + 名称、简短目标、执行者 / 节点类型。
 *
 * 成功/失败/重试不在节点里解释；这些属于连接关系，选中连接后在右栏查看。
 */
export function JourneyX6Node({ node }: JourneyX6NodeProps) {
  const data = node.getData<FlowNodeData>();
  const terminal = data.nodeType === 'end';
  const selected = Boolean(data.selected);
  const nodeType = NODE_TYPE_META[data.nodeType];
  const actor = ACTOR_META[data.actor];

  const className = [
    'journey-x6-node',
    'journey-flow-node',
    'journey-flow-node-' + data.nodeType,
    statusClass(data.status),
    data.connectionIssue
      ? 'journey-flow-node-connection-' + data.connectionIssue
      : '',
    data.isNew ? 'journey-flow-node-new' : '',
    selected ? 'journey-x6-node-selected' : '',
   ]
    .filter(Boolean)
    .join(' ');

  if (terminal) {
    return (
      <div className={className + ' journey-x6-node-terminal'}>
        <div className="journey-flow-event-symbol">
          ✓
        </div>
        <div className="journey-flow-node-title">{data.title}</div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="journey-flow-node-main">
        <div className="journey-flow-node-header">
          <div className="journey-flow-node-type-icon">{nodeType.icon}</div>
          <div className="journey-flow-node-title" title={data.title}>
            {data.title}
          </div>
          <span
            className="journey-flow-node-status-dot"
            aria-label={
              data.status === 'current'
                ? '当前步骤'
                : data.status === 'completed'
                  ? '已完成'
                  : data.status === 'locked'
                    ? '暂不可走'
                    : '待进入'
            }
          />
        </div>

        <div className="journey-flow-node-subtitle">
          {data.objective || '未设置步骤目标'}
        </div>

        <div className="journey-flow-node-meta">
          <span>
            {actor.icon}
            {actor.label}
          </span>
          <span>
            {nodeType.label}
          </span>
          {data.status === 'current' && data.actor === 'human' ? (
            <span className="journey-flow-node-waiting-label">等待处理</span>
          ) : null}
          {data.connectionIssue ? (
            <span className="journey-flow-node-connection-indicator">
              {data.connectionIssue === 'error' ? '连接问题' : '需检查'}
            </span>
          ) : null}
        </div>
      </div>

      {selected ? (
        <div className="journey-x6-node-actions">
          <Space size={2}>
            <Tooltip title="插入下一步">
              <Button
                size="small"
                type="text"
                icon={<PlusOutlined />}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onAddStep?.(node.id);
                }}
              />
            </Tooltip>
            <Tooltip title="添加分支">
              <Button
                size="small"
                type="text"
                icon={<BranchesOutlined />}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onAddBranch?.(node.id);
                }}
              />
            </Tooltip>
            <Tooltip title="删除步骤">
              <Button
                danger
                size="small"
                type="text"
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
