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
  | { type: 'update-route'; nodeId: string; outcome: string; patch: { target?: string; condition?: string | null } }
  | { type: 'remove-route'; nodeId: string; outcome: string };

export interface WorkflowDefinition {
  id: string;
  start: string;
  nodes: WorkflowNodeDefinition[];
}

export interface WorkflowLayout {
  version: 1;
  nodes: Record<string, { x: number; y: number }>;
  /** 自动布局算法版本；旧 elk* 值继续兼容历史布局。 */
  engine?: 'workflow-v1' | 'elk' | 'elk-v2' | 'elk-v3' | 'elk-v4' | 'elk-v5';
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

export type JourneyEdgeKind = 'success' | 'fail' | 'retry' | 'other';

export interface HandleSpec {
  id: string;
  label: string;
  /** 用于决定 Port 位于节点的哪一侧；不进入 Workflow DSL。 */
  kind?: JourneyEdgeKind;
}

/**
 * 画布运行时节点。
 *
 * 这个类型不再依赖 React Flow。X6 只是渲染/交互层，业务层继续使用稳定的
 * Workflow 节点 + position 数据，因此换图引擎不会污染 Workflow DSL。
 */
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
  selected?: boolean;
  sourceHandles: HandleSpec[];
  targetHandles: HandleSpec[];
  connectionIssue?: 'error' | 'warning';
  connectionIssueText?: string;
  onAddStep?: (id: string) => void;
  onAddBranch?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export interface FlowNode {
  id: string;
  type: 'journey';
  position: { x: number; y: number };
  data: FlowNodeData;
  width?: number;
  height?: number;
}

export interface FlowEdgeData extends Record<string, unknown> {
  outcome: string;
  /** 仅用于工作地图视觉；真实业务语义仍以 outcome 为准。 */
  kind?: JourneyEdgeKind;
  condition?: string;
  onSelect?: (id: string) => void;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** X6 source port；只作为画布连接身份，不进入 Workflow DSL。 */
  sourceHandle?: string;
  /** X6 target port；只作为画布连接身份，不进入 Workflow DSL。 */
  targetHandle?: string;
  data: FlowEdgeData;
}

/** 当前工作地图使用的图引擎。 */
export const JOURNEY_GRAPH_ENGINE = 'x6' as const;

/** 工作地图固定节点尺寸；布局、X6 Shape、Graph projection 必须共用。 */
export const JOURNEY_NODE_SIZE = {
  regular: { width: 220, height: 104 },
  terminal: { width: 132, height: 68 },
} as const;

/** X6 中隐藏的“新增出口”连接桩。 */
export const NEW_SOURCE_HANDLE_ID = '__new__';

/** X6 中用于从任意节点新增一条入边的透明目标连接桩。 */
export const NEW_TARGET_HANDLE_ID = '__new-in__';

/** 节点状态对应的 CSS class；视觉细节留在 styles.css。 */
export const STATUS_CLASS: Record<JourneyMapStage['status'], string> = {
  completed: 'journey-flow-node-completed',
  current: 'journey-flow-node-current',
  future: 'journey-flow-node-future',
  locked: 'journey-flow-node-locked',
};

/** Workflow 编辑器的边类型只是业务侧的稳定标识，不再对应 React Flow edge type。 */
export const EDGE_TYPE = 'journey' as const;
