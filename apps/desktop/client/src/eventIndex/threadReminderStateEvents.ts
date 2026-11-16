import { classifyTurnErrorSemantics } from "@codeflowai/shared";
import type { ConversationEventEnvelope, TurnId } from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";

type ThreadReminderStateSnapshot = ReturnType<ClientDb["threadReminderStates"]["get"]>;

/** 根据会话事件更新提醒状态，返回是否实际改变了提醒派生数据。 */
export function applyThreadReminderStateEvent(
  db: Pick<ClientDb, "threadReminderStates">,
  event: ConversationEventEnvelope,
): boolean {
  const before = db.threadReminderStates.get(event.threadId);
  const handled = applyThreadReminderStateEventMutation(db, event);
  if (!handled) return false;
  const after = db.threadReminderStates.get(event.threadId);
  return !sameThreadReminderState(before, after);
}

/** 执行会话提醒状态写入；未命中提醒相关事件时返回 false。 */
function applyThreadReminderStateEventMutation(
  db: Pick<ClientDb, "threadReminderStates">,
  event: ConversationEventEnvelope,
): boolean {
  if (event.type === "turn.started") {
    db.threadReminderStates.clearAttention(event.threadId, { updatedAt: Number(event.ts ?? Date.now()) });
    return true;
  }

  if (event.type === "turn.completed") {
    const turnId = String(event.payload.turnId ?? "").trim() as TurnId;
    if (!turnId) return false;
    db.threadReminderStates.recordTurnCompleted({
      threadId: event.threadId,
      workspaceId: event.workspaceId,
      turnId,
      completedAt: Number(event.ts ?? Date.now()),
    });
    return true;
  }

  if (event.type === "turn.error") {
    const turnId = String((event.payload as any)?.turnId ?? "").trim() as TurnId;
    if (!turnId) return false;
    const error = String((event.payload as any)?.error ?? "");
    const code = String((event.payload as any)?.code ?? "").trim();
    const terminationKind = (event.payload as any)?.terminationKind ?? null;
    const semantics = classifyTurnErrorSemantics({ terminationKind, error, code });
    if (semantics === "manual_interrupt") {
      db.threadReminderStates.recordTurnInterrupted({
        threadId: event.threadId,
        workspaceId: event.workspaceId,
        turnId,
        endedAt: Number(event.ts ?? Date.now()),
      });
      return true;
    }
    if (semantics === "transient_cleanup") {
      db.threadReminderStates.recordTurnTransientCleanup({
        threadId: event.threadId,
        workspaceId: event.workspaceId,
        turnId,
        endedAt: Number(event.ts ?? Date.now()),
      });
      return true;
    }
    db.threadReminderStates.recordTurnError({
      threadId: event.threadId,
      workspaceId: event.workspaceId,
      turnId,
      endedAt: Number(event.ts ?? Date.now()),
    });
    return true;
  }

  if (event.type === "approval.request") {
    db.threadReminderStates.setAttention({
      threadId: event.threadId,
      workspaceId: event.workspaceId,
      attentionKind: "approval",
      attentionRequestId: String((event.payload as any)?.requestId ?? ""),
      updatedAt: Number(event.ts ?? Date.now()),
    });
    return true;
  }

  if (event.type === "approval.resolved" || event.type === "approval.expired") {
    db.threadReminderStates.clearAttention(event.threadId, {
      attentionKind: "approval",
      requestId: String((event.payload as any)?.requestId ?? ""),
      updatedAt: Number(event.ts ?? Date.now()),
    });
    return true;
  }

  if (event.type === "userInput.requested") {
    db.threadReminderStates.setAttention({
      threadId: event.threadId,
      workspaceId: event.workspaceId,
      attentionKind: "user_input",
      attentionRequestId: String((event.payload as any)?.request?.requestId ?? ""),
      updatedAt: Number(event.ts ?? Date.now()),
    });
    return true;
  }

  if (event.type === "userInput.resolved" || event.type === "userInput.expired") {
    const requestId = event.type === "userInput.resolved"
      ? String((event.payload as any)?.response?.requestId ?? "")
      : String((event.payload as any)?.requestId ?? "");
    db.threadReminderStates.clearAttention(event.threadId, {
      attentionKind: "user_input",
      requestId,
      updatedAt: Number(event.ts ?? Date.now()),
    });
    return true;
  }

  return false;
}

/** 比较会影响提醒派生结果的字段，避免重复事件造成无意义刷新。 */
function sameThreadReminderState(
  left: ThreadReminderStateSnapshot,
  right: ThreadReminderStateSnapshot,
): boolean {
  return threadReminderOutputKey(left) === threadReminderOutputKey(right);
}

/** 生成提醒可见结果的轻量签名，避免仅内部时间戳变化触发刷新。 */
function threadReminderOutputKey(state: ThreadReminderStateSnapshot): string {
  if (!state) return "";
  const workspaceId = String(state.workspaceId ?? "");
  if (state.attentionKind) {
    return [
      workspaceId,
      "attention",
      state.attentionKind,
      state.attentionRequestId ?? "",
      state.updatedAt,
    ].join("::");
  }
  if (state.latestCompletedStatus === "interrupted") {
    return [workspaceId, "interrupted", state.updatedAt].join("::");
  }
  if (state.latestCompletedStatus === "completed" && state.latestCompletedTurnId) {
    return [
      workspaceId,
      "completed",
      state.latestCompletedTurnId,
      state.latestCompletedAt ?? "",
    ].join("::");
  }
  return "";
}
