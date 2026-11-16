import type {
  OrchestrationInstanceSummary,
  OrchestrationRunSummary,
  WorkflowId,
  WorkflowNode,
  WorkflowRuntimeDefinition,
  WorkspaceId,
} from "@codeflowai/shared";

import { logger } from "../logger.js";
import type {
  OrchAssetAuthorityRuntimeReadService,
  OrchAssetAuthorityRuntimeReadSession,
} from "./orchAssetAuthorityRuntimeReadService.js";

/** 当前工作流定义里可用于展示的流程名与节点名；读不到定义时解析结果为 null。 */
export type OrchCurrentWorkflowLabels = {
  workspaceId: string;
  workflowId: string;
  /** 触发本次解析的请求标识；会话服务层没有该上下文时为 null。 */
  requestId: string | null;
  name: string | null;
  /** nodeId → 当前定义的节点名。 */
  nodeLabels: ReadonlyMap<string, string>;
};

// 会话卡片与监控面板按秒级轮询，解析失败必须按 (workspaceId, workflowId, 签名) 在进程内去重，否则刷屏。
const loggedDiagnostics = new Set<string>();

/** 仅供测试清空进程内日志去重，避免用例之间互相抑制。 */
export function resetOrchCurrentDefinitionLabelLogDedupeForTest(): void {
  loggedDiagnostics.clear();
}

/** 同一诊断签名在进程内只记录一次。 */
function logDiagnosticOnce(key: string, message: string, data: Record<string, unknown>): void {
  if (loggedDiagnostics.has(key)) return;
  loggedDiagnostics.add(key);
  logger.warn("orchestration", message, data);
}

/** 节点在当前定义里不存在；展示回退旧名，不显示 nodeId。 */
function logMissingNode(labels: OrchCurrentWorkflowLabels, nodeId: string): void {
  logDiagnosticOnce(`ORCH_NODE_LABEL_NODE_MISSING:${labels.workspaceId}:${labels.workflowId}:${nodeId}`,
    "current workflow definition has no node for the frozen snapshot node", {
      code: "ORCH_NODE_LABEL_NODE_MISSING",
      requestId: labels.requestId,
      workspaceId: labels.workspaceId,
      workflowId: labels.workflowId,
      missingNodeId: nodeId,
    });
}

/**
 * 按 nodeId 从当前工作流定义解析展示名。
 * 一个请求内只打开一次 workspace 只读会话，并按 workflowId 记忆化；任何读取失败都降级为 null，由调用方保留快照旧名。
 */
export class OrchCurrentWorkflowLabelResolver {
  private readonly sessions = new Map<string, OrchAssetAuthorityRuntimeReadSession>();
  private readonly cache = new Map<string, OrchCurrentWorkflowLabels | null>();

  constructor(
    private readonly read: OrchAssetAuthorityRuntimeReadService | undefined,
    private readonly requestId: string | null = null,
  ) {}

