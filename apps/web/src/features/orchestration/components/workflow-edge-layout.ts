import { Position, type Edge } from "@vue-flow/core";

import type { WorkflowRoutePoint } from "./workflow-auto-layout";

export type WorkflowEdgeAnchorLayout = {
  sourcePosition: Position;
  targetPosition: Position;
  sourceSlotIndex: number;
  sourceSlotCount: number;
  targetSlotIndex: number;
  targetSlotCount: number;
};

type NodePositionLike = {
  id: string;
  position?: {
    x?: number | null;
    y?: number | null;
  } | null;
  /** 节点类型：开始/结束的 bbox 是正方形而非卡片矩形，尺寸要按类型解析。 */
  type?: string | null;
};

/** 节点尺寸：固定值适用于全图同尺寸；节点类型尺寸不同时传解析函数。 */
export type WorkflowNodeSizeSpec =
  | { width: number; height: number }
  | ((node: NodePositionLike) => { width: number; height: number });

type NodeBounds = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

/** 锚点在卡片边上的最小留白比例，保证同一侧的多个锚点不贴上角。 */
export const EDGE_SLOT_PADDING_RATIO = 0.18;
/** 绕行通道与卡片边缘的间距。 */
const DETOUR_GAP = 26;
/** 相邻两条绕行通道之间的间距。 */
const DETOUR_LANE_GAP = 22;
/** 离开锚点后先直行一小段再转向，避免折线压在卡片边框上。 */
const DETOUR_STUB = 16;

type EdgeEndpointKind = "source" | "target";

type EndpointGroupEntry = {
  edgeId: string;
  endpoint: EdgeEndpointKind;
  sortValue: number;
};

const DISTRIBUTABLE_SIDES = new Set<Position>([
  Position.Left,
  Position.Right,
  Position.Top,
  Position.Bottom,
]);

export function withWorkflowEdgeAnchorLayout<T extends Edge>(
  edges: T[],
  nodes: NodePositionLike[],
  nodeSize: WorkflowNodeSizeSpec,
): T[] {
  if (edges.length === 0) return edges;

  const boundsByNodeId = new Map<string, NodeBounds>();
  for (const node of nodes) {
    boundsByNodeId.set(node.id, normalizeNodeBounds(node, nodeSize));
  }

  const layoutByEdgeId = new Map<string, WorkflowEdgeAnchorLayout>();
  const endpointGroups = new Map<string, EndpointGroupEntry[]>();

  for (const edge of edges) {
    const sourceBounds = boundsByNodeId.get(edge.source);
    const targetBounds = boundsByNodeId.get(edge.target);
    const anchorLayout = resolveAnchorLayout(sourceBounds, targetBounds);
    layoutByEdgeId.set(edge.id, anchorLayout);

    if (!sourceBounds || !targetBounds) continue;

    registerEndpointGroup(
      endpointGroups,
      edge.id,
      "source",
      sourceBounds.id,
      anchorLayout.sourcePosition,
      sortValueForSide(anchorLayout.sourcePosition, targetBounds),
    );
    registerEndpointGroup(
      endpointGroups,
      edge.id,
      "target",
      targetBounds.id,
      anchorLayout.targetPosition,
      sortValueForSide(anchorLayout.targetPosition, sourceBounds),
    );
  }

  for (const group of endpointGroups.values()) {
    group.sort((left, right) => left.sortValue - right.sortValue || left.edgeId.localeCompare(right.edgeId));
    const slotCount = group.length;
    group.forEach((entry, slotIndex) => {
      const layout = layoutByEdgeId.get(entry.edgeId);
      if (!layout) return;
      if (entry.endpoint === "source") {
        layout.sourceSlotIndex = slotIndex;
        layout.sourceSlotCount = slotCount;
        return;
      }
      layout.targetSlotIndex = slotIndex;
      layout.targetSlotCount = slotCount;
    });
  }

  return edges.map((edge) => {
    const anchorLayout = layoutByEdgeId.get(edge.id);
    if (!anchorLayout) return edge;
    const data = isRecord(edge.data) ? edge.data : {};
    return {
      ...edge,
      data: {
        ...data,
        anchorLayout,
      },
    };
  });
}

