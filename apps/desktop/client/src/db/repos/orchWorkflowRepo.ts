import crypto from "node:crypto";
import {
  normalizeOrchAssetDefinitionKind,
  normalizeNodeWorkItemPolicy,
  type WorkspaceId,
  type WorkflowId,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowEdge,
} from "@codeflowai/shared";
import type { SqliteDb } from "../sqliteTypes.js";

/** 编排工作流仓储：负责 orch_workflows 表的 CRUD。 */
export class OrchWorkflowRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 列出某 workspace 的所有工作流（按 updated_at DESC）。 */
  listByWorkspace(workspaceId: WorkspaceId): WorkflowDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, name, description, nodes_json, edges_json, definition_json,
                version, created_at, updated_at
         FROM orch_workflows WHERE workspace_id = ? ORDER BY updated_at DESC`,
      )
      .all(String(workspaceId)) as any[];
    return rows.map(rowToWorkflow);
  }

  /** 完整图读取拒绝原始损坏；普通调用保留已有字段兼容映射。 */
  get(id: WorkflowId, options?: { requireCompleteDefinition?: boolean }): WorkflowDefinition | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, name, description, nodes_json, edges_json, definition_json,
                version, created_at, updated_at
         FROM orch_workflows WHERE id = ?`,
      )
      .get(String(id)) as any | undefined;
    if (!row) return null;
    if (options?.requireCompleteDefinition) assertCompleteWorkflowRow(row);
    return rowToWorkflow(row);
  }

  /** 创建或更新工作流（upsert）。 */
  upsert(input: Omit<WorkflowDefinition, "createdAt" | "updatedAt">): WorkflowDefinition {
    return this.db.transaction(() => {
      const now = Date.now();
      const existing = input.id ? this.get(input.id) : null;
      const id = input.id || (crypto.randomUUID() as WorkflowId);
      const createdAt = existing?.createdAt ?? now;
      const version = input.version ?? (existing ? existing.version + 1 : 1);
      const normalizedInput = normalizeWorkflowForStorage(input, { id, version, existing });

      this.db
        .prepare(
          `INSERT INTO orch_workflows (id, workspace_id, name, description, nodes_json, edges_json,
                  definition_json, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, description = excluded.description,
             nodes_json = excluded.nodes_json, edges_json = excluded.edges_json,
             definition_json = excluded.definition_json,
             version = excluded.version, updated_at = excluded.updated_at`,
        )
        .run(
          id,
          String(normalizedInput.workspaceId),
          String(normalizedInput.name ?? ""),
          String(normalizedInput.description ?? ""),
          JSON.stringify(normalizedInput.nodes ?? []),
          JSON.stringify(normalizedInput.edges ?? []),
          JSON.stringify(normalizedInput),
          version,
          createdAt,
          now,
        );
      return { ...normalizedInput, id, version, createdAt, updatedAt: now } as WorkflowDefinition;
    })();
  }

  /** 删除工作流。 */
  delete(id: WorkflowId): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM orch_workflows WHERE id = ?").run(String(id));
    })();
  }
}

/** 在节点归一化前检查完整图数组和原始引用，不能恢复成空流程继续复制。 */
function assertCompleteWorkflowRow(row: { id: string; workspace_id: string; definition_json: string }): void {
  const value = JSON.parse(row.definition_json) as WorkflowDefinition;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value.id != null && value.id !== row.id) || (value.workspaceId != null && value.workspaceId !== row.workspace_id)
    || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error(`流程原始定义非法：${row.id}`);
  /** 已声明知识引用必须保留，不能被数组转换或过滤删除。 */
  const assertIds = (ids: unknown): void => {
    if (ids != null && (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id.trim()))) {
      throw new Error(`流程原始知识依赖非法：${row.id}`);
    }
  };
  assertIds(value.workflowKnowledgeBundleIds);
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!node || typeof node.id !== "string" || !node.id.trim() || nodeIds.has(node.id)
      || !["role", "condition", "parallel-fork", "parallel-join", "start", "end"].includes(node.type)
      || (node.roleId != null && (typeof node.roleId !== "string" || !node.roleId.trim()))) {
      throw new Error(`流程原始节点非法：${row.id}`);
    }
    nodeIds.add(node.id);
    assertIds(node.knowledgeOverrideBundleIds);
  }
  for (const edge of value.edges) {
    if (!edge || typeof edge.id !== "string" || !edge.id.trim() || !nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      throw new Error(`流程原始连线非法：${row.id}`);
    }
  }
}

