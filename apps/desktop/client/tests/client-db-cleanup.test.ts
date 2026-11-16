import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SessionId, ThreadId, WorkspaceId } from "@codeflowai/shared";

import { openClientDb, type ClientDb } from "../src/db/clientDb.ts";
import { ClientDbCleanupError, ClientDbCleanupService } from "../src/db/clientDbCleanupService.ts";
import { resolveThreadWorkflowStateMap } from "../src/app/threadRunningState.ts";

test("client DB cleanup deletes only startup high-water rows and keeps protected large-table data", async () => {
  const harness = createHarness();
  const releases: string[] = [];
  const notices: Array<{ threadId: string; throughSeq: number }> = [];
  let flushCount = 0;
  const service = new ClientDbCleanupService({
    db: harness.db,
    dbPath: harness.dbPath,
    batchSize: 2,
    batchDelayMs: 10,
    flushEventPersistence: () => {
      flushCount += 1;
    },
    beginThreadCleanup: async ({ threadId }) => () => releases.push(String(threadId)),
    onThreadHistoryCleaned: ({ threadId, throughSeq }) => notices.push({ threadId: String(threadId), throughSeq }),
  });

  try {
    seedOldThread(harness.db, "thread-old", 100);
    for (let seq = 1; seq <= 5; seq += 1) insertConversationEvent(harness.db, "thread-old", seq);
    for (let seq = 11; seq <= 15; seq += 1) insertRawEvent(harness.db, "thread-old", seq);
    seedPromptSnapshots(harness.db, "thread-old");
    const orphanBlobId = harness.db.blobs.put(Buffer.from("orphan"), "binary");
    const referencedBlobId = harness.db.blobs.put(Buffer.from("referenced"), "binary");
    referenceBlobFromDraft(harness.db, "thread-old", referencedBlobId);

    const started = service.start({ inactiveBefore: 500, requestId: "request-cleanup-success" });
    assert.equal(started.cleanup.status, "queued");
    const duplicate = service.start({ inactiveBefore: 500, requestId: "request-cleanup-duplicate" });
    assert.equal(duplicate.cleanup.jobId, started.cleanup.jobId);
    assert.throws(
      () => service.start({ inactiveBefore: 600, requestId: "request-cleanup-conflict" }),
      (error) => error instanceof ClientDbCleanupError && error.status === 409,
    );
    assert.equal(flushCount, 1);

    await waitFor(service, (status) => status.phase === "conversation_events" && status.selectedThreadCount === 1);
    insertConversationEvent(harness.db, "thread-old", 100);
    insertRawEvent(harness.db, "thread-old", 101);
    insertPromptSnapshot(harness.db, "prompt-late", "instance-completed", "thread-old");
    const lateBlobId = harness.db.blobs.put(Buffer.from("late-orphan"), "binary");
    seedOldThread(harness.db, "thread-other-write", 1_000);

    const completed = await waitFor(service, (status) => status.status === "completed");
    assert.equal(completed.processedThreadCount, 1);
    assert.equal(completed.skippedThreadCount, 0);
    assert.equal(completed.deletedConversationEventCount, 5);
    assert.equal(completed.deletedRawEngineEventCount, 5);
    assert.equal(completed.deletedPromptSnapshotCount, 3);
    assert.equal(completed.deletedFileBlobCount, 1);
    assert.equal(completed.deletedFileBlobBytes, Buffer.byteLength("orphan"));
    assert.ok(completed.batchCount >= 8);
    assert.ok(completed.reusableBytesBefore != null);
    assert.ok(completed.reusableBytesAfter != null);
    assert.deepEqual(readSeqs(harness.db, "conversation_events", "thread-old"), [100]);
    assert.deepEqual(readSeqs(harness.db, "raw_engine_events", "thread-old"), [101]);
    assert.deepEqual(readPromptIds(harness.db), ["prompt-late", "prompt-running"]);
    assert.equal(harness.db.blobs.get(orphanBlobId), null);
    assert.ok(harness.db.blobs.get(referencedBlobId));
    assert.ok(harness.db.blobs.get(lateBlobId));
    assert.deepEqual(notices, [{ threadId: "thread-old", throughSeq: 5 }]);
    assert.deepEqual(releases, ["thread-old"]);
    assert.ok(harness.db.threads.get("thread-other-write" as ThreadId));
  } finally {
    service.dispose();
    harness.close();
  }
});

