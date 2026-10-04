import { useEffect, useRef, useCallback } from 'react';
import {
  Graph,
  Keyboard,
  MiniMap,
  Selection,
  Snapline,
  type Edge,
  type Node,
} from '@antv/x6';
import type {
  FlowEdge,
  FlowNode,
} from './journey-map-types.js';
import { JOURNEY_X6_SHAPE } from './JourneyX6Node.js';
import type { GraphConnection } from './journey-map-graph.js';

export interface JourneyX6GraphProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedNodeId?: string;
  selectedEdgeId?: string;
  onNodeClick: (id: string) => void;
  onEdgeClick: (id: string) => void;
  onBlankClick: () => void;
  onNodeDragStart: () => void;
  onNodeMoved: (id: string, position: { x: number; y: number }) => void;
  onConnect: (connection: GraphConnection) => Promise<void>;
  onReconnect: (
    edgeId: string,
    connection: GraphConnection,
  ) => Promise<void>;
  onDeleteSelected: (cellId: string, kind: 'node' | 'edge') => void;
  onFitView?: () => void;
}

/**
 * X6 画布适配层。
 *
 * 这是整个工作地图唯一接触 X6 Graph API 的地方：
 * - Workflow Definition / FlowNode / FlowEdge 不包含 X6 对象；
 * - React 组件只把业务 graph 投影到 X6；
 * - 节点移动、连线、选择等交互再转换回业务事件。
 *
 * X6 3.x 原生提供 orth router、rounded connector、native edge labels、ports、
 * Selection、Snapline、MiniMap 和 zoomToFit，因此这里不再维护 React Flow 那套
 * viewport/handle/EdgeLabelRenderer 的补偿代码。
 */
