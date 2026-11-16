import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { handleReminderIgnoreItems, handleReminderItemsList } from "../../apps/desktop/client/src/app/handlers/reminderHandlers.ts";

function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-reminder-ignore-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openClientDb({ dbPath });

  const workspaceId = "ws-reminder-ignore" as WorkspaceId;
  const threadId = "thread-reminder-ignore" as ThreadId;

  db.workspaces.upsert({ id: workspaceId, title: "Reminder Ignore WS", path: tempDir });
  db.threads.create({
    id: threadId,
    workspaceId,
    engine: "codex",
    title: "Reminder Ignore Thread",
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
    listItems() {
      handleReminderItemsList(ctx, {
        id: "req-list",
        body: { workspaceId },
      } as any);
      return this.getResponse()?.body?.items ?? [];
    },
    ignoreItems(items: Array<{ reminderId: string; ignoreMarker: string }>) {
      handleReminderIgnoreItems(ctx, {
        id: "req-ignore",
        body: { workspaceId, items },
      } as any);
      return this.getResponse()?.body ?? null;
    },
    cleanup() {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("ignored action reminder stays hidden until the attention marker changes", () => {
  const harness = createHarness();
  try {
    harness.db.threadReminderStates.setAttention({
      threadId: harness.threadId,
      workspaceId: harness.workspaceId,
      attentionKind: "user_input",
      attentionRequestId: "req-1",
      updatedAt: 1_000,
    });

    const initialItems = harness.listItems();
    assert.equal(initialItems.length, 1);
    assert.equal(initialItems[0]?.statusLabel, "待补充");

    const ignoreResult = harness.ignoreItems([
      {
        reminderId: initialItems[0].id,
        ignoreMarker: initialItems[0].ignoreMarker,
      },
    ]);
    assert.deepEqual(ignoreResult?.ignoredIds, [initialItems[0].id]);
    assert.deepEqual(harness.listItems(), []);

    harness.db.threadReminderStates.setAttention({
      threadId: harness.threadId,
      workspaceId: harness.workspaceId,
      attentionKind: "user_input",
      attentionRequestId: "req-1",
      updatedAt: 1_001,
    });
    assert.deepEqual(harness.listItems(), []);

    harness.db.threadReminderStates.setAttention({
      threadId: harness.threadId,
      workspaceId: harness.workspaceId,
      attentionKind: "user_input",
      attentionRequestId: "req-2",
      updatedAt: 1_002,
    });
    const nextItems = harness.listItems();
    assert.equal(nextItems.length, 1);
    assert.notEqual(nextItems[0]?.ignoreMarker, initialItems[0]?.ignoreMarker);
  } finally {
    harness.cleanup();
  }
});

test("batch ignore marks receipt reminders read and ignores stale markers", () => {
  const harness = createHarness();
  try {
    harness.db.threadReminderStates.recordTurnCompleted({
      threadId: harness.threadId,
      workspaceId: harness.workspaceId,
      turnId: "turn-1" as TurnId,
      completedAt: 2_000,
    });

    const initialItems = harness.listItems();
    assert.equal(initialItems.length, 1);
    assert.equal(initialItems[0]?.displayKind, "receipt");

    const ignoreResult = harness.ignoreItems([
      {
        reminderId: initialItems[0].id,
        ignoreMarker: `${initialItems[0].ignoreMarker}-stale`,
      },
      {
        reminderId: initialItems[0].id,
        ignoreMarker: initialItems[0].ignoreMarker,
      },
    ]);
    assert.deepEqual(ignoreResult?.ignoredIds, [initialItems[0].id]);
    assert.deepEqual(harness.listItems(), []);

    harness.db.threadReminderStates.recordTurnCompleted({
      threadId: harness.threadId,
      workspaceId: harness.workspaceId,
      turnId: "turn-2" as TurnId,
      completedAt: 2_100,
    });
    const nextItems = harness.listItems();
    assert.equal(nextItems.length, 1);
    assert.equal(nextItems[0]?.ignoreMarker, "turn-2");
  } finally {
    harness.cleanup();
  }
});
