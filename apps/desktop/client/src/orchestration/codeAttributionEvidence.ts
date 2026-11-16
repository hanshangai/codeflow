import crypto from "node:crypto";

import {
  normalizeOrchestrationCodeAttributionLine,
  type OrchestrationId,
  type OrchestrationMetricCodeAttributionQualityReason,
  type OrchestrationMetricCodeAttributionQualityStatus,
  type ThreadId,
  type TurnId,
  type WorkspaceId,
} from "@codeflowai/shared";
import { formatPatch, parsePatch, structuredPatch, type StructuredPatch } from "diff";

import type { ClientDb } from "../db/clientDb.js";
import type { TurnFileChangeRecord } from "../db/repos/turnFileChangeRepo.js";
import { normalizeWorkspaceRelativePosixPath } from "../engines/toolFilePaths.js";
import { decodeSnapshotText } from "../fs/textEncoding.js";

export type LocalCodeAttributionEvidenceIssueCode =
  | "prompt_snapshot_missing"
  | "prompt_snapshot_ambiguous"
  | "execution_association_missing"
  | "execution_association_mismatch"
  | "ai_trace_missing"
  | "patch_snapshot_missing"
  | "patch_snapshot_corrupt"
  | "patch_evidence_conflict"
  | "patch_path_invalid"
  | "patch_path_ambiguous"
  | "binary_file";

export type LocalCodeAttributionEvidenceIssue = {
  code: LocalCodeAttributionEvidenceIssueCode;
  qualityReason: OrchestrationMetricCodeAttributionQualityReason;
  message: string;
  promptSnapshotId: string | null;
  threadId: string | null;
  turnId: string | null;
  path: string | null;
};

export type LocalCodeAttributionPatch = {
  patchId: string;
  source: "codex_aggregate_diff" | "turn_file_snapshot";
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
  attemptId: string;
  attemptNo: number;
  promptSnapshotId: string;
  threadId: ThreadId;
  turnId: TurnId;
  path: string;
  localPathSha256: string;
  operation: "create" | "modify" | "delete";
  addedLines: string[];
  removedLines: string[];
  patchText: string;
  patchSha256: string;
  evidenceRef: string;
  capturedAt: number;
  supersedesPatchId: string | null;
};

export type LocalCodeAttributionCandidateFile = {
  path: string;
  localPathSha256: string;
  candidateAddedLines: string[];
  patchIds: string[];
  latestPatchId: string;
};

export type LocalCodeAttributionEvidenceResult = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  qualityStatus: OrchestrationMetricCodeAttributionQualityStatus;
  qualityReasons: OrchestrationMetricCodeAttributionQualityReason[];
  evaluatedTurnCount: number;
  patches: LocalCodeAttributionPatch[];
  candidateFiles: LocalCodeAttributionCandidateFile[];
  issues: LocalCodeAttributionEvidenceIssue[];
};

type ExecutionAssociation = {
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeId: string;
  attemptId: string;
  attemptNo: number;
  promptSnapshotId: string;
  threadId: ThreadId;
  turnId: TurnId;
  engine: "claude" | "codex";
  startedAt: number;
  endedAt: number;
  startEventSeq: number;
  endEventSeq: number;
};

type CandidatePatch = LocalCodeAttributionPatch & {
  beforeLines: string[] | null;
  afterLines: string[] | null;
  executionStartedAt: number;
  executionEndedAt: number;
  executionStartEventSeq: number;
  executionEndEventSeq: number;
};

type BuildTurnResult = {
  evaluated: boolean;
  patches: CandidatePatch[];
  issues: LocalCodeAttributionEvidenceIssue[];
};

type BuildAggregateDiffResult = {
  patches: CandidatePatch[];
  issues: LocalCodeAttributionEvidenceIssue[];
};

type RawPatchShape = {
  hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number }>;
};

const AGGREGATE_GIT_METADATA_PATTERNS = [
  /^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/u,
  /^(?:new file mode|deleted file mode|old mode|new mode) \d+$/u,
  /^(?:similarity|dissimilarity) index \d+%$/u,
  /^(?:rename from|rename to|copy from|copy to) .+$/u,
] as const;

type FinalizePatchChainsResult = {
  patches: LocalCodeAttributionPatch[];
  candidateFiles: LocalCodeAttributionCandidateFile[];
  issues: LocalCodeAttributionEvidenceIssue[];
};