test("client DB cleanup remains running while runtime pressure is high and resumes afterward", async () => {
  const harness = createHarness();
  seedOldThread(harness.db, "thread-pressure", 100);
  insertConversationEvent(harness.db, "thread-pressure", 1);
  let pressureHigh = true;
  let cleanupLeaseCount = 0;
  const service = new ClientDbCleanupService({
    db: harness.db,
    dbPath: harness.dbPath,
    batchSize: 1,
    batchDelayMs: 0,
    pressureRetryDelayMs: 5,
    getRuntimePressure: () => ({
      shouldDefer: pressureHigh,
      reasons: pressureHigh ? ["ws_handler_active"] : [],
      inboundMessages: 0,
      inboundBytes: 0,
      activeHandlers: pressureHigh ? 1 : 0,
      eventLoopLagMaxMs: 0,
      eventLoopLagP99Ms: 0,
    }),
    flushEventPersistence: () => {},
    beginThreadCleanup: async () => {
      cleanupLeaseCount += 1;
      return () => {};
    },
    onThreadHistoryCleaned: () => {},
  });

  try {
    service.start({ inactiveBefore: 500, requestId: "request-cleanup-pressure" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const deferred = service.getStorageSummary().cleanup;
    assert.equal(deferred.status, "running");
    assert.equal(deferred.batchCount, 0);
    assert.equal(cleanupLeaseCount, 0);
    assert.deepEqual(readSeqs(harness.db, "conversation_events", "thread-pressure"), [1]);

    pressureHigh = false;
    const completed = await waitFor(service, (status) => status.status === "completed");
    assert.equal(completed.deletedConversationEventCount, 1);
    assert.equal(cleanupLeaseCount, 1);
    assert.deepEqual(readSeqs(harness.db, "conversation_events", "thread-pressure"), []);
  } finally {
    service.dispose();
    harness.close();
  }
});

test("client DB cleanup skips a thread when its cleanup lease is unavailable", async () => {
  const harness = createHarness();
  seedOldThread(harness.db, "thread-busy", 100);
  insertConversationEvent(harness.db, "thread-busy", 1);
  seedPromptSnapshots(harness.db, "thread-busy");
  const service = new ClientDbCleanupService({
    db: harness.db,
    dbPath: harness.dbPath,
    batchSize: 1,
    batchDelayMs: 0,
    flushEventPersistence: () => {},
    beginThreadCleanup: async () => null,
    onThreadHistoryCleaned: () => {
      throw new Error("skipped thread must not emit history cleanup");
    },
  });

  try {
    service.start({ inactiveBefore: 500, requestId: "request-cleanup-skip" });
    const completed = await waitFor(service, (status) => status.status === "completed");
    assert.equal(completed.selectedThreadCount, 1);
    assert.equal(completed.processedThreadCount, 0);
    assert.equal(completed.skippedThreadCount, 1);
    assert.equal(completed.deletedPromptSnapshotCount, 0);
    assert.deepEqual(readSeqs(harness.db, "conversation_events", "thread-busy"), [1]);
    assert.deepEqual(readPromptIds(harness.db), [
      "prompt-cancelled",
      "prompt-completed",
      "prompt-failed",
      "prompt-running",
    ]);
  } finally {
    service.dispose();
    harness.close();
  }
});

test("client DB cleanup skips a target that becomes active before lease-side revalidation", async () => {
  const harness = createHarness();
  const threadId = "thread-recent-before-lease" as ThreadId;
  seedOldThread(harness.db, threadId, 100);
  insertConversationEvent(harness.db, threadId, 1);
  let releaseCount = 0;
  const service = new ClientDbCleanupService({
    db: harness.db,
    dbPath: harness.dbPath,
    batchSize: 1,
    batchDelayMs: 0,
    flushEventPersistence: () => {},
    beginThreadCleanup: async (target, inactiveBefore) => {
      harness.db.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(inactiveBefore, target.threadId);
      const release = () => {
        releaseCount += 1;
      };
      if (!harness.db.threads.isHistoryCleanupTargetEligible({
        threadId: target.threadId,
        workspaceId: target.workspaceId,
        inactiveBefore,
      })) {
        release();
        return null;
      }
      return release;
    },
    onThreadHistoryCleaned: () => {
      throw new Error("revalidated target must not emit history cleanup");
    },
  });

  try {
    service.start({ inactiveBefore: 500, requestId: "request-cleanup-revalidate" });
    const completed = await waitFor(service, (status) => status.status === "completed");
    assert.equal(completed.selectedThreadCount, 1);
    assert.equal(completed.processedThreadCount, 0);
    assert.equal(completed.skippedThreadCount, 1);
    assert.equal(releaseCount, 1);
    assert.deepEqual(readSeqs(harness.db, "conversation_events", threadId), [1]);
  } finally {
    service.dispose();
    harness.close();
  }
});

test("client DB cleanup fails once, stops scheduling, and releases the thread lease", async () => {
  const harness = createHarness();
  seedOldThread(harness.db, "thread-failure", 100);
  insertConversationEvent(harness.db, "thread-failure", 1);
  let releaseCount = 0;
  const originalDelete = harness.db.conversationEvents.deleteByThreadThroughSeq.bind(harness.db.conversationEvents);
  (harness.db.conversationEvents as any).deleteByThreadThroughSeq = () => {
    throw new Error("injected cleanup batch failure");
  };
  const service = new ClientDbCleanupService({
    db: harness.db,
    dbPath: harness.dbPath,
    batchSize: 1,
    batchDelayMs: 0,
    flushEventPersistence: () => {},
    beginThreadCleanup: async () => () => {
      releaseCount += 1;
    },
    onThreadHistoryCleaned: () => {},
  });

  try {
    service.start({ inactiveBefore: 500, requestId: "request-cleanup-failure" });
    const failed = await waitFor(service, (status) => status.status === "failed");
    assert.equal(failed.phase, "conversation_events");
    assert.equal(failed.currentThreadId, "thread-failure");
    assert.match(failed.error ?? "", /injected cleanup batch failure/);
    assert.equal(failed.batchCount, 0);
    assert.equal(releaseCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(service.getStorageSummary().cleanup.batchCount, 0);
    assert.deepEqual(readSeqs(harness.db, "conversation_events", "thread-failure"), [1]);
  } finally {
    (harness.db.conversationEvents as any).deleteByThreadThroughSeq = originalDelete;
    service.dispose();
    harness.close();
  }
});

test("client DB cleanup dispose cancels the active job and releases its lease", async () => {
  const harness = createHarness();
  seedOldThread(harness.db, "thread-cancel", 100);
  for (let seq = 1; seq <= 10; seq += 1) insertConversationEvent(harness.db, "thread-cancel", seq);
  let releaseCount = 0;
  const service = new ClientDbCleanupService({
    db: harness.db,
    dbPath: harness.dbPath,
    batchSize: 1,
    batchDelayMs: 50,
    flushEventPersistence: () => {},
    beginThreadCleanup: async () => () => {
      releaseCount += 1;
    },
    onThreadHistoryCleaned: () => {},
  });

  try {
    service.start({ inactiveBefore: 500, requestId: "request-cleanup-cancel" });
    await waitFor(service, (status) => status.currentThreadId === "thread-cancel");
    service.dispose();
    const cancelled = service.getStorageSummary().cleanup;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.phase, null);
    assert.equal(releaseCount, 1);
    assert.ok(readSeqs(harness.db, "conversation_events", "thread-cancel").length > 0);
  } finally {
    service.dispose();
    harness.close();
  }
});

test("client DB cleanup rejects a non-past cutoff before flushing or scheduling", () => {
  const harness = createHarness();
  let flushCount = 0;
  const service = new ClientDbCleanupService({
    db: harness.db,
    dbPath: harness.dbPath,
    flushEventPersistence: () => {
      flushCount += 1;
    },
    beginThreadCleanup: async () => () => {},
    onThreadHistoryCleaned: () => {},
  });

  try {
    assert.throws(() => service.start({ inactiveBefore: Date.now() + 60_000 }), /inactiveBefore/);
    assert.throws(
      () => service.start({ inactiveBefore: String(Date.now() - 60_000) as unknown as number }),
      /inactiveBefore/,
    );
    assert.equal(flushCount, 0);
    assert.equal(service.getStorageSummary().cleanup.status, "idle");
  } finally {
    service.dispose();
    harness.close();
  }
});

test("thread cleanup can clear a session binding without changing historical activity", () => {
  const harness = createHarness();
  try {
    seedOldThread(harness.db, "thread-preserve-activity", 100);
    harness.db.threads.setSessionId("thread-preserve-activity" as ThreadId, "session-old" as SessionId);
    harness.db.db.prepare("UPDATE threads SET updated_at = 100 WHERE id = ?").run("thread-preserve-activity");

    harness.db.threads.clearSessionId("thread-preserve-activity" as ThreadId, { preserveUpdatedAt: true });

    const thread = harness.db.threads.get("thread-preserve-activity" as ThreadId);
    assert.equal(thread?.sessionId, null);
    assert.equal(thread?.updatedAt, 100);
  } finally {
    harness.close();
  }
});

test("thread cleanup target paging clamps pages to 50 and advances a zero timestamp cursor", () => {
  const harness = createHarness();
  try {
    for (let index = 0; index < 60; index += 1) {
      seedOldThread(harness.db, `thread-zero-${String(index).padStart(2, "0")}`, 0);
    }
    const first = harness.db.threads.listHistoryCleanupTargetPage({ inactiveBefore: 500, limit: 500 });
    assert.equal(first.items.length, 50);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor?.updatedAt, 0);

    const second = harness.db.threads.listHistoryCleanupTargetPage({
      inactiveBefore: 500,
      cursor: first.nextCursor,
      limit: 500,
    });
    assert.equal(second.items.length, 10);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.items, ...second.items].map((item) => String(item.threadId))).size, 60);
  } finally {
    harness.close();
  }
});

