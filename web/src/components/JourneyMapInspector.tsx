import React from 'react';
import {
  Badge,
  Button,
  Collapse,
  Flex,
  Input,
  Select,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  ArrowRightOutlined,
  DeleteOutlined,
  HolderOutlined,
  RobotOutlined,
  SaveOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { JourneyMapAiChat } from './JourneyMapAiChat.js';
import type {
  FlowEdge,
  FlowNode,
  WorkflowChange,
  WorkflowNodeDefinition,
  WorkflowNodeType,
  WorkflowActor,
 } from './journey-map-types.js';

const { Text } = Typography;

const NODE_TYPE_LABEL: Record<WorkflowNodeType, string> = {
  task: '任务',
   review: '评审',
  end: '完成',
 };

/** 两个 Tab 共用同一套标签结构（Badge 只在有未处理事项时打点），切 Tab 时表头不再跳动。 */
function tabLabel(icon: React.ReactNode, text: string, dot: boolean) {
  return (
    <Badge dot={dot} offset={[5, -1]}>
      <Flex align="center" gap={6}>
        {icon}
        <span>{text}</span>
      </Flex>
    </Badge>
  );
}

interface JourneyMapInspectorProps {
  nodes: FlowNode[];
  selectedNode?: FlowNode;
  selectedEdge?: FlowEdge;
  nodeDraft?: Partial<WorkflowNodeDefinition>;
  edgeDraft?: { outcome: string; target: string };
  connectTargetId?: string;
  connectOutcome: string;
  setNodeDraft: React.Dispatch<React.SetStateAction<Partial<WorkflowNodeDefinition> | undefined>>;
  setEdgeDraft: React.Dispatch<React.SetStateAction<{ outcome: string; target: string } | undefined>>;
  setConnectTargetId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setConnectOutcome: React.Dispatch<React.SetStateAction<string>>;
  applyNodeDraft: () => Promise<void>;
  applyEdgeDraft: () => Promise<void>;
  connectSelectedNode: () => Promise<void>;
  deleteSelectedEdge: () => void;
  currentDefinition?: import('./journey-map-types.js').WorkflowDefinition;
  selectedNodeId?: string;
  pendingAiChange?: { message: string; changes: WorkflowChange[] };
  aiEditFlow: (
    prompt: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ) => Promise<{ message: string; changes: WorkflowChange[] } | undefined>;
  applyAiChanges: () => Promise<void>;
  discardAiChanges: () => void;
  humanWaiting?: boolean;
  applyHumanWorkflowTransition: (outcome: string) => Promise<void>;
}

/**
 * 右侧属性面板。
 *
 * 把“节点编辑”和“分支编辑”从主画布组件里拆出来，
 * 这样 JourneyMap.tsx 不再同时承担 Graph、状态、表单和 React Flow rendering。
 */
export function JourneyMapInspector({
  nodes,
  selectedNode,
  selectedEdge,
  nodeDraft,
  edgeDraft,
  connectTargetId,
  connectOutcome,
  setNodeDraft,
  setEdgeDraft,
  setConnectTargetId,
  setConnectOutcome,
  applyNodeDraft,
  applyEdgeDraft,
  connectSelectedNode,
  deleteSelectedEdge,
  currentDefinition,
  selectedNodeId,
  pendingAiChange,
  aiEditFlow,
  applyAiChanges,
  discardAiChanges,
  humanWaiting,
  applyHumanWorkflowTransition,
}: JourneyMapInspectorProps) {
  // 两类内容只占用同一个右侧空间，通过 Tabs 切换，避免属性表单和 AI 同时挤在一起。
  const [activeTab, setActiveTab] = React.useState<'properties' | 'ai'>(
    selectedNode || selectedEdge ? 'properties' : 'ai',
  );

  const propertiesContent = (
    <div className="journey-map-inspector-section journey-map-inspector-properties">
      <div className="journey-map-inspector-context">
        <Flex align="center" justify="space-between" gap={8}>
          <Flex align="center" gap={7} style={{ minWidth: 0 }}>
            <SettingOutlined />
            <Text strong>{selectedNode ? '节点属性' : selectedEdge ? '连接属性' : '属性'}</Text>
            {selectedNode && nodeDraft?.type ? (
              <Tag variant="filled">{NODE_TYPE_LABEL[nodeDraft.type] ?? nodeDraft.type}</Tag>
            ) : null}
            {selectedEdge && edgeDraft ? (
              <Tag variant="filled">{edgeDraft.outcome || '分支'}</Tag>
            ) : null}
          </Flex>
          {selectedNode ? (
            <Text type="secondary" className="journey-map-inspector-id" ellipsis={{ tooltip: selectedNode.id }}>
              {selectedNode.id}
            </Text>
          ) : null}
        </Flex>
        <Text type="secondary" className="journey-map-inspector-desc">
          {selectedNode || selectedEdge
            ? '修改字段后点击底部“应用”，改动才会进入当前画布。'
            : '在画布上点击节点或分支开始编辑。'}
        </Text>
      </div>

      <div className="journey-map-inspector-properties-scroll">
        {humanWaiting && selectedNode ? (
        <div className="journey-map-human-review">
          <Flex align="center" justify="space-between" gap={8}>
            <Text strong>等待人工处理</Text>
            <Tag color="blue">当前步骤</Tag>
          </Flex>
          <Text type="secondary">
            请根据当前评审结果选择一个出口；Agent 不会替你推进这一步。
          </Text>
          <Flex wrap gap={8}>
            {selectedNode.data.sourceHandles.map((handle) => (
              <Button
                key={handle.id}
                size="small"
                onClick={() => void applyHumanWorkflowTransition(handle.label)}
              >
                {handle.label}
              </Button>
            ))}
          </Flex>
        </div>
      ) : null}

      {selectedNode && nodeDraft ? (
        <Flex vertical gap={10}>
          <div className="journey-map-property-id">
            <Text type="secondary">ID</Text>
            <Text code>{selectedNode.id}</Text>
          </div>

          <div>
            <Text type="secondary">名称</Text>
            <Input
              value={String(nodeDraft.title ?? '')}
              onChange={(event) =>
                setNodeDraft({ ...nodeDraft, title: event.target.value })}
            />
          </div>

          <div>
            <Text type="secondary">目标</Text>
            <Input.TextArea
              value={String(nodeDraft.objective ?? '')}
              onChange={(event) =>
                setNodeDraft({ ...nodeDraft, objective: event.target.value })}
              autoSize={{ minRows: 2, maxRows: 5 }}
            />
          </div>

          <Collapse
            size="small"
            defaultActiveKey={['execution']}
            items={[
              {
                key: 'execution',
                label: '执行设置',
                children: (
                  <Flex vertical gap={10}>
                    <div className="journey-map-property-grid">
                      <div>
                        <Text type="secondary">节点类型</Text>
                        <Select
                          value={nodeDraft.type}
                          style={{ width: '100%' }}
                          options={[
                            { value: 'task', label: '任务' },
                            { value: 'review', label: '评审' },
                            { value: 'end', label: '完成' },
                          ]}
                          onChange={(value) =>
                            setNodeDraft({
                              ...nodeDraft,
                              type: value as WorkflowNodeType,
                            })}
                        />
                      </div>
                      <div>
                        <Text type="secondary">执行者</Text>
                        <Select
                          value={nodeDraft.actor}
                          style={{ width: '100%' }}
                          options={[
                            { value: 'agent', label: 'Agent' },
                            { value: 'human', label: '人工' },
                           ]}
                          onChange={(value) =>
                            setNodeDraft({
                              ...nodeDraft,
                              actor: value as WorkflowActor,
                            })}
                        />
                      </div>
                    </div>

                    <div>
                      <div>
                        <Text type="secondary">确定性条件</Text>
                        <Input
                          value={String(nodeDraft.completeWhen ?? '')}
                          placeholder="例如 goal / current-state / validation"
                          onChange={(event) =>
                            setNodeDraft({
                              ...nodeDraft,
                              completeWhen: event.target.value,
                            })}
                        />
                      </div>
                  </Flex>
                ),
              },
              {
                key: 'connections',
                label: '连接',
                children: (
                  <div className="journey-map-connect-box">
                    <Text strong>连接到现有步骤</Text>
                    <Text type="secondary">
                      新建步骤或断开步骤可以直接在这里选择目标，不必拖线。
                    </Text>

                    <Select
                      value={connectTargetId}
                      allowClear
                      placeholder="选择目标步骤"
                      style={{ width: '100%' }}
                      options={nodes
                        .filter((node) => node.id !== selectedNode.id)
                        .map((node) => ({
                          value: node.id,
                          label: node.id + ' · ' + node.data.title,
                        }))}
                      onChange={setConnectTargetId}
                    />

                    <Input
                      value={connectOutcome}
                      placeholder="success / failed / retry"
                      onChange={(event) => setConnectOutcome(event.target.value)}
                      addonBefore="outcome"
                    />

                    <Button
                      block
                      icon={<ArrowRightOutlined />}
                      disabled={!connectTargetId}
                      onClick={() => void connectSelectedNode()}
                    >
                      建立连接
                    </Button>

                    <Text type="secondary" className="journey-map-connect-hint">
                      也可以从节点右侧出口区域拖到目标步骤。
                    </Text>
                  </div>
                ),
              },
            ]}
          />

          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={() => void applyNodeDraft()}
          >
            应用节点属性
          </Button>
        </Flex>
      ) : selectedEdge && edgeDraft ? (
        <Flex vertical gap={10}>
          <div className="journey-map-edge-summary">
            <div>
              <Text type="secondary">来源</Text>
              <Text strong ellipsis={{ tooltip: selectedEdge.source }}>
                {nodes.find((node) => node.id === selectedEdge.source)?.data.title ?? selectedEdge.source}
              </Text>
            </div>
            <ArrowRightOutlined />
            <div>
              <Text type="secondary">目标</Text>
              <Text strong ellipsis={{ tooltip: edgeDraft.target }}>
                {nodes.find((node) => node.id === edgeDraft.target)?.data.title ?? edgeDraft.target}
              </Text>
            </div>
          </div>

          <div className="journey-map-edge-info">
            <Text type="secondary">连接类型</Text>
            <Tag
              color={
                selectedEdge.data?.kind === 'fail'
                  ? 'red'
                  : selectedEdge.data?.kind === 'success'
                    ? 'green'
                    : undefined
              }
              variant="filled"
            >
              {selectedEdge.data?.kind === 'success'
                ? '成功'
                : selectedEdge.data?.kind === 'fail'
                  ? '失败'
                  : selectedEdge.data?.kind === 'retry'
                    ? '重试'
                    : '分支'}
            </Tag>
          </div>

          <div>
            <Text type="secondary">结果</Text>
            <Input
              value={edgeDraft.outcome}
              placeholder="Workflow outcome"
              onChange={(event) =>
                setEdgeDraft({
                  ...edgeDraft,
                  outcome: event.target.value,
                })}
            />
          </div>

          <div>
            <Text type="secondary">目标步骤</Text>
            <Select
              value={edgeDraft.target}
              style={{ width: '100%' }}
              options={nodes.map((node) => ({
                value: node.id,
                label: node.id + ' · ' + node.data.title,
              }))}
              onChange={(value) =>
                setEdgeDraft({
                  ...edgeDraft,
                  target: value,
                })}
            />
          </div>

          <Flex gap={8}>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={() => void applyEdgeDraft()}
            >
              应用连接
            </Button>

            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={deleteSelectedEdge}
            >
              删除连接
            </Button>
          </Flex>
        </Flex>
      ) : (
        <div className="journey-map-inspector-empty">
          <HolderOutlined />
          <Text type="secondary">
            点击节点编辑步骤；点击连线查看并修改连接信息。
          </Text>
        </div>
      )}

      {selectedNode?.data.connectionIssue ? (
        <Tag
          color={selectedNode.data.connectionIssue === 'error' ? 'error' : 'warning'}
          className="journey-map-inspector-issue"
        >
          {selectedNode.data.connectionIssueText}
        </Tag>
      ) : null}
      </div>
    </div>
  );

  const aiContent = (
    <div className="journey-map-inspector-section journey-map-inspector-ai">
      <JourneyMapAiChat
        currentDefinition={currentDefinition}
        selectedNodeId={selectedNodeId}
        pendingAiChange={pendingAiChange}
        aiEditFlow={aiEditFlow}
        applyAiChanges={applyAiChanges}
        discardAiChanges={discardAiChanges}
      />
    </div>
  );

  return (
    <aside className="journey-map-inspector" aria-label="工作地图侧栏">
      <Tabs
        className="journey-map-inspector-tabs"
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as 'properties' | 'ai')}
        size="middle"
        animated={false}
        tabBarGutter={26}
        items={[
          {
            key: 'properties',
            label: tabLabel(<SettingOutlined />, '属性', false),
          },
          {
            key: 'ai',
            label: tabLabel(<RobotOutlined />, 'AI', Boolean(pendingAiChange)),
          },
        ]}
      />
      <div className="journey-map-inspector-content">
        {activeTab === 'properties' ? propertiesContent : aiContent}
      </div>
    </aside>
  );
}
