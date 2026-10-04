import {
  BaseEdge,
  getSmoothStepPath,
  MarkerType,
  type EdgeProps,
} from '@xyflow/react';
import type { FlowEdge } from './journey-map-types.js';

/**
 * 工作地图的自定义边。
 *
 * 连线只负责表达“从这里到那里”：
 * - source：透明 Handle，避免画布上出现突兀的连接圆点；
 * - target：闭合箭头；
 * - outcome（success / need-input / retry …）不再画在 edge 上。
 *
 * outcome 改为紧贴 source Handle 显示在节点边缘，避免 EdgeLabelRenderer / EdgeText
 * 在缩放、复杂折线路径和回边场景下产生漂移、遮挡或“飞掉”的视觉问题。
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
}: EdgeProps<FlowEdge>) {
  // 工作地图不展示 self-loop。
  if (source === target) return null;

  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });

  return (
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
  );
}
