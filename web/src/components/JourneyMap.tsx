import { useEffect, useState } from 'react';
import {
  Button,
  Empty,
  Flex,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  RedoOutlined,
  SaveOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';

import { JourneyFlowEdge } from './JourneyFlowEdge.js';
import { JourneyFlowNode } from './JourneyFlowNode.js';
import { JourneyMapInspector } from './JourneyMapInspector.js';
import { EDGE_TYPE, type FlowNodeData } from './journey-map-types.js';
import { useJourneyWorkflowEditor } from './useJourneyWorkflowEditor.js';

const { Text } = Typography;

export interface JourneyMapProps {
  /** 从完整工作页返回调查对话。 */
  onBack?: () => void;
}

/** 工作地图页面。 */
export function JourneyMap(props: JourneyMapProps) {
  return (
    <ReactFlowProvider>
      <JourneyMapCanvas onBack={props.onBack} />
    </ReactFlowProvider>
  );
}

/**
 * 工作地图是独立的业务页面：
 * 进入后直接可以拖动、连线、修改属性、让 AI 修改流程，然后明确保存。
 *
 * AI 对话位于右侧“属性”面板，采用 Ant Design X 的 Bubble.List + Sender。
 * 每一轮都基于当前画布继续修改；AI 只替换当前画布，不直接写入服务端，
 * 用户检查后再点击“保存”。
 */
function JourneyMapCanvas({ onBack }: JourneyMapProps) {
  const editor = useJourneyWorkflowEditor();
  const {
    snapshot,
    fetching,
    dirty,
    nodes,
    edges,
    selectedNode,
    selectedEdge,
    nodeDraft,
    edgeDraft,
    connectTargetId,
    connectOutcome,
    validationIssues,
    currentStage,
    completedCount,
    saveWorkflow,
    aiEditFlow,
    resetWorkflow,
    autoLayout,
    createStandaloneNode,
    applyNodeDraft,
    applyEdgeDraft,
    connectSelectedNode,
    setNodeDraft,
    setEdgeDraft,
    setConnectTargetId,
    setConnectOutcome,
    handleNodesChange,
    handleEdgesChange,
    onConnect,
    onReconnect,
    undo,
    redo,
    canUndo,
    canRedo,
    flowInstanceRef,
    onNodeClick,
    onEdgeClick,
    clearSelection,
    deleteSelectedEdge,
    beginNodeDrag,
  } = editor;

  const currentDefinition = snapshot?.definition;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (dirty) void saveWorkflow();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dirty, saveWorkflow]);



  if (fetching) {
    return (
      <div className="journey-map-page journey-map-empty">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="正在打开工作地图，请稍候…"
        />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="journey-map-page journey-map-empty">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="这个调查还没有固定工作方式，先到调查设置选择一种工作方式。"
        />
        {onBack ? (
          <Button icon={<ArrowLeftOutlined />} onClick={onBack}>返回调查</Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="journey-map-page">
      <header className="journey-map-page-header">
        <div className="journey-map-page-header-main">
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={onBack}
            aria-label="返回调查"
          >
            返回调查
          </Button>
          <div className="journey-map-page-title-group">
            <Flex align="center" gap={8}>
              <Typography.Title level={4} style={{ margin: 0 }}>
                工作地图
              </Typography.Title>
              <Tag color={snapshot.source === 'custom' ? 'blue' : undefined}>
                {snapshot.source === 'custom'
                  ? '自定义 v' + String(snapshot.version)
                  : '内置路线'}
              </Tag>
              {dirty ? <Tag color="orange">有未保存修改</Tag> : null}
            </Flex>
            <Text type="secondary">
              直接拖动节点和连线；也可以告诉 AI 怎么改，检查后点击保存。
            </Text>
          </div>
        </div>

        <Flex align="center" gap={8} wrap>
          <Button
            size="small"
            icon={<UndoOutlined />}
            disabled={!canUndo}
            onClick={undo}
          >
            撤销
          </Button>
          <Button
            size="small"
            icon={<RedoOutlined />}
            disabled={!canRedo}
            onClick={redo}
          >
            重做
          </Button>
          <Button
            size="small"
            icon={<NodeIndexOutlined />}
            onClick={() => void autoLayout()}
          >
            自动排版
          </Button>
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => void createStandaloneNode()}
          >
            新建步骤
          </Button>
          <Button
            size="small"
            onClick={resetWorkflow}
          >
            恢复内置
          </Button>
          <Button
            type="primary"
            size="small"
            icon={<SaveOutlined />}
            disabled={!dirty}
            onClick={() => void saveWorkflow()}
          >
            保存
          </Button>
        </Flex>
      </header>



      {validationIssues.length ? (
        <div className="journey-map-validation-panel">
          <div className="journey-map-validation-title">
            <Text strong>保存前需要修正 {validationIssues.length} 个问题</Text>
            <Text type="secondary">当前画布仍然可以继续编辑。</Text>
          </div>
          <div className="journey-map-validation-items">
            {validationIssues.slice(0, 8).map((issue, index) => (
              <Text type="danger" key={index}>{issue}</Text>
            ))}
            {validationIssues.length > 8 ? (
              <Text type="secondary">还有 {validationIssues.length - 8} 个问题。</Text>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="journey-map-workspace">
        <div className="journey-map-flow-wrap">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={{ journey: JourneyFlowNode }}
            edgeTypes={{ [EDGE_TYPE]: JourneyFlowEdge }}
            onInit={(instance) => {
              flowInstanceRef.current = instance;
            }}
            nodesDraggable
            nodesConnectable
            elementsSelectable
            edgesReconnectable
            connectionLineType={ConnectionLineType.SmoothStep}
            connectionRadius={28}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onNodeDragStart={beginNodeDrag}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onNodeClick={(_, node) => onNodeClick(node.id)}
            onEdgeClick={(_, edge) => onEdgeClick(edge.id)}
            onPaneClick={clearSelection}
            colorMode="light"
            proOptions={{ hideAttribution: true }}
          >
            <Background
              gap={22}
              size={1}
              variant={BackgroundVariant.Dots}
              color="#dfe5ee"
            />

            <Controls showInteractive />

            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              nodeColor={(node) => {
                const data = node.data as FlowNodeData;
                if (data.connectionIssue === 'error') return '#ff4d4f';
                if (data.connectionIssue === 'warning') return '#faad14';
                if (data.status === 'completed') return '#52c41a';
                if (data.status === 'current') return '#1677ff';
                if (data.status === 'locked') return '#d9d9d9';
                return '#b5c0cf';
              }}
              nodeStrokeWidth={3}
              maskColor="rgba(247,249,252,.76)"
            />
          </ReactFlow>
        </div>

        <JourneyMapInspector
          nodes={nodes}
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          nodeDraft={nodeDraft}
          edgeDraft={edgeDraft}
          connectTargetId={connectTargetId}
          connectOutcome={connectOutcome}
          setNodeDraft={setNodeDraft}
          setEdgeDraft={setEdgeDraft}
          setConnectTargetId={setConnectTargetId}
          setConnectOutcome={setConnectOutcome}
          applyNodeDraft={applyNodeDraft}
          applyEdgeDraft={applyEdgeDraft}
          connectSelectedNode={connectSelectedNode}
          deleteSelectedEdge={deleteSelectedEdge}
          currentDefinition={currentDefinition}
          aiEditFlow={aiEditFlow}
        />
      </div>

      <footer className="journey-map-page-footer">
        <Flex align="center" gap={8} wrap>
          <Text strong>{currentStage?.title ?? '当前步骤'}</Text>
          <Tag bordered={false}>
            {completedCount}/{Math.max(currentDefinition?.nodes.filter((node) => node.visible).length ?? 0, 1)} 已完成
          </Tag>
          <Text type="secondary">
            当前执行位置：{snapshot.state.currentNodeId}
          </Text>
        </Flex>
        <Space size={12}>
          <Text type="secondary">
            Cmd/Ctrl + S 保存
          </Text>
          {snapshot.execution.status === 'completed' ? (
            <Tag color="green" bordered={false}>这条路线已经走完</Tag>
          ) : snapshot.execution.status === 'stopped' ? (
            <Tag color="red" bordered={false}>这条路线已停止</Tag>
          ) : (
            <Tag bordered={false}>正在执行</Tag>
          )}
        </Space>
      </footer>
    </div>
  );
}
