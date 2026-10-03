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
 * 选中后用鲜明的蓝色 + 黄色 glow 强调整条边，并明确标出两端。
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
  // 工作地图不展示 self-loop。
  // 这类 route 即使存在于旧 Workflow Definition 中，也不应该污染画布。
  if (source === target) return null;

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
        className="journey-flow-edge-path"
        style={selected
          ? {
              stroke: '#1677ff',
              strokeWidth: 4,
              filter: 'drop-shadow(0 0 3px #ffd666) drop-shadow(0 0 7px rgba(255, 214, 102, 0.95))',
            }
          : undefined}
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
