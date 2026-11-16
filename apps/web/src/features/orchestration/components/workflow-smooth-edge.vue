<script setup lang="ts">
import { computed } from "vue";
import { BaseEdge, Position, getSmoothStepPath, type EdgeProps } from "@vue-flow/core";
import type { WorkflowRoutePoint } from "./workflow-auto-layout";
import { resolveAnchorX, resolveAnchorY, type WorkflowEdgeAnchorLayout } from "./workflow-edge-layout";

defineOptions({ name: "WorkflowSmoothEdge" });

const props = defineProps<EdgeProps>();
const WORKFLOW_EDGE_PATH_OPTIONS = Object.freeze({
  offset: 24,
  borderRadius: 16,
});
const EDGE_ROUTE_CORNER_RADIUS = 14;

type NodeBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

const pathState = computed(() => {
  const routedPath = resolveRoutedPathState(props.data);
  if (routedPath) return routedPath;

  const sourceBounds = resolveNodeBounds(props.sourceNode, props.sourceX, props.sourceY);
  const targetBounds = resolveNodeBounds(props.targetNode, props.targetX, props.targetY);
  const anchorLayout = resolveAnchorLayout(sourceBounds, targetBounds, props.data);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: resolveAnchorX(
      sourceBounds,
      anchorLayout.sourcePosition,
      anchorLayout.sourceSlotIndex,
      anchorLayout.sourceSlotCount,
    ),
    sourceY: resolveAnchorY(
      sourceBounds,
      anchorLayout.sourcePosition,
      anchorLayout.sourceSlotIndex,
      anchorLayout.sourceSlotCount,
    ),
    sourcePosition: anchorLayout.sourcePosition,
    targetX: resolveAnchorX(
      targetBounds,
      anchorLayout.targetPosition,
      anchorLayout.targetSlotIndex,
      anchorLayout.targetSlotCount,
    ),
    targetY: resolveAnchorY(
      targetBounds,
      anchorLayout.targetPosition,
      anchorLayout.targetSlotIndex,
      anchorLayout.targetSlotCount,
    ),
    targetPosition: anchorLayout.targetPosition,
    ...WORKFLOW_EDGE_PATH_OPTIONS,
  });
  return {
    path,
    labelX,
    labelY,
  };
});

function resolveNodeBounds(
  node: EdgeProps["sourceNode"] | EdgeProps["targetNode"],
  fallbackX: number,
  fallbackY: number,
): NodeBounds {
  const width = Number(node?.dimensions?.width ?? 0);
  const height = Number(node?.dimensions?.height ?? 0);
  const x = Number(node?.computedPosition?.x ?? fallbackX - width / 2);
  const y = Number(node?.computedPosition?.y ?? fallbackY - height / 2);
  const centerX = width > 0 ? x + width / 2 : fallbackX;
  const centerY = height > 0 ? y + height / 2 : fallbackY;
  return {
    x,
    y,
    width,
    height,
    centerX,
    centerY,
  };
}

function resolveAnchorPositions(
  sourceBounds: NodeBounds,
  targetBounds: NodeBounds,
): { sourcePosition: Position; targetPosition: Position } {
  const deltaX = targetBounds.centerX - sourceBounds.centerX;
  const deltaY = targetBounds.centerY - sourceBounds.centerY;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return deltaX >= 0
      ? { sourcePosition: Position.Right, targetPosition: Position.Left }
      : { sourcePosition: Position.Left, targetPosition: Position.Right };
  }
  return deltaY >= 0
    ? { sourcePosition: Position.Bottom, targetPosition: Position.Top }
    : { sourcePosition: Position.Top, targetPosition: Position.Bottom };
}

function resolveAnchorLayout(
  sourceBounds: NodeBounds,
  targetBounds: NodeBounds,
  data: EdgeProps["data"],
): WorkflowEdgeAnchorLayout {
  const storedLayout = (data as { anchorLayout?: WorkflowEdgeAnchorLayout } | undefined)?.anchorLayout;
  if (storedLayout) return storedLayout;
  const { sourcePosition, targetPosition } = resolveAnchorPositions(sourceBounds, targetBounds);
  return {
    sourcePosition,
    targetPosition,
    sourceSlotIndex: 0,
    sourceSlotCount: 1,
    targetSlotIndex: 0,
    targetSlotCount: 1,
  };
}

