import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  MarkerType,
  useInternalNode,
  type EdgeProps,
} from '@xyflow/react';
import type { FlowEdge, FlowNodeData } from './journey-map-types.js';

/**
 * 工作地图边的交互重点是“这条线从哪里到哪里”。
 * React Flow 默认只把选中的边加深，复杂工作流里不够明显，所以选中后同时标出两端节点。
 */
export function JourneyFlowEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected = false,
  data,
}: EdgeProps<FlowEdge>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });

  const sourceTitle = (sourceNode?.data as FlowNodeData | undefined)?.title ?? source;
  const targetTitle = (targetNode?.data as FlowNodeData | undefined)?.title ?? target;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={MarkerType.ArrowClosed}
        className={selected ? 'journey-flow-edge-path journey-flow-edge-path-selected' : 'journey-flow-edge-path'}
      />

      <EdgeLabelRenderer>
        <div
          className={selected ? 'journey-flow-edge-label journey-flow-edge-label-selected nodrag nopan' : 'journey-flow-edge-label nodrag nopan'}
          style={{
            transform:
              'translate(-50%, -50%) translate('
              + labelX
              + 'px,'
              + (labelY + Number(data?.labelOffsetY ?? 0))
              + 'px)',
            pointerEvents: data?.onSelect ? 'all' : 'none',
          }}
          onClick={() => data?.onSelect?.(id)}
        >
          {selected ? (
            <span className="journey-flow-edge-route-summary">
              {sourceTitle} → {targetTitle}
            </span>
          ) : null}
          <span>{data?.outcome}</span>
          {data?.condition ? (
            <span className="journey-flow-edge-condition"> · {data.condition}</span>
          ) : null}
        </div>

        {selected ? (
          <>
            <div
              className="journey-flow-edge-endpoint journey-flow-edge-endpoint-source"
              style={{ transform: 'translate(-50%, -50%) translate(' + sourceX + 'px,' + sourceY + 'px)' }}
              aria-hidden="true"
            >
              <span>来源</span>
            </div>
            <div
              className="journey-flow-edge-endpoint journey-flow-edge-endpoint-target"
              style={{ transform: 'translate(-50%, -50%) translate(' + targetX + 'px,' + targetY + 'px)' }}
              aria-hidden="true"
            >
              <span>目标</span>
            </div>
          </>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}
