import crypto from "node:crypto";

import type {
  NodeArtifactInput,
  ResolvedNodeContext,
  OrchestrationMetricAgentHandoffFact,
  OrchestrationMetricCollectRequest,
  OrchestrationMetricCollectResponse,
  OrchestrationMetricConformanceFact,
  OrchestrationMetricContextCompactionFact,
  OrchestrationMetricContractFact,
  OrchestrationMetricEvaluationFact,
  OrchestrationMetricInstanceFact,
  OrchestrationMetricNodeFact,
  OrchestrationMetricQualityEventFact,
  OrchestrationMetricQualityEventType,
  OrchestrationMetricStateSegmentFact,
  OrchestrationMetricStateSegmentType,
  OrchestrationMetricStatus,
  OrchestrationMetricTraceFact,
  OrchestrationMetricValidationStatus,
} from "@codeflowai/shared";
import {
  ORCHESTRATION_METRIC_DEFINITION_VERSION,
  ORCHESTRATION_METRIC_SCHEMA_VERSION,
  calculateRelayCostMicros,
  inferRoleArtifactOutputMode,
  normalizeRoleOutputDefinition,
  requireRelayInvocationPriceSnapshot,
} from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { logger } from "../../logger.js";
import { buildPromptDefinitionHash } from "../../orchestration/promptDefinitionHash.js";

type InstanceRow = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  workflow_snapshot_json: string;
  role_snapshots_json: string | null;
  intake_snapshot_json: string;
  status: string;
  node_states_json: string;
  master_thread_id: string | null;
  created_at: number;
  updated_at: number;
  source_updated_at: number;
  terminal_at?: number | null;
};

type EventRow = {
  id: string;
  node_id: string | null;
  type: string;
  payload_json: string | null;
  created_at: number;
};

type FeedbackRow = {
  node_id: string | null;
  action: string;
  created_at: number;
};

type ArtifactStatusRow = {
  id: string;
  node_id: string;
  kind: string;
  version: number;
  status: string;
  updated_at: number;
};

type ArtifactFieldRow = {
  artifact_id: string;
  node_id: string;
  result_name: string;
  field_key: string;
  required: number;
  validation_status: string;
  updated_at: number;
};

type PromptSnapshotRow = {
  id: string;
  node_id: string;
  attempt_no: number;
  thread_id: string | null;
  turn_id: string | null;
  engine: string;
  model: string | null;
  effort: string | null;
  prompt_envelope_json: string | null;
  system_message: string;
  developer_message: string | null;
  user_message: string;
  artifact_input_json?: string | null;
  created_at: number;
};

type NodeContextResolutionRow = {
  node_id: string;
  attempt_no: number;
  status: string;
  context_json: string;
  created_at: number;
};

export type AgentHandoffContextEvidence = {
  nodeId: string;
  attemptNo: number;
  status: ResolvedNodeContext["status"];
  context: ResolvedNodeContext;
  createdAt: number;
};

export type AgentHandoffPromptEvidence = {
  id: string;
  nodeId: string;
  attemptNo: number;
  artifactInput: NodeArtifactInput;
  createdAt: number;
};

type ConversationMetricEventRow = {
  seq: number;
  type: string;
  event_json: string;
  ts: number;
};

export type ContextCompactionTurnEvidence = {
  turnId: string;
  status: string;
  startEventSeq: number | null;
  endEventSeq: number | null;
  endedAt: number | null;
};

export type ContextCompactionEventEvidence = ConversationMetricEventRow & {
  engine: string;
};

type TraceBuildResult = {
  fact: OrchestrationMetricTraceFact;
  toolSegments: OrchestrationMetricStateSegmentFact[];
  ineffectiveLoopCount: number;
};

type MetricBuildResult = {
  instance: OrchestrationMetricInstanceFact;
  nodes: OrchestrationMetricNodeFact[];
  qualityEvents: OrchestrationMetricQualityEventFact[];
  stateSegments: OrchestrationMetricStateSegmentFact[];
  contractFacts: OrchestrationMetricContractFact[];
  conformanceFacts: OrchestrationMetricConformanceFact[];
  traceFacts: OrchestrationMetricTraceFact[];
  contextCompactionFacts: OrchestrationMetricContextCompactionFact[];
  agentHandoffFacts: OrchestrationMetricAgentHandoffFact[];
  evaluationFacts: OrchestrationMetricEvaluationFact[];
  missingStartedAt: boolean;
  missingCompletedAt: boolean;
  missingValidation: boolean;
  invalidPayload: boolean;
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const METRIC_ARTIFACT_CONTRACT_STATUSES = new Set(["approved", "published", "rejected", "draft", "superseded", "missing"]);
const WORKFLOW_SNAPSHOT_CACHE_MAX_ENTRIES = 32;
const parseWorkflowSnapshotWithQuality = createWorkflowSnapshotParser();
type CollectionSnapshot = {
  requestKey: string;
  collectedAt: number;
  rows: InstanceRow[];
  facts: MetricBuildResult[];
};
const collectionSnapshots = new WeakMap<object, Map<string, CollectionSnapshot>>();

/** Collects versioned orchestration metric facts for one local workspace. */
export function handleOrchMetricsCollect(ctx: ApiHandlerContext, req: ApiRequestMessage): void | Promise<void> {
  const request = normalizeCollectRequest(req.body);
  if (!request) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, code: "BAD_REQUEST", message: "参数错误：workspaceId" },
    });
    return;
  }
  if (!ctx.workspaces.has(request.workspaceId as never)) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 404,
      body: { ok: false, code: "NOT_FOUND", message: `未知 workspaceId：${request.workspaceId}` },
    });
    return;
  }
  if (asRecord(req.body).syncCodeAttribution === true) {
    if (!ctx.syncCodeAttribution) throw new Error("CODE_ATTRIBUTION_DEMAND_OWNER_UNAVAILABLE");
    return ctx.syncCodeAttribution(request.workspaceId, request.roundId ?? undefined).then(() => {
      ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
    });
  }

  const now = Date.now();
  const snapshots = collectionSnapshots.get(ctx.db.db) ?? new Map<string, CollectionSnapshot>();
  collectionSnapshots.set(ctx.db.db, snapshots);
  for (const [id, snapshot] of snapshots) if (now - snapshot.collectedAt > 5 * 60_000) snapshots.delete(id);
  const requestKey = JSON.stringify({ ...request, cursor: null, snapshotId: null, limit: null });
  const snapshotId = request.snapshotId ?? crypto.randomUUID();
  let snapshot = request.snapshotId ? snapshots.get(snapshotId) : undefined;
  if ((request.cursor && !request.snapshotId) || (request.snapshotId && (!snapshot || snapshot.requestKey !== requestKey))) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: {
      ok: false, code: "ORCH_METRICS_SNAPSHOT_EXPIRED", message: "采集快照已失效，请重新开始本轮采集。",
    } });
    return;
  }
  if (!snapshot) {
    snapshot = ctx.db.db.transaction(() => {
      const rows = listCandidateInstances(ctx, request);
      return { requestKey, collectedAt: now, rows, facts: rows.map(row => buildMetricFacts(ctx, row, request, req.id)) };
    })();
    snapshots.set(snapshotId, snapshot);
    while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
  }
  const { rows, collectedAt } = snapshot;
  const offset = normalizeCursorOffset(request.cursor);
  const limit = normalizeLimit(request.limit);
  const pageRows = rows.slice(offset, offset + limit);
  const nextOffset = offset + pageRows.length;
  const buildResults = snapshot.facts.slice(offset, offset + limit);

  const response: OrchestrationMetricCollectResponse = {
    snapshotId,
    metricSchemaVersion: ORCHESTRATION_METRIC_SCHEMA_VERSION,
    metricDefinitionVersion: ORCHESTRATION_METRIC_DEFINITION_VERSION,
    collectedAt,
    sourceWorkspaceId: request.workspaceId,
    instances: buildResults.map((item) => item.instance),
    nodes: buildResults.flatMap((item) => item.nodes),
    qualityEvents: buildResults.flatMap((item) => item.qualityEvents),
    stateSegments: buildResults.flatMap((item) => item.stateSegments),
    contractFacts: buildResults.flatMap((item) => item.contractFacts),
    conformanceFacts: buildResults.flatMap((item) => item.conformanceFacts),
    traceFacts: buildResults.flatMap((item) => item.traceFacts),
    contextCompactionFacts: buildResults.flatMap((item) => item.contextCompactionFacts),
    agentHandoffFacts: buildResults.flatMap((item) => item.agentHandoffFacts),
    evaluationFacts: buildResults.flatMap((item) => item.evaluationFacts),
    coverage: {
      sourceCount: 1,
      onlineSourceCount: 1,
      offlineSourceCount: 0,
      instanceCount: pageRows.length,
      missingStartedAtCount: buildResults.filter((item) => item.missingStartedAt).length,
      missingCompletedAtCount: buildResults.filter((item) => item.missingCompletedAt).length,
      missingValidationCount: buildResults.filter((item) => item.missingValidation).length,
      missingRawTraceCount: buildResults.filter((item) => item.instance.conversationEventCount > 0 && item.instance.rawEngineEventCount === 0).length,
      invalidPayloadCount: buildResults.filter((item) => item.invalidPayload).length,
      truncatedSourceCount: 0,
      latestSourceUpdatedAt: pageRows.reduce((max, row) => Math.max(max, Number(row.source_updated_at ?? row.updated_at ?? 0)), 0) || null,
      collectedAt,
    },
    hasMore: nextOffset < rows.length,
    nextCursor: nextOffset < rows.length ? String(nextOffset) : null,
  };
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...response } });
}

/** 保留采集轮次与快照身份，后续页只读取首次冻结事实。 */
function normalizeCollectRequest(value: unknown): OrchestrationMetricCollectRequest | null {
  const record = asRecord(value);
  const workspaceId = readString(record.workspaceId);
  if (!workspaceId) return null;
  const filters = asRecord(record.filters);
  return {
    roundId: readString(record.roundId) || null,
    snapshotId: readString(record.snapshotId) || null,
    workspaceId,
    scope: {
      scopeKind: record.scope && typeof record.scope === "object"
        ? (readString(asRecord(record.scope).scopeKind) as OrchestrationMetricCollectRequest["scope"]["scopeKind"] || "mine")
        : "mine",
      scopeId: record.scope && typeof record.scope === "object" ? readString(asRecord(record.scope).scopeId) : null,
    },
    filters: {
      from: readOptionalNumber(filters.from),
      to: readOptionalNumber(filters.to),
      workflowIds: readStringArray(filters.workflowIds),
      statuses: readStringArray(filters.statuses).filter(isMetricStatus),
    },
    allowedResourceIds: readStringArray(record.allowedResourceIds),
    cursor: readString(record.cursor) || null,
    limit: readOptionalNumber(record.limit),
    sinceUpdatedAt: readOptionalNumber(record.sinceUpdatedAt),
  };
}

/** Filters instances by their single result-time anchor using half-open time ranges. */
function listCandidateInstances(ctx: ApiHandlerContext, request: OrchestrationMetricCollectRequest): InstanceRow[] {
  const rows = ctx.db.db.prepare(`
    SELECT i.id, i.workspace_id, i.workflow_id, i.workflow_snapshot_json, i.role_snapshots_json, i.intake_snapshot_json,
           i.status, i.node_states_json, i.master_thread_id, i.created_at, i.updated_at,
           MAX(
             i.updated_at,
              COALESCE((SELECT MAX(e.created_at) FROM orch_events e WHERE e.instance_id = i.id), 0),
              COALESCE((SELECT MAX(f.created_at) FROM orch_feedback_records f WHERE f.instance_id = i.id), 0),
              COALESCE((SELECT MAX(a.updated_at) FROM orch_artifacts a WHERE a.instance_id = i.id), 0),
              COALESCE((SELECT MAX(af.updated_at) FROM orch_artifact_fields af WHERE af.instance_id = i.id), 0)
            ) AS source_updated_at,
           (SELECT MAX(e.created_at)
              FROM orch_events e
             WHERE e.instance_id = i.id
               AND e.type IN ('orchestration.completed', 'orchestration.cancelled')) AS terminal_at
      FROM orch_instances i
     WHERE workspace_id = ?
  `).all(request.workspaceId) as InstanceRow[];
  const threadIdsByInstance = new Map<string, string[]>();
  const allThreadIds: string[] = [];
  for (const row of rows) {
    const threadIds = collectThreadIds(row, safeParseRecord(row.node_states_json));
    threadIdsByInstance.set(row.id, threadIds);
    allThreadIds.push(...threadIds);
  }
  const latestTraceTimestampByThread = listLatestTraceTimestamps(ctx, allThreadIds);
  for (const row of rows) {
    const latestTraceTimestamp = (threadIdsByInstance.get(row.id) ?? [])
      .reduce((max, threadId) => Math.max(max, latestTraceTimestampByThread.get(threadId) ?? 0), 0);
    row.source_updated_at = Math.max(Number(row.source_updated_at ?? row.updated_at ?? 0), latestTraceTimestamp);
  }
  rows.sort((left, right) => {
    const timeDiff = Number(right.source_updated_at ?? 0) - Number(left.source_updated_at ?? 0);
    if (timeDiff !== 0) return timeDiff;
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  });
  const allowedIntakeIds = new Set(request.allowedResourceIds ?? []);
  const workflowIds = new Set(request.filters?.workflowIds ?? []);
  const statuses = new Set(request.filters?.statuses ?? []);
  const from = normalizeTimeFilter(request.filters?.from);
  const to = normalizeTimeFilter(request.filters?.to);
  const sinceUpdatedAt = normalizeTimeFilter(request.sinceUpdatedAt);
  return rows.filter((row) => {
    const intake = safeParseRecord(row.intake_snapshot_json);
    const intakeId = readString(intake.id);
    if (allowedIntakeIds.size > 0 && !allowedIntakeIds.has(intakeId)) return false;
    if (workflowIds.size > 0 && !workflowIds.has(String(row.workflow_id ?? ""))) return false;
    if (statuses.size > 0 && !statuses.has(normalizeMetricStatus(row.status))) return false;
    const updatedAt = Number(row.source_updated_at ?? row.updated_at ?? 0);
    const resultAt = deriveRowResultTime(row);
    if (from !== null && resultAt < from) return false;
    if (to !== null && resultAt >= to) return false;
    if (sinceUpdatedAt !== null && updatedAt < sinceUpdatedAt) return false;
    return true;
  });
}

