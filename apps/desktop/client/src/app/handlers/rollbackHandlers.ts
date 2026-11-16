import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ConversationEventEnvelope, EngineType, RollbackEvidenceIssue, RollbackFileInfo, SessionId, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import type { ThreadRollbackRecord } from "../../db/repos/threadRollbackRepo.js";
import {
  decideCodexProviderTurnMapping,
} from "../../db/repos/codexProviderTurnMapping.js";
import { resolveThreadRunningState } from "../threadRunningState.js";
import {
  prepareCodexProviderTurnHistoryBatch,
  type CodexProviderTurnHistoryBatch,
} from "../utils/codexTurnHistory.js";
import { deriveClaudeCheckpointByteLenByDropping, deriveClaudeSessionCheckpointByteLen, readClaudeSessionFileByteLen, resolveClaudeSessionFilePath, truncateClaudeSessionToByteLen } from "../../engines/claude/claudeSessionStore.js";
import { analyzeUnifiedDiffPaths } from "../../engines/toolFilePaths.js";
import { logger } from "../../logger.js";

// ── Shared types for extracted helpers ───────────────────────────

type TurnRecord = {
  turnId: TurnId;
  threadId: ThreadId;
  startEventSeq: number | null;
  endEventSeq: number | null;
  startedAt: number | null;
  endedAt: number | null;
  status: string;
  engineCheckpointJson: string | null;
  [k: string]: unknown;
};

type ValidatedInputs = {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  toTurnId: TurnId;
  thread: { engine: EngineType; sessionId: SessionId | null; workspaceId: WorkspaceId; [k: string]: unknown };
  toTurn: TurnRecord;
  workspacePath: string;
  codexHistoryBatch: CodexProviderTurnHistoryBatch | null;
};

type RollbackBoundary = {
  turnsToDrop: TurnRecord[];
  boundarySeq: number;
  boundaryTurn: TurnRecord | null;
  boundaryTurnOrdinal: number;
  orderedByStart: TurnRecord[];
  targetIdx: number;
};

type FileSnapshot = { exists: boolean; data: Buffer | null };

type FileCompensationEntry = {
  expectedCurrent: FileSnapshot;
  restore: FileSnapshot;
};

type RollbackAssessment = {
  affectedPaths: string[];
  files: RollbackFileInfo[];
  evidenceComplete: boolean;
  evidenceIssues: RollbackEvidenceIssue[];
  currentSnapshots: Map<string, FileSnapshot>;
};

type RollbackFileChangeRecord = ReturnType<ApiHandlerContext["db"]["fileChanges"]["listByThread"]>[number];

type RollbackFileChangeIndex = {
  byTurn: Map<TurnId, RollbackFileChangeRecord[]>;
  byPath: Map<string, RollbackFileChangeRecord[]>;
  recordCount: number;
};

type CodexTurnDiffEvidence = {
  engineTurnId: string | null;
  eventSeq: number;
  diffSha256: string;
  paths: string[];
};

type CodexProviderTurnEvidence = {
  engineTurnId: string;
  engineSessionId: SessionId | null;
  previousEngineTurnId: string | null;
  supersededEngineTurnIds?: string[];
  source: "turn.engineBound" | "turn/started";
  eventSeq: number;
  observedAt: number;
};

type CodexProviderHistoryExpectation = {
  droppedTurnIds: string[];
  retainedTurnId: string | null;
};

type CodexProviderTurnDisposition =
  | { kind: "provider"; turnId: string }
  | { kind: "local_only" };

type PreparedCodexRollbackHistory = CodexProviderHistoryExpectation & {
  sessionId: SessionId;
  numTurns: number;
  beforeTurnIds: string[];
  afterTurnIds: string[];
};

type RollbackFileStateRef = {
  exists: boolean;
  blobId: string | null;
  sha256: string | null;
};

type RollbackFileRecoveryPlan = {
  path: string;
  pre: RollbackFileStateRef;
  target: RollbackFileStateRef;
  /** 多段 inverse 的可达中间内容；旧 v1 audit 没有该字段时仍只接受 pre/target。 */
  intermediateStates?: RollbackFileStateRef[];
};

type RollbackRecoveryPlan = {
  v: 1;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  engine: EngineType;
  engineSessionId: SessionId | null;
  boundarySeq: number;
  toTurnId: TurnId;
  droppedTurnIds: TurnId[];
  rollbackFiles: boolean;
  skippedFileCount: number;
  /** 回滚裁剪前该 thread 已持久化的最大 canonical event seq。 */
  rollbackEventSeqBarrier?: number;
  /** 实际需要从 Codex provider 历史裁剪的 turn 数；旧审计缺失时等同本地 droppedTurnIds 数。 */
  codexProviderDroppedTurnCount?: number;
  files: RollbackFileRecoveryPlan[];
  codexHistory: { beforeTurnIds: string[]; afterTurnIds: string[] } | null;
};

class CodexProviderTurnMappingMissingError extends Error {}

const activeRollbackMutations = new Set<ThreadId>();

/** 仅同步数据库段占用许可，provider 与证据屏障等待保持在许可之外。 */
function withRollbackDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

/** 返回当前正在执行文件或 provider 历史变更的回滚 thread 快照。 */
export function listActiveRollbackMutationThreadIds(): ThreadId[] {
  return [...activeRollbackMutations];
}

/** 在任何证据冲刷或历史扫描前拒绝同一 thread 的并发回滚请求。 */
function rejectActiveRollbackMutation(ctx: Pick<ApiHandlerContext, "send">, req: ApiRequestMessage): boolean {
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  if (!threadId || !activeRollbackMutations.has(threadId)) return false;
  logger.warn("rollback", "rollback request rejected because another rollback is active", {
    errorCode: "rollback_in_progress",
    ...readRollbackRequestLogContext(req),
  });
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 409,
    body: { ok: false, code: "rollback_in_progress", message: "当前会话正在执行历史回滚，请稍后重试" },
  });
  return true;
}

// ── Extracted helpers ────────────────────────────────────────────

/** 校验输入参数并返回解析后的对象，校验失败时发送错误响应并返回 null。 */
async function validateRollbackInputs(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
): Promise<ValidatedInputs | null> {
  const scope = await withRollbackDatabase(ctx, req.id, () => {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  const toTurnId = String((req.body as any)?.toTurnId ?? "").trim() as TurnId;
  if (!workspaceId || !threadId || !toTurnId) {
    logger.warn("rollback", "rollback request rejected because required identifiers are missing", {
      errorCode: "rollback_invalid_input",
      ...readRollbackRequestLogContext(req),
    });
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/toTurnId" } });
    return null;
  }

  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    logger.warn("rollback", "rollback request rejected because workspace is unknown", {
      errorCode: "rollback_workspace_not_found",
      ...readRollbackRequestLogContext(req),
    });
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return null;
  }

  let thread = ctx.db.threads.get(threadId);
  if (!thread) {
    logger.warn("rollback", "rollback request rejected because thread was not found", {
      errorCode: "rollback_thread_not_found",
      ...readRollbackRequestLogContext(req),
    });
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return null;
  }
  if (thread.workspaceId !== workspaceId) {
    logger.warn("rollback", "rollback request rejected because thread workspace mismatched", {
      errorCode: "rollback_workspace_mismatch",
      ...readRollbackRequestLogContext(req),
      threadWorkspaceId: thread.workspaceId,
    });
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return null;
  }

  const running = resolveThreadRunningState(ctx, { workspaceId, threadId });
  if (running) {
    logger.warn("rollback", "rollback request rejected because thread is running", {
      errorCode: "rollback_thread_running",
      requestId: req.id,
      method: req.method,
      workspaceId,
      threadId,
      toTurnId,
      runningTurnId: running.runningTurnId,
    });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        code: "rollback_thread_running",
        message: "thread 运行中，禁止回滚（请先停止/等待完成）",
        details: running,
      },
    });
    return null;
  }

  return { workspaceId, threadId, toTurnId, thread, workspacePath };
  });
  if (!scope || !await flushRollbackEvidence(ctx, req)) return null;
  return await withRollbackDatabase(ctx, req.id, () => {
  const { workspaceId, threadId, toTurnId, workspacePath } = scope;
  let { thread } = scope;
  let codexHistoryBatch: CodexProviderTurnHistoryBatch | null;
  try {
    codexHistoryBatch = ensureThreadTurnsIndexedFromEvents(ctx, { threadId });
  } catch (cause) {
    logger.error("rollback", "rollback history indexing failed", {
      errorCode: "rollback_provider_history_evidence_incomplete",
      requestId: req.id,
      method: req.method,
      workspaceId,
      threadId,
      toTurnId,
      rootCause: formatError(cause, "回滚历史索引证据不完整"),
    });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        code: "rollback_provider_history_evidence_incomplete",
        message: formatError(cause, "回滚历史索引证据不完整"),
      },
    });
    return null;
  }
  thread = ctx.db.threads.get(threadId) ?? thread;

  const toTurn = ctx.db.turns.get(toTurnId);
  if (!toTurn || toTurn.threadId !== threadId) {
    logger.warn("rollback", "rollback request rejected because target turn was not found in thread", {
      errorCode: "rollback_target_turn_not_found",
      ...readRollbackRequestLogContext(req),
    });
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "目标 turn 不存在" } });
    return null;
  }
  if ((toTurn.status !== "completed" && toTurn.status !== "error") || !toTurn.endEventSeq) {
    logger.warn("rollback", "rollback request rejected because target turn is not terminal", {
      errorCode: "rollback_target_turn_not_terminal",
      ...readRollbackRequestLogContext(req),
      targetTurnStatus: toTurn.status,
      targetTurnEndEventSeq: toTurn.endEventSeq,
    });
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "目标 turn 非 completed/error，禁止回滚" } });
    return null;
  }

  return {
    workspaceId,
    threadId,
    toTurnId,
    thread: thread as any,
    toTurn: toTurn as any,
    workspacePath,
    codexHistoryBatch,
  };
  });
}

/** 计算回滚边界：哪些 turn 需要 drop，边界 seq 是什么。 */
function computeRollbackBoundary(
  ctx: Pick<ApiHandlerContext, "db">,
  input: { threadId: ThreadId; toTurnId: TurnId },
): RollbackBoundary | { error: string } {
  const allTurns = ctx.db.turns.listByThread(input.threadId) as TurnRecord[];
  const orderedByStart = [...allTurns].sort((a, b) => {
    const sa = a.startEventSeq == null ? Number.MAX_SAFE_INTEGER : Number(a.startEventSeq);
    const sb = b.startEventSeq == null ? Number.MAX_SAFE_INTEGER : Number(b.startEventSeq);
    if (sa !== sb) return sa - sb;
    return Number(a.startedAt ?? 0) - Number(b.startedAt ?? 0);
  });
  const targetIdx = orderedByStart.findIndex((t) => t.turnId === input.toTurnId);
  if (targetIdx < 0) {
    return { error: "无法定位目标 turn 在会话中的顺序（索引缺失）" };
  }

  const boundaryTurn = targetIdx > 0 ? orderedByStart[targetIdx - 1]! : null;
  const boundarySeq = boundaryTurn?.endEventSeq != null ? Number(boundaryTurn.endEventSeq) : 0;
  const boundaryTurnOrdinal = boundaryTurn ? targetIdx : 0;

  const turnsToDrop = allTurns.filter((t) => {
    const endSeq = t.endEventSeq != null ? Number(t.endEventSeq) : null;
    if (endSeq != null && endSeq > boundarySeq) return true;
    const startSeq = t.startEventSeq != null ? Number(t.startEventSeq) : null;
    if (endSeq == null && startSeq != null && startSeq > boundarySeq) return true;
    return false;
  });

  return { turnsToDrop, boundarySeq, boundaryTurn, boundaryTurnOrdinal, orderedByStart, targetIdx };
}

/** 汇总 diff 审计、快照完整性和当前磁盘冲突，供 preview 与 commit 共用。 */
function assessRollbackFiles(
  ctx: Pick<ApiHandlerContext, "db">,
  input: {
    threadId: ThreadId;
    workspacePath: string;
    turnsToDrop: TurnRecord[];
    fileChanges: RollbackFileChangeIndex;
  },
): RollbackAssessment {
  const orderedTurns = [...input.turnsToDrop].sort(compareTurnOrder);
  const affectedPathSet = new Set<string>();
  const evidenceIssues: RollbackEvidenceIssue[] = [];
  const issueKeys = new Set<string>();

  for (const turn of orderedTurns) {
    const changes = input.fileChanges.byTurn.get(turn.turnId) ?? [];
    const capturedPaths = changes.map((change) => change.path);
    let auditedPaths = capturedPaths;

    if (turn.engine === "codex") {
      const resolved = resolveCodexTurnDiffEvidence(ctx, {
        threadId: input.threadId,
        workspacePath: input.workspacePath,
        turn,
      });
      if (resolved.evidence) {
        const providerPathSet = new Set(resolved.evidence.paths);
        for (const capturedPath of capturedPaths) {
          if (providerPathSet.has(capturedPath)) continue;
          addEvidenceIssue(evidenceIssues, issueKeys, {
            code: "invalid_provider_diff",
            path: capturedPath,
            message: `Codex diff 遗漏已捕获文件：turnId=${turn.turnId}, path=${capturedPath}`,
          });
        }
        auditedPaths = [...new Set([...capturedPaths, ...resolved.evidence.paths])];
      } else if (changes.length > 0) {
        addEvidenceIssue(evidenceIssues, issueKeys, {
          code: "missing_turn_diff",
          path: null,
          message: `Codex turn 缺少权威文件 diff：turnId=${turn.turnId}`,
        });
      }
      if (resolved.issue) addEvidenceIssue(evidenceIssues, issueKeys, resolved.issue);
    }

    const changesByPath = new Map(changes.map((change) => [change.path, change]));
    for (const filePath of auditedPaths) {
      affectedPathSet.add(filePath);
      const change = changesByPath.get(filePath) ?? null;
      if (!change) {
        addEvidenceIssue(evidenceIssues, issueKeys, {
          code: "untracked_change",
          path: filePath,
          message: `Codex diff 包含未捕获快照的文件：${filePath}`,
        });
        continue;
      }
      validateChangeSnapshots(ctx, change, evidenceIssues, issueKeys);
    }
  }

  const affectedPaths = Array.from(affectedPathSet).sort();
  const files: RollbackFileInfo[] = [];
  const currentSnapshots = new Map<string, FileSnapshot>();

  for (const relPath of affectedPaths) {
    const changesForPath = input.fileChanges.byPath.get(relPath) ?? [];
    if (changesForPath.length === 0) continue;

    const firstRecord = changesForPath[0]!;
    const lastRecord = changesForPath[changesForPath.length - 1]!;
    const rollbackOp: "restore" | "delete" = firstRecord.beforeExists ? "restore" : "delete";
    const canRollback = changesForPath.every((change) => (
      (!change.beforeExists || Boolean(change.beforeBlobId && ctx.db.blobs.get(change.beforeBlobId)))
      && (!change.afterExists || Boolean(change.afterBlobId && ctx.db.blobs.get(change.afterBlobId)))
    ));

    let hasConflict = false;
    let conflictReason: string | null = null;
    try {
      const abs = resolveWorkspaceAbsPath(input.workspacePath, relPath);
      const diskSnapshot = readFileSnapshot(abs);
      currentSnapshots.set(relPath, diskSnapshot);
      const conflict = compareCurrentSnapshot(ctx, relPath, lastRecord, diskSnapshot);
      hasConflict = conflict.hasConflict;
      conflictReason = conflict.reason;
    } catch (cause) {
      hasConflict = true;
      conflictReason = cause instanceof Error ? cause.message : "无法读取文件状态";
    }

    files.push({ path: relPath, rollbackOp, hasConflict, conflictReason, canRollback });
  }

  return {
    affectedPaths,
    files,
    evidenceComplete: evidenceIssues.length === 0,
    evidenceIssues,
    currentSnapshots,
  };
}

