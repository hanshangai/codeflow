import type { ConversationEventEnvelope, ConversationEventInput, SessionId, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { classifyTurnErrorSemantics } from "@codeflowai/shared";
import { createTurnErrorEventInput } from "../errors/turnErrors.js";

import type { ClientDb } from "../db/clientDb.js";
import { allocateClientEventSeq, readWorkspaceEventSeqFloor, recordWorkspaceEventSeqFloor } from "../db/repos/eventRepo.js";
import type { ThreadTurnRecord } from "../db/repos/threadTurnRepo.js";
import type { ThreadStore } from "../threads/threadStore.js";
import type { ThreadSessionManager } from "../engines/threadSessionManager.js";
import { engineDiagnosticCause, writeEngineWorkspaceLog } from "../engines/threadSession.js";
import type { WorkspaceLogEntry } from "../logger.js";
import {
  findCodexClientUserMessageIdsFromHistory,
  findCodexProviderTurnIdentityFromHistory,
} from "../app/utils/codexTurnHistory.js";

export type StartupDanglingTurnReconcileResult = {
  events: ConversationEventEnvelope[];
  scanned: number;
  completed: number;
  errored: number;
  pending: number;
  droppedSessionBindings: number;
};

/** 固定当前已核工作区；诊断构造与写入失败保留原业务抛值。 */
function logStartup(db: ClientDb, level: WorkspaceLogEntry["level"], message: string,
  build: () => Record<string, unknown>, business?: { reason: unknown }): void {
  if (db.workspaceId === null) throw new Error("STARTUP_RECONCILE_WORKSPACE_REQUIRED");
  const workspaceId = db.workspaceId;
  writeEngineWorkspaceLog(db.writeWorkspaceLog, workspaceId, () => {
    const data = build();
    return { level, tag: "startup-reconcile", message, data: { ...data,
      code: data.code ?? "STARTUP_TURN_RECONCILE", requestId: data.requestId ?? `startup-reconcile:${workspaceId}` } };
  }, business);
}

/** Client 重启时按统一序号在本地收口未完成 turn，不访问 provider。 */
export async function finalizeDanglingTurnsOnStartup(input: {
  db: ClientDb;
  withDatabase?: <T>(operation: () => T) => Promise<T>;
}): Promise<StartupDanglingTurnReconcileResult> {
  /** 启动恢复只在短同步段访问仓储，不让异步调用方持有Writer许可。 */
  const database = async <T>(operation: () => T): Promise<T> => input.withDatabase ? input.withDatabase(operation) : operation();
  if (input.db.workspaceId === null) {
    const result = emptyReconcileResult();
    for (const workspace of await database(() => input.db.workspaces.list())) {
      const scoped = await database(() => input.db.forWorkspace(workspace.id));
      mergeReconcileResult(result, await finalizeDanglingTurnsOnStartup({ ...input, db: scoped }));
    }
    return result;
  }
  let result: StartupDanglingTurnReconcileResult;
  try {
    result = await database(() => input.db.db.transaction(() => {
      const runningTurns = input.db.turns.listRunning();
      const appended: ConversationEventEnvelope[] = [];
      for (const turn of runningTurns) {
        const providerThreadId = turn.engineSessionId ?? input.db.threads.get(turn.threadId)?.sessionId ?? null;
        appended.push(appendSyntheticConversationEvent(input.db, {
          event: createTurnErrorEventInput({
            ts: Date.now(),
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            engine: turn.engine,
            turnId: turn.turnId,
            error: "CodeFlow 重启导致上一回合中断，未尝试恢复 provider 结果。",
            code: "client_restarted",
            recoveryReason: "client_restart_discard",
            providerThreadId,
            terminationKind: "transient_cleanup",
          }),
        }, true));
      }
      return { ...emptyReconcileResult(), events: appended, scanned: runningTurns.length, errored: appended.length };
    }, { mode: "immediate", requireOutermost: true })());
  } catch (cause) {
    logStartup(input.db, "error", "startup local turn finalization failed", () => ({
      code: "STARTUP_TURN_FINALIZATION_FAILED", rootCause: engineDiagnosticCause(cause),
    }), { reason: cause });
    throw cause;
  }

  logStartup(input.db, "info", "dangling turns finalized locally after client restart", () => ({
    code: "client_restart_discard",
    strategy: "discard",
    providerQueries: 0,
    workspaceId: input.db.workspaceId,
    scanned: result.scanned,
    completed: 0,
    errored: result.errored,
    pending: 0,
    droppedSessionBindings: 0,
  }));
  return result;
}

/** 跨工作区仅聚合已完成结果，不建立跨库事务或第二份定位状态。 */
function emptyReconcileResult(): StartupDanglingTurnReconcileResult {
  return { events: [], scanned: 0, completed: 0, errored: 0, pending: 0, droppedSessionBindings: 0 };
}

/** 按原工作区顺序聚合；调用失败直接向上抛出，后续工作区不处理。 */
function mergeReconcileResult(target: StartupDanglingTurnReconcileResult, source: StartupDanglingTurnReconcileResult): void {
  target.events.push(...source.events);
  target.scanned += source.scanned;
  target.completed += source.completed;
  target.errored += source.errored;
  target.pending += source.pending;
  target.droppedSessionBindings += source.droppedSessionBindings;
}

/** 启动公共入口固定采用本地丢弃策略，保留旧名称供调用方平滑迁移。 */
export async function reconcileDanglingTurnsOnStartup(input: {
  db: ClientDb;
}): Promise<StartupDanglingTurnReconcileResult> {
  return await finalizeDanglingTurnsOnStartup(input);
}

/** 显式按 provider 证据对账并统一编号；不属于 Client 启动路径。 */
export async function reconcileDanglingTurnsWithProvider(input: {
  db: ClientDb;
  threads: ThreadStore;
  sessions: ThreadSessionManager;
}): Promise<StartupDanglingTurnReconcileResult> {
  if (input.db.workspaceId === null) {
    const result = emptyReconcileResult();
    for (const workspace of input.db.workspaces.list()) {
      mergeReconcileResult(result, await reconcileDanglingTurnsWithProvider({ ...input, db: input.db.forWorkspace(workspace.id) }));
    }
    return result;
  }
  const runningTurns = input.db.turns.listRunning();
  if (!runningTurns.length) {
    return {
      events: [],
      scanned: 0,
      completed: 0,
      errored: 0,
      pending: 0,
      droppedSessionBindings: 0,
    };
  }

  let completedCount = 0;
  let errorCount = 0;
  let pendingCount = 0;
  let droppedSessionBindingCount = 0;
  const events: ConversationEventEnvelope[] = [];
  const startupRunningTurnIdsByThread = new Map<string, TurnId[]>();
  for (const turn of runningTurns) {
    if (turn.engine !== "codex") continue;
    const key = String(turn.threadId);
    const turnIds = startupRunningTurnIdsByThread.get(key) ?? [];
    turnIds.push(turn.turnId);
    startupRunningTurnIdsByThread.set(key, turnIds);
  }
  for (const turn of runningTurns) {
    if (turn.engine === "codex") {
      const workspacePath = input.sessions.getWorkspacePath(turn.workspaceId);
      let providerIdentity: ReturnType<typeof findCodexProviderTurnIdentityFromHistory>;
      try {
        providerIdentity = findCodexProviderTurnIdentityFromHistory(input.db, {
          threadId: turn.threadId,
          clientTurnId: turn.turnId,
        });
      } catch (cause) {
        logStartup(input.db, "error", "invalid Codex provider turn history", () => ({
          code: "CODEX_PROVIDER_TURN_HISTORY_INVALID", requestId: `provider-reconcile:${turn.turnId}`,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId: turn.turnId,
          rootCause: engineDiagnosticCause(cause),
        }), { reason: cause });
        throw cause;
      }
      let engineSessionId = providerIdentity.engineSessionId;
      let engineSessionSource: "durable_history" | "start_attempt" | "weak_candidate" =
        providerIdentity.engineSessionSource === "durable_history"
          ? "durable_history"
          : providerIdentity.engineSessionSource === "start_attempt"
            ? "start_attempt"
            : "weak_candidate";
      const engineTurnId = providerIdentity.engineTurnId;
      const exactProviderTurn = Boolean(engineSessionId && engineTurnId);
      if (
        providerIdentity.engineSessionSource !== "durable_history"
        && providerIdentity.engineSessionSource !== "start_attempt"
      ) {
        const threadSessionCandidate = findStartupCodexThreadSessionCandidate(
          input.db,
          turn,
          providerIdentity.engineSessionSource === "turn_row" ? providerIdentity.engineSessionId : null,
          startupRunningTurnIdsByThread.get(String(turn.threadId)) ?? [],
        );
        if (threadSessionCandidate.kind === "unsafe") {
          logStartup(input.db, "warn", "Codex thread session candidate is unsafe; keeping turn pending", () => ({
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            turnId: turn.turnId,
            error: threadSessionCandidate.message,
          }));
          pendingCount += 1;
          continue;
        }
        if (threadSessionCandidate.kind === "candidate") {
          engineSessionId = threadSessionCandidate.engineSessionId;
        }
      }

      if (workspacePath && engineSessionId) {
        let clientUserMessageIds: string[] | undefined;
        if (!exactProviderTurn) {
          const clientIdLookup = findCodexClientUserMessageIdsFromHistory(input.db, {
            threadId: turn.threadId,
            clientTurnId: turn.turnId,
          });
          if (clientIdLookup.kind === "incomplete") {
            logStartup(input.db, "warn", "Codex clientId history incomplete; keeping turn pending", () => ({
              workspaceId: turn.workspaceId,
              threadId: turn.threadId,
              turnId: turn.turnId,
              error: clientIdLookup.message,
            }));
            pendingCount += 1;
            continue;
          }
          clientUserMessageIds = clientIdLookup.clientUserMessageIds;
        }
        let reconciled: Awaited<ReturnType<ThreadSessionManager["reconcileCodexDanglingTurn"]>>;
        try {
          reconciled = await input.sessions.reconcileCodexDanglingTurn({
            threadId: turn.threadId,
            workspaceId: turn.workspaceId,
            workspacePath,
            turnId: turn.turnId,
            engineSessionId,
            engineTurnId,
            exactProviderTurn,
            ...(clientUserMessageIds ? { clientUserMessageIds } : {}),
          });
        } catch (cause) {
          logStartup(input.db, "error", "Codex provider reconcile failed", () => ({
            code: "client_restart_reconcile_failed",
            requestId: `provider-reconcile:${turn.turnId}`,
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            turnId: turn.turnId,
            engineSessionId,
            engineTurnId,
            rootCause: engineDiagnosticCause(cause),
          }), { reason: cause });
          throw cause;
        }
        const actualEngineTurnId = String(reconciled.actualEngineTurnId ?? "").trim();
        if (
          actualEngineTurnId
          && (actualEngineTurnId !== engineTurnId || engineSessionSource !== "durable_history")
        ) {
          const previousEngineTurnId = actualEngineTurnId === engineTurnId ? null : engineTurnId;
          try {
            events.push(appendRecoveredCodexProviderBinding(input.db, {
              observedAt: Date.now(),
              workspaceId: turn.workspaceId,
              threadId: turn.threadId,
              clientTurnId: turn.turnId,
              engineSessionId,
              engineTurnId: actualEngineTurnId,
              previousEngineTurnId,
            }));
            engineSessionSource = "durable_history";
          } catch (cause) {
            logStartup(input.db, "error", "Codex provider mapping repair failed", () => ({
              code: "codex_startup_provider_binding_conflict",
              requestId: `provider-reconcile:${turn.turnId}`,
              workspaceId: turn.workspaceId,
              threadId: turn.threadId,
              turnId: turn.turnId,
              engineSessionId,
              previousEngineTurnId,
              actualEngineTurnId,
              rootCause: engineDiagnosticCause(cause),
            }), { reason: cause });
            throw cause;
          }
        }
        if (reconciled.kind === "completed") {
          try {
            const recoveredEvents = input.db.db.transaction(() => {
              const appended: ConversationEventEnvelope[] = [];
              for (const assistantEvent of reconciled.assistantEvents) {
                appended.push(appendSyntheticConversationEvent(input.db, {
                  event: {
                    ...assistantEvent,
                    ts: Date.now(),
                  },
                }, true));
              }
              appended.push(appendSyntheticConversationEvent(input.db, {
                event: {
                  ts: Date.now(),
                  workspaceId: turn.workspaceId,
                  threadId: turn.threadId,
                  engine: turn.engine,
                  type: "turn.completed",
                  payload: {
                    turnId: turn.turnId,
                    result: {
                      responseText: reconciled.responseText ?? "",
                      recoveredAfterRestart: true,
                    },
                  },
                },
              }, true));
              return appended;
            }, { mode: "immediate", requireOutermost: true })();
            events.push(...recoveredEvents);
            completedCount += 1;
          } catch (cause) {
            logStartup(input.db, "error", "Codex completed recovery persistence failed", () => ({
              code: "client_restart_completed_persistence_failed",
              requestId: `provider-reconcile:${turn.turnId}`,
              workspaceId: turn.workspaceId,
              threadId: turn.threadId,
              turnId: turn.turnId,
              rootCause: engineDiagnosticCause(cause),
            }), { reason: cause });
            throw cause;
          }
          continue;
        }

        if (reconciled.kind === "pending") {
          logStartup(input.db, "info", "Codex provider turn remains pending", () => ({
            code: reconciled.code,
            requestId: null,
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            turnId: turn.turnId,
            engineSessionId,
            engineTurnId,
            rootCause: engineDiagnosticCause(reconciled.message),
          }));
          pendingCount += 1;
          continue;
        }

        const providerTerminal = (reconciled as { providerTerminal?: unknown }).providerTerminal === true;
        if (!providerTerminal) {
          logStartup(input.db, "error", "Codex recovery failed without provider terminal; preserving running state", () => ({
            code: reconciled.code,
            requestId: null,
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            turnId: turn.turnId,
            engineSessionId,
            engineTurnId,
            providerThreadId: reconciled.providerThreadId ?? engineSessionId,
            rootCause: engineDiagnosticCause(reconciled.message),
          }));
          pendingCount += 1;
          continue;
        }

        try {
          const terminalEvent = appendSyntheticConversationEvent(input.db, {
            event: createTurnErrorEventInput({
              ts: Date.now(),
              workspaceId: turn.workspaceId,
              threadId: turn.threadId,
              engine: turn.engine,
              turnId: turn.turnId,
              error: reconciled.message,
              code: reconciled.code,
              terminationKind: classifyTurnErrorSemantics({
                error: reconciled.message,
                code: reconciled.code,
              }),
            }),
          });
          events.push(terminalEvent);
          errorCount += 1;
        } catch (cause) {
          logStartup(input.db, "error", "Codex terminal persistence failed", () => ({
            code: "client_restart_terminal_persistence_failed",
            requestId: `provider-reconcile:${turn.turnId}`,
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            turnId: turn.turnId,
            rootCause: engineDiagnosticCause(cause),
          }), { reason: cause });
          throw cause;
        }
        continue;
      }

      if (!engineSessionId) {
        logStartup(input.db, "warn", "Codex provider binding missing; keeping turn pending", () => ({
          code: "client_restart_provider_binding_missing",
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId: turn.turnId,
          rootCause: "provider session id is unavailable",
        }));
        pendingCount += 1;
        continue;
      }

      if (!workspacePath) {
        logStartup(input.db, "warn", "Codex workspace unavailable; keeping turn pending", () => ({
          code: "client_restart_workspace_missing",
          requestId: null,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId: turn.turnId,
          engineSessionId,
          engineTurnId,
          rootCause: "workspace path is unavailable",
        }));
        pendingCount += 1;
        continue;
      }
    }

    events.push(appendSyntheticConversationEvent(input.db, {
      event: {
        ...createTurnErrorEventInput({
          ts: Date.now(),
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          engine: turn.engine,
          turnId: turn.turnId,
          error: "CodeFlow 重启前的回合未完成，已在本地收尾。",
          code: "client_restarted",
          terminationKind: "transient_cleanup",
        }),
      },
    }));
    errorCount += 1;
  }

  logStartup(input.db, "info", "dangling turns reconciled", () => ({
    scanned: runningTurns.length,
    completed: completedCount,
    errored: errorCount,
    pending: pendingCount,
    droppedSessionBindings: droppedSessionBindingCount,
  }));
  return {
    events,
    scanned: runningTurns.length,
    completed: completedCount,
    errored: errorCount,
    pending: pendingCount,
    droppedSessionBindings: droppedSessionBindingCount,
  };
}

type StartupCodexThreadSessionCandidate =
  | { kind: "missing" }
  | { kind: "candidate"; engineSessionId: SessionId }
  | { kind: "unsafe"; message: string };

/** row/thread 弱 session 仅在持久化 Codex thread 只有当前一个 started turn 时进入 provider ownership 确权。 */
function findStartupCodexThreadSessionCandidate(
  db: ClientDb,
  turn: ThreadTurnRecord,
  turnRowSessionId: SessionId | null,
  startupRunningTurnIds: readonly TurnId[],
): StartupCodexThreadSessionCandidate {
  const persisted = db.threads.get(turn.threadId);
  if (!persisted) {
    return {
      kind: "unsafe",
      message: `CodeFlow 重启时缺少 Codex 持久化 thread，无法恢复 provider session ownership：turnId=${turn.turnId}`,
    };
  }
  if (persisted.workspaceId !== turn.workspaceId || persisted.engine !== "codex") {
    return {
      kind: "unsafe",
      message: `CodeFlow 重启时 Codex thread scope 不匹配，无法恢复 provider session ownership：turnId=${turn.turnId}, workspaceId=${persisted.workspaceId}, engine=${persisted.engine}`,
    };
  }
  const engineSessionId = String(turnRowSessionId ?? persisted.sessionId ?? "").trim();
  if (!engineSessionId) return { kind: "missing" };

  if (startupRunningTurnIds.length !== 1 || startupRunningTurnIds[0] !== turn.turnId) {
    return {
      kind: "unsafe",
      message: `CodeFlow 重启时 thread 级 Codex session 无法归属到唯一 started turn；会话继续保持运行状态：turnId=${turn.turnId}, running=${startupRunningTurnIds.length}`,
    };
  }
  return { kind: "candidate", engineSessionId: engineSessionId as SessionId };
}

/** 原子编号并追加 ownership 修复事件，随后替换本地 provider checkpoint。 */
function appendRecoveredCodexProviderBinding(
  db: ClientDb,
  input: {
    observedAt: number;
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    clientTurnId: TurnId;
    engineSessionId: SessionId;
    engineTurnId: string;
    previousEngineTurnId: string | null;
  },
): ConversationEventEnvelope {
  const transaction = db.db.transaction(() => {
    const envelope = appendSyntheticConversationEvent(db, {
      event: {
        ts: input.observedAt,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: {
          turnId: input.clientTurnId,
          engineTurnId: input.engineTurnId,
          engineSessionId: input.engineSessionId,
          previousEngineTurnId: input.previousEngineTurnId,
        },
      },
    }, true);
    db.turns.setCodexProviderTurnId(input.clientTurnId, {
      engineTurnId: input.engineTurnId,
      engineSessionId: input.engineSessionId,
      previousEngineTurnId: input.previousEngineTurnId,
      source: "turn.engineBound",
      eventSeq: envelope.seq,
      observedAt: envelope.ts,
    });
    return envelope;
  }, { mode: "immediate", requireOutermost: true });
  return transaction();
}

/** W先持写锁，再在应用库耐久预留序号；正文、floor和索引在W同事务提交。 */
function appendSyntheticConversationEvent(
  db: ClientDb,
  input: {
    event: ConversationEventInput;
  },
  inWorkspaceTransaction = false,
): ConversationEventEnvelope {
  return db.db.transaction(() => {
    const ts = Number(input.event.ts ?? Date.now());
    const envelope: ConversationEventEnvelope = {
      ...input.event,
      ts,
      seq: allocateClientEventSeq(db.applicationDb, { requireOutermost: true,
        minimumSeqExclusive: readWorkspaceEventSeqFloor(db.db) }),
      schema: 1,
    };
    db.conversationEvents.appendEnvelope(envelope, { requireInsert: true });
    recordWorkspaceEventSeqFloor(db.db, envelope.seq);
    db.threads.touch(input.event.threadId as ThreadId, ts);

    if (input.event.type === "turn.completed" || input.event.type === "turn.error") {
      const turnId = String((input.event.payload as any)?.turnId ?? "").trim();
      if (turnId) {
        db.turns.setEnded(turnId as TurnId, {
          status: input.event.type === "turn.completed" ? "completed" : "error",
          endedAt: ts,
          endEventSeq: envelope.seq,
        });
      }
    }
    return envelope;
  }, inWorkspaceTransaction ? undefined : { mode: "immediate", requireOutermost: true })();
}