test("thread cleanup target eligibility rechecks strict cutoff and workspace", () => {
  const harness = createHarness();
  try {
    const threadId = "thread-revalidate" as ThreadId;
    seedOldThread(harness.db, threadId, 100);
    assert.equal(harness.db.threads.isHistoryCleanupTargetEligible({
      threadId,
      workspaceId: "workspace-cleanup" as WorkspaceId,
      inactiveBefore: 500,
    }), true);

    harness.db.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(500, threadId);
    assert.equal(harness.db.threads.isHistoryCleanupTargetEligible({
      threadId,
      workspaceId: "workspace-cleanup" as WorkspaceId,
      inactiveBefore: 500,
    }), false);
    assert.equal(harness.db.threads.isHistoryCleanupTargetEligible({
      threadId,
      workspaceId: "workspace-other" as WorkspaceId,
      inactiveBefore: 600,
    }), false);
  } finally {
    harness.close();
  }
});

test("client DB cleanup pages all old threads including no-event threads before eligible prompt cleanup", async () => {
  const harness = createHarness();
  const leasedThreadIds = new Set<string>();
  for (let index = 0; index < 51; index += 1) {
    seedOldThread(harness.db, `thread-page-${String(index).padStart(2, "0")}`, 0);
  }
  seedPromptSnapshots(harness.db, "thread-page-50");
  const service = new ClientDbCleanupService({
    db: harness.db,
    dbPath: harness.dbPath,
    batchSize: 10,
    batchDelayMs: 0,
    flushEventPersistence: () => {},
    beginThreadCleanup: async ({ threadId }) => {
      leasedThreadIds.add(String(threadId));
      return () => {};
    },
    onThreadHistoryCleaned: () => {},
  });

  try {
    service.start({ inactiveBefore: 500, requestId: "request-cleanup-pages" });
    const completed = await waitFor(service, (status) => status.status === "completed");
    assert.equal(completed.selectedThreadCount, 51);
    assert.equal(completed.processedThreadCount, 51);
    assert.equal(completed.skippedThreadCount, 0);
    assert.equal(leasedThreadIds.size, 51);
    assert.equal(completed.deletedPromptSnapshotCount, 3);
    assert.deepEqual(readPromptIds(harness.db), ["prompt-running"]);
  } finally {
    service.dispose();
    harness.close();
  }
});