/** 解析单个节点的 bbox 尺寸；固定值直接复用，函数按节点类型给出。 */
function resolveNodeSize(
  node: NodePositionLike,
  nodeSize: WorkflowNodeSizeSpec,
): { width: number; height: number } {
  return typeof nodeSize === "function" ? nodeSize(node) : nodeSize;
}

function normalizeNodeBounds(
  node: NodePositionLike,
  nodeSize: WorkflowNodeSizeSpec,
): NodeBounds {
  const size = resolveNodeSize(node, nodeSize);
  const width = Number(size.width || 0);
  const height = Number(size.height || 0);
  const x = Number(node.position?.x ?? 0);
  const y = Number(node.position?.y ?? 0);
  return {
    id: node.id,
    x,
    y,
    width,
    height,
    centerX: x + width / 2,
    centerY: y + height / 2,
  };
}

function resolveAnchorLayout(
  sourceBounds: NodeBounds | undefined,
  targetBounds: NodeBounds | undefined,
): WorkflowEdgeAnchorLayout {
  const { sourcePosition, targetPosition } =
    sourceBounds && targetBounds
      ? resolveAnchorPositions(sourceBounds, targetBounds)
      : { sourcePosition: Position.Bottom, targetPosition: Position.Top };
  return {
    sourcePosition,
    targetPosition,
    sourceSlotIndex: 0,
    sourceSlotCount: 1,
    targetSlotIndex: 0,
    targetSlotCount: 1,
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

function registerEndpointGroup(
  groups: Map<string, EndpointGroupEntry[]>,
  edgeId: string,
  endpoint: EdgeEndpointKind,
  nodeId: string,
  side: Position,
  sortValue: number,
): void {
  if (!DISTRIBUTABLE_SIDES.has(side)) return;
  const groupKey = `${nodeId}:${side}`;
  const group = groups.get(groupKey) ?? [];
  group.push({
    edgeId,
    endpoint,
    sortValue,
  });
  groups.set(groupKey, group);
}

function sortValueForSide(side: Position, oppositeBounds: NodeBounds): number {
  if (side === Position.Left || side === Position.Right) return oppositeBounds.centerY;
  return oppositeBounds.centerX;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 卡片边上的锚点横坐标；上下边按槽位比例取点。 */
export function resolveAnchorX(
  bounds: Pick<NodeBounds, "x" | "width">,
  position: Position,
  slotIndex: number,
  slotCount: number,
): number {
  if (position === Position.Left) return bounds.x;
  if (position === Position.Right) return bounds.x + bounds.width;
  return bounds.x + bounds.width * resolveSlotRatio(slotIndex, slotCount);
}

/** 卡片边上的锚点纵坐标；左右边按槽位比例取点。 */
export function resolveAnchorY(
  bounds: Pick<NodeBounds, "y" | "height">,
  position: Position,
  slotIndex: number,
  slotCount: number,
): number {
  if (position === Position.Top) return bounds.y;
  if (position === Position.Bottom) return bounds.y + bounds.height;
  return bounds.y + bounds.height * resolveSlotRatio(slotIndex, slotCount);
}

function resolveSlotRatio(slotIndex: number, slotCount: number): number {
  if (!Number.isFinite(slotCount) || slotCount <= 1) return 0.5;
  const normalizedCount = Math.max(1, Math.round(slotCount));
  const normalizedIndex = Math.min(Math.max(0, Math.round(slotIndex)), normalizedCount - 1);
  const usableSpan = 1 - EDGE_SLOT_PADDING_RATIO * 2;
  return EDGE_SLOT_PADDING_RATIO + ((normalizedIndex + 0.5) * usableSpan) / normalizedCount;
}

type DetourPlan = {
  edgeId: string;
  orientation: "horizontal" | "vertical";
  source: WorkflowRoutePoint;
  target: WorkflowRoutePoint;
  /** 通道基准坐标：水平流为 y，垂直流为 x。 */
  rail: number;
  /** 主轴占用区间，用于给互不相交的绕行线分配不同通道。 */
  spanStart: number;
  spanEnd: number;
  lane: number;
};

/**
 * 边几何的统一入口：先按节点位置定锚点，再给跨越型直连补绕行折线。
 * 两件事必须成对使用——绕行折线的起止点就是锚点，分开调用会让线头离开卡片。
 */
export function withWorkflowEdgeRouting<T extends Edge>(
  edges: T[],
  nodes: NodePositionLike[],
  nodeSize: WorkflowNodeSizeSpec,
): T[] {
  return withWorkflowEdgeDetourRoutes(
    withWorkflowEdgeAnchorLayout(edges, nodes, nodeSize),
    nodes,
    nodeSize,
  );
}

/**
 * 给会横穿其它卡片的直连边补一条绕行折线。
 *
 * 背景：只有点过自动布局的边才带 ELK 正交路由（`routePoints`）；拖动节点会清掉它，
 * 之后边退回 `getSmoothStepPath`——那条路径不看卡片，跨节点的直连会直接穿过去。
 * 这里只处理这种回退边：直连段压到别的卡片时，走卡片外一条通道绕行。
 * 已经有 `routePoints` 的边保持不动，避免覆盖质量更高的自动布局结果。
 */
function withWorkflowEdgeDetourRoutes<T extends Edge>(
  edges: T[],
  nodes: NodePositionLike[],
  nodeSize: WorkflowNodeSizeSpec,
): T[] {
  if (edges.length === 0) return edges;

  const boundsByNodeId = new Map<string, NodeBounds>();
  for (const node of nodes) boundsByNodeId.set(node.id, normalizeNodeBounds(node, nodeSize));
  const allBounds = Array.from(boundsByNodeId.values());

  const plans: DetourPlan[] = [];
  for (const edge of edges) {
    if (hasStoredRoutePoints(edge)) continue;
    const plan = planEdgeDetour(edge, boundsByNodeId, allBounds);
    if (plan) plans.push(plan);
  }
  if (plans.length === 0) return edges;

  assignDetourLanes(plans);
  const pointsByEdgeId = new Map(
    plans.map((plan) => [plan.edgeId, buildDetourPoints(plan)] as const),
  );
  return edges.map((edge) => {
    const routePoints = pointsByEdgeId.get(edge.id);
    if (!routePoints) return edge;
    const data = isRecord(edge.data) ? edge.data : {};
    return { ...edge, data: { ...data, routePoints } };
  });
}

/** 已带自动布局路由的边不再改写。 */
function hasStoredRoutePoints(edge: Edge): boolean {
  const stored = isRecord(edge.data) ? (edge.data as { routePoints?: unknown }).routePoints : null;
  return Array.isArray(stored) && stored.length >= 2;
}

/** 计算单条边的绕行方案；不需要绕行时返回 null。 */
function planEdgeDetour(
  edge: Edge,
  boundsByNodeId: Map<string, NodeBounds>,
  allBounds: NodeBounds[],
): DetourPlan | null {
  const sourceBounds = boundsByNodeId.get(edge.source);
  const targetBounds = boundsByNodeId.get(edge.target);
  if (!sourceBounds || !targetBounds) return null;

  const anchorLayout = resolveStoredAnchorLayout(edge.data, sourceBounds, targetBounds);
  const orientation = resolveAnchorOrientation(anchorLayout);
  if (!orientation) return null;

  const source = {
    x: resolveAnchorX(sourceBounds, anchorLayout.sourcePosition, anchorLayout.sourceSlotIndex, anchorLayout.sourceSlotCount),
    y: resolveAnchorY(sourceBounds, anchorLayout.sourcePosition, anchorLayout.sourceSlotIndex, anchorLayout.sourceSlotCount),
  };
  const target = {
    x: resolveAnchorX(targetBounds, anchorLayout.targetPosition, anchorLayout.targetSlotIndex, anchorLayout.targetSlotCount),
    y: resolveAnchorY(targetBounds, anchorLayout.targetPosition, anchorLayout.targetSlotIndex, anchorLayout.targetSlotCount),
  };

  const spanStart = orientation === "horizontal" ? Math.min(source.x, target.x) : Math.min(source.y, target.y);
  const spanEnd = orientation === "horizontal" ? Math.max(source.x, target.x) : Math.max(source.y, target.y);

  // 绕行通道必须落在「主轴区间内所有卡片」的外侧，这样每段折线都不会再压到别的卡片。
  const spanBounds = allBounds.filter((bounds) => (
    bounds.id !== sourceBounds.id
    && bounds.id !== targetBounds.id
    && (orientation === "horizontal"
      ? bounds.x < spanEnd && bounds.x + bounds.width > spanStart
      : bounds.y < spanEnd && bounds.y + bounds.height > spanStart)
  ));
  if (spanBounds.length === 0) return null;

  const segmentBounds = orientation === "horizontal"
    ? { x: spanStart, y: Math.min(source.y, target.y), width: spanEnd - spanStart, height: Math.abs(target.y - source.y) }
    : { x: Math.min(source.x, target.x), y: spanStart, width: Math.abs(target.x - source.x), height: spanEnd - spanStart };
  const blocked = spanBounds.some((bounds) => rectsIntersect(bounds, segmentBounds));
  if (!blocked) return null;

  const rail = orientation === "horizontal"
    ? Math.max(...spanBounds.map((bounds) => bounds.y + bounds.height)) + DETOUR_GAP
    : Math.max(...spanBounds.map((bounds) => bounds.x + bounds.width)) + DETOUR_GAP;

  return {
    edgeId: edge.id,
    orientation,
    source,
    target,
    rail,
    spanStart,
    spanEnd,
    lane: 0,
  };
}

/** 读取已写入的锚点布局；缺失时退回与写入侧一致的默认方向。 */
function resolveStoredAnchorLayout(
  data: unknown,
  sourceBounds: NodeBounds,
  targetBounds: NodeBounds,
): WorkflowEdgeAnchorLayout {
  const stored = isRecord(data) ? (data as { anchorLayout?: WorkflowEdgeAnchorLayout }).anchorLayout : null;
  if (stored?.sourcePosition && stored?.targetPosition) return stored;
  return resolveAnchorLayout(sourceBounds, targetBounds);
}

/** 只处理源与目标锚点同轴的情形；混合方向交给既有平滑折线。 */
function resolveAnchorOrientation(layout: WorkflowEdgeAnchorLayout): "horizontal" | "vertical" | null {
  const sourceHorizontal = layout.sourcePosition === Position.Left || layout.sourcePosition === Position.Right;
  const targetHorizontal = layout.targetPosition === Position.Left || layout.targetPosition === Position.Right;
  if (sourceHorizontal !== targetHorizontal) return null;
  return sourceHorizontal ? "horizontal" : "vertical";
}

function rectsIntersect(
  left: Pick<NodeBounds, "x" | "y" | "width" | "height">,
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

/** 主轴区间相交的绕行线各占一条通道，避免折线叠在一起。 */
function assignDetourLanes(plans: DetourPlan[]): void {
  const ordered = [...plans].sort((left, right) => (
    left.spanStart - right.spanStart
    || right.spanEnd - left.spanEnd
    || left.edgeId.localeCompare(right.edgeId)
  ));
  const laneEnds: number[] = [];
  for (const plan of ordered) {
    let lane = laneEnds.findIndex((end) => end + 30 < plan.spanStart);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = plan.spanEnd;
    plan.lane = lane;
  }
}

/** 按方案生成折线：先离开锚点，再沿通道绕行，最后折回目标锚点。 */
function buildDetourPoints(plan: DetourPlan): WorkflowRoutePoint[] {
  const rail = plan.rail + plan.lane * DETOUR_LANE_GAP;
  if (plan.orientation === "horizontal") {
    const direction = Math.sign(plan.target.x - plan.source.x) || 1;
    const sourceStubX = plan.source.x + DETOUR_STUB * direction;
    const targetStubX = plan.target.x - DETOUR_STUB * direction;
    return [
      plan.source,
      { x: sourceStubX, y: plan.source.y },
      { x: sourceStubX, y: rail },
      { x: targetStubX, y: rail },
      { x: targetStubX, y: plan.target.y },
      plan.target,
    ];
  }
  const direction = Math.sign(plan.target.y - plan.source.y) || 1;
  const sourceStubY = plan.source.y + DETOUR_STUB * direction;
  const targetStubY = plan.target.y - DETOUR_STUB * direction;
  return [
    plan.source,
    { x: plan.source.x, y: sourceStubY },
    { x: rail, y: sourceStubY },
    { x: rail, y: targetStubY },
    { x: plan.target.x, y: targetStubY },
    plan.target,
  ];
}
