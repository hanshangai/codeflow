import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MANUAL_TURN_INTERRUPT_CODE, type ClientToServerMessage, type ThreadId, type TurnId, type WorkspaceId } from "@codeflowai/shared";

import { handleWorkspacesDelete } from "../src/app/handlers/workspaceHandlers.ts";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { OrchInstanceSummaryProjectionReader } from "../src/db/orchInstanceSummaryProjection.ts";
import { ConversationEventRepo, RawEngineEventRepo } from "../src/db/repos/eventRepo.ts";
import { FileBlobRepo } from "../src/db/repos/fileBlobRepo.ts";
import { OrchInstanceRepo } from "../src/db/repos/orchInstanceRepo.ts";
import { OrchIntakeListStateRepo } from "../src/db/repos/orchIntakeListStateRepo.ts";
import { ThreadMessageQueueRepo } from "../src/db/repos/threadMessageQueueRepo.ts";
import { ThreadQueueStateRepo } from "../src/db/repos/threadQueueStateRepo.ts";
import { ThreadRepo } from "../src/db/repos/threadRepo.ts";
import { ThreadTurnRepo } from "../src/db/repos/threadTurnRepo.ts";
import { WorkspaceRepo } from "../src/db/repos/workspaceRepo.ts";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";

const WORKSPACE_ID = "client-test:workspace-delete-handler" as WorkspaceId;
const THREAD_ID = "thread-delete-handler" as ThreadId;
const TURN_ID = "turn-delete-handler" as TurnId;

const SEND_OPTS = {
  workMode: "general" as const,
  planMode: false,
  accessMode: null,
  model: null,
  effort: null,
  contextWindow: null,
  autoCompactPct: null,
  serviceTier: null,
};