test("client DB cleanup releases the lease and retains failure thread context when the callback fails", async () => {
  const harness = createHarness();
  seedOldThread(harness.db, "thread-callback-failure", 100);
  let releaseCount = 0;
  const service = new ClientDbCleanupService({
    db: harness.db,
    dbPath: harness.dbPath,
    batchSize: 1,
    batchDelayMs: 0,
    flushEventPersistence: () => {},
    beginThreadCleanup: async () => () => {
      releaseCount += 1;
    },
    onThreadHistoryCleaned: () => {
      throw new Error("injected history cleanup callback failure");
    },
  });

  try {
    service.start({ inactiveBefore: 500, requestId: "request-cleanup-callback-failure" });
    const failed = await waitFor(service, (status) => status.status === "failed");
    assert.equal(failed.currentThreadId, "thread-callback-failure");
    assert.equal(failed.processedThreadCount, 0);
    assert.equal(releaseCount, 1);
    assert.match(failed.error ?? "", /callback failure/);
  } finally {
    service.dispose();
    harness.close();
  }
});

test("client DB cleanup immediately releases a lease that resolves after dispose", async () => {
  const harness = createHarness();
  seedOldThread(harness.db, "thread-late-lease", 100);
  insertConversationEvent(harness.db, "thread-late-lease", 1);
  let resolveLease: ((release: () => void) => void) | null = null;
  let releaseCount = 0;
  const service = new ClientDbCleanupService({
    db: harness.db,
    dbPath: harness.dbPath,
    batchSize: 1,
    batchDelayMs: 0,
    flushEventPersistence: () => {},
    beginThreadCleanup: async () => new Promise<() => void>((resolve) => {
      resolveLease = resolve;
    }),
    onThreadHistoryCleaned: () => {},
  });

  try {
    service.start({ inactiveBefore: 500, requestId: "request-cleanup-late-lease" });
    await waitFor(service, (status) => status.currentThreadId === "thread-late-lease");
    service.dispose();
    assert.equal(service.getStorageSummary().cleanup.status, "cancelled");
    assert.ok(resolveLease);
    resolveLease(() => {
      releaseCount += 1;
    });
    await waitUntil(() => releaseCount === 1);
    assert.deepEqual(readSeqs(harness.db, "conversation_events", "thread-late-lease"), [1]);
  } finally {
    service.dispose();
    harness.close();
  }
});

