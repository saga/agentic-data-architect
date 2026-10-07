import { useEffect, useMemo, useRef } from 'react';
import {
  Graph,
  Keyboard,
  MiniMap,
  Selection,
  Snapline,
} from '@antv/x6';
import {
  JOURNEY_NODE_SIZE,
  NEW_SOURCE_HANDLE_ID,
  NEW_TARGET_HANDLE_ID,
} from './journey-map-types.js';
import type {
  FlowEdge,
  FlowNode,
  FlowNodeData,
  JourneyEdgeKind,
} from './journey-map-types.js';
import { classifyJourneyEdge } from './journey-map-visuals.js';
import { JOURNEY_X6_SHAPE } from './JourneyX6Node.js';
import type { GraphConnection } from './journey-map-graph.js';

export interface JourneyX6GraphProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedNodeId?: string;
  selectedEdgeId?: string;
  fitViewRequest: number;
  onNodeClick: (id: string) => void;
  onEdgeClick: (id: string) => void;
  onBlankClick: () => void;
  onNodeDragStart: () => void;
  onNodeMoved: (id: string, position: { x: number; y: number }) => void;
  onConnect: (connection: GraphConnection) => Promise<void>;
  onReconnect: (edgeId: string, connection: GraphConnection) => Promise<void>;
  onDeleteSelected: (cellId: string, kind: 'node' | 'edge') => void;
  execution?: import('./journey-map-types.js').WorkflowExecution;
  executionAnimation?: boolean;
}

function activeExecutionEdgeId(
  edges: FlowEdge[],
  execution?: import('./journey-map-types.js').WorkflowExecution,
): string | undefined {
  if (!execution || execution.status !== 'active' || !execution.currentNodeId) return undefined;
  const completed = new Set(execution.completedNodeIds);
  const incoming = edges
    .filter((edge) => edge.target === execution.currentNodeId && completed.has(edge.source))
    .sort((a, b) => a.id.localeCompare(b.id));
  return incoming[0]?.id;
}

/**
 * AntV X6 画布适配层。
 *
 * 这里是工作地图唯一直接操作 X6 Graph 的地方：
 * Workflow Definition / FlowNode / FlowEdge 仍然是业务模型，
 * X6 只负责节点、Port、Edge、缩放、选择和连线交互。
 *
 * 特别重要：
 * - outcome 不在画布上显示，只保存在 Edge data，并在选中连线后由右侧属性面板展示；
 * - 节点移动只更新 X6 自己的位置，不重建整张图；
 * - 只有节点/边的结构真正变化时才重新同步结构，避免拖动时闪烁；
 * - source/target Port 本身透明，只作为真实连接热区。
 */