// ── Preview handler ──────────────────────────────────────────────

/** 处理 `threads.rollback.preview`：预览回滚会影响哪些文件，及其冲突状态。 */
export async function handleThreadsRollbackPreview(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  if (rejectActiveRollbackMutation(ctx, req)) return;
  const startedAt = Date.now();
  await ctx.flushLocalEvents?.(String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId, String((req.body as any)?.threadId ?? "").trim() as ThreadId);
  const validated = await validateRollbackInputs(ctx, req);
  if (validated) await withRollbackDatabase(ctx, req.id, () => previewRollbackSnapshot(ctx, req, validated, startedAt));
}

/** 预览仅消费屏障后的同步快照，不在数据库许可中等待引擎。 */
function previewRollbackSnapshot(ctx: ApiHandlerContext, req: ApiRequestMessage, validated: ValidatedInputs, startedAt: number): void {
  const requestContext = readRollbackRequestLogContext(req);
  logger.info("rollback", "rollback preview started", requestContext);
  if (rejectActiveRollbackMutation(ctx, req)) return;
  const historyDurationMs = Date.now() - startedAt;

  const { threadId, thread, workspacePath } = validated;
  if (rejectUnresolvedRollback(ctx, req, threadId)) return;

  const boundary = computeRollbackBoundary(ctx, { threadId, toTurnId: validated.toTurnId });
  if ("error" in boundary) {
    logger.error("rollback", "rollback preview boundary resolution failed", {
      errorCode: "rollback_boundary_resolution_failed",
      ...requestContext,
      rootCause: boundary.error,
    });
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: boundary.error } });
    return;
  }

  const { turnsToDrop } = boundary;
  const droppedTurnCount = turnsToDrop.length;
  if (droppedTurnCount === 0) {
    logger.info("rollback", "rollback preview completed", {
      ...requestContext,
      durationMs: Date.now() - startedAt,
      historyDurationMs,
      droppedTurnCount: 0,
      fileChangeRecordCount: 0,
      affectedFileCount: 0,
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, droppedTurnCount: 0, files: [], evidenceComplete: true, evidenceIssues: [] } });
    return;
  }

  const fileAssessmentStartedAt = Date.now();
  let fileChanges: RollbackFileChangeIndex;
  let assessment: RollbackAssessment;
  try {
    fileChanges = indexRollbackFileChanges(ctx, { threadId, turnsToDrop });
    assessment = assessRollbackFiles(ctx, { threadId, workspacePath, turnsToDrop, fileChanges });
  } catch (cause) {
    logger.error("rollback", "rollback preview file assessment failed", {
      errorCode: "rollback_preview_file_assessment_failed",
      ...requestContext,
      droppedTurnCount,
      rootCause: formatError(cause, "回滚预览失败"),
    });
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: formatError(cause, "回滚预览失败") } });
    return;
  }
  const fileAssessmentDurationMs = Date.now() - fileAssessmentStartedAt;
  const providerHistoryStartedAt = Date.now();
  if (thread.engine === "codex") {
    try {
      resolveCodexProviderHistoryExpectation(ctx, {
        threadId,
        retainedTurns: boundary.orderedByStart.slice(0, boundary.targetIdx),
        turnsToDrop,
        historyBatch: validated.codexHistoryBatch,
      });
    } catch (cause) {
      logger.error("rollback", "rollback preview provider history resolution failed", {
        errorCode: "rollback_provider_history_evidence_incomplete",
        ...requestContext,
        droppedTurnCount,
        rootCause: formatError(cause, "Codex provider turn 映射证据不完整"),
      });
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 409,
        body: {
          ok: false,
          code: "rollback_provider_history_evidence_incomplete",
          message: formatError(cause, "Codex provider turn 映射证据不完整"),
        },
      });
      return;
    }
  }
  logger.info("rollback", "rollback preview completed", {
    ...requestContext,
    durationMs: Date.now() - startedAt,
    historyDurationMs,
    fileAssessmentDurationMs,
    providerHistoryDurationMs: Date.now() - providerHistoryStartedAt,
    droppedTurnCount,
    fileChangeRecordCount: fileChanges.recordCount,
    affectedFileCount: assessment.files.length,
    evidenceIssueCount: assessment.evidenceIssues.length,
  });
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: {
      ok: true,
      droppedTurnCount,
      files: assessment.files,
      evidenceComplete: assessment.evidenceComplete,
      evidenceIssues: assessment.evidenceIssues,
    },
  });
}

// ── Main rollback handler ────────────────────────────────────────

/** 处理 `threads.rollback`：回滚到指定用户 turn（同一 thread 真回滚）。 */
export async function handleThreadsRollback(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  if (rejectActiveRollbackMutation(ctx, req)) return;
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  const release = ctx.sessions.beginThreadDeletion([threadId]);
  try {
    await ctx.flushLocalEvents?.(String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId, threadId);
    await executeThreadRollback(ctx, req);
  } finally { release(); }
}