/** Resolves one event-time anchor so a terminal instance belongs to only one result period. */
function deriveRowResultTime(row: InstanceRow): number {
  if (!TERMINAL_STATUSES.has(normalizeMetricStatus(row.status))) return Number(row.created_at ?? row.updated_at ?? 0);
  const terminalAt = Number(row.terminal_at ?? 0);
  if (terminalAt > 0) return terminalAt;
  const updatedAt = Number(row.updated_at ?? 0);
  if (updatedAt > 0) return updatedAt;
  const nodeStates = safeParseRecord(row.node_states_json);
  const completedAt = Object.values(nodeStates)
    .map((state) => readOptionalNumber(asRecord(state).completedAt) ?? 0)
    .reduce((max, value) => Math.max(max, value), 0);
  return completedAt || Number(row.created_at ?? 0);
}

/** Builds one instance fact set, isolating unsupported artifact rows while recording source quality. */
function buildMetricFacts(
  ctx: ApiHandlerContext,
  row: InstanceRow,
  request: OrchestrationMetricCollectRequest,
  requestId: string,
): MetricBuildResult {
  const workflowPayload = parseWorkflowSnapshotWithQuality(row.workflow_id, row.workflow_snapshot_json);
  const intakePayload = parseRecordWithQuality(row.intake_snapshot_json);
  const nodeStatePayload = parseRecordWithQuality(row.node_states_json);
  const workflow = workflowPayload.value;
  const roleSnapshots = safeParseRecord(row.role_snapshots_json);
  const intake = intakePayload.value;
  const nodeStates = nodeStatePayload.value;
  const events = listEvents(ctx, row.id);
  const invalidEventPayload = events.some((event) => parseRecordWithQuality(event.payload_json).invalid);
  const feedbackRecords = listFeedbackRecords(ctx, row.id);
  const artifactStatuses = listArtifactStatuses(ctx, row.id);
  const artifactFields = listArtifactFields(ctx, row.id);
  const excludedArtifacts = artifactStatuses.filter((artifact) => !METRIC_ARTIFACT_CONTRACT_STATUSES.has(artifact.status));
  const excludedArtifactIds = new Set(excludedArtifacts.map((artifact) => artifact.id));
  const contractArtifacts = artifactStatuses.filter((artifact) => !excludedArtifactIds.has(artifact.id));
  const contractArtifactFields = artifactFields.filter((field) => !excludedArtifactIds.has(field.artifact_id));
  // Approved degradation: malformed artifact rows are isolated to preserve the remaining instance facts.
  if (excludedArtifacts.length > 0) {
    logger.warn("orchestration-metrics", "invalid artifact excluded from metric collection", {
      code: "orch_metrics_artifact_excluded",
      requestId,
      workspaceId: request.workspaceId,
      instanceId: row.id,
      excludedArtifactCount: excludedArtifacts.length,
      artifactIds: excludedArtifacts.slice(0, 20).map((artifact) => artifact.id),
      artifactStatuses: [...new Set(excludedArtifacts.map((artifact) => artifact.status))],
      rootCause: "unsupported artifact lifecycle status",
      impact: "artifact contract and related fields excluded; remaining instance facts retained",
      recovery: "correct or remove the source artifact, then refresh orchestration metrics",
    });
  }
  const threadIds = collectThreadIds(row, nodeStates);
  const conversationEventCount = countThreadEvents(ctx, "conversation_events", threadIds);
  const rawEngineEventCount = countThreadEvents(ctx, "raw_engine_events", threadIds);
  const workflowSnapshotHash = hashFingerprint(workflow);
  const nodeFacts = buildNodeFacts(row.id, workflowSnapshotHash, workflow, roleSnapshots, nodeStates, events);
  const baseQualityEvents = [
    ...buildInstanceQualityEvents(row, events),
    ...buildNodeQualityEvents(nodeFacts, row.updated_at),
    ...buildFeedbackQualityEvents(feedbackRecords),
    ...buildEventQualityEvents(events),
    ...buildArtifactQualityEvents(artifactStatuses, row.id, row.updated_at),
  ];
  const stateSegments = buildStateSegments(row, events);
  const startedAt = deriveInstanceStartedAt(row, nodeFacts);
  const completedAt = deriveInstanceCompletedAt(row, nodeFacts, events);
  const validation = deriveValidation(nodeStates);
  const retryCount = countRetries(nodeFacts, feedbackRecords);
  const reworkCount = feedbackRecords.filter((item) => item.action === "rework_to_target").length;
  const artifactCount = artifactStatuses.length;
  const conformanceFacts = buildConformanceFacts(row, workflowSnapshotHash, workflow, nodeStates, nodeFacts);
  const traceResult = buildTraceFacts(ctx, row, workflowSnapshotHash, nodeFacts);
  const traceFacts = traceResult.facts;
  const contextCompactionFacts = buildContextCompactionFacts(ctx, row, traceFacts);
  const agentHandoffFacts = buildAgentHandoffFacts(ctx, row, nodeFacts);
  stateSegments.push(...traceResult.toolSegments);
  const qualityEvents = mergeQualityEvents([...baseQualityEvents, ...traceResult.qualityEvents], row.id);
  const evaluationFacts = buildTraceEvaluationFacts(traceResult.results);
  const rejectionCount = qualityEvents
    .filter((item) => item.eventType === "review_rejected")
    .reduce((sum, item) => sum + item.eventCount, 0);
  const contractFacts = buildContractFacts(
    row,
    workflowSnapshotHash,
    workflow,
    roleSnapshots,
    nodeStates,
    contractArtifacts,
    contractArtifactFields,
    events,
    traceFacts,
  );
  const instanceFields = {
    sourceUserId: request.scope.scopeKind === "mine" ? request.scope.scopeId ?? null : null,
    sourceWorkspaceId: request.workspaceId,
    sourceInstanceId: row.id,
    workflowId: String(row.workflow_id ?? ""),
    workflowName: readString(workflow.name) || "未命名流程",
    intakeId: readString(intake.id) || null,
    titleSummary: summarizeTitle(readString(intake.title) || readString(intake.goal) || row.id),
    status: normalizeMetricStatus(row.status),
    startedAt,
    completedAt,
    durationMs: startedAt !== null && completedAt !== null && completedAt >= startedAt ? completedAt - startedAt : null,
    nodeCount: new Set(nodeFacts.map((node) => node.nodeId)).size,
    retryCount,
    reworkCount,
    rejectionCount,
    validationStatus: validation.status,
    validationCheckedCount: validation.checked,
    validationPassedCount: validation.passed,
    artifactCount,
    conversationEventCount,
    rawEngineEventCount,
    updatedAt: Number(row.source_updated_at ?? row.updated_at ?? 0),
  };
  const instance: OrchestrationMetricInstanceFact = {
    ...instanceFields,
    sourceFingerprint: hashFingerprint(instanceFields),
  };
  return {
    instance,
    nodes: nodeFacts,
    qualityEvents,
    stateSegments,
    contractFacts,
    conformanceFacts,
    traceFacts,
    contextCompactionFacts,
    agentHandoffFacts,
    evaluationFacts,
    missingStartedAt: startedAt === null,
    missingCompletedAt: TERMINAL_STATUSES.has(instance.status) && completedAt === null,
    missingValidation: validation.checked === 0,
    invalidPayload: workflowPayload.invalid || intakePayload.invalid || nodeStatePayload.invalid || invalidEventPayload
      || excludedArtifacts.length > 0,
  };
}

/** Builds turn-scoped Trace facts only from persisted prompt, turn, conversation, and raw evidence. */
function buildTraceFacts(
  ctx: ApiHandlerContext,
  row: InstanceRow,
  workflowSnapshotHash: string,
  nodeFacts: OrchestrationMetricNodeFact[],
): { facts: OrchestrationMetricTraceFact[]; toolSegments: OrchestrationMetricStateSegmentFact[]; qualityEvents: OrchestrationMetricQualityEventFact[]; results: TraceBuildResult[] } {
  const snapshots = ctx.db.db.prepare(`
    SELECT id, node_id, attempt_no, thread_id, turn_id, engine, model, effort,
           prompt_envelope_json, system_message, developer_message, user_message, created_at
      FROM orch_prompt_snapshots
     WHERE instance_id = ?
       AND thread_id IS NOT NULL
       AND turn_id IS NOT NULL
     ORDER BY created_at ASC, id ASC
  `).all(row.id) as PromptSnapshotRow[];
  const executionByAttempt = new Map(nodeFacts.map((fact) => [`${fact.nodeId}\u001f${fact.attemptNo}`, fact]));
  const results = snapshots.map((snapshot) => buildTraceFact(ctx, row, workflowSnapshotHash, snapshot, executionByAttempt));
  const toolSegments = new Map<string, OrchestrationMetricStateSegmentFact>();
  for (const result of results) {
    for (const segment of result.toolSegments) toolSegments.set(segment.segmentId, segment);
  }
  const loopsByNode = new Map<string, { count: number; at: number }>();
  for (const result of results) {
    if (result.ineffectiveLoopCount <= 0) continue;
    const existing = loopsByNode.get(result.fact.nodeId);
    loopsByNode.set(result.fact.nodeId, {
      count: (existing?.count ?? 0) + result.ineffectiveLoopCount,
      at: Math.max(existing?.at ?? 0, result.fact.completedAt ?? result.fact.startedAt),
    });
  }
  const qualityEvents = [...loopsByNode.entries()].map(([nodeId, loop]) => (
    createQualityEvent(row.id, nodeId, "ineffective_loop", "trace", loop.count, loop.at)
  ));
  return { facts: results.map((result) => result.fact), toolSegments: [...toolSegments.values()], qualityEvents, results };
}

/** Builds attempt-scoped handoff facts from persisted input resolutions and prompt snapshots. */
function buildAgentHandoffFacts(
  ctx: ApiHandlerContext,
  row: InstanceRow,
  nodeFacts: OrchestrationMetricNodeFact[],
): OrchestrationMetricAgentHandoffFact[] {
  const contextRows = ctx.db.db.prepare(`
    SELECT node_id, attempt_no, status, context_json, created_at
      FROM orch_node_context_resolutions
     WHERE instance_id = ?
     ORDER BY attempt_no ASC, created_at ASC
  `).all(row.id) as NodeContextResolutionRow[];
  const promptRows = ctx.db.db.prepare(`
    SELECT id, node_id, attempt_no, artifact_input_json, created_at
      FROM orch_prompt_snapshots
     WHERE instance_id = ?
     ORDER BY created_at ASC, id ASC
  `).all(row.id) as Array<Pick<PromptSnapshotRow, "id" | "node_id" | "attempt_no" | "artifact_input_json" | "created_at">>;
  const contexts = contextRows.map((item): AgentHandoffContextEvidence => {
    const context = parseRequiredJson<ResolvedNodeContext>(item.context_json,
      `节点输入解析 JSON 损坏: instanceId=${row.id}, nodeId=${item.node_id}, attemptNo=${item.attempt_no}`);
    return {
      nodeId: String(item.node_id),
      attemptNo: Number(item.attempt_no),
      status: String(item.status) as ResolvedNodeContext["status"],
      context,
      createdAt: Number(item.created_at),
    };
  });
  const prompts = promptRows.map((item): AgentHandoffPromptEvidence => ({
    id: String(item.id),
    nodeId: String(item.node_id),
    attemptNo: Number(item.attempt_no),
    artifactInput: parseRequiredJson<NodeArtifactInput>(item.artifact_input_json,
      `Prompt Artifact 输入 JSON 损坏: instanceId=${row.id}, promptSnapshotId=${item.id}`),
    createdAt: Number(item.created_at),
  }));
  return deriveAgentHandoffFacts({ sourceInstanceId: row.id, nodeFacts, contexts, prompts });
}

