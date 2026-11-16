import { MarkerType, type Edge } from "@vue-flow/core";
import type { WorkflowNode } from "@codeflowai/shared";

import type { WorkflowRoutePoint } from "./workflow-auto-layout";

type ReworkConnection = {
  id: string;
  source: WorkflowNode;
  target: WorkflowNode;
  start: number;
  end: number;
  lane: number;
};

type ReworkEdgeOptions = {
  nodeWidth: number;
  nodeHeight: number;
  dark: boolean;
  /** 开始/结束的 bbox 是正方形而非卡片矩形；图边界与锚点尺寸都要按节点类型取。 */
  resolveNodeSize?: (node: WorkflowNode) => { width: number; height: number };
};

/** 单节点尺寸：未提供解析函数时退回全图统一的卡片尺寸。 */
function nodeSizeOf(node: WorkflowNode, options: ReworkEdgeOptions): { width: number; height: number } {
  return options.resolveNodeSize?.(node) ?? { width: options.nodeWidth, height: options.nodeHeight };
}

/** 按有效回退关系判断开关是否需要展示，不受当前显示偏好影响。 */
export function hasWorkflowReworkEdges(nodes: WorkflowNode[]): boolean {
  const roleIds = new Set(nodes.filter((node) => node.type === "role").map((node) => node.id));
  return nodes.some((node) => node.type === "role"
    && (node.reworkPolicy?.allowedTargetNodeIds ?? []).some((targetId) => targetId !== node.id && roleIds.has(targetId)));
}

/** 回退线只用于解释节点配置，不参与工作流 DAG 或持久化。 */
export function buildWorkflowReworkEdges(
  nodes: WorkflowNode[],
  options: ReworkEdgeOptions,
): Edge[] {
  if (!nodes.length) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const bounds = graphBounds(nodes, options);
  const vertical = bounds.height > bounds.width;
  const axis = (node: WorkflowNode) => vertical
    ? node.position.y + options.nodeHeight / 2
    : node.position.x + options.nodeWidth / 2;
  const connections: ReworkConnection[] = [];
  for (const source of nodes) {
    if (source.type !== "role") continue;
    for (const targetId of new Set(source.reworkPolicy?.allowedTargetNodeIds ?? [])) {
      const target = byId.get(targetId);
      if (!target || target.type !== "role" || target.id === source.id) continue;
      connections.push({
        id: `rework-visual:${source.id}:${target.id}`,
        source,
        target,
        start: Math.min(axis(source), axis(target)),
        end: Math.max(axis(source), axis(target)),
        lane: 0,
      });
    }
  }

  // 复用互不相交的轨道；相交的回退关系分别占一条轨道，避免线段重叠。
  connections.sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const laneEnds: number[] = [];
  for (const connection of connections) {
    let lane = laneEnds.findIndex((end) => end + 30 < connection.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = connection.end;
    connection.lane = lane;
  }

  const slots = endpointSlots(connections);
  const stroke = options.dark ? "#ffab8a" : "#ce6247";
  return connections.map((connection) => ({
    id: connection.id,
    source: connection.source.id,
    target: connection.target.id,
    type: "workflow-smooth",
    label: "退回",
    labelShowBg: true,
    labelBgPadding: [7, 3],
    labelBgBorderRadius: 8,
    labelStyle: { fill: stroke, fontSize: "11px", fontWeight: 600 },
    labelBgStyle: { fill: options.dark ? "#25202a" : "#fff7f2", stroke, strokeWidth: 0.8 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: stroke },
    style: { stroke, strokeWidth: 1.7, strokeDasharray: "6 4" },
    data: {
      visualKind: "rework",
      routePoints: routePoints(connection, bounds, options, vertical, slots),
    },
    selectable: false,
    updatable: false,
    focusable: false,
    interactionWidth: 0,
  }));
}

function endpointSlots(connections: ReworkConnection[]) {
  const groups = new Map<string, Array<{ connection: ReworkConnection; endpoint: "source" | "target" }>>();
  for (const connection of connections) {
    for (const endpoint of ["source", "target"] as const) {
      const id = connection[endpoint].id;
      groups.set(id, [...(groups.get(id) ?? []), { connection, endpoint }]);
    }
  }
  const slots = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.connection.lane - b.connection.lane
      || a.connection.id.localeCompare(b.connection.id)
      || a.endpoint.localeCompare(b.endpoint));
    group.forEach(({ connection, endpoint }, index) => {
      slots.set(`${connection.id}:${endpoint}`, (index + 1) / (group.length + 1));
    });
  }
  return slots;
}

function routePoints(
  connection: ReworkConnection,
  bounds: { minX: number; minY: number },
  options: ReworkEdgeOptions,
  vertical: boolean,
  slots: Map<string, number>,
): WorkflowRoutePoint[] {
  const sourceSize = nodeSizeOf(connection.source, options);
  const targetSize = nodeSizeOf(connection.target, options);
  const sourceRatio = slots.get(`${connection.id}:source`) ?? 0.5;
  const targetRatio = slots.get(`${connection.id}:target`) ?? 0.5;
  if (vertical) {
    const railX = bounds.minX - 52 - connection.lane * 32;
    const sourceY = connection.source.position.y + sourceSize.height * sourceRatio;
    const targetY = connection.target.position.y + targetSize.height * targetRatio;
    return [
      { x: connection.source.position.x, y: sourceY },
      { x: railX, y: sourceY },
      { x: railX, y: targetY },
      { x: connection.target.position.x, y: targetY },
    ];
  }
  const railY = bounds.minY - 52 - connection.lane * 32;
  const sourceX = connection.source.position.x + sourceSize.width * sourceRatio;
  const targetX = connection.target.position.x + targetSize.width * targetRatio;
  return [
    { x: sourceX, y: connection.source.position.y },
    { x: sourceX, y: railY },
    { x: targetX, y: railY },
    { x: targetX, y: connection.target.position.y },
  ];
}

function graphBounds(nodes: WorkflowNode[], options: ReworkEdgeOptions) {
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + nodeSizeOf(node, options).width));
  const maxY = Math.max(...nodes.map((node) => node.position.y + nodeSizeOf(node, options).height));
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

export function isWorkflowReworkVisualEdge(edge: Edge): boolean {
  return (edge.data as { visualKind?: unknown } | undefined)?.visualKind === "rework";
}