/** 构造带真实 SQLite repos 的 workspace 删除 handler 测试环境。 */
function setup(): {
  workspacePath: string;
  db: any;
  ctx: ApiHandlerContext;
  sent: ClientToServerMessage[];
  cleanup: () => void;
} {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-ws-delete-"));
  const sqlite = openSqliteDb(path.join(workspacePath, "client.db"));
  migrateClientDb(sqlite);
  const db = createDbHarness(sqlite);
  const sent: ClientToServerMessage[] = [];
  let seq = 0;

  db.workspaces.upsert({ id: WORKSPACE_ID, title: "delete handler", path: workspacePath });
  db.threads.create({ id: THREAD_ID, workspaceId: WORKSPACE_ID, engine: "codex", title: "running thread" });
  db.turns.insertStarted({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    turnId: TURN_ID,
    startedAt: Date.now(),
    startEventSeq: 1,
  });
  db.threadMessageQueue.appendItem({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    text: "sending item",
    images: [],
    files: [],
    sendOptions: SEND_OPTS,
  });
  const sending = db.threadMessageQueue.claimNextPending(THREAD_ID);
  assert.ok(sending);
  db.threadMessageQueue.appendItem({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    text: "pending item",
    images: [],
    files: [],
    sendOptions: SEND_OPTS,
  });

  const instance = db.orchInstances.create({
    workspaceId: WORKSPACE_ID,
    workflowId: "workflow-delete-handler" as any,
    workflowSnapshot: {
      id: "workflow-delete-handler",
      workspaceId: WORKSPACE_ID,
      name: "delete handler workflow",
      description: "",
      nodes: [],
      edges: [],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any,
    intakeSnapshot: {
      id: "intake-delete-handler",
      workspaceId: WORKSPACE_ID,
      triggerMode: "manual",
      taskType: "test",
      title: "delete handler intake",
      goal: "test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any,
  });
  db.orchInstances.updateStatus(instance.id, "running");

  const ctx = {
    db,
    workspaces: new Map([[WORKSPACE_ID, workspacePath]]),
    clientId: "client-test",
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 1_000,
    },
    threads: new ThreadStore(),
    sessions: {
      async interrupt() {
        return true;
      },
      async interruptCodexTurnByEngineIds() {
        return;
      },
      async disposeThreadWithOptions() {
        return;
      },
      getOrCreate() {
        return null;
      },
    },
    orchEngine: {
      /** 单工作区夹具沿生产接口选择当前执行owner。 */
      forWorkspace() { return this; },
      async cancelAndWait(instanceId: string) {
        db.orchInstances.updateStatus(instanceId as any, "cancelled");
      },
    },
    send(message: ClientToServerMessage) {
      sent.push(message);
    },
    onBeforeEmitConversationEvent(event) {
      db.conversationEvents.appendEnvelope({
        ...event,
        seq: ++seq,
      } as any);
    },
  } as ApiHandlerContext;

  return {
    workspacePath,
    db,
    ctx,
    sent,
    cleanup() {
      db.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

/** 只挂载 workspace 删除 handler 依赖的 repos，避免测试加载无关仓储。 */
function createDbHarness(sqlite: SqliteDb): any {
  const blobs = new FileBlobRepo(sqlite);
  const orchInstanceSummaries = new OrchInstanceSummaryProjectionReader(sqlite);
  const orchIntakeListStates = new OrchIntakeListStateRepo(sqlite, orchInstanceSummaries);
  const database = {
    db: sqlite,
    workspaces: new WorkspaceRepo(sqlite),
    threads: new ThreadRepo(sqlite),
    turns: new ThreadTurnRepo(sqlite),
    threadMessageQueue: new ThreadMessageQueueRepo(sqlite, blobs),
    threadQueueStates: new ThreadQueueStateRepo(sqlite),
    orchInstances: new OrchInstanceRepo(sqlite, orchIntakeListStates, orchInstanceSummaries),
    conversationEvents: new ConversationEventRepo(sqlite),
    rawEvents: new RawEngineEventRepo(sqlite),
    close: () => sqlite.close(),
  };
  return { ...database, forWorkspace: () => database };
}

test("handleWorkspacesDelete 软删除前显式中断 running turn、取消编排和活跃队列", async () => {
  const harness = setup();
  try {
    await handleWorkspacesDelete(harness.ctx, {
      t: "api.req",
      id: "req-delete-workspace",
      method: "workspaces.delete",
      path: "/api/workspaces/delete",
      body: { workspaceId: WORKSPACE_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.t === "api.res" && message.id === "req-delete-workspace") as any;
    assert.equal(response?.status, 200);
    assert.equal(harness.db.workspaces.get(WORKSPACE_ID), null);
    assert.equal(harness.db.workspaces.getIncludingDeleted(WORKSPACE_ID)?.isDeleted, true);
    assert.equal(harness.db.threads.get(THREAD_ID)?.id, THREAD_ID);

    const turn = harness.db.turns.get(TURN_ID);
    assert.equal(turn?.status, "error");
    assert.ok(turn?.endedAt);
    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    assert.ok(events.some((event: any) => event.type === "turn.error"
      && event.payload?.code === MANUAL_TURN_INTERRUPT_CODE
      && event.payload?.terminationKind === "manual_interrupt"));

    assert.equal(harness.db.orchInstances.listByWorkspace(WORKSPACE_ID)[0]?.status, "cancelled");
    assert.deepEqual(harness.db.threadMessageQueue.listActiveByThread(THREAD_ID), []);
    assert.equal(harness.db.threadQueueStates.getState(THREAD_ID).pausedReason, "user_stop");
  } finally {
    harness.cleanup();
  }
});

test("handleWorkspacesDelete 可移除未装入运行集合的持久化工作区并保留历史", async () => {
  const harness = setup();
  try {
    harness.ctx.workspaces.delete(WORKSPACE_ID);
    await handleWorkspacesDelete(harness.ctx, {
      t: "api.req", id: "req-delete-unregistered", method: "workspaces.delete", path: "/workspaces/delete",
      body: { workspaceId: WORKSPACE_ID },
    } as ApiRequestMessage);
    const response = harness.sent.find(item => item.t === "api.res" && item.id === "req-delete-unregistered") as any;
    assert.equal(response?.status, 200);
    assert.equal(harness.db.workspaces.get(WORKSPACE_ID), null);
    assert.equal(harness.db.threads.get(THREAD_ID)?.id, THREAD_ID);
    assert.ok(harness.db.turns.get(TURN_ID)?.endedAt);
  } finally {
    harness.cleanup();
  }
});

test("删除工作区的SQLite短段受许可保护，取消和session等待不持许可", async () => {
  const harness = setup();
  let permitted = false;
  harness.ctx.withDatabase = async (_requestId, operation) => {
    assert.equal(permitted, false); permitted = true;
    try { const value = operation(); assert.equal(Boolean(value && typeof (value as any).then === "function"), false); return value; }
    finally { permitted = false; }
  };
  const guard = () => assert.equal(permitted, true, "删除工作区越过数据库许可");
  harness.db.db.setAccessGuard(guard);
  (harness.ctx.orchEngine as any).cancelAndWait = async (instanceId: string) => {
    assert.equal(permitted, false);
    await harness.ctx.withDatabase!("cancel-orch", () => harness.db.orchInstances.updateStatus(instanceId, "cancelled"));
  };
  harness.ctx.onBeforeEmitConversationEvent = () => {};
  harness.ctx.sessions.disposeThreadWithOptions = async () => { assert.equal(permitted, false); };
  try {
    await handleWorkspacesDelete(harness.ctx, { t: "api.req", id: "delete-permitted", method: "workspaces.delete", path: "/test", body: { workspaceId: WORKSPACE_ID } });
    assert.equal((harness.sent.at(-1) as any)?.status, 200);
  } finally { harness.db.db.setAccessGuard(null); harness.cleanup(); }
});
