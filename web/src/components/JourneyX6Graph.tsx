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
} from './journey-map-types.js';
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
          })),
          targetHandles: node.data.targetHandles.map((handle) => handle.id),
        })),
        edges: edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
        })),
      }),
    [nodes, edges],
  );

  /**
   * 构造一个节点的 X6 Port。
   *
   * X6 原生支持 Port Label，并提供 right/outside 等定位算法：
   * success / retry / need-input 因此成为“出口自己的标签”，
   * 而不是 EdgeLabelRenderer 那种独立悬浮元素。
   */
  const buildPorts = (node: FlowNode) => {
    const terminal =
      node.data.nodeType === 'end' || node.data.nodeType === 'stop';
    const size = terminal
      ? JOURNEY_NODE_SIZE.terminal
      : JOURNEY_NODE_SIZE.regular;
    const newPortY = size.height - 18;

    return {
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
        label: {
          position: {
            name: 'right',
            args: {
              x: 7,
              attrs: {
                text: {
                  fill: '#69788b',
                  fontSize: 10,
                  fontWeight: 600,
                },
              },
            },
          },
        },
      },
      newInput: {
        position: {
          name: 'absolute',
          args: { x: 0, y: newPortY },
        },
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
      newOutput: {
        position: {
          name: 'absolute',
          args: { x: size.width, y: newPortY },
        },
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
      ...node.data.targetHandles.map((handle) => ({
        id: handle.id,
        group: 'input',
      })),
      {
        id: NEW_TARGET_HANDLE_ID,
        group: 'newInput',
      },
      ...node.data.sourceHandles.map((handle) => ({
        id: handle.id,
        group: 'output',
        attrs: {
          text: {
            text: handle.label,
          },
        },
      })),
      ...(node.data.nodeType === 'end' || node.data.nodeType === 'stop'
        ? []
        : [
            {
              // 单独提供一个透明的“新分支”出口。它不是 Workflow route，
              // 所以不会出现在属性面板或人工 transition 选项里。
              id: NEW_SOURCE_HANDLE_ID,
              group: 'newOutput',
              attrs: {
                text: {
                  text: '',
                },
              },
            },
          ]),
    ],
    };
  };

  /** 给 X6 添加完整业务 graph。 */
  const rebuildGraphStructure = () => {
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
          ports: buildPorts(node),
        })),
      );

      graph.addEdges(
        edges.map((edge) => {
          const sourceNode = nodes.find((node) => node.id === edge.source);
          const targetNode = nodes.find((node) => node.id === edge.target);
          const backward =
            sourceNode && targetNode
              ? targetNode.position.x <= sourceNode.position.x
              : false;
          const selected = edge.id === selectedEdgeId;

          const backwardIndex = edges
            .slice(0, edges.indexOf(edge))
            .filter((item) => {
              const source = nodes.find((node) => node.id === item.source);
              const target = nodes.find((node) => node.id === item.target);
              return Boolean(source && target && target.position.x <= source.position.x);
            }).length;

          const minY = Math.min(...nodes.map((node) => node.position.y));
          const maxY = Math.max(
            ...nodes.map(
              (node) =>
                node.position.y
                + (node.height ?? JOURNEY_NODE_SIZE.regular.height),
            ),
          );

          const edgeConfig: Record<string, unknown> = {
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
              args: { radius: 10 },
            },
            labels: [],
            attrs: {
              line: {
                stroke: selected ? '#1677ff' : backward ? '#8b98a8' : '#99a6b5',
                strokeWidth: selected ? 2.8 : 1.8,
                strokeLinejoin: 'round',
                strokeLinecap: 'round',
                ...(backward ? { strokeDasharray: '6 4', opacity: 0.78 } : {}),
                targetMarker: {
                  name: 'block',
                  width: selected ? 10 : 8,
                  height: selected ? 7 : 6,
                },
              },
            },
            data: edge.data,
          };

          if (backward) {
            const useBottom = backwardIndex % 2 === 1;
            const laneIndex = Math.floor(backwardIndex / 2);
            const lane = useBottom
              ? maxY + 56 + laneIndex * 30
              : minY - 56 - laneIndex * 30;

            const sourceX =
              (sourceNode?.position.x ?? 0)
              + (sourceNode?.width ?? JOURNEY_NODE_SIZE.regular.width)
              + 28;
            const targetX = (targetNode?.position.x ?? 0) - 28;

            Object.assign(edgeConfig, {
              vertices: [
                { x: sourceX, y: lane },
                { x: targetX, y: lane },
              ],
              router: {
                name: 'orth',
                args: { padding: 18 },
              },
            });
          } else {
            Object.assign(edgeConfig, {
              router: {
                name: 'manhattan',
                args: {
                  step: 16,
                  padding: 18,
                  startDirections: ['right'],
                  endDirections: ['left'],
                },
              },
            });
          }

          return edgeConfig;
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
      cell.attr(
        'line/stroke',
        selected ? '#1677ff' : '#aab6c5',
      );
      cell.attr(
        'line/strokeWidth',
        selected ? 3 : 1.8,
      );
      cell.attr(
        'line/targetMarker',
        {
          name: 'block',
          width: selected ? 10 : 8,
          height: selected ? 7 : 6,
        },
      );
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
