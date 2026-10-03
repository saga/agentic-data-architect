import React from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  MarkerType,
  useInternalNode,
  type EdgeProps,
} from '@xyflow/react';
import type { FlowEdge } from './journey-map-types.js';

/**
 * 自环（例如 needs-input -> 同一个步骤）不能使用普通 smooth-step 路径。
 * 否则回线会被节点自己盖住，看起来像断线。
 */
function selfLoopPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  nodeBottom: number | undefined,
): [string, number, number] {
  const gap = 28;
  const corner = 12;
  const right = sourceX + gap;
  const left = targetX - gap;
  const bottom = Math.max(
    nodeBottom ?? 0,
    Math.max(sourceY, targetY) + gap,
  ) + 24;

  const d = [
    'M', sourceX, sourceY,
    'L', right - corner, sourceY,
    'Q', right, sourceY, right, sourceY + corner,
    'L', right, bottom - corner,
    'Q', right, bottom, right - corner, bottom,
    'L', left + corner, bottom,
    'Q', left, bottom, left, bottom - corner,
    'L', left, targetY + corner,
    'Q', left, targetY, left + corner, targetY,
    'L', targetX, targetY,
  ].join(' ');

  return [d, (right + left) / 2, bottom];
}

/**
 * 自定义 Workflow edge。
 *
 * Edge 只负责：
 * - 根据 React Flow 提供的 source/target 坐标画线；
 * - 显示 outcome；
 * - 把点击 outcome 交给编辑器。
 *
 * “这条线应该去哪里”仍然来自 Workflow Definition，而不是这个组件。
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
  data,
}: EdgeProps<FlowEdge>) {
  const sourceNode = useInternalNode(source);
  const selfLoop = source === target;

  const nodeBottom = sourceNode
    ? sourceNode.internals.positionAbsolute.y + (sourceNode.measured.height ?? 0)
    : undefined;

  const [path, labelX, labelY] = selfLoop
    ? selfLoopPath(sourceX, sourceY, targetX, targetY, nodeBottom)
    : getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        borderRadius: 12,
      });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={MarkerType.ArrowClosed}
      />

      <EdgeLabelRenderer>
        <div
          className="journey-flow-edge-label nodrag nopan"
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
          {data?.outcome}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
