import type {
  ConversationEventEnvelope,
  EngineType,
  SessionId,
  ThreadId,
  ThreadSessionCapabilities,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";

export type ThreadStartedBindingPlan =
  | { kind: "not_applicable" }
  | { kind: "missing_thread"; threadId: ThreadId; sessionId: SessionId | null }
  | {
      kind: "stale_binding";
      threadId: ThreadId;
      sessionId: SessionId;
      currentSessionId: SessionId | null;
      reason: "runtime_mismatch" | "persisted_mismatch" | "runtime_without_persisted" | "detached";
    }
  | {
      kind: "apply";
      threadId: ThreadId;
      sessionId: SessionId;
      engine: EngineType;
      sessionCapabilities: ThreadSessionCapabilities | null;
    };

/** 在 ACK 入队前校验 thread.started 归属；缺失 thread 只保留证据，不推断删除原因。 */
export function resolveThreadStartedBinding(
  db: ClientDb,
  event: ConversationEventEnvelope,
  currentRuntimeSessionId?: SessionId | null,
): ThreadStartedBindingPlan {
  if (event.type !== "thread.started") return { kind: "not_applicable" };
  const sessionId = (String(event.payload.sessionId ?? "").trim() || null) as SessionId | null;
  const persistedThread = db.threads.get(event.threadId);
  if (!persistedThread) {
    return { kind: "missing_thread", threadId: event.threadId, sessionId };
  }
  if (
    persistedThread.workspaceId !== event.workspaceId
    || persistedThread.engine !== event.engine
  ) {
    throw new Error(
      `thread.started scope 不匹配：threadId=${event.threadId}, workspaceId=${event.workspaceId}, engine=${event.engine}`,
    );
  }
  if (!sessionId) return { kind: "not_applicable" };
  if (persistedThread.engine === "codex") {
    const runtimeSessionId = (String(currentRuntimeSessionId ?? "").trim() || null) as SessionId | null;
    const persistedSessionId = (String(persistedThread.sessionId ?? "").trim() || null) as SessionId | null;
    if (persistedSessionId && persistedSessionId !== sessionId) {
      return {
        kind: "stale_binding",
        threadId: event.threadId,
        sessionId,
        currentSessionId: persistedSessionId,
        reason: "persisted_mismatch",
      };
    }
    if (runtimeSessionId && runtimeSessionId !== sessionId) {
      return {
        kind: "stale_binding",
        threadId: event.threadId,
        sessionId,
        currentSessionId: runtimeSessionId,
        reason: "runtime_mismatch",
      };
    }
    if (!persistedSessionId && runtimeSessionId) {
      return {
        kind: "stale_binding",
        threadId: event.threadId,
        sessionId,
        currentSessionId: runtimeSessionId,
        reason: "runtime_without_persisted",
      };
    }
    if (!runtimeSessionId && !persistedSessionId) {
      return {
        kind: "stale_binding",
        threadId: event.threadId,
        sessionId,
        currentSessionId: null,
        reason: "detached",
      };
    }
  }
  return {
    kind: "apply",
    threadId: event.threadId,
    sessionId,
    engine: persistedThread.engine,
    sessionCapabilities: event.payload.sessionCapabilities ?? null,
  };
}

/** 校验 binding 后将 canonical ACK 入队；scope 冲突会在入队前显式失败。 */
export function prepareThreadStartedBindingAck(
  db: ClientDb,
  event: ConversationEventEnvelope,
  enqueueCanonicalAck: (event: ConversationEventEnvelope) => void,
  currentRuntimeSessionId?: SessionId | null,
): ThreadStartedBindingPlan {
  const plan = resolveThreadStartedBinding(db, event, currentRuntimeSessionId);
  if (plan.kind !== "missing_thread") enqueueCanonicalAck(event);
  return plan;
}

/** 应用已校验的 session binding；只有共享 session 的 Claude 才回填 thread 内 turns。 */
export function applyThreadStartedBinding(db: ClientDb, plan: ThreadStartedBindingPlan): void {
  if (plan.kind !== "apply") return;
  db.threads.setSessionBinding(plan.threadId, plan.sessionId, plan.sessionCapabilities);
  if (plan.engine === "claude") {
    db.turns.setEngineSessionIdByThread(plan.threadId, plan.sessionId);
  }
}
