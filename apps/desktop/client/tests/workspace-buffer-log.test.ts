import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ConversationEventEnvelope, RawEngineEventEnvelope, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { createConversationEventAckBuffer } from "../src/diagnostics/conversationEventAckBuffer.js";
import { createRawEventAckBuffer } from "../src/diagnostics/rawEventAckBuffer.js";
import { createThreadTouchBuffer } from "../src/diagnostics/threadTouchBuffer.js";
import { logger } from "../src/logger.js";

/** 真W库和原分组事务；只替换会失败的持久化边界。 */
function fixture(t: test.TestContext, kind: "canonical" | "raw" | "touch", onError?: (error: unknown) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-buffer-log-"));
  const app = openClientDb({ dbPath: path.join(root, "app.db") }), workspaceId = "buffer:workspace" as WorkspaceId, threadId = "thread" as ThreadId;
  const directory = path.join(root, "workspace"); fs.mkdirSync(directory);
  app.workspaces.upsert({ id: workspaceId, title: "buffer", path: directory });
  const db = app.forWorkspace(workspaceId);
  db.threads.create({ id: threadId, workspaceId, title: "buffer", engine: "codex" });
  const options = { flushDelayMs: onError ? 5 : 60_000, onError };
  const buffer = kind === "canonical" ? createConversationEventAckBuffer(app, options)
    : kind === "raw" ? createRawEventAckBuffer(app, options) : createThreadTouchBuffer(app, options);
  const original = kind === "touch" ? db.threads : kind === "canonical" ? db.conversationEvents : db.rawEvents;
  const method = kind === "touch" ? "touchMany" : "appendEnvelopes";
  t.after(() => { t.mock.restoreAll(); buffer.dispose(); app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, db, buffer, workspaceId, threadId,
    enqueue() {
      if (kind === "touch") (buffer as ReturnType<typeof createThreadTouchBuffer>).enqueue(threadId, 1000, { workspaceId });
      else (buffer as ReturnType<typeof createConversationEventAckBuffer>).enqueue({ schema: 1, seq: 100, ts: 100, workspaceId, threadId,
        engine: "codex", type: "turn.started", payload: { turnId: "turn" as TurnId } } as ConversationEventEnvelope & RawEngineEventEnvelope);
    },
    fail(cause: unknown) { return t.mock.method(original as any, method, () => { throw cause; }); },
    logs() { return fs.readdirSync(path.join(directory, ".codeflowai")).filter(name => /^client-\d{8}\.[1-9]\d*\.log$/.test(name))
      .flatMap(name => fs.readFileSync(path.join(directory, ".codeflowai", name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); },
  };
}

for (const kind of ["canonical", "raw", "touch"] as const) {
  test(`${kind}分组失败只落所属W并保原falsy拒绝，队列显式重试恢复`, t => {
    const f = fixture(t, kind), business = false, appLog = t.mock.method(logger, "error", () => {});
    const failure = f.fail(business); f.enqueue();
    let originalFailure: unknown;
    assert.throws(() => f.buffer.flush(), error => {
      originalFailure = error; return (error as Error).cause === business;
    });
    assert.equal(f.buffer.isFailure(originalFailure), true);
    assert.equal(f.buffer.isFailure(new Error((originalFailure as Error).message)), false);
    assert.equal(f.logs().length, 1); assert.equal(f.logs()[0].workspaceId, f.workspaceId);
    assert.equal(appLog.mock.callCount(), 0); assert.equal(f.buffer.getPendingCount(), 1);
    assert.doesNotThrow(() => f.buffer.assertNoFailure("other-workspace" as WorkspaceId));
    assert.throws(() => f.buffer.assertNoFailure(), error => (error as Error).cause === business);
    failure.mock.restore(); f.buffer.flush(); assert.equal(f.buffer.getPendingCount(), 0);
    assert.doesNotThrow(() => f.buffer.assertNoFailure());
    assert.equal(f.buffer.isFailure(originalFailure), false);
  });

  test(`${kind}持久化与W日志双错保原顺序，timer通知失败不覆盖原记录`, async t => {
    const business = new Error("PRIVATE_EVENT_BODY"), logging = undefined, notify = null;
    let notified!: (error: unknown) => void;
    const called = new Promise<unknown>(resolve => { notified = resolve; });
    const f = fixture(t, kind, error => { notified(error); throw notify; });
    f.fail(business); t.mock.method(f.app, "writeWorkspaceLog", () => { throw logging; }); f.enqueue();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let failure: unknown;
    try { failure = await Promise.race([called, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("BUFFER_OWNER_NOT_NOTIFIED")), 2_000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
    assert.ok(failure instanceof AggregateError); assert.deepEqual(failure.errors, [business, logging]);
    assert.doesNotThrow(() => f.buffer.assertNoFailure("other-workspace" as WorkspaceId));
    assert.throws(() => f.buffer.assertNoFailure(), error => {
      assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [failure, notify]);
      assert.equal(f.buffer.isFailure(error), true); assert.equal(f.buffer.isFailure(failure), false); return true;
    });
    assert.equal(f.buffer.getPendingCount(), 1); assert.equal(f.logs().length, 0);
  });
}
