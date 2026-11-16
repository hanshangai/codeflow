import crypto from "node:crypto";

import type { NodePromptSnapshot, OrchestrationId } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type OrchPromptSnapshotListOptions = {
  limit?: number | null;
  includeContent?: boolean | null;
  attemptNo?: number | null;
};

export type PromptSnapshotCleanupBatchResult = {
  scannedRows: number;
  deletedRows: number;
  lastScannedRowId: number;
};

export class OrchPromptSnapshotRepo {
  constructor(private readonly db: SqliteDb) {}

  get(id: string): NodePromptSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort, purpose,
                prompt_envelope_json, system_message, developer_message, user_message, rendered_input_preview,
                runtime_policy_json, tool_registry_json, knowledge_catalogs_json, artifact_input_json, created_at
         FROM orch_prompt_snapshots
         WHERE id = ?`,
      )
      .get(String(id)) as any | undefined;
    return row ? rowToPromptSnapshot(row) : null;
  }

  /** 列出实例 Prompt Snapshot；includeContent=false 时只返回轻量索引摘要。 */
  listByInstance(instanceId: OrchestrationId, options: OrchPromptSnapshotListOptions = {}): NodePromptSnapshot[] {
    const limit = normalizeListLimit(options.limit);
    if (options.includeContent === false) {
      const rows = this.listSummaryRows("WHERE instance_id = ?", [String(instanceId)], limit);
      return rows.map(rowToPromptSnapshotSummary);
    }
    if (limit) {
      const rows = this.db
        .prepare(
          `SELECT id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort, purpose,
                  prompt_envelope_json, system_message, developer_message, user_message, rendered_input_preview,
                  runtime_policy_json, tool_registry_json, knowledge_catalogs_json, artifact_input_json, created_at
           FROM (
             SELECT id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort, purpose,
                    prompt_envelope_json, system_message, developer_message, user_message, rendered_input_preview,
                    runtime_policy_json, tool_registry_json, knowledge_catalogs_json, artifact_input_json, created_at
             FROM orch_prompt_snapshots
             WHERE instance_id = ?
             ORDER BY created_at DESC LIMIT ?
           )
           ORDER BY created_at ASC`,
        )
        .all(String(instanceId), limit) as any[];
      return rows.map(rowToPromptSnapshot);
    }
    const rows = this.db
      .prepare(
        `SELECT id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort, purpose,
                prompt_envelope_json, system_message, developer_message, user_message, rendered_input_preview,
                runtime_policy_json, tool_registry_json, knowledge_catalogs_json, artifact_input_json, created_at
         FROM orch_prompt_snapshots
         WHERE instance_id = ?
         ORDER BY created_at ASC`,
      )
      .all(String(instanceId)) as any[];
    return rows.map(rowToPromptSnapshot);
  }

  /** 列出节点 Prompt Snapshot；includeContent=false 时只返回轻量索引摘要。 */
  listByNode(instanceId: OrchestrationId, nodeId: string, options: OrchPromptSnapshotListOptions = {}): NodePromptSnapshot[] {
    const limit = normalizeListLimit(options.limit);
    const attemptClause = options.attemptNo == null ? "" : " AND attempt_no = ?";
    const attemptParams = options.attemptNo == null ? [] : [Number(options.attemptNo)];
    if (options.includeContent === false) {
      const rows = this.listSummaryRows(`WHERE instance_id = ? AND node_id = ?${attemptClause}`, [String(instanceId), String(nodeId), ...attemptParams], limit);
      return rows.map(rowToPromptSnapshotSummary);
    }
    if (limit) {
      const rows = this.db
        .prepare(
          `SELECT id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort, purpose,
                  prompt_envelope_json, system_message, developer_message, user_message, rendered_input_preview,
                  runtime_policy_json, tool_registry_json, knowledge_catalogs_json, artifact_input_json, created_at
           FROM (
             SELECT id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort, purpose,
                    prompt_envelope_json, system_message, developer_message, user_message, rendered_input_preview,
                    runtime_policy_json, tool_registry_json, knowledge_catalogs_json, artifact_input_json, created_at
             FROM orch_prompt_snapshots
             WHERE instance_id = ? AND node_id = ?${attemptClause}
             ORDER BY created_at DESC LIMIT ?
           )
           ORDER BY created_at ASC`,
        )
        .all(String(instanceId), String(nodeId), ...attemptParams, limit) as any[];
      return rows.map(rowToPromptSnapshot);
    }
    const rows = this.db
      .prepare(
        `SELECT id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort, purpose,
                prompt_envelope_json, system_message, developer_message, user_message, rendered_input_preview,
                runtime_policy_json, tool_registry_json, knowledge_catalogs_json, artifact_input_json, created_at
         FROM orch_prompt_snapshots
         WHERE instance_id = ? AND node_id = ?${attemptClause}
         ORDER BY created_at ASC`,
      )
      .all(String(instanceId), String(nodeId), ...attemptParams) as any[];
    return rows.map(rowToPromptSnapshot);
  }

  /** 查询轻量 Prompt Snapshot 行，避免列表接口读取完整 prompt 正文。 */
  private listSummaryRows(whereSql: string, params: unknown[], limit: number | null): any[] {
    if (limit) {
      return this.db
        .prepare(
          `SELECT id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort, purpose,
                  created_at
           FROM (
             SELECT id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort, purpose,
                    created_at
             FROM orch_prompt_snapshots
             ${whereSql}
             ORDER BY created_at DESC LIMIT ?
           )
           ORDER BY created_at ASC`,
        )
        .all(...params, limit) as any[];
    }
    return this.db
      .prepare(
        `SELECT id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort, purpose,
                created_at
         FROM orch_prompt_snapshots
         ${whereSql}
         ORDER BY created_at ASC`,
      )
      .all(...params) as any[];
  }

  create(input: Omit<NodePromptSnapshot, "id">): NodePromptSnapshot {
    const snapshot: NodePromptSnapshot = {
      ...input,
      id: crypto.randomUUID(),
    };
    this.db
      .prepare(
        `INSERT INTO orch_prompt_snapshots (
          id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort,
          prompt_envelope_json, system_message, developer_message, user_message, rendered_input_preview,
          runtime_policy_json, tool_registry_json, knowledge_catalogs_json, artifact_input_json, purpose, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        String(snapshot.instanceId),
        String(snapshot.nodeId),
        Number(snapshot.attemptNo ?? 1),
        snapshot.threadId ?? null,
        snapshot.turnId ?? null,
        String(snapshot.engine),
        snapshot.model ?? null,
        snapshot.effort ?? null,
        JSON.stringify(snapshot.promptEnvelope),
        String(snapshot.systemMessage ?? ""),
        snapshot.developerMessage ?? null,
        String(snapshot.userMessage ?? ""),
        String(snapshot.renderedInputPreview ?? ""),
        JSON.stringify(snapshot.runtimePolicy ?? {}),
        snapshot.toolRegistry ? JSON.stringify(snapshot.toolRegistry) : null,
        JSON.stringify({
          catalogs: snapshot.knowledgeCatalogs ?? [],
          warnings: snapshot.knowledgeWarnings ?? [],
        }),
        JSON.stringify(snapshot.artifactInput ?? { artifacts: [], fieldBindings: {} }),
        snapshot.purpose ?? null,
        Number(snapshot.createdAt ?? Date.now()),
      );
    return snapshot;
  }

  /** 读取当前 Prompt 大表 rowid 高水位，后续新增行不进入本轮清理。 */
  getCleanupHighWaterRowId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS value FROM orch_prompt_snapshots").get() as
      | { value?: number | null }
      | undefined;
    return normalizeCleanupRowId(row?.value);
  }

  /** 按 rowid 小窗口扫描，只删除终态实例的 Prompt 快照。 */
  cleanupTerminalBatch(
    afterRowId: number,
    throughRowId: number,
    limit: number,
    eligibleThreadIds: ReadonlySet<string>,
  ): PromptSnapshotCleanupBatchResult {
    const after = normalizeCleanupRowId(afterRowId);
    const through = normalizeCleanupRowId(throughRowId);
    const batchSize = normalizeCleanupBatchSize(limit);
    if (after >= through) return { scannedRows: 0, deletedRows: 0, lastScannedRowId: after };

    const cleanupTx = this.db.transaction((): PromptSnapshotCleanupBatchResult => {
      const rows = this.db
        .prepare(
          `SELECT snapshot.rowid AS row_id, snapshot.thread_id, instance.status
           FROM orch_prompt_snapshots snapshot
           LEFT JOIN orch_instances instance ON instance.id = snapshot.instance_id
           WHERE snapshot.rowid > ? AND snapshot.rowid <= ?
           ORDER BY snapshot.rowid ASC
           LIMIT ?`,
        )
        .all(after, through, batchSize) as Array<{ row_id: number; thread_id: string | null; status: string | null }>;
      if (!rows.length) return { scannedRows: 0, deletedRows: 0, lastScannedRowId: after };
      const terminalRowIds = rows
        .filter((row) => (
          isTerminalOrchestrationStatus(row.status)
          && row.thread_id != null
          && eligibleThreadIds.has(String(row.thread_id))
        ))
        .map((row) => Number(row.row_id));
      const deletedRows = terminalRowIds.length
        ? Number(this.db.prepare(
          `DELETE FROM orch_prompt_snapshots
           WHERE rowid IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
             AND instance_id IN (
               SELECT id FROM orch_instances WHERE status IN ('completed', 'failed', 'cancelled')
             )`,
        ).run(JSON.stringify(terminalRowIds)).changes ?? 0)
        : 0;
      return {
        scannedRows: rows.length,
        deletedRows,
        lastScannedRowId: Number(rows[rows.length - 1]!.row_id),
      };
    });
    return cleanupTx();
  }

  deleteByInstance(instanceId: OrchestrationId): number {
    const result = this.db.prepare("DELETE FROM orch_prompt_snapshots WHERE instance_id = ?").run(String(instanceId));
    return Number(result.changes ?? 0);
  }
}

