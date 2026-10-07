import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Slider,
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

import type { WorkflowExecution, WorkflowRunEvent } from './journey-map-types.js';
import { JourneyMapInspector } from './JourneyMapInspector.js';
import { JourneyX6Graph } from './JourneyX6Graph.js';
import { useJourneyWorkflowEditor } from './useJourneyWorkflowEditor.js';

const { Text } = Typography;

function replayExecutionAt(definition: { id: string; start: string }, events: WorkflowRunEvent[], index: number): WorkflowExecution {
  const execution: WorkflowExecution = {
    workflowId: definition.id,
    workflowVersion: 0,
    runId: events[0]?.runId ?? 'replay',
    currentNodeId: definition.start,
    completedNodeIds: [],
    status: 'active',
  };

  for (const event of events.slice(0, index)) {
    if (event.workflowVersion > 0) execution.workflowVersion = event.workflowVersion;
    if (event.nodeId) execution.currentNodeId = event.nodeId;
    switch (event.type) {
      case 'node-started':
        execution.status = 'active';
        break;
      case 'node-completed': {
        if (event.nodeId && !execution.completedNodeIds.includes(event.nodeId)) {
          execution.completedNodeIds.push(event.nodeId);
        }
        const nextNodeId = event.data && 'nextNodeId' in event.data ? event.data.nextNodeId : undefined;
        if (nextNodeId) execution.currentNodeId = nextNodeId;
        execution.status = 'active';
        break;
      }
      case 'node-waiting':
        execution.status = 'waiting';
        if (event.data && 'nodeId' in event.data) execution.currentNodeId = event.data.nodeId;
        if (event.data && 'id' in event.data) {
          execution.pendingInteraction = {
            id: event.data.id,
            nodeId: event.data.nodeId,
            reason: event.data.reason,
            requestedAt: event.data.requestedAt,
          };
        }
        break;
      case 'node-failed':
        execution.status = 'active';
        break;
      case 'workflow-completed':
        execution.status = 'completed';
        break;
      default:
        break;
    }
    if (event.type !== 'node-waiting' && execution.status !== 'waiting') delete execution.pendingInteraction;
  }
  return execution;
}

function replayEventLabel(event: WorkflowRunEvent): string {
  switch (event.type) {
    case 'workflow-started': return '开始执行';
    case 'node-started': return '进入步骤';
    case 'node-completed': return '完成步骤';
    case 'node-waiting': return '等待人工';
    case 'node-failed': return '步骤失败';
    case 'workflow-completed': return '执行完成';
    case 'transition-rejected': return '转换被拒绝';
    default: return event.type;
  }
}

export interface JourneyMapProps {
  /** 从完整工作页返回调查对话。 */
  onBack?: () => void;
}

/**
 * 工作地图页面。
 *
 * 图编辑能力统一由 AntV X6 承担：节点、Port、Edge、路由、缩放、选择、吸附和小地图
 * 都在 JourneyX6Graph 内完成。Workflow Definition / AI Patch / 保存逻辑仍由 editor hook
 * 管理，因此更换图引擎不会改变业务层。
 *
 * 页面本身只负责三件事：组合画布和右栏、显示保存/校验状态、把用户动作交给 editor hook。
 * 不在这里直接修改 Workflow Definition，也不把 X6 对象存进业务状态。
 */