/** 回滚沿既有审计阶段推进，每次异步恢复后重新取得短许可。 */
async function executeThreadRollback(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const validated = await validateRollbackInputs(ctx, req);
  if (!validated) return;

  const { workspaceId, threadId, toTurnId, thread, workspacePath } = validated;
  let codexHistoryBatch = validated.codexHistoryBatch;
  const unresolvedBeforeReconciliation = await withRollbackDatabase(ctx, req.id, () => ctx.db.rollbacks.findLatestUnresolvedByThread(threadId));
  const reconciliation = unresolvedBeforeReconciliation
    ? await reconcileUnresolvedRollbackBeforeMutation(ctx, req, { workspaceId, threadId })
    : { kind: "none" as const, recoveryPlan: null };
  if (!reconciliation) return;
  if (reconciliation.kind === "success" && reconciliation.recoveryPlan) {
    const recovered = reconciliation.recoveryPlan;
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: {
        ok: true,
        reconciled: true,
        droppedTurnCount: recovered.droppedTurnIds.length,
        revertedFileCount: recovered.files.length,
        skippedFileCount: recovered.skippedFileCount,
        fileRollbackStatus: recovered.rollbackFiles ? "completed" : "not_requested",
        ...(recovered.rollbackEventSeqBarrier != null
          ? { rollbackEventSeqBarrier: recovered.rollbackEventSeqBarrier }
          : {}),
      },
    });
    return;
  }
  if (unresolvedBeforeReconciliation && thread.engine === "codex") {
    await ctx.flushLocalEvents?.(workspaceId, threadId);
    if (!await flushRollbackEvidence(ctx, req)) return;
    try {
      // reconciliation 可跨 provider await；再次冲刷后才能基于最新持久证据重建 batch。
      codexHistoryBatch = await withRollbackDatabase(ctx, req.id, () => ensureThreadTurnsIndexedFromEvents(ctx, { threadId }));
    } catch (cause) {
      logger.error("rollback", "rollback history refresh after reconciliation failed", {
        errorCode: "rollback_provider_history_evidence_incomplete",
        ...readRollbackRequestLogContext(req),
        rootCause: formatError(cause, "回滚历史索引证据不完整"),
      });
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 409,
        body: {
          ok: false,
          code: "rollback_provider_history_evidence_incomplete",
          message: formatError(cause, "回滚历史索引证据不完整"),
        },
      });
      return;
    }
  }
  if (await withRollbackDatabase(ctx, req.id, () => rejectUnresolvedRollback(ctx, req, threadId))) return;
  const rollbackFiles = (req.body as any)?.rollbackFiles !== false;
  const skipPathsRaw = Array.isArray((req.body as any)?.skipPaths) ? ((req.body as any).skipPaths as string[]) : [];
  const skipPathSet = new Set(skipPathsRaw.map((p) => String(p).trim()).filter(Boolean));

  const boundary = await withRollbackDatabase(ctx, req.id, () => computeRollbackBoundary(ctx, { threadId, toTurnId }));
  if ("error" in boundary) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: boundary.error } });
    return;
  }

  const { turnsToDrop, boundarySeq, boundaryTurn, boundaryTurnOrdinal } = boundary;
  const droppedTurnCount = turnsToDrop.length;
  if (droppedTurnCount === 0) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: {
        ok: true,
        droppedTurnCount: 0,
        revertedFileCount: 0,
        skippedFileCount: 0,
        fileRollbackStatus: rollbackFiles ? "completed" : "not_requested",
      },
    });
    return;
  }

  let fileChanges: RollbackFileChangeIndex;
  let assessment: RollbackAssessment;
  try {
    ({ fileChanges, assessment } = await withRollbackDatabase(ctx, req.id, () => {
      const fileChanges = indexRollbackFileChanges(ctx, { threadId, turnsToDrop });
      return { fileChanges, assessment: assessRollbackFiles(ctx, { threadId, workspacePath, turnsToDrop, fileChanges }) };
    }));
  } catch (cause) {
    logger.error("rollback", "rollback file assessment failed", {
      errorCode: "rollback_file_assessment_failed",
      ...readRollbackRequestLogContext(req),
      droppedTurnCount,
      rootCause: formatError(cause, "回滚证据校验失败"),
    });
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: formatError(cause, "回滚证据校验失败") } });
    return;
  }

  let codexProviderExpectation: CodexProviderHistoryExpectation | null = null;
  if (thread.engine === "codex") {
    try {
      codexProviderExpectation = await withRollbackDatabase(ctx, req.id, () => resolveCodexProviderHistoryExpectation(ctx, {
        threadId,
        retainedTurns: boundary.orderedByStart.slice(0, boundary.targetIdx),
        turnsToDrop,
        historyBatch: codexHistoryBatch,
      }));
    } catch (cause) {
      logger.error("rollback", "rollback provider history resolution failed", {
        errorCode: "rollback_provider_history_evidence_incomplete",
        ...readRollbackRequestLogContext(req),
        droppedTurnCount,
        rootCause: formatError(cause, "Codex provider turn 映射证据不完整"),
      });
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 409,
        body: {
          ok: false,
          code: "rollback_provider_history_evidence_incomplete",
          message: formatError(cause, "Codex provider turn 映射证据不完整"),
        },
      });
      return;
    }
  }

  const unknownSkipPaths = Array.from(skipPathSet).filter((filePath) => !assessment.affectedPaths.includes(filePath));
  if (unknownSkipPaths.length > 0) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, message: `skipPaths 包含非本次回滚文件：${unknownSkipPaths.join(", ")}` },
    });
    return;
  }

  const effectivePaths = rollbackFiles ? assessment.affectedPaths.filter((filePath) => !skipPathSet.has(filePath)) : [];
  const effectivePathSet = new Set(effectivePaths);
  const skippedFileCount = assessment.affectedPaths.length - effectivePaths.length;
  if (rollbackFiles && !assessment.evidenceComplete) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        code: "rollback_evidence_incomplete",
        message: "文件回滚证据不完整，未执行任何回滚",
        details: { evidenceIssues: assessment.evidenceIssues },
      },
    });
    return;
  }
  if (rollbackFiles && assessment.affectedPaths.length > 0 && effectivePaths.length === 0) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "未选择任何可回滚文件；如只回滚对话，请关闭文件回滚" } });
    return;
  }

  const selectedFiles = assessment.files.filter((file) => effectivePathSet.has(file.path));
  const blockedFiles = selectedFiles.filter((file) => !file.canRollback || file.hasConflict);
  if (blockedFiles.length > 0) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        code: "rollback_file_conflict",
        message: "文件状态已变化或缺少快照，未执行任何回滚",
        details: { files: blockedFiles },
      },
    });
    return;
  }

  const preSnapshots = new Map<string, FileSnapshot>();
  for (const filePath of effectivePaths) {
    const snapshot = assessment.currentSnapshots.get(filePath);
    if (!snapshot) {
      ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: `缺少提交前磁盘快照：${filePath}` } });
      return;
    }
    preSnapshots.set(filePath, snapshot);
  }

  const runningBeforeCommit = await withRollbackDatabase(ctx, req.id, () => resolveThreadRunningState(ctx, { workspaceId, threadId }));
  if (runningBeforeCommit) {
    logger.warn("rollback", "rollback request rejected because thread started before commit", {
      errorCode: "rollback_thread_running",
      ...readRollbackRequestLogContext(req),
      runningTurnId: runningBeforeCommit.runningTurnId,
    });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        code: "rollback_thread_running",
        message: "thread 在回滚提交前已开始新的 turn，未执行任何回滚",
        details: runningBeforeCommit,
      },
    });
    return;
  }

  if (rejectActiveRollbackMutation(ctx, req)) return;
  activeRollbackMutations.add(threadId);
  try {

  let codexPreparation: { session: any; prepared: PreparedCodexRollbackHistory } | null = null;
  let codexProviderDroppedTurnCount = codexProviderExpectation?.droppedTurnIds.length ?? 0;
  let codexProviderMutationRequired = thread.engine === "codex" && codexProviderDroppedTurnCount > 0;
  if (codexProviderMutationRequired) {
    try {
      if (!codexProviderExpectation) throw new Error("Codex provider 历史映射缺失，无法 prepare 回滚");
      codexPreparation = await prepareCodexRollbackHistory(ctx, {
        requestId: req.id,
        threadId,
        numTurnsToDrop: codexProviderDroppedTurnCount,
        expectation: codexProviderExpectation,
      });
      const preparedProviderTurnCount = Number(codexPreparation.prepared.numTurns);
      if (
        !Number.isSafeInteger(preparedProviderTurnCount)
        || preparedProviderTurnCount < 0
        || preparedProviderTurnCount > codexProviderExpectation.droppedTurnIds.length
        || codexPreparation.prepared.droppedTurnIds.length !== preparedProviderTurnCount
        || codexPreparation.prepared.beforeTurnIds.length - codexPreparation.prepared.afterTurnIds.length !== preparedProviderTurnCount
      ) {
        throw new Error(`Codex prepareRollbackHistory 返回的实际删除数量无效：${String(preparedProviderTurnCount)}`);
      }
      codexProviderDroppedTurnCount = preparedProviderTurnCount;
      codexProviderMutationRequired = preparedProviderTurnCount > 0;
    } catch (cause) {
      if (codexPreparation) {
        try {
          cancelPreparedCodexRollback(codexPreparation);
        } catch (cancelCause) {
          cause = combineRollbackErrors(cause, cancelCause, "取消无效的 Codex 回滚计划失败");
        }
      }
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 502,
        body: { ok: false, code: "rollback_provider_prepare_failed", message: formatError(cause, "读取 provider 回滚计划失败") },
      });
      return;
    }
  }

  let recoveryPlan: RollbackRecoveryPlan;
  try {
    recoveryPlan = await withRollbackDatabase(ctx, req.id, () => buildRollbackRecoveryPlan(ctx, {
      workspaceId,
      threadId,
      engine: thread.engine,
      engineSessionId: codexPreparation?.prepared.sessionId ?? thread.sessionId,
      boundarySeq,
      toTurnId,
      turnsToDrop,
      rollbackFiles,
      skippedFileCount,
      rollbackEventSeqBarrier: readThreadCanonicalEventSeqBarrier(ctx, threadId),
      codexProviderDroppedTurnCount: thread.engine === "codex" ? codexProviderDroppedTurnCount : null,
      effectivePaths,
      fileChanges,
      // provider-backed no-op 也需持久化 before/after，供重启时拒绝历史漂移。
      codexPrepared: codexPreparation?.prepared ?? null,
    }));
  } catch (cause) {
    try {
      cancelPreparedCodexRollback(codexPreparation);
    } catch (cancelCause) {
      cause = combineRollbackErrors(cause, cancelCause, "构建回滚恢复计划失败");
    }
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: formatError(cause, "构建回滚恢复计划失败") } });
    return;
  }

  let rollbackId: number;
  try {
    rollbackId = await withRollbackDatabase(ctx, req.id, () => ctx.db.rollbacks.insert({
      threadId,
      toTurnId,
      droppedTurnCount,
      droppedEventSeqGt: boundarySeq,
      createdAt: Date.now(),
      result: "pending",
      error: serializeRollbackAuditError(req.id, "prepared", null, recoveryPlan),
    }));
  } catch (cause) {
    try {
      cancelPreparedCodexRollback(codexPreparation);
    } catch (cancelCause) {
      cause = combineRollbackErrors(cause, cancelCause, "创建回滚审计记录失败");
    }
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: formatError(cause, "创建回滚审计记录失败") } });
    return;
  }

  const appliedFileTargets = new Map<string, FileSnapshot>();
  try {
    await withRollbackDatabase(ctx, req.id, () => updateRollbackPhase(ctx, rollbackId, req.id, "files_applying", recoveryPlan));
    if (effectivePaths.length > 0) {
      const turnsDesc = [...turnsToDrop].sort((a, b) => compareTurnOrder(b, a));
      for (const turn of turnsDesc) {
        const changes = fileChanges.byTurn.get(turn.turnId) ?? [];
        for (let index = changes.length - 1; index >= 0; index -= 1) {
          const change = changes[index]!;
          if (!effectivePathSet.has(change.path)) continue;
          const mutation = await withRollbackDatabase(ctx, req.id, () => buildInverseFileMutation(ctx, change));
          try {
            applyInverseChange({ workspacePath, path: change.path, mutation });
            appliedFileTargets.set(change.path, mutation.target);
          } catch (cause) {
            if (hasRollbackFileMutationApplied(cause)) {
              appliedFileTargets.set(change.path, mutation.target);
            }
            throw cause;
          }
        }
      }
    }
    await withRollbackDatabase(ctx, req.id, () => updateRollbackPhase(ctx, rollbackId, req.id, "files_applied", recoveryPlan));
  } catch (cause) {
    try {
      cancelPreparedCodexRollback(codexPreparation);
    } catch (cancelCause) {
      cause = combineRollbackErrors(cause, cancelCause, "文件回滚失败");
    }
    const compensationEntries = buildFileCompensationEntries(preSnapshots, appliedFileTargets);
    const failure = compensateFilesOrCombine(workspacePath, compensationEntries, cause);
    const reported = await withRollbackDatabase(ctx, req.id, () => updateRollbackFailureOrCombine(
      ctx,
      rollbackId,
      failure.compensationFailed ? "partial" : "failed",
      req.id,
      failure.compensationConflict
        ? "files_compensation_conflict"
        : failure.compensationFailed
          ? "files_compensation"
          : "files",
      failure.error,
      recoveryPlan,
    ));
    const conflictCode = failure.compensationConflict
      ? "rollback_file_compensation_conflict"
      : hasNestedErrorCode(cause, "rollback_file_conflict")
        ? "rollback_file_conflict"
        : null;
    ctx.send({
      t: "api.res",
      id: req.id,
      status: conflictCode ? 409 : 500,
      body: { ok: false, ...(conflictCode ? { code: conflictCode } : {}), message: reported.message },
    });
    return;
  }

  let providerApplyStarted = false;
  try {
    await withRollbackDatabase(ctx, req.id, () => updateRollbackPhase(ctx, rollbackId, req.id, "provider_applying", recoveryPlan));
    if (codexPreparation) {
      if (typeof codexPreparation.session.applyPreparedRollbackHistory !== "function") {
        throw new Error("Codex session 不支持 applyPreparedRollbackHistory");
      }
      providerApplyStarted = true;
      await codexPreparation.session.applyPreparedRollbackHistory(codexPreparation.prepared);
    } else if (thread.engine !== "codex") {
      providerApplyStarted = true;
      await rollbackEngineHistory(ctx, {
        requestId: req.id,
        engine: thread.engine,
        workspaceId,
        workspacePath,
        threadId,
        sessionId: thread.sessionId,
        toTurn: boundaryTurn
          ? { turnId: boundaryTurn.turnId, engineCheckpointJson: boundaryTurn.engineCheckpointJson, turnOrdinal: boundaryTurnOrdinal }
          : { turnId: "" as TurnId, engineCheckpointJson: null, turnOrdinal: 0 },
        numTurnsToDrop: droppedTurnCount,
        codexProviderExpectation,
      });
    }
    try {
      await withRollbackDatabase(ctx, req.id, () => updateRollbackPhase(ctx, rollbackId, req.id, "provider_applied", recoveryPlan));
    } catch (phaseCause) {
      const phaseError = new Error(
        `${codexProviderMutationRequired || thread.engine !== "codex" ? "provider 已回滚" : "provider 无需回滚"}但审计阶段写入失败：${formatError(phaseCause, "未知错误")}`,
        { cause: phaseCause },
      );
      if (codexProviderMutationRequired || thread.engine !== "codex") {
        throw Object.assign(phaseError, { providerMutationMayHaveApplied: true });
      }
      throw phaseError;
    }
  } catch (cause) {
    if (codexPreparation && !providerApplyStarted) {
      try {
        cancelPreparedCodexRollback(codexPreparation);
      } catch (cancelCause) {
        cause = combineRollbackErrors(cause, cancelCause, "引擎历史回滚失败");
      }
    }
    const providerMayHaveChanged = hasProviderMutationMayHaveApplied(cause);
    const compensated = providerMayHaveChanged || effectivePaths.length === 0
      ? { error: toError(cause, "引擎历史回滚失败"), compensationFailed: false, compensationConflict: false }
      : await withRollbackDatabase(ctx, req.id, () => compensatePlannedFilesOrCombine(ctx, workspacePath, recoveryPlan.files, cause));
    const unresolved = providerMayHaveChanged || compensated.compensationFailed;
    const reported = await withRollbackDatabase(ctx, req.id, () => updateRollbackFailureOrCombine(
      ctx,
      rollbackId,
      unresolved ? "partial" : "failed",
      req.id,
      providerMayHaveChanged
        ? "provider_uncertain"
        : compensated.compensationConflict
          ? "provider_compensation_conflict"
          : compensated.compensationFailed
            ? "provider_compensation"
            : "provider",
      compensated.error,
      recoveryPlan,
    ));
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 502,
      body: {
        ok: false,
        code: providerMayHaveChanged
          ? "rollback_provider_state_uncertain"
          : compensated.compensationConflict
            ? "rollback_file_compensation_conflict"
            : compensated.compensationFailed
              ? "rollback_file_compensation_failed"
            : String((cause as any)?.code ?? "rollback_provider_failed"),
        message: reported.message,
      },
    });
    return;
  }

  let pauseQueue = false;
  try {
    const serverEventSeqBarrier = await requestRollbackEvidenceFence(ctx, {
      workspaceId,
      threadId,
      engine: thread.engine,
    });
    await ctx.flushRollbackEvidence?.();
    recoveryPlan = await withRollbackDatabase(ctx, req.id, () => {
    updateRollbackPhase(ctx, rollbackId, req.id, "local_committing", recoveryPlan);
    pauseQueue = ctx.db.threadMessageQueue.listActiveByThread(threadId).length > 0;
    return commitLocalRollbackHistory(ctx, {
      rollbackId,
      requestId: req.id,
      workspaceId,
      threadId,
      boundarySeq,
      pauseQueue,
      clearEngineSessionBinding: !boundaryTurn && thread.engine === "claude",
      serverEventSeqBarrier,
      recoveryPlan,
    });
    });
  } catch (cause) {
    const failure = toError(cause, "裁剪本地历史失败");
    const reported = await withRollbackDatabase(ctx, req.id, () => updateRollbackFailureOrCombine(ctx, rollbackId, "partial", req.id, "local_history", failure, recoveryPlan));
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 500,
      body: {
        ok: false,
        code: "rollback_local_history_failed",
        message: `文件与引擎历史可能已回滚，但本地历史裁剪失败：${reported.message}`,
      },
    });
    return;
  }

  try {
    await ctx.sessions.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
    if (!boundaryTurn && thread.engine === "claude") ctx.threads.clearSessionId(threadId);
    await withRollbackDatabase(ctx, req.id, () => ctx.db.rollbacks.updateResult(rollbackId, { result: "success", error: null }));
  } catch (cause) {
    const failure = toError(cause, "释放回滚后的引擎会话缓存失败");
    const reported = await withRollbackDatabase(ctx, req.id, () => updateRollbackFailureOrCombine(ctx, rollbackId, "partial", req.id, "session_cache", failure, recoveryPlan));
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 500,
      body: { ok: false, code: "rollback_session_cache_failed", message: `回滚已落盘，但会话缓存清理失败：${reported.message}` },
    });
    return;
  }

  if (pauseQueue) {
    ctx.send({
      t: "thread.queue.changed",
      workspaceId,
      threadId,
      reason: "paused",
    });
  } else {
    logger.info("queue", "rollback skipped queue pause: no active items", {
      threadId,
      workspaceId,
      toTurnId,
      droppedTurnCount,
    });
  }

  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: {
      ok: true,
      droppedTurnCount,
      revertedFileCount: effectivePaths.length,
      skippedFileCount,
      fileRollbackStatus: rollbackFiles ? "completed" : "not_requested",
      ...(recoveryPlan.rollbackEventSeqBarrier != null
        ? { rollbackEventSeqBarrier: recoveryPlan.rollbackEventSeqBarrier }
        : {}),
    },
  });
  } finally {
    activeRollbackMutations.delete(threadId);
  }
}

// ── Internal helpers ─────────────────────────────────────────────

/** 原线程校验后显式冲刷并复核W准入；任一步失败即终止回滚请求。 */
async function flushRollbackEvidence(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<boolean> {
  try {
    await ctx.flushRollbackEvidence?.();
    await withRollbackDatabase(ctx, req.id, () => ctx.assertWorkspacePersistenceAvailable?.(String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId));
    return true;
  } catch (cause) {
    logger.error("rollback", "rollback evidence flush failed", {
      errorCode: "rollback_evidence_flush_failed",
      ...readRollbackRequestLogContext(req),
      rootCause: formatError(cause, "回滚证据落盘失败"),
    });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 500,
      body: { ok: false, code: "rollback_evidence_flush_failed", message: formatError(cause, "回滚证据落盘失败") },
    });
    return false;
  }
}

/** 未确认的历史 mutation 存在时阻止预览和重试，避免二次裁剪 provider。 */
function rejectUnresolvedRollback(ctx: ApiHandlerContext, req: ApiRequestMessage, threadId: ThreadId): boolean {
  const unresolved = ctx.db.rollbacks.findLatestUnresolvedByThread(threadId);
  if (!unresolved) return false;
  logger.warn("rollback", "rollback request rejected because reconciliation is required", {
    errorCode: "rollback_reconciliation_required",
    ...readRollbackRequestLogContext(req),
    rollbackId: unresolved.id,
    rollbackStatus: unresolved.result,
  });
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 409,
    body: {
      ok: false,
      code: "rollback_reconciliation_required",
      message: `存在未确认的历史回滚（rollbackId=${unresolved.id}, status=${unresolved.result}），禁止继续回滚`,
      details: {
        rollbackId: unresolved.id,
        status: unresolved.result,
        toTurnId: unresolved.toTurnId,
        createdAt: unresolved.createdAt,
      },
    },
  });
  return true;
}

