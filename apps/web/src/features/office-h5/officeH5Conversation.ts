import type { ConversationMessage, EngineEventEnvelope, ThreadId } from "@codeflowai/shared";

import type { ThreadConversationState } from "../chat/chatTypes";
import { applyEngineEventToConversation } from "../chat/engineEventReducer";

export type OfficeH5ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number | null;
  turnId: string | null;
  streaming: boolean;
};

export type OfficeH5ConversationSnapshot = {
  messages: OfficeH5ConversationMessage[];
  completedTurnIds: string[];
};

/** Create the minimal conversation state required by the canonical reducer. */
function createReplayState(threadId: ThreadId): ThreadConversationState {
  return {
    threadId,
    items: [],
    tokenUsage: null,
    runningTurnId: null,
    runningTurnStartedAt: null,
    completedTurnIds: {},
    engineSessionId: null,
    currentTodolist: null,
    invalidated: false,
    _indexById: new Map(),
    _assistantTranscriptIdByItemId: new Map(),
    _assistantTranscriptIdByTurnId: new Map(),
  };
}

/** Replay canonical events and return only user and assistant messages for H5. */
export function replayOfficeH5Conversation(
  threadId: ThreadId,
  events: readonly EngineEventEnvelope[],
): OfficeH5ConversationSnapshot {
  const state = createReplayState(threadId);
  const orderedEvents = [...events].sort((left, right) => left.seq - right.seq);
  for (const event of orderedEvents) applyEngineEventToConversation(state, event);

  const messages = state.items
    .filter((item): item is ConversationMessage => item.kind === "message")
    .filter((item) => Boolean(String(item.text ?? "").trim()))
    .map((item) => ({
      id: String(item.id),
      role: item.role,
      text: item.text,
      createdAt: item.createdAt ?? null,
      turnId: item.turnId ? String(item.turnId) : null,
      streaming: item.role === "assistant" && item.streamState === "streaming",
    }));

  return {
    messages,
    completedTurnIds: Object.keys(state.completedTurnIds),
  };
}