class EvidenceValidationError extends Error {
  /** 标记可转换为质量状态的本地证据错误，其他运行异常必须继续抛出。 */
  constructor(
    readonly issueCode: LocalCodeAttributionEvidenceIssueCode,
    readonly qualityReason: OrchestrationMetricCodeAttributionQualityReason,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

/** 从既有 Client 事实构建实例级 AI Patch 链和当前有效候选行，不写数据库。 */
export function buildLocalCodeAttributionEvidence(
  db: ClientDb,
  input: { instanceId: OrchestrationId },
): LocalCodeAttributionEvidenceResult {
  const instance = db.orchInstances.get(input.instanceId);
  if (!instance) throw new Error(`编排实例不存在：instanceId=${input.instanceId}`);
  const workspace = db.workspaces.get(instance.workspaceId);
  if (!workspace) {
    throw new Error(`编排实例工作区不存在：instanceId=${input.instanceId}, workspaceId=${instance.workspaceId}`);
  }

  const snapshots = db.orchPromptSnapshots
    .listByInstance(input.instanceId, { includeContent: false })
    .filter((snapshot) => snapshot.purpose !== "gate-evaluation")
    .sort((left, right) => left.createdAt - right.createdAt || compareText(left.id, right.id));
  const issues: LocalCodeAttributionEvidenceIssue[] = [];
  if (snapshots.length === 0) {
    issues.push(createIssue({
      code: "prompt_snapshot_missing",
      qualityReason: "association_missing",
      message: `实例没有可用于代码归因的节点 Prompt Snapshot：instanceId=${input.instanceId}`,
    }));
  }

  const duplicateTurnKeys = findDuplicateSnapshotTurnKeys(snapshots);
  const patches: CandidatePatch[] = [];
  let evaluatedTurnCount = 0;
  for (const snapshot of snapshots) {
    const turnKey = snapshot.threadId && snapshot.turnId
      ? `${String(snapshot.threadId)}\u0000${String(snapshot.turnId)}`
      : null;
    if (turnKey && duplicateTurnKeys.has(turnKey)) {
      issues.push(createIssue({
        code: "prompt_snapshot_ambiguous",
        qualityReason: "ambiguous_attribution",
        message: `同一 thread/turn 关联了多个节点 Prompt Snapshot：threadId=${snapshot.threadId}, turnId=${snapshot.turnId}`,
        promptSnapshotId: snapshot.id,
        threadId: String(snapshot.threadId),
        turnId: String(snapshot.turnId),
      }));
      continue;
    }

    const association = resolveExecutionAssociation(db, instance.workspaceId, input.instanceId, snapshot);
    if ("issue" in association) {
      issues.push(association.issue);
      continue;
    }
    const turnResult = buildTurnEvidence(db, workspace.path, association.value);
    if (turnResult.evaluated) evaluatedTurnCount += 1;
    patches.push(...turnResult.patches);
    issues.push(...turnResult.issues);
  }

  const finalized = finalizePatchChains(patches);
  issues.push(...finalized.issues);
  const qualityReasons = Array.from(new Set(issues.map((issue) => issue.qualityReason))).sort();
  const qualityStatus: OrchestrationMetricCodeAttributionQualityStatus = issues.length === 0
    ? "complete"
    : evaluatedTurnCount > 0
      ? "partial"
      : "unavailable";
  return {
    workspaceId: instance.workspaceId,
    instanceId: input.instanceId,
    qualityStatus,
    qualityReasons,
    evaluatedTurnCount,
    patches: finalized.patches,
    candidateFiles: finalized.candidateFiles,
    issues,
  };
}

/** 将 Prompt Snapshot、Attempt 和本地 turn 校验为同一确定执行身份。 */
function resolveExecutionAssociation(
  db: ClientDb,
  workspaceId: WorkspaceId,
  instanceId: OrchestrationId,
  snapshot: ReturnType<ClientDb["orchPromptSnapshots"]["listByInstance"]>[number],
): { value: ExecutionAssociation } | { issue: LocalCodeAttributionEvidenceIssue } {
  const rawThreadId = String(snapshot.threadId ?? "");
  const rawTurnId = String(snapshot.turnId ?? "");
  const threadId = rawThreadId.trim();
  const turnId = rawTurnId.trim();
  if (!threadId || !turnId) {
    return { issue: createIssue({
      code: "execution_association_missing",
      qualityReason: "association_missing",
      message: `Prompt Snapshot 缺少 thread/turn 归属：promptSnapshotId=${snapshot.id}`,
      promptSnapshotId: snapshot.id,
      threadId: threadId || null,
      turnId: turnId || null,
    }) };
  }
  if (threadId !== rawThreadId || turnId !== rawTurnId) {
    return { issue: createIssue({
      code: "execution_association_mismatch",
      qualityReason: "ambiguous_attribution",
      message: `Prompt Snapshot 的 thread/turn 标识不规范：promptSnapshotId=${snapshot.id}`,
      promptSnapshotId: snapshot.id,
      threadId,
      turnId,
    }) };
  }

  const turn = db.turns.get(turnId as TurnId);
  if (!turn) {
    return { issue: createIssue({
      code: "execution_association_missing",
      qualityReason: "association_missing",
      message: `Prompt Snapshot 对应 turn 不存在：promptSnapshotId=${snapshot.id}, turnId=${turnId}`,
      promptSnapshotId: snapshot.id,
      threadId,
      turnId,
    }) };
  }
  const thread = db.threads.get(threadId as ThreadId);
  if (
    !thread
    || String(thread.workspaceId) !== String(workspaceId)
    || thread.engine !== snapshot.engine
    || thread.threadType !== "orchestration"
  ) {
    return { issue: createIssue({
      code: "execution_association_mismatch",
      qualityReason: "ambiguous_attribution",
      message: `Prompt Snapshot 与 thread 执行身份不一致：promptSnapshotId=${snapshot.id}, threadId=${threadId}`,
      promptSnapshotId: snapshot.id,
      threadId,
      turnId,
    }) };
  }
  const startEventSeq = Number(turn.startEventSeq);
  const endEventSeq = Number(turn.endEventSeq);
  const startedAt = Number(turn.startedAt);
  const endedAt = Number(turn.endedAt);
  if (
    String(turn.threadId) !== threadId
    || String(turn.workspaceId) !== String(workspaceId)
    || turn.engine !== snapshot.engine
    || (turn.status !== "completed" && turn.status !== "error")
    || !Number.isSafeInteger(startEventSeq)
    || !Number.isSafeInteger(endEventSeq)
    || !Number.isSafeInteger(startedAt)
    || !Number.isSafeInteger(endedAt)
    || startedAt <= 0
    || endedAt < startedAt
    || startEventSeq <= 0
    || endEventSeq < startEventSeq
  ) {
    return { issue: createIssue({
      code: "execution_association_mismatch",
      qualityReason: "ambiguous_attribution",
      message: `Prompt Snapshot 与 turn 执行边界不一致：promptSnapshotId=${snapshot.id}, turnId=${turnId}`,
      promptSnapshotId: snapshot.id,
      threadId,
      turnId,
    }) };
  }

  const nodeId = String(snapshot.nodeId ?? "");
  const attemptNo = Number(snapshot.attemptNo);
  if (!nodeId || nodeId !== nodeId.trim() || !Number.isSafeInteger(attemptNo) || attemptNo <= 0) {
    return { issue: createIssue({
      code: "execution_association_mismatch",
      qualityReason: "ambiguous_attribution",
      message: `Prompt Snapshot 的节点 Attempt 标识无效：promptSnapshotId=${snapshot.id}`,
      promptSnapshotId: snapshot.id,
      threadId,
      turnId,
    }) };
  }

  const attempts = db.db.prepare(`
    SELECT id
    FROM orch_node_attempts
    WHERE instance_id = ? AND node_id = ? AND attempt_no = ? AND thread_id = ? AND turn_id = ?
    ORDER BY id ASC
  `).all(
    String(instanceId),
    nodeId,
    attemptNo,
    threadId,
    turnId,
  ) as Array<{ id?: string }>;
  const attemptId = String(attempts[0]?.id ?? "");
  if (attempts.length !== 1 || !attemptId || attemptId !== attemptId.trim()) {
    return { issue: createIssue({
      code: attempts.length === 0 ? "execution_association_missing" : "execution_association_mismatch",
      qualityReason: attempts.length === 0 ? "association_missing" : "ambiguous_attribution",
      message: `Prompt Snapshot 无法唯一关联节点 Attempt：promptSnapshotId=${snapshot.id}, matches=${attempts.length}`,
      promptSnapshotId: snapshot.id,
      threadId,
      turnId,
    }) };
  }

  return { value: {
    workspaceId,
    instanceId,
    nodeId,
    attemptId,
    attemptNo,
    promptSnapshotId: snapshot.id,
    threadId: threadId as ThreadId,
    turnId: turnId as TurnId,
    engine: snapshot.engine,
    startedAt,
    endedAt,
    startEventSeq,
    endEventSeq,
  } };
}

/** 优先读取 Codex aggregate diff；存在 Blob 时交叉核验并补齐候选状态边界。 */
function buildTurnEvidence(db: ClientDb, workspacePath: string, association: ExecutionAssociation): BuildTurnResult {
  const issues: LocalCodeAttributionEvidenceIssue[] = [];
  const fileChanges = db.fileChanges.listByThreadAndTurn(association.threadId, association.turnId);
  if (association.engine === "codex") {
    let event: NonNullable<ReturnType<ClientDb["conversationEvents"]["getDiffEventBySeq"]>> | null = null;
    try {
      event = readLatestAggregateDiffEvent(db, association);
      if (event) {
        const aggregate = buildAggregateDiffPatches(workspacePath, association, event);
        if (fileChanges.length === 0) {
          return {
            evaluated: true,
            patches: aggregate.patches,
            issues: aggregate.issues,
          };
        }
        const snapshots = buildSnapshotPatches(db, workspacePath, association, fileChanges);
        return reconcileAggregateAndSnapshot(association, aggregate, snapshots);
      }
    } catch (cause) {
      const evidenceError = normalizeAggregateEvidenceError(cause);
      if (!evidenceError) throw cause;
      issues.push(createIssue({
        code: evidenceError.issueCode,
        qualityReason: evidenceError.qualityReason,
        message: `Codex aggregate diff 无法校验：promptSnapshotId=${association.promptSnapshotId}, cause=${evidenceError.message}`,
        ...associationIssueScope(association),
      }));
    }
  }

  if (fileChanges.length === 0) {
    if (issues.length === 0) {
      issues.push(createIssue({
        code: "ai_trace_missing",
        qualityReason: "ai_trace_missing",
        message: `turn 没有可用的代码变更证据：promptSnapshotId=${association.promptSnapshotId}`,
        ...associationIssueScope(association),
      }));
    }
    return { evaluated: false, patches: [], issues };
  }

  const snapshots = buildSnapshotPatches(db, workspacePath, association, fileChanges);
  issues.push(...snapshots.issues);
  return {
    evaluated: snapshots.evaluated,
    patches: snapshots.patches,
    issues,
  };
}

/** 将同一 turn 的文件快照逐项转换为 Patch，不隐藏单文件质量问题。 */
function buildSnapshotPatches(
  db: ClientDb,
  workspacePath: string,
  association: ExecutionAssociation,
  fileChanges: TurnFileChangeRecord[],
): BuildTurnResult {
  const patches: CandidatePatch[] = [];
  const issues: LocalCodeAttributionEvidenceIssue[] = [];
  for (const change of fileChanges) {
    const built = buildSnapshotPatch(db, workspacePath, association, change);
    if ("issue" in built) issues.push(built.issue);
    else patches.push(built.patch);
  }
  return {
    evaluated: patches.length > 0 || issues.some((issue) => issue.code === "binary_file"),
    patches,
    issues,
  };
}

/** 交叉校验 aggregate 与完整 Blob；冲突路径不进入候选归因。 */
function reconcileAggregateAndSnapshot(
  association: ExecutionAssociation,
  aggregate: BuildAggregateDiffResult,
  snapshots: BuildTurnResult,
): BuildTurnResult {
  const aggregateByPath = new Map(aggregate.patches.map((patch) => [patch.path, patch]));
  const snapshotByPath = new Map(snapshots.patches.map((patch) => [patch.path, patch]));
  const aggregateIssuePaths = new Set(aggregate.issues.map((issue) => issue.path).filter((path): path is string => Boolean(path)));
  const snapshotIssuePaths = new Set(snapshots.issues.map((issue) => issue.path).filter((path): path is string => Boolean(path)));
  const allPaths = new Set([
    ...aggregateByPath.keys(),
    ...snapshotByPath.keys(),
    ...aggregateIssuePaths,
    ...snapshotIssuePaths,
  ]);
  const patches: CandidatePatch[] = [];
  const issues = deduplicateIssues([...aggregate.issues, ...snapshots.issues]);

  for (const path of allPaths) {
    const aggregatePatch = aggregateByPath.get(path) ?? null;
    const snapshotPatch = snapshotByPath.get(path) ?? null;
    if (aggregatePatch && snapshotPatch) {
      if (!patchesDescribeSameChange(aggregatePatch, snapshotPatch)) {
        issues.push(createEvidenceConflictIssue(association, path));
        continue;
      }
      patches.push({
        ...aggregatePatch,
        beforeLines: snapshotPatch.beforeLines,
        afterLines: snapshotPatch.afterLines,
      });
      continue;
    }

    const aggregateHasIssue = aggregateIssuePaths.has(path);
    const snapshotHasIssue = snapshotIssuePaths.has(path);
    if (
      aggregatePatch
      && snapshotHasIssue
      && snapshots.issues.some((issue) => issue.path === path && issue.code === "binary_file")
    ) {
      issues.push(createEvidenceConflictIssue(association, path));
      continue;
    }
    if (aggregatePatch && snapshotHasIssue) {
      patches.push(aggregatePatch);
      continue;
    }
    if (
      !aggregatePatch
      && !snapshotPatch
      && aggregateHasIssue
      && snapshotHasIssue
      && hasBinaryExclusionForPath(path, aggregate.issues, snapshots.issues)
    ) continue;
    issues.push(createEvidenceConflictIssue(association, path));
  }

  return {
    evaluated: patches.length > 0 || hasSharedBinaryExclusion(aggregate.issues, snapshots.issues),
    patches,
    issues: deduplicateIssues(issues),
  };
}

/** 判断两路证据是否描述同一文件操作及相同非空代码行多重集。 */
function patchesDescribeSameChange(left: CandidatePatch, right: CandidatePatch): boolean {
  return left.operation === right.operation
    && equalNormalizedLineMultiset(left.addedLines, right.addedLines)
    && equalNormalizedLineMultiset(left.removedLines, right.removedLines);
}

/** 比较规范化代码行多重集，重复行数量必须一致。 */
function equalNormalizedLineMultiset(left: string[], right: string[]): boolean {
  const leftCounts = countNormalizedLines(left);
  const rightCounts = countNormalizedLines(right);
  if (leftCounts.size !== rightCounts.size) return false;
  for (const [line, count] of leftCounts) {
    if (rightCounts.get(line) !== count) return false;
  }
  return true;
}

/** 两路都明确识别为二进制时，保留排除结论而不制造冲突。 */
function hasSharedBinaryExclusion(
  aggregateIssues: LocalCodeAttributionEvidenceIssue[],
  snapshotIssues: LocalCodeAttributionEvidenceIssue[],
): boolean {
  const aggregatePaths = new Set(aggregateIssues.filter((issue) => issue.code === "binary_file").map((issue) => issue.path));
  return snapshotIssues.some((issue) => issue.code === "binary_file" && aggregatePaths.has(issue.path));
}

/** 判断指定路径是否被两路证据一致识别为二进制排除项。 */
function hasBinaryExclusionForPath(
  path: string,
  aggregateIssues: LocalCodeAttributionEvidenceIssue[],
  snapshotIssues: LocalCodeAttributionEvidenceIssue[],
): boolean {
  return aggregateIssues.some((issue) => issue.code === "binary_file" && issue.path === path)
    && snapshotIssues.some((issue) => issue.code === "binary_file" && issue.path === path);
}

/** 创建双路证据冲突问题，避免选择任一路径后伪造确定归因。 */
function createEvidenceConflictIssue(
  association: ExecutionAssociation,
  path: string,
): LocalCodeAttributionEvidenceIssue {
  return createIssue({
    code: "patch_evidence_conflict",
    qualityReason: "ambiguous_attribution",
    message: `Codex aggregate diff 与文件快照不一致：promptSnapshotId=${association.promptSnapshotId}, path=${path}`,
    ...associationIssueScope(association),
    path,
  });
}

/** 区分没有 aggregate 与 aggregate 行存在但无法水合，避免损坏证据被当成无变更。 */
function readLatestAggregateDiffEvent(
  db: ClientDb,
  association: ExecutionAssociation,
): NonNullable<ReturnType<ClientDb["conversationEvents"]["getDiffEventBySeq"]>> | null {
  const row = db.db.prepare(`
    SELECT event.seq, event.thread_id, event.workspace_id, event.engine, event.type, event.event_json, event.ts,
      snapshot.thread_id AS snapshot_thread_id, snapshot.diff_key, snapshot.event_seq AS snapshot_event_seq,
      snapshot.diff_sha256, snapshot.diff_bytes, snapshot.updated_at AS snapshot_updated_at
    FROM conversation_events event
    LEFT JOIN conversation_diff_snapshots snapshot ON snapshot.event_seq = event.seq
    WHERE event.thread_id = ? AND event.type = 'item.diff.created' AND event.seq >= ? AND event.seq <= ?
    ORDER BY event.seq DESC
    LIMIT 1
  `).get(
    String(association.threadId),
    association.startEventSeq,
    association.endEventSeq,
  ) as {
    seq?: number;
    thread_id?: string;
    workspace_id?: string;
    engine?: string;
    type?: string;
    event_json?: string;
    ts?: number;
    snapshot_thread_id?: string;
    diff_key?: string;
    snapshot_event_seq?: number;
    diff_sha256?: string;
    diff_bytes?: number;
    snapshot_updated_at?: number;
  } | undefined;
  if (!row) return null;
  const seq = Number(row.seq);
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "aggregate diff 事件序号无效");
  }
  let storedEnvelope: Record<string, unknown>;
  try {
    storedEnvelope = JSON.parse(String(row.event_json ?? "")) as Record<string, unknown>;
  } catch {
    throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", `aggregate diff 事件正文无法解析：eventSeq=${seq}`);
  }
  const storedPayload = storedEnvelope.payload as Record<string, unknown> | null;
  const storedDiffRef = storedPayload?.diffRef as Record<string, unknown> | null;
  const rowTs = Number(row.ts);
  if (
    String(row.thread_id ?? "") !== String(association.threadId)
    || String(row.workspace_id ?? "") !== String(association.workspaceId)
    || String(row.engine ?? "") !== "codex"
    || String(row.type ?? "") !== "item.diff.created"
    || Number(storedEnvelope.seq) !== seq
    || String(storedEnvelope.threadId ?? "") !== String(row.thread_id ?? "")
    || String(storedEnvelope.workspaceId ?? "") !== String(row.workspace_id ?? "")
    || String(storedEnvelope.engine ?? "") !== String(row.engine ?? "")
    || String(storedEnvelope.type ?? "") !== String(row.type ?? "")
    || Number(storedEnvelope.ts) !== rowTs
    || String(storedPayload?.turnId ?? "") !== String(association.turnId)
  ) {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `aggregate diff 数据库行与事件身份不一致：eventSeq=${seq}`,
    );
  }
  if (!row.snapshot_thread_id || row.snapshot_event_seq == null) {
    throw evidenceError("patch_snapshot_missing", "patch_snapshot_missing", `aggregate diff 外置正文不存在：eventSeq=${seq}`);
  }
  if (
    !Number.isSafeInteger(rowTs)
    || rowTs <= 0
    || String(row.snapshot_thread_id) !== String(association.threadId)
    || String(row.diff_key ?? "") !== `turn:${String(association.turnId)}`
    || Number(row.snapshot_event_seq) !== seq
    || Number(row.snapshot_updated_at) !== rowTs
    || (storedDiffRef?.kind === "client_latest_snapshot" && (
      String(row.diff_sha256 ?? "") !== String(storedDiffRef.sha256 ?? "")
      || Number(row.diff_bytes) !== Number(storedDiffRef.bytes)
    ))
  ) {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `aggregate diff 外置正文与事件身份不一致：eventSeq=${seq}`,
    );
  }
  const event = db.conversationEvents.getDiffEventBySeq(association.threadId, seq);
  if (!event) {
    throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", `aggregate diff 事件无法水合：eventSeq=${seq}`);
  }
  if (
    Number(event.seq) !== seq
    || String(event.threadId) !== String(row.thread_id)
    || String(event.workspaceId) !== String(row.workspace_id)
    || event.engine !== row.engine
    || event.type !== row.type
    || Number(event.ts) !== rowTs
    || String(event.payload.turnId ?? "") !== String(association.turnId)
  ) {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `aggregate diff 水合事件身份不一致：eventSeq=${seq}`,
    );
  }
  return event;
}

