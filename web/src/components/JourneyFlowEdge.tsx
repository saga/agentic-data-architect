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

  // 回退/重试等边通常会绕很远，React Flow 给出的路径中心点也会落在大片空白处。
  // 这种边的标签贴近起点第一段横线，避免出现截图里的“游离标签”。
  const outcome = String(data?.outcome ?? '').trim().toLowerCase();
  const backwardRoute =
    targetX + 24 < sourceX
    || /(^|[-_\s])(retry|return|rollback|back|previous|prev|reopen|again)([-_\s]|$)/.test(outcome)
    || /(重试|退回|回退|返回|回滚|重新)/.test(outcome);
  const displayLabelX = backwardRoute
    ? sourceX + Math.min(96, Math.max(48, Math.abs(targetX - sourceX) / 3))
    : labelX;
  const displayLabelY = backwardRoute
    ? sourceY + Number(data?.labelOffsetY ?? 0)
    : labelY + Number(data?.labelOffsetY ?? 0);

  return (
    <>
      {/* React Flow 官方推荐用 BaseEdge + markerEnd 表达方向；这里把箭头加大，
          同时在 source 端补一个小圆点，让“从哪里开始、到哪里结束”一眼可见。 */}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={{
          type: MarkerType.ArrowClosed,
          width: selected ? 18 : 16,
          height: selected ? 18 : 16,
          color: selected ? '#1677ff' : '#94a3b8',
        }}
        className="journey-flow-edge-path"
        style={selected
          ? {
              stroke: '#1677ff',
              strokeWidth: 4,
              filter: 'drop-shadow(0 0 3px #ffd666) drop-shadow(0 0 7px rgba(255, 214, 102, 0.95))',
            }
          : undefined}
      />
      <circle
        className="journey-flow-edge-source-dot"
        cx={sourceX}
        cy={sourceY}
        r={selected ? 4 : 3}
        fill={selected ? '#1677ff' : '#94a3b8'}
        stroke="#fff"
        strokeWidth={2}
      />

      <EdgeLabelRenderer>
        <div
          className={selected ? 'journey-flow-edge-label journey-flow-edge-label-selected nodrag nopan' : 'journey-flow-edge-label nodrag nopan'}
          style={{
            transform:
              'translate(-50%, -50%) translate('
              + displayLabelX
              + 'px,'
              + displayLabelY
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
              <span>源：{sourceTitle}</span>
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