function resolveRoutedPathState(data: EdgeProps["data"]): { path: string; labelX: number; labelY: number } | null {
  const points = normalizeRoutePoints(data);
  if (!points) return null;
  return {
    path: buildRoundedPolylinePath(points),
    ...resolvePolylineLabelPoint(points),
  };
}

function normalizeRoutePoints(data: EdgeProps["data"]): null | WorkflowRoutePoint[] {
  const rawPoints = (data as { routePoints?: WorkflowRoutePoint[] } | undefined)?.routePoints;
  if (!Array.isArray(rawPoints) || rawPoints.length < 2) return null;
  const points = rawPoints
    .map((point) => ({
      x: Number(point?.x ?? NaN),
      y: Number(point?.y ?? NaN),
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  return points.length >= 2 ? points : null;
}

function buildRoundedPolylinePath(points: WorkflowRoutePoint[]): string {
  if (points.length < 2) return "";
  let path = `M${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    if (!next) {
      path += `L${current.x} ${current.y}`;
      continue;
    }

    const incomingDistance = distanceBetween(previous, current);
    const outgoingDistance = distanceBetween(current, next);
    if (incomingDistance <= 0 || outgoingDistance <= 0) continue;

    const cornerRadius = Math.min(
      EDGE_ROUTE_CORNER_RADIUS,
      incomingDistance / 2,
      outgoingDistance / 2,
    );
    const entry = movePointTowards(current, previous, cornerRadius);
    const exit = movePointTowards(current, next, cornerRadius);
    path += `L${entry.x} ${entry.y}Q${current.x} ${current.y} ${exit.x} ${exit.y}`;
  }
  return path;
}

function resolvePolylineLabelPoint(points: WorkflowRoutePoint[]): { labelX: number; labelY: number } {
  const segments = points
    .slice(1)
    .map((point, index) => ({
      start: points[index],
      end: point,
      length: distanceBetween(points[index], point),
    }))
    .filter((segment) => segment.length > 0);
  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (totalLength <= 0) {
    const middle = points[Math.floor(points.length / 2)] ?? points[0];
    return { labelX: middle.x, labelY: middle.y };
  }

  const targetLength = totalLength / 2;
  let traversed = 0;
  for (const segment of segments) {
    if (traversed + segment.length >= targetLength) {
      const ratio = (targetLength - traversed) / segment.length;
      return {
        labelX: segment.start.x + (segment.end.x - segment.start.x) * ratio,
        labelY: segment.start.y + (segment.end.y - segment.start.y) * ratio,
      };
    }
    traversed += segment.length;
  }

  const tail = points.at(-1) ?? points[0];
  return { labelX: tail.x, labelY: tail.y };
}

function movePointTowards(
  origin: WorkflowRoutePoint,
  target: WorkflowRoutePoint,
  distance: number,
): WorkflowRoutePoint {
  const deltaX = target.x - origin.x;
  const deltaY = target.y - origin.y;
  const length = Math.hypot(deltaX, deltaY) || 1;
  return {
    x: origin.x + (deltaX / length) * distance,
    y: origin.y + (deltaY / length) * distance,
  };
}

function distanceBetween(left: WorkflowRoutePoint, right: WorkflowRoutePoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}
</script>

<template>
  <BaseEdge
    :id="id"
    :path="pathState.path"
    :style="style"
    :label="label"
    :label-x="pathState.labelX"
    :label-y="pathState.labelY"
    :marker-start="markerStart"
    :marker-end="markerEnd"
    :interaction-width="interactionWidth"
    :label-style="labelStyle"
    :label-show-bg="labelShowBg"
    :label-bg-style="labelBgStyle"
    :label-bg-padding="labelBgPadding"
    :label-bg-border-radius="labelBgBorderRadius"
  />
</template>
