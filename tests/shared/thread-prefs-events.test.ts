import test from "node:test";
import assert from "node:assert/strict";

import { replayThreadPrefsFromConversationEvents } from "../../packages/shared/src/utils/threadPrefsEvents.ts";
import type { ConversationEventEnvelope, ThreadPrefs } from "../../packages/shared/src/index.ts";

test("replayThreadPrefsFromConversationEvents restores plan mode from approval events", () => {
  const basePrefs: ThreadPrefs = {
    model: "claude-opus-4-6",
    effort: "high",
    accessMode: "full-access",
    planMode: false,
    roleId: "role.analysis" as any,
  };

  const events: ConversationEventEnvelope[] = [
    {
      schema: 1,
      seq: 10,
      ts: 1_773_747_009_037,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread_demo" as any,
      engine: "claude",
      type: "approval.resolved",
      payload: {
        requestId: "auto_mode_1",
        approved: true,
        nextPlanMode: true,
      },
    },
  ];

  assert.deepEqual(replayThreadPrefsFromConversationEvents(basePrefs, events), {
    model: "claude-opus-4-6",
    effort: "high",
    accessMode: "full-access",
    planMode: true,
    roleId: "role.analysis" as any,
  });
});

test("replayThreadPrefsFromConversationEvents keeps only the latest mode after enter+exit plan", () => {
  const basePrefs: ThreadPrefs = {
    model: "claude-opus-4-6",
    effort: "medium",
    accessMode: "full-access",
    planMode: false,
    roleId: "role.dev" as any,
  };

  const events: ConversationEventEnvelope[] = [
    {
      schema: 1,
      seq: 10,
      ts: 1,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread_demo" as any,
      engine: "claude",
      type: "approval.resolved",
      payload: {
        requestId: "auto_mode_1",
        approved: true,
        nextPlanMode: true,
      },
    },
    {
      schema: 1,
      seq: 11,
      ts: 2,
      workspaceId: "client-a:ws-demo" as any,
      threadId: "thread_demo" as any,
      engine: "claude",
      type: "approval.resolved",
      payload: {
        requestId: "exit_plan_1",
        approved: true,
        nextPlanMode: false,
        nextAccessMode: "current",
      },
    },
  ];

  assert.deepEqual(replayThreadPrefsFromConversationEvents(basePrefs, events), {
    model: "claude-opus-4-6",
    effort: "medium",
    accessMode: "current",
    planMode: false,
    roleId: "role.dev" as any,
  });
});