test("活跃会话工作流判定与删除门禁同源，且启动中任务归并为等待执行", () => {
  const harness = createHarness();
  try {
    const cases: Array<{ threadId: string; taskState: string; instanceStatus: string | null }> = [
      { threadId: "thread-wf-starting", taskState: "starting", instanceStatus: null },
      { threadId: "thread-wf-pending", taskState: "linked", instanceStatus: "pending" },
      { threadId: "thread-wf-running", taskState: "linked", instanceStatus: "running" },
      { threadId: "thread-wf-paused", taskState: "linked", instanceStatus: "paused" },
      { threadId: "thread-wf-waiting-start", taskState: "linked", instanceStatus: "waiting-start" },
      { threadId: "thread-wf-waiting-approval", taskState: "linked", instanceStatus: "waiting-approval" },
      { threadId: "thread-wf-waiting-feedback", taskState: "linked", instanceStatus: "waiting-feedback" },
      { threadId: "thread-wf-completed", taskState: "linked", instanceStatus: "completed" },
      { threadId: "thread-wf-cancelled", taskState: "linked", instanceStatus: "cancelled" },
      { threadId: "thread-wf-dirty-linked", taskState: "linked", instanceStatus: null },
      { threadId: "thread-wf-recommended", taskState: "recommended", instanceStatus: null },
      { threadId: "thread-wf-dismissed", taskState: "dismissed", instanceStatus: null },
    ];
    const threadIds = cases.map((item) => item.threadId as ThreadId);
    for (const item of cases) {
      seedOldThread(harness.db, item.threadId, 1_000);
      seedChatWorkflowTask(
        harness.db,
        item.threadId,
        item.taskState,
        item.instanceStatus ? seedOrchestrationInstance(harness.db, item.threadId, item.instanceStatus) : null,
      );
    }

    const stateMap = resolveThreadWorkflowStateMap({ db: harness.db }, {
      workspaceId: "workspace-cleanup" as WorkspaceId,
      threads: threadIds.map((id) => ({ id })),
    });
    const activeThreadIds = Object.keys(stateMap).sort();
    assert.deepEqual(activeThreadIds, [
      "thread-wf-paused",
      "thread-wf-pending",
      "thread-wf-running",
      "thread-wf-starting",
      "thread-wf-waiting-approval",
      "thread-wf-waiting-feedback",
      "thread-wf-waiting-start",
    ]);
    // 启动中（实例尚未创建）归并为等待执行；linked 却无实例的脏数据判为不活跃
    assert.equal(stateMap["thread-wf-starting"]?.status, "pending");
    assert.equal(stateMap["thread-wf-dirty-linked"], undefined);

    const blocked = harness.db.threads.getCleanupBusinessBlockedReasons(threadIds);
    assert.deepEqual([...blocked.keys()].sort(), activeThreadIds, "徽标判据必须与删除门禁完全一致");
  } finally {
    harness.close();
  }
});