/** Derives deterministic handoff facts without reading prompt or Artifact body text. */
export function deriveAgentHandoffFacts(input: {
  sourceInstanceId: string;
  nodeFacts: OrchestrationMetricNodeFact[];
  contexts: AgentHandoffContextEvidence[];
  prompts: AgentHandoffPromptEvidence[];
}): OrchestrationMetricAgentHandoffFact[] {
  const executionByAttempt = new Map(input.nodeFacts.map((fact) => [`${fact.nodeId}\u001f${fact.attemptNo}`, fact]));
  const promptsByAttempt = new Map<string, AgentHandoffPromptEvidence[]>();
  for (const prompt of input.prompts) {
    const key = `${prompt.nodeId}\u001f${prompt.attemptNo}`;
    const rows = promptsByAttempt.get(key) ?? [];
    rows.push(prompt);
    promptsByAttempt.set(key, rows);
  }
  const seenAttempts = new Set<string>();
  const facts: OrchestrationMetricAgentHandoffFact[] = [];
  for (const evidence of input.contexts) {
    const context = evidence.context;
    const attemptKey = `${evidence.nodeId}\u001f${evidence.attemptNo}`;
    if (seenAttempts.has(attemptKey)) {
      throw new Error(`编排度量交接事实发现重复解析快照: instanceId=${input.sourceInstanceId}, nodeId=${evidence.nodeId}, attemptNo=${evidence.attemptNo}`);
    }
    seenAttempts.add(attemptKey);
    if (context.inputs.length === 0) continue;
    if (context.instanceId !== input.sourceInstanceId || context.nodeId !== evidence.nodeId
      || context.attemptNo !== evidence.attemptNo || context.status !== evidence.status
      || !Number.isFinite(evidence.createdAt) || evidence.createdAt <= 0) {
      throw new Error(`编排度量交接解析快照归属无效: instanceId=${input.sourceInstanceId}, nodeId=${evidence.nodeId}, attemptNo=${evidence.attemptNo}`);
    }
    const execution = executionByAttempt.get(attemptKey);
    if (!execution) {
      throw new Error(`编排度量交接事实缺少节点 execution: instanceId=${input.sourceInstanceId}, nodeId=${evidence.nodeId}, attemptNo=${evidence.attemptNo}`);
    }
    const inputIds = context.inputs.map((item) => item.inputId);
    if (new Set(inputIds).size !== inputIds.length || inputIds.some((item) => !String(item).trim())) {
      throw new Error(`编排度量交接解析快照包含重复或空输入 ID: inputContextId=${context.contextId}`);
    }
    const prompts = (promptsByAttempt.get(attemptKey) ?? []).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const firstPrompt = prompts[0] ?? null;
    let promptReferences: NonNullable<NodeArtifactInput["inputReferences"]> = [];
    if (firstPrompt) {
      const expectedPromptShape = normalizePromptInputEvidence(firstPrompt, context);
      for (const prompt of prompts.slice(1)) {
        const currentShape = normalizePromptInputEvidence(prompt, context);
        if (JSON.stringify(currentShape) !== JSON.stringify(expectedPromptShape)) {
          throw new Error(`编排度量交接 Prompt Snapshot 在同一 Attempt 内漂移: inputContextId=${context.contextId}, promptSnapshotId=${prompt.id}`);
        }
      }
      promptReferences = firstPrompt.artifactInput.inputReferences ?? [];
    }
    const promptReferenceById = new Map(promptReferences.map((item) => [item.inputId, item]));
    const requiredInputs = context.inputs.filter((item) => item.required).sort((left, right) => left.inputId.localeCompare(right.inputId));
    const expectedReferenceIds = requiredInputs.map((item) => item.inputId);
    const availableReferenceIds = requiredInputs.filter((item) => item.status === "resolved" && item.source).map((item) => item.inputId);
    const injectedReferenceIds = requiredInputs.filter((item) => {
      const actual = promptReferenceById.get(item.inputId);
      return Boolean(firstPrompt && item.status === "resolved" && item.source && actual?.status === "resolved"
        && actual.sourceArtifactId === item.source.artifactId);
    }).map((item) => item.inputId);
    const expectedFieldReferenceIds = requiredInputs
      .filter((item) => item.config.sourceSelector.type === "field")
      .map((item) => item.inputId);
    const consumedFieldReferenceIds = requiredInputs.filter((item) => {
      if (item.config.sourceSelector.type !== "field" || !item.source) return false;
      const actual = promptReferenceById.get(item.inputId);
      return Boolean(firstPrompt && actual?.status === "resolved"
        && actual.sourceArtifactId === item.source.artifactId
        && actual.sourceFieldKey === item.config.sourceSelector.fieldKey);
    }).map((item) => item.inputId);
    const missingReasons = context.inputs
      .filter((item) => item.status !== "resolved")
      .map((item) => ({ inputId: item.inputId, errorCode: String(item.errorCode ?? item.status) }))
      .sort((left, right) => left.inputId.localeCompare(right.inputId));
    const fields = {
      sourceInstanceId: input.sourceInstanceId,
      nodeId: evidence.nodeId,
      nodeExecutionId: execution.nodeExecutionId,
      attemptNo: evidence.attemptNo,
      inputContextId: context.contextId,
      promptSnapshotId: firstPrompt?.id ?? null,
      resolutionStatus: context.status,
      expectedReferenceIds,
      availableReferenceIds,
      injectedReferenceIds,
      expectedFieldReferenceIds,
      consumedFieldReferenceIds,
      missingReasons,
      observedAt: firstPrompt?.createdAt ?? evidence.createdAt,
    };
    facts.push({ ...fields, sourceFingerprint: hashFingerprint(fields) });
  }
  return facts.sort((left, right) => left.observedAt - right.observedAt || left.nodeExecutionId.localeCompare(right.nodeExecutionId));
}

/** Normalizes one prompt's structural handoff evidence and verifies its context binding. */
function normalizePromptInputEvidence(prompt: AgentHandoffPromptEvidence, context: ResolvedNodeContext): unknown {
  if (prompt.artifactInput.inputContextId !== context.contextId || !Array.isArray(prompt.artifactInput.inputReferences)) {
    throw new Error(`编排度量交接 Prompt Snapshot 缺少一致的输入上下文: inputContextId=${context.contextId}, promptSnapshotId=${prompt.id}`);
  }
  const references = [...prompt.artifactInput.inputReferences]
    .sort((left, right) => left.inputId.localeCompare(right.inputId));
  if (new Set(references.map((item) => item.inputId)).size !== references.length) {
    throw new Error(`编排度量交接 Prompt Snapshot 包含重复输入 ID: promptSnapshotId=${prompt.id}`);
  }
  return { inputContextId: prompt.artifactInput.inputContextId, references };
}