/** 严格解析 aggregate diff，并按单文件 Hunk 输出 Patch。 */
function buildAggregateDiffPatches(
  workspacePath: string,
  association: ExecutionAssociation,
  event: NonNullable<ReturnType<ClientDb["conversationEvents"]["findLatestDiffEventInRange"]>>,
): BuildAggregateDiffResult {
  const payloadTurnId = String(event.payload.turnId ?? "");
  if (
    String(event.workspaceId) !== String(association.workspaceId)
    || String(event.threadId) !== String(association.threadId)
    || event.engine !== "codex"
    || payloadTurnId !== String(association.turnId)
  ) {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `aggregate diff 与本地执行身份不一致：eventSeq=${event.seq}`,
    );
  }
  if (typeof event.payload.diff !== "string" || event.payload.diffRef?.kind !== "client_latest_snapshot") {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `aggregate diff 缺少外置正文引用：eventSeq=${event.seq}`,
    );
  }
  const diffText = event.payload.diff;
  const diffSha256 = sha256(diffText);
  const diffBytes = Buffer.byteLength(diffText, "utf8");
  if (
    !/^[a-f0-9]{64}$/u.test(event.payload.diffRef.sha256)
    || !Number.isSafeInteger(event.payload.diffRef.bytes)
    || event.payload.diffRef.bytes < 0
    || event.payload.diffRef.sha256 !== diffSha256
    || event.payload.diffRef.bytes !== diffBytes
  ) {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `aggregate diff 正文与引用摘要不一致：eventSeq=${event.seq}`,
    );
  }
  let parsed: StructuredPatch[];
  try {
    parsed = parsePatch(diffText);
  } catch {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `aggregate diff 解析失败：eventSeq=${event.seq}`,
    );
  }
  const rawPatchShapes = validateAggregateDiffStructure(diffText);
  if (diffText.trim() && parsed.length === 0) {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `aggregate diff 不是有效 unified diff：eventSeq=${event.seq}`,
    );
  }
  if (rawPatchShapes.length !== parsed.length) {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `aggregate diff 文件段数量不一致：eventSeq=${event.seq}`,
    );
  }
  const capturedAt = Number(event.ts);
  if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0) {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `aggregate diff 缺少有效采集时间：eventSeq=${event.seq}`,
    );
  }

  const seenPaths = new Set<string>();
  const patches: CandidatePatch[] = [];
  const issues: LocalCodeAttributionEvidenceIssue[] = [];
  for (let patchIndex = 0; patchIndex < parsed.length; patchIndex += 1) {
    const patch = parsed[patchIndex]!;
    const pathIdentity = resolveStructuredPatchIdentity(workspacePath, patch, patchIndex);
    validateStructuredPatch(patch, pathIdentity.operation, rawPatchShapes[patchIndex]);
    const normalizedPath = pathIdentity.path;
    if (seenPaths.has(normalizedPath)) {
      throw evidenceError(
        "patch_path_ambiguous",
        "ambiguous_attribution",
        `aggregate diff 文件路径重复：patchIndex=${patchIndex}`,
      );
    }
    seenPaths.add(normalizedPath);
    if (patch.isBinary) {
      issues.push(createIssue({
        code: "binary_file",
        qualityReason: "binary_file",
        message: `二进制文件不进入代码行归因：eventSeq=${event.seq}, path=${normalizedPath}`,
        ...associationIssueScope(association),
        path: normalizedPath,
      }));
      continue;
    }
    if (patch.hunks.length === 0) continue;

    const patchText = formatCanonicalPatch(patch, normalizedPath, pathIdentity.operation);
    patches.push(createPatchRecord({
      association,
      source: "codex_aggregate_diff",
      path: normalizedPath,
      operation: pathIdentity.operation,
      addedLines: extractHunkLines(patch, "+"),
      removedLines: extractHunkLines(patch, "-"),
      patchText,
      evidenceRef: `conversation-diff:${event.seq}:${diffSha256}`,
      capturedAt,
      beforeLines: null,
      afterLines: null,
    }));
  }
  return { patches, issues };
}

