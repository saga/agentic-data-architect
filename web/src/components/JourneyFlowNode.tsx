import { useEffect, type ReactNode } from 'react';
import {
  Button,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
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
import {
  Handle,
  NodeToolbar,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import type { FlowNode, JourneyMapStage, WorkflowNodeType } from './journey-map-types.js';
import { handleStyle } from './journey-map-graph.js';

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
const { Text } = Typography;

/**
 * Workflow 节点。
 *
 * 这个组件只负责“节点长什么样、有哪些 Handle、工具栏有哪些按钮”。
 * 不负责修改 Workflow 数据；所有修改都通过 props 回到编辑器。
 */
export function JourneyFlowNode({ id, data, selected }: NodeProps<FlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const meta = STATUS_META[data.status];
  const terminal = data.nodeType === 'end' || data.nodeType === 'stop';

  // 动态增加/删除分支后，React Flow 必须重新测量 Handle 的位置。
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, data.sourceHandles.length, data.targetHandles.length, updateNodeInternals]);

  return (
    <>
      {data.targetHandles.map((handle, index) => (
        <Handle
          key={handle.id}
          type="target"
          position={Position.Left}
          id={handle.id}
          className="journey-flow-handle journey-flow-handle-edit"
          style={handleStyle(index, data.targetHandles.length)}
        />
      ))}

      {selected ? (
        <NodeToolbar
          isVisible
          position={Position.Top}
          offset={10}
          className="journey-node-editor-toolbar"
        >
          <Space size={4}>
            {!terminal ? (
              <>
                <Tooltip title="在当前 success 出口后插入一步">
                  <Button
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() => data.onAddStep?.(id)}
                  />
                </Tooltip>
                <Tooltip title="从当前节点添加一条新分支">
                  <Button
                    size="small"
                    icon={<BranchesOutlined />}
                    onClick={() => data.onAddBranch?.(id)}
                  />
                </Tooltip>
              </>
            ) : null}

            <Tooltip title="删除节点">
              <Button
                danger
                size="small"
                icon={<DeleteOutlined />}
                onClick={() => data.onDelete?.(id)}
              />
            </Tooltip>
          </Space>
        </NodeToolbar>
      ) : null}

      {terminal ? (
        <div className="journey-flow-terminal-content">
          <div className="journey-flow-event-symbol">
            {data.nodeType === 'end' ? '✓' : '×'}
          </div>
          <div className="journey-flow-node-title">{data.title}</div>
          <Text type="secondary">
            {data.nodeType === 'end' ? '正常完成' : '停止并结束'}
          </Text>
        </div>
      ) : (
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

            <Text type="secondary" className="journey-flow-connect-hint">
              拖右侧连接点到另一个步骤左侧连接点即可连线
            </Text>
          </div>
        </div>
      )}

      {!terminal
        ? data.sourceHandles.map((handle, index) => (
            <Handle
              key={handle.id}
              type="source"
              position={Position.Right}
              id={handle.id}
              className="journey-flow-handle journey-flow-handle-edit"
              style={handleStyle(index, data.sourceHandles.length)}
            />
          ))
        : null}
    </>
  );
}
