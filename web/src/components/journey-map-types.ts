import type React from 'react';
import {
  AimOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  LockOutlined,
} from '@ant-design/icons';
import type { Edge, Node } from '@xyflow/react';

/** DSL 中允许出现的 Workflow 节点类型。保持小集合，避免演变成 BPMN。 */
export type WorkflowNodeType = 'task' | 'gate' | 'review' | 'end' | 'stop';

/** 节点如何判断“这一阶段完成”。 */
export type CompletionMode = 'deterministic' | 'agent';

export interface JourneyMapStage {
  id: string;
  title: string;
  objective: string;
  status: 'completed' | 'current' | 'locked' | 'future';
  nodeType: string;
  unlocked: boolean;
}

export interface JourneyMapRoute {
  id: string;
  title: string;
  reason: string;
  steps: string[];
}

export interface JourneyRouteDefinition {
  outcome: string;
  target: string;
  line?: number;
}

export interface WorkflowNodeDefinition {
  id: string;
  type: WorkflowNodeType;
  title: string;
  objective?: string;
  visible: boolean;
  completion: CompletionMode;
  completeWhen?: string;
  tools?: string[];
  routes: JourneyRouteDefinition[];
  line?: number;
}

export interface WorkflowDefinition {
  id: string;
  start: string;
  nodes: WorkflowNodeDefinition[];
}

export interface WorkflowLayout {
  version: 1;
  nodes: Record<string, { x: number; y: number }>;
  /** 布局算法版本。升级算法后故意改值，让旧布局自动重新计算。 */
  engine?: 'elk' | 'elk-v2';
  viewport?: { x: number; y: number; zoom: number };
}

export interface WorkflowExecution {
  workflowId: string;
  workflowVersion: number;
  currentNodeId: string;
  completedNodeIds: string[];
  status: 'active' | 'completed' | 'stopped';
}

export interface WorkflowState {
  workflowId: string;
  currentNodeId: string;
  completedNodeIds: string[];
  unlockedNodeIds: string[];
  stages: JourneyMapStage[];
  execution: WorkflowExecution;
}

export interface WorkflowSnapshot {
  workflowId: string;
  source: 'base' | 'custom';
  baseWorkflowId: string;
  version: number;
  definition: WorkflowDefinition;
  layout: WorkflowLayout;
  execution: WorkflowExecution;
  state: WorkflowState;
  draft: {
    definition: WorkflowDefinition;
    layout: WorkflowLayout;
    issues: string[];
  } | null;
}

export interface JourneyMapProps {
  journey?: { stages: JourneyMapStage[] };
  routes?: JourneyMapRoute[];
  loading?: boolean;
  onChooseRoute?: (route: JourneyMapRoute) => void;
  onAskStage?: (stage: JourneyMapStage) => void;
}

export interface HandleSpec {
  id: string;
  label: string;
}

export interface FlowNodeData extends Record<string, unknown> {
  title: string;
  objective?: string;
  nodeType: WorkflowNodeType;
  status: JourneyMapStage['status'];
  completion: CompletionMode;
  completeWhen?: string;
  visible: boolean;
  editing: boolean;
  isNew?: boolean;
  sourceHandles: HandleSpec[];
  targetHandles: HandleSpec[];
  connectionIssue?: 'error' | 'warning';
  connectionIssueText?: string;
  onSelect?: (id: string) => void;
  onAddStep?: (id: string) => void;
  onAddBranch?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export interface FlowEdgeData extends Record<string, unknown> {
  outcome: string;
  labelOffsetY?: number;
  onSelect?: (id: string) => void;
}

export type FlowNode = Node<FlowNodeData>;
export type FlowEdge = Edge<FlowEdgeData>;

export const NODE_TYPE_LABEL: Record<WorkflowNodeType, string> = {
  task: '任务',
  gate: '判断点',
  review: '评审',
  end: '完成',
  stop: '停止',
};

export const STATUS_META: Record<
  JourneyMapStage['status'],
  { label: string; icon: React.ReactNode }
> = {
  completed: { label: '已完成', icon: <CheckCircleFilled /> },
  current: { label: '当前', icon: <AimOutlined /> },
  future: { label: '待进入', icon: <ClockCircleOutlined /> },
  locked: { label: '暂不可走', icon: <LockOutlined /> },
};

export const STATUS_CLASS: Record<JourneyMapStage['status'], string> = {
  completed: 'journey-flow-node-completed',
  current: 'journey-flow-node-current',
  future: 'journey-flow-node-future',
  locked: 'journey-flow-node-locked',
};

export const EDGE_TYPE = 'journey' as const;