/** 完整消费 Git unified diff，拒绝 parsePatch 会忽略的尾随内容和畸形原始 Hunk。 */
function validateAggregateDiffStructure(diffText: string): RawPatchShape[] {
  if (!diffText.trim()) return [];
  const lines = diffText.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  while (lines.at(-1) === "") lines.pop();
  const patches: RawPatchShape[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index]?.startsWith("diff --git ")) {
      throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", `aggregate diff 包含未识别内容：line=${index + 1}`);
    }
    index += 1;
    const shape: RawPatchShape = { hunks: [] };
    patches.push(shape);
    let sawBinary = false;
    let sawOldHeader = false;
    let sawNewHeader = false;

    while (index < lines.length && !lines[index]?.startsWith("diff --git ") && !lines[index]?.startsWith("@@ ")) {
      const line = lines[index]!;
      if (line.startsWith("--- ")) {
        if (sawOldHeader || sawNewHeader || sawBinary) throwInvalidAggregateLine(index);
        sawOldHeader = true;
        index += 1;
        continue;
      }
      if (line.startsWith("+++ ")) {
        if (!sawOldHeader || sawNewHeader || sawBinary) throwInvalidAggregateLine(index);
        sawNewHeader = true;
        index += 1;
        continue;
      }
      if (/^Binary files .+ differ$/u.test(line)) {
        if (sawOldHeader || sawNewHeader || sawBinary) throwInvalidAggregateLine(index);
        sawBinary = true;
        index += 1;
        continue;
      }
      if (line === "GIT binary patch" || !AGGREGATE_GIT_METADATA_PATTERNS.some((pattern) => pattern.test(line))) {
        throwInvalidAggregateLine(index);
      }
      index += 1;
    }

    if (sawOldHeader !== sawNewHeader) throwInvalidAggregateLine(index - 1);
    if (sawBinary) {
      if (index < lines.length && !lines[index]?.startsWith("diff --git ")) throwInvalidAggregateLine(index);
      continue;
    }

    while (index < lines.length && lines[index]?.startsWith("@@ ")) {
      if (!sawOldHeader || !sawNewHeader) throwInvalidAggregateLine(index);
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(lines[index]!);
      if (!header) throwInvalidAggregateLine(index);
      const hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] == null ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] == null ? 1 : Number(header[4]),
      };
      if (!Object.values(hunk).every(Number.isSafeInteger)) throwInvalidAggregateLine(index);
      shape.hunks.push(hunk);
      index += 1;
      let oldCount = 0;
      let newCount = 0;
      let sawContentLine = false;
      while (oldCount < hunk.oldLines || newCount < hunk.newLines) {
        const line = lines[index];
        if (line == null) throwInvalidAggregateLine(index);
        const prefix = line[0];
        if (prefix === " ") {
          oldCount += 1;
          newCount += 1;
        } else if (prefix === "-") {
          oldCount += 1;
        } else if (prefix === "+") {
          newCount += 1;
        } else if (line === "\\ No newline at end of file" && sawContentLine) {
          index += 1;
          continue;
        } else {
          throwInvalidAggregateLine(index);
        }
        sawContentLine = true;
        if (oldCount > hunk.oldLines || newCount > hunk.newLines) throwInvalidAggregateLine(index);
        index += 1;
      }
      if (lines[index] === "\\ No newline at end of file") index += 1;
    }

    if (index < lines.length && !lines[index]?.startsWith("diff --git ")) throwInvalidAggregateLine(index);
  }
  return patches;
}