function rowToWorkflow(row: any): WorkflowDefinition {
  const full = safeParseJson<WorkflowDefinition | null>(row.definition_json, null);
  if (full && typeof full === "object") {
    return normalizeWorkflowForRead(full, {
      id: row.id as WorkflowId,
      workspaceId: row.workspace_id as WorkspaceId,
      version: Number(row.version ?? full.version ?? 1),
      createdAt: Number(row.created_at ?? full.createdAt ?? 0),
      updatedAt: Number(row.updated_at ?? full.updatedAt ?? 0),
    });
  }
  return {
    id: row.id as WorkflowId,
    workspaceId: row.workspace_id as WorkspaceId,
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    nodes: normalizeWorkflowNodes(safeParseJson<unknown>(row.nodes_json, []), []),
    edges: normalizeWorkflowEdges(safeParseJson<unknown>(row.edges_json, []), []),
    kind: "custom",
    version: Number(row.version ?? 1),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** 按当前 WorkflowDefinition 合同保存，避免把调用方额外字段写入 definition_json。 */
function normalizeWorkflowForStorage(
  input: Omit<WorkflowDefinition, "createdAt" | "updatedAt">,
  opts: { id: WorkflowId; version: number; existing: WorkflowDefinition | null },
): Omit<WorkflowDefinition, "createdAt" | "updatedAt"> {
  return {
    id: opts.id,
    workspaceId: input.workspaceId ?? opts.existing?.workspaceId,
    family: input.family ?? opts.existing?.family ?? null,
    name: String(input.name ?? opts.existing?.name ?? ""),
    description: String(input.description ?? opts.existing?.description ?? ""),
    workflowKnowledgeBundleIds: input.workflowKnowledgeBundleIds ?? opts.existing?.workflowKnowledgeBundleIds ?? null,
    nodes: normalizeWorkflowNodes(input.nodes, opts.existing?.nodes ?? []),
    edges: normalizeWorkflowEdges(input.edges, opts.existing?.edges ?? []),
    kind: normalizeOrchAssetDefinitionKind(input.kind ?? opts.existing?.kind),
    version: opts.version,
  };
}

/** 按当前 WorkflowDefinition 合同读取，屏蔽 definition_json 里的额外字段。 */
function normalizeWorkflowForRead(
  input: WorkflowDefinition,
  overrides: Pick<WorkflowDefinition, "id" | "workspaceId" | "version" | "createdAt" | "updatedAt">,
): WorkflowDefinition {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId,
    family: input.family ?? null,
    name: String(input.name ?? ""),
    description: String(input.description ?? ""),
    workflowKnowledgeBundleIds: input.workflowKnowledgeBundleIds ?? null,
    nodes: normalizeWorkflowNodes(input.nodes, []),
    edges: normalizeWorkflowEdges(input.edges, []),
    kind: normalizeOrchAssetDefinitionKind(input.kind),
    version: overrides.version,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt,
  };
}

/** 规范化流程节点数组，只保留当前 WorkflowNode 合同字段。 */
function normalizeWorkflowNodes(value: unknown, fallback: WorkflowNode[]): WorkflowNode[] {
  if (!Array.isArray(value)) return fallback;
  return value.map(pickWorkflowNode) as WorkflowNode[];
}

/** 规范化流程连线数组，只保留当前 WorkflowEdge 合同字段。 */
function normalizeWorkflowEdges(value: unknown, fallback: WorkflowEdge[]): WorkflowEdge[] {
  if (!Array.isArray(value)) return fallback;
  return value.map(pickWorkflowEdge) as WorkflowEdge[];
}

/** 清理节点级废弃字段，避免 assigneeUserIds 重新进入流程定义。 */
function pickWorkflowNode(value: unknown): Partial<WorkflowNode> {
  const node = asRecord(value);
  const allowedKeys = [
    "id",
    "type",
    "roleId",
    "conditionExpr",
    "conditionDecisionMode",
    "label",
    "position",
    "inputReferences",
    "inputBindings",
    "outputWritePolicy",
    "outputArtifactMode",
    "outputResultKey",
    "knowledgeOverrideBundleIds",
    "startMode",
    "manualStartPrompt",
    "approvalMode",
    "failPolicy",
    "workItemPolicy",
    "reworkPolicy",
  ];
  const picked: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
    if (key === "manualStartPrompt") {
      picked[key] = node.startMode === "manual" ? String(node[key] ?? "").trim() || null : null;
      continue;
    }
    if (key === "workItemPolicy") {
      picked[key] = normalizeNodeWorkItemPolicy(node[key]);
      continue;
    }
    picked[key] = key === "position" ? pickWorkflowNodePosition(node[key]) : node[key];
  }
  return picked as Partial<WorkflowNode>;
}

/** 画布位置只保留 x/y，避免节点 position 携带非合同字段。 */
function pickWorkflowNodePosition(value: unknown): Partial<WorkflowNode["position"]> {
  const position = asRecord(value);
  const picked: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(position, "x")) picked.x = position.x;
  if (Object.prototype.hasOwnProperty.call(position, "y")) picked.y = position.y;
  return picked as Partial<WorkflowNode["position"]>;
}

/** 清理连线级废弃字段，保持仓储写入合同和共享类型一致。 */
function pickWorkflowEdge(value: unknown): Partial<WorkflowEdge> {
  const edge = asRecord(value);
  const allowedKeys = ["id", "sourceNodeId", "targetNodeId", "conditionBranch", "dataMappings", "routePoints"];
  const picked: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(edge, key)) picked[key] = edge[key];
  }
  return picked as Partial<WorkflowEdge>;
}

/** 安全读取普通对象，供流程定义深层白名单使用。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

