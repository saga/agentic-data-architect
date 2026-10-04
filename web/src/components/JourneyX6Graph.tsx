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
}

/**
 * AntV X6 画布适配层。
 *
 * 这里是工作地图唯一直接操作 X6 Graph 的地方：
 * Workflow Definition / FlowNode / FlowEdge 仍然是业务模型，
 * X6 只负责节点、Port、Edge、缩放、选择和连线交互。
 *
 * 特别重要：
 * - outcome 是 X6 Port Label，而不是悬浮 HTML 标签；
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
}: JourneyX6GraphProps) {
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
          retryGroupIds: node.data.retryGroupIds ?? [],
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
   * - retry：不再创建可见 Port，改用画布上的 retry group。
   *
   * X6 自带 top/right/bottom/left 均匀分布 Port 的布局能力，
   * 不需要自己计算每个 Port 的像素位置。
   */
  const buildPorts = (node: FlowNode) => {
    const terminal =
      node.data.nodeType === 'end' || node.data.nodeType === 'stop';
    const size = terminal
      ? JOURNEY_NODE_SIZE.terminal
      : JOURNEY_NODE_SIZE.regular;

    const visibleSources = node.data.sourceHandles.filter(
      (handle) => handle.kind !== 'retry',
    );
    const visibleTargets = node.data.targetHandles.filter(
      (handle) => handle.kind !== 'retry',
    );

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
          position: {
            name: 'absolute',
            args: { x: '50%', y: 0 },
          },
          attrs: {
            circle: {
              r: 8,
              magnet: 'passive',
              fill: 'transparent',
              stroke: 'transparent',
              opacity: 0,
            },
          },
        },
        newOutput: {
          position: {
            name: 'absolute',
            args: { x: '50%', y: size.height },
          },
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

    const visibleEdges = edges.filter(
      (edge) => (edge.data?.kind ?? classifyJourneyEdge(edge.data?.outcome)) !== 'retry',
    );

    const retryGroupMap = new Map<string, FlowNode[]>();
    for (const node of nodes) {
      for (const groupId of node.data.retryGroupIds ?? []) {
        retryGroupMap.set(groupId, [
          ...(retryGroupMap.get(groupId) ?? []),
          node,
        ]);
      }
    }

    const retryGroups = [...retryGroupMap.entries()].map(([id, members]) => {
      const minX = Math.min(...members.map((node) => node.position.x));
      const minY = Math.min(...members.map((node) => node.position.y));
      const maxX = Math.max(
        ...members.map(
          (node) =>
            node.position.x
            + (node.width
              ?? (node.data.nodeType === 'end' || node.data.nodeType === 'stop'
                ? JOURNEY_NODE_SIZE.terminal.width
                : JOURNEY_NODE_SIZE.regular.width)),
        ),
      );
      const maxY = Math.max(
        ...members.map(
          (node) =>
            node.position.y
            + (node.height
              ?? (node.data.nodeType === 'end' || node.data.nodeType === 'stop'
                ? JOURNEY_NODE_SIZE.terminal.height
                : JOURNEY_NODE_SIZE.regular.height)),
        ),
      );

      return {
        id,
        shape: 'rect',
        x: minX - 28,
        y: minY - 28,
        width: maxX - minX + 56,
        height: maxY - minY + 56,
        zIndex: 0,
        attrs: {
          body: {
            rx: 18,
            ry: 18,
            fill: '#f5f7fa',
            fillOpacity: 0.58,
            stroke: '#9aa8b8',
            strokeWidth: 1.5,
            strokeDasharray: '8 6',
            pointerEvents: 'none',
          },
          label: {
            text: '',
          },
        },
        data: {
          retryGroup: true,
          retryGroupId: id,
        },
      };
    });

    graph.batchUpdate(() => {
      graph.clearCells();

      graph.addNodes(retryGroups);

      graph.addNodes(
        nodes.map((node) => ({
          id: node.id,
          shape: JOURNEY_X6_SHAPE,
          x: node.position.x,
          y: node.position.y,
          width: node.width ?? (
            node.data.nodeType === 'end' || node.data.nodeType === 'stop'
              ? JOURNEY_NODE_SIZE.terminal.width
              : JOURNEY_NODE_SIZE.regular.width
          ),
          height: node.height ?? (
            node.data.nodeType === 'end' || node.data.nodeType === 'stop'
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

          const style = {
            success: {
              stroke: '#52c41a',
              opacity: 0.82,
            },
            fail: {
              stroke: '#ff4d4f',
              opacity: 0.86,
            },
            other: {
              stroke: '#9aa7b7',
              opacity: 0.66,
            },
            retry: {
              stroke: '#9aa7b7',
              opacity: 0,
            },
          }[kind];

          const edgeConfig = {
            id: edge.id,
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
        || JSON.stringify(data.retryGroupIds ?? []) !== JSON.stringify(node.data.retryGroupIds ?? [])
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
      const kind: JourneyEdgeKind =
        edge.data?.kind ?? classifyJourneyEdge(edge.data?.outcome);
      if (kind === 'retry') {
        cell.setVisible(false);
        continue;
      }

      const stroke =
        kind === 'success'
          ? '#52c41a'
          : kind === 'fail'
            ? '#ff4d4f'
            : '#9aa7b7';

      cell.setVisible(true);
      cell.attr('line/stroke', stroke);
      cell.attr('line/strokeOpacity', selected ? 1 : kind === 'success' ? 0.82 : kind === 'fail' ? 0.86 : 0.66);
      cell.attr('line/strokeWidth', selected ? 3 : 2);
      cell.attr('line/targetMarker', {
        name: 'block',
        width: selected ? 10 : 8,
        height: selected ? 7 : 6,
        fill: stroke,
        stroke,
      });
    }

  }, [nodes, edges, selectedNodeId, selectedEdgeId]);

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
      <div ref={containerRef} className="journey-x6-graph-container" />
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