/** 抛出不含源码正文的 aggregate 结构错误。 */
function throwInvalidAggregateLine(index: number): never {
  throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", `aggregate diff 结构无效：line=${index + 1}`);
}

/** 从 turn 文件快照生成结构化 Patch；缺失、损坏和二进制均返回显式问题。 */
function buildSnapshotPatch(
  db: ClientDb,
  workspacePath: string,
  association: ExecutionAssociation,
  change: TurnFileChangeRecord,
): { patch: CandidatePatch } | { issue: LocalCodeAttributionEvidenceIssue } {
  const path = normalizeEvidencePath(workspacePath, change.path);
  if (!path) {
    return { issue: createIssue({
      code: "patch_path_invalid",
      qualityReason: "ambiguous_attribution",
      message: `文件变更路径无效或越过工作区：changeId=${change.id}`,
      ...associationIssueScope(association),
    }) };
  }

  try {
    validateFileChangeOperation(change);
    if (!Number.isSafeInteger(change.capturedAt) || change.capturedAt <= 0) {
      throw evidenceError(
        "patch_snapshot_corrupt",
        "patch_snapshot_corrupt",
        `文件变更缺少有效采集时间：changeId=${change.id}`,
      );
    }
    const before = readSnapshotContent(db, change.beforeExists, change.beforeBlobId, change.id, "before");
    const after = readSnapshotContent(db, change.afterExists, change.afterBlobId, change.id, "after");
    if (before == null || after == null) {
      return { issue: createIssue({
        code: "binary_file",
        qualityReason: "binary_file",
        message: `二进制文件不进入代码行归因：changeId=${change.id}, path=${path}`,
        ...associationIssueScope(association),
        path,
      }) };
    }
    let patch: StructuredPatch;
    try {
      patch = structuredPatch(path, path, before, after, "", "", { context: 3, stripTrailingCr: false });
    } catch {
      throw evidenceError(
        "patch_snapshot_corrupt",
        "patch_snapshot_corrupt",
        `文件快照无法生成 Patch：changeId=${change.id}`,
      );
    }
    validateStructuredPatch(patch, change.op);
    const patchText = formatCanonicalPatch(patch, path, change.op);
    return { patch: createPatchRecord({
      association,
      source: "turn_file_snapshot",
      path,
      operation: change.op,
      addedLines: extractHunkLines(patch, "+"),
      removedLines: extractHunkLines(patch, "-"),
      patchText,
      evidenceRef: `turn-file-change:${change.id}`,
      capturedAt: change.capturedAt,
      beforeLines: splitTextLines(before),
      afterLines: splitTextLines(after),
    }) };
  } catch (cause) {
    if (!(cause instanceof EvidenceValidationError)) throw cause;
    return { issue: createIssue({
      code: cause.issueCode,
      qualityReason: cause.qualityReason,
      message: `文件快照无法形成代码归因证据：changeId=${change.id}, path=${path}, cause=${cause.message}`,
      ...associationIssueScope(association),
      path,
    }) };
  }
}