export function JourneyMap(props: JourneyMapProps) {
  const editor = useJourneyWorkflowEditor();
  const [replayMode, setReplayMode] = useState(false);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
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
    currentDefinition,
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
    onGraphConnect,
    onGraphReconnect,
    onNodeClick,
    onEdgeClick,
    clearSelection,
    deleteSelectedCell,
    beginNodeDrag,
    onNodeMoved,
    fitViewRequest,
  } = editor;

  const replayEvents = useMemo(
    () => snapshot?.events.filter((event) => event.runId === snapshot.execution.runId) ?? [],
    [snapshot?.events, snapshot?.execution.runId],
  );
  const replayExecution = useMemo(
    () => snapshot && replayEvents.length
      ? replayExecutionAt(snapshot.definition, replayEvents, replayIndex)
      : undefined,
    [snapshot, replayEvents, replayIndex],
  );
  const replayEvent = replayEvents[Math.max(0, Math.min(replayIndex - 1, replayEvents.length - 1))];

  useEffect(() => {
    if (!replayMode || !replayPlaying || replayEvents.length === 0) return;
    const timer = window.setInterval(() => {
      setReplayIndex((current) => {
        if (current >= replayEvents.length) {
          setReplayPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [replayMode, replayPlaying, replayEvents.length]);

  useEffect(() => {
    setReplayIndex(0);
    setReplayPlaying(false);
    setReplayMode(false);
  }, [snapshot?.execution.runId]);

  const displayedExecution = replayMode ? replayExecution : snapshot?.execution;

  return (
    <div className="journey-map-page">
      {fetching ? (
        <div className="journey-map-page journey-map-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="正在打开工作地图，请稍候…"
          />
        </div>
      ) : !snapshot ? (
        <div className="journey-map-page journey-map-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="这个调查还没有固定工作方式，先到调查设置选择一种工作方式。"
          />
          {props.onBack ? (
            <Button icon={<ArrowLeftOutlined />} onClick={props.onBack}>
              返回调查
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <header className="journey-map-page-header">
            <div className="journey-map-page-header-main">
              <Button
                type="text"
                icon={<ArrowLeftOutlined />}
                onClick={props.onBack}
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
                  <Tag
                    color={
                      snapshot.execution.status === 'waiting' ? 'blue' : undefined
                    }
                  >
                    {snapshot.execution.status === 'waiting'
                      ? '等待人工'
                      : snapshot.execution.status === 'completed'
                        ? '已完成'
                        : false
                          ? '已停止'
                          : '运行中'}
                  </Tag>
                </Flex>
                <Text type="secondary">
                  直接拖动节点、连接步骤；右侧切换“属性 / AI”。
                </Text>
              </div>
            </div>

            <Flex align="center" gap={8} wrap>
              <Button
                size="small"
                icon={<UndoOutlined />}
                disabled={editor.canUndo === false}
                onClick={editor.undo}
              >
                撤销
              </Button>
              <Button
                size="small"
                icon={<RedoOutlined />}
                disabled={editor.canRedo === false}
                onClick={editor.redo}
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
              <Button size="small" onClick={resetWorkflow}>
                恢复内置
              </Button>
              <Button
                size="small"
                disabled={replayEvents.length === 0}
                onClick={() => {
                  setReplayMode((enabled) => {
                    const next = !enabled;
                    setReplayPlaying(false);
                    if (next) setReplayIndex(0);
                    return next;
                  });
                }}
              >
                {replayMode ? '退出回放' : '运行回放'}
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
                <Text strong>
                  保存前需要修正 {validationIssues.length} 个问题
                </Text>
                <Text type="secondary">当前画布仍然可以继续编辑。</Text>
              </div>
              <div className="journey-map-validation-items">
                {validationIssues.slice(0, 8).map((issue, index) => (
                  <Text type="danger" key={index}>
                    {issue}
                  </Text>
                ))}
                {validationIssues.length > 8 ? (
                  <Text type="secondary">
                    还有 {validationIssues.length - 8} 个问题。
                  </Text>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="journey-map-workspace">
            <div className="journey-map-flow-wrap">
              <JourneyX6Graph
                nodes={nodes}
                edges={edges}
                selectedNodeId={selectedNode?.id}
                selectedEdgeId={selectedEdge?.id}
                fitViewRequest={fitViewRequest}
                execution={displayedExecution}
                executionAnimation={!replayMode || replayPlaying}
                onNodeClick={onNodeClick}
                onEdgeClick={onEdgeClick}
                onBlankClick={clearSelection}
                onNodeDragStart={beginNodeDrag}
                onNodeMoved={onNodeMoved}
                onConnect={onGraphConnect}
                onReconnect={onGraphReconnect}
                onDeleteSelected={deleteSelectedCell}
              />
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
              deleteSelectedEdge={editor.deleteSelectedEdge}
              currentDefinition={currentDefinition}
              selectedNodeId={selectedNode?.id}
              pendingAiChange={pendingAiChange}
              aiEditFlow={aiEditFlow}
              applyAiChanges={applyAiChanges}
              discardAiChanges={discardAiChanges}
              humanWaiting={
                snapshot.execution.status === 'waiting'
                && snapshot.execution.currentNodeId === selectedNode?.id
              }
              applyHumanWorkflowTransition={applyHumanWorkflowTransition}
            />
          </div>

          {replayMode && replayEvents.length ? (
            <div className="journey-map-replay-bar">
              <Flex align="center" gap={8} wrap>
                <Button
                  size="small"
                  onClick={() => {
                    if (replayIndex >= replayEvents.length) {
                      setReplayIndex(0);
                      setReplayPlaying(true);
                    } else {
                      setReplayPlaying((playing) => !playing);
                    }
                  }}
                >
                  {replayPlaying ? '暂停' : replayIndex >= replayEvents.length ? '重播' : '播放'}
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    setReplayPlaying(false);
                    setReplayIndex(0);
                  }}
                >
                  回到开始
                </Button>
                <Text strong>运行轨迹</Text>
                <Text type="secondary">{replayIndex}/{replayEvents.length}</Text>
              </Flex>
              <Slider
                min={0}
                max={replayEvents.length}
                value={replayIndex}
                onChange={(value) => {
                  setReplayPlaying(false);
                  setReplayIndex(value);
                }}
                tooltip={{
                  formatter: (value) => {
                    if (!value || value <= 0) return '开始';
                    const event = replayEvents[value - 1];
                    return event
                      ? replayEventLabel(event) + ' · ' + new Date(event.timestamp).toLocaleTimeString()
                      : undefined;
                  },
                }}
              />
              <Text type="secondary">
                {replayEvent
                  ? replayEventLabel(replayEvent) + ' · ' + (replayEvent.nodeId ?? '工作流')
                  : '从真实运行事件回放'}
              </Text>
            </div>
          ) : null}

          <footer className="journey-map-page-footer">
            <Flex align="center" gap={8} wrap>
              <Text strong>{currentStage?.title ?? '当前步骤'}</Text>
              <Tag variant="filled">
                {completedCount}/
                {Math.max(
                  currentDefinition?.nodes.length ?? 0,
                  1,
                )}{' '}
                已完成
              </Tag>
              <Text type="secondary">
                当前执行位置：{snapshot.execution.currentNodeId}
              </Text>
            </Flex>

            <Space size={12}>
              <Text type="secondary">Cmd/Ctrl + S 保存</Text>
              {snapshot.execution.status === 'completed' ? (
                <Tag color="green" variant="filled">
                  这条路线已经走完
                </Tag>
              ) : (
                <Tag variant="filled">正在执行</Tag>
              )}
            </Space>
          </footer>
        </>
      )}
    </div>
  );
}
