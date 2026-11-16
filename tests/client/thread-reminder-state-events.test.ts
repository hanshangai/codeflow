import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConversationEventEnvelope, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { MANUAL_TURN_INTERRUPT_CODE } from "../../packages/shared/src/index.ts";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { applyThreadReminderStateEvent } from "../../apps/desktop/client/src/eventIndex/threadReminderStateEvents.ts";
import { handleReminderItemsList } from "../../apps/desktop/client/src/app/handlers/reminderHandlers.ts";

function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-reminder-events-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openClientDb({ dbPath });

  const workspaceId = "ws-reminder-events" as WorkspaceId;
  const threadId = "thread-reminder-events" as ThreadId;
  db.workspaces.upsert({ id: workspaceId, title: "Reminder Events WS", path: tempDir });
  db.threads.create({
    id: threadId,
    workspaceId,
    engine: "codex",
    title: "Reminder Events Thread",
  });

  let response: any = null;
  const ctx = {
    db,
    workspaces: new Map([[workspaceId, tempDir]]),
    send(message: unknown) {
      response = message;
    },
  } as any;

  return {
    db,
    ctx,
    workspaceId,
    threadId,
    getResponse() {
      return response;
    },
    cleanup() {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function createTurnErrorEvent(input: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  turnId: TurnId;
  error: string;
  code?: string;
}): ConversationEventEnvelope {
  return {
    schema: 1,
    seq: 1,
    ts: Date.now(),
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    engine: "codex",
    type: "turn.error",
    payload: {
      turnId: input.turnId,
      error: input.error,
      code: input.code,
    },
  } as ConversationEventEnvelope;
}

test("manual interrupt turn.error writes interrupted reminder state", () => {
  const harness = createHarness();
  try {
    const changed = applyThreadReminderStateEvent(harness.db, createTurnErrorEvent({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      turnId: "turn-manual" as TurnId,
      error: "turn interrupted",
      code: MANUAL_TURN_INTERRUPT_CODE,
    }));
    assert.equal(changed, true);

    const state = harness.db.threadReminderStates.get(harness.threadId);
    assert.equal(state?.latestCompletedStatus, "interrupted");

    handleReminderItemsList(harness.ctx, {
      id: "req-manual",
      body: { workspaceId: harness.workspaceId },
    } as any);
    const res = harness.getResponse();
    assert.equal(res?.body?.items?.[0]?.statusLabel, "已中止");
  } finally {
    harness.cleanup();
  }
});

test("restart cleanup turn.error does not create interrupted reminder items", () => {
  const harness = createHarness();
  try {
    const changed = applyThreadReminderStateEvent(harness.db, createTurnErrorEvent({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      turnId: "turn-restart" as TurnId,
      error: "CodeFlow 重启后确认上一条未完成请求已经中止；当前会话仍可继续发送消息。",
      code: "codex_interrupted",
    }));
    assert.equal(changed, false);

    const state = harness.db.threadReminderStates.get(harness.threadId);
    assert.equal(state?.latestCompletedStatus, "transient_cleanup");

    handleReminderItemsList(harness.ctx, {
      id: "req-restart",
      body: { workspaceId: harness.workspaceId },
    } as any);
    const res = harness.getResponse();
    assert.deepEqual(res?.body?.items ?? [], []);
  } finally {
    harness.cleanup();
  }
});