/** 读取并校验 Blob 摘要、长度和编码；不存在与损坏使用不同错误前缀。 */
function readSnapshotContent(
  db: ClientDb,
  exists: boolean,
  blobId: string | null,
  changeId: number,
  side: "before" | "after",
): string | null {
  if (!exists) {
    if (blobId) {
      throw evidenceError(
        "patch_snapshot_corrupt",
        "patch_snapshot_corrupt",
        `不存在的 ${side} 快照仍绑定 Blob：changeId=${changeId}`,
      );
    }
    return "";
  }
  if (!blobId) {
    throw evidenceError(
      "patch_snapshot_missing",
      "patch_snapshot_missing",
      `${side} 快照缺少 Blob 标识：changeId=${changeId}`,
    );
  }
  const blob = db.db.prepare(`
    SELECT blob_id, byte_len, encoding, data
    FROM file_blobs
    WHERE blob_id = ?
  `).get(blobId) as { blob_id?: string; byte_len?: number; encoding?: string; data?: Buffer } | undefined;
  if (!blob) {
    throw evidenceError(
      "patch_snapshot_missing",
      "patch_snapshot_missing",
      `${side} Blob 不存在：changeId=${changeId}, blobId=${blobId}`,
    );
  }
  const storedBlobId = String(blob.blob_id ?? "");
  const byteLen = Number(blob.byte_len);
  const encoding = String(blob.encoding ?? "");
  const data = Buffer.from(blob.data ?? Buffer.alloc(0));
  if (
    storedBlobId !== blobId
    || !Number.isSafeInteger(byteLen)
    || byteLen < 0
    || byteLen !== data.byteLength
    || sha256(data) !== storedBlobId
  ) {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `${side} Blob 摘要或长度不一致：changeId=${changeId}, blobId=${blobId}`,
    );
  }
  if (encoding === "binary") return null;
  if (encoding !== "utf8" && encoding !== "gb18030") {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `${side} Blob 编码无效：changeId=${changeId}, blobId=${blobId}`,
    );
  }
  try {
    return decodeSnapshotText(data, encoding, byteLen);
  } catch {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `${side} Blob 正文无法按声明编码解码：changeId=${changeId}, blobId=${blobId}`,
    );
  }
}

/** 按路径和时间建立取代链，并计算每个文件当前仍有效的 AI 候选行。 */
function finalizePatchChains(input: CandidatePatch[]): FinalizePatchChainsResult {
  const sorted = [...input].sort((left, right) =>
    comparePatchExecution(left, right)
    || left.capturedAt - right.capturedAt
    || compareText(left.path, right.path)
    || compareText(left.patchId, right.patchId));
  const ambiguousPaths = findAmbiguousPatchPaths(sorted);
  const latestByPath = new Map<string, CandidatePatch>();
  const stateByPath = new Map<string, Map<string, string[]>>();
  const patchIdsByPath = new Map<string, string[]>();
  const finalized: LocalCodeAttributionPatch[] = [];

  for (const patch of sorted) {
    if (ambiguousPaths.has(patch.path)) {
      finalized.push(toPublicPatch(patch, null));
      continue;
    }
    const previous = latestByPath.get(patch.path) ?? null;
    const candidateState = patch.operation === "create"
      ? new Map<string, string[]>()
      : stateByPath.get(patch.path) ?? new Map<string, string[]>();
    if (patch.beforeLines) capCandidateState(candidateState, patch.beforeLines);
    removeCandidateLines(candidateState, patch.removedLines);
    addCandidateLines(candidateState, patch.addedLines);
    if (patch.afterLines) capCandidateState(candidateState, patch.afterLines);
    if (patch.operation === "delete") candidateState.clear();
    stateByPath.set(patch.path, candidateState);
    latestByPath.set(patch.path, patch);
    patchIdsByPath.set(patch.path, [...(patchIdsByPath.get(patch.path) ?? []), patch.patchId]);
    finalized.push(toPublicPatch(patch, previous?.patchId ?? null));
  }

  const candidateFiles = Array.from(latestByPath.entries())
    .map(([path, latest]) => ({
      path,
      localPathSha256: latest.localPathSha256,
      candidateAddedLines: flattenCandidateState(stateByPath.get(path) ?? new Map()),
      patchIds: patchIdsByPath.get(path) ?? [],
      latestPatchId: latest.patchId,
    }))
    .sort((left, right) => compareText(left.path, right.path));
  const issues = Array.from(ambiguousPaths).sort(compareText).map((path) => createIssue({
    code: "execution_association_mismatch",
    qualityReason: "ambiguous_attribution",
    message: `同一路径存在无法确定先后顺序的并发执行：path=${path}`,
    path,
  }));
  return { patches: finalized, candidateFiles, issues };
}

/** 使用同线程事件边界或跨线程执行时间比较 Patch，禁止比较不同线程的 seq。 */
function comparePatchExecution(left: CandidatePatch, right: CandidatePatch): number {
  if (String(left.threadId) === String(right.threadId)) {
    return left.executionStartEventSeq - right.executionStartEventSeq
      || left.executionEndEventSeq - right.executionEndEventSeq;
  }
  return left.executionStartedAt - right.executionStartedAt
    || left.executionEndedAt - right.executionEndedAt
    || compareText(String(left.threadId), String(right.threadId));
}

/** 找出同路径无全局因果顺序的执行，避免建立伪造的 supersedes 链。 */
function findAmbiguousPatchPaths(patches: CandidatePatch[]): Set<string> {
  const byPath = new Map<string, CandidatePatch[]>();
  for (const patch of patches) byPath.set(patch.path, [...(byPath.get(patch.path) ?? []), patch]);
  const ambiguous = new Set<string>();
  for (const [path, pathPatches] of byPath) {
    for (let leftIndex = 0; leftIndex < pathPatches.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < pathPatches.length; rightIndex += 1) {
        if (!hasDeterministicExecutionOrder(pathPatches[leftIndex]!, pathPatches[rightIndex]!)) {
          ambiguous.add(path);
        }
      }
    }
  }
  return ambiguous;
}

/** 判断两个 Patch 的执行边界是否给出唯一先后关系。 */
function hasDeterministicExecutionOrder(left: CandidatePatch, right: CandidatePatch): boolean {
  if (String(left.turnId) === String(right.turnId)) return false;
  if (String(left.threadId) === String(right.threadId)) {
    const leftBeforeRight = left.executionEndEventSeq < right.executionStartEventSeq;
    const rightBeforeLeft = right.executionEndEventSeq < left.executionStartEventSeq;
    return leftBeforeRight !== rightBeforeLeft;
  }
  const leftBeforeRight = left.executionEndedAt <= right.executionStartedAt;
  const rightBeforeLeft = right.executionEndedAt <= left.executionStartedAt;
  return leftBeforeRight !== rightBeforeLeft;
}

/** 移除候选状态内部字段并设置确定的取代关系。 */
function toPublicPatch(patch: CandidatePatch, supersedesPatchId: string | null): LocalCodeAttributionPatch {
  const {
    beforeLines: _beforeLines,
    afterLines: _afterLines,
    executionStartedAt: _executionStartedAt,
    executionEndedAt: _executionEndedAt,
    executionStartEventSeq: _executionStartEventSeq,
    executionEndEventSeq: _executionEndEventSeq,
    ...publicPatch
  } = patch;
  return { ...publicPatch, supersedesPatchId };
}

