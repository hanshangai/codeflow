import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { createRawEventAckBuffer } from "../../apps/desktop/client/src/diagnostics/rawEventAckBuffer.ts";
import {
  createRawEventRetentionWorker,
  type RawEventRetentionRunFailure,
  type RawEventRetentionRunResult,
} from "../../apps/desktop/client/src/diagnostics/rawEventRetention.ts";

/** 构造 ACK buffer 测试使用的最小 raw event。 */
function buildRawEvent(seq = 1): any {
  return {
    schema: 1,
    seq,
    ts: seq,
    workspaceId: "ws-raw-strict",
    threadId: "thread-raw-strict",
    engine: "codex",
    source: "codex.app-server.msg",
    data: { method: "turn/started", params: { turn: { id: `provider-${seq}` } } },
    handled: true,
    action: "mapped",
    emittedTypes: [],
  };
}

/** 保留应用注册入口，故障和读取都固定真实W库。 */
function createFailureFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-raw-ack-failure-"));
  const app = openClientDb({ dbPath: path.join(root, "client.db") });
  app.workspaces.upsert({ id: "ws-raw-strict", title: "tmp", path: root });
  const db = app.forWorkspace("ws-raw-strict");
  db.threads.create({ id: "thread-raw-strict", workspaceId: "ws-raw-strict", engine: "codex", title: "tmp" });
  t.after(() => { app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, db };
}