/** 在新 mutation 前自动核对并收口 v2 未决回滚；无法确认时发送阻断响应。 */
export async function reconcileUnresolvedRollbackBeforeMutation(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  input: { workspaceId: WorkspaceId; threadId: ThreadId },
): Promise<{ kind: "none" | "failed" | "success"; recoveryPlan: RollbackRecoveryPlan | null } | null> {
  // rollback 在 provider prepare 期间还没有 audit 行，active gate 必须先于 audit 查询。
  if (activeRollbackMutations.has(input.threadId)) {
    logger.warn("rollback", "rollback reconciliation rejected because another rollback is active", {
      errorCode: "rollback_in_progress",
      ...readRollbackRequestLogContext(req),
    });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, code: "rollback_in_progress", message: "当前会话正在执行历史回滚，请稍后重试" },
    });
    return null;
  }
  const unresolved = await withRollbackDatabase(ctx, req.id, () => ctx.db.rollbacks.findLatestUnresolvedByThread(input.threadId));
  if (!unresolved) return { kind: "none", recoveryPlan: null };

  const running = await withRollbackDatabase(ctx, req.id, () => resolveThreadRunningState(ctx, input));
  if (running) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, code: "rollback_reconciliation_required", message: "会话仍有运行中回合，暂不能核对未决回滚", details: running },
    });
    return null;
  }

  if (rejectActiveRollbackMutation(ctx, req)) return null;
  activeRollbackMutations.add(input.threadId);
  let audit: ReturnType<typeof parseRollbackRecoveryAudit> | null = null;
  let recoveryPlanForFailure: RollbackRecoveryPlan | null = null;
  let failurePhase = "reconciliation";
  try {
    audit = parseRollbackRecoveryAudit(unresolved);
    let plan = audit.recoveryPlan;
    recoveryPlanForFailure = plan;
    if (plan.workspaceId !== input.workspaceId || plan.threadId !== input.threadId) {
      throw new Error(`回滚恢复计划 scope 不匹配：rollbackId=${unresolved.id}`);
    }
    await ctx.flushLocalEvents?.(input.workspaceId, input.threadId);
    await withRollbackDatabase(ctx, req.id, () => ctx.assertWorkspacePersistenceAvailable?.(input.workspaceId));

    if (audit.phase === "local_committed" || audit.phase === "session_cache") {
      failurePhase = "session_cache";
      await ctx.sessions.disposeThreadWithOptions(input.threadId, { flushActiveTurn: false });
      await withRollbackDatabase(ctx, req.id, () => ctx.db.rollbacks.updateResult(unresolved.id, { result: "success", error: null }));
      return { kind: "success", recoveryPlan: plan };
    }

    if (plan.engine !== "codex") throw new Error(`当前未决回滚不是 Codex：rollbackId=${unresolved.id}`);
    const providerDroppedTurnCount = plan.codexProviderDroppedTurnCount ?? plan.droppedTurnIds.length;
    const zeroProviderRollbackWasApplied = providerDroppedTurnCount === 0
      && hasZeroProviderRollbackReachedAfter(audit.phase);
    if (zeroProviderRollbackWasApplied) failurePhase = ZERO_PROVIDER_ROLLBACK_AFTER_PHASE;
    const workspacePath = ctx.workspaces.get(input.workspaceId) ?? null;
    if (!workspacePath) throw new Error(`回滚恢复 workspace 不存在：${input.workspaceId}`);

    await withRollbackDatabase(ctx, req.id, () => validatePlannedFileStatesAreKnown(ctx, workspacePath, plan.files));
    let providerTurnIds: string[] | null = null;
    let providerAtBefore: boolean;
    let providerAtAfter: boolean;
    if (providerDroppedTurnCount === 0 && !plan.codexHistory) {
      providerAtAfter = zeroProviderRollbackWasApplied;
      providerAtBefore = !providerAtAfter;
    } else {
      if (!plan.codexHistory || !plan.engineSessionId) {
        throw new Error(`当前未决回滚缺少可自动核对的 Codex provider 计划：rollbackId=${unresolved.id}`);
      }
      const session = await withRollbackDatabase(ctx, req.id, () => getCodexRollbackSession(ctx, input.threadId));
      if (String(session.getSessionId?.() ?? "") !== String(plan.engineSessionId)) {
        throw new Error(`Codex sessionId 与回滚恢复计划不一致：rollbackId=${unresolved.id}`);
      }
      if (typeof session.readRollbackHistoryTurnIds !== "function") {
        throw new Error("Codex session 不支持 readRollbackHistoryTurnIds");
      }
      const currentProviderTurnIds = await session.readRollbackHistoryTurnIds() as string[];
      providerTurnIds = currentProviderTurnIds;
      const matchesBefore = sameOrderedStrings(currentProviderTurnIds, plan.codexHistory.beforeTurnIds);
      const matchesAfter = sameOrderedStrings(currentProviderTurnIds, plan.codexHistory.afterTurnIds);
      if (providerDroppedTurnCount === 0) {
        // before/after 相同，先拒绝漂移，再由审计阶段区分文件恢复与本地裁剪。
        providerAtBefore = matchesBefore && matchesAfter && !zeroProviderRollbackWasApplied;
        providerAtAfter = matchesBefore && matchesAfter && zeroProviderRollbackWasApplied;
      } else {
        providerAtBefore = matchesBefore;
        providerAtAfter = matchesAfter;
      }
    }

    if (providerAtBefore) {
      await withRollbackDatabase(ctx, req.id, () => {
      restorePlannedFileStates(ctx, workspacePath, plan.files, "pre");
      ctx.db.rollbacks.updateResult(unresolved.id, {
        result: "failed",
        error: serializeRollbackAuditError(
          audit!.requestId,
          "reconciled_provider_before",
          new Error(providerDroppedTurnCount === 0
            ? "回滚尚未进入本地提交阶段；文件已恢复到 pre 状态"
            : "provider 历史仍处于回滚前状态；文件已恢复到 pre 状态"),
          plan,
        ),
      });
      });
      return { kind: "failed", recoveryPlan: plan };
    }

    if (providerAtAfter) {
      await withRollbackDatabase(ctx, req.id, () => restorePlannedFileStates(ctx, workspacePath, plan.files, "target"));
      const serverEventSeqBarrier = await requestRollbackEvidenceFence(ctx, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        engine: plan.engine,
      });
      await ctx.flushRollbackEvidence?.();
      const committed = await withRollbackDatabase(ctx, req.id, () => {
      const pauseQueue = ctx.db.threadMessageQueue.listActiveByThread(input.threadId).length > 0;
      updateRollbackPhase(ctx, unresolved.id, audit!.requestId, "local_committing", plan);
      return { pauseQueue, plan: commitLocalRollbackHistory(ctx, {
        rollbackId: unresolved.id,
        requestId: audit!.requestId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        boundarySeq: plan.boundarySeq,
        pauseQueue,
        clearEngineSessionBinding: false,
        serverEventSeqBarrier,
        recoveryPlan: plan,
      }) };
      });
      const pauseQueue = committed.pauseQueue;
      plan = committed.plan;
      recoveryPlanForFailure = plan;
      failurePhase = "session_cache";
      await ctx.sessions.disposeThreadWithOptions(input.threadId, { flushActiveTurn: false });
      await withRollbackDatabase(ctx, req.id, () => ctx.db.rollbacks.updateResult(unresolved.id, { result: "success", error: null }));
      if (pauseQueue) {
        ctx.send({ t: "thread.queue.changed", workspaceId: input.workspaceId, threadId: input.threadId, reason: "paused" });
      }
      return { kind: "success", recoveryPlan: plan };
    }

    throw new Error(
      `provider 历史既不等于 before 也不等于 after：actual=${JSON.stringify(providerTurnIds ?? [])}`,
    );
  } catch (cause) {
    const failure = toError(cause, "未决回滚状态核对失败");
    let reported = failure;
    if (audit) {
      reported = await withRollbackDatabase(ctx, req.id, () => updateRollbackFailureOrCombine(
        ctx,
        unresolved.id,
        "partial",
        audit!.requestId,
        failurePhase,
        failure,
        recoveryPlanForFailure ?? audit!.recoveryPlan,
      ));
    }
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        code: "rollback_reconciliation_required",
        message: `未决回滚仍无法安全收口：${reported.message}`,
        details: { rollbackId: unresolved.id, status: unresolved.result },
      },
    });
    return null;
  } finally {
    activeRollbackMutations.delete(input.threadId);
  }
}

/** 严格解析 v2 审计与不可变恢复计划。 */
function parseRollbackRecoveryAudit(record: ThreadRollbackRecord): {
  requestId: string;
  phase: string;
  recoveryPlan: RollbackRecoveryPlan;
} {
  let parsed: any;
  try {
    parsed = JSON.parse(String(record.error ?? ""));
  } catch (cause) {
    throw new Error(`回滚审计 JSON 无法解析：rollbackId=${record.id}`, { cause });
  }
  const requestId = String(parsed?.requestId ?? "").trim();
  const phase = String(parsed?.phase ?? "").trim();
  const plan = parsed?.recoveryPlan as RollbackRecoveryPlan | undefined;
  if (Number(parsed?.v) !== 2 || !requestId || !phase || !plan || Number(plan.v) !== 1) {
    throw new Error(`回滚审计缺少 v2 恢复计划：rollbackId=${record.id}`);
  }
  if (
    String(plan.threadId) !== String(record.threadId)
    || String(plan.toTurnId) !== String(record.toTurnId)
    || Number(plan.boundarySeq) !== Number(record.droppedEventSeqGt)
    || !Array.isArray(plan.droppedTurnIds)
    || plan.droppedTurnIds.length !== record.droppedTurnCount
    || typeof plan.rollbackFiles !== "boolean"
    || !Number.isSafeInteger(Number(plan.skippedFileCount))
    || Number(plan.skippedFileCount) < 0
    || (plan.rollbackEventSeqBarrier != null
      && (!Number.isSafeInteger(Number(plan.rollbackEventSeqBarrier)) || Number(plan.rollbackEventSeqBarrier) < 0))
    || (plan.codexProviderDroppedTurnCount != null
      && (!Number.isSafeInteger(Number(plan.codexProviderDroppedTurnCount))
        || Number(plan.codexProviderDroppedTurnCount) < 0
        || Number(plan.codexProviderDroppedTurnCount) > record.droppedTurnCount))
    || !Array.isArray(plan.files)
  ) {
    throw new Error(`回滚恢复计划与审计行不一致：rollbackId=${record.id}`);
  }
  if (new Set(plan.droppedTurnIds.map(String)).size !== plan.droppedTurnIds.length) {
    throw new Error(`回滚恢复计划包含重复 local turnId：rollbackId=${record.id}`);
  }
  if (new Set(plan.files.map((file) => String(file?.path ?? ""))).size !== plan.files.length) {
    throw new Error(`回滚恢复计划包含重复文件路径：rollbackId=${record.id}`);
  }
  if (plan.files.some((file) => file.intermediateStates != null && !Array.isArray(file.intermediateStates))) {
    throw new Error(`回滚恢复计划 intermediateStates 无效：rollbackId=${record.id}`);
  }
  if (plan.engine === "codex") {
    const providerDroppedTurnCount = plan.codexProviderDroppedTurnCount ?? record.droppedTurnCount;
    const before = plan.codexHistory?.beforeTurnIds;
    const after = plan.codexHistory?.afterTurnIds;
    if (plan.codexHistory == null) {
      if (providerDroppedTurnCount !== 0) {
        throw new Error(`Codex 回滚恢复计划缺少 provider 历史：rollbackId=${record.id}`);
      }
    } else if (!plan.engineSessionId || !Array.isArray(before) || !Array.isArray(after)) {
      throw new Error(`Codex 回滚恢复计划缺少 provider 历史：rollbackId=${record.id}`);
    } else if (before.length - after.length !== providerDroppedTurnCount || !sameOrderedStrings(before.slice(0, after.length), after)) {
      throw new Error(`Codex 回滚恢复计划 before/after 不是精确前缀：rollbackId=${record.id}`);
    }
  }
  return { requestId, phase, recoveryPlan: plan };
}

type RollbackRecoveryStateLabel = "pre" | "intermediate" | "target";

/** 写文件前验证每个当前路径只处于 plan 记录的已知状态。 */
function validatePlannedFileStatesAreKnown(
  ctx: Pick<ApiHandlerContext, "db">,
  workspacePath: string,
  files: RollbackFileRecoveryPlan[],
): void {
  const unknownPaths: string[] = [];
  for (const file of files) {
    const current = readFileSnapshot(resolveWorkspaceAbsPath(workspacePath, file.path));
    const matchesKnown = listRollbackFileRecoveryStates(file)
      .map(({ ref, label }) => snapshotMatchesRecoveryRef(ctx, current, ref, file.path, label))
      .some(Boolean);
    if (!matchesKnown) unknownPaths.push(file.path);
  }
  if (unknownPaths.length > 0) {
    throw new Error(`文件状态不属于 recovery plan：${unknownPaths.join(", ")}`);
  }
}

/** 将全部文件恢复到计划状态并逐字节复核。 */
function restorePlannedFileStates(
  ctx: Pick<ApiHandlerContext, "db">,
  workspacePath: string,
  files: RollbackFileRecoveryPlan[],
  side: "pre" | "target",
): void {
  validatePlannedFileStatesAreKnown(ctx, workspacePath, files);
  for (const file of files) {
    const abs = resolveWorkspaceAbsPath(workspacePath, file.path);
    const current = readFileSnapshot(abs);
    const matchesKnown = listRollbackFileRecoveryStates(file)
      .map(({ ref, label }) => snapshotMatchesRecoveryRef(ctx, current, ref, file.path, label))
      .some(Boolean);
    if (!matchesKnown) {
      throw fileCompensationConflict(file.path, "当前内容已不属于 recovery plan");
    }
    const desired = recoveryRefToSnapshot(ctx, file[side], file.path, side);
    restoreFileSnapshot(abs, file.path, { expectedCurrent: current, restore: desired });
  }
  for (const file of files) {
    const current = readFileSnapshot(resolveWorkspaceAbsPath(workspacePath, file.path));
    if (!snapshotMatchesRecoveryRef(ctx, current, file[side], file.path, side)) {
      throw new Error(`文件恢复后未达到 ${side} 状态：${file.path}`);
    }
  }
}

/** 旧计划没有 intermediateStates 时自然退化为 pre/target 两态。 */
function listRollbackFileRecoveryStates(
  file: RollbackFileRecoveryPlan,
): Array<{ ref: RollbackFileStateRef; label: RollbackRecoveryStateLabel }> {
  return [
    { ref: file.pre, label: "pre" },
    ...(file.intermediateStates ?? []).map((ref) => ({ ref, label: "intermediate" as const })),
    { ref: file.target, label: "target" },
  ];
}

/** 将 recovery plan 引用解析为已校验的文件快照。 */
function recoveryRefToSnapshot(
  ctx: Pick<ApiHandlerContext, "db">,
  ref: RollbackFileStateRef,
  filePath: string,
  side: RollbackRecoveryStateLabel,
): FileSnapshot {
  if (!ref.exists) {
    assertMissingRecoveryRefValid(ref, filePath, side);
    return { exists: false, data: null };
  }
  return { exists: true, data: readRecoveryBlob(ctx, ref, filePath, side) };
}

/** 比较当前磁盘快照与审计中的 blob/hash 状态。 */
function snapshotMatchesRecoveryRef(
  ctx: Pick<ApiHandlerContext, "db">,
  snapshot: FileSnapshot,
  ref: RollbackFileStateRef,
  filePath: string,
  side: RollbackRecoveryStateLabel,
): boolean {
  if (!ref.exists) {
    assertMissingRecoveryRefValid(ref, filePath, side);
    return !snapshot.exists;
  }
  const expected = readRecoveryBlob(ctx, ref, filePath, side);
  if (!snapshot.exists || !snapshot.data) return false;
  return sha256(snapshot.data) === sha256(expected);
}

/** 不存在状态不能携带 blob/hash，避免损坏的 audit 被当作已知状态。 */
function assertMissingRecoveryRefValid(
  ref: RollbackFileStateRef,
  filePath: string,
  side: RollbackRecoveryStateLabel,
): void {
  if (ref.blobId != null || ref.sha256 != null) {
    throw new Error(`回滚恢复计划 ${side} 不存在状态携带了 blob 引用：${filePath}`);
  }
}

/** 读取并校验恢复计划引用的 blob，拒绝审计与实体不一致。 */
function readRecoveryBlob(
  ctx: Pick<ApiHandlerContext, "db">,
  ref: RollbackFileStateRef,
  filePath: string,
  side: RollbackRecoveryStateLabel,
): Buffer {
  if (!ref.exists || !ref.blobId || !/^[a-f0-9]{64}$/i.test(String(ref.sha256 ?? ""))) {
    throw new Error(`回滚恢复计划 ${side} 引用无效：${filePath}`);
  }
  const blob = ctx.db.blobs.get(ref.blobId);
  if (!blob) throw new Error(`回滚恢复计划 ${side} blob 不存在：${filePath}`);
  if (sha256(blob.data) !== ref.sha256) throw new Error(`回滚恢复计划 ${side} blob hash 不一致：${filePath}`);
  return blob.data;
}

/** 严格比较 provider turnId 有序序列。 */
function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const ZERO_PROVIDER_ROLLBACK_AFTER_PHASE = "reconciliation_zero_provider_after";

/** 判断零 Provider mutation 的回滚是否已越过引擎阶段，可继续本地裁剪。 */
function hasZeroProviderRollbackReachedAfter(phase: string): boolean {
  return phase === "provider_applied"
    || phase === "local_committing"
    || phase === "local_history"
    || phase === ZERO_PROVIDER_ROLLBACK_AFTER_PHASE;
}

/** 按本地事件顺序排列 turn，确保多 turn 文件逆操作可稳定反向执行。 */
function compareTurnOrder(a: TurnRecord, b: TurnRecord): number {
  const aSeq = a.startEventSeq == null ? Number.MAX_SAFE_INTEGER : Number(a.startEventSeq);
  const bSeq = b.startEventSeq == null ? Number.MAX_SAFE_INTEGER : Number(b.startEventSeq);
  if (aSeq !== bSeq) return aSeq - bSeq;
  return Number(a.startedAt ?? 0) - Number(b.startedAt ?? 0);
}