/** 创建带稳定摘要和本地执行归属的单文件 Patch。 */
function createPatchRecord(input: Omit<CandidatePatch, keyof LocalCodeAttributionPatch | "patchId" | "patchSha256" | "localPathSha256" | "supersedesPatchId" | "executionStartedAt" | "executionEndedAt" | "executionStartEventSeq" | "executionEndEventSeq"> & {
  association: ExecutionAssociation;
  source: LocalCodeAttributionPatch["source"];
  path: string;
  operation: LocalCodeAttributionPatch["operation"];
  addedLines: string[];
  removedLines: string[];
  patchText: string;
  evidenceRef: string;
  capturedAt: number;
  beforeLines: string[] | null;
  afterLines: string[] | null;
}): CandidatePatch {
  const patchSha256 = sha256(input.patchText);
  const localPathSha256 = sha256(input.path);
  const patchId = sha256([
    input.source,
    input.association.promptSnapshotId,
    input.association.turnId,
    input.path,
    patchSha256,
  ].join("\u0000"));
  return {
    patchId,
    source: input.source,
    workspaceId: input.association.workspaceId,
    instanceId: input.association.instanceId,
    nodeId: input.association.nodeId,
    attemptId: input.association.attemptId,
    attemptNo: input.association.attemptNo,
    promptSnapshotId: input.association.promptSnapshotId,
    threadId: input.association.threadId,
    turnId: input.association.turnId,
    path: input.path,
    localPathSha256,
    operation: input.operation,
    addedLines: input.addedLines,
    removedLines: input.removedLines,
    patchText: input.patchText,
    patchSha256,
    evidenceRef: input.evidenceRef,
    capturedAt: input.capturedAt,
    supersedesPatchId: null,
    beforeLines: input.beforeLines,
    afterLines: input.afterLines,
    executionStartedAt: input.association.startedAt,
    executionEndedAt: input.association.endedAt,
    executionStartEventSeq: input.association.startEventSeq,
    executionEndEventSeq: input.association.endEventSeq,
  };
}

/** 校验操作语义、Hunk 顺序和行数守恒，拒绝宽松解析后的畸形 Patch。 */
function validateStructuredPatch(
  patch: StructuredPatch,
  operation: LocalCodeAttributionPatch["operation"],
  rawShape?: RawPatchShape,
): void {
  if (!Array.isArray(patch.hunks)) {
    throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "Patch 缺少 Hunk 集合");
  }
  if (
    patch.isRename
    || patch.isCopy
    || (operation === "create" && patch.isDelete)
    || (operation === "delete" && patch.isCreate)
    || (operation === "modify" && (patch.isCreate || patch.isDelete))
    || (patch.isBinary && patch.hunks.length > 0)
  ) {
    throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "Patch 操作元数据互相冲突");
  }
  let previousOldEnd = -1;
  let previousNewEnd = -1;
  for (let hunkIndex = 0; hunkIndex < patch.hunks.length; hunkIndex += 1) {
    const hunk = patch.hunks[hunkIndex]!;
    const rawHunk = rawShape?.hunks[hunkIndex];
    if (
      !Number.isSafeInteger(hunk.oldStart)
      || !Number.isSafeInteger(hunk.newStart)
      || !Number.isSafeInteger(hunk.oldLines)
      || !Number.isSafeInteger(hunk.newLines)
      || hunk.oldStart < 0
      || hunk.newStart < 0
      || hunk.oldLines < 0
      || hunk.newLines < 0
      || !Array.isArray(hunk.lines)
    ) {
      throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "Patch Hunk 元数据无效");
    }
    if (
      hunk.oldStart < previousOldEnd
      || hunk.newStart < previousNewEnd
      || (operation === "create" && hunk.oldLines !== 0)
      || (operation === "delete" && hunk.newLines !== 0)
    ) {
      throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "Patch Hunk 区间重叠或与文件操作不一致");
    }
    if (
      rawShape
      && (!rawHunk
        || (rawHunk.oldLines > 0 && rawHunk.oldStart === 0)
        || (rawHunk.newLines > 0 && rawHunk.newStart === 0)
        || (operation === "create" && (rawHunk.oldStart !== 0 || rawHunk.oldLines !== 0))
        || (operation === "delete" && (rawHunk.newStart !== 0 || rawHunk.newLines !== 0)))
    ) {
      throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "Patch Hunk 原始区间与文件操作不一致");
    }
    previousOldEnd = hunk.oldStart + Math.max(1, hunk.oldLines);
    previousNewEnd = hunk.newStart + Math.max(1, hunk.newLines);
    let oldLines = 0;
    let newLines = 0;
    for (const line of hunk.lines) {
      if (typeof line !== "string") {
        throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "Patch Hunk 包含非文本行");
      }
      const prefix = line[0];
      if (prefix === " ") {
        oldLines += 1;
        newLines += 1;
      } else if (prefix === "-") {
        oldLines += 1;
      } else if (prefix === "+") {
        newLines += 1;
      } else if (line !== "\\ No newline at end of file") {
        throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "Patch Hunk 包含无效行前缀");
      }
    }
    if (oldLines !== hunk.oldLines || newLines !== hunk.newLines) {
      throw evidenceError(
        "patch_snapshot_corrupt",
        "patch_snapshot_corrupt",
        `Patch Hunk 行数不守恒：old=${oldLines}/${hunk.oldLines}, new=${newLines}/${hunk.newLines}`,
      );
    }
  }
  if (rawShape && rawShape.hunks.length !== patch.hunks.length) {
    throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "Patch Hunk 数量不一致");
  }
}

/** 按 +/- 前缀提取非空代码行，保留原始行内容供后续多重集归因。 */
function extractHunkLines(patch: StructuredPatch, prefix: "+" | "-"): string[] {
  return patch.hunks.flatMap((hunk) => hunk.lines)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(1))
    .filter((line) => normalizeOrchestrationCodeAttributionLine(line) != null);
}

/** 校验文件存在性与 create/modify/delete 操作一致。 */
function validateFileChangeOperation(change: TurnFileChangeRecord): void {
  const expected = !change.beforeExists && change.afterExists
    ? "create"
    : change.beforeExists && !change.afterExists
      ? "delete"
      : change.beforeExists && change.afterExists
        ? "modify"
        : null;
  if (!expected || expected !== change.op) {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `文件变更操作与存在性不一致：changeId=${change.id}, op=${change.op}`,
    );
  }
}

