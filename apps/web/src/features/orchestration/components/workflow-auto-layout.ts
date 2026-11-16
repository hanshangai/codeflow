import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkEdgeSection, ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api";
import type { Edge, Node } from "@vue-flow/core";

export type WorkflowAutoLayoutDirection = "horizontal" | "vertical";

export type WorkflowRoutePoint = {
  x: number;
  y: number;
};

export type WorkflowAutoLayoutResult = {
  nodePositions: Map<string, WorkflowRoutePoint>;
  edgeRoutes: Map<string, WorkflowRoutePoint[]>;
};

const elk = new ELK();

export async function computeWorkflowAutoLayout(
  nodes: Array<Pick<Node, "id"> & { type?: string | null }>,
  edges: Array<Pick<Edge, "id" | "source" | "target">>,
  options: {
    direction: WorkflowAutoLayoutDirection;
    nodeWidth: number;
    nodeHeight: number;
    /** 开始/结束的 bbox 是正方形而非卡片矩形，需要按节点类型给 ELK 尺寸。 */
    resolveNodeSize?: (node: { id: string; type?: string | null }) => { width: number; height: number };
  },
): Promise<WorkflowAutoLayoutResult> {
  const graph: ElkNode = {
    id: "workflow-root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": options.direction === "horizontal" ? "RIGHT" : "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=48,left=48,bottom=48,right=48]",
      "elk.spacing.nodeNode": "72",
      "elk.spacing.edgeNode": "36",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.thoroughness": "25",
    },
    children: nodes.map((node) => {
      const size = options.resolveNodeSize?.(node) ?? { width: options.nodeWidth, height: options.nodeHeight };
      return {
        id: node.id,
        width: size.width,
        height: size.height,
      };
    }),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const layout = await elk.layout(graph);
  const nodePositions = new Map<string, WorkflowRoutePoint>();
  const edgeRoutes = new Map<string, WorkflowRoutePoint[]>();

  for (const child of layout.children ?? []) {
    nodePositions.set(child.id, {
      x: Math.round(Number(child.x ?? 0)),
      y: Math.round(Number(child.y ?? 0)),
    });
  }

  for (const edge of layout.edges ?? []) {
    const routePoints = extractEdgeRoute(edge);
    if (routePoints.length >= 2) {
      edgeRoutes.set(edge.id ?? "", routePoints);
    }
  }

  return {
    nodePositions,
    edgeRoutes,
  };
}

function extractEdgeRoute(edge: ElkExtendedEdge): WorkflowRoutePoint[] {
  const sections = edge.sections ?? [];
  if (sections.length === 0) return [];

  const sectionById = new Map(sections.map((section) => [section.id, section] as const));
  const orderedPoints: WorkflowRoutePoint[] = [];
  const visited = new Set<string>();
  let current: ElkEdgeSection | undefined =
    sections.find((section) => (section.incomingSections?.length ?? 0) === 0) ?? sections[0];

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    pushUniquePoint(orderedPoints, current.startPoint);
    for (const bendPoint of current.bendPoints ?? []) {
      pushUniquePoint(orderedPoints, bendPoint);
    }
    pushUniquePoint(orderedPoints, current.endPoint);
    const nextId: string | undefined = (current.outgoingSections ?? []).find(
      (candidateId: string) => !visited.has(candidateId),
    );
    current = nextId ? sectionById.get(nextId) : undefined;
  }

  return orderedPoints;
}

function pushUniquePoint(target: WorkflowRoutePoint[], point: ElkPoint): void {
  const normalized = {
    x: Math.round(Number(point.x ?? 0)),
    y: Math.round(Number(point.y ?? 0)),
  };
  const last = target.at(-1);
  if (last && last.x === normalized.x && last.y === normalized.y) return;
  target.push(normalized);
}
