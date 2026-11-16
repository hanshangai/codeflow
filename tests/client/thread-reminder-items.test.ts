import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { handleReminderItemsList } from "../../apps/desktop/client/src/app/handlers/reminderHandlers.ts";

function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-reminder-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openClientDb({ dbPath });

  const workspaceId = "ws-reminder" as WorkspaceId;
  const threadId = "thread-reminder" as ThreadId;
  const turnId = "turn-reminder" as TurnId;

  db.workspaces.upsert({ id: workspaceId, title: "Reminder WS", path: tempDir });
  db.threads.create({
    id: threadId,
    workspaceId,
    engine: "codex",
    title: "Reminder Thread",
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
    turnId,
    getResponse() {
      return response;
    },
    cleanup() {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("interrupted turn states create interrupted status items instead of exception reminders", () => {
  const harness = createHarness();
  try {
    harness.db.threadReminderStates.recordTurnInterrupted({
      threadId: harness.threadId,
      workspaceId: harness.workspaceId,
      turnId: harness.turnId,
      endedAt: Date.now(),
    });

    handleReminderItemsList(harness.ctx, {
      id: "req-1",
      body: { workspaceId: harness.workspaceId },
    } as any);

    const res = harness.getResponse();
    assert.equal(res?.status, 200);
    assert.equal(res?.body?.items?.length, 1);
    assert.equal(res?.body?.items?.[0]?.displayKind, "status");
    assert.equal(res?.body?.items?.[0]?.statusLabel, "已中止");
    assert.equal(res?.body?.items?.[0]?.summary, "本次请求已中止，可继续发送消息。");
    assert.equal(res?.body?.summary?.pendingActionCount, 0);
    assert.equal(res?.body?.summary?.pendingReceiptCount, 0);
  } finally {
    harness.cleanup();
  }
});

test("real turn errors still create exception reminder items", () => {
  const harness = createHarness();
  try {
    harness.db.threadReminderStates.recordTurnError({
      threadId: harness.threadId,
      workspaceId: harness.workspaceId,
      turnId: harness.turnId,
      endedAt: Date.now(),
    });

    handleReminderItemsList(harness.ctx, {
      id: "req-2",
      body: { workspaceId: harness.workspaceId },
    } as any);

    const res = harness.getResponse();
    assert.equal(res?.status, 200);
    assert.equal(res?.body?.items?.length, 1);
    assert.equal(res?.body?.items?.[0]?.displayKind, "action");
    assert.equal(res?.body?.items?.[0]?.statusLabel, "异常");
    assert.equal(res?.body?.items?.[0]?.summary, "会话已异常结束，建议先查看上下文。");
    assert.equal(res?.body?.summary?.pendingActionCount, 1);
  } finally {
    harness.cleanup();
  }
});

test("orchestration node completed turns do not create chat receipt items", () => {
  const harness = createHarness();
  try {
    const orchestrationThreadId = "orch-node-reminder" as ThreadId;
    harness.db.threads.create({
      id: orchestrationThreadId,
      workspaceId: harness.workspaceId,
      engine: "codex",
      title: "[编排] UI/UX设计师（UI） - CodeFlow 标准功能开发",
      threadType: "orchestration",
      threadSubtype: "node",
    });
    harness.db.threadReminderStates.recordTurnCompleted({
      threadId: orchestrationThreadId,
      workspaceId: harness.workspaceId,
      turnId: "turn-orch-node" as TurnId,
      completedAt: Date.now(),
    });

    handleReminderItemsList(harness.ctx, {
      id: "req-orch-node",
      body: { workspaceId: harness.workspaceId },
    } as any);

    const res = harness.getResponse();
    assert.equal(res?.status, 200);
    assert.deepEqual(res?.body?.items ?? [], []);
  } finally {
    harness.cleanup();
  }
});
