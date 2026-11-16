import type {
  Artifact,
  ExecutableToolDescriptor,
  FeedbackRecord,
  NodePromptSnapshot,
  OrchestrationEventRecord,
  OrchestrationInstance,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";

const RUNTIME_EVIDENCE_TOOLSET_ID = "__runtime_evidence__";
const RUNTIME_EVIDENCE_TOOL_ID = "runtime.inspectInstanceEvidence";
const DEFAULT_PROMPT_SECTION_MAX_CHARS = 12_000;

type RuntimeEvidenceDb = Pick<
  ClientDb,
  "orchInstances" | "orchArtifacts" | "orchFeedback" | "orchPromptSnapshots" | "orchEvents"
>;

export class RuntimeEvidenceService {
  constructor(
    private readonly deps: {
      db: RuntimeEvidenceDb;
      instance: OrchestrationInstance;
    },
  ) {}

  buildBuiltinTools(): ExecutableToolDescriptor[] {
    return [{
      toolsetId: RUNTIME_EVIDENCE_TOOLSET_ID as any,
      toolsetName: "内建实例证据",
      toolId: RUNTIME_EVIDENCE_TOOL_ID as any,
      name: "查看实例运行证据",
      alias: null,
      description: "查看当前实例的节点状态、审核记录、工件版本、事件时间线，以及指定节点的 prompt 快照。",
      runtime: "builtin",
      usageGuidance: "当您要核对“这个实例到底发生了什么”，尤其是审核链路、版本覆盖和 prompt 实际输入时优先使用。",
      invocationHint: "先用 mode=summary 看全局，再按需要用 mode=prompt 或 mode=events 下钻到具体节点。",
      code: "",
      inputSchema: JSON.stringify({
        type: "object",
        properties: {
          mode: { type: "string" },
          nodeId: { type: "string" },
          attemptNo: { type: "number" },
          limit: { type: "number" },
          eventTypes: {
            type: "array",
            items: { type: "string" },
          },
          maxCharsPerSection: { type: "number" },
        },
      }),
      outputSchema: JSON.stringify({
        type: "object",
        required: ["mode", "instanceId"],
        properties: {
          mode: { type: "string" },
          instanceId: { type: "string" },
        },
      }),
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }];
  }

  /** 同步读取证据，由工具执行 owner 为完整读取段授予数据库许可。 */
  executeBuiltinTool(tool: ExecutableToolDescriptor, input: unknown) {
    if (String(tool.toolId) !== RUNTIME_EVIDENCE_TOOL_ID) {
      throw new Error(`未知实例证据工具：${tool.toolId}`);
    }
    const params = asRecord(input);
    const mode = String(params.mode ?? "summary").trim().toLowerCase();
    switch (mode) {
      case "summary":
        return this.buildSummary();
      case "prompt":
        return this.buildPromptDetail(params);
      case "events":
        return this.buildEventDetail(params);
      default:
        throw new Error(`参数错误：mode 只支持 summary / prompt / events，收到 ${mode || "(empty)"}`);
    }
  }

  private buildSummary() {
    const instance = this.resolveLatestInstance();
    const artifacts = this.deps.db.orchArtifacts.listByInstance(instance.id);
    const feedbackRecords = this.deps.db.orchFeedback.listByInstance(instance.id);
    const promptSnapshots = this.deps.db.orchPromptSnapshots.listByInstance(instance.id);

    return {
      mode: "summary",
      instanceId: instance.id,
      workflowId: instance.workflowId,
      workflowName: instance.workflowSnapshot.name,
      instanceStatus: instance.status,
      nodes: instance.workflowSnapshot.nodes.map((node) => {
        const nodeState = instance.nodeStates[node.id] ?? null;
        const nodeArtifacts = artifacts
          .filter((artifact) => artifact.nodeId === node.id)
          .map((artifact) => summarizeArtifact(artifact));
        const nodeFeedback = feedbackRecords
          .filter((record) => record.nodeId === node.id)
          .map((record) => summarizeFeedback(record));
        const nodePrompts = promptSnapshots
          .filter((snapshot) => snapshot.nodeId === node.id)
          .map((snapshot) => ({
            promptSnapshotId: snapshot.id,
            attemptNo: snapshot.attemptNo,
            threadId: snapshot.threadId ?? null,
            createdAt: snapshot.createdAt,
          }));
        return {
          nodeId: node.id,
          nodeLabel: node.label,
          nodeType: node.type,
          status: nodeState?.status ?? "pending",
          threadId: nodeState?.threadId ?? null,
          retryCount: nodeState?.retryCount ?? 0,
          startedAt: nodeState?.startedAt ?? null,
          completedAt: nodeState?.completedAt ?? null,
          error: nodeState?.error ?? null,
          artifacts: nodeArtifacts,
          feedback: nodeFeedback,
          promptSnapshots: nodePrompts,
        };
      }),
    };
  }

  private buildPromptDetail(params: Record<string, unknown>) {
    const instance = this.resolveLatestInstance();
    const nodeId = readRequiredString(params, "nodeId");
    const node = instance.workflowSnapshot.nodes.find((item) => item.id === nodeId) ?? null;
    if (!node) {
      throw new Error(`参数错误：当前实例不存在节点 ${nodeId}`);
    }
    const snapshots = this.deps.db.orchPromptSnapshots.listByNode(instance.id, nodeId);
    if (!snapshots.length) {
      throw new Error(`当前节点 ${node.label} 还没有 prompt 快照`);
    }
    const requestedAttempt = Number(params.attemptNo ?? snapshots.at(-1)?.attemptNo ?? 0);
    const snapshot = snapshots.find((item) => item.attemptNo === requestedAttempt) ?? null;
    if (!snapshot) {
      throw new Error(`参数错误：节点 ${node.label} 不存在第 ${requestedAttempt} 次 prompt 快照`);
    }
    const maxCharsPerSection = clampNumber(params.maxCharsPerSection, 1_000, 80_000, DEFAULT_PROMPT_SECTION_MAX_CHARS);
    return {
      mode: "prompt",
      instanceId: instance.id,
      workflowName: instance.workflowSnapshot.name,
      nodeId: node.id,
      nodeLabel: node.label,
      selectedAttemptNo: snapshot.attemptNo,
      totalAttempts: snapshots.length,
      snapshot: {
        promptSnapshotId: snapshot.id,
        threadId: snapshot.threadId ?? null,
        turnId: snapshot.turnId ?? null,
        engine: snapshot.engine,
        model: snapshot.model ?? null,
        effort: snapshot.effort ?? null,
        createdAt: snapshot.createdAt,
        promptEnvelope: truncateForTool(JSON.stringify(snapshot.promptEnvelope, null, 2), maxCharsPerSection),
        runtimePolicy: snapshot.runtimePolicy,
        artifactInput: snapshot.artifactInput,
        messages: {
          system: truncateForTool(snapshot.systemMessage, maxCharsPerSection),
          developer: truncateForTool(snapshot.developerMessage ?? "", maxCharsPerSection),
          user: truncateForTool(snapshot.userMessage, maxCharsPerSection),
        },
      },
    };
  }

  private buildEventDetail(params: Record<string, unknown>) {
    const instance = this.resolveLatestInstance();
    const nodeId = String(params.nodeId ?? "").trim();
    const limit = clampNumber(params.limit, 1, 200, 50);
    const eventTypes = normalizeStringArray(params.eventTypes);
    let events = this.deps.db.orchEvents.listByInstance(instance.id);
    if (nodeId) {
      events = events.filter((event) => String(event.nodeId ?? "") === nodeId);
    }
    if (eventTypes?.length) {
      const allowed = new Set(eventTypes);
      events = events.filter((event) => allowed.has(event.type));
    }
    const sliced = events.slice(-limit);
    return {
      mode: "events",
      instanceId: instance.id,
      workflowName: instance.workflowSnapshot.name,
      nodeId: nodeId || null,
      eventTypes: eventTypes ?? [],
      events: sliced.map((event) => summarizeEvent(event)),
    };
  }

  private resolveLatestInstance(): OrchestrationInstance {
    return this.deps.db.orchInstances.get(this.deps.instance.id) ?? this.deps.instance;
  }
}

function summarizeArtifact(artifact: Artifact) {
  return {
    artifactId: artifact.id,
    nodeId: artifact.nodeId,
    kind: artifact.kind,
    version: artifact.version,
    status: artifact.status,
    title: artifact.title,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function summarizeFeedback(record: FeedbackRecord) {
  return {
    feedbackRecordId: record.id,
    nodeId: record.nodeId,
    action: record.action,
    feedback: String(record.feedback ?? "").trim() || null,
    artifactIds: record.artifactIds ?? null,
    createdAt: record.createdAt,
  };
}

function summarizeEvent(event: OrchestrationEventRecord) {
  const payload = safeParseJson<Record<string, unknown>>(event.payloadJson, {});
  return {
    eventId: event.id,
    nodeId: event.nodeId ?? null,
    type: event.type,
    createdAt: event.createdAt,
    payload,
  };
}

function truncateForTool(text: string, maxChars: number) {
  const raw = String(text ?? "");
  if (raw.length <= maxChars) {
    return {
      text: raw,
      truncated: false,
      originalLength: raw.length,
    };
  }
  return {
    text: `${raw.slice(0, maxChars)}\n\n...(已截断)`,
    truncated: true,
    originalLength: raw.length,
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function readRequiredString(input: Record<string, unknown>, key: string): string {
  const value = String(input[key] ?? "").trim();
  if (!value) {
    throw new Error(`参数错误：${key}`);
  }
  return value;
}

function normalizeStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const values = raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  return values.length ? values : null;
}

function clampNumber(raw: unknown, min: number, max: number, fallback: number) {
  const value = Math.floor(Number(raw ?? fallback));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

