import type { WorkflowEdge, WorkflowNode } from "@codeflowai/shared";

export type ReworkTargetOption = {
  id: string;
  label: string;
};

/** 解析当前节点允许人工退回的目标；显式配置优先，否则退化为所有上游角色节点。 */
export function resolveAllowedReworkTargets(
  workflowNodes: WorkflowNode[],
  workflowEdges: WorkflowEdge[],
  currentNodeId: string,
): ReworkTargetOption[] {
  const currentNode = workflowNodes.find((item) => String(item.id ?? "").trim() === currentNodeId) ?? null;
  if (!currentNode) return [];

  const explicitTargets = (currentNode.reworkPolicy?.allowedTargetNodeIds ?? [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  const allowedTargetIds = explicitTargets.length
    ? explicitTargets
    : Array.from(collectUpstreamRoleNodeIds(workflowNodes, workflowEdges, currentNodeId));

  return allowedTargetIds
    .map((nodeId) => {
      const node = workflowNodes.find((item) => String(item.id ?? "").trim() === nodeId) ?? null;
      if (!node) return null;
      return {
        id: nodeId,
        label: String(node.label ?? "").trim() || nodeId,
      };
    })
    .filter((item): item is ReworkTargetOption => Boolean(item));
}

/** 沿入边向上收集可作为返工起点的角色节点。 */
export function collectUpstreamRoleNodeIds(
  workflowNodes: WorkflowNode[],
  workflowEdges: WorkflowEdge[],
  currentNodeId: string,
): Set<string> {
  const visited = new Set<string>();
  const upstreamRoleNodeIds = new Set<string>();
  const queue = [currentNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const inEdges = workflowEdges.filter((edge) => edge.targetNodeId === current);
    for (const edge of inEdges) {
      queue.push(edge.sourceNodeId);
      const upstreamNode = workflowNodes.find((item) => item.id === edge.sourceNodeId) ?? null;
      if (upstreamNode?.type === "role" && upstreamNode.id !== currentNodeId) {
        upstreamRoleNodeIds.add(upstreamNode.id);
      }
    }
  }
  return upstreamRoleNodeIds;
}