/** 提取回滚日志所需的稳定请求标识，不记录原始请求正文。 */
function readRollbackRequestLogContext(req: ApiRequestMessage): {
  requestId: string;
  method: string;
  workspaceId: string;
  threadId: string;
  toTurnId: string;
} {
  return {
    requestId: String(req.id),
    method: String(req.method),
    workspaceId: String((req.body as any)?.workspaceId ?? "").trim(),
    threadId: String((req.body as any)?.threadId ?? "").trim(),
    toTurnId: String((req.body as any)?.toTurnId ?? "").trim(),
  };
}

/** 一次读取待回滚 turn 的文件变更，并按稳定 turn 顺序建立复用索引。 */
function indexRollbackFileChanges(
  ctx: Pick<ApiHandlerContext, "db">,
  input: { threadId: ThreadId; turnsToDrop: TurnRecord[] },
): RollbackFileChangeIndex {
  const orderedTurns = [...input.turnsToDrop].sort(compareTurnOrder);
  const droppedTurnIds = new Set(orderedTurns.map((turn) => String(turn.turnId)));
  const unorderedByTurn = new Map<TurnId, RollbackFileChangeRecord[]>();
  for (const change of ctx.db.fileChanges.listByThread(input.threadId)) {
    if (!droppedTurnIds.has(String(change.turnId))) continue;
    const records = unorderedByTurn.get(change.turnId) ?? [];
    records.push(change);
    unorderedByTurn.set(change.turnId, records);
  }

  const byTurn = new Map<TurnId, RollbackFileChangeRecord[]>();
  const byPath = new Map<string, RollbackFileChangeRecord[]>();
  let recordCount = 0;
  for (const turn of orderedTurns) {
    const records = unorderedByTurn.get(turn.turnId) ?? [];
    byTurn.set(turn.turnId, records);
    recordCount += records.length;
    for (const change of records) {
      const pathRecords = byPath.get(change.path) ?? [];
      pathRecords.push(change);
      byPath.set(change.path, pathRecords);
    }
  }
  return { byTurn, byPath, recordCount };
}

/** 固化重启核对所需的 provider 历史与文件 pre/target 字节证据。 */
function buildRollbackRecoveryPlan(
  ctx: Pick<ApiHandlerContext, "db">,
  input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    engine: EngineType;
    engineSessionId: SessionId | null;
    boundarySeq: number;
    toTurnId: TurnId;
    turnsToDrop: TurnRecord[];
    rollbackFiles: boolean;
    skippedFileCount: number;
    rollbackEventSeqBarrier: number;
    codexProviderDroppedTurnCount: number | null;
    effectivePaths: string[];
    fileChanges: RollbackFileChangeIndex;
    codexPrepared: PreparedCodexRollbackHistory | null;
  },
): RollbackRecoveryPlan {
  const orderedTurns = [...input.turnsToDrop].sort(compareTurnOrder);
  const files = input.effectivePaths.map((filePath) => {
    const changes = input.fileChanges.byPath.get(filePath) ?? [];
    if (changes.length === 0) throw new Error(`回滚恢复计划缺少文件变更：${filePath}`);
    const first = changes[0]!;
    const last = changes[changes.length - 1]!;
    const pre = buildRollbackFileStateRef(ctx, last.afterExists, last.afterBlobId, filePath, "after");
    const target = buildRollbackFileStateRef(ctx, first.beforeExists, first.beforeBlobId, filePath, "before");
    const intermediateStates: RollbackFileStateRef[] = [];
    for (const change of [...changes].reverse().slice(0, -1)) {
      const state = buildRollbackFileStateRef(ctx, change.beforeExists, change.beforeBlobId, filePath, "before");
      if (sameRollbackFileStateRef(state, pre) || sameRollbackFileStateRef(state, target)) continue;
      if (intermediateStates.some((known) => sameRollbackFileStateRef(known, state))) continue;
      intermediateStates.push(state);
    }
    return {
      path: filePath,
      pre,
      target,
      ...(intermediateStates.length > 0 ? { intermediateStates } : {}),
    } satisfies RollbackFileRecoveryPlan;
  });
  return {
    v: 1,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    engine: input.engine,
    engineSessionId: input.engineSessionId,
    boundarySeq: input.boundarySeq,
    toTurnId: input.toTurnId,
    droppedTurnIds: orderedTurns.map((turn) => turn.turnId),
    rollbackFiles: input.rollbackFiles,
    skippedFileCount: input.skippedFileCount,
    rollbackEventSeqBarrier: input.rollbackEventSeqBarrier,
    ...(input.codexProviderDroppedTurnCount != null
      ? { codexProviderDroppedTurnCount: input.codexProviderDroppedTurnCount }
      : {}),
    files,
    codexHistory: input.codexPrepared
      ? {
          beforeTurnIds: [...input.codexPrepared.beforeTurnIds],
          afterTurnIds: [...input.codexPrepared.afterTurnIds],
        }
      : null,
  };
}

/** 读取裁剪前的 thread canonical 高水位，供 Web 拒绝回滚前迟到事件。 */
function readThreadCanonicalEventSeqBarrier(
  ctx: Pick<ApiHandlerContext, "db">,
  threadId: ThreadId,
): number {
  const row = ctx.db.db
    .prepare("SELECT MAX(seq) AS maxSeq FROM conversation_events WHERE thread_id = ?")
    .get(String(threadId)) as { maxSeq?: number | null } | undefined;
  const seq = Number(row?.maxSeq ?? 0);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
}

/** 等待 Server 顺序栅栏，确保已发出但尚未 ACK 的旧事件也进入回滚屏障。 */
async function requestRollbackEvidenceFence(
  ctx: Pick<ApiHandlerContext, "fenceRollbackEvidence">,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; engine: EngineType },
): Promise<number> {
  if (!ctx.fenceRollbackEvidence) throw new Error("Client 未配置回滚事件 Server 栅栏");
  const seq = await ctx.fenceRollbackEvidence(input);
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new Error(`回滚事件 Server 栅栏 seq 无效：${String(seq)}`);
  }
  return seq;
}

/** 内容引用相等即可视为同一恢复状态。 */
function sameRollbackFileStateRef(left: RollbackFileStateRef, right: RollbackFileStateRef): boolean {
  return left.exists === right.exists && left.blobId === right.blobId && left.sha256 === right.sha256;
}

/** 将文件存在性与 blob 固化为可逐字节复核的状态引用。 */
function buildRollbackFileStateRef(
  ctx: Pick<ApiHandlerContext, "db">,
  exists: boolean,
  blobId: string | null,
  filePath: string,
  side: "before" | "after",
): RollbackFileStateRef {
  if (!exists) return { exists: false, blobId: null, sha256: null };
  if (!blobId) throw new Error(`回滚恢复计划缺少 ${side} blob：${filePath}`);
  const blob = ctx.db.blobs.get(blobId);
  if (!blob) throw new Error(`回滚恢复计划 ${side} blob 不存在：path=${filePath}, blobId=${blobId}`);
  return { exists: true, blobId, sha256: sha256(blob.data) };
}

/** 建立本地回滚边界到 provider turnId 的严格尾部映射。 */
function resolveCodexProviderHistoryExpectation(
  ctx: Pick<ApiHandlerContext, "db">,
  input: {
    threadId: ThreadId;
    retainedTurns: TurnRecord[];
    turnsToDrop: TurnRecord[];
    historyBatch: CodexProviderTurnHistoryBatch | null;
  },
): CodexProviderHistoryExpectation {
  if (!input.historyBatch) throw new Error(`Codex provider 历史批次缺失：threadId=${input.threadId}`);
  const droppedTurnIds: string[] = [];
  for (const turn of [...input.turnsToDrop].sort(compareTurnOrder)) {
    const disposition = resolveCodexProviderTurnDisposition(ctx, input.threadId, turn, input.historyBatch);
    if (disposition.kind === "provider") droppedTurnIds.push(disposition.turnId);
  }
  if (new Set(droppedTurnIds).size !== droppedTurnIds.length) {
    throw new Error(`Codex provider turnId 重复：${JSON.stringify(droppedTurnIds)}`);
  }
  let retainedTurnId: string | null = null;
  for (const turn of [...input.retainedTurns].sort(compareTurnOrder).reverse()) {
    const disposition = resolveCodexProviderTurnDisposition(ctx, input.threadId, turn, input.historyBatch);
    if (disposition.kind !== "provider") continue;
    retainedTurnId = disposition.turnId;
    break;
  }
  if (retainedTurnId && droppedTurnIds.includes(retainedTurnId)) {
    throw new Error(`Codex provider 边界 turnId 与待删除 turn 重复：${retainedTurnId}`);
  }
  return { droppedTurnIds, retainedTurnId };
}

/** 将 Codex 本地 turn 严格区分为 provider-backed 或 provider 创建前失败。 */
function resolveCodexProviderTurnDisposition(
  ctx: Pick<ApiHandlerContext, "db">,
  threadId: ThreadId,
  turn: TurnRecord,
  historyBatch: CodexProviderTurnHistoryBatch,
): CodexProviderTurnDisposition {
  try {
    return { kind: "provider", turnId: resolveCodexProviderTurnId(ctx, threadId, turn, historyBatch) };
  } catch (cause) {
    if (!(cause instanceof CodexProviderTurnMappingMissingError)) throw cause;
    if (isCodexPreProviderFailedTurn(ctx, threadId, turn)) return { kind: "local_only" };
    throw cause;
  }
}

/** 仅凭终态事件的精确请求阶段，识别从未进入 provider turn 历史的失败回合。 */
function isCodexPreProviderFailedTurn(
  ctx: Pick<ApiHandlerContext, "db">,
  threadId: ThreadId,
  turn: TurnRecord,
): boolean {
  if (turn.status !== "error") return false;
  const endEventSeq = Number(turn.endEventSeq ?? 0);
  if (!Number.isSafeInteger(endEventSeq) || endEventSeq <= 0) return false;
  const rows = ctx.db.db
    .prepare(
      "SELECT event_json FROM conversation_events WHERE thread_id = ? AND seq = ? AND type = 'turn.error'",
    )
    .all(String(threadId), endEventSeq) as Array<{ event_json: string }>;
  if (rows.length !== 1) return false;
  let event: any;
  try {
    event = JSON.parse(String(rows[0]!.event_json ?? ""));
  } catch (cause) {
    throw new Error(`Codex 本地-only turn.error 无法解析：turnId=${turn.turnId}`, { cause });
  }
  const payload = event?.payload ?? null;
  if (
    String(event?.threadId ?? "") !== String(threadId)
    || String(event?.engine ?? "") !== "codex"
    || String(event?.type ?? "") !== "turn.error"
    || String(payload?.turnId ?? "") !== String(turn.turnId)
    || String(payload?.code ?? "") !== "codex_app_server_request_timeout"
    || String(payload?.terminationKind ?? "") !== "error"
  ) {
    return false;
  }
  const requestMethod = String(payload?.requestMethod ?? "").trim();
  if (requestMethod) return requestMethod === "thread/start";
  return String(payload?.error ?? "") === "Codex app-server request timeout: thread/start";
}

/** 复用严格历史 resolver；仅在没有 provider 历史时读取 legacy diff checkpoint。 */
function resolveCodexProviderTurnId(
  ctx: Pick<ApiHandlerContext, "db">,
  threadId: ThreadId,
  turn: TurnRecord,
  historyBatch: CodexProviderTurnHistoryBatch,
): string {
  const historyTurnId = historyBatch.findTurnId(turn.turnId);
  const persistedTurn = ctx.db.turns.get(turn.turnId) ?? turn;
  const providerCheckpointRead = readCodexProviderTurnCheckpoint(persistedTurn.engineCheckpointJson);
  if (providerCheckpointRead.invalidReason) {
    throw new Error(`Codex provider turn checkpoint 无效：turnId=${turn.turnId}, reason=${providerCheckpointRead.invalidReason}`);
  }

  const diffCheckpointRead = readCodexDiffCheckpoint(persistedTurn.engineCheckpointJson);
  const diffTurnId = diffCheckpointRead.checkpoint?.engineTurnId ?? null;
  const providerLineage = new Set(providerCheckpointRead.checkpoint?.supersededEngineTurnIds ?? []);
  if (historyTurnId && diffTurnId && historyTurnId !== diffTurnId && !providerLineage.has(diffTurnId)) {
    throw new Error(
      `Codex provider turnId 证据冲突：turnId=${turn.turnId}, resolved=${historyTurnId}, diff=${diffTurnId}`,
    );
  }

  const resolved = historyTurnId ?? diffTurnId;
  if (!resolved) {
    const checkpointReason = diffCheckpointRead.invalidReason ? `, checkpoint=${diffCheckpointRead.invalidReason}` : "";
    throw new CodexProviderTurnMappingMissingError(`缺少 Codex provider turnId 映射：turnId=${turn.turnId}${checkpointReason}`);
  }
  return resolved;
}

/** 去重追加结构化证据问题。 */
function addEvidenceIssue(
  target: RollbackEvidenceIssue[],
  keys: Set<string>,
  issue: RollbackEvidenceIssue,
): void {
  const key = `${issue.code}:${issue.path ?? ""}:${issue.message}`;
  if (keys.has(key)) return;
  keys.add(key);
  target.push(issue);
}

/** 校验单条 before/after 引用及其 blob 实体，缺一项即不能自动回滚。 */
function validateChangeSnapshots(
  ctx: Pick<ApiHandlerContext, "db">,
  change: ReturnType<ApiHandlerContext["db"]["fileChanges"]["get"]> & {},
  issues: RollbackEvidenceIssue[],
  issueKeys: Set<string>,
): void {
  if (change.beforeExists && !change.beforeBlobId) {
    addEvidenceIssue(issues, issueKeys, {
      code: "missing_before_snapshot",
      path: change.path,
      message: `缺少文件修改前快照：${change.path}`,
    });
  } else if (change.beforeExists && change.beforeBlobId && !ctx.db.blobs.get(change.beforeBlobId)) {
    addEvidenceIssue(issues, issueKeys, {
      code: "snapshot_blob_missing",
      path: change.path,
      message: `文件修改前快照实体不存在：${change.path}`,
    });
  }

  if (change.afterExists && !change.afterBlobId) {
    addEvidenceIssue(issues, issueKeys, {
      code: "missing_after_snapshot",
      path: change.path,
      message: `缺少文件修改后快照：${change.path}`,
    });
  } else if (change.afterExists && change.afterBlobId && !ctx.db.blobs.get(change.afterBlobId)) {
    addEvidenceIssue(issues, issueKeys, {
      code: "snapshot_blob_missing",
      path: change.path,
      message: `文件修改后快照实体不存在：${change.path}`,
    });
  }
}

