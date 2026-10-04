import {
  BaseEdge,
  EdgeText,
  getSmoothStepPath,
  MarkerType,
  type EdgeProps,
} from '@xyflow/react';
import type { FlowEdge } from './journey-map-types.js';

/**
 * 工作地图的自定义边。
 *
 * outcome（success / retry / rollback …）直接作为 SVG EdgeText 绘制在连线上，
 * 不再使用 HTML Tag / EdgeLabelRenderer。SVG 文本和 edge 共用 React Flow 的
 * 坐标系，因此平移、缩放时会一起变换，不会发生标签漂移。
 *
 * 方向只用闭合箭头表达。连接点 Handle 负责真正的连接，不额外绘制 source/target
 * 文案，避免一条线周围出现过多视觉标记。
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
  if (source === target) return null;

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });

  const outcome = String(data?.outcome ?? '').trim();
  const backwardRoute =
    targetX + 24 < sourceX
    || /(^|[-_\s])(retry|return|rollback|back|previous|prev|reopen|again)([-_\s]|$)/i.test(outcome)
    || /(重试|退回|回退|返回|回滚|重新)/.test(outcome);

  // sourcePosition=Right 时，边离开节点后先沿水平线走一小段。
  // 把 outcome 放在这一小段上，用户可以直接看到“这个出口走 success 还是 retry”。
  // 回退线也同样贴近 source，避免把文字放到绕行路径中间的大空白区域。
  const firstSegmentX = sourceX + Math.min(
    92,
    Math.max(36, Math.abs(targetX - sourceX) / 3),
  );
  const edgeLabelX = backwardRoute
    ? firstSegmentX
    : Math.max(firstSegmentX, labelX - 18);
  const edgeLabelY = backwardRoute
    ? sourceY + Number(data?.labelOffsetY ?? 0)
    : labelY + Number(data?.labelOffsetY ?? 0);

  return (
    <>
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

      {outcome ? (
        <EdgeText
          x={edgeLabelX}
          y={edgeLabelY}
          label={outcome}
          labelStyle={{
            fill: selected ? '#1677ff' : '#526174',
            fontSize: 10,
            fontWeight: 650,
            paintOrder: 'stroke',
            stroke: '#fff',
            strokeWidth: 4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }}
          className="journey-flow-edge-text nodrag nopan"
          pointerEvents={data?.onSelect ? 'all' : 'none'}
          onClick={() => data?.onSelect?.(id)}
        />
      ) : null}
    </>
  );
}
