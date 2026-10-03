import React from 'react';
import {
  Button,
  Empty,
  Flex,
  Tag,
  Typography,
} from 'antd';
import {
  ArrowRightOutlined,
  BranchesOutlined,
  EditOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  RedoOutlined,
  SaveOutlined,
  UndoOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
} from '@xyflow/react';

import { JourneyFlowEdge } from './JourneyFlowEdge.js';
import { JourneyFlowNode } from './JourneyFlowNode.js';
import { JourneyMapInspector } from './JourneyMapInspector.js';
import {
  EDGE_TYPE,
} from './journey-map-types.js';
import type {
  JourneyMapProps,
  JourneyMapRoute,
  JourneyMapStage,
  FlowNodeData,
} from './journey-map-types.js';
import { useJourneyWorkflowEditor } from './useJourneyWorkflowEditor.js';

const { Text } = Typography;

/** 保持原文件的公共类型导出，避免其它页面需要跟着改 import。 */
export type {
  JourneyMapProps,
  JourneyMapRoute,
  JourneyMapStage,
};

/**
 * 工作地图只负责“页面”：
 *
 * - React Flow 画布
 * - Header 工具栏
 * - Inspector
 * - Journey 底部摘要
 *
 * 所有编辑状态、Graph 变换、HTTP 持久化和 Undo/Redo 都已经放到
 * useJourneyWorkflowEditor，避免一个组件同时承担太多职责。
 */
export function JourneyMap({
  journey,
  routes = [],
  loading = false,
  onChooseRoute,
  onAskStage,
}: JourneyMapProps) {
  const editor = useJourneyWorkflowEditor();

  if (loading || editor.fetching) {
    return (
      <div className="journey-map-empty">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="正在整理工作地图…"
        />
      </div>
    );
  }

  if (!editor.snapshot) {
    if (!journey?.stages.length && !routes.length) {
      return (
        <div className="journey-map-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="当前是自主调查，没有固定 Workflow。"
          />
        </div>
      );
    }

    return (
      <div className="journey-map-empty">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="工作地图加载失败。请关闭后重新打开。"
        />
      </div>
    );
  }

  const {
    snapshot,
    editing,
    usingDraft,
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
    enterEdit,
    cancelEdit,
    saveDraft,
    validate,
    applyWorkflow,
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
    currentDefinition,
  } = editor;

  const activeDefinition = currentDefinition ?? snapshot.definition;

  return (
    <div
      className={
        'journey-map-canvas journey-map-editor-shell'
        + (editing
          ? ' journey-map-editor-mode'
          : ' journey-map-locked-mode')
      }
    >
      <div className="journey-map-editor-header">
        <div>
          <div className="journey-map-heading-title">工作地图</div>
          <div className="journey-map-heading-subtitle">
            {editing
              ? '正在编辑 Workflow 草稿。拖动节点、连线、添加分支；验证通过后才会改变执行路线。'
              : '这是当前 Workflow 的完整路线。锁定模式只能查看；有连接问题的步骤会直接标出。'}
          </div>
        </div>

        <Flex align="center" gap={8} wrap>
          <Tag color={snapshot.source === 'custom' ? 'blue' : undefined}>
            {snapshot.source === 'custom'
              ? '自定义 v' + String(snapshot.version)
              : '内置 Workflow'}
          </Tag>

          {editing ? (
            <>
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
                icon={<SaveOutlined />}
                onClick={() => void saveDraft()}
              >
                保存草稿
              </Button>
              <Button
                size="small"
                onClick={() => void validate()}
              >
                验证
              </Button>
              <Button size="small" onClick={resetWorkflow}>
                恢复内置
              </Button>
              <Button
                size="small"
                onClick={() => void cancelEdit()}
              >
                取消
              </Button>
              <Button
                type="primary"
                size="small"
                icon={<UploadOutlined />}
                onClick={() => void applyWorkflow()}
              >
                应用修改
              </Button>
            </>
          ) : (
            <Button
              type="primary"
              ghost
              size="small"
              icon={<EditOutlined />}
              onClick={enterEdit}
            >
              编辑工作地图
            </Button>
          )}
        </Flex>
      </div>

      {editing && snapshot.draft ? (
        <div className="journey-map-draft-banner">
          <Text>
            已载入之前保存的草稿。当前执行位置仍属于 active Workflow，
            直到你点击“应用修改”。
          </Text>
        </div>
      ) : null}

      {editing && validationIssues.length ? (
        <div className="journey-map-validation-panel">
          <div className="journey-map-validation-title">
            <Text strong>验证问题 {validationIssues.length}</Text>
            <Text type="secondary">这些问题修正后才能应用。</Text>
          </div>

          <div className="journey-map-validation-items">
            {validationIssues.slice(0, 8).map((issue, index) => (
              <Text type="danger" key={index}>
                • {issue}
              </Text>
            ))}
            {validationIssues.length > 8 ? (
              <Text type="secondary">
                还有 {validationIssues.length - 8} 个问题…
              </Text>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="journey-map-editor-body">
        <div className="journey-map-flow-wrap">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={{ journey: JourneyFlowNode }}
            edgeTypes={{ [EDGE_TYPE]: JourneyFlowEdge }}
            onInit={(instance) => {
              flowInstanceRef.current = instance;
            }}
            nodesDraggable={editing}
            nodesConnectable={editing}
            elementsSelectable={editing}
            edgesReconnectable={editing}
            connectionLineType={ConnectionLineType.SmoothStep}
            connectionRadius={28}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onNodeDragStart={() => {
              if (editing) {
                // Undo 历史记录在 drag start 时保存一次，而不是 drag move 每帧保存。
              }
            }}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onNodeClick={(_, node) => {
              if (editing) onNodeClick(node.id);
            }}
            onEdgeClick={(_, edge) => {
              if (editing) onEdgeClick(edge.id);
            }}
            onPaneClick={clearSelection}
            fitView
            fitViewOptions={{
              padding: 0.12,
              minZoom: 0.4,
              maxZoom: 1.05,
            }}
            colorMode="light"
            proOptions={{ hideAttribution: true }}
          >
            <Background
              gap={22}
              size={1}
              variant={BackgroundVariant.Dots}
              color="#dfe5ee"
            />

            <Controls showInteractive={editing} />

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

        {editing ? (
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
          />
        ) : null}
      </div>

      {!editing ? (
        <>
          <div className="journey-map-summary-row">
            <Flex gap={8} align="center" wrap>
              <Text strong>{currentStage?.title ?? '当前调查'}</Text>

              <Tag bordered={false}>
                {completedCount}/
                {Math.max(
                  activeDefinition.nodes.filter((node) => node.visible).length,
                  1,
                )}{' '}
                已完成
              </Tag>

              <Tag bordered={false}>
                {snapshot.state.currentNodeId}
              </Tag>
            </Flex>

            {currentStage && onAskStage ? (
              <Button
                size="small"
                type="primary"
                ghost
                icon={<ArrowRightOutlined />}
                onClick={() => onAskStage(currentStage)}
              >
                围绕当前阶段继续
              </Button>
            ) : null}
          </div>

          {routes.length ? (
            <div className="journey-map-route-list">
              <div className="journey-map-route-list-title">
                <BranchesOutlined />
                Agent 临时建议
              </div>

              <Flex gap={8} wrap>
                {routes.slice(0, 3).map((route) => (
                  <Button
                    key={route.id}
                    size="small"
                    onClick={() => onChooseRoute?.(route)}
                  >
                    {route.title}
                  </Button>
                ))}
              </Flex>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