/** 将当前磁盘状态与最后一个 after 快照比较，检测会话外写入。 */
function compareCurrentSnapshot(
  ctx: Pick<ApiHandlerContext, "db">,
  relPath: string,
  lastRecord: { afterExists: boolean; afterBlobId: string | null },
  diskSnapshot: FileSnapshot,
): { hasConflict: boolean; reason: string | null } {
  if (!lastRecord.afterExists) {
    return diskSnapshot.exists
      ? { hasConflict: true, reason: "文件在会话外被重新创建" }
      : { hasConflict: false, reason: null };
  }
  if (!diskSnapshot.exists) return { hasConflict: true, reason: "文件在会话外被删除" };
  if (!lastRecord.afterBlobId) return { hasConflict: true, reason: `缺少修改后快照：${relPath}` };
  const expected = ctx.db.blobs.get(lastRecord.afterBlobId);
  if (!expected) return { hasConflict: true, reason: `修改后快照实体不存在：${relPath}` };
  if (!diskSnapshot.data) return { hasConflict: true, reason: `无法读取当前文件内容：${relPath}` };
  return sha256(diskSnapshot.data) === sha256(expected.data)
    ? { hasConflict: false, reason: null }
    : { hasConflict: true, reason: "文件在会话外被修改" };
}

/** 从 checkpoint 指向的 canonical diff 或 turn 范围内最新 diff 恢复权威路径证据。 */
function resolveCodexTurnDiffEvidence(
  ctx: Pick<ApiHandlerContext, "db">,
  input: { threadId: ThreadId; workspacePath: string; turn: TurnRecord },
): { evidence: CodexTurnDiffEvidence | null; issue: RollbackEvidenceIssue | null } {
  const checkpointRead = readCodexDiffCheckpoint(input.turn.engineCheckpointJson);
  if (checkpointRead.invalidReason) {
    return {
      evidence: null,
      issue: {
        code: "invalid_provider_diff",
        path: null,
        message: `Codex diff checkpoint 无效：turnId=${input.turn.turnId}, reason=${checkpointRead.invalidReason}`,
      },
    };
  }
  const checkpoint = checkpointRead.checkpoint;
  let event: Extract<ConversationEventEnvelope, { type: "item.diff.created" }> | null = null;
  const turnStartSeq = Math.max(1, Number(input.turn.startEventSeq ?? 1));
  const turnEndSeq = Math.max(turnStartSeq, Number(input.turn.endEventSeq ?? Number.MAX_SAFE_INTEGER));

  try {
    if (checkpoint) {
      if (checkpoint.eventSeq < turnStartSeq || checkpoint.eventSeq > turnEndSeq) {
        return {
          evidence: null,
          issue: {
            code: "invalid_provider_diff",
            path: null,
            message: `Codex diff eventSeq 超出 turn 边界：turnId=${input.turn.turnId}, eventSeq=${checkpoint.eventSeq}`,
          },
        };
      }
      event = ctx.db.conversationEvents.getDiffEventBySeq(input.threadId, checkpoint.eventSeq);
      if (!event) {
        return {
          evidence: null,
          issue: {
            code: "diff_event_missing",
            path: null,
            message: `Codex diff 索引指向的 canonical event 不存在：turnId=${input.turn.turnId}, eventSeq=${checkpoint.eventSeq}`,
          },
        };
      }
    } else {
      event = ctx.db.conversationEvents.findLatestDiffEventInRange(input.threadId, turnStartSeq, turnEndSeq);
      if (!event) return { evidence: null, issue: null };
    }
  } catch (cause) {
    return {
      evidence: null,
      issue: { code: "diff_parse_failed", path: null, message: `Codex canonical diff event 无法读取：${formatError(cause, "JSON/快照错误")}` },
    };
  }

  const eventTurnId = String(event?.payload?.turnId ?? "").trim();
  if (eventTurnId && eventTurnId !== String(input.turn.turnId)) {
    return {
      evidence: null,
      issue: {
        code: "invalid_provider_diff",
        path: null,
        message: `Codex diff 归属不一致：expectedTurnId=${input.turn.turnId}, actualTurnId=${eventTurnId}`,
      },
    };
  }
  const eventEngineTurnId = String(event?.payload?.engineTurnId ?? "").trim() || null;
  if (checkpoint?.engineTurnId && checkpoint.engineTurnId !== eventEngineTurnId) {
    return {
      evidence: null,
      issue: {
        code: "invalid_provider_diff",
        path: null,
        message: `Codex diff provider turnId 与索引不一致：turnId=${input.turn.turnId}, eventSeq=${event.seq}`,
      },
    };
  }

  const diff = String(event?.payload?.diff ?? "");
  const diffSha256 = sha256(Buffer.from(diff, "utf8"));
  if (checkpoint && checkpoint.diffSha256 !== diffSha256) {
    return {
      evidence: null,
      issue: {
        code: "diff_hash_mismatch",
        path: null,
        message: `Codex diff hash 与索引不一致：turnId=${input.turn.turnId}, eventSeq=${event.seq}`,
      },
    };
  }

  const analyzed = analyzeUnifiedDiffPaths(input.workspacePath, diff);
  if (!analyzed.valid) {
    return {
      evidence: null,
      issue: {
        code: "diff_parse_failed",
        path: null,
        message: `Codex diff 路径解析失败：turnId=${input.turn.turnId}, reason=${analyzed.error ?? "unknown"}`,
      },
    };
  }
  if (checkpoint && !sameStringSet(checkpoint.paths, analyzed.paths)) {
    return {
      evidence: null,
      issue: {
        code: "invalid_provider_diff",
        path: null,
        message: `Codex diff 路径与索引不一致：turnId=${input.turn.turnId}, eventSeq=${event.seq}`,
      },
    };
  }

  return {
    evidence: { engineTurnId: eventEngineTurnId, eventSeq: Number(event.seq), diffSha256, paths: analyzed.paths },
    issue: null,
  };
}

/** 严格读取 Codex diff checkpoint，并显式返回损坏原因。 */
function readCodexDiffCheckpoint(raw: string | null): { checkpoint: CodexTurnDiffEvidence | null; invalidReason: string | null } {
  const text = String(raw ?? "").trim();
  if (!text) return { checkpoint: null, invalidReason: null };
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { checkpoint: null, invalidReason: formatError(cause, "JSON 无法解析") };
  }
  const value = parsed?.codexTurnDiff;
  if (value == null) return { checkpoint: null, invalidReason: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { checkpoint: null, invalidReason: "codexTurnDiff 必须是 object" };
  }
  if (Number(value.v) !== 1 || String(value.source ?? "") !== "turn/diff/updated") {
    return { checkpoint: null, invalidReason: "codexTurnDiff 版本或来源无效" };
  }
  const eventSeq = Number(value.eventSeq ?? 0);
  const diffSha256 = String(value.diffSha256 ?? "").trim();
  const engineTurnId = String(value.engineTurnId ?? "").trim() || null;
  if (!Array.isArray(value.paths)) return { checkpoint: null, invalidReason: "paths 必须是数组" };
  const paths: string[] = Array.isArray(value.paths)
    ? value.paths.map((item: unknown) => String(item ?? "").trim()).filter((item: string) => Boolean(item))
    : [];
  if (!Number.isFinite(eventSeq) || eventSeq <= 0) return { checkpoint: null, invalidReason: "eventSeq 无效" };
  if (!/^[a-f0-9]{64}$/i.test(diffSha256)) return { checkpoint: null, invalidReason: "diffSha256 无效" };
  return {
    checkpoint: { engineTurnId, eventSeq, diffSha256, paths: Array.from(new Set(paths)).sort() },
    invalidReason: null,
  };
}

/** 严格读取独立的 Codex provider turn 映射 checkpoint。 */
function readCodexProviderTurnCheckpoint(
  raw: string | null,
): { checkpoint: CodexProviderTurnEvidence | null; invalidReason: string | null } {
  const text = String(raw ?? "").trim();
  if (!text) return { checkpoint: null, invalidReason: null };
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { checkpoint: null, invalidReason: formatError(cause, "JSON 无法解析") };
  }
  const value = parsed?.codexProviderTurn;
  if (value == null) return { checkpoint: null, invalidReason: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { checkpoint: null, invalidReason: "codexProviderTurn 必须是 object" };
  }
  const engineTurnId = String(value.engineTurnId ?? "").trim();
  const engineSessionId = (String(value.engineSessionId ?? "").trim() || null) as SessionId | null;
  const previousEngineTurnId = String(value.previousEngineTurnId ?? "").trim() || null;
  const source = String(value.source ?? "").trim();
  const eventSeq = Number(value.eventSeq ?? 0);
  const observedAt = Number(value.observedAt ?? 0);
  if (Number(value.v) !== 1 || (source !== "turn.engineBound" && source !== "turn/started")) {
    return { checkpoint: null, invalidReason: "codexProviderTurn 版本或来源无效" };
  }
  if (!engineTurnId) return { checkpoint: null, invalidReason: "engineTurnId 无效" };
  if (!Number.isSafeInteger(eventSeq) || eventSeq <= 0) return { checkpoint: null, invalidReason: "eventSeq 无效" };
  if (!Number.isFinite(observedAt) || observedAt <= 0) return { checkpoint: null, invalidReason: "observedAt 无效" };
  const decision = decideCodexProviderTurnMapping(null, {
    engineTurnId,
    engineSessionId,
    previousEngineTurnId,
    supersededEngineTurnIds: value.supersededEngineTurnIds,
    source: source as "turn.engineBound" | "turn/started",
    eventSeq,
    observedAt,
  });
  if (decision.action !== "replace") {
    return { checkpoint: null, invalidReason: "codexProviderTurn lineage 无效" };
  }
  return {
    checkpoint: decision.mapping as CodexProviderTurnEvidence,
    invalidReason: null,
  };
}

/** 比较两个路径集合，忽略原始顺序。 */
function sameStringSet(left: string[], right: string[]): boolean {
  const a = Array.from(new Set(left)).sort();
  const b = Array.from(new Set(right)).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 仅为确实落盘的路径建立带当前状态前置条件的补偿计划。 */
function buildFileCompensationEntries(
  preSnapshots: Map<string, FileSnapshot>,
  appliedTargets: Map<string, FileSnapshot>,
): Map<string, FileCompensationEntry> {
  const entries = new Map<string, FileCompensationEntry>();
  for (const [filePath, expectedCurrent] of appliedTargets) {
    const restore = preSnapshots.get(filePath);
    if (!restore) throw new Error(`缺少已触碰文件的提交前快照：${filePath}`);
    entries.set(filePath, { expectedCurrent, restore });
  }
  return entries;
}

/** 从耐久 recovery plan 构造 provider 明确失败后的严格补偿计划。 */
function buildPlannedFileCompensationEntries(
  ctx: Pick<ApiHandlerContext, "db">,
  files: RollbackFileRecoveryPlan[],
): Map<string, FileCompensationEntry> {
  const entries = new Map<string, FileCompensationEntry>();
  for (const file of files) {
    entries.set(file.path, {
      expectedCurrent: recoveryRefToSnapshot(ctx, file.target, file.path, "target"),
      restore: recoveryRefToSnapshot(ctx, file.pre, file.path, "pre"),
    });
  }
  return entries;
}

/** Provider 明确失败时仅补偿仍处于本轮 target 状态的文件。 */
function compensatePlannedFilesOrCombine(
  ctx: Pick<ApiHandlerContext, "db">,
  workspacePath: string,
  files: RollbackFileRecoveryPlan[],
  cause: unknown,
): { error: Error; compensationFailed: boolean; compensationConflict: boolean } {
  return compensateFilesOrCombine(
    workspacePath,
    buildPlannedFileCompensationEntries(ctx, files),
    cause,
  );
}

/** 恢复提交前文件，并标明补偿失败或外部编辑冲突。 */
function compensateFilesOrCombine(
  workspacePath: string,
  entries: Map<string, FileCompensationEntry>,
  cause: unknown,
): { error: Error; compensationFailed: boolean; compensationConflict: boolean } {
  const original = toError(cause, "文件回滚失败");
  try {
    restoreSnapshots(workspacePath, entries);
    return { error: original, compensationFailed: false, compensationConflict: false };
  } catch (restoreCause) {
    const compensationConflict = hasNestedErrorCode(restoreCause, "rollback_file_compensation_conflict");
    return {
      error: new Error(`${original.message}；文件补偿失败：${formatError(restoreCause, "未知错误")}`, { cause: restoreCause }),
      compensationFailed: true,
      compensationConflict,
    };
  }
}

/** 更新回滚审计；审计写入失败也必须体现在返回错误中。 */
function updateRollbackFailureOrCombine(
  ctx: Pick<ApiHandlerContext, "db">,
  rollbackId: number,
  result: "failed" | "partial",
  requestId: string,
  phase: string,
  cause: unknown,
  recoveryPlan?: RollbackRecoveryPlan | null,
): Error {
  const failure = toError(cause, "回滚失败");
  try {
    ctx.db.rollbacks.updateResult(rollbackId, {
      result,
      error: serializeRollbackAuditError(requestId, phase, failure, recoveryPlan),
    });
    return failure;
  } catch (auditCause) {
    return new Error(`${failure.message}；更新回滚审计失败：${formatError(auditCause, "未知错误")}`, { cause: auditCause });
  }
}

/** 在每个副作用前持久化 pending phase，供进程重启后判断未知区间。 */
function updateRollbackPhase(
  ctx: Pick<ApiHandlerContext, "db">,
  rollbackId: number,
  requestId: string,
  phase: string,
  recoveryPlan: RollbackRecoveryPlan,
): void {
  ctx.db.rollbacks.updateResult(rollbackId, {
    result: "pending",
    error: serializeRollbackAuditError(requestId, phase, null, recoveryPlan),
  });
}

/** 调用方已异步排空事件ACK；同一同步事务刷新屏障、裁剪历史并记录提交阶段。 */
function commitLocalRollbackHistory(
  ctx: Pick<ApiHandlerContext, "db">,
  input: {
    rollbackId: number;
    requestId: string;
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    boundarySeq: number;
    pauseQueue: boolean;
    clearEngineSessionBinding: boolean;
    serverEventSeqBarrier: number;
    recoveryPlan: RollbackRecoveryPlan;
  },
): RollbackRecoveryPlan {
  let committedPlan = input.recoveryPlan;
  const commit = ctx.db.db.transaction(() => {
    const currentBarrier = readThreadCanonicalEventSeqBarrier(ctx, input.threadId);
    if (!Number.isSafeInteger(currentBarrier) || currentBarrier <= 0) {
      throw new Error(`无法确定回滚裁剪前的 canonical event 屏障：threadId=${input.threadId}`);
    }
    committedPlan = {
      ...input.recoveryPlan,
      rollbackEventSeqBarrier: Math.max(
        Number(input.recoveryPlan.rollbackEventSeqBarrier ?? 0),
        currentBarrier,
        input.serverEventSeqBarrier,
      ),
    };
    if (input.boundarySeq > 0) {
      ctx.db.conversationEvents.deleteAfterSeq(input.threadId, input.boundarySeq);
      ctx.db.rawEvents.deleteAfterSeq(input.threadId, input.boundarySeq);
      ctx.db.fileChanges.deleteAfterTurnEndSeq(input.threadId, input.boundarySeq);
      ctx.db.turns.deleteAfterEndSeq(input.threadId, input.boundarySeq);
    } else {
      ctx.db.conversationEvents.deleteByThread(input.threadId);
      ctx.db.rawEvents.deleteByThread(input.threadId);
      ctx.db.fileChanges.deleteByThread(input.threadId);
      ctx.db.turns.deleteAfterEndSeq(input.threadId, 0);
    }
    if (input.clearEngineSessionBinding) ctx.db.threads.clearSessionId(input.threadId);
    if (input.pauseQueue) ctx.db.threadQueueStates.pause(input.threadId, input.workspaceId, "rollback");
    ctx.db.threads.touch(input.threadId);
    updateRollbackPhase(ctx, input.rollbackId, input.requestId, "local_committed", committedPlan);
  });
  commit();
  return committedPlan;
}

/** 将审计错误压缩成可检索 JSON，保留请求与阶段上下文。 */
function serializeRollbackAuditError(
  requestId: string,
  phase: string,
  cause: unknown,
  recoveryPlan?: RollbackRecoveryPlan | null,
): string {
  return JSON.stringify({
    v: recoveryPlan ? 2 : 1,
    requestId: String(requestId ?? ""),
    phase,
    message: cause == null ? null : formatError(cause, "未知错误"),
    ...(recoveryPlan ? { recoveryPlan } : {}),
  });
}

/** 判断 provider RPC 是否可能已经产生历史变更。 */
function hasProviderMutationMayHaveApplied(cause: unknown): boolean {
  return Boolean(cause && typeof cause === "object" && (cause as any).providerMutationMayHaveApplied === true);
}

/** 将未知异常规整为 Error，并保留原始 cause。 */
function toError(cause: unknown, fallback: string): Error {
  if (cause instanceof Error) return cause;
  return new Error(formatError(cause, fallback), { cause });
}

/** 聚合主失败与 provider 锁释放失败，同时保留两侧错误分类。 */
function combineRollbackErrors(primary: unknown, secondary: unknown, fallback: string): AggregateError {
  const first = toError(primary, fallback);
  const second = toError(secondary, "释放 provider 回滚锁失败");
  return new AggregateError(
    [first, second],
    `${first.message}；释放 provider 回滚锁失败：${second.message}`,
    { cause: first },
  );
}

/** 聚合错误也要保留底层 CAS 冲突分类，避免降级成普通补偿失败。 */
function hasNestedErrorCode(cause: unknown, code: string, seen = new Set<object>()): boolean {
  if (!cause || typeof cause !== "object" || seen.has(cause)) return false;
  seen.add(cause);
  if (String((cause as { code?: unknown }).code ?? "") === code) return true;
  if (cause instanceof AggregateError) {
    for (const nested of cause.errors) {
      if (hasNestedErrorCode(nested, code, seen)) return true;
    }
  }
  return hasNestedErrorCode((cause as { cause?: unknown }).cause, code, seen);
}

/** 生成稳定错误文本。 */
function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause ?? "").trim();
  return text || fallback;
}

