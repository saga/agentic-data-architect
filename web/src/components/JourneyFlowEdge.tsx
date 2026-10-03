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
 * 不再使用 EdgeLabelRenderer + HTML 标签。这样标签天然跟随 React Flow 的 edge
 * 坐标和 viewport 一起缩放、平移，不会出现 zoom 后“飞走”的问题。
 *
 * 方向只用箭头表达：
 * - 起点：线本身从 source handle 发出；
 * - 终点：闭合箭头；
 * - outcome：贴在线的第一段附近，避免和节点正文混在一起。
 */
export function JourneyFlowEdge({
  id,
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
  if (data && typeof data === 'object' && data.outcome === '__self__') return null;

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

  // React Flow 自带 EdgeText 使用 SVG 坐标，标签与 edge 永远处在同一个 viewport 变换里。
  // 对正常前进线，把文字放在靠近 source 的第一段水平线附近；回退线同样贴近 source，
  // 不让标签跑到大段绕线路径的空白区域。
  const firstSegmentX = sourceX + Math.min(92, Math.max(36, Math.abs(targetX - sourceX) / 3));
  const edgeLabelX = backwardRoute ? firstSegmentX : Math.max(firstSegmentX, labelX - 18);
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
            fontWeight: 600,
          }}
          labelShowBg
          labelBgStyle={{
            fill: '#fff',
            fillOpacity: 0.92,
            stroke: selected ? '#91caff' : '#d9e1ec',
            strokeWidth: 1,
          }}
          labelBgPadding={[3, 5]}
          labelBgBorderRadius={5}
          className="journey-flow-edge-text"
          pointerEvents={data?.onSelect ? 'all' : 'none'}
          onClick={() => data?.onSelect?.(id)}
        />
      ) : null}
    </>
  );
}