test("raw event ack buffer flushes queued events in batches", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-raw-ack-buffer-"));
  const app = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const workspaceId = "ws-raw-ack" as any;
    const threadId = "thread-raw-ack" as any;
    app.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    const db = app.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "claude", title: "tmp" });

    const buffer = createRawEventAckBuffer(db, { maxBatchSize: 3, flushDelayMs: 10 });
    for (let i = 1; i <= 5; i += 1) {
      buffer.enqueue({
        schema: 1,
        seq: i,
        ts: Date.now(),
        workspaceId,
        threadId,
        engine: "claude",
        source: "claude.stream-json.stdout",
        data: { idx: i },
        handled: true,
        action: "mapped",
        emittedTypes: [],
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 40));
    buffer.flush();

    const page = db.rawEvents.pageByThread(threadId, { limit: 10 });
    assert.equal(page.events.length, 5);
    assert.deepEqual(
      page.events.map((event) => event.seq).sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
    );
  } finally {
    app.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("raw event ack buffer dispose drains queued events immediately", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-raw-ack-buffer-dispose-"));
  const app = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const workspaceId = "ws-raw-ack-dispose" as any;
    const threadId = "thread-raw-ack-dispose" as any;
    app.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    const db = app.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "claude", title: "tmp" });

    const buffer = createRawEventAckBuffer(db, { maxBatchSize: 3, flushDelayMs: 10_000 });
    for (let i = 1; i <= 5; i += 1) {
      buffer.enqueue({
        schema: 1,
        seq: i,
        ts: Date.now(),
        workspaceId,
        threadId,
        engine: "claude",
        source: "claude.stream-json.stdout",
        data: { idx: i },
        handled: true,
        action: "mapped",
        emittedTypes: [],
      });
    }

    buffer.dispose();

    const page = db.rawEvents.pageByThread(threadId, { limit: 10 });
    assert.equal(page.events.length, 5);
    assert.equal(buffer.getPendingCount(), 0);
  } finally {
    app.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("raw event ack buffer persists 10746 unique seqs without duplicate rows", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-raw-ack-stress-"));
  const app = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const workspaceId = "ws-raw-ack-stress" as any;
    const threadId = "thread-raw-ack-stress" as any;
    app.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    const db = app.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "tmp" });

    const count = 10_746;
    const buffer = createRawEventAckBuffer(db, { maxBatchSize: 200, flushDelayMs: 10_000 });
    for (let seq = 1; seq <= count; seq += 1) {
      buffer.enqueue({ ...buildRawEvent(seq), workspaceId, threadId });
    }
    for (let seq = 1; seq <= 100; seq += 1) {
      buffer.enqueue({ ...buildRawEvent(seq), workspaceId, threadId });
    }
    while (buffer.getPendingCount() > 0) buffer.flush();

    const persistedSeqs: number[] = [];
    let beforeSeq: number | null = null;
    do {
      const page = db.rawEvents.pageByThread(threadId, { beforeSeq, limit: 2_000 });
      persistedSeqs.push(...page.events.map((event) => Number(event.seq)));
      beforeSeq = page.nextBeforeSeq;
    } while (beforeSeq != null);
    persistedSeqs.sort((left, right) => left - right);
    assert.equal(persistedSeqs.length, count);
    assert.deepEqual(persistedSeqs, Array.from({ length: count }, (_, index) => index + 1));
    assert.equal(buffer.getPendingCount(), 0);
    buffer.dispose();
  } finally {
    app.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("raw event ack buffer strict flush retains batch failure without single fallback", t => {
  const f = createFailureFixture(t), original = new Error("raw batch failed");
  const batch = t.mock.method(f.db.rawEvents, "appendEnvelopes", () => { throw original; });
  const single = t.mock.method(f.db.rawEvents, "appendEnvelope", () => { assert.fail("不得逐条补写"); });
  const buffer = createRawEventAckBuffer(f.app, { flushDelayMs: 10_000 });
  buffer.enqueue(buildRawEvent());

  assert.throws(() => buffer.flush(), error => (error as Error).cause === original);
  assert.equal(single.mock.callCount(), 0); assert.equal(buffer.getPendingCount(), 1);
  assert.throws(() => buffer.dispose(), error => (error as Error).cause === original);
  batch.mock.restore(); single.mock.restore();
  buffer.dispose();
  assert.equal(f.db.rawEvents.pageByThread("thread-raw-strict", { limit: 10 }).events.length, 1);
});

test("raw event ack buffer strict flush preserves persistence and diagnostic failures for retry", t => {
  const f = createFailureFixture(t), original = new Error("raw batch failed"), logging = undefined;
  const batch = t.mock.method(f.db.rawEvents, "appendEnvelopes", () => { throw original; });
  const writer = t.mock.method(f.app, "writeWorkspaceLog", () => { throw logging; });
  const buffer = createRawEventAckBuffer(f.app, { flushDelayMs: 10_000 });
  buffer.enqueue(buildRawEvent());

  assert.throws(
    () => buffer.flush(),
    (error: unknown) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === logging,
  );
  assert.equal(buffer.getPendingCount(), 1);

  batch.mock.restore(); writer.mock.restore();
  buffer.flush();
  assert.deepEqual(f.db.rawEvents.pageByThread("thread-raw-strict", { limit: 10 }).events.map(event => event.seq), [1]);
  assert.equal(buffer.getPendingCount(), 0);
  buffer.dispose();
});

test("raw event ack buffer background failure remains visible until explicit retry", async t => {
  const f = createFailureFixture(t), original = new Error("raw background batch failed");
  const batch = t.mock.method(f.db.rawEvents, "appendEnvelopes", () => { throw original; });
  const buffer = createRawEventAckBuffer(f.app, { flushDelayMs: 5 });
  buffer.enqueue(buildRawEvent());

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.db.rawEvents.pageByThread("thread-raw-strict", { limit: 10 }).events.length, 0);
  assert.equal(buffer.getPendingCount(), 1);
  assert.throws(() => buffer.assertNoFailure(), error => (error as Error).cause === original);
  batch.mock.restore();
  buffer.dispose();
  assert.equal(buffer.getPendingCount(), 0);
});