/** 将 Patch 路径限制在当前工作区内。 */
function normalizePatchPath(workspacePath: string, rawPath: string): string | null {
  if (!rawPath || rawPath === "/dev/null" || rawPath.includes("\u0000")) return null;
  return normalizeEvidencePath(workspacePath, rawPath.replace(/^(?:a|b)\//u, ""));
}

/** 规范证据路径并拒绝会破坏 Patch Header 的控制字符。 */
function normalizeEvidencePath(workspacePath: string, rawPath: unknown): string | null {
  const normalized = normalizeWorkspaceRelativePosixPath({ workspacePath, rawPath });
  return normalized && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : null;
}

/** 同时校验 Patch 新旧路径；跨文件移动不猜测为单文件归因。 */
function resolveStructuredPatchIdentity(
  workspacePath: string,
  patch: StructuredPatch,
  patchIndex: number,
): { path: string; operation: LocalCodeAttributionPatch["operation"] } {
  const hasExplicitFileHeaders = patch.oldHeader !== undefined || patch.newHeader !== undefined;
  if (
    (patch.isCreate && patch.isDelete)
    || (hasExplicitFileHeaders && patch.isCreate && patch.oldFileName !== "/dev/null")
    || (hasExplicitFileHeaders && patch.isDelete && patch.newFileName !== "/dev/null")
  ) {
    throw evidenceError(
      "patch_snapshot_corrupt",
      "patch_snapshot_corrupt",
      `aggregate diff 文件操作元数据冲突：patchIndex=${patchIndex}`,
    );
  }
  const oldIsMissing = patch.oldFileName === "/dev/null" || Boolean(patch.isCreate && !hasExplicitFileHeaders);
  const newIsMissing = patch.newFileName === "/dev/null" || Boolean(patch.isDelete && !hasExplicitFileHeaders);
  const oldPath = oldIsMissing ? null : normalizePatchPath(workspacePath, String(patch.oldFileName ?? ""));
  const newPath = newIsMissing ? null : normalizePatchPath(workspacePath, String(patch.newFileName ?? ""));
  if ((!oldIsMissing && !oldPath) || (!newIsMissing && !newPath) || (oldIsMissing && newIsMissing)) {
    throw evidenceError(
      "patch_path_invalid",
      "ambiguous_attribution",
      `aggregate diff 文件路径无效或越过工作区：patchIndex=${patchIndex}`,
    );
  }
  if (oldIsMissing) return { path: newPath!, operation: "create" };
  if (newIsMissing) return { path: oldPath!, operation: "delete" };
  if (oldPath !== newPath || patch.isRename) {
    throw evidenceError(
      "patch_path_ambiguous",
      "ambiguous_attribution",
      `aggregate diff 跨文件移动无法形成单文件归因：patchIndex=${patchIndex}`,
    );
  }
  return { path: newPath!, operation: "modify" };
}

/** 白名单重建规范 Patch，避免 Header、模式或扩展元数据泄露本机路径。 */
function formatCanonicalPatch(
  patch: StructuredPatch,
  path: string,
  operation: LocalCodeAttributionPatch["operation"],
): string {
  const canonicalPatch: StructuredPatch = {
    oldFileName: operation === "create" ? "/dev/null" : `a/${path}`,
    newFileName: operation === "delete" ? "/dev/null" : `b/${path}`,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: patch.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: [...hunk.lines],
    })),
    isGit: true,
  };
  try {
    return formatPatch(canonicalPatch);
  } catch {
    throw evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "Patch 无法规范化输出");
  }
}

/** 找出会导致执行归属不唯一的重复 thread/turn Snapshot。 */
function findDuplicateSnapshotTurnKeys(
  snapshots: ReturnType<ClientDb["orchPromptSnapshots"]["listByInstance"]>,
): Set<string> {
  const counts = new Map<string, number>();
  for (const snapshot of snapshots) {
    if (!snapshot.threadId || !snapshot.turnId) continue;
    const key = `${String(snapshot.threadId)}\u0000${String(snapshot.turnId)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(Array.from(counts).filter(([, count]) => count > 1).map(([key]) => key));
}

/** 以当前文件内容的多重集上限裁剪历史候选行。 */
function capCandidateState(state: Map<string, string[]>, contentLines: string[]): void {
  const limits = countNormalizedLines(contentLines);
  for (const [key, values] of state) {
    const limit = limits.get(key) ?? 0;
    if (values.length <= limit) continue;
    if (limit === 0) state.delete(key);
    else state.set(key, values.slice(0, limit));
  }
}

/** 从历史候选多重集中扣除本轮 Patch 删除行。 */
function removeCandidateLines(state: Map<string, string[]>, lines: string[]): void {
  const removals = countNormalizedLines(lines);
  for (const [key, count] of removals) {
    const values = state.get(key) ?? [];
    if (values.length <= count) state.delete(key);
    else state.set(key, values.slice(count));
  }
}

/** 将本轮 AI 新增行加入候选多重集。 */
function addCandidateLines(state: Map<string, string[]>, lines: string[]): void {
  for (const line of lines) {
    const key = normalizeOrchestrationCodeAttributionLine(line);
    if (key == null) continue;
    state.set(key, [...(state.get(key) ?? []), line]);
  }
}

/** 统计规范化后的非空行多重集。 */
function countNormalizedLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = normalizeOrchestrationCodeAttributionLine(line);
    if (key == null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** 以稳定键顺序展开候选多重集，避免数据库读取顺序影响证据摘要。 */
function flattenCandidateState(state: Map<string, string[]>): string[] {
  return Array.from(state.entries())
    .sort(([left], [right]) => compareText(left, right))
    .flatMap(([, lines]) => lines);
}

/** 按通用换行规则拆分文件正文。 */
function splitTextLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/u);
}

/** 创建字段齐全的本地质量问题。 */
function createIssue(input: Partial<LocalCodeAttributionEvidenceIssue> & Pick<LocalCodeAttributionEvidenceIssue, "code" | "qualityReason" | "message">): LocalCodeAttributionEvidenceIssue {
  return {
    code: input.code,
    qualityReason: input.qualityReason,
    message: input.message,
    promptSnapshotId: input.promptSnapshotId ?? null,
    threadId: input.threadId ?? null,
    turnId: input.turnId ?? null,
    path: input.path ?? null,
  };
}

/** 按稳定字段去重同一问题，避免双路二进制排除重复展示。 */
function deduplicateIssues(issues: LocalCodeAttributionEvidenceIssue[]): LocalCodeAttributionEvidenceIssue[] {
  const unique = new Map<string, LocalCodeAttributionEvidenceIssue>();
  for (const issue of issues) {
    const key = [issue.code, issue.qualityReason, issue.promptSnapshotId, issue.threadId, issue.turnId, issue.path].join("\u0000");
    if (!unique.has(key)) unique.set(key, issue);
  }
  return Array.from(unique.values());
}

/** 复用执行归属字段填充质量问题上下文。 */
function associationIssueScope(association: ExecutionAssociation): Pick<LocalCodeAttributionEvidenceIssue, "promptSnapshotId" | "threadId" | "turnId"> {
  return {
    promptSnapshotId: association.promptSnapshotId,
    threadId: String(association.threadId),
    turnId: String(association.turnId),
  };
}

/** 将已知 aggregate 存储错误转换为证据质量，数据库和程序错误保持失败。 */
function normalizeAggregateEvidenceError(cause: unknown): EvidenceValidationError | null {
  if (cause instanceof EvidenceValidationError) return cause;
  const message = errorMessage(cause);
  if (/^aggregate diff snapshot missing:/u.test(message)) {
    return evidenceError("patch_snapshot_missing", "patch_snapshot_missing", "aggregate diff 外置正文不存在");
  }
  if (/^aggregate diff snapshot metadata mismatch:/u.test(message)) {
    return evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "aggregate diff 外置正文元数据不一致");
  }
  if (cause instanceof SyntaxError) {
    return evidenceError("patch_snapshot_corrupt", "patch_snapshot_corrupt", "aggregate diff 事件正文无法解析");
  }
  return null;
}

/** 安全提取错误原因，供本地质量问题审计。 */
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 创建本模块可识别的证据校验错误。 */
function evidenceError(
  issueCode: LocalCodeAttributionEvidenceIssueCode,
  qualityReason: OrchestrationMetricCodeAttributionQualityReason,
  message: string,
): EvidenceValidationError {
  return new EvidenceValidationError(issueCode, qualityReason, message);
}

/** 使用 UTF-16 码元顺序排序，避免系统区域设置影响证据顺序。 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 计算本地证据稳定 SHA-256。 */
function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