export function JourneyX6Graph({
  nodes,
  edges,
  selectedNodeId,
  selectedEdgeId,
  fitViewRequest,
  onNodeClick,
  onEdgeClick,
  onBlankClick,
  onNodeDragStart,
  onNodeMoved,
  onConnect,
  onReconnect,
  onDeleteSelected,
  execution,
  executionAnimation = true,
}: JourneyX6GraphProps) {
  const executionOverlayRef = useRef<SVGSVGElement>(null);
  const executionTokenRef = useRef<SVGCircleElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const callbacksRef = useRef({
    onNodeClick,
    onEdgeClick,
    onBlankClick,
    onNodeDragStart,
    onNodeMoved,
    onConnect,
    onReconnect,
    onDeleteSelected,
  });
  const lastStructureKeyRef = useRef('');

  callbacksRef.current = {
    onNodeClick,
    onEdgeClick,
    onBlankClick,
    onNodeDragStart,
    onNodeMoved,
    onConnect,
    onReconnect,
    onDeleteSelected,
  };

  const activeExecutionEdgeIdValue = useMemo(
    () => activeExecutionEdgeId(edges, execution),
    [edges, execution?.status, execution?.currentNodeId, execution?.completedNodeIds],
  );

  const structureKey = useMemo(
    () =>
      JSON.stringify({
        nodes: nodes.map((node) => ({
          id: node.id,
          width: node.width,
          height: node.height,
          sourceHandles: node.data.sourceHandles.map((handle) => ({
            id: handle.id,
            label: handle.label,
            kind: handle.kind,
          })),
          targetHandles: node.data.targetHandles.map((handle) => ({
            id: handle.id,
            kind: handle.kind,
          })),
        })),
        edges: edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          kind: edge.data?.kind ?? classifyJourneyEdge(edge.data?.outcome),
        })),
      }),
    [nodes, edges],
  );

  /**
   * Agent Flow 风格的方向性 Port：
   * - success：从底部出去、从顶部进入，形成清晰的主流程；
   * - fail：从右侧出去、从左侧进入；
   * - 其它分支：从左侧出去、从右侧进入；
   * - retry：从左侧出去、从左侧进入，并沿画布最外侧走灰色虚线回线；它仍是真实 Workflow Edge。
   *
   * X6 自带 top/right/bottom/left 均匀分布 Port 的布局能力，
   * 不需要自己计算每个 Port 的像素位置。
   */
  const buildPorts = (node: FlowNode) => {
    const terminal =
      node.data.nodeType === 'end';

    // retry 也是真实 Workflow Edge，不能从 Port 中隐藏；它只是采用不同的视觉路由。
    const visibleSources = node.data.sourceHandles;
    const visibleTargets = node.data.targetHandles;

    const portAttrs = {
      circle: {
        r: 4,
        magnet: true,
        fill: '#fff',
        stroke: '#8da0b5',
        strokeWidth: 1.5,
        opacity: 0.96,
      },
    };

    return {
      groups: {
        inputTop: {
          position: 'top',
          attrs: { circle: { ...portAttrs.circle, magnet: 'passive' } },
        },
        inputLeft: {
          position: 'left',
          attrs: { circle: { ...portAttrs.circle, magnet: 'passive' } },
        },
        inputRight: {
          position: 'right',
          attrs: { circle: { ...portAttrs.circle, magnet: 'passive' } },
        },
        outputBottom: {
          position: 'bottom',
          attrs: portAttrs,
        },
        outputLeft: {
          position: 'left',
          attrs: portAttrs,
        },
        outputRight: {
          position: 'right',
          attrs: portAttrs,
        },
        newInput: {
          position: 'top' as const,
          attrs: {
            circle: {
              r: 8,
              magnet: 'passive' as const,
              fill: 'transparent',
              stroke: 'transparent',
              opacity: 0,
            },
          },
        },
        newOutput: {
          position: 'bottom' as const,
          attrs: {
            circle: {
              r: 8,
              magnet: true,
              fill: 'transparent',
              stroke: 'transparent',
              opacity: 0,
            },
          },
        },
      },
      items: [
        ...visibleTargets.map((handle) => ({
          id: handle.id,
          group:
            handle.kind === 'success'
              ? 'inputTop'
              : handle.kind === 'retry'
                ? 'inputLeft'
                : handle.kind === 'fail'
                  ? 'inputLeft'
                  : 'inputRight',
        })),
        {
          id: NEW_TARGET_HANDLE_ID,
          group: 'newInput',
        },
        ...visibleSources.map((handle) => ({
          id: handle.id,
          group:
            handle.kind === 'success'
              ? 'outputBottom'
              : handle.kind === 'retry'
                ? 'outputLeft'
                : handle.kind === 'fail'
                  ? 'outputRight'
                  : 'outputLeft',
        })),
        ...(terminal
          ? []
          : [
              {
                id: NEW_SOURCE_HANDLE_ID,
                group: 'newOutput',
              },
            ]),
      ],
    };
  };

  /** 给 X6 添加完整业务 graph。 */
  const rebuildGraphStructure = () => {
    const graph = graphRef.current;
    if (!graph) return;

    const visibleEdges = edges;

    graph.batchUpdate(() => {
      graph.clearCells();

      graph.addNodes(
        nodes.map((node) => ({
          id: node.id,
          shape: JOURNEY_X6_SHAPE,
          x: node.position.x,
          y: node.position.y,
          width: node.width ?? (
            node.data.nodeType === 'end'
              ? JOURNEY_NODE_SIZE.terminal.width
              : JOURNEY_NODE_SIZE.regular.width
          ),
          height: node.height ?? (
            node.data.nodeType === 'end'
              ? JOURNEY_NODE_SIZE.terminal.height
              : JOURNEY_NODE_SIZE.regular.height
          ),
          zIndex: 10,
          data: {
            ...node.data,
            selected: node.id === selectedNodeId,
          },
          ports: buildPorts(node),
        })),
      );

      graph.addEdges(
        visibleEdges.map((edge) => {
          const kind: JourneyEdgeKind =
            edge.data?.kind ?? classifyJourneyEdge(edge.data?.outcome);
          const selected = edge.id === selectedEdgeId;
          const active = edge.id === activeExecutionEdgeIdValue;

          const style = {
            success: {
              stroke: '#52c41a',
              opacity: 0.82,
              dash: undefined,
            },
            fail: {
              stroke: '#ff4d4f',
              opacity: 0.86,
              dash: undefined,
            },
            retry: {
              stroke: '#8c99a8',
              opacity: 0.86,
              dash: '7 5',
            },
            other: {
              stroke: '#9aa7b7',
              opacity: 0.66,
              dash: undefined,
            },
          }[kind];

          const edgeConfig = {
            id: edge.id,
            className: active ? 'journey-flow-edge-active' : undefined,
            shape: 'edge',
            source: {
              cell: edge.source,
              port: edge.sourceHandle,
            },
            target: {
              cell: edge.target,
              port: edge.targetHandle,
            },
            connector: {
              name: 'rounded',
              args: { radius: 12 },
            },
            labels: [],
            attrs: {
              line: {
                stroke: style.stroke,
                strokeWidth: selected ? 3 : 2,
                strokeOpacity: selected ? 1 : style.opacity,
                strokeLinejoin: 'round',
                strokeLinecap: 'round',
                ...(style.dash ? { strokeDasharray: style.dash } : {}),
                targetMarker: {
                  name: 'block',
                  width: selected ? 10 : 8,
                  height: selected ? 7 : 6,
                  fill: style.stroke,
                  stroke: style.stroke,
                },
              },
            },
            data: edge.data,
          };

          if (kind === 'success') {
            return {
              ...edgeConfig,
              router: {
                name: 'manhattan',
                args: {
                  step: 16,
                  padding: 18,
                  startDirections: ['bottom'],
                  endDirections: ['top'],
                },
              },
            };
          }

          if (kind === 'fail') {
            return {
              ...edgeConfig,
              router: {
                name: 'manhattan',
                args: {
                  step: 16,
                  padding: 18,
                  startDirections: ['right'],
                  endDirections: ['left'],
                },
              },
            };
          }

          if (kind === 'retry') {
            const sourceNode = nodes.find((node) => node.id === edge.source);
            const targetNode = nodes.find((node) => node.id === edge.target);
            const retryEdgeIndex = edges
              .slice(0, edges.indexOf(edge))
              .filter(
                (candidate) =>
                  (candidate.data?.kind ?? classifyJourneyEdge(candidate.data?.outcome))
                    === 'retry',
              ).length;
            const laneX =
              Math.min(...nodes.map((node) => node.position.x))
              - 72
              - Math.floor(retryEdgeIndex / 2) * 28;

            return {
              ...edgeConfig,
              vertices: [
                {
                  x: laneX,
                  y:
                    (sourceNode?.position.y ?? 0)
                    + (sourceNode?.height ?? JOURNEY_NODE_SIZE.regular.height) / 2,
                },
                {
                  x: laneX,
                  y:
                    (targetNode?.position.y ?? 0)
                    + (targetNode?.height ?? JOURNEY_NODE_SIZE.regular.height) / 2,
                },
              ],
              router: {
                name: 'orth',
                args: {
                  padding: 18,
                },
              },
            };
          }

          return {
            ...edgeConfig,
            router: {
              name: 'manhattan',
              args: {
                step: 16,
                padding: 18,
              },
            },
          };
        }),
      );
    });
  };

  /**
   * X6 Graph 只创建一次。
   *
   * 官方事件模型里 node:move 是拖动开始、node:moved 是拖动结束；
   * 因此 Undo 只在 node:move 记录一次，位置在 node:moved 再写回业务状态。
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || graphRef.current) return;

    const graph = new Graph({
      container,
      autoResize: true,
      background: {
        color: '#f7f9fc',
      },
      grid: {
        size: 16,
        visible: true,
        type: 'dot',
        args: {
          color: '#dfe5ee',
          thickness: 1,
        },
      },
      panning: true,
      mousewheel: true,
      scaling: {
        min: 0.2,
        max: 1.4,
      },
      connecting: {
        allowBlank: false,
        allowLoop: false,
        allowNode: false,
        allowEdge: false,
        allowPort: true,
        allowMulti: 'withPort',
        highlight: true,
        sourceConnectionPoint: 'boundary',
        targetConnectionPoint: 'boundary',
        router: {
          name: 'manhattan',
          args: {
            step: 16,
            padding: 18,
          },
        },
        connector: {
          name: 'rounded',
          args: {
            radius: 10,
          },
        },
        createEdge() {
          return this.createEdge({
            shape: 'edge',
            attrs: {
              line: {
                stroke: '#aab6c5',
                strokeWidth: 1.8,
                targetMarker: {
                  name: 'block',
                  width: 8,
                  height: 6,
                },
              },
            },
            data: {
              outcome: 'branch',
            },
          });
        },
      },
    });

    graph.use(
      new Selection({
        enabled: true,
        multiple: false,
        rubberband: false,
        showNodeSelectionBox: false,
        showEdgeSelectionBox: false,
      }),
    );

    graph.use(new Snapline({ enabled: true, tolerance: 8 }));
    graph.use(new Keyboard({ enabled: true }));

    if (minimapRef.current) {
      graph.use(
        new MiniMap({
          container: minimapRef.current,
          width: 180,
          height: 120,
          padding: 8,
          scalable: true,
        }),
      );
    }

    graph.on('node:click', ({ node }) => {
      callbacksRef.current.onNodeClick(node.id);
    });

    graph.on('edge:click', ({ edge }) => {
      callbacksRef.current.onEdgeClick(edge.id);
    });

    graph.on('blank:click', () => {
      graph.cleanSelection();
      callbacksRef.current.onBlankClick();
    });

    graph.on('node:move', () => {
      callbacksRef.current.onNodeDragStart();
    });

    graph.on('node:moved', ({ node }) => {
      const position = node.position();
      callbacksRef.current.onNodeMoved(node.id, position);
    });

    graph.on('node:selected', ({ node }) => {
      const data = node.getData<FlowNodeData>();
      node.setData({ ...data, selected: true });
    });

    graph.on('node:unselected', ({ node }) => {
      const data = node.getData<FlowNodeData>();
      node.setData({ ...data, selected: false });
    });

    graph.on('edge:connected', async ({ edge, isNew }) => {
      const sourceCell = edge.getSourceCell();
      const targetCell = edge.getTargetCell();

      if (!sourceCell?.isNode() || !targetCell?.isNode()) {
        edge.remove();
        return;
      }

      const sourcePort = edge.getSourcePortId();
      const targetPort = edge.getTargetPortId();
      const connection: GraphConnection = {
        source: sourceCell.id,
        target: targetCell.id,
        ...(sourcePort ? { sourcePort } : {}),
        ...(targetPort ? { targetPort } : {}),
      };

      if (isNew) {
        await callbacksRef.current.onConnect(connection);
      } else {
        await callbacksRef.current.onReconnect(edge.id, connection);
      }
    });

    graph.bindKey(['delete', 'backspace'], () => {
      const selected = graph.getSelectedCells();
      for (const cell of selected) {
        callbacksRef.current.onDeleteSelected(
          cell.id,
          cell.isEdge() ? 'edge' : 'node',
        );
      }
      graph.cleanSelection();
    });

    graphRef.current = graph;

    return () => {
      graph.dispose();
      graphRef.current = null;
    };
  }, []);

  /**
   * 结构变化才重建 X6 cell。
   * 节点拖动时 structureKey 不变，因此不会清空 canvas，也不会打断鼠标拖动。
   */
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    if (structureKey === lastStructureKeyRef.current) return;

    lastStructureKeyRef.current = structureKey;
    rebuildGraphStructure();
  }, [structureKey]);

  /**
   * 普通节点属性、选择状态、位置变化只更新现有 X6 cell。
   * 不再通过 React 重建整张图。
   */
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;

    for (const node of nodes) {
      const cell = graph.getCellById(node.id);
      if (!cell?.isNode()) continue;

      const data = cell.getData<FlowNodeData>();
      if (
        data.title !== node.data.title
        || data.objective !== node.data.objective
        || data.nodeType !== node.data.nodeType
        || data.actor !== node.data.actor
        || data.status !== node.data.status
        || data.completion !== node.data.completion
        || data.completeWhen !== node.data.completeWhen
        || data.visible !== node.data.visible
        || data.connectionIssue !== node.data.connectionIssue
        || data.connectionIssueText !== node.data.connectionIssueText
        || data.selected !== (node.id === selectedNodeId)
      ) {
        cell.setData(
          {
            ...node.data,
            selected: node.id === selectedNodeId,
          },
        );
      }

      const currentPosition = cell.position();
      if (
        currentPosition.x !== node.position.x
        || currentPosition.y !== node.position.y
      ) {
        cell.position(node.position.x, node.position.y);
      }
    }

    for (const edge of edges) {
      const cell = graph.getCellById(edge.id);
      if (!cell?.isEdge()) continue;

      const selected = edge.id === selectedEdgeId;
      const active = edge.id === activeExecutionEdgeIdValue;
      const kind: JourneyEdgeKind =
        edge.data?.kind ?? classifyJourneyEdge(edge.data?.outcome);
      const stroke =
        kind === 'success'
          ? '#52c41a'
          : kind === 'fail'
            ? '#ff4d4f'
            : kind === 'retry'
              ? '#8c99a8'
              : '#9aa7b7';

      cell.setVisible(true);
      cell.attr('line/stroke', stroke);
      cell.attr(
        'line/strokeOpacity',
        selected
          ? 1
          : kind === 'success'
            ? 0.82
            : kind === 'fail'
              ? 0.86
              : kind === 'retry'
                ? 0.86
                : 0.66,
      );
      cell.attr('line/strokeWidth', selected ? 3 : 2);
      cell.attr('line/targetMarker', {
        name: 'block',
        width: selected ? 10 : 8,
        height: selected ? 7 : 6,
        fill: stroke,
        stroke,
      });
      cell.attr('line/strokeDasharray', active ? '10 7' : kind === 'retry' ? '7 5' : undefined);
      cell.setProp('className', active ? 'journey-flow-edge-active' : '');

      // retry 使用显式回线，节点拖动/自动排版后也要同步回线的折点。
      if (kind === 'retry') {
        const sourceNode = nodes.find((node) => node.id === edge.source);
        const targetNode = nodes.find((node) => node.id === edge.target);
        const retryEdgeIndex = edges
          .slice(0, edges.indexOf(edge))
          .filter(
            (candidate) =>
              (candidate.data?.kind ?? classifyJourneyEdge(candidate.data?.outcome))
                === 'retry',
          ).length;
        const laneX =
          Math.min(...nodes.map((node) => node.position.x))
          - 72
          - Math.floor(retryEdgeIndex / 2) * 28;

        cell.setVertices([
          {
            x: laneX,
            y:
              (sourceNode?.position.y ?? 0)
              + (sourceNode?.height ?? JOURNEY_NODE_SIZE.regular.height) / 2,
          },
          {
            x: laneX,
            y:
              (targetNode?.position.y ?? 0)
              + (targetNode?.height ?? JOURNEY_NODE_SIZE.regular.height) / 2,
          },
        ]);
      }
    }

  }, [nodes, edges, selectedNodeId, selectedEdgeId, activeExecutionEdgeIdValue]);

  /**
   * Magpie 风格的执行覆盖层：不重画 X6 Edge，而是让一个小 token 沿 X6 的真实 SVG path 移动。
   * 因为位置通过 screen CTM 计算，缩放、平移和拖动节点时 token 会继续跟随真实路径。
   */
  useEffect(() => {
    const graph = graphRef.current;
    const container = containerRef.current;
    const overlay = executionOverlayRef.current;
    const token = executionTokenRef.current;
    if (!graph || !container || !overlay || !token || !activeExecutionEdgeIdValue || !executionAnimation) {
      if (overlay && token) token.setAttribute('visibility', 'hidden');
      return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hidden = () => document.hidden;
    let raf = 0;
    const startedAt = performance.now();
    const duration = 1100;

    const findPath = (): SVGPathElement | null => {
      const cell = graph.getCellById(activeExecutionEdgeIdValue);
      if (!cell?.isEdge()) return null;
      const view = graph.findViewByCell(cell);
      if (!view) return null;
      return (
        (view.container.querySelector('.x6-edge-line') as SVGPathElement | null)
        || (view.container.querySelector('path') as SVGPathElement | null)
      );
    };

    const hideToken = () => token.setAttribute('visibility', 'hidden');

    if (reducedMotion) {
      const path = findPath();
      if (path) {
        const length = path.getTotalLength();
        const point = path.getPointAtLength(length);
        const matrix = path.getScreenCTM();
        const rect = container.getBoundingClientRect();
        if (matrix) {
          const client = new DOMPoint(point.x, point.y).matrixTransform(matrix);
          token.setAttribute('cx', String(client.x - rect.left));
          token.setAttribute('cy', String(client.y - rect.top));
          token.removeAttribute('visibility');
        } else {
          hideToken();
        }
      } else {
        hideToken();
      }
      return;
    }

    const frame = (timestamp: number) => {
      if (hidden()) {
        token.setAttribute('visibility', 'hidden');
        raf = 0;
        return;
      }

      const path = findPath();
      if (!path || !path.isConnected) {
        token.setAttribute('visibility', 'hidden');
        raf = requestAnimationFrame(frame);
        return;
      }

      try {
        const length = path.getTotalLength();
        const progress = ((timestamp - startedAt) % duration) / duration;
        const eased = progress < 0.5
          ? 2 * progress * progress
          : 1 - ((-2 * progress + 2) ** 2) / 2;
        const point = path.getPointAtLength(length * eased);
        const matrix = path.getScreenCTM();
        if (!matrix) {
          hideToken();
        } else {
          const client = new DOMPoint(point.x, point.y).matrixTransform(matrix);
          const rect = container.getBoundingClientRect();
          token.setAttribute('cx', String(client.x - rect.left));
          token.setAttribute('cy', String(client.y - rect.top));
          token.removeAttribute('visibility');
        }
      } catch {
        hideToken();
      }

      raf = requestAnimationFrame(frame);
    };

    const onVisibilityChange = () => {
      if (!document.hidden && !raf) {
        raf = requestAnimationFrame(frame);
      } else if (document.hidden) {
        hideToken();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    raf = requestAnimationFrame(frame);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      hideToken();
    };
  }, [activeExecutionEdgeIdValue, executionAnimation]);

  /** 只处理 editor 明确发出的 fit 请求；普通拖动不会触发缩放。 */
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !fitViewRequest) return;

    requestAnimationFrame(() => {
      graph.zoomToFit({
        padding: 40,
        minScale: 0.2,
        maxScale: 1.1,
      });
    });
  }, [fitViewRequest]);

  return (
    <>
      <div ref={containerRef} className="journey-x6-graph-container">
        <svg
          ref={executionOverlayRef}
          className="journey-flow-execution-overlay"
          aria-hidden="true"
        >
          <circle
            ref={executionTokenRef}
            className="journey-flow-execution-token"
            r="5"
            visibility="hidden"
          />
        </svg>
      </div>
      <div ref={minimapRef} className="journey-x6-minimap" aria-hidden="true" />
      <div className="journey-x6-controls">
        <button
          type="button"
          aria-label="放大"
          onClick={() => graphRef.current?.zoom(0.1)}
        >
          +
        </button>
        <button
          type="button"
          aria-label="缩小"
          onClick={() => graphRef.current?.zoom(-0.1)}
        >
          −
        </button>
        <button
          type="button"
          aria-label="适应画布"
          onClick={() =>
            graphRef.current?.zoomToFit({
              padding: 40,
              minScale: 0.2,
              maxScale: 1.1,
            })
          }
        >
          全图
        </button>
      </div>
    </>
  );
}