test("raw event repo deletes events before sequence cutoff in bounded batches", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-raw-retention-"));
  const app = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const workspaceId = "ws-raw-retention" as any;
    const threadId = "thread-raw-retention" as any;
    app.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    const db = app.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "claude", title: "tmp" });

    db.rawEvents.appendEnvelopes([
      {
        schema: 1,
        seq: 1,
        ts: 1_000,
        workspaceId,
        threadId,
        engine: "claude",
        source: "claude.stream-json.stdout",
        data: { idx: 1 },
        handled: true,
        action: "mapped",
        emittedTypes: [],
      },
      {
        schema: 1,
        seq: 2,
        ts: 2_000,
        workspaceId,
        threadId,
        engine: "claude",
        source: "claude.stream-json.stdout",
        data: { idx: 2 },
        handled: true,
        action: "mapped",
        emittedTypes: [],
      },
      {
        schema: 1,
        seq: 3,
        ts: 3_000,
        workspaceId,
        threadId,
        engine: "claude",
        source: "claude.stream-json.stdout",
        data: { idx: 3 },
        handled: true,
        action: "mapped",
        emittedTypes: [],
      },
    ]);

    assert.equal(db.rawEvents.deleteBeforeSeq(3, 1), 1);
    assert.equal(db.rawEvents.deleteBeforeSeq(3, 1), 1);
    assert.equal(db.rawEvents.deleteBeforeSeq(3, 1), 0);

    const page = db.rawEvents.pageByThread(threadId, { limit: 10 });
    assert.deepEqual(
      page.events.map((event) => event.seq).sort((a, b) => a - b),
      [3],
    );
  } finally {
    app.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("raw event retention worker yields between batches and deduplicates triggers", async () => {
  const calls: Array<{ cutoff: number; limit: number }> = [];
  const deleteCounts = [2, 2, 1];
  let resolveCompletion: (result: RawEventRetentionRunResult) => void = () => {};
  let rejectCompletion: (error: unknown) => void = () => {};
  const completion = new Promise<RawEventRetentionRunResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const worker = createRawEventRetentionWorker(
    {
      deleteBeforeSeq(cutoff: number, limit: number) {
        calls.push({ cutoff, limit });
        return deleteCounts.shift() ?? 0;
      },
    },
    {
      batchSize: 2,
      batchDelayMs: 0,
      onComplete: resolveCompletion,
      onError: (failure) => rejectCompletion(failure.error),
    },
  );

  try {
    assert.equal(worker.trigger(10_000), true);
    assert.equal(worker.trigger(10_000), false);
    assert.equal(calls.length, 0);
    const result = await completion;
    assert.deepEqual(calls, [
      { cutoff: 10_000, limit: 2 },
      { cutoff: 10_000, limit: 2 },
      { cutoff: 10_000, limit: 2 },
    ]);
    assert.equal(result.deletedRows, 5);
    assert.equal(result.batchCount, 3);
    assert.equal(result.configuredBatchSize, 2);
    assert.equal(result.initialBatchSize, 2);
    assert.equal(result.finalBatchSize, 2);
    assert.equal(result.batchSizeAdjustmentCount, 0);
    assert.ok(Number.isFinite(result.deleteDurationMs));
    assert.ok(Number.isFinite(result.maxBatchDeleteDurationMs));
    assert.ok(result.deleteDurationMs >= result.maxBatchDeleteDurationMs);
  } finally {
    worker.dispose();
  }
});

test("raw event retention starts small and adapts the next batch to delete duration", async () => {
  const calls: Array<{ cutoff: number; limit: number }> = [];
  const durations = [100, 5, 5];
  let clock = 0;
  let resolveCompletion: (result: RawEventRetentionRunResult) => void = () => {};
  const completion = new Promise<RawEventRetentionRunResult>((resolve) => {
    resolveCompletion = resolve;
  });
  const worker = createRawEventRetentionWorker(
    {
      deleteBeforeSeq(cutoff: number, limit: number) {
        calls.push({ cutoff, limit });
        clock += durations.shift() ?? 0;
        return calls.length < 3 ? limit : 0;
      },
    },
    {
      batchSize: 100,
      batchDelayMs: 0,
      now: () => clock,
      onComplete: (result) => resolveCompletion(result),
      onError: (failure) => assert.fail(String(failure.error)),
    },
  );

  try {
    worker.trigger(40_000);
    const result = await completion;
    assert.deepEqual(calls, [
      { cutoff: 40_000, limit: 10 },
      { cutoff: 40_000, limit: 2 },
      { cutoff: 40_000, limit: 3 },
    ]);
    assert.equal(result.deletedRows, 12);
    assert.equal(result.configuredBatchSize, 100);
    assert.equal(result.initialBatchSize, 10);
    assert.equal(result.finalBatchSize, 3);
    assert.equal(result.batchSizeAdjustmentCount, 2);
    assert.equal(result.maxBatchDeleteDurationMs, 100);

    const secondCompletion = new Promise<RawEventRetentionRunResult>((resolve) => {
      resolveCompletion = resolve;
    });
    worker.trigger(50_000);
    const secondResult = await secondCompletion;
    assert.deepEqual(calls[3], { cutoff: 50_000, limit: 10 });
    assert.equal(secondResult.initialBatchSize, 10);
    assert.equal(secondResult.finalBatchSize, 10);
  } finally {
    worker.dispose();
  }
});

test("raw event retention does not report an unused adjustment after a partial final batch", async () => {
  let clock = 0;
  let resolveCompletion: (result: RawEventRetentionRunResult) => void = () => {};
  const completion = new Promise<RawEventRetentionRunResult>((resolve) => {
    resolveCompletion = resolve;
  });
  const worker = createRawEventRetentionWorker(
    {
      deleteBeforeSeq() {
        clock += 100;
        return 5;
      },
    },
    {
      batchSize: 100,
      now: () => clock,
      onComplete: resolveCompletion,
      onError: (failure) => assert.fail(String(failure.error)),
    },
  );

  try {
    worker.trigger(60_000);
    const result = await completion;
    assert.equal(result.deletedRows, 5);
    assert.equal(result.initialBatchSize, 10);
    assert.equal(result.finalBatchSize, 10);
    assert.equal(result.batchSizeAdjustmentCount, 0);
    assert.equal(result.maxBatchDeleteDurationMs, 100);
  } finally {
    worker.dispose();
  }
});

test("raw event retention defers under runtime pressure and resumes without changing delete semantics", async () => {
  const calls: number[] = [];
  const transitions: string[] = [];
  let pressureHigh = true;
  let resolveCompletion: (result: RawEventRetentionRunResult) => void = () => {};
  const completion = new Promise<RawEventRetentionRunResult>((resolve) => {
    resolveCompletion = resolve;
  });
  const worker = createRawEventRetentionWorker(
    {
      deleteBeforeSeq(_cutoff: number, _limit: number) {
        calls.push(Date.now());
        return 0;
      },
    },
    {
      batchDelayMs: 0,
      pressureRetryDelayMs: 5,
      getRuntimePressure: () => ({
        shouldDefer: pressureHigh,
        reasons: pressureHigh ? ["ws_inbound_queued"] : [],
        inboundMessages: pressureHigh ? 3 : 0,
        inboundBytes: pressureHigh ? 300 : 0,
        activeHandlers: 0,
        eventLoopLagMaxMs: 0,
        eventLoopLagP99Ms: 0,
      }),
      onDeferred: () => transitions.push("deferred"),
      onResumed: () => transitions.push("resumed"),
      onComplete: resolveCompletion,
      onError: (failure) => assert.fail(String(failure.error)),
    },
  );

  try {
    worker.trigger(30_000);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(calls, []);
    assert.deepEqual(transitions, ["deferred"]);
    pressureHigh = false;
    const result = await completion;
    assert.equal(result.deletedRows, 0);
    assert.equal(result.batchCount, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(transitions, ["deferred", "resumed"]);
  } finally {
    worker.dispose();
  }
});

test("raw event retention worker reports a failed batch and stops the current run", async () => {
  let resolveFailure: (failure: RawEventRetentionRunFailure) => void = () => {};
  const failure = new Promise<RawEventRetentionRunFailure>((resolve) => {
    resolveFailure = resolve;
  });
  const worker = createRawEventRetentionWorker(
    {
      deleteBeforeSeq(_cutoff: number, _limit: number) {
        throw new Error("delete failed");
      },
    },
    {
      batchDelayMs: 0,
      onError: resolveFailure,
    },
  );

  try {
    assert.equal(worker.trigger(20_000), true);
    const result = await failure;
    assert.equal((result.error as Error).message, "delete failed");
    assert.ok(Number.isFinite(result.deleteDurationMs));
    assert.ok(Number.isFinite(result.maxBatchDeleteDurationMs));
    assert.equal(worker.isRunning(), false);
    assert.throws(() => worker.assertNoFailure(), error => error === result.error);
    assert.throws(() => worker.trigger(30_000), error => error === result.error);
  } finally {
    assert.throws(() => worker.dispose(), /delete failed/);
  }
});