/** Parses required local JSON evidence and fails with business identity instead of returning an empty value. */
function parseRequiredJson<T>(raw: unknown, message: string): T {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(message);
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${message}; reason=${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Builds compaction facts from persisted node-thread events without treating compact turns as task success. */
function buildContextCompactionFacts(
  ctx: ApiHandlerContext,
  row: InstanceRow,
  traceFacts: OrchestrationMetricTraceFact[],
): OrchestrationMetricContextCompactionFact[] {
  const tracesByThread = new Map<string, OrchestrationMetricTraceFact[]>();
  for (const trace of traceFacts) {
    const traces = tracesByThread.get(trace.threadId) ?? [];
    traces.push(trace);
    tracesByThread.set(trace.threadId, traces);
  }
  const facts: OrchestrationMetricContextCompactionFact[] = [];
  const sourceUpdatedAt = TERMINAL_STATUSES.has(normalizeMetricStatus(row.status))
    ? deriveRowResultTime(row)
    : Number(row.source_updated_at ?? row.updated_at ?? 0);
  for (const [threadId, traces] of tracesByThread) {
    const nodeIds = new Set(traces.map((trace) => trace.nodeId));
    if (nodeIds.size !== 1) {
      throw new Error(`编排度量上下文压缩线程跨节点复用：instanceId=${row.id}, threadId=${threadId}`);
    }
    const turns = ctx.db.db.prepare(`
      SELECT turn_id, status, start_event_seq, end_event_seq, ended_at
        FROM thread_turns
       WHERE thread_id = ?
       ORDER BY start_event_seq ASC, started_at ASC, turn_id ASC
    `).all(threadId) as Array<{
      turn_id: string;
      status: string;
      start_event_seq: number | null;
      end_event_seq: number | null;
      ended_at: number | null;
    }>;
    const traceTurnIds = new Set(traces.map((trace) => trace.turnId));
    const firstTraceEventSeq = turns
      .filter((turn) => traceTurnIds.has(String(turn.turn_id)))
      .map((turn) => turn.start_event_seq)
      .filter((seq): seq is number => seq !== null)
      .reduce((min, seq) => Math.min(min, seq), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(firstTraceEventSeq)) continue;
    const events = ctx.db.db.prepare(`
      SELECT seq, engine, type, event_json, ts
        FROM conversation_events
       WHERE thread_id = ? AND seq >= ? AND ts <= ?
         AND type IN ('system.notice', 'turn.completed', 'turn.error')
       ORDER BY seq ASC
    `).all(threadId, firstTraceEventSeq, sourceUpdatedAt) as ContextCompactionEventEvidence[];
    facts.push(...deriveContextCompactionFacts({
      sourceInstanceId: row.id,
      nodeId: [...nodeIds][0]!,
      threadId,
      observedThrough: sourceUpdatedAt,
      traces,
      turns: turns.map((turn) => ({
        turnId: String(turn.turn_id),
        status: String(turn.status),
        startEventSeq: turn.start_event_seq == null ? null : Number(turn.start_event_seq),
        endEventSeq: turn.end_event_seq == null ? null : Number(turn.end_event_seq),
        endedAt: turn.ended_at == null ? null : Number(turn.ended_at),
      })),
      events,
    }));
  }
  return facts.sort((left, right) => left.compactionEventSeq - right.compactionEventSeq);
}

/** Derives deterministic context-compaction facts from one persisted orchestration node thread. */
export function deriveContextCompactionFacts(input: {
  sourceInstanceId: string;
  nodeId: string;
  threadId: string;
  observedThrough: number;
  traces: OrchestrationMetricTraceFact[];
  turns: ContextCompactionTurnEvidence[];
  events: ContextCompactionEventEvidence[];
}): OrchestrationMetricContextCompactionFact[] {
  if (!Number.isFinite(input.observedThrough) || input.observedThrough <= 0) {
    throw new Error(`编排度量上下文压缩采集上界无效：instanceId=${input.sourceInstanceId}, observedThrough=${input.observedThrough}`);
  }
  const turnById = new Map<string, ContextCompactionTurnEvidence>();
  for (const turn of input.turns) {
    if (turnById.has(turn.turnId)) throw new Error(`编排度量上下文压缩发现重复 Turn：threadId=${input.threadId}, turnId=${turn.turnId}`);
    turnById.set(turn.turnId, turn);
  }
  const traceByTurnId = new Map<string, OrchestrationMetricTraceFact>();
  for (const trace of input.traces) {
    if (trace.threadId !== input.threadId || trace.nodeId !== input.nodeId) {
      throw new Error(`编排度量上下文压缩 Trace 归属冲突：instanceId=${input.sourceInstanceId}, promptSnapshotId=${trace.promptSnapshotId}`);
    }
    if (traceByTurnId.has(trace.turnId)) {
      throw new Error(`编排度量上下文压缩发现 Turn 绑定多个 Prompt Snapshot：threadId=${input.threadId}, turnId=${trace.turnId}`);
    }
    traceByTurnId.set(trace.turnId, trace);
  }
  const parsedEvents = input.events.map((event) => {
    if (!Number.isSafeInteger(event.seq) || event.seq <= 0 || !Number.isFinite(event.ts) || event.ts <= 0) {
      throw new Error(`编排度量上下文压缩事件时间或序号无效：threadId=${input.threadId}, seq=${event.seq}`);
    }
    const parsed = parseRecordWithQuality(event.event_json);
    if (parsed.invalid) throw new Error(`编排度量上下文压缩事件 JSON 损坏：threadId=${input.threadId}, seq=${event.seq}`);
    return { event, payload: asRecord(parsed.value.payload) };
  });
  const seenSeq = new Set<number>();
  for (const { event } of parsedEvents) {
    if (seenSeq.has(event.seq)) throw new Error(`编排度量上下文压缩事件序号重复：threadId=${input.threadId}, seq=${event.seq}`);
    seenSeq.add(event.seq);
  }
  const manualEventByTurnId = new Map<string, ContextCompactionEventEvidence>();
  for (const { event, payload } of parsedEvents) {
    if (event.engine !== "codex" || event.type !== "turn.completed" || asRecord(payload.result).compacted !== true) continue;
    const turnId = readString(payload.turnId);
    if (!turnId) throw new Error(`编排度量 Codex 压缩事件缺少 turnId：threadId=${input.threadId}, seq=${event.seq}`);
    const turn = turnById.get(turnId);
    if (!turn || turn.status !== "completed" || turn.endEventSeq !== event.seq
      || turn.endedAt === null || !Number.isFinite(turn.endedAt)
      || turn.endedAt < event.ts || turn.endedAt > input.observedThrough) {
      throw new Error(`编排度量 Codex 压缩事件与 Turn 边界不一致：threadId=${input.threadId}, turnId=${turnId}`);
    }
    if (manualEventByTurnId.has(turnId)) throw new Error(`编排度量 Codex 压缩 Turn 存在重复终态：threadId=${input.threadId}, turnId=${turnId}`);
    manualEventByTurnId.set(turnId, event);
  }
  const terminalTurns = input.turns
    .filter((turn) => (turn.status === "completed" || turn.status === "error") && turn.endEventSeq !== null)
    .sort((left, right) => Number(left.endEventSeq) - Number(right.endEventSeq));
  const nearestTrace = (eventSeq: number, outcomeTurnId: string | null): OrchestrationMetricTraceFact | null => {
    if (outcomeTurnId) {
      const outcomeTrace = traceByTurnId.get(outcomeTurnId);
      if (outcomeTrace) return outcomeTrace;
    }
    const containingTrace = input.traces.find((trace) => {
      const turn = turnById.get(trace.turnId);
      return turn?.startEventSeq != null && turn.startEventSeq <= eventSeq && (turn.endEventSeq == null || eventSeq <= turn.endEventSeq);
    });
    if (containingTrace) return containingTrace;
    return [...input.traces]
      .filter((trace) => (turnById.get(trace.turnId)?.endEventSeq ?? Number.POSITIVE_INFINITY) < eventSeq)
      .sort((left, right) => Number(turnById.get(right.turnId)?.endEventSeq ?? 0) - Number(turnById.get(left.turnId)?.endEventSeq ?? 0))[0] ?? null;
  };
  const toOutcome = (turn: ContextCompactionTurnEvidence | null, event: ContextCompactionEventEvidence): {
    status: OrchestrationMetricContextCompactionFact["postCompactionOutcome"];
    turnId: string | null;
    at: number | null;
  } => {
    if (!turn || (turn.status !== "completed" && turn.status !== "error")) {
      return { status: "not_observed", turnId: null, at: null };
    }
    if (!Number.isSafeInteger(turn.endEventSeq) || Number(turn.endEventSeq) < event.seq
      || turn.endedAt === null || !Number.isFinite(turn.endedAt)) {
      throw new Error(`编排度量上下文压缩结果 Turn 边界无效：threadId=${input.threadId}, turnId=${turn.turnId}, seq=${event.seq}`);
    }
    if (turn.endedAt > input.observedThrough) return { status: "not_observed", turnId: null, at: null };
    if (turn.endedAt < event.ts) {
      throw new Error(`编排度量上下文压缩结果 Turn 边界无效：threadId=${input.threadId}, turnId=${turn.turnId}, seq=${event.seq}`);
    }
    return { status: turn.status, turnId: turn.turnId, at: turn.endedAt };
  };
  const facts: OrchestrationMetricContextCompactionFact[] = [];
  for (const { event, payload } of parsedEvents) {
    let compactionKind: OrchestrationMetricContextCompactionFact["compactionKind"] | null = null;
    let compactionTurn: ContextCompactionTurnEvidence | null = null;
    let outcomeTurn: ContextCompactionTurnEvidence | null = null;
    if (event.engine === "claude" && event.type === "system.notice" && readString(payload.action) === "context.compacted") {
      const matchingTurns = input.turns.filter((turn) => (
        turn.startEventSeq !== null
        && turn.startEventSeq <= event.seq
        && (turn.endEventSeq === null || event.seq <= turn.endEventSeq)
      ));
      if (matchingTurns.length !== 1) {
        throw new Error(`编排度量 Claude 压缩事件无法唯一归属 Turn：threadId=${input.threadId}, seq=${event.seq}`);
      }
      compactionKind = "automatic";
      compactionTurn = matchingTurns[0]!;
      outcomeTurn = compactionTurn.status === "completed" || compactionTurn.status === "error" ? compactionTurn : null;
    } else if (event.engine === "codex" && event.type === "turn.completed" && asRecord(payload.result).compacted === true) {
      compactionKind = "manual";
      compactionTurn = turnById.get(readString(payload.turnId)) ?? null;
      outcomeTurn = terminalTurns.find((turn) => (
        Number(turn.endEventSeq) > event.seq && !manualEventByTurnId.has(turn.turnId)
      )) ?? null;
    }
    if (!compactionKind || !compactionTurn) continue;
    const outcome = toOutcome(outcomeTurn, event);
    const relatedTrace = nearestTrace(event.seq, outcome.turnId);
    const fields = {
      sourceInstanceId: input.sourceInstanceId,
      nodeId: input.nodeId,
      nodeExecutionId: relatedTrace && !relatedTrace.nodeExecutionId.startsWith("unresolved:") ? relatedTrace.nodeExecutionId : null,
      promptSnapshotId: outcome.turnId ? traceByTurnId.get(outcome.turnId)?.promptSnapshotId ?? null : null,
      threadId: input.threadId,
      compactionTurnId: compactionTurn.turnId,
      compactionEventSeq: event.seq,
      compactionKind,
      engine: readString(event.engine) || relatedTrace?.engine || "unknown",
      model: readString(relatedTrace?.model) || null,
      compactedAt: event.ts,
      postCompactionOutcome: outcome.status,
      outcomeTurnId: outcome.turnId,
      outcomeAt: outcome.at,
    };
    facts.push({ ...fields, sourceFingerprint: hashFingerprint(fields) });
  }
  return facts;
}

/** Builds deterministic, versioned Trace Grader facts without copying prompt or model bodies. */
function buildTraceEvaluationFacts(results: TraceBuildResult[]): OrchestrationMetricEvaluationFact[] {
  return results.flatMap((result) => {
    const trace = result.fact;
    const evidenceScopeJson = JSON.stringify({
      promptSnapshotId: trace.promptSnapshotId,
      threadId: trace.threadId,
      turnId: trace.turnId,
      evidenceReasons: trace.evidenceReasons,
      ineffectiveLoopCount: result.ineffectiveLoopCount,
    });
    const integrityStatus = trace.evidenceStatus === "complete" ? "passed" as const : "missing_evidence" as const;
    const toolEvidenceMissing = trace.evidenceReasons.some((reason) => (
      reason === "missing_event_bounds" || reason === "invalid_conversation_event" || reason === "invalid_tool_event"
      || reason === "duplicate_tool_start" || reason === "unmatched_tool_completion" || reason === "invalid_tool_interval"
      || reason === "incomplete_tool_call"
    ));
    const toolStatus = toolEvidenceMissing
      ? "missing_evidence" as const
      : trace.toolCallCount < 3
        ? "not_evaluated" as const
        : result.ineffectiveLoopCount > 0 ? "failed" as const : "passed" as const;
    const makeFact = (input: {
      evaluationKey: string;
      evaluatorId: string;
      criterion: string;
      evaluationStatus: OrchestrationMetricEvaluationFact["evaluationStatus"];
      score: number | null;
      explanation: string;
    }): OrchestrationMetricEvaluationFact => {
      const fields = {
        sourceInstanceId: trace.sourceInstanceId,
        nodeId: trace.nodeId,
        nodeExecutionId: trace.nodeExecutionId.startsWith("unresolved:") ? null : trace.nodeExecutionId,
        promptSnapshotId: trace.promptSnapshotId,
        evaluationKey: input.evaluationKey,
        evaluationKind: "trace_grader" as const,
        evaluatorId: input.evaluatorId,
        evaluatorVersion: "v1",
        criterion: input.criterion,
        evaluationStatus: input.evaluationStatus,
        score: input.score,
        evidenceScopeJson,
        evidenceRef: `prompt-snapshot:${trace.promptSnapshotId}`,
        explanation: input.explanation,
        evaluatedAt: trace.completedAt ?? trace.startedAt,
      };
      return { ...fields, sourceFingerprint: hashFingerprint(fields) };
    };
    return [
      makeFact({
        evaluationKey: `${trace.promptSnapshotId}:trace-integrity`,
        evaluatorId: "trace-evidence-integrity-grader",
        criterion: "trace_evidence_integrity",
        evaluationStatus: integrityStatus,
        score: integrityStatus === "passed" ? 1 : null,
        explanation: integrityStatus === "passed" ? "运行证据完整" : `运行证据缺口：${trace.evidenceReasons.join(",")}`,
      }),
      makeFact({
        evaluationKey: `${trace.promptSnapshotId}:tool-path-efficiency`,
        evaluatorId: "tool-path-efficiency-grader",
        criterion: "tool_path_efficiency",
        evaluationStatus: toolStatus,
        score: toolStatus === "passed" ? 1 : toolStatus === "failed" ? 0 : null,
        explanation: toolStatus === "failed"
          ? `检测到 ${result.ineffectiveLoopCount} 次无进展重复工具调用`
          : toolStatus === "passed" ? "未检测到无进展重复工具调用" : toolStatus === "not_evaluated" ? "工具调用少于 3 次" : "工具路径证据不完整",
      }),
    ];
  });
}

/** Converts one prompt snapshot and its bounded runtime events into a deterministic Trace fact. */
function buildTraceFact(
  ctx: ApiHandlerContext,
  row: InstanceRow,
  workflowSnapshotHash: string,
  snapshot: PromptSnapshotRow,
  executionByAttempt: Map<string, OrchestrationMetricNodeFact>,
): TraceBuildResult {
  const nodeId = String(snapshot.node_id ?? "").trim();
  const attemptNo = Math.max(1, Number(snapshot.attempt_no ?? 1));
  const execution = executionByAttempt.get(`${nodeId}\u001f${attemptNo}`);
  const threadId = String(snapshot.thread_id ?? "").trim();
  const turnId = String(snapshot.turn_id ?? "").trim();
  const resolvedTurn = ctx.db.db.prepare(`
    SELECT status, started_at, ended_at, start_event_seq, end_event_seq
      FROM thread_turns
     WHERE thread_id = ? AND turn_id = ?
  `).get(threadId, turnId) as {
    status: string;
    started_at: number;
    ended_at: number | null;
    start_event_seq: number | null;
    end_event_seq: number | null;
  } | undefined;
  const reasons = new Set<string>();
  if (!execution) reasons.add("missing_node_execution");
  if (!resolvedTurn) reasons.add("missing_thread_turn");
  if (resolvedTurn && (resolvedTurn.start_event_seq == null || resolvedTurn.end_event_seq == null)) reasons.add("missing_event_bounds");
  if (resolvedTurn?.status === "started") reasons.add("turn_not_terminal");

  const conversationRows = resolvedTurn?.start_event_seq != null && resolvedTurn.end_event_seq != null
    ? ctx.db.db.prepare(`
        SELECT seq, type, event_json, ts
          FROM conversation_events
         WHERE thread_id = ? AND seq BETWEEN ? AND ?
         ORDER BY seq ASC
      `).all(threadId, resolvedTurn.start_event_seq, resolvedTurn.end_event_seq) as ConversationMetricEventRow[]
    : [];
  const tokenUsages: Array<Record<string, unknown>> = [];
  const toolStarted = new Set<string>();
  const toolCompleted = new Map<string, "completed" | "failed">();
  const activeTools = new Map<string, ConversationMetricEventRow>();
  const toolSegments: OrchestrationMetricStateSegmentFact[] = [];
  let previousToolPath: { signature: string; outcome: string; hasProgress: boolean; repeatLength: number } | null = null;
  let ineffectiveLoopCount = 0;
  for (const event of conversationRows) {
    const parsed = parseRecordWithQuality(event.event_json);
    if (parsed.invalid) {
      reasons.add("invalid_conversation_event");
      continue;
    }
    const payload = asRecord(parsed.value.payload);
    if (event.type === "orchestration.artifactWritten" || event.type === "orchestration.artifactRevised" || event.type === "orchestration.artifactPublished") {
      previousToolPath = null;
    }
    if (
      event.type === "tokenUsage.updated"
      && readString(payload.source || "current") === "current"
      && readString(payload.usagePhase || "final") !== "intermediate"
    ) {
      tokenUsages.push(asRecord(payload.tokenUsage));
    }
    if (event.type === "item.tool.started") {
      const itemId = readString(payload.itemId);
      if (!itemId) {
        reasons.add("invalid_tool_event");
      } else {
        toolStarted.add(itemId);
        if (activeTools.has(itemId)) reasons.add("duplicate_tool_start");
        else activeTools.set(itemId, event);
      }
    }
    if (event.type === "item.tool.completed") {
      const itemId = readString(payload.itemId);
      if (!itemId) {
        reasons.add("invalid_tool_event");
        continue;
      }
      const status = readString(payload.status);
      if (status !== "completed" && status !== "failed") {
        reasons.add("invalid_tool_event");
        continue;
      }
      const started = activeTools.get(itemId);
      if (!started) {
        reasons.add("unmatched_tool_completion");
        continue;
      }
      toolCompleted.set(itemId, status);
      activeTools.delete(itemId);
      if (event.ts < started.ts) {
        reasons.add("invalid_tool_interval");
        continue;
      }
      if (execution) toolSegments.push(createToolActiveSegment(row, execution, started, event));
      const startedPayload = asRecord(parseRecordWithQuality(started.event_json).value.payload);
      const toolName = readString(startedPayload.toolName) || readString(payload.toolName);
      if (!toolName) {
        reasons.add("invalid_tool_event");
        previousToolPath = null;
        continue;
      }
      const signature = hashFingerprint([toolName, startedPayload.input ?? null]);
      const outcome = hashFingerprint([status, payload.output ?? null, readString(payload.error)]);
      const output = asRecord(payload.output);
      const hasProgress = (Array.isArray(payload.changes) && payload.changes.length > 0) || output.accepted === true;
      const repeatLength: number = previousToolPath
        && previousToolPath.signature === signature
        && previousToolPath.outcome === outcome
        && !previousToolPath.hasProgress
        && !hasProgress
        ? previousToolPath.repeatLength + 1
        : 1;
      if (repeatLength >= 3) ineffectiveLoopCount += 1;
      previousToolPath = { signature, outcome, hasProgress, repeatLength };
    }
  }
  if (tokenUsages.length === 0) reasons.add("missing_token_usage");
  const unmatchedToolCalls = [...toolStarted].filter((itemId) => !toolCompleted.has(itemId));
  if (unmatchedToolCalls.length > 0) reasons.add("incomplete_tool_call");

  const startedAt = Number(resolvedTurn?.started_at ?? snapshot.created_at ?? 0);
  const completedAt = resolvedTurn?.ended_at == null ? null : Number(resolvedTurn.ended_at);
  const rawCount = completedAt == null
    ? 0
    : Number((ctx.db.db.prepare(`
        SELECT COUNT(1) AS total
          FROM raw_engine_events
         WHERE thread_id = ? AND ts >= ? AND ts <= ?
      `).get(threadId, startedAt, completedAt) as { total?: number } | undefined)?.total ?? 0);
  if (rawCount === 0) reasons.add("missing_raw_trace");

  const promptEnvelope = parseRecordWithQuality(snapshot.prompt_envelope_json);
  if (promptEnvelope.invalid) reasons.add("invalid_prompt_snapshot");
  const envelope = promptEnvelope.value;
  const role = asRecord(envelope.role);
  const meta = asRecord(envelope.meta);
  const roleRevision = asRecord(meta.roleExecutionRevision);
  const billingContext = asRecord(meta.billingContext);
  const providerId = readString(billingContext.providerId) || null;
  const credentialSource = readCredentialSource(billingContext.credentialSource);
  if (!providerId || !credentialSource) reasons.add("missing_billing_context");
  const rawPriceSnapshot = billingContext.priceSnapshot;
  const priceSnapshot = rawPriceSnapshot == null ? null : requireRelayInvocationPriceSnapshot(rawPriceSnapshot);
  if (priceSnapshot && credentialSource !== "codeflow_key") throw new Error(`Prompt Snapshot ${snapshot.id} 的 Relay 价格快照与凭据来源不一致`);
  if (priceSnapshot && priceSnapshot.providerId !== providerId) throw new Error(`Prompt Snapshot ${snapshot.id} 的 Relay 价格快照与 provider 不一致`);
  if (priceSnapshot && priceSnapshot.modelVersion.trim().toLowerCase() !== String(snapshot.model ?? "").trim().toLowerCase()) {
    throw new Error(`Prompt Snapshot ${snapshot.id} 的 Relay 价格快照与模型不一致`);
  }
  const tokenTotals = tokenUsages.reduce<{
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  }>((totals, usage) => ({
    inputTokens: totals.inputTokens + (readOptionalNumber(usage.inputTokens) ?? 0),
    outputTokens: totals.outputTokens + (readOptionalNumber(usage.outputTokens) ?? 0),
    cachedInputTokens: totals.cachedInputTokens + (readOptionalNumber(usage.cachedInputTokens) ?? 0),
    cacheCreationInputTokens: totals.cacheCreationInputTokens + (readOptionalNumber(usage.cacheCreationInputTokens) ?? 0),
    reasoningOutputTokens: totals.reasoningOutputTokens + (readOptionalNumber(usage.reasoningOutputTokens) ?? 0),
    totalTokens: totals.totalTokens + (readOptionalNumber(usage.totalTokens) ?? 0),
  }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });
  const roleId = readString(roleRevision.roleId) || readString(role.roleId) || "unknown";
  const roleSnapshotHash = hashFingerprint(roleRevision.roleId ? roleRevision : role);
  const promptDefinitionHash = buildPromptDefinitionHash(envelope, workflowSnapshotHash, nodeId, roleSnapshotHash);
  const promptHash = hashFingerprint({
    promptEnvelope: envelope,
    systemMessage: snapshot.system_message,
    developerMessage: snapshot.developer_message,
    userMessage: snapshot.user_message,
  });
  const engine = String(snapshot.engine ?? "").trim();
  if (priceSnapshot && engine !== "claude" && engine !== "codex") throw new Error(`Prompt Snapshot ${snapshot.id} 的计价引擎无效`);
  const estimatedCostMicros = priceSnapshot && tokenUsages.length > 0
    ? calculateRelayCostMicros(engine as "claude" | "codex", tokenTotals, priceSnapshot)
    : null;
  const priceSnapshotJson = estimatedCostMicros === null ? null : JSON.stringify(priceSnapshot);
  const fields = {
    sourceInstanceId: row.id,
    nodeId,
    nodeExecutionId: execution?.nodeExecutionId ?? `unresolved:${nodeId}:${attemptNo}`,
    attemptNo,
    promptSnapshotId: snapshot.id,
    workflowSnapshotHash,
    roleId,
    roleSnapshotHash,
    promptDefinitionHash,
    promptHash,
    threadId,
    turnId,
    engine,
    providerId,
    credentialSource,
    model: snapshot.model ? String(snapshot.model) : null,
    effort: snapshot.effort ? String(snapshot.effort) : null,
    startedAt,
    completedAt,
    durationMs: completedAt !== null && completedAt >= startedAt ? completedAt - startedAt : null,
    modelCallCount: tokenUsages.length,
    ...tokenTotals,
    // 仅本机视图区分字段缺失与真实零值，云端保持原事实和计价口径。
    ...(ctx.localWorkspaceOnly === true ? { tokenUsageCoverage: {
      inputTokens: tokenUsages.length > 0 && tokenUsages.every(usage => readOptionalNumber(usage.inputTokens) !== null),
      outputTokens: tokenUsages.length > 0 && tokenUsages.every(usage => readOptionalNumber(usage.outputTokens) !== null),
      totalTokens: tokenUsages.length > 0 && tokenUsages.every(usage => readOptionalNumber(usage.totalTokens) !== null),
    } } : {}),
    toolCallCount: toolStarted.size,
    toolSuccessCount: [...toolCompleted.values()].filter((status) => status === "completed").length,
    toolFailureCount: [...toolCompleted.values()].filter((status) => status === "failed").length,
    costStatus: estimatedCostMicros === null ? "unavailable" as const : "available" as const,
    estimatedCostMicros,
    priceSnapshotJson,
    evidenceStatus: reasons.size === 0 ? "complete" as const : "incomplete" as const,
    evidenceReasons: [...reasons].sort(),
  };
  return { fact: { ...fields, sourceFingerprint: hashFingerprint(fields) }, toolSegments, ineffectiveLoopCount };
}

/** Converts one canonical tool call into a node-scoped resource activity interval. */
function createToolActiveSegment(
  row: InstanceRow,
  execution: OrchestrationMetricNodeFact,
  started: ConversationMetricEventRow,
  completed: ConversationMetricEventRow,
): OrchestrationMetricStateSegmentFact {
  return createStateSegment({
    row,
    nodeId: execution.nodeId,
    nodeExecutionId: execution.nodeExecutionId,
    attemptNo: execution.attemptNo,
    parentExecutionId: execution.parentExecutionId ?? null,
    segmentType: "tool_active",
    segmentClass: "resource_activity",
    startedAt: started.ts,
    endedAt: completed.ts,
    sourceEventFrom: `conversation-event:${started.seq}`,
    sourceEventTo: `conversation-event:${completed.seq}`,
  });
}

/** Reads a persisted credential source without accepting unknown future values. */
function readCredentialSource(value: unknown): OrchestrationMetricTraceFact["credentialSource"] {
  return value === "codeflow_key" || value === "local_oauth" || value === "local_api_key" || value === "none"
    ? value
    : null;
}

/** Evaluates the frozen workflow path without treating disabled condition branches as deviations. */
function buildConformanceFacts(
  row: InstanceRow,
  workflowSnapshotHash: string,
  workflow: Record<string, unknown>,
  nodeStates: Record<string, unknown>,
  nodeFacts: OrchestrationMetricNodeFact[],
): OrchestrationMetricConformanceFact[] {
  const nodes = (Array.isArray(workflow.nodes) ? workflow.nodes : []).map(asRecord);
  const edges = (Array.isArray(workflow.edges) ? workflow.edges : []).map(asRecord);
  const nodeById = new Map<string, Record<string, unknown>>(
    nodes.flatMap((node): Array<[string, Record<string, unknown>]> => {
      const nodeId = readString(node.id);
      return nodeId ? [[nodeId, node]] : [];
    }),
  );
  const executionCountByNode = new Map<string, number>();
  for (const fact of nodeFacts) executionCountByNode.set(fact.nodeId, (executionCountByNode.get(fact.nodeId) ?? 0) + 1);
  /** Matches the runtime condition-edge key, including unlabeled and legacy default branches. */
  const isConditionEdgeSelected = (edge: Record<string, unknown>, branchTaken: string): boolean => {
    const branchLabel = readString(edge.conditionBranch);
    const targetNodeId = readString(edge.targetNodeId);
    const selectionKey = branchLabel || (targetNodeId ? `target:${targetNodeId}` : `edge:${readString(edge.id)}`);
    return selectionKey === branchTaken || (!branchLabel && branchTaken === "default");
  };
  const inactiveMemo = new Map<string, boolean>();
  const isConditionallyInactive = (nodeId: string, visiting = new Set<string>()): boolean => {
    if (inactiveMemo.has(nodeId)) return inactiveMemo.get(nodeId)!;
    if (visiting.has(nodeId)) return false;
    visiting.add(nodeId);
    const inEdges = edges.filter((edge) => readString(edge.targetNodeId) === nodeId);
    if (inEdges.length === 0) return false;
    const inactive = inEdges.every((edge) => {
      const sourceNodeId = readString(edge.sourceNodeId);
      const sourceNode = nodeById.get(sourceNodeId);
      if (readString(sourceNode?.type) === "condition") {
        const branchTaken = readString(asRecord(nodeStates[sourceNodeId]).branchTaken);
        if (branchTaken && !isConditionEdgeSelected(edge, branchTaken)) return true;
      }
      return isConditionallyInactive(sourceNodeId, new Set(visiting));
    });
    inactiveMemo.set(nodeId, inactive);
    return inactive;
  };
  const completedInstance = normalizeMetricStatus(row.status) === "completed";
  return nodes.flatMap((node) => {
    const nodeId = readString(node.id);
    if (!nodeId) return [];
    const state = asRecord(nodeStates[nodeId]);
    const observedStatus = readString(state.status) || "pending";
    const executionCount = executionCountByNode.get(nodeId) ?? 0;
    const conditionallyInactive = isConditionallyInactive(nodeId);
    const nodeType = readString(node.type) || "unknown";
    const outEdges = edges.filter((edge) => readString(edge.sourceNodeId) === nodeId);
    const branchTaken = readString(state.branchTaken) || null;
    const matchingBranches = branchTaken
      ? outEdges.filter((edge) => isConditionEdgeSelected(edge, branchTaken)).length
      : 0;
    const configuredFailureSkip = observedStatus === "skipped"
      && executionCount === 1
      && readString(node.failPolicy) === "skip"
      && Boolean(readString(state.error));
    let result: OrchestrationMetricConformanceFact["result"] = "conformant";
    let deviationType: OrchestrationMetricConformanceFact["deviationType"] = null;
    if (conditionallyInactive && executionCount > 0) {
      result = "deviation";
      deviationType = "unexpected_execution";
    } else if (nodeType === "condition" && observedStatus === "completed" && matchingBranches !== 1) {
      result = "deviation";
      deviationType = "invalid_branch";
    } else if (executionCount > 1) {
      result = "deviation";
      deviationType = "repeat_execution";
    } else if (observedStatus === "skipped") {
      result = conditionallyInactive || configuredFailureSkip ? "legal_skip" : "manual_override";
    } else if (completedInstance && executionCount === 0) {
      result = "deviation";
      deviationType = "missing_required";
    } else if (!completedInstance && executionCount === 0) {
      result = "not_evaluated";
    }
    const directConditionEdges = edges.filter((edge) => {
      const sourceNodeId = readString(edge.sourceNodeId);
      return readString(edge.targetNodeId) === nodeId && readString(nodeById.get(sourceNodeId)?.type) === "condition";
    });
    const branchEvidenceEdge = directConditionEdges.find((edge) => {
      const sourceNodeId = readString(edge.sourceNodeId);
      const selectedBranch = readString(asRecord(nodeStates[sourceNodeId]).branchTaken);
      return Boolean(selectedBranch) && isConditionEdgeSelected(edge, selectedBranch);
    }) ?? directConditionEdges.find((edge) => readString(asRecord(nodeStates[readString(edge.sourceNodeId)]).branchTaken))
      ?? directConditionEdges[0];
    const branchSourceNodeId = branchEvidenceEdge ? readString(branchEvidenceEdge.sourceNodeId) || null : null;
    const evidenceBranchTaken = nodeType === "condition"
      ? branchTaken
      : branchSourceNodeId
        ? readString(asRecord(nodeStates[branchSourceNodeId]).branchTaken) || null
        : null;
    const fields = {
      sourceInstanceId: row.id,
      workflowSnapshotHash,
      nodeId,
      nodeLabel: readString(node.label) || nodeId,
      nodeType,
      observedStatus,
      result,
      deviationType,
      executionCount,
      branchSourceNodeId,
      branchTaken: evidenceBranchTaken,
      evidenceRef: `orchestration://instance/${row.id}/node/${nodeId}`,
      observedAt: Number(row.updated_at ?? 0),
    };
    return [{ ...fields, sourceFingerprint: hashFingerprint(fields) }];
  });
}

/** Derives contract evidence only from persisted validators, artifacts, fields, and Trace facts. */
function buildContractFacts(
  row: InstanceRow,
  workflowSnapshotHash: string,
  workflow: Record<string, unknown>,
  roleSnapshots: Record<string, unknown>,
  nodeStates: Record<string, unknown>,
  artifacts: ArtifactStatusRow[],
  artifactFields: ArtifactFieldRow[],
  events: EventRow[],
  traceFacts: OrchestrationMetricTraceFact[],
): OrchestrationMetricContractFact[] {
  const facts: OrchestrationMetricContractFact[] = [];
  const addFact = (input: Omit<OrchestrationMetricContractFact, "sourceFingerprint">) => {
    facts.push({ ...input, sourceFingerprint: hashFingerprint(input) });
  };
  for (const execution of collectContractExecutionStates(row, nodeStates, events)) {
    const { nodeId, nodeExecutionId, state, evaluatedAt } = execution;
    const gateResults = Array.isArray(state.gateResults) ? state.gateResults : [];
    gateResults.forEach((rawResult, index) => {
      const result = asRecord(rawResult);
      if (typeof result.passed !== "boolean") {
        throw new Error(`编排度量发现无效门禁结果：instanceId=${row.id}, nodeId=${nodeId}, index=${index}`);
      }
      const criterionId = readString(result.criterionId) || `gate-${index + 1}`;
      const passed = result.passed;
      const evidence = readString(result.message);
      addFact({
        sourceInstanceId: row.id,
        nodeId,
        nodeExecutionId,
        workflowSnapshotHash,
        contractType: "gate",
        contractKey: criterionId,
        contractVersion: "gate-result/v1",
        required: true,
        evaluationStatus: evidence ? (passed ? "passed" : "failed") : "missing_evidence",
        passed: evidence ? passed : null,
        evidenceRef: evidence || null,
        evaluatorId: "orchestration-gate",
        evaluatorVersion: "v1",
        evaluatedAt,
      });
    });
    const conclusion = asRecord(state.conclusion);
    const acceptanceChecks = Array.isArray(conclusion.acceptanceChecks) ? conclusion.acceptanceChecks : [];
    acceptanceChecks.forEach((rawCheck, index) => {
      const check = asRecord(rawCheck);
      const criterionId = readString(check.criterionId);
      const label = readString(check.label) || `acceptance-${index + 1}`;
      const verdict = readString(check.verdict);
      const evidence = readString(check.evidence);
      if (verdict !== "pass" && verdict !== "fail" && verdict !== "not_evaluated") {
        throw new Error(`编排度量发现无效验收结论：instanceId=${row.id}, nodeId=${nodeId}, index=${index}`);
      }
      const evaluationStatus = verdict === "not_evaluated"
        ? "not_evaluated"
        : !evidence
          ? "missing_evidence"
          : verdict === "pass" ? "passed" : "failed";
      addFact({
        sourceInstanceId: row.id,
        nodeId,
        nodeExecutionId,
        workflowSnapshotHash,
        contractType: "acceptance",
        contractKey: criterionId || hashFingerprint([nodeId, label, index]),
        contractVersion: "acceptance-check/v1",
        required: check.blocking !== false,
        evaluationStatus,
        passed: evaluationStatus === "passed" ? true : evaluationStatus === "failed" ? false : null,
        evidenceRef: evidence || null,
        evaluatorId: "node-result-contract",
        evaluatorVersion: "v1",
        evaluatedAt,
      });
    });
  }
  for (const artifact of artifacts) {
    const evaluation = resolveArtifactContractEvaluation(artifact.status);
    addFact({
      sourceInstanceId: row.id,
      nodeId: artifact.node_id || null,
      nodeExecutionId: null,
      workflowSnapshotHash,
      contractType: "artifact",
      contractKey: artifact.id,
      contractVersion: "artifact-record/v1",
      required: false,
      evaluationStatus: evaluation.evaluationStatus,
      passed: evaluation.passed,
      evidenceRef: `artifact:${artifact.id}`,
      evaluatorId: "artifact-persistence",
      evaluatorVersion: "v1",
      evaluatedAt: Number(artifact.updated_at ?? row.updated_at ?? 0),
    });
  }
  for (const outputFieldFact of buildOutputFieldContractFacts(row, workflowSnapshotHash, workflow, roleSnapshots, nodeStates, artifacts, artifactFields)) {
    addFact(outputFieldFact);
  }
  for (const trace of traceFacts) {
    const complete = trace.evidenceStatus === "complete";
    addFact({
      sourceInstanceId: row.id,
      nodeId: trace.nodeId,
      nodeExecutionId: trace.nodeExecutionId.startsWith("unresolved:") ? null : trace.nodeExecutionId,
      workflowSnapshotHash,
      contractType: "runtime_evidence",
      contractKey: trace.promptSnapshotId,
      contractVersion: "runtime-trace-evidence/v1",
      required: true,
      evaluationStatus: complete ? "passed" : "missing_evidence",
      passed: complete ? true : null,
      evidenceRef: `prompt-snapshot:${trace.promptSnapshotId}`,
      evaluatorId: "runtime-trace-collector",
      evaluatorVersion: "v1",
      evaluatedAt: trace.completedAt ?? trace.startedAt,
    });
  }
  return facts;
}

/** Reconstructs contract-bearing node states per execution without losing completed retry history. */
function collectContractExecutionStates(
  row: InstanceRow,
  nodeStates: Record<string, unknown>,
  events: EventRow[],
): Array<{ nodeId: string; nodeExecutionId: string; state: Record<string, unknown>; evaluatedAt: number }> {
  const executions = new Map<string, { nodeId: string; nodeExecutionId: string; state: Record<string, unknown>; evaluatedAt: number }>();
  const mergeExecution = (
    nodeId: string,
    nodeExecutionId: string,
    state: Record<string, unknown>,
    evaluatedAt: number,
  ): void => {
    const key = `${nodeId}\u001f${nodeExecutionId}`;
    const existing = executions.get(key);
    const mergedState = { ...(existing?.state ?? {}), ...state };
    if (state.gateResults == null && existing?.state.gateResults != null) {
      mergedState.gateResults = existing.state.gateResults;
    }
    executions.set(key, {
      nodeId,
      nodeExecutionId,
      state: mergedState,
      evaluatedAt: Math.max(existing?.evaluatedAt ?? 0, evaluatedAt),
    });
  };

  for (const event of events) {
    if (event.type !== "orchestration.nodeStateChanged") continue;
    const payload = safeParseRecord(event.payload_json);
    const state = asRecord(payload.nodeState);
    const nodeId = readString(event.node_id ?? payload.nodeId ?? state.nodeId);
    const status = readString(payload.status ?? state.status);
    if (!nodeId) continue;
    const attemptNo = Math.max(1, readOptionalNumber(payload.attemptNo ?? state.attemptNo) ?? 1);
    const explicitExecutionId = readString(payload.nodeExecutionId ?? state.nodeExecutionId);
    if (!explicitExecutionId && (status === "pending" || status === "skipped")) continue;
    const nodeExecutionId = explicitExecutionId || `legacy:${hashFingerprint([row.id, nodeId, attemptNo])}`;
    mergeExecution(
      nodeId,
      nodeExecutionId,
      { ...state, status, attemptNo, nodeExecutionId },
      readOptionalNumber(state.completedAt) ?? Number(event.created_at ?? 0),
    );
  }

  for (const [nodeId, rawState] of Object.entries(nodeStates)) {
    const state = asRecord(rawState);
    const status = readString(state.status);
    const attemptNo = Math.max(1, readOptionalNumber(state.attemptNo) ?? (readOptionalNumber(state.retryCount) ?? 0) + 1);
    const explicitExecutionId = readString(state.nodeExecutionId);
    if (!explicitExecutionId && (status === "pending" || status === "skipped")) continue;
    const nodeExecutionId = explicitExecutionId || `legacy:${hashFingerprint([row.id, nodeId, attemptNo])}`;
    mergeExecution(
      nodeId,
      nodeExecutionId,
      { ...state, attemptNo, nodeExecutionId },
      readOptionalNumber(state.completedAt) ?? Number(row.updated_at ?? 0),
    );
  }

  return [...executions.values()];
}

/** Maps current and legacy artifact lifecycle states without treating drafts as successful evidence. */
function resolveArtifactContractEvaluation(status: string): Pick<OrchestrationMetricContractFact, "evaluationStatus" | "passed"> {
  if (status === "approved" || status === "published") return { evaluationStatus: "passed", passed: true };
  if (status === "rejected") return { evaluationStatus: "failed", passed: false };
  if (status === "draft" || status === "superseded") return { evaluationStatus: "not_evaluated", passed: null };
  if (status === "missing") return { evaluationStatus: "missing_evidence", passed: null };
  throw new Error(`编排度量发现无效工件状态：status=${status || "missing"}`);
}

/** Maps persisted output-field validation without inferring validity from field content. */
function resolveOutputFieldContractEvaluation(status: string): Pick<OrchestrationMetricContractFact, "evaluationStatus" | "passed"> {
  if (status === "valid") return { evaluationStatus: "passed", passed: true };
  if (status === "invalid") return { evaluationStatus: "failed", passed: false };
  if (status === "missing") return { evaluationStatus: "missing_evidence", passed: null };
  throw new Error(`编排度量发现无效输出字段状态：status=${status || "missing"}`);
}

/** Builds stable field contracts from frozen roles and the latest active Artifact version. */
function buildOutputFieldContractFacts(
  row: InstanceRow,
  workflowSnapshotHash: string,
  workflow: Record<string, unknown>,
  roleSnapshots: Record<string, unknown>,
  nodeStates: Record<string, unknown>,
  artifacts: ArtifactStatusRow[],
  artifactFields: ArtifactFieldRow[],
): Array<Omit<OrchestrationMetricContractFact, "sourceFingerprint">> {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const fieldsByArtifact = new Map<string, Map<string, ArtifactFieldRow>>();
  for (const field of artifactFields) {
    const artifact = artifactById.get(field.artifact_id);
    if (!artifact || artifact.node_id !== field.node_id || artifact.kind !== field.result_name) {
      throw new Error(`编排度量发现输出字段与 Artifact 身份不一致：instanceId=${row.id}, artifactId=${field.artifact_id}, fieldKey=${field.field_key}`);
    }
    if (field.required !== 0 && field.required !== 1) {
      throw new Error(`编排度量发现无效输出字段必填标记：instanceId=${row.id}, artifactId=${field.artifact_id}, fieldKey=${field.field_key}`);
    }
    resolveOutputFieldContractEvaluation(field.validation_status);
    const artifactFieldsByKey = fieldsByArtifact.get(field.artifact_id) ?? new Map<string, ArtifactFieldRow>();
    if (artifactFieldsByKey.has(field.field_key)) {
      throw new Error(`编排度量发现重复输出字段：instanceId=${row.id}, artifactId=${field.artifact_id}, fieldKey=${field.field_key}`);
    }
    artifactFieldsByKey.set(field.field_key, field);
    fieldsByArtifact.set(field.artifact_id, artifactFieldsByKey);
  }

  const nodes = (Array.isArray(workflow.nodes) ? workflow.nodes : []).map(asRecord);
  const completedInstance = normalizeMetricStatus(row.status) === "completed";
  return nodes.flatMap((node) => {
    const nodeId = readString(node.id);
    const roleId = readString(node.type) === "role" ? readString(node.roleId) : "";
    if (!nodeId || !roleId) return [];
    const nodeState = asRecord(nodeStates[nodeId]);
    const nodeStatus = readString(nodeState.status);
    if (nodeStatus === "pending" || nodeStatus === "skipped") return [];
    if (!nodeStatus && !artifacts.some((artifact) => artifact.node_id === nodeId)) return [];
    const roleSnapshot = asRecord(roleSnapshots[roleId]);
    const outputDefinition = normalizeRoleOutputDefinition(asRecord(roleSnapshot.outputDefinition));
    if (outputDefinition.requiredFields.length === 0) return [];
    const fieldKeys = new Set<string>();
    for (const field of outputDefinition.requiredFields) {
      if (fieldKeys.has(field.key)) {
        throw new Error(`编排度量发现重复输出字段契约：instanceId=${row.id}, nodeId=${nodeId}, fieldKey=${field.key}`);
      }
      fieldKeys.add(field.key);
    }
    const configuredKey = readString(node.outputResultKey);
    const roleDefaultKey = readString(outputDefinition.resultKey);
    const configuredOutputMode = readString(node.outputArtifactMode);
    if (configuredOutputMode && configuredOutputMode !== "direct" && configuredOutputMode !== "structured"
      && configuredOutputMode !== "file" && configuredOutputMode !== "file-set") {
      throw new Error(`编排度量发现无效输出模式：instanceId=${row.id}, nodeId=${nodeId}, outputArtifactMode=${configuredOutputMode}`);
    }
    const outputMode = configuredOutputMode || inferRoleArtifactOutputMode(outputDefinition);
    const resultName = configuredKey || roleDefaultKey || (outputMode === "file"
      ? `file-output/${nodeId}`
      : outputMode === "file-set"
        ? `file-set-output/${nodeId}`
        : outputMode === "structured"
          ? `structured-output/${nodeId}`
          : `node-output/${nodeId}`);
    const selectedArtifactIds = new Set(readStringArray(nodeState.outputArtifactIds));
    const allowHistoricalFallback = selectedArtifactIds.size === 0 && readString(nodeState.status) === "completed";
    const activeArtifact = artifacts
      .filter((artifact) => artifact.node_id === nodeId
        && artifact.kind === resultName
        && artifact.status !== "rejected"
        && artifact.status !== "superseded"
        && (selectedArtifactIds.has(artifact.id) || allowHistoricalFallback))
      .sort((left, right) => right.version - left.version || right.updated_at - left.updated_at || right.id.localeCompare(left.id))[0] ?? null;
    const persistedFields = activeArtifact ? fieldsByArtifact.get(activeArtifact.id) ?? new Map<string, ArtifactFieldRow>() : new Map<string, ArtifactFieldRow>();
    return outputDefinition.requiredFields.map((definition) => {
      const persisted = persistedFields.get(definition.key) ?? null;
      if (persisted && Boolean(persisted.required) !== definition.required) {
        throw new Error(`编排度量发现输出字段契约漂移：instanceId=${row.id}, nodeId=${nodeId}, fieldKey=${definition.key}`);
      }
      const evaluation = persisted
        ? resolveOutputFieldContractEvaluation(persisted.validation_status)
        : activeArtifact || completedInstance
          ? { evaluationStatus: "missing_evidence" as const, passed: null }
          : { evaluationStatus: "not_evaluated" as const, passed: null };
      return {
        sourceInstanceId: row.id,
        nodeId,
        nodeExecutionId: null,
        workflowSnapshotHash,
        contractType: "output_field" as const,
        contractKey: `${nodeId}:${resultName}:${definition.key}`,
        contractVersion: "node-result-field/v2",
        required: definition.required,
        evaluationStatus: evaluation.evaluationStatus,
        passed: evaluation.passed,
        evidenceRef: activeArtifact
          ? `artifact:${encodeURIComponent(activeArtifact.id)}#field:${encodeURIComponent(definition.key)}`
          : null,
        evaluatorId: "node-result-contract-validator",
        evaluatorVersion: "v2",
        evaluatedAt: Number(persisted?.updated_at ?? activeArtifact?.updated_at ?? row.updated_at ?? 0),
      };
    });
  });
}

/** Derives stable state intervals from existing node and instance transition events. */
function buildStateSegments(row: InstanceRow, events: EventRow[]): OrchestrationMetricStateSegmentFact[] {
  const terminalEvent = [...events].reverse().find((event) => event.type === "orchestration.completed" || event.type === "orchestration.cancelled") ?? null;
  const terminalAt = terminalEvent?.created_at
    ?? (TERMINAL_STATUSES.has(normalizeMetricStatus(row.status)) ? Number(row.updated_at ?? 0) || null : null);
  const byNode = new Map<string, Array<{ event: EventRow; status: string; nodeId: string; nodeExecutionId: string; attemptNo: number; parentExecutionId: string | null }>>();
  for (const event of events) {
    if (event.type !== "orchestration.nodeStateChanged") continue;
    const payload = safeParseRecord(event.payload_json);
    const nodeId = readString(event.node_id ?? payload.nodeId);
    const status = readString(payload.status);
    if (!nodeId || !status) continue;
    const state = asRecord(payload.nodeState);
    const attemptNo = Math.max(1, readOptionalNumber(payload.attemptNo ?? state.attemptNo) ?? 1);
    const nodeExecutionId = readString(payload.nodeExecutionId ?? state.nodeExecutionId)
      || `legacy:${hashFingerprint([row.id, nodeId, attemptNo])}`;
    const transitions = byNode.get(nodeId) ?? [];
    transitions.push({
      event,
      status,
      nodeId,
      nodeExecutionId,
      attemptNo,
      parentExecutionId: readString(payload.parentExecutionId ?? state.parentExecutionId) || null,
    });
    byNode.set(nodeId, transitions);
  }

  const segments: OrchestrationMetricStateSegmentFact[] = [];
  for (const transitions of byNode.values()) {
    transitions.forEach((transition, index) => {
      const mapped = mapNodeStatusToSegment(transition.status);
      if (!mapped) return;
      const next = transitions[index + 1]?.event ?? null;
      const endedAt = next?.created_at ?? terminalAt;
      segments.push(createStateSegment({
        row,
        nodeId: transition.nodeId,
        nodeExecutionId: transition.nodeExecutionId,
        attemptNo: transition.attemptNo,
        parentExecutionId: transition.parentExecutionId,
        segmentType: mapped.segmentType,
        segmentClass: mapped.segmentClass,
        startedAt: transition.event.created_at,
        endedAt: endedAt !== null && endedAt >= transition.event.created_at ? endedAt : null,
        sourceEventFrom: transition.event.id,
        sourceEventTo: next?.id ?? terminalEvent?.id ?? null,
      }));
    });
  }

  let pausedEvent: EventRow | null = null;
  for (const event of events) {
    if (event.type === "orchestration.paused") {
      pausedEvent ??= event;
      continue;
    }
    if (!pausedEvent || (event.type !== "orchestration.resumed" && event.type !== "orchestration.completed" && event.type !== "orchestration.cancelled")) continue;
    segments.push(createStateSegment({
      row,
      nodeId: null,
      nodeExecutionId: null,
      attemptNo: null,
      parentExecutionId: null,
      segmentType: "paused",
      segmentClass: "cycle_state",
      startedAt: pausedEvent.created_at,
      endedAt: event.created_at,
      sourceEventFrom: pausedEvent.id,
      sourceEventTo: event.id,
    }));
    pausedEvent = null;
  }
  if (pausedEvent) {
    segments.push(createStateSegment({
      row,
      nodeId: null,
      nodeExecutionId: null,
      attemptNo: null,
      parentExecutionId: null,
      segmentType: "paused",
      segmentClass: "cycle_state",
      startedAt: pausedEvent.created_at,
      endedAt: terminalAt !== null && terminalAt >= pausedEvent.created_at ? terminalAt : null,
      sourceEventFrom: pausedEvent.id,
      sourceEventTo: terminalEvent?.id ?? null,
    }));
  }
  return segments;
}

/** Maps runtime node states onto the versioned metric segment contract. */
export function mapNodeStatusToSegment(status: string): Pick<OrchestrationMetricStateSegmentFact, "segmentType" | "segmentClass"> | null {
  const cycleTypes: Partial<Record<string, OrchestrationMetricStateSegmentType>> = {
    queued: "queue",
    "waiting-start": "waiting_start",
    "waiting-approval": "waiting_approval",
    "waiting-feedback": "waiting_feedback",
  };
  const resourceTypes: Partial<Record<string, OrchestrationMetricStateSegmentType>> = {
    running: "agent_active",
    "artifact-writing": "artifact_writing",
    "gate-checking": "gate_checking",
  };
  if (cycleTypes[status]) return { segmentType: cycleTypes[status]!, segmentClass: "cycle_state" };
  if (resourceTypes[status]) return { segmentType: resourceTypes[status]!, segmentClass: "resource_activity" };
  return null;
}

/** Creates one state segment with a stable identity and source fingerprint. */
function createStateSegment(input: {
  row: InstanceRow;
  nodeId: string | null;
  nodeExecutionId: string | null;
  attemptNo: number | null;
  parentExecutionId: string | null;
  segmentType: OrchestrationMetricStateSegmentFact["segmentType"];
  segmentClass: OrchestrationMetricStateSegmentFact["segmentClass"];
  startedAt: number;
  endedAt: number | null;
  sourceEventFrom: string;
  sourceEventTo: string | null;
}): OrchestrationMetricStateSegmentFact {
  const fields = {
    sourceInstanceId: input.row.id,
    nodeId: input.nodeId,
    nodeExecutionId: input.nodeExecutionId,
    attemptNo: input.attemptNo,
    parentExecutionId: input.parentExecutionId,
    segmentId: hashFingerprint([input.row.id, input.nodeId, input.nodeExecutionId, input.sourceEventFrom, input.segmentType]),
    segmentType: input.segmentType,
    segmentClass: input.segmentClass,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.endedAt !== null ? input.endedAt - input.startedAt : null,
    sourceEventFrom: input.sourceEventFrom,
    sourceEventTo: input.sourceEventTo,
  };
  return { ...fields, sourceFingerprint: hashFingerprint(fields) };
}

/** Counts retries once per node by reconciling node state counters with feedback records. */
function countRetries(nodes: OrchestrationMetricNodeFact[], feedbackRecords: FeedbackRow[]): number {
  const nodeRetryCounts = new Map<string, number>();
  for (const node of nodes) {
    nodeRetryCounts.set(node.nodeId, Math.max(nodeRetryCounts.get(node.nodeId) ?? 0, node.attemptNo - 1, node.retryCount));
  }
  const feedbackCounts = new Map<string, number>();
  let unscopedFeedbackCount = 0;
  for (const item of feedbackRecords) {
    if (item.action !== "retry") continue;
    const nodeId = readString(item.node_id);
    if (!nodeId) {
      unscopedFeedbackCount += 1;
      continue;
    }
    feedbackCounts.set(nodeId, (feedbackCounts.get(nodeId) ?? 0) + 1);
  }
  const nodeIds = new Set([...nodeRetryCounts.keys(), ...feedbackCounts.keys()]);
  return unscopedFeedbackCount + [...nodeIds].reduce(
    (sum, nodeId) => sum + Math.max(nodeRetryCounts.get(nodeId) ?? 0, feedbackCounts.get(nodeId) ?? 0),
    0,
  );
}

/** Builds one version-bound node fact per stable execution attempt, using current state only as execution fallback. */
function buildNodeFacts(
  sourceInstanceId: string,
  workflowSnapshotHash: string,
  workflow: Record<string, unknown>,
  roleSnapshots: Record<string, unknown>,
  nodeStates: Record<string, unknown>,
  events: EventRow[],
): OrchestrationMetricNodeFact[] {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes.map(asRecord) : [];
  const workflowNodeEntries = nodes
    .map((node): [string, Record<string, unknown>] => [readString(node.id), node])
    .filter(([id]) => Boolean(id));
  const workflowNodeById = new Map<string, Record<string, unknown>>(workflowNodeEntries);
  const executions = new Map<string, { nodeId: string; nodeExecutionId: string; attemptNo: number; parentExecutionId: string | null; state: Record<string, unknown>; firstAt: number | null; lastAt: number | null }>();
  for (const event of events) {
    if (event.type !== "orchestration.nodeStateChanged") continue;
    const payload = safeParseRecord(event.payload_json);
    const state = asRecord(payload.nodeState);
    const nodeId = readString(event.node_id ?? payload.nodeId ?? state.nodeId);
    if (!nodeId) continue;
    const status = readString(payload.status) || readString(state.status);
    const explicitExecutionId = readString(payload.nodeExecutionId ?? state.nodeExecutionId);
    if (!explicitExecutionId && (status === "pending" || status === "skipped")) continue;
    const attemptNo = Math.max(1, readOptionalNumber(payload.attemptNo ?? state.attemptNo) ?? 1);
    const nodeExecutionId = explicitExecutionId
      || `legacy:${hashFingerprint([sourceInstanceId, nodeId, attemptNo])}`;
    const key = `${nodeId}:${nodeExecutionId}`;
    const current = executions.get(key);
    executions.set(key, {
      nodeId,
      nodeExecutionId,
      attemptNo,
      parentExecutionId: readString(payload.parentExecutionId ?? state.parentExecutionId) || current?.parentExecutionId || null,
      state: { ...(current?.state ?? {}), ...state, status },
      firstAt: current?.firstAt ?? event.created_at,
      lastAt: event.created_at,
    });
  }
  for (const [nodeId, rawState] of Object.entries(nodeStates)) {
    const state = asRecord(rawState);
    const status = readString(state.status) || "pending";
    const explicitExecutionId = readString(state.nodeExecutionId);
    if (!explicitExecutionId && (status === "pending" || status === "skipped") && readOptionalNumber(state.startedAt) === null) continue;
    const attemptNo = Math.max(1, readOptionalNumber(state.attemptNo) ?? (readOptionalNumber(state.retryCount) ?? 0) + 1);
    const nodeExecutionId = explicitExecutionId || `legacy:${hashFingerprint([sourceInstanceId, nodeId, attemptNo])}`;
    const key = `${nodeId}:${nodeExecutionId}`;
    const current = executions.get(key);
    executions.set(key, {
      nodeId,
      nodeExecutionId,
      attemptNo,
      parentExecutionId: readString(state.parentExecutionId) || current?.parentExecutionId || null,
      state: { ...(current?.state ?? {}), ...state },
      firstAt: current?.firstAt ?? readOptionalNumber(state.startedAt),
      lastAt: readOptionalNumber(state.completedAt) ?? current?.lastAt ?? null,
    });
  }
  return [...executions.values()].map((execution) => {
    const { nodeId, state } = execution;
    const workflowNode = workflowNodeById.get(nodeId) ?? {};
    const nodeType = readString(workflowNode.type) || null;
    const roleId = nodeType === "role" ? readString(workflowNode.roleId) : "";
    const roleSnapshot = roleId ? asRecord(roleSnapshots[roleId]) : {};
    const roleStageId = roleId ? `role:${roleId}` : "control";
    const roleStageName = roleId
      ? readString(roleSnapshot.name) || readString(workflowNode.label) || roleId
      : "流程控制";
    const startedAt = readOptionalNumber(state.startedAt) ?? execution.firstAt;
    const completedAt = readOptionalNumber(state.completedAt) ?? (TERMINAL_STATUSES.has(readString(state.status)) ? execution.lastAt : null);
    const retryCount = execution.attemptNo > 1 ? 1 : 0;
    const validation = deriveNodeValidation(state);
    const status = readString(state.status) || "pending";
    const qualityFlags = new Set<OrchestrationMetricQualityEventType>();
    if (status === "failed" || readString(state.error)) qualityFlags.add("failed");
    if (retryCount > 0) qualityFlags.add("retry");
    if (validation.failed > 0) qualityFlags.add("validation_failed");
    if (hasEvidenceMissingSignal(state)) qualityFlags.add("evidence_missing");
    return {
      sourceInstanceId,
      workflowSnapshotHash,
      nodeId,
      nodeExecutionId: execution.nodeExecutionId,
      attemptNo: execution.attemptNo,
      parentExecutionId: execution.parentExecutionId,
      nodeLabel: readString(workflowNode.label) || readString(state.label) || nodeId,
      nodeType,
      roleStageId,
      roleStageName,
      status,
      attemptCount: 1,
      retryCount,
      startedAt,
      completedAt,
      durationMs: startedAt !== null && completedAt !== null && completedAt >= startedAt ? completedAt - startedAt : null,
      hasGateFailure: validation.failed > 0,
      hasValidationFailure: validation.failed > 0,
      qualityFlags: [...qualityFlags],
    };
  });
}

function buildInstanceQualityEvents(row: InstanceRow, events: EventRow[]): OrchestrationMetricQualityEventFact[] {
  const at = Number(row.updated_at ?? row.created_at ?? Date.now());
  const out: OrchestrationMetricQualityEventFact[] = [];
  const status = normalizeMetricStatus(row.status);
  if (status === "failed") out.push(createQualityEvent(row.id, null, "failed", "instance", 1, at));
  if (status === "cancelled") out.push(createQualityEvent(row.id, null, "interrupted", "instance", 1, at));
  if (events.some((event) => /interrupt|cancel|abort/i.test(event.type))) {
    out.push(createQualityEvent(row.id, null, "interrupted", "event", 1, at));
  }
  return out;
}

/** Builds quality events without mutating node fact identity fields. */
function buildNodeQualityEvents(nodes: OrchestrationMetricNodeFact[], fallbackAt: number): OrchestrationMetricQualityEventFact[] {
  const out: OrchestrationMetricQualityEventFact[] = [];
  for (const node of nodes) {
    for (const flag of node.qualityFlags) {
      const count = flag === "retry" ? Math.max(1, node.retryCount) : 1;
      out.push(createQualityEvent("", node.nodeId, flag, "node", count, node.completedAt ?? node.startedAt ?? fallbackAt));
    }
  }
  return out;
}

function buildFeedbackQualityEvents(feedbackRecords: FeedbackRow[]): OrchestrationMetricQualityEventFact[] {
  const out: OrchestrationMetricQualityEventFact[] = [];
  for (const item of feedbackRecords) {
    if (item.action === "retry") {
      out.push(createQualityEvent("", item.node_id, "retry", "feedback", 1, item.created_at));
    }
    if (item.action === "rework_to_target") {
      out.push(createQualityEvent("", item.node_id, "rework", "feedback", 1, item.created_at));
    }
    if (item.action === "abort" || item.action === "cancel") {
      out.push(createQualityEvent("", item.node_id, "interrupted", "feedback", 1, item.created_at));
    }
  }
  return out;
}

function buildEventQualityEvents(events: EventRow[]): OrchestrationMetricQualityEventFact[] {
  const out: OrchestrationMetricQualityEventFact[] = [];
  for (const event of events) {
    const type = event.type.toLowerCase();
    const payload = safeParseRecord(event.payload_json);
    const nextAction = readString(payload.nextAction);
    if (type.includes("error") || type.includes("failed")) {
      out.push(createQualityEvent("", event.node_id, "failed", "event", 1, event.created_at));
    }
    if (type.includes("retry") || type.includes("rerun")) {
      out.push(createQualityEvent("", event.node_id, "retry", "event", 1, event.created_at));
    }
    if (nextAction === "rework") {
      out.push(createQualityEvent("", event.node_id, "review_rejected", "event", 1, event.created_at));
    }
    if (type.includes("validation") && hasFailureSignal(payload)) {
      out.push(createQualityEvent("", event.node_id, "validation_failed", "validation", 1, event.created_at));
    }
  }
  return out;
}

function buildArtifactQualityEvents(statusRows: ArtifactStatusRow[], instanceId: string, fallbackAt: number): OrchestrationMetricQualityEventFact[] {
  const failedCount = statusRows
    .filter((item) => /fail|error|missing/i.test(item.status))
    .length;
  return failedCount > 0 ? [createQualityEvent(instanceId, null, "evidence_missing", "artifact", failedCount, fallbackAt)] : [];
}

/** Merges duplicate semantic events while retaining the most authoritative source. */
function mergeQualityEvents(
  items: OrchestrationMetricQualityEventFact[],
  instanceId: string,
): OrchestrationMetricQualityEventFact[] {
  const byKey = new Map<string, OrchestrationMetricQualityEventFact>();
  for (const item of items) {
    const key = `${item.nodeId ?? ""}:${item.eventType}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, sourceInstanceId: instanceId });
      continue;
    }
    existing.eventCount = Math.max(existing.eventCount, item.eventCount);
    existing.firstSeenAt = Math.min(existing.firstSeenAt, item.firstSeenAt);
    existing.lastSeenAt = Math.max(existing.lastSeenAt, item.lastSeenAt);
    if (qualityEventSourcePriority(item.eventSource) > qualityEventSourcePriority(existing.eventSource)) {
      existing.eventSource = item.eventSource;
    }
  }
  return [...byKey.values()];
}

/** Chooses the most authoritative source when multiple facts describe the same quality event. */
function qualityEventSourcePriority(source: OrchestrationMetricQualityEventFact["eventSource"]): number {
  if (source === "validation" || source === "artifact") return 4;
  if (source === "trace") return 3;
  if (source === "feedback") return 3;
  if (source === "node" || source === "instance") return 2;
  return 1;
}

function createQualityEvent(
  sourceInstanceId: string,
  nodeId: string | null | undefined,
  eventType: OrchestrationMetricQualityEventType,
  eventSource: OrchestrationMetricQualityEventFact["eventSource"],
  eventCount: number,
  at: number,
): OrchestrationMetricQualityEventFact {
  const ts = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : Date.now();
  return {
    sourceInstanceId,
    nodeId: nodeId || null,
    eventType,
    eventSource,
    eventCount,
    firstSeenAt: ts,
    lastSeenAt: ts,
  };
}

/** Keeps the instance lifecycle anchored at its earliest persisted creation or node start time. */
function deriveInstanceStartedAt(row: InstanceRow, nodes: OrchestrationMetricNodeFact[]): number | null {
  const nodeStarts = nodes.map((node) => node.startedAt ?? 0).filter((value) => value > 0);
  const createdAt = Number(row.created_at ?? 0);
  const candidates = createdAt > 0 ? [createdAt, ...nodeStarts] : nodeStarts;
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** Resolves terminal time from instance events before persisted and node-level fallbacks. */
function deriveInstanceCompletedAt(row: InstanceRow, nodes: OrchestrationMetricNodeFact[], events: EventRow[]): number | null {
  if (!TERMINAL_STATUSES.has(normalizeMetricStatus(row.status))) return null;
  const terminalAt = [...events].reverse()
    .find((event) => event.type === "orchestration.completed" || event.type === "orchestration.cancelled")
    ?.created_at ?? Number(row.terminal_at ?? 0);
  if (terminalAt > 0) return terminalAt;
  const updatedAt = Number(row.updated_at ?? 0);
  if (updatedAt > 0) return updatedAt;
  const nodeEnds = nodes.map((node) => node.completedAt ?? 0).filter((value) => value > 0);
  if (nodeEnds.length) return Math.max(...nodeEnds);
  return null;
}

/** 汇总节点中的确定性验证结论，未识别状态不计入覆盖。 */
function deriveValidation(nodeStates: Record<string, unknown>): {
  status: OrchestrationMetricValidationStatus;
  checked: number;
  passed: number;
} {
  const validation = Object.values(nodeStates)
    .map((state) => deriveNodeValidation(asRecord(state)))
    .reduce((sum, item) => ({
      checked: sum.checked + item.checked,
      failed: sum.failed + item.failed,
      passed: sum.passed + item.passed,
    }), { checked: 0, failed: 0, passed: 0 });
  const { checked, failed, passed } = validation;
  if (checked === 0) return { status: "not_evaluated", checked: 0, passed: 0 };
  return { status: failed > 0 ? "failed" : "passed", checked, passed };
}

function deriveNodeValidation(state: Record<string, unknown>): { checked: number; failed: number; passed: number } {
  const visited: unknown[] = [state.gateResults, state.validationResults, state.acceptanceChecks, state.conclusion];
  let checked = 0;
  let failed = 0;
  let passed = 0;
  for (const value of visited) {
    const result = countValidationSignals(value);
    checked += result.checked;
    failed += result.failed;
    passed += result.passed;
  }
  return { checked, failed, passed };
}

function countValidationSignals(value: unknown): { checked: number; failed: number; passed: number } {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => {
      const next = countValidationSignals(item);
      return {
        checked: sum.checked + next.checked,
        failed: sum.failed + next.failed,
        passed: sum.passed + next.passed,
      };
    }, { checked: 0, failed: 0, passed: 0 });
  }
  if (!value || typeof value !== "object") return { checked: 0, failed: 0, passed: 0 };
  const record = value as Record<string, unknown>;
  const verdict = readString(record.verdict ?? record.status ?? record.result ?? record.outcome).toLowerCase();
  const failed = verdict.includes("fail") || verdict.includes("error") || verdict.includes("reject");
  const passed = verdict.includes("pass") || verdict.includes("success") || verdict.includes("approve") || verdict.includes("accept");
  const self = failed || passed
    ? { checked: 1, failed: failed ? 1 : 0, passed: passed ? 1 : 0 }
    : { checked: 0, failed: 0, passed: 0 };
  const children = ["items", "checks", "acceptanceChecks", "results"]
    .map((key) => countValidationSignals(record[key]))
    .reduce((sum, item) => ({
      checked: sum.checked + item.checked,
      failed: sum.failed + item.failed,
      passed: sum.passed + item.passed,
    }), { checked: 0, failed: 0, passed: 0 });
  return {
    checked: self.checked + children.checked,
    failed: self.failed + children.failed,
    passed: self.passed + children.passed,
  };
}

function hasEvidenceMissingSignal(value: Record<string, unknown>): boolean {
  const text = JSON.stringify({
    error: value.error ?? null,
    qualityWarnings: value.qualityWarnings ?? null,
    knowledgeWarnings: value.knowledgeWarnings ?? null,
    gateResults: value.gateResults ?? null,
  }).toLowerCase();
  return text.includes("evidence") && (text.includes("missing") || text.includes("not_evaluated"));
}

function hasFailureSignal(value: Record<string, unknown>): boolean {
  return JSON.stringify(value).toLowerCase().includes("fail");
}

function collectThreadIds(row: InstanceRow, nodeStates: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  addString(ids, row.master_thread_id);
  for (const state of Object.values(nodeStates).map(asRecord)) {
    addString(ids, state.threadId);
    addString(ids, state.discussionThreadId);
    for (const previous of readStringArray(state.previousThreadIds)) addString(ids, previous);
  }
  return [...ids];
}

function countThreadEvents(ctx: ApiHandlerContext, table: "conversation_events" | "raw_engine_events", threadIds: string[]): number {
  if (!threadIds.length) return 0;
  const placeholders = threadIds.map(() => "?").join(", ");
  const row = ctx.db.db.prepare(`SELECT COUNT(1) AS total FROM ${table} WHERE thread_id IN (${placeholders})`).get(...threadIds) as { total?: number } | undefined;
  return Number(row?.total ?? 0);
}

/** Reads the latest persisted trace timestamp for each referenced thread in bounded SQLite batches. */
function listLatestTraceTimestamps(ctx: ApiHandlerContext, threadIds: string[]): Map<string, number> {
  const uniqueThreadIds = [...new Set(threadIds.filter(Boolean))];
  const latestByThread = new Map<string, number>();
  const batchSize = 400;
  for (let offset = 0; offset < uniqueThreadIds.length; offset += batchSize) {
    const batch = uniqueThreadIds.slice(offset, offset + batchSize);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = ctx.db.db.prepare(`
      SELECT thread_id, MAX(ts) AS latest_ts
        FROM (
          SELECT thread_id, ts FROM conversation_events WHERE thread_id IN (${placeholders})
          UNION ALL
          SELECT thread_id, ts FROM raw_engine_events WHERE thread_id IN (${placeholders})
        )
       GROUP BY thread_id
    `).all(...batch, ...batch) as Array<{ thread_id: string; latest_ts: number }>;
    for (const row of rows) latestByThread.set(row.thread_id, Number(row.latest_ts ?? 0));
  }
  return latestByThread;
}

function listEvents(ctx: ApiHandlerContext, instanceId: string): EventRow[] {
  return ctx.db.db.prepare(`
    SELECT id, node_id, type, payload_json, created_at
      FROM orch_events
     WHERE instance_id = ?
     ORDER BY created_at ASC, id ASC
  `).all(instanceId) as EventRow[];
}

function listFeedbackRecords(ctx: ApiHandlerContext, instanceId: string): FeedbackRow[] {
  return ctx.db.db.prepare(`
    SELECT node_id, action, created_at
      FROM orch_feedback_records
     WHERE instance_id = ?
     ORDER BY created_at ASC
  `).all(instanceId) as FeedbackRow[];
}

function listArtifactStatuses(ctx: ApiHandlerContext, instanceId: string): ArtifactStatusRow[] {
  return ctx.db.db.prepare(`
    SELECT id, node_id, kind, version, status, updated_at
      FROM orch_artifacts
     WHERE instance_id = ?
     ORDER BY node_id ASC, updated_at ASC, id ASC
  `).all(instanceId) as ArtifactStatusRow[];
}

/** Lists deterministic output-field validation records for one instance. */
function listArtifactFields(ctx: ApiHandlerContext, instanceId: string): ArtifactFieldRow[] {
  return ctx.db.db.prepare(`
    SELECT artifact_id, node_id, result_name, field_key, required, validation_status, updated_at
      FROM orch_artifact_fields
     WHERE instance_id = ?
     ORDER BY artifact_id ASC, result_name ASC, field_key ASC
  `).all(instanceId) as ArtifactFieldRow[];
}

function normalizeMetricStatus(value: unknown): OrchestrationMetricStatus {
  const status = readString(value);
  return isMetricStatus(status) ? status : "pending";
}

function isMetricStatus(value: string): value is OrchestrationMetricStatus {
  return value === "pending"
    || value === "running"
    || value === "paused"
    || value === "waiting-start"
    || value === "waiting-approval"
    || value === "waiting-feedback"
    || value === "completed"
    || value === "failed"
    || value === "cancelled";
}

function normalizeCursorOffset(value: unknown): number {
  const offset = Math.floor(Number(value ?? 0));
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

function normalizeLimit(value: unknown): number {
  const limit = Math.floor(Number(value ?? 500));
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 500;
}

function normalizeTimeFilter(value: unknown): number | null {
  const parsed = readOptionalNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function readOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function readStringArray(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return Array.from(new Set(raw.map(readString).filter(Boolean)));
}

function readString(value: unknown): string {
  return String(value ?? "").trim();
}

function addString(target: Set<string>, value: unknown): void {
  const text = readString(value);
  if (text) target.add(text);
}

/** Parses optional JSON records for callers that do not consume quality metadata. */
function safeParseRecord(raw: unknown): Record<string, unknown> {
  return parseRecordWithQuality(raw).value;
}

/** Parses a JSON record and exposes corruption without hiding it as an empty object. */
function parseRecordWithQuality(raw: unknown): { value: Record<string, unknown>; invalid: boolean } {
  if (typeof raw !== "string" || !raw.trim()) return { value: {}, invalid: false };
  try {
    const parsed = JSON.parse(raw) as unknown;
    const value = asRecord(parsed);
    return { value, invalid: parsed === null || typeof parsed !== "object" || Array.isArray(parsed) };
  } catch {
    return { value: {}, invalid: true };
  }
}

/** 创建按 workflow ID 与完整 JSON 校验的 LRU 解析器；无 ID 时保持原逐次解析语义。 */
export function createWorkflowSnapshotParser(maxEntries = WORKFLOW_SNAPSHOT_CACHE_MAX_ENTRIES) {
  const parsedMaxEntries = Math.floor(Number(maxEntries));
  const normalizedMaxEntries = Number.isFinite(parsedMaxEntries) && parsedMaxEntries > 0
    ? Math.min(WORKFLOW_SNAPSHOT_CACHE_MAX_ENTRIES, parsedMaxEntries)
    : WORKFLOW_SNAPSHOT_CACHE_MAX_ENTRIES;
  const cache = new Map<string, {
    snapshotJson: string;
    result: { value: Record<string, unknown>; invalid: boolean };
  }>();

  /** 复用内容未变化的 workflow snapshot，并在命中时刷新 LRU 顺序。 */
  return (workflowId: unknown, raw: unknown): { value: Record<string, unknown>; invalid: boolean } => {
    const normalizedWorkflowId = readString(workflowId);
    if (!normalizedWorkflowId || typeof raw !== "string") return parseRecordWithQuality(raw);
    const cached = cache.get(normalizedWorkflowId);
    if (cached?.snapshotJson === raw) {
      cache.delete(normalizedWorkflowId);
      cache.set(normalizedWorkflowId, cached);
      return cached.result;
    }
    const result = parseRecordWithQuality(raw);
    cache.delete(normalizedWorkflowId);
    cache.set(normalizedWorkflowId, { snapshotJson: raw, result });
    while (cache.size > normalizedMaxEntries) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }
    return result;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function summarizeTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
}

function hashFingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
