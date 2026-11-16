import type {
  EngineType,
  OrchestrationRoleExecutionOverride,
  WorkflowRuntimeDefinition,
} from "@codeflowai/shared";

export type RerunExecutionOverrideScope = "affected" | "all";
export type RerunNodeScope = "downstream" | "single" | "custom";

export type RerunExecutionOverrideDraft = {
  engine: EngineType;
  model: string;
  effort: string;
  autoCompactPct: number | null;
  /** 服务档位覆盖；"fast" 开启，null 表示显式关闭角色默认的 Fast。 */
  serviceTier?: "fast" | null;
};

/** 收集从重跑起点可达的节点，供界面限定“本节点及后续”配置范围。 */
export function collectRerunAffectedNodeIds(workflow: WorkflowRuntimeDefinition, targetNodeId: string): string[] {
  const normalizedTargetNodeId = String(targetNodeId ?? "").trim();
  if (!normalizedTargetNodeId) return [];
  const visited = new Set<string>();
  const queue = [normalizedTargetNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const edge of workflow.edges) {
      if (edge.sourceNodeId === nodeId) queue.push(edge.targetNodeId);
    }
  }
  return [...visited];
}

/** 按界面范围生成提交给运行时的精确节点集合；downstream 保持旧接口的空值语义。 */
export function buildRerunNodeIds(
  workflow: WorkflowRuntimeDefinition,
  targetNodeId: string,
  scope: RerunNodeScope,
  customNodeIds: Iterable<string> = [],
): string[] | null {
  const normalizedTargetNodeId = String(targetNodeId ?? "").trim();
  if (!normalizedTargetNodeId || scope === "downstream") return null;
  if (scope === "single") return [normalizedTargetNodeId];
  return Array.from(new Set([
    normalizedTargetNodeId,
    ...Array.from(customNodeIds, (nodeId) => String(nodeId ?? "").trim()).filter(Boolean),
  ]));
}

/** 校验自定义节点在所选子图内从起点连续可达，提前给出可读错误。 */
export function validateRerunNodeIds(
  workflow: WorkflowRuntimeDefinition,
  targetNodeId: string,
  rerunNodeIds: string[] | null,
): string | null {
  if (rerunNodeIds == null) return null;
  const selectedNodeIds = new Set(rerunNodeIds);
  if (!selectedNodeIds.has(targetNodeId)) return "精确重跑范围必须包含起点节点";
  const workflowNodeIds = new Set(workflow.nodes.map((node) => node.id));
  const unknownNodeIds = Array.from(selectedNodeIds).filter((nodeId) => !workflowNodeIds.has(nodeId));
  if (unknownNodeIds.length > 0) return `精确重跑范围包含不存在的节点：${unknownNodeIds.join("、")}`;
  const downstreamNodeIds = new Set(collectRerunAffectedNodeIds(workflow, targetNodeId));
  const outsideNodeIds = Array.from(selectedNodeIds).filter((nodeId) => !downstreamNodeIds.has(nodeId));
  if (outsideNodeIds.length > 0) return `只能选择起点下游节点：${outsideNodeIds.join("、")}`;

  const reachableNodeIds = new Set<string>();
  const queue = [targetNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (reachableNodeIds.has(nodeId)) continue;
    reachableNodeIds.add(nodeId);
    for (const edge of workflow.edges) {
      if (edge.sourceNodeId === nodeId && selectedNodeIds.has(edge.targetNodeId)) queue.push(edge.targetNodeId);
    }
  }
  const disconnectedNodeIds = Array.from(selectedNodeIds).filter((nodeId) => !reachableNodeIds.has(nodeId));
  return disconnectedNodeIds.length > 0
    ? `所选节点必须从起点连续可达，请补充中间节点：${disconnectedNodeIds.join("、")}`
    : null;
}

/** 按所选范围返回需更新的唯一角色 ID，重复绑定同一角色时只提交一次覆盖。 */
export function collectRerunScopeRoleIds(
  workflow: WorkflowRuntimeDefinition,
  targetNodeId: string,
  scope: RerunExecutionOverrideScope,
  rerunNodeIds: string[] | null = null,
): string[] {
  const allowedNodeIds = scope === "all"
    ? null
    : new Set(rerunNodeIds ?? collectRerunAffectedNodeIds(workflow, targetNodeId));
  const roleIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.type !== "role" || !node.roleId) continue;
    if (allowedNodeIds && !allowedNodeIds.has(node.id)) continue;
    roleIds.add(String(node.roleId));
  }
  return [...roleIds];
}

/** 生成角色运行覆盖；窗口由模型决定，空压缩比例保持不修改。 */
export function buildRerunRoleExecutionOverrides(
  roleIds: Iterable<string>,
  draft: RerunExecutionOverrideDraft,
): Record<string, OrchestrationRoleExecutionOverride> {
  const override: OrchestrationRoleExecutionOverride = {
    engine: draft.engine,
    model: String(draft.model ?? "").trim(),
    effort: String(draft.effort ?? "").trim() || null,
  };
  const autoCompactPct = normalizeOptionalNumber(draft.autoCompactPct);
  if (autoCompactPct != null) override.autoCompactPct = Math.round(autoCompactPct);
  // 透传服务档位：显式 null 表示关闭角色默认的 Fast，不能被一次往返保存抹掉。
  if (draft.serviceTier !== undefined) override.serviceTier = draft.serviceTier === "fast" ? "fast" : null;

  const overrides: Record<string, OrchestrationRoleExecutionOverride> = {};
  for (const rawRoleId of roleIds) {
    const roleId = String(rawRoleId ?? "").trim();
    if (roleId) overrides[roleId] = { ...override };
  }
  return overrides;
}

/** 校验界面草稿中的模型与数值边界，避免无效请求进入重跑链路。 */
export function validateRerunExecutionOverrideDraft(draft: RerunExecutionOverrideDraft): string | null {
  if (!String(draft.model ?? "").trim()) return "请选择模型或填写模型 ID";
  const autoCompactPct = normalizeOptionalNumber(draft.autoCompactPct);
  if (autoCompactPct != null && (!Number.isFinite(autoCompactPct) || autoCompactPct < 50 || autoCompactPct > 99)) {
    return "自动压缩比例应在 50-99 之间";
  }
  return null;
}

/** 将可选输入统一为有限数值；空值保持不覆盖，非法值留给校验函数拒绝。 */
function normalizeOptionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : Number.NaN;
}
