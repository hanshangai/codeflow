import type { ConversationEventInput, TurnId } from "@codeflowai/shared";

import type { ConversationEmitFn, ThreadEngineSession } from "./threadSession.js";

export async function emitTurnTerminalWithAssistantReconcile(input: {
  session: ThreadEngineSession | null;
  turnId: TurnId;
  outcome: "completed" | "error";
  emitConversation: ConversationEmitFn;
  buildTerminalEvent: (latestAssistantText: string | null) => ConversationEventInput;
}): Promise<void> {
  const reconciled = input.session
    ? await input.session.prepareAssistantTerminalEvents({
      turnId: input.turnId,
      outcome: input.outcome,
    })
    : { events: [], latestAssistantText: null };

  for (const event of reconciled.events) {
    input.emitConversation(event);
  }
  input.emitConversation(input.buildTerminalEvent(reconciled.latestAssistantText));
}