export function JourneyX6Graph({
  nodes,
  edges,
  selectedNodeId,
  selectedEdgeId,
  onNodeClick,
  onEdgeClick,
  onBlankClick,
  onNodeDragStart,
  onNodeMoved,
  onConnect,
  onReconnect,
  onDeleteSelected,
  onFitView,
}: JourneyX6GraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const lastGraphStateRef = useRef<string>('');

  const renderGraph = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;

    graph.batchUpdate(() => {
      graph.clearCells();
      graph.addNodes(
        nodes.map((node) => ({
          id: node.id,
          shape: JOURNEY_X6_SHAPE,
          x: node.position.x,
          y: node.position.y,
          width: node.width ?? 236,
          height: node.height ?? 210,
          data: {
            ...node.data,
            selected: node.id === selectedNodeId,
          },
          ports: {
            groups: {
              input: {
                position: 'left',
                attrs: {
                  circle: {
                    r: 7,
                    magnet: 'passive',
                    fill: 'transparent',
                    stroke: 'transparent',
                    opacity: 0,
                  },
                },
              },
              output: {
                position: 'right',
                attrs: {
                  circle: {
                    r: 7,
                    magnet: true,
                    fill: 'transparent',
                    stroke: 'transparent',
                    opacity: 0,
                  },
                },
              },
            },
            items: [
              {
                id: '__in__',
                group: 'input',
              },
              ...node.data.sourceHandles.map((handle) => ({
                id: handle.id,
                group: 'output',
              })),
            ],
          },
        })),
      );

      graph.addEdges(
        edges.map((edge) => ({
          id: edge.id,
          shape: 'edge',
          source: {
            cell: edge.source,
            port: edge.sourceHandle,
            anchor: 'right',
          },
          target: {
            cell: edge.target,
            port: edge.targetHandle,
            anchor: 'left',
          },
          router: {
            name: 'orth',
            args: {
              padding: 24,
            },
          },
          connector: {
            name: 'rounded',
            args: {
              radius: 10,
            },
          },
          vertices: [],
          labels: [
            {
              attrs: {
                label: {
                  text: edge.data.outcome,
                  fill: '#65758b',
                  fontSize: 10,
                  fontWeight: 600,
                  pointerEvents: edge.data.onSelect ? 'auto' : 'none',
                },
              },
              position: {
                distance: 0.2,
                options: {
                  keepGradient: false,
                },
              },
            },
          ],
          attrs: {
            line: {
              stroke: edge.id === selectedEdgeId ? '#1677ff' : '#aab6c5',
              strokeWidth: edge.id === selectedEdgeId ? 3 : 1.8,
              strokeLinejoin: 'round',
              targetMarker: {
                name: 'block',
                width: edge.id === selectedEdgeId ? 10 : 8,
                height: edge.id === selectedEdgeId ? 7 : 6,
              },
            },
          },
          data: edge.data,
        })),
      );
    });

    graph.cleanSelection();

    if (selectedNodeId && graph.getCellById(selectedNodeId)) {
      graph.resetSelection(selectedNodeId);
    } else if (selectedEdgeId && graph.getCellById(selectedEdgeId)) {
      graph.resetSelection(selectedEdgeId);
    }

    requestAnimationFrame(() => {
      graph.zoomToFit({
        padding: 40,
        minScale: 0.2,
        maxScale: 1.1,
      });
    });
  }, [edges, nodes, selectedEdgeId, selectedNodeId]);

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
        args: [
          {
            color: '#dfe5ee',
            thickness: 1,
          },
        ],
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
        sourceAnchor: 'right',
        targetAnchor: 'left',
        sourceConnectionPoint: 'boundary',
        targetConnectionPoint: 'boundary',
        router: {
          name: 'orth',
          args: {
            padding: 24,
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
                targetMarker: 'block',
              },
            },
            data: {
              outcome: 'branch',
            },
          });
        },
        validateConnection({ sourceCell, targetCell }: { sourceCell?: Node | null; targetCell?: Node | null }) {
          return Boolean(
            sourceCell
            && targetCell
            && sourceCell.isNode()
            && targetCell.isNode()
            && sourceCell.id !== targetCell.id,
          );
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
    graph.use(new Keyboard({ enabled: true, global: true }));

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
      graph.resetSelection(node);
      onNodeClick(node.id);
    });

    graph.on('edge:click', ({ edge }) => {
      graph.resetSelection(edge);
      onEdgeClick(edge.id);
    });

    graph.on('blank:click', () => {
      graph.cleanSelection();
      onBlankClick();
    });

    graph.on('node:move', () => {
      onNodeDragStart();
    });

    graph.on('node:moved', ({ node }) => {
      const position = node.position();
      onNodeMoved(node.id, position);
    });

    graph.on('edge:connected', async ({
      edge,
      isNew,
      previousPort,
      currentPort,
    }) => {
      const source = edge.getSourceCell();
      const target = edge.getTargetCell();
      if (!source?.isNode() || !target?.isNode()) {
        edge.remove();
        return;
      }

      const sourceTerminal = edge.getSource();
      const targetTerminal = edge.getTarget();

      const connection: GraphConnection = {
        source: source.id,
        target: target.id,
        ...(typeof sourceTerminal.port === 'string'
          ? { sourcePort: sourceTerminal.port }
          : {}),
        ...(typeof targetTerminal.port === 'string'
          ? { targetPort: targetTerminal.port }
          : {}),
      };

      if (isNew) {
        await onConnect(connection);
      } else if (previousPort !== currentPort || source.id || target.id) {
        await onReconnect(edge.id, connection);
      }
    });

    graph.bindKey(['delete', 'backspace'], () => {
      const selected = graph.getSelectedCells();
      for (const cell of selected) {
        onDeleteSelected(cell.id, cell.isEdge() ? 'edge' : 'node');
      }
      graph.cleanSelection();
    });

    graphRef.current = graph;

    return () => {
      graph.dispose();
      graphRef.current = null;
    };
  }, [
    onBlankClick,
    onConnect,
    onDeleteSelected,
    onEdgeClick,
    onNodeClick,
    onNodeDragStart,
    onNodeMoved,
    onReconnect,
  ]);

  useEffect(() => {
    const signature = JSON.stringify({
      nodes: nodes.map((node) => ({
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        data: {
          ...node.data,
          // 函数引用不应该触发 X6 重建。
          onAddStep: undefined,
          onAddBranch: undefined,
          onDelete: undefined,
        },
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        data: edge.data
          ? {
              outcome: edge.data.outcome,
              condition: edge.data.condition,
            }
          : undefined,
      })),
      selectedNodeId,
      selectedEdgeId,
    });

    if (signature === lastGraphStateRef.current) return;
    lastGraphStateRef.current = signature;

    renderGraph();
  }, [edges, nodes, renderGraph, selectedEdgeId, selectedNodeId]);

  useEffect(() => {
    onFitView?.();
  }, [onFitView]);

  return (
    <>
      <div ref={containerRef} className="journey-x6-graph-container" />
      <div ref={minimapRef} className="journey-x6-minimap" />
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