type Harness = {
  db: ClientDb;
  dbPath: string;
  close: () => void;
};

/** 创建隔离 Client DB，并提供严格清理函数。 */
function createHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-db-cleanup-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openClientDb({ dbPath });
  db.db.prepare(
    "INSERT INTO workspaces (id, title, path, is_deleted, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
  ).run("workspace-cleanup", "Cleanup", tempDir, 1, 1);
  return {
    db,
    dbPath,
    close: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** 插入或复用一条旧会话。 */
function seedOldThread(db: ClientDb, threadId: string, updatedAt: number): void {
  db.db.prepare(
    `INSERT OR IGNORE INTO threads (id, workspace_id, engine, title, created_at, updated_at)
     VALUES (?, 'workspace-cleanup', 'codex', ?, ?, ?)`,
  ).run(threadId, threadId, updatedAt, updatedAt);
}

/** 插入一条会话工作流任务行；instanceId 为空表示尚未关联实例。 */
function seedChatWorkflowTask(db: ClientDb, threadId: string, state: string, instanceId: string | null): void {
  db.db.prepare(
    `INSERT INTO chat_workflow_tasks
       (id, workspace_id, thread_id, source_turn_id, instance_id, state, version, task_json, created_at, updated_at)
     VALUES (?, 'workspace-cleanup', ?, ?, ?, ?, 1, '{}', 1000, 1000)`,
  ).run(`task-${threadId}`, threadId, `turn-${threadId}`, instanceId, state);
}

/** 插入一条编排实例行；node_states_json 保持为空，避免实例引用影响清理门禁判定。 */
function seedOrchestrationInstance(db: ClientDb, instanceId: string, status: string): string {
  db.db.prepare(
    `INSERT INTO orch_instances
       (id, workspace_id, workflow_id, workflow_snapshot_json, intake_snapshot_json, status, node_states_json, created_at, updated_at)
     VALUES (?, 'workspace-cleanup', 'workflow-cleanup', '{}', '{}', ?, '{}', 1000, 1000)`,
  ).run(instanceId, status);
  return instanceId;
}

/** 插入 canonical 事件测试行。 */
function insertConversationEvent(db: ClientDb, threadId: string, seq: number): void {
  db.db.prepare(
    `INSERT INTO conversation_events (seq, thread_id, workspace_id, engine, type, event_json, ts)
     VALUES (?, ?, 'workspace-cleanup', 'codex', 'test.event', ?, ?)`,
  ).run(seq, threadId, JSON.stringify({ seq, threadId }), seq);
}

/** 插入 raw 事件测试行。 */
function insertRawEvent(db: ClientDb, threadId: string, seq: number): void {
  db.db.prepare(
    `INSERT INTO raw_engine_events (seq, thread_id, workspace_id, engine, source, event_json, ts)
     VALUES (?, ?, 'workspace-cleanup', 'codex', 'test', ?, ?)`,
  ).run(seq, threadId, JSON.stringify({ seq, threadId }), seq);
}

/** 插入三个终态和一条运行态 Prompt 快照。 */
function seedPromptSnapshots(db: ClientDb, threadId: string): void {
  const insertInstance = db.db.prepare(
    `INSERT INTO orch_instances (
       id, workspace_id, workflow_id, workflow_snapshot_json, intake_snapshot_json,
       status, node_states_json, created_at, updated_at
     ) VALUES (?, 'workspace-cleanup', 'workflow-cleanup', '{}', '{}', ?, '{}', 1, 1)`,
  );
  insertInstance.run("instance-completed", "completed");
  insertInstance.run("instance-failed", "failed");
  insertInstance.run("instance-cancelled", "cancelled");
  insertInstance.run("instance-running", "running");
  insertPromptSnapshot(db, "prompt-completed", "instance-completed", threadId);
  insertPromptSnapshot(db, "prompt-failed", "instance-failed", threadId);
  insertPromptSnapshot(db, "prompt-cancelled", "instance-cancelled", threadId);
  insertPromptSnapshot(db, "prompt-running", "instance-running", threadId);
}

/** 插入一条关联指定会话的 Prompt 快照。 */
function insertPromptSnapshot(db: ClientDb, promptId: string, instanceId: string, threadId: string): void {
  const insertPrompt = db.db.prepare(
    `INSERT INTO orch_prompt_snapshots (
       id, instance_id, node_id, attempt_no, thread_id, turn_id, engine, model, effort,
       prompt_envelope_json, system_message, developer_message, user_message, rendered_input_preview,
       runtime_policy_json, tool_registry_json, knowledge_catalogs_json, artifact_input_json, created_at
     ) VALUES (?, ?, 'node', 1, ?, NULL, 'codex', NULL, NULL, '{}', '', NULL, '', '', '{}', NULL, '{}', '{}', 1)`,
  );
  insertPrompt.run(promptId, instanceId, threadId);
}

/** 建立一个草稿引用，验证 Blob GC 会检查引用索引。 */
function referenceBlobFromDraft(db: ClientDb, threadId: string, blobId: string): void {
  db.db.prepare(
    `INSERT INTO thread_drafts (thread_id, workspace_id, text, path_references_json, version, updated_at)
     VALUES (?, 'workspace-cleanup', '', '[]', 1, 1)`,
  ).run(threadId);
  db.db.prepare(
    `INSERT INTO thread_draft_attachments (
       thread_id, attachment_id, kind, order_index, name, display_name, mime, size, blob_id
     ) VALUES (?, 'attachment', 'file', 0, 'ref', NULL, NULL, 1, ?)`,
  ).run(threadId, blobId);
}

/** 读取指定事件表的 seq。 */
function readSeqs(db: ClientDb, table: "conversation_events" | "raw_engine_events", threadId: string): number[] {
  return (db.db.prepare(`SELECT seq FROM ${table} WHERE thread_id = ? ORDER BY seq`).all(threadId) as Array<{ seq: number }>)
    .map((row) => Number(row.seq));
}

/** 读取剩余 Prompt ID。 */
function readPromptIds(db: ClientDb): string[] {
  return (db.db.prepare("SELECT id FROM orch_prompt_snapshots ORDER BY id").all() as Array<{ id: string }>)
    .map((row) => String(row.id));
}

/** 轮询任务快照直到命中条件。 */
async function waitFor(
  service: ClientDbCleanupService,
  predicate: (snapshot: ReturnType<ClientDbCleanupService["getStorageSummary"]>["cleanup"]) => boolean,
  timeoutMs = 5_000,
): Promise<ReturnType<ClientDbCleanupService["getStorageSummary"]>["cleanup"]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = service.getStorageSummary().cleanup;
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const snapshot = service.getStorageSummary().cleanup;
  assert.fail(`cleanup status timeout: ${JSON.stringify(snapshot)}`);
}

/** 等待异步竞态中的普通条件成立。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition timeout");
}
