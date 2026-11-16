import test from "node:test";
import assert from "node:assert/strict";

import { hasRealConversationActivity } from "../src/features/composer/thread-config-lock.ts";

function createConversation(overrides?: Partial<{
  runningTurnId: string | null;
  completedTurnIds: Record<string, true>;
  invalidated: boolean;
}>) {
  return {
    runningTurnId: null,
    completedTurnIds: {},
    invalidated: false,
    ...overrides,
  };
}

test("thread.started alone does not lock a brand-new thread config", () => {
  const locked = hasRealConversationActivity({
    hasRealTurnActivity: false,
    conversation: createConversation(),
  });

  assert.equal(locked, false);
});

test("thread meta events alone do not lock a brand-new thread config", () => {
  const locked = hasRealConversationActivity({
    hasRealTurnActivity: false,
    conversation: createConversation(),
  });

  assert.equal(locked, false);
});

test("real turn activity locks thread config", () => {
  const fromRunningTurn = hasRealConversationActivity({
    hasRealTurnActivity: false,
    conversation: createConversation({ runningTurnId: "turn-1" }),
  });
  const fromCompletedTurn = hasRealConversationActivity({
    hasRealTurnActivity: false,
    conversation: createConversation({ completedTurnIds: { "turn-1": true } }),
  });
  const fromIndexedTurn = hasRealConversationActivity({
    hasRealTurnActivity: true,
    conversation: createConversation(),
  });

  assert.equal(fromRunningTurn, true);
  assert.equal(fromCompletedTurn, true);
  assert.equal(fromIndexedTurn, true);
});

test("bootstrap assistant messages no longer lock thread config without real turns", () => {
  const locked = hasRealConversationActivity({
    hasRealTurnActivity: false,
    conversation: createConversation(),
  });

  assert.equal(locked, false);
});
