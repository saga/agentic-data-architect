import { useEffect, useRef } from 'react';
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
 * 右侧栏分成“属性”和“AI”两个 Tab：编辑节点时看属性，需要改流程时切到 AI。
 * AI 对话采用 Ant Design X 的 Bubble.List + Sender；每一轮都基于当前画布继续修改，
 * 只更新当前画布预览，不直接写入服务端，用户检查后再点击“保存”。
 */
function JourneyMapCanvas({ onBack }: JourneyMapProps) {
  const editor = useJourneyWorkflowEditor();
  const flowWrapRef = useRef<HTMLDivElement>(null);
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
    pendingAiChange,
    applyAiChanges,
    discardAiChanges,
    applyHumanWorkflowTransition,
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

  const currentDefinition = editor.currentDefinition;

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

  /**
   * React Flow 的 viewport 依赖真实容器尺寸。
   * 独立页面刚打开、右侧栏切换宽度、浏览器窗口变化时，第一次 fitView 可能发生得太早。
   * 用 ResizeObserver 在“画布真的有尺寸”之后重新 fit，避免整张图缩成顶部一条。
   */
  useEffect(() => {
    const container = flowWrapRef.current;
    if (!container) return;

    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const instance = flowInstanceRef.current;
          if (!instance || !nodes.length) return;
          instance.fitView({
            padding: 0.14,
            minZoom: 0.2,
            maxZoom: 1.4,
            duration: 160,
          });
        });
      });
    };

    const observer = new ResizeObserver(fit);
    observer.observe(container);
    fit();

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [nodes.length]);

  if (fetching) {
    return (
      <div className="journey-map-page journey-map-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="正在打开工作地图，请稍候…" />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="journey-map-page journey-map-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个调查还没有固定工作方式，先到调查设置选择一种工作方式。" />
        {onBack ? <Button icon={<ArrowLeftOutlined />} onClick={onBack}>返回调查</Button> : null}
      </div>
    );
  }

  return (
    <div
      className="journey-map-page"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100dvh',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <header className="journey-map-page-header">
        <div className="journey-map-page-header-main">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} aria-label="返回调查">返回调查</Button>
          <div className="journey-map-page-title-group">
            <Flex align="center" gap={8}>
              <Typography.Title level={4} style={{ margin: 0 }}>工作地图</Typography.Title>
              <Tag color={snapshot.source === 'custom' ? 'blue' : undefined}>
                {snapshot.source === 'custom' ? '自定义 v' + String(snapshot.version) : '内置路线'}
              </Tag>
              {dirty ? <Tag color="orange">有未保存修改</Tag> : null}
              <Tag color={snapshot.execution.status === 'waiting' ? 'blue' : undefined}>
                {snapshot.execution.status === 'waiting' ? '等待人工' : snapshot.execution.status === 'completed' ? '已完成' : snapshot.execution.status === 'stopped' ? '已停止' : '运行中'}
              </Tag>
            </Flex>
            <Text type="secondary">直接拖动节点和连线；右侧切换“属性 / AI”，调整后检查并保存。</Text>
          </div>
        </div>

        <Flex align="center" gap={8} wrap>
          <Button size="small" icon={<UndoOutlined />} disabled={!canUndo} onClick={undo}>撤销</Button>
          <Button size="small" icon={<RedoOutlined />} disabled={!canRedo} onClick={redo}>重做</Button>
          <Button size="small" icon={<NodeIndexOutlined />} onClick={() => void autoLayout()}>自动排版</Button>
          <Button size="small" icon={<PlusOutlined />} onClick={() => void createStandaloneNode()}>新建步骤</Button>
          <Button size="small" onClick={resetWorkflow}>恢复内置</Button>
          <Button type="primary" size="small" icon={<SaveOutlined />} disabled={!dirty} onClick={() => void saveWorkflow()}>保存</Button>
        </Flex>
      </header>

      {snapshot.analysis?.length ? (
        <div className="journey-map-warning-panel">
          <Flex align="center" justify="space-between">
            <Text strong>Workflow 检查</Text>
            <Tag color="warning">{snapshot.analysis.length} 个提醒</Tag>
          </Flex>
          <div className="journey-map-validation-items">
            {snapshot.analysis.slice(0, 6).map((item, index) => <Text type="warning" key={index}>{item.message}</Text>)}
          </div>
        </div>
      ) : null}

      {validationIssues.length ? (
        <div className="journey-map-validation-panel">
          <div className="journey-map-validation-title">
            <Text strong>保存前需要修正 {validationIssues.length} 个问题</Text>
            <Text type="secondary">当前画布仍然可以继续编辑。</Text>
          </div>
          <div className="journey-map-validation-items">
            {validationIssues.slice(0, 8).map((issue, index) => <Text type="danger" key={index}>{issue}</Text>)}
            {validationIssues.length > 8 ? <Text type="secondary">还有 {validationIssues.length - 8} 个问题。</Text> : null}
          </div>
        </div>
      ) : null}

      <div
        className="journey-map-workspace"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(360px, 420px)',
          width: '100%',
          minWidth: 0,
          minHeight: 0,
          flex: '1 1 0',
          height: 0,
          overflow: 'hidden',
        }}
      >
        <div
          ref={flowWrapRef}
          className="journey-map-flow-wrap"
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={{ journey: JourneyFlowNode }}
            edgeTypes={{ [EDGE_TYPE]: JourneyFlowEdge }}
            onInit={(instance) => {
              flowInstanceRef.current = instance;
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (nodes.length) instance.fitView({ padding: 0.14, minZoom: 0.2, maxZoom: 1.4, duration: 0 });
                });
              });
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
            style={{ width: '100%', height: '100%' }}
          >
            <Background gap={22} size={1} variant={BackgroundVariant.Dots} color="#dfe5ee" />
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
          selectedNodeId={selectedNode?.id}
          pendingAiChange={pendingAiChange}
          aiEditFlow={aiEditFlow}
          applyAiChanges={applyAiChanges}
          discardAiChanges={discardAiChanges}
          humanWaiting={snapshot.execution.status === 'waiting' && snapshot.execution.currentNodeId === selectedNode?.id}
          applyHumanWorkflowTransition={applyHumanWorkflowTransition}
        />
      </div>

      <footer className="journey-map-page-footer">
        <Flex align="center" gap={8} wrap>
          <Text strong>{currentStage?.title ?? '当前步骤'}</Text>
          <Tag bordered={false}>{completedCount}/{Math.max(currentDefinition?.nodes.filter((node) => node.visible).length ?? 0, 1)} 已完成</Tag>
          <Text type="secondary">当前执行位置：{snapshot.state.currentNodeId}</Text>
        </Flex>
        <Space size={12}>
          <Text type="secondary">Cmd/Ctrl + S 保存</Text>
          {snapshot.execution.status === 'completed' ? <Tag color="green" bordered={false}>这条路线已经走完</Tag> : snapshot.execution.status === 'stopped' ? <Tag color="red" bordered={false}>这条路线已停止</Tag> : <Tag bordered={false}>正在执行</Tag>}
        </Space>
      </footer>
    </div>
  );
}
