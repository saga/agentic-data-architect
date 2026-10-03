import type { Edge, Node } from '@xyflow/react';

/** DSL 中允许出现的 Workflow 节点类型；只取 BPMN 里最有价值的一小部分语义。 */
export type WorkflowNodeType = 'task' | 'gate' | 'review' | 'end' | 'stop';

/** 节点如何判断“这一阶段完成”。 */
export type CompletionMode = 'deterministic' | 'agent';
export type WorkflowActor = 'agent' | 'human' | 'system';

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
  /** 可选确定性条件；命中后优先使用该出口。 */
  condition?: string;
  line?: number;
}

export interface WorkflowNodeDefinition {
  id: string;
  type: WorkflowNodeType;
  title: string;
  objective?: string;
  visible: boolean;
  completion: CompletionMode;
  actor: WorkflowActor;
  completeWhen?: string;
  tools?: string[];
  requires?: string[];
  produces?: string[];
  routes: JourneyRouteDefinition[];
  line?: number;
}

export type WorkflowChange =
  | { type: 'replace-definition'; definition: WorkflowDefinition }
  | { type: 'add-node'; node: WorkflowNodeDefinition }
  | { type: 'update-node'; nodeId: string; patch: Partial<Omit<WorkflowNodeDefinition, 'id' | 'routes' | 'line'>> }
  | { type: 'remove-node'; nodeId: string }
  | { type: 'add-route'; nodeId: string; route: { outcome: string; target: string; condition?: string } }
  | { type: 'update-route'; nodeId: string; outcome: string; patch: { target?: string; condition?: string } }
  | { type: 'remove-route'; nodeId: string; outcome: string };

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

export interface WorkflowPendingInteraction {
  id: string;
  nodeId: string;
  reason: string;
  requestedAt: string;
}

export interface WorkflowRunEvent {
  id: string;
  runId: string;
  workflowId: string;
  workflowVersion: number;
  type: string;
  timestamp: string;
  nodeId?: string;
  outcome?: string;
  error?: string;
  data?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cost?: number;
  };
}

export interface WorkflowAnalysisIssue {
  severity: 'warning' | 'error';
  code: string;
  nodeId?: string;
  message: string;
}

export interface WorkflowExecution {
  workflowId: string;
  workflowVersion: number;
  runId: string;
  currentNodeId: string;
  completedNodeIds: string[];
  status: 'active' | 'waiting' | 'completed' | 'stopped';
  pendingInteraction?: WorkflowPendingInteraction;
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
  analysis: WorkflowAnalysisIssue[];
  events: WorkflowRunEvent[];
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
  actor: WorkflowActor;
  completeWhen?: string;
  requires?: string[];
  produces?: string[];
  visible: boolean;
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
  condition?: string;
  labelOffsetY?: number;
  onSelect?: (id: string) => void;
}

export type FlowNode = Node<FlowNodeData>;
export type FlowEdge = Edge<FlowEdgeData>;

/** 节点状态对应的 CSS class；视觉细节留在 styles.css。 */
export const STATUS_CLASS: Record<JourneyMapStage['status'], string> = {
  completed: 'journey-flow-node-completed',
  current: 'journey-flow-node-current',
  future: 'journey-flow-node-future',
  locked: 'journey-flow-node-locked',
};

export const EDGE_TYPE = 'journey' as const;
