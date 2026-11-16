import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openClientDb } from "../src/db/clientDb.js";
import { createRawEventRetentionWorker, type RawEventRetentionPressureSnapshot } from "../src/diagnostics/rawEventRetention.js";

/** 仅控制既有压力输入，不改变Worker分批和自适应策略。 */
function pressure(shouldDefer: boolean): RawEventRetentionPressureSnapshot {
  return { shouldDefer, reasons: shouldDefer ? ["ws_inbound_queued"] : [], inboundMessages: shouldDefer ? 1 : 0,
    inboundBytes: 0, activeHandlers: 0, eventLoopLagMaxMs: 0, eventLoopLagP99Ms: 0 };
}

for (const [phase, original] of [["delete", false], ["pressure", null], ["deferred", undefined], ["resumed", 0], ["complete", ""]] as const) {
  test(`retention ${phase}计时器失败保falsy原值，原owner阻止自动重试并严格关闭`, t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let high = phase === "deferred" || phase === "resumed", deletions = 0;
    const notifications: unknown[] = [];
    const worker = createRawEventRetentionWorker({ deleteBeforeSeq() {
      deletions++; if (phase === "delete") throw original; return 0;
    } }, { batchDelayMs: 0, pressureRetryDelayMs: 5,
      getRuntimePressure() { if (phase === "pressure") throw original; return pressure(high); },
      onDeferred() { if (phase === "deferred") throw original; },
      onResumed() { if (phase === "resumed") throw original; },
      onComplete() { if (phase === "complete") throw original; },
      onError(failure) { notifications.push(failure.error); },
    });
    worker.trigger(100);
    assert.doesNotThrow(() => t.mock.timers.tick(0));
    if (phase === "resumed") { high = false; assert.doesNotThrow(() => t.mock.timers.tick(5)); }
    assert.deepEqual(notifications, [original]); assert.equal(worker.isRunning(), false);
    assert.throws(() => worker.assertNoFailure(), error => Object.is(error, original));
    assert.throws(() => worker.trigger(200), error => Object.is(error, original));
    assert.throws(() => worker.dispose(), error => Object.is(error, original));
    const stoppedCount = deletions; t.mock.timers.tick(60_000); assert.equal(deletions, stoppedCount);
  });
}

test("retention逐批许可在关闭时等待已准入批次并取消未开始删除", async () => {
  let permitted = false, deletions = 0, entered!: () => void, rejectEntered!: (error: unknown) => void, allow!: () => void;
  const acquired = new Promise<void>((resolve, reject) => { entered = resolve; rejectEntered = reject; });
  const gate = new Promise<void>(resolve => { allow = resolve; });
  const worker = createRawEventRetentionWorker({ deleteBeforeSeq() { assert.equal(permitted, true); deletions++; return 0; } }, {
    withLegacyDatabase: async (_requestId: string, operation: () => unknown) => {
      entered(); await gate; permitted = true;
      try { const value = operation(); assert.equal(Boolean((value as any)?.then), false); return value; } finally { permitted = false; }
    },
    onError: failure => rejectEntered(failure.error),
  } as any);
  worker.trigger(100);
  await acquired;
  let disposed = false;
  const closing = Promise.resolve(worker.dispose()).then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, false);
  assert.equal(deletions, 0);
  allow();
  await closing;
  await worker.waitIdle();
  assert.equal(deletions, 0);
  assert.equal(worker.isRunning(), false);
});

test("retention删除耗时不包含异步许可排队，正常完成后waitIdle读取原结果", async () => {
  let clock = 0, measured = -1;
  const worker = createRawEventRetentionWorker({ deleteBeforeSeq() { clock += 7; return 0; } }, {
    now: () => clock,
    withLegacyDatabase: async (_requestId: string, operation: () => unknown) => { clock += 5_000; return operation(); },
    onComplete(result) { measured = result.deleteDurationMs; },
    onError(failure) { throw failure.error; },
  } as any);
  worker.trigger(100);
  await worker.waitIdle();
  assert.equal(measured, 7);
  await worker.dispose();
});

test("retention timer通知再失败保两侧原值，不逃全局也不清空原owner", async () => {
  const original = Object.freeze(new Error("PERSISTENCE_FAILED")), notification = undefined;
  let notify!: () => void;
  const notified = new Promise<void>(resolve => { notify = resolve; });
  const worker = createRawEventRetentionWorker({ deleteBeforeSeq() { throw original; } }, {
    batchDelayMs: 0, onError() { notify(); throw notification; },
  });
  worker.trigger(100);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([notified, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("RETENTION_OWNER_NOT_NOTIFIED")), 2_000); })]); }
  finally { if (timeout) clearTimeout(timeout); }
  let retained: unknown;
  assert.throws(() => worker.assertNoFailure(), error => {
    retained = error; assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [original, notification]);
    assert.equal(error.cause, original); return true;
  });
  assert.throws(() => worker.trigger(200), error => error === retained);
  assert.throws(() => worker.dispose(), error => error === retained);
});

test("真实W删除完成后通知失败不回滚既有删除，其他W事件保持独立", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-retention-log-"));
  const app = openClientDb({ dbPath: path.join(root, "app.db") });
  for (const workspaceId of ["first", "second"]) {
    const directory = path.join(root, workspaceId); fs.mkdirSync(directory);
    app.workspaces.upsert({ id: workspaceId, title: workspaceId, path: directory });
    const db = app.forWorkspace(workspaceId);
    db.threads.create({ id: "thread", workspaceId, engine: "codex", title: "retention" });
    db.rawEvents.appendEnvelope({ schema: 1, seq: 1, ts: 1, workspaceId, threadId: "thread", engine: "codex",
      source: "codex.app-server.msg", data: { method: "turn/started" }, handled: true, action: "mapped", emittedTypes: [] });
  }
  const original = new Error("RETENTION_COMPLETE_NOTIFICATION_FAILED"), errors: unknown[] = [];
  const worker = createRawEventRetentionWorker(app.forWorkspace("first").rawEvents, {
    batchDelayMs: 0, onComplete() { throw original; }, onError(failure) { errors.push(failure.error); },
  });
  try {
    worker.trigger(2); assert.doesNotThrow(() => t.mock.timers.tick(0));
    assert.equal(app.forWorkspace("first").rawEvents.pageByThread("thread", { limit: 10 }).events.length, 0);
    assert.equal(app.forWorkspace("second").rawEvents.pageByThread("thread", { limit: 10 }).events.length, 1);
    assert.deepEqual(errors, [original]); assert.throws(() => worker.dispose(), error => error === original);
  } finally { app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