/** 从 canonical conversation_events 回放补齐 turn 索引（用于历史回滚）。 */
function ensureThreadTurnsIndexedFromEvents(
  ctx: Pick<ApiHandlerContext, "db">,
  input: { threadId: ThreadId },
): CodexProviderTurnHistoryBatch | null {
  const thread = ctx.db.threads.get(input.threadId);
  if (!thread) return null;
  let codexHistoryBatch: CodexProviderTurnHistoryBatch | null = null;
  const transaction = ctx.db.db.transaction(() => {
    const rows = ctx.db.db
      .prepare(
        [
          "SELECT seq, thread_id, workspace_id, engine, type, event_json, ts FROM conversation_events",
          "WHERE thread_id = ? AND type IN (",
          "  'thread.started','turn.started','turn.completed','turn.error','item.userMessage.created','turn.engineBound'",
          ")",
          "ORDER BY seq ASC",
        ].join("\n"),
      )
      .all(String(input.threadId)) as RollbackStoredEventRow[];
    const events = rows
      .filter((row) => thread.engine !== "codex" || row.type !== "thread.started")
      .map((row) => parseRollbackCanonicalEvent(row, thread));
    const codexBindingTurnIds = new Set<TurnId>();
    let sessionId: SessionId | null = null;

    // 第一遍只创建 turn 行，避免 terminal-before-started 或 engineBound 先到时发生部分索引。
    for (const event of events) {
      if (event.type === "thread.started") {
        const sid = String(event.payload?.sessionId ?? "").trim();
        if (sid) sessionId = sid as SessionId;
        continue;
      }
      if (event.type !== "turn.started") continue;
      const turnId = String(event.payload?.turnId ?? "").trim() as TurnId;
      if (!turnId) continue;
      ctx.db.turns.insertStarted({
        workspaceId: thread.workspaceId,
        threadId: input.threadId,
        engine: thread.engine,
        turnId,
        startedAt: Number(event.ts ?? Date.now()),
        startEventSeq: Number(event.seq ?? 0) || null,
      });
      assertRollbackTurnScope(ctx, thread, turnId);
    }

    // 第二遍应用依赖 turn 行的派生索引；任一失败由外层事务整体回滚。
    for (const event of events) {
      const type = String(event.type ?? "");
      if (type === "item.userMessage.created") {
        const turnId = String(event.payload?.turnId ?? "").trim() as TurnId;
        const itemId = String(event.payload?.itemId ?? "").trim();
        if (!turnId || !itemId || !ctx.db.turns.get(turnId)) continue;
        assertRollbackTurnScope(ctx, thread, turnId);
        ctx.db.turns.setUserMessage(turnId, { userItemId: itemId as any, userText: String(event.payload?.text ?? "") });
        continue;
      }
      if (type === "turn.completed" || type === "turn.error") {
        const turnId = String(event.payload?.turnId ?? "").trim() as TurnId;
        if (!turnId || !ctx.db.turns.get(turnId)) continue;
        assertRollbackTurnScope(ctx, thread, turnId);
        ctx.db.turns.setEnded(turnId, {
          status: type === "turn.completed" ? "completed" : "error",
          endedAt: Number(event.ts ?? Date.now()),
          endEventSeq: Number(event.seq ?? 0) || null,
        });
        continue;
      }
      if (type === "turn.engineBound") {
        if (thread.engine !== "codex") {
          throw new Error(`turn.engineBound 无法回放到 ${thread.engine} thread：threadId=${input.threadId}`);
        }
        const turnId = String(event.payload?.turnId ?? "").trim() as TurnId;
        if (!turnId) throw new Error(`turn.engineBound 缺少本地 turnId：threadId=${input.threadId}`);
        assertRollbackTurnScope(ctx, thread, turnId);
        codexBindingTurnIds.add(turnId);
      }
    }

    if (thread.engine === "codex") {
      const historyBatch = prepareCodexProviderTurnHistoryBatch(ctx.db, {
        threadId: input.threadId,
        clientTurnIds: ctx.db.turns.listByThread(input.threadId).map((turn) => turn.turnId),
      });
      codexHistoryBatch = historyBatch;
      // 同一批快照逐 turn 严格确权；外层事务保证任一冲突都回滚本轮索引修复。
      for (const turnId of codexBindingTurnIds) {
        const pair = historyBatch.findPair(turnId);
        if (!pair) throw new Error(`Codex canonical provider pair 缺失：threadId=${input.threadId}, turnId=${turnId}`);
      }
    }

    if (sessionId) {
      ctx.db.turns.setEngineSessionIdByThread(input.threadId, sessionId);
      if (!thread.sessionId) {
        ctx.db.threads.setSessionId(input.threadId, sessionId);
      }
    }
  });
  transaction();
  return codexHistoryBatch;
}

type RollbackStoredEventRow = {
  seq: number;
  thread_id: string;
  workspace_id: string;
  engine: string;
  type?: string;
  event_json: string;
  ts: number;
};

/** 严格解析回滚 canonical；显式 scope 冲突不得写入持久化 thread。 */
function parseRollbackCanonicalEvent(row: RollbackStoredEventRow, thread: { id: ThreadId; workspaceId: WorkspaceId; engine: EngineType }): any {
  const event = parseRollbackStoredEvent(row, "canonical");
  assertRollbackEventScope(row, event, thread);
  const storedType = String(row.type ?? "").trim();
  const explicitType = String(event.type ?? "").trim();
  if (!storedType || (explicitType && explicitType !== storedType)) {
    throw new Error(`rollback canonical event type scope 不匹配：seq=${row.seq}`);
  }
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`rollback canonical event payload 无效：type=${storedType}, seq=${row.seq}`);
  }
  return { ...event, type: storedType, payload, seq: Number(row.seq), ts: Number(row.ts) };
}

/** JSON 损坏不能被回滚重建静默忽略。 */
function parseRollbackStoredEvent(row: RollbackStoredEventRow, kind: "canonical" | "raw"): any {
  let event: unknown;
  try {
    event = JSON.parse(String(row.event_json ?? ""));
  } catch (cause) {
    throw new Error(`rollback ${kind} event JSON 无法解析：seq=${row.seq}`, { cause });
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error(`rollback ${kind} event envelope 无效：seq=${row.seq}`);
  }
  return event as any;
}

/** 旧 envelope 缺 scope 时信任持久化列；显式值与列或目标 thread 冲突时失败。 */
function assertRollbackEventScope(
  row: RollbackStoredEventRow,
  event: any,
  thread: { id: ThreadId; workspaceId: WorkspaceId; engine: EngineType },
): void {
  const storedThreadId = String(row.thread_id ?? "").trim();
  const storedWorkspaceId = String(row.workspace_id ?? "").trim();
  const storedEngine = String(row.engine ?? "").trim();
  const explicitThreadId = String(event.threadId ?? "").trim();
  const explicitWorkspaceId = String(event.workspaceId ?? "").trim();
  const explicitEngine = String(event.engine ?? "").trim();
  if (
    storedThreadId !== String(thread.id)
    || storedWorkspaceId !== String(thread.workspaceId)
    || storedEngine !== String(thread.engine)
    || (explicitThreadId && explicitThreadId !== storedThreadId)
    || (explicitWorkspaceId && explicitWorkspaceId !== storedWorkspaceId)
    || (explicitEngine && explicitEngine !== storedEngine)
  ) {
    throw new Error(`rollback event scope 不匹配：seq=${row.seq}, threadId=${thread.id}`);
  }
}

/** 所有按 payload.turnId 写入的派生索引必须仍归属持久化 thread。 */
function assertRollbackTurnScope(
  ctx: Pick<ApiHandlerContext, "db">,
  thread: { id: ThreadId; workspaceId: WorkspaceId; engine: EngineType },
  turnId: TurnId,
): void {
  const turn = ctx.db.turns.get(turnId);
  if (!turn) throw new Error(`rollback canonical turn 不存在：threadId=${thread.id}, turnId=${turnId}`);
  if (turn.threadId !== thread.id || turn.workspaceId !== thread.workspaceId || turn.engine !== thread.engine) {
    throw new Error(`rollback canonical turn scope 不匹配：threadId=${thread.id}, turnId=${turnId}`);
  }
}

/** 引擎等待在许可外执行，恢复本地绑定时独立取得同步数据库许可。 */
async function rollbackEngineHistory(
  ctx: Pick<ApiHandlerContext, "db" | "threads" | "sessions" | "withDatabase">,
  input: {
    requestId: string;
    engine: EngineType;
    workspaceId: WorkspaceId;
    workspacePath: string;
    threadId: ThreadId;
    sessionId: SessionId | null;
    toTurn: { turnId: TurnId; engineCheckpointJson: string | null; turnOrdinal: number };
    numTurnsToDrop: number;
    codexProviderExpectation: CodexProviderHistoryExpectation | null;
  },
): Promise<void> {
  if (input.engine === "codex") {
    if (!input.sessionId) throw new Error("Codex sessionId 缺失，无法回滚");
    const session = await withRollbackDatabase(ctx, input.requestId, () => getCodexRollbackSession(ctx, input.threadId));
    if (typeof session.rollbackHistory !== "function") throw new Error("Codex session 不支持 rollbackHistory");
    if (!input.codexProviderExpectation) throw new Error("Codex provider 历史映射缺失，无法回滚");
    await session.rollbackHistory(input.numTurnsToDrop, input.codexProviderExpectation);
    return;
  }

  if (input.engine === "claude") {
    if (!input.sessionId) throw new Error("Claude sessionId 缺失，无法回滚");

    // turnOrdinal=0 表示无前置 turn，截断到空文件
    let byteLen: number | null = input.toTurn.turnOrdinal === 0 ? 0 : null;

    if (byteLen == null) {
      // 首选：使用存储的 checkpoint（在 compact_boundary 事件时已更新为压缩后的文件偏移）。
      // 安全校验：如果存储值 > 当前文件大小，说明 checkpoint 仍然失效（compact_boundary 事件
      // 可能未被处理，例如 turn 在压缩事件到达前就被 kill 了），此时跳过。
      const stored = parseClaudeCheckpointByteLen(input.toTurn.engineCheckpointJson);
      if (stored != null) {
        const sessionFile = resolveClaudeSessionFilePath({
          workspacePath: input.workspacePath,
          sessionId: String(input.sessionId),
        });
        const currentSize = sessionFile ? readClaudeSessionFileByteLen(sessionFile) : null;
        if (currentSize != null && stored <= currentSize) {
          byteLen = stored;
        }
        // else: checkpoint 失效（文件被 compaction 重写且未更新），fall through
      }
    }

    if (byteLen == null) {
      // Fallback 1：从末尾丢弃推导（近似值，每个 turn 可能对应多个 session 文件 user message）
      const dropDerived = await deriveClaudeCheckpointByteLenByDropping({
        workspacePath: input.workspacePath,
        sessionId: String(input.sessionId),
        numTurnsToDrop: input.numTurnsToDrop,
      });
      if (dropDerived.ok) {
        byteLen = dropDerived.byteLen;
      }
    }

    if (byteLen == null) {
      // Fallback 2：基于 turnOrdinal 推导
      const ordinalDerived = await deriveClaudeSessionCheckpointByteLen({
        workspacePath: input.workspacePath,
        sessionId: String(input.sessionId),
        turnOrdinal: input.toTurn.turnOrdinal,
      });
      if (!ordinalDerived.ok) throw new Error(ordinalDerived.message);
      byteLen = ordinalDerived.byteLen;
    }

    const res = await truncateClaudeSessionToByteLen({ workspacePath: input.workspacePath, sessionId: String(input.sessionId), byteLen });
    if (!res.ok) throw new Error(res.message);
    return;
  }

  throw new Error(`未知 engine：${input.engine}`);
}

