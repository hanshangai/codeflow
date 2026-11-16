import { extractThreadPrefsPatchFromConversationEvent, mergeThreadPrefs, type TurnId } from "@codeflowai/shared";
import type { ClientDb } from "../db/clientDb.js";
import type { LocalEventMessage } from "./localEventPersistence.js";
import { applyThreadStartedBinding, resolveThreadStartedBinding } from "../eventIndex/threadStartedBinding.js";
import { applyThreadReminderStateEvent } from "../eventIndex/threadReminderStateEvents.js";
import { indexCodexProviderTurnStarted, persistOrStageCodexProviderTurn, type CodexProviderTurnIndexRuntime } from "../eventIndex/codexProviderTurnStarted.js";
import type { CodexProviderTurnMappingCandidate } from "../db/repos/codexProviderTurnMapping.js";

/** 纯输出没有主线程文件或生命周期副作用；正文、展示和DB索引仍完整提交。 */
export function hasLocalEventOwnerEffects(message: LocalEventMessage): boolean {
  if (message.t === "raw.event") return false;
  return !["item.agentMessage.delta", "item.agentMessage.snapshot", "item.reasoning.delta"].includes(message.event.type);
}

/** 既有数据库索引在Writer中执行；进程、文件检查点和外部通知仍由原运行owner收口。 */
export function createLocalEventDatabaseIndex() {
  return (db: ClientDb, message: LocalEventMessage): void => {
    const event = message.event;
    const turnId = String(message.t === "raw.event" ? message.event.clientTurnId ?? ""
      : (message.event.payload as { turnId?: unknown }).turnId ?? "").trim() as TurnId;
    const pendingKey = `local_event_provider_pending:${JSON.stringify([event.threadId, turnId])}`;
    const runtime: CodexProviderTurnIndexRuntime = { pendingCodexProviderTurnByClientTurnId: new Map() };
    if (event.engine === "codex" && turnId) {
      const row = db.db.prepare("SELECT value FROM meta WHERE key=?").get(pendingKey) as { value: string } | undefined;
      if (row) runtime.pendingCodexProviderTurnByClientTurnId.set(turnId, JSON.parse(row.value) as CodexProviderTurnMappingCandidate);
      const turn = db.turns.get(turnId);
      if (turn && (turn.workspaceId !== event.workspaceId || turn.threadId !== event.threadId || turn.engine !== event.engine)) throw new Error("LOCAL_EVENT_INDEX_TURN_SCOPE_INVALID");
    }
    /** 与所属批次索引事务一起保存待关联映射，失败回滚及Worker重启不丢失。 */
    const persistPending = (): void => {
      if (event.engine !== "codex" || !turnId) return;
      const pending = runtime.pendingCodexProviderTurnByClientTurnId.get(turnId);
      if (pending) db.db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(pendingKey, JSON.stringify(pending));
      else db.db.prepare("DELETE FROM meta WHERE key=?").run(pendingKey);
    };
    if (message.t === "raw.event") { indexCodexProviderTurnStarted({ db, runtime }, message.event); persistPending(); return; }
    const canonical = message.event;
    const thread = db.threads.get(event.threadId);
    if (!thread || thread.workspaceId !== event.workspaceId || thread.engine !== event.engine) throw new Error("LOCAL_EVENT_INDEX_THREAD_SCOPE_INVALID");
    const plan = resolveThreadStartedBinding(db, canonical, thread.sessionId);
    if (plan.kind === "stale_binding") return;
    applyThreadStartedBinding(db, plan);
    const patch = extractThreadPrefsPatchFromConversationEvent(canonical);
    if (patch) db.threads.updatePrefs(event.threadId, mergeThreadPrefs(thread, patch));
    if (canonical.type === "turn.started") {
      db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, engine: event.engine,
        turnId: canonical.payload.turnId, startedAt: event.ts, startEventSeq: event.seq });
    } else if (canonical.type === "item.userMessage.created" && canonical.payload.turnId && !canonical.payload.activeTurnAppend) {
      db.turns.setUserMessage(canonical.payload.turnId, { userItemId: canonical.payload.itemId, userText: canonical.payload.text });
    } else if (canonical.type === "turn.engineBound") {
      if (event.engine !== "codex") throw new Error("LOCAL_EVENT_INDEX_PROVIDER_SCOPE_INVALID");
      persistOrStageCodexProviderTurn({ db, runtime }, canonical.payload.turnId, {
        engineTurnId: canonical.payload.engineTurnId, engineSessionId: canonical.payload.engineSessionId,
        previousEngineTurnId: canonical.payload.previousEngineTurnId ?? null, source: "turn.engineBound", eventSeq: event.seq, observedAt: event.ts,
      });
    } else if (canonical.type === "turn.completed" || canonical.type === "turn.error") {
      const turnId = String(canonical.payload.turnId ?? "").trim() as TurnId;
      if (turnId) {
        const existing = db.turns.get(turnId);
        if (existing && (existing.threadId !== event.threadId || existing.workspaceId !== event.workspaceId || existing.engine !== event.engine)) {
          throw new Error("LOCAL_EVENT_INDEX_TURN_SCOPE_INVALID");
        }
        if (!existing) db.turns.insertStarted({ workspaceId: event.workspaceId, threadId: event.threadId, engine: event.engine,
          turnId, startedAt: event.ts, startEventSeq: null });
        db.turns.setEnded(turnId, { status: canonical.type === "turn.completed" ? "completed" : "error", endedAt: event.ts, endEventSeq: event.seq });
      }
    }
    const pending = turnId ? runtime.pendingCodexProviderTurnByClientTurnId.get(turnId) : undefined;
    if (pending && db.turns.get(turnId)) { db.turns.setCodexProviderTurnId(turnId, pending); runtime.pendingCodexProviderTurnByClientTurnId.delete(turnId); }
    persistPending();
    applyThreadReminderStateEvent(db, canonical);
    db.threads.touch(event.threadId, event.ts);
  };
}
