import type {
  JourneyActor,
  JourneyDerivedState,
  JourneyDefinition,
  JourneyExecution,
  JourneyNode,
  JourneyNodeType,
  JourneyRoute,
  JourneyStage,
  JourneyWorkflowChange,
  JourneyRunEvent,
  WorkflowSnapshot as SharedWorkflowSnapshot,
} from '../../../src/api/contracts.js';

/** Workflow business types come from the canonical shared contract. Canvas-only types are defined below. */
export type WorkflowNodeType = JourneyNodeType;
export type WorkflowActor = JourneyActor;
export type JourneyMapStage = JourneyStage;
export type JourneyRouteDefinition = JourneyRoute;
export type WorkflowNodeDefinition = JourneyNode;
export type WorkflowChange = JourneyWorkflowChange;
export type WorkflowDefinition = JourneyDefinition;
export type WorkflowExecution = JourneyExecution;
export type WorkflowState = JourneyDerivedState;
export type WorkflowRunEvent = JourneyRunEvent;
export type WorkflowSnapshot = SharedWorkflowSnapshot;

export interface JourneyMapRoute {
  id: string;
  title: string;
  reason: string;
  steps: string[];
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
  actor: WorkflowActor;
  completeWhen?: string;
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