/** 获取绑定到当前本地 thread 的 Codex session，不创建并行 runtime 口径。 */
function getCodexRollbackSession(
  ctx: Pick<ApiHandlerContext, "db" | "threads" | "sessions">,
  threadId: ThreadId,
): any {
  const persisted = ctx.db.threads.get(threadId);
  if (!persisted) throw new Error("thread 不存在");
  if (persisted.engine !== "codex") throw new Error(`当前 thread 不是 Codex：threadId=${threadId}`);
  const persistedSessionId = (String(persisted.sessionId ?? "").trim() || null) as SessionId | null;
  if (!persistedSessionId) {
    throw new Error(`Codex 当前 provider session binding 缺失：threadId=${threadId}`);
  }

  let runtime = ctx.threads.get(threadId);
  if (runtime) {
    const runtimeSessionId = (String(runtime.sessionId ?? "").trim() || null) as SessionId | null;
    if (runtime.workspaceId !== persisted.workspaceId || runtime.engine !== persisted.engine) {
      throw new Error(`Codex runtime thread scope 与持久化不一致：threadId=${threadId}`);
    }
    if (runtimeSessionId !== persistedSessionId) {
      throw new Error(
        `Codex runtime 与持久化 session binding 不一致：threadId=${threadId}, persisted=${persistedSessionId}, runtime=${runtimeSessionId ?? "missing"}`,
      );
    }
  } else {
    runtime = ctx.threads.create({
      threadId: persisted.id,
      workspaceId: persisted.workspaceId,
      engine: persisted.engine,
      title: persisted.title,
      sessionId: persisted.sessionId,
      sessionCapabilities: persisted.sessionCapabilities,
    });
  }
  const session = ctx.sessions.getOrCreate(runtime);
  const actualSessionId = (String(session.getSessionId?.() ?? "").trim() || null) as SessionId | null;
  if (actualSessionId !== persistedSessionId) {
    throw new Error(
      `Codex provider session 与持久化 binding 不一致：threadId=${threadId}, persisted=${persistedSessionId}, provider=${actualSessionId ?? "missing"}`,
    );
  }
  return session;
}

/** 在任何文件副作用前读取并锁定 Codex provider 的精确 before/after 历史。 */
async function prepareCodexRollbackHistory(
  ctx: Pick<ApiHandlerContext, "db" | "threads" | "sessions" | "withDatabase">,
  input: { requestId: string; threadId: ThreadId; numTurnsToDrop: number; expectation: CodexProviderHistoryExpectation },
): Promise<{ session: any; prepared: PreparedCodexRollbackHistory }> {
  const session = await withRollbackDatabase(ctx, input.requestId, () => getCodexRollbackSession(ctx, input.threadId));
  if (typeof session.prepareRollbackHistory !== "function") throw new Error("Codex session 不支持 prepareRollbackHistory");
  const prepared = await session.prepareRollbackHistory(input.numTurnsToDrop, input.expectation);
  if (!prepared) throw new Error("Codex prepareRollbackHistory 未返回有效计划");
  return { session, prepared };
}

/** 文件或审计准备失败时释放尚未提交的 Codex provider 回滚锁。 */
function cancelPreparedCodexRollback(input: { session: any; prepared: PreparedCodexRollbackHistory } | null): void {
  if (!input) return;
  if (typeof input.session.cancelPreparedRollbackHistory !== "function") {
    throw new Error("Codex session 不支持 cancelPreparedRollbackHistory");
  }
  input.session.cancelPreparedRollbackHistory(input.prepared);
}

function parseClaudeCheckpointByteLen(engineCheckpointJson: string | null): number | null {
  const raw = String(engineCheckpointJson ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as any;
    const value = parsed?.sessionFileByteLen ?? parsed?.byteLen;
    if (value == null) return null;
    const byteLen = Number(value);
    if (!Number.isFinite(byteLen) || byteLen < 0) throw new Error("checkpoint byteLen 无效");
    return Math.floor(byteLen);
  } catch (cause) {
    throw new Error("Claude turn checkpoint JSON 无法解析", { cause });
  }
}

type InverseFileMutation = {
  expectedCurrent: FileSnapshot;
  target: FileSnapshot;
};

/** 将一条快照记录解析为可执行的 inverse 文件 mutation。 */
function buildInverseFileMutation(
  ctx: Pick<ApiHandlerContext, "db">,
  change: {
    path: string;
    beforeExists: boolean;
    beforeBlobId: string | null;
    afterExists: boolean;
    afterBlobId: string | null;
  },
): InverseFileMutation {
  return {
    expectedCurrent: capturedFileStateToSnapshot(ctx, change.path, "after", change.afterExists, change.afterBlobId),
    target: capturedFileStateToSnapshot(ctx, change.path, "before", change.beforeExists, change.beforeBlobId),
  };
}

/** 读取并校验捕获的 before/after blob 状态。 */
function capturedFileStateToSnapshot(
  ctx: Pick<ApiHandlerContext, "db">,
  filePath: string,
  side: "before" | "after",
  exists: boolean,
  blobId: string | null,
): FileSnapshot {
  if (!exists) return { exists: false, data: null };
  if (!blobId) throw new Error(`缺少 ${side} 快照，无法回滚：${filePath}`);
  const blob = ctx.db.blobs.get(blobId);
  if (!blob) throw new Error(`${side} 快照不存在（blobId=${blobId}）：${filePath}`);
  return { exists: true, data: blob.data };
}

/** 在底层文件副作用前执行 after-state 前置条件并写入 inverse target。 */
function applyInverseChange(
  input: {
    workspacePath: string;
    path: string;
    mutation: InverseFileMutation;
  },
): void {
  const abs = resolveWorkspaceAbsPath(input.workspacePath, input.path);
  if (!input.mutation.target.exists) {
    removeFileIfExists(abs, input.path, input.mutation.expectedCurrent, "rollback_file_conflict");
    return;
  }
  if (!input.mutation.target.data) throw new Error(`inverse target 内容缺失：${input.path}`);
  writeRollbackFileAtomically(
    abs,
    input.mutation.target.data,
    input.path,
    input.mutation.expectedCurrent,
    "rollback_file_conflict",
  );
}

/** 同目录落临时文件、刷盘后原子替换目标，进程退出时磁盘只保留旧版或新版。 */
function writeRollbackFileAtomically(
  absPath: string,
  data: Buffer,
  relPath: string,
  expectedCurrent: FileSnapshot,
  conflictCode: "rollback_file_conflict" | "rollback_file_compensation_conflict",
): void {
  if (fileSnapshotsEqual(expectedCurrent, { exists: true, data })) {
    assertFileSnapshotPrecondition(absPath, relPath, expectedCurrent, conflictCode);
    return;
  }
  const directory = path.dirname(absPath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(absPath)}.codeflow-rollback-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  let failure: Error | null = null;
  let mutationApplied = false;
  try {
    let mode = 0o666;
    try {
      const current = fs.statSync(absPath);
      if (!current.isFile()) throw new Error(`回滚路径不是普通文件：${relPath}`);
      mode = current.mode;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
    }
    descriptor = fs.openSync(tempPath, "wx", mode);
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    assertFileSnapshotPrecondition(absPath, relPath, expectedCurrent, conflictCode);
    fs.renameSync(tempPath, absPath);
    mutationApplied = true;
    syncDirectoryAfterMutation(directory);
  } catch (cause) {
    failure = toError(cause, `原子写入回滚文件失败：${relPath}`);
    if (!mutationApplied) {
      try {
        mutationApplied = inferFileMutationApplied(absPath, expectedCurrent, { exists: true, data });
      } catch (verificationCause) {
        mutationApplied = true;
        failure = new AggregateError(
          [failure, toError(verificationCause, `核对回滚写入结果失败：${relPath}`)],
          failure.message,
          { cause: failure },
        );
      }
    }
    if (mutationApplied) Object.assign(failure, { rollbackFileMutationApplied: true });
  }

  const cleanupFailures: Error[] = [];
  if (descriptor != null) {
    try {
      fs.closeSync(descriptor);
    } catch (cause) {
      cleanupFailures.push(toError(cause, `关闭回滚临时文件失败：${relPath}`));
    }
  }
  if (failure) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") {
        cleanupFailures.push(toError(cause, `清理回滚临时文件失败：${relPath}`));
      }
    }
  }
  if (failure && cleanupFailures.length > 0) {
    const aggregate = new AggregateError([failure, ...cleanupFailures], failure.message, { cause: failure });
    if (mutationApplied) Object.assign(aggregate, { rollbackFileMutationApplied: true });
    throw aggregate;
  }
  if (failure) throw failure;
}

/** POSIX 上同步目录元数据；Windows 的同卷 rename 已提供进程崩溃所需的原子替换边界。 */
function syncDirectoryAfterMutation(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** 严格读取回滚快照；仅 ENOENT 代表文件不存在，其余 I/O 异常向上抛出。 */
function readFileSnapshot(absPath: string): FileSnapshot {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) throw new Error(`回滚路径不是普通文件：${absPath}`);
    const maxBytes = 2_000_000;
    if (st.size > maxBytes) throw new Error(`文件过大，无法安全回滚：${absPath}`);
    return { exists: true, data: fs.readFileSync(absPath) };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return { exists: false, data: null };
    throw cause;
  }
}

/** 尝试补偿全部已触碰文件，先统一验证再逐文件执行带前置条件的恢复。 */
function restoreSnapshots(workspacePath: string, entries: Map<string, FileCompensationEntry>): void {
  for (const [relPath, entry] of entries) {
    const abs = resolveWorkspaceAbsPath(workspacePath, relPath);
    assertFileSnapshotPrecondition(abs, relPath, entry.expectedCurrent, "rollback_file_compensation_conflict");
  }

  const failures: Error[] = [];
  for (const [relPosix, entry] of entries) {
    const abs = resolveWorkspaceAbsPath(workspacePath, relPosix);
    try {
      restoreFileSnapshot(abs, relPosix, entry);
    } catch (cause) {
      failures.push(toError(cause, `补偿文件失败：${relPosix}`));
    }
  }
  if (failures.length > 0) {
    const failure = new Error(
      `文件补偿失败（${failures.length} 个）：${failures.map((failure) => failure.message).join("；")}`,
      { cause: new AggregateError(failures) },
    );
    if (failures.some((nested) => hasNestedErrorCode(nested, "rollback_file_compensation_conflict"))) {
      Object.assign(failure, { code: "rollback_file_compensation_conflict" });
    }
    throw failure;
  }
}

/** 将单个文件从期望状态恢复到指定快照，所有写删都在副作用前复检。 */
function restoreFileSnapshot(absPath: string, relPath: string, entry: FileCompensationEntry): void {
  if (fileSnapshotsEqual(entry.expectedCurrent, entry.restore)) {
    assertFileSnapshotPrecondition(
      absPath,
      relPath,
      entry.expectedCurrent,
      "rollback_file_compensation_conflict",
    );
    return;
  }
  if (!entry.restore.exists) {
    removeFileIfExists(
      absPath,
      relPath,
      entry.expectedCurrent,
      "rollback_file_compensation_conflict",
    );
    return;
  }
  if (!entry.restore.data) throw new Error(`补偿快照内容缺失：${relPath}`);
  writeRollbackFileAtomically(
    absPath,
    entry.restore.data,
    relPath,
    entry.expectedCurrent,
    "rollback_file_compensation_conflict",
  );
}

/** 仅删除普通文件；副作用后刷盘失败时保留 mutation 已发生标记。 */
function removeFileIfExists(
  absPath: string,
  relPath: string,
  expectedCurrent: FileSnapshot,
  conflictCode: "rollback_file_conflict" | "rollback_file_compensation_conflict",
): void {
  if (!expectedCurrent.exists) {
    assertFileSnapshotPrecondition(absPath, relPath, expectedCurrent, conflictCode);
    return;
  }
  let mutationApplied = false;
  try {
    assertFileSnapshotPrecondition(absPath, relPath, expectedCurrent, conflictCode);
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) throw new Error(`回滚路径不是普通文件：${relPath}`);
    fs.unlinkSync(absPath);
    mutationApplied = true;
    syncDirectoryAfterMutation(path.dirname(absPath));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT" && !mutationApplied) {
      const message = conflictCode === "rollback_file_compensation_conflict"
        ? `文件补偿冲突：${relPath}（删除前文件已被外部移除）`
        : `文件在回滚删除前已被外部移除：${relPath}`;
      throw Object.assign(new Error(message, { cause }), { code: conflictCode });
    }
    let failure = toError(cause, `删除回滚文件失败：${relPath}`);
    if (!mutationApplied) {
      try {
        mutationApplied = inferFileMutationApplied(absPath, expectedCurrent, { exists: false, data: null });
      } catch (verificationCause) {
        mutationApplied = true;
        failure = new AggregateError(
          [failure, toError(verificationCause, `核对回滚删除结果失败：${relPath}`)],
          failure.message,
          { cause: failure },
        );
      }
    }
    if (mutationApplied) Object.assign(failure, { rollbackFileMutationApplied: true });
    throw failure;
  }
}

/** 比较两个内存快照的存在性与字节内容。 */
function fileSnapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return Boolean(left.data && right.data && left.data.equals(right.data));
}

/** 在紧邻文件副作用的位置验证当前内容，冲突时不触碰磁盘。 */
function assertFileSnapshotPrecondition(
  absPath: string,
  relPath: string,
  expected: FileSnapshot,
  code: "rollback_file_conflict" | "rollback_file_compensation_conflict",
): void {
  const current = readFileSnapshot(absPath);
  if (fileSnapshotsEqual(current, expected)) return;
  const message = code === "rollback_file_compensation_conflict"
    ? `文件补偿冲突：${relPath}（当前内容不再等于本轮 inverse target）`
    : `文件在回滚提交期间发生变化：${relPath}`;
  throw Object.assign(
    new Error(message),
    { code },
  );
}

/** 文件 API 报错后根据磁盘实态判断目标副作用是否已经发生。 */
function inferFileMutationApplied(
  absPath: string,
  expectedCurrent: FileSnapshot,
  target: FileSnapshot,
): boolean {
  const current = readFileSnapshot(absPath);
  if (fileSnapshotsEqual(current, target)) return true;
  if (fileSnapshotsEqual(current, expectedCurrent)) return false;
  return false;
}

/** 识别底层写删已生效但后续持久化步骤失败的错误。 */
function hasRollbackFileMutationApplied(cause: unknown): boolean {
  return Boolean(cause && typeof cause === "object" && (cause as any).rollbackFileMutationApplied === true);
}

/** 构造不会被普通补偿失败吞并的外部编辑冲突。 */
function fileCompensationConflict(relPath: string, reason: string): Error {
  return Object.assign(
    new Error(`文件补偿冲突：${relPath}（${reason}）`),
    { code: "rollback_file_compensation_conflict" },
  );
}

function resolveWorkspaceAbsPath(workspacePath: string, relPosixPath: string): string {
  const rel = String(relPosixPath ?? "").trim();
  if (!rel) throw new Error("非法路径：空 path");
  const workspaceAbs = path.resolve(workspacePath);
  const abs = path.resolve(workspaceAbs, rel.split("/").join(path.sep));
  const safeRel = path.relative(workspaceAbs, abs);
  if (!safeRel || safeRel === "." || safeRel.startsWith("..") || path.isAbsolute(safeRel)) {
    throw new Error(`非法路径（越界）：${relPosixPath}`);
  }
  assertRollbackPathHasNoLinkedComponents(workspaceAbs, safeRel, relPosixPath);
  return abs;
}

/** 拒绝通过 workspace 内 symlink/junction 父目录访问外部路径。 */
function assertRollbackPathHasNoLinkedComponents(
  workspaceAbs: string,
  safeRel: string,
  originalPath: string,
): void {
  const root = fs.statSync(workspaceAbs);
  if (!root.isDirectory()) throw new Error(`workspace 不是目录：${workspaceAbs}`);

  const parts = safeRel.split(path.sep).filter(Boolean);
  let current = workspaceAbs;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    let stat: ReturnType<typeof fs.lstatSync>;
    try {
      stat = fs.lstatSync(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw cause;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`非法路径（包含 symlink/junction）：${originalPath}`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`非法路径（父级不是目录）：${originalPath}`);
    }
  }
}

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