  /** 解析某个工作流当前的流程名与节点名；缺 workspaceId/workflowId 或读不到定义时返回 null。 */
  resolve(workspaceId: string | null | undefined, workflowId: string | null | undefined): OrchCurrentWorkflowLabels | null {
    const workspace = String(workspaceId ?? "").trim();
    const workflow = String(workflowId ?? "").trim();
    if (!workspace || !workflow) return null;
    const cacheKey = `${workspace}\u0000${workflow}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) ?? null;
    const labels = this.load(workspace, workflow);
    this.cache.set(cacheKey, labels);
    return labels;
  }

  /** 惰性打开只读会话并读取定义；资产已删除或读取抛错都只降级不抛给用户。 */
  private load(workspaceId: string, workflowId: string): OrchCurrentWorkflowLabels | null {
    if (!this.read) {
      logDiagnosticOnce("ORCH_NODE_LABEL_READER_ABSENT",
        "orch asset runtime reader is not wired; workflow display labels fall back to the frozen snapshot", {
          code: "ORCH_NODE_LABEL_READER_ABSENT",
          requestId: this.requestId,
          workspaceId,
          workflowId,
        });
      return null;
    }
    try {
      const session = this.openSession(workspaceId);
      const definition = session.getAsset("workflow", workflowId as WorkflowId)?.definition ?? null;
      if (!definition) {
        logDiagnosticOnce(`ORCH_NODE_LABEL_DEFINITION_UNAVAILABLE:${workspaceId}:${workflowId}`,
          "current workflow definition is unavailable; workflow display labels fall back to the frozen snapshot", {
            code: "ORCH_NODE_LABEL_DEFINITION_UNAVAILABLE",
            requestId: this.requestId,
            workspaceId,
            workflowId,
            cause: "workflow asset not found",
          });
        return null;
      }
      const nodeLabels = new Map<string, string>();
      for (const node of definition.nodes) nodeLabels.set(node.id, node.label);
      return { workspaceId, workflowId, requestId: this.requestId, name: String(definition.name ?? "").trim() || null, nodeLabels };
    } catch (error) {
      logDiagnosticOnce(`ORCH_NODE_LABEL_DEFINITION_UNAVAILABLE:${workspaceId}:${workflowId}`,
        "current workflow definition read failed; workflow display labels fall back to the frozen snapshot", {
          code: "ORCH_NODE_LABEL_DEFINITION_UNAVAILABLE",
          requestId: this.requestId,
          workspaceId,
          workflowId,
          cause: error instanceof Error ? error.message : String(error),
        });
      return null;
    }
  }

  private openSession(workspaceId: string): OrchAssetAuthorityRuntimeReadSession {
    const existing = this.sessions.get(workspaceId);
    if (existing) return existing;
    const session = this.read!.openWorkspace(workspaceId as WorkspaceId);
    this.sessions.set(workspaceId, session);
    return session;
  }
}

/** 用当前定义的节点名覆盖快照节点名；缺失节点保留旧名，不改数量、顺序与其它字段。 */
export function relabelWorkflowNodes(nodes: WorkflowNode[], labels: OrchCurrentWorkflowLabels | null): WorkflowNode[] {
  if (!labels) return nodes;
  return nodes.map((node) => {
    const label = labels.nodeLabels.get(node.id);
    if (label === undefined) { logMissingNode(labels, node.id); return node; }
    return label === node.label ? node : { ...node, label };
  });
}

/** 用当前定义覆盖流程定义（名称 + 节点名）的展示值；入参不被修改。 */
export function relabelWorkflowDefinition(
  workflow: WorkflowRuntimeDefinition,
  labels: OrchCurrentWorkflowLabels | null,
): WorkflowRuntimeDefinition {
  if (!labels) return workflow;
  return { ...workflow, name: labels.name ?? workflow.name, nodes: relabelWorkflowNodes(workflow.nodes, labels) };
}

/** 用当前定义覆盖运行摘要的活跃节点名；detailText 只按旧名的前缀替换，不静默拼接。 */
export function relabelRunSummary(
  summary: OrchestrationRunSummary,
  labels: OrchCurrentWorkflowLabels | null,
): OrchestrationRunSummary {
  if (!labels) return summary;
  const nodeId = String(summary.activeNodeId ?? "").trim();
  if (!nodeId) return summary;
  const currentLabel = labels.nodeLabels.get(nodeId);
  if (currentLabel === undefined) { logMissingNode(labels, nodeId); return summary; }
  // 必须用未 trim 的旧名做前缀比对：shared 派生 detailText 与 activeNodeLabel 用的是同一个原始 node.label，
  // trim 会把「  开发 · xxx」误判成契约漂移，留下 detailText 旧名 + activeNodeLabel 新名的矛盾摘要。
  const frozenLabel = String(summary.activeNodeLabel ?? "");
  let detailText = summary.detailText;
  if (detailText && frozenLabel && detailText.startsWith(frozenLabel)) {
    detailText = `${currentLabel}${detailText.slice(frozenLabel.length)}`;
  } else if (detailText) {
    logDiagnosticOnce(`ORCH_NODE_LABEL_DETAIL_PREFIX_MISMATCH:${labels.workspaceId}:${labels.workflowId}:${nodeId}`,
      "run summary detailText does not start with the frozen node label; keeping the frozen text", {
        code: "ORCH_NODE_LABEL_DETAIL_PREFIX_MISMATCH",
        requestId: labels.requestId,
        workspaceId: labels.workspaceId,
        workflowId: labels.workflowId,
        instanceId: summary.instanceId,
        nodeId,
      });
  }
  return { ...summary, activeNodeLabel: currentLabel, detailText };
}

/** 用当前定义覆盖实例摘要的流程名与活跃节点名；入参不被修改。 */
export function relabelInstanceSummary(
  summary: OrchestrationInstanceSummary,
  labels: OrchCurrentWorkflowLabels | null,
): OrchestrationInstanceSummary {
  if (!labels) return summary;
  return { ...summary, workflowName: labels.name ?? summary.workflowName, runSummary: relabelRunSummary(summary.runSummary, labels) };
}