/** 清理只认可编排定义中的三个终态。 */
function isTerminalOrchestrationStatus(status: unknown): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** 规整 SQLite rowid 高水位。 */
function normalizeCleanupRowId(raw: unknown): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** 限制 Prompt 单批扫描行数。 */
function normalizeCleanupBatchSize(raw: unknown): number {
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid prompt cleanup batch size: ${String(raw)}`);
  return Math.min(1_000, value);
}

function rowToPromptSnapshot(row: any): NodePromptSnapshot {
  const knowledge = safeParseJson<{ catalogs?: NodePromptSnapshot["knowledgeCatalogs"]; warnings?: NodePromptSnapshot["knowledgeWarnings"] }>(
    row.knowledge_catalogs_json,
    {},
  );
  const runtimePolicy = safeParseJson<NodePromptSnapshot["runtimePolicy"]>(row.runtime_policy_json, {
    workflowId: "",
    workflowName: "",
    nodeId: String(row.node_id ?? ""),
    nodeLabel: "",
    approvalMode: "auto",
    executionEngine: "codex",
    executionProfileMode: "custom",
    executionProfileLabel: "codex:custom",
    accessMode: "current",
    toolRuntimePolicy: {
      allowedToolIds: [],
      requiresWorkspaceWrite: false,
    },
    artifactPolicy: {
      persistenceMode: "db-only",
      outputMode: "text",
      primaryKind: null,
    },
  });
  const toolRegistry = safeParseJson<NodePromptSnapshot["toolRegistry"]>(row.tool_registry_json, null);
  const artifactInput = safeParseJson<NodePromptSnapshot["artifactInput"]>(row.artifact_input_json, { artifacts: [], fieldBindings: {} });
  const promptEnvelopeInput = {
    instanceId: String(row.instance_id ?? "") as OrchestrationId,
    nodeId: String(row.node_id ?? ""),
    developerMessage: row.developer_message ? String(row.developer_message) : null,
    userMessage: String(row.user_message ?? ""),
    runtimePolicy,
    toolRegistry,
    knowledgeCatalogs: knowledge.catalogs ?? [],
    knowledgeWarnings: knowledge.warnings ?? [],
    artifactInput,
  };
  const parsedPromptEnvelope = safeParseJson<NodePromptSnapshot["promptEnvelope"] | null>(row.prompt_envelope_json, null);
  const promptEnvelope = parsedPromptEnvelope
    ? normalizePromptEnvelope(parsedPromptEnvelope, promptEnvelopeInput)
    : buildLegacyPromptEnvelope(promptEnvelopeInput);
  return {
    id: String(row.id ?? ""),
    instanceId: String(row.instance_id ?? "") as OrchestrationId,
    nodeId: String(row.node_id ?? ""),
    attemptNo: Number(row.attempt_no ?? 1),
    threadId: row.thread_id ? String(row.thread_id) : null,
    turnId: row.turn_id ? String(row.turn_id) : null,
    engine: String(row.engine ?? "claude") as NodePromptSnapshot["engine"],
    model: row.model ? String(row.model) : null,
    effort: row.effort ? String(row.effort) : null,
    purpose: row.purpose === "gate-evaluation" ? "gate-evaluation" : row.purpose === "node-execution" ? "node-execution" : null,
    promptEnvelope,
    systemMessage: String(row.system_message ?? ""),
    developerMessage: row.developer_message ? String(row.developer_message) : null,
    userMessage: String(row.user_message ?? ""),
    renderedInputPreview: String(row.rendered_input_preview ?? ""),
    runtimePolicy,
    toolRegistry,
    knowledgeCatalogs: knowledge.catalogs ?? [],
    knowledgeWarnings: knowledge.warnings ?? [],
    artifactInput,
    contentLoaded: true,
    createdAt: Number(row.created_at ?? 0),
  };
}

/** 将数据库行映射成轻量快照摘要，不携带完整 prompt 正文。 */
function rowToPromptSnapshotSummary(row: any): NodePromptSnapshot {
  return {
    id: String(row.id ?? ""),
    instanceId: String(row.instance_id ?? "") as OrchestrationId,
    nodeId: String(row.node_id ?? ""),
    attemptNo: Number(row.attempt_no ?? 1),
    threadId: row.thread_id ? String(row.thread_id) : null,
    turnId: row.turn_id ? String(row.turn_id) : null,
    engine: String(row.engine ?? "claude") as NodePromptSnapshot["engine"],
    model: row.model ? String(row.model) : null,
    effort: row.effort ? String(row.effort) : null,
    purpose: row.purpose === "gate-evaluation" ? "gate-evaluation" : row.purpose === "node-execution" ? "node-execution" : null,
    contentLoaded: false,
    createdAt: Number(row.created_at ?? 0),
  } as NodePromptSnapshot;
}

/** 将外部 limit 规整为正整数；无效值表示不裁剪。 */
function normalizeListLimit(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/** Backfills newly required task fields for older structured prompt envelopes. */
function normalizePromptEnvelope(
  envelope: NodePromptSnapshot["promptEnvelope"],
  input: {
    developerMessage: string | null;
    userMessage: string;
    artifactInput: NodePromptSnapshot["artifactInput"];
  },
): NodePromptSnapshot["promptEnvelope"] {
  const rawTask = isPlainRecord((envelope as any).task) ? (envelope as any).task : {};
  const title = normalizePromptText(rawTask.title)
    || extractXmlText(input.userMessage, "task_title")
    || normalizePromptText(rawTask.goal)
    || "历史快照未保存需求标题";
  const titlePathSegment = normalizePromptText(rawTask.titlePathSegment)
    || extractXmlText(input.userMessage, "task_title_path_segment")
    || title;
  return {
    ...envelope,
    task: {
      ...rawTask,
      title,
      titlePathSegment,
      goal: normalizePromptText(rawTask.goal) || "历史快照未保存结构化任务目标，请结合 userMessage 原文理解本轮任务。",
      background: rawTask.background ?? null,
      acceptanceCriteria: Array.isArray(rawTask.acceptanceCriteria) ? rawTask.acceptanceCriteria : null,
      renderedTaskInput: typeof rawTask.renderedTaskInput === "string" ? rawTask.renderedTaskInput : input.developerMessage ?? "",
      fieldBindings: isPlainRecord(rawTask.fieldBindings) ? rawTask.fieldBindings as Record<string, string> : input.artifactInput.fieldBindings ?? {},
    },
  };
}

/** Extracts a simple XML text tag value from persisted prompt text. */
function extractXmlText(raw: string, tagName: string): string {
  const match = String(raw ?? "").match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  return normalizePromptText(decodeXmlText(match?.[1] ?? ""));
}

/** Decodes the XML entities emitted by promptRenderer text nodes. */
function decodeXmlText(raw: string): string {
  return String(raw ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Normalizes prompt metadata to a single line without treating it as executable text. */
function normalizePromptText(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/** Checks for plain JSON-like objects before reading legacy fields. */
function isPlainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Rehydrates older prompt snapshots that predate structured prompt-envelope persistence. */
function buildLegacyPromptEnvelope(input: {
  instanceId: OrchestrationId;
  nodeId: string;
  developerMessage: string | null;
  userMessage: string;
  runtimePolicy: NodePromptSnapshot["runtimePolicy"];
  toolRegistry: NodePromptSnapshot["toolRegistry"];
  knowledgeCatalogs: NodePromptSnapshot["knowledgeCatalogs"];
  knowledgeWarnings: NodePromptSnapshot["knowledgeWarnings"];
  artifactInput: NodePromptSnapshot["artifactInput"];
}): NodePromptSnapshot["promptEnvelope"] {
  return {
    schemaVersion: "node-prompt-envelope/v1",
    meta: {
      scene: "orchestration-node",
      instanceId: input.instanceId,
      workflowId: input.runtimePolicy.workflowId,
      workflowName: input.runtimePolicy.workflowName,
      nodeId: input.nodeId,
      nodeLabel: input.runtimePolicy.nodeLabel || input.nodeId,
      intent: /人工反馈|重做|最新文件内容为准/.test(input.userMessage) ? "rework-current-node" : "execute",
    },
    role: {
      roleId: "__legacy_prompt_snapshot__" as any,
      name: "历史快照",
      description: "该快照生成时尚未保存结构化 prompt envelope，请以 system/developer/user 原文为准。",
      responsibility: null,
      systemPrompt: null,
      formalTemplateName: "历史快照模板",
      inputDefinition: {
        instructions: "",
        requiredFields: [],
      },
      outputDefinition: {
        instructions: "",
        deliveryMode: "direct",
        format: "markdown",
        resultKey: null,
        filePathRule: null,
        files: [],
        requiredFields: [],
      },
    },
    task: {
      title: "历史快照未保存需求标题",
      titlePathSegment: "历史快照未保存需求标题",
      goal: "历史快照未保存结构化任务目标，请结合 userMessage 原文理解本轮任务。",
      background: null,
      acceptanceCriteria: null,
      renderedTaskInput: input.developerMessage ?? "",
      fieldBindings: input.artifactInput.fieldBindings ?? {},
    },
    artifacts: {
      upstreamArtifacts: input.artifactInput.artifacts ?? [],
    },
    knowledge: {
      catalogs: input.knowledgeCatalogs ?? [],
      warnings: input.knowledgeWarnings ?? [],
    },
    review: {
      feedbackPatch: null,
    },
    runtime: {
      runtimePolicy: input.runtimePolicy,
      toolRegistry: input.toolRegistry ?? null,
    },
  };
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

