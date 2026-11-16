import type { ThreadConversationState } from "../chat/chatTypes";

type ThreadConfigLockInput = {
  hasRealTurnActivity: boolean;
  conversation: Pick<ThreadConversationState, "runningTurnId" | "completedTurnIds" | "invalidated"> | null | undefined;
};

export function hasRealConversationActivity(input: ThreadConfigLockInput): boolean {
  if (input.hasRealTurnActivity) return true;
  const conversation = input.conversation;
  if (conversation?.runningTurnId) return true;
  if (Object.keys(conversation?.completedTurnIds ?? {}).length > 0) return true;
  if (conversation?.invalidated) return true;
  return false;
}
