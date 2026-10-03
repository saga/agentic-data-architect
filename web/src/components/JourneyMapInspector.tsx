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
  CompletionMode,
} from './journey-map-types.js';

const { Text } = Typography;

interface JourneyMapInspectorProps {
  nodes: FlowNode[];
  selectedNode?: FlowNode;
  selectedEdge?: FlowEdge;
  nodeDraft?: Partial<WorkflowNodeDefinition>;
  edgeDraft?: { outcome: string; target: string; condition?: string };
  connectTargetId?: string;
  connectOutcome: string;
  setNodeDraft: React.Dispatch<React.SetStateAction<Partial<WorkflowNodeDefinition> | undefined>>;
  setEdgeDraft: React.Dispatch<React.SetStateAction<{ outcome: string; target: string; condition?: string } | undefined>>;
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
    mode: 'generate' | 'modify',
    prompt: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
    scope?: 'workflow' | 'selection',
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
                            { value: 'gate', label: '判断点' },
                            { value: 'review', label: '评审' },
                            { value: 'end', label: '完成' },
                            { value: 'stop', label: '停止' },
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
                            { value: 'system', label: '系统' },
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
                      <Text type="secondary">完成方式</Text>
                      <Select
                        value={nodeDraft.completion}
                        style={{ width: '100%' }}
                        options={[
                          { value: 'agent', label: 'Agent 判断结果' },
                          { value: 'deterministic', label: '确定性条件' },
                        ]}
                        onChange={(value) =>
                          setNodeDraft({
                            ...nodeDraft,
                            completion: value as CompletionMode,
                          })}
                      />
                    </div>

                    {nodeDraft.completion === 'deterministic' ? (
                      <div>
                        <Text type="secondary">completeWhen</Text>
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
                    ) : null}
                  </Flex>
                ),
              },
              {
                key: 'dependencies',
                label: '依赖与产出',
                children: (
                  <Flex vertical gap={10}>
                    <div>
                      <Text type="secondary">前置成果</Text>
                      <Input
                        value={nodeDraft.requires?.join(', ') ?? ''}
                        placeholder="例如 current-state, evidence"
                        onChange={(event) =>
                          setNodeDraft({
                            ...nodeDraft,
                            requires: event.target.value
                              .split(',')
                              .map((item) => item.trim())
                              .filter(Boolean),
                          })}
                      />
                    </div>
                    <div>
                      <Text type="secondary">产出成果</Text>
                      <Input
                        value={nodeDraft.produces?.join(', ') ?? ''}
                        placeholder="例如 target, validation"
                        onChange={(event) =>
                          setNodeDraft({
                            ...nodeDraft,
                            produces: event.target.value
                              .split(',')
                              .map((item) => item.trim())
                              .filter(Boolean),
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
                      placeholder="success / retry / needs-input"
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
                      也可以直接拖右侧连接点 → 目标步骤左侧连接点。
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
        <Flex vertical gap={12}>
          <div>
            <Text type="secondary">分支结果</Text>
            <Input
              value={edgeDraft.outcome}
              placeholder="success / needs-input / retry"
              onChange={(event) =>
                setEdgeDraft({
                  ...edgeDraft,
                  outcome: event.target.value,
                })}
            />
          </div>

          <div>
            <Text type="secondary">目标</Text>
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

          <div>
            <Text type="secondary">条件（可选）</Text>
            <Input
              value={edgeDraft.condition ?? ''}
              placeholder="例如 goal / current-state"
              onChange={(event) =>
                setEdgeDraft({
                  ...edgeDraft,
                  condition: event.target.value,
                })}
            />
            <Text type="secondary" className="journey-map-connect-hint">
              仅对确定性节点参与自动路由；同一节点按 DSL 中的顺序先匹配。
            </Text>
          </div>

          <Flex gap={8}>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={() => void applyEdgeDraft()}
            >
              应用分支属性
            </Button>

            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={deleteSelectedEdge}
            >
              删除分支
            </Button>
          </Flex>
        </Flex>
      ) : (
        <div className="journey-map-inspector-empty">
          <HolderOutlined />
          <Text type="secondary">
            点击节点编辑属性；点击连线标签修改分支结果或目标。
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
        size="small"
        animated={false}
        items={[
          {
            key: 'properties',
            label: (
              <Flex align="center" gap={6}>
                <SettingOutlined />
                <span>属性</span>
              </Flex>
            ),
            children: propertiesContent,
          },
          {
            key: 'ai',
            label: (
              <Badge dot={Boolean(pendingAiChange)} offset={[5, -1]}>
                <Flex align="center" gap={6}>
                  <RobotOutlined />
                  <span>AI</span>
                </Flex>
              </Badge>
            ),
            children: aiContent,
          },
        ]}
      />
    </aside>
  );
}
