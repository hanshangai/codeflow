import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import { handleThreadsDelete, handleThreadsRestartCodexAppServer } from "../src/app/handlers/threadHandlers.ts";
import { interruptTurnBestEffort } from "../src/app/turnInterrupt.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { ThreadSessionManager } from "../src/engines/threadSessionManager.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";
import { resolveThreadRunningState } from "../src/app/threadRunningState.ts";

/** 创建只有 SQLite running turn、没有内存/provider binding 的 Codex 测试现场。 */
function setupDbOnlyCodexTurn(suffix: string) {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), `codeflowai-codex-state-guard-${suffix}-`));
  const application = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  const workspaceId = `ws-codex-state-guard-${suffix}` as WorkspaceId;
  const threadId = `thread-codex-state-guard-${suffix}` as ThreadId;
  const turnId = `turn-codex-state-guard-${suffix}` as TurnId;
  application.workspaces.upsert({ id: workspaceId, title: "状态门禁测试", path: workspacePath });
  const db = application.forWorkspace(workspaceId);
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "状态门禁测试" });
  db.turns.insertStarted({
    workspaceId,
    threadId,
    engine: "codex",
    turnId,
    startedAt: 1_000,
    startEventSeq: 1,
  });
  return {
    db,
    workspacePath,
    workspaceId,
    threadId,
    turnId,
    cleanup() {
      application.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

test("Codex app-server 显式重启不被 DB-only started 快照阻断", async () => {
  const harness = setupDbOnlyCodexTurn("restart");
  const sent: any[] = [];
  let killCalls = 0;
  try {
    const requestedThreadId = "thread-codex-state-guard-restart-idle" as ThreadId;
    harness.db.threads.create({
      id: requestedThreadId,
      workspaceId: harness.workspaceId,
      engine: "codex",
      title: "空闲重启目标",
    });
    const sessions = new ThreadSessionManager({
      writeWorkspaceLog: testEngineWorkspaceLog,
      workspaces: new Map([[harness.workspaceId, harness.workspacePath]]),
      threads: { setSessionId() {}, setSessionBinding() {}, dropSessionBinding() {} } as any,
    }) as any;
    sessions.codexAppServer = {
      async releaseThread(threadId: ThreadId) { assert.equal(threadId, requestedThreadId); killCalls += 1; },
      forThread() { return { async drainMessages() {} }; },
    };
    const ctx = {
      db: harness.db,
      workspaces: new Map([[harness.workspaceId, harness.workspacePath]]),
      sessions,
      send(message: any) {
        sent.push(message);
      },
    } as unknown as ApiHandlerContext;

    await handleThreadsRestartCodexAppServer(ctx, {
      t: "api.req",
      id: "req-codex-restart-db-only",
      method: "threads.restartCodexAppServer",
      path: "/threads/restart-codex-app-server",
      body: { workspaceId: harness.workspaceId, threadId: requestedThreadId },
    } as ApiRequestMessage);

    const response = sent.find((message) => message.t === "api.res");
    assert.equal(response?.status, 200);
    assert.equal(response?.body?.ok, true);
    assert.equal(response?.body?.message, "Codex app-server 运行态已重置；下一次请求会启动新进程。");
    assert.equal(killCalls, 1);
    assert.equal(harness.db.turns.get(harness.turnId)?.status, "started");
  } finally {
    harness.cleanup();
  }
});

for (const scenario of ["db-only", "live", "completed-race", "failed-race", "kill-failed", "dispatch-retry", "multiple-old-turns"] as const) {
  test(`Codex 显式重启收口持久运行态：${scenario}`, async () => {
    const harness = setupDbOnlyCodexTurn(`restart-${scenario}`);
    const sent: any[] = [];
    const queued: any[] = [];
    let kills = 0;
    let invalidations = 0;
    let rejectTerminalDispatch = scenario === "dispatch-retry";
    try {
      const oldTurnId = `old-${harness.turnId}` as TurnId;
      if (scenario === "multiple-old-turns") {
        harness.db.turns.insertStarted({ workspaceId: harness.workspaceId, threadId: harness.threadId,
          engine: "codex", turnId: oldTurnId, startedAt: 500, startEventSeq: null });
      }
      const sessions = new ThreadSessionManager({
        writeWorkspaceLog: testEngineWorkspaceLog,
        workspaces: new Map([[harness.workspaceId, harness.workspacePath]]),
        threads: { setSessionBinding() {}, dropSessionBinding() {} } as any,
      }) as any;
      const oldSession = {
        engine: "codex", workspaceId: harness.workspaceId, threadId: harness.threadId,
        hasActiveTurn() { return true; },
        getActiveTurnId() { return harness.turnId; },
        getObservedTurnTerminalStatus(turnId: TurnId) {
          if (scenario === "multiple-old-turns" && turnId === oldTurnId) return "completed";
          return scenario === "completed-race" ? "completed" : scenario === "failed-race" ? "failed" : null;
        },
        async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: "work done" }; },
        invalidateAfterProcessTermination() { invalidations += 1; },
      };
      if (scenario !== "db-only") sessions.sessions.set(harness.threadId, { session: oldSession, lastUsedAt: 0 });
      sessions.codexAppServer = {
        async releaseThread(threadId: ThreadId) {
          assert.equal(threadId, harness.threadId);
          kills += 1;
          if (scenario === "kill-failed") throw new Error("process tree still alive");
        },
        forThread() { return { async drainMessages() {} }; },
      };
      // 真实用户输入确保回归同时覆盖 queue 的停止/完成通知。
      harness.db.db.prepare("UPDATE thread_turns SET user_item_id = ? WHERE turn_id = ?").run("restart-user", harness.turnId);
      const ctx = {
        db: harness.db, sessions,
        workspaces: new Map([[harness.workspaceId, harness.workspacePath]]),
        queueDispatcher: { notifyTurnTerminal(event: any) { queued.push(event); } },
        send(message: any) {
          sent.push(message);
          if (message.t === "conversation.event") {
            if (rejectTerminalDispatch) return { accepted: false, reason: "test-rejected" };
            harness.db.conversationEvents.appendEnvelope({
              ...message.event, schema: 1,
              seq: harness.db.conversationEvents.getLatestSeqByThread(harness.threadId) + 1,
            });
          }
          return { accepted: true };
        },
      } as unknown as ApiHandlerContext;
      const req = {
        t: "api.req", id: `req-restart-${scenario}`, method: "threads.restartCodexAppServer",
        path: "/threads/restart-codex-app-server", body: { workspaceId: harness.workspaceId, threadId: harness.threadId },
      } as ApiRequestMessage;
      await handleThreadsRestartCodexAppServer(ctx, req);
      if (scenario === "kill-failed") {
        assert.equal(sent.at(-1)?.status, 409);
        assert.equal(harness.db.turns.get(harness.turnId)?.status, "started");
        assert.equal(sessions.sessions.get(harness.threadId)?.session, oldSession);
        assert.equal(invalidations, 0);
        assert.equal(queued.length, 0);
        return;
      }
      if (scenario === "dispatch-retry") {
        assert.equal(sent.at(-1)?.status, 409);
        rejectTerminalDispatch = false;
        await handleThreadsRestartCodexAppServer(ctx, req);
      }
      assert.equal(sent.at(-1)?.status, 200);
      assert.equal(kills, scenario === "dispatch-retry" ? 2 : 1);
      assert.equal(harness.db.turns.get(harness.turnId)?.status, scenario === "completed-race" ? "completed" : "error");
      assert.ok(harness.db.turns.get(harness.turnId)?.endedAt);
      assert.equal(resolveThreadRunningState(ctx, { workspaceId: harness.workspaceId, threadId: harness.threadId }), null);
      const terminals = harness.db.conversationEvents.listByThread(harness.threadId)
        .filter((event) => event.type === "turn.completed" || event.type === "turn.error");
      assert.equal(terminals.length, scenario === "multiple-old-turns" ? 2 : 1);
      assert.equal(queued.length, 1);
      assert.equal(queued[0].outcome, scenario === "completed-race" ? "completed" : "error");
      if (scenario !== "completed-race") {
        assert.equal(queued[0].terminationKind, scenario === "failed-race" ? "error" : "manual_interrupt");
      }
      assert.equal(sessions.hasActiveTurn(harness.threadId), false);
    } finally {
      harness.cleanup();
    }
  });
}

test("Codex stop keeps a DB-only turn running when provider turn identity is unknown but session binding remains", async () => {
  const harness = setupDbOnlyCodexTurn("interrupt");
  try {
    const runtimeThread = {
      threadId: harness.threadId,
      workspaceId: harness.workspaceId,
      engine: "codex",
      title: "状态门禁测试",
      sessionId: "provider-session-still-known",
    };
    const ctx = {
      db: harness.db,
      workspaces: new Map([[harness.workspaceId, harness.workspacePath]]),
      sessions: {
        async interrupt() {
          return false;
        },
        hasActiveTurn() {
          return false;
        },
      },
      threads: {
        get() {
          return runtimeThread;
        },
      },
      send() {},
    } as unknown as ApiHandlerContext;

    await assert.rejects(
      interruptTurnBestEffort(ctx, {
        workspaceId: harness.workspaceId,
        threadId: harness.threadId,
        turnId: harness.turnId,
      }),
      /Codex 回合停止状态仍未确认/,
    );
    assert.equal(harness.db.turns.get(harness.turnId)?.status, "started");
    assert.equal(
      harness.db.conversationEvents.listByThread(harness.threadId).some((event) => event.type === "turn.error"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("Codex 进程树回收失败时删除会话中止并保留全部数据", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-delete-guard-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  const workspaceId = "ws-codex-delete-guard" as WorkspaceId;
  const threadId = "thread-codex-delete-guard" as ThreadId;
  const turnId = "turn-codex-delete-guard" as TurnId;
  const threads = new ThreadStore();
  let deletionHeld = false;
  let deletionReleaseCalls = 0;
  const sent: any[] = [];
  try {
    db.workspaces.upsert({ id: workspaceId, title: "删除门禁测试", path: directory });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "删除门禁测试" });
    db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 1,
      ts: 1_000,
      workspaceId,
      threadId,
      engine: "codex",
      type: "system.notice",
      payload: { level: "info", text: "must survive" },
    });
    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 1,
      ts: 1_000,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      clientTurnId: turnId,
      data: { method: "thread/started" },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    });
    threads.create({ threadId, workspaceId, engine: "codex", title: "删除门禁测试" });
    const ctx = {
      db,
      workspaces: new Map([[workspaceId, directory]]),
      threads,
      sessions: {
        beginThreadDeletion(ids: readonly ThreadId[]) {
          assert.deepEqual(ids, [threadId]);
          assert.equal(deletionHeld, false);
          deletionHeld = true;
          return () => {
            deletionHeld = false;
            deletionReleaseCalls += 1;
          };
        },
        async disposeThreadWithOptions() {
          assert.equal(deletionHeld, true);
          throw new Error("taskkill failed");
        },
      },
      orchEngine: {
        async disposeManagedServicesForThread() {
          assert.equal(deletionHeld, true);
        },
      },
      async flushLocalEvents() {},
      trackApiTail() { assert.fail("资源释放失败时不能启动物理清理"); },
      send(message: any) {
        sent.push(message);
      },
    } as unknown as ApiHandlerContext;

    await handleThreadsDelete(ctx, {
      t: "api.req",
      id: "req-codex-delete-process-tree-failed",
      method: "threads.delete",
      path: "/threads/delete",
      body: { workspaceId, threadId },
    } as ApiRequestMessage);

    const response = sent.find((message) => message.t === "api.res");
    assert.equal(response?.status, 500);
    assert.equal(response?.body?.code, "thread_delete_failed");
    assert.equal(response?.body?.details?.requestId, "req-codex-delete-process-tree-failed");
    assert.equal(response?.body?.details?.threadId, threadId);
    assert.ok(db.threads.get(threadId));
    assert.equal(db.conversationEvents.getLatestSeqByThread(threadId), 1);
    assert.equal(db.rawEvents.getLatestSeqByThread(threadId), 1);
    assert.ok(threads.get(threadId));
    assert.equal(deletionHeld, false);
    assert.equal(deletionReleaseCalls, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("删除确认后由后台清理会话工作流孤儿记录", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-chat-workflow-delete-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  const workspaceId = "ws-chat-workflow-delete" as WorkspaceId;
  const threadId = "thread-chat-workflow-delete" as ThreadId;
  const runtimeThreads = new ThreadStore();
  const sent: any[] = [];
  const tails: Promise<void>[] = [];
  try {
    db.workspaces.upsert({ id: workspaceId, title: "工作流删除清理", path: directory });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "工作流删除清理" });
    runtimeThreads.create({ threadId, workspaceId, engine: "codex", title: "工作流删除清理" });
    db.db.prepare("INSERT INTO chat_workflow_settings (thread_id, recommendation_enabled) VALUES (?, 1)").run(threadId);
    db.db.prepare("INSERT INTO chat_workflow_tasks (id, workspace_id, thread_id, source_turn_id, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'recommended', 1, '{}', 1, 1)").run("task-delete", workspaceId, threadId, "turn-delete");
    db.db.prepare("INSERT INTO chat_workflow_actions (request_id, task_id, actor_user_id, input_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', 1, 1)").run("action-delete", "task-delete", "owner", "hash");

    const ctx = {
      db,
      workspaces: new Map([[workspaceId, directory]]),
      threads: runtimeThreads,
      sessions: {
        beginThreadDeletion() { return () => {}; },
        async disposeThreadWithOptions() {},
      },
      orchEngine: { async disposeManagedServicesForThread() {} },
      async flushLocalEvents() {},
      trackApiTail(work: Promise<void>) { void work.then(undefined, () => undefined); tails.push(work); },
      send(message: any) { sent.push(message); },
    } as unknown as ApiHandlerContext;

    await handleThreadsDelete(ctx, {
      t: "api.req", id: "delete-chat-workflow", method: "threads.delete", path: "/threads/delete",
      body: { workspaceId, threadId },
    } as ApiRequestMessage);

    assert.equal(sent.find((message) => message.t === "api.res")?.status, 200);
    assert.equal(db.threads.get(threadId), null);
    assert.ok(db.db.prepare("SELECT 1 FROM chat_workflow_tasks WHERE thread_id = ?").get(threadId));
    await Promise.all(tails);
    assert.equal(db.db.prepare("SELECT 1 FROM chat_workflow_settings WHERE thread_id = ?").get(threadId), undefined);
    assert.equal(db.db.prepare("SELECT 1 FROM chat_workflow_tasks WHERE thread_id = ?").get(threadId), undefined);
    assert.equal(db.db.prepare("SELECT 1 FROM chat_workflow_actions WHERE task_id = ?").get("task-delete"), undefined);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("运行中的会话工作流阻止删除并提示先终止工作流", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-chat-workflow-delete-blocked-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  const workspaceId = "ws-chat-workflow-delete-blocked" as WorkspaceId;
  const threadId = "thread-chat-workflow-delete-blocked" as ThreadId;
  const runtimeThreads = new ThreadStore();
  const sent: any[] = [];
  try {
    db.workspaces.upsert({ id: workspaceId, title: "运行中工作流删除门禁", path: directory });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "运行中工作流删除门禁" });
    runtimeThreads.create({ threadId, workspaceId, engine: "codex", title: "运行中工作流删除门禁" });
    db.db.prepare(
      "INSERT INTO chat_workflow_tasks (id, workspace_id, thread_id, source_turn_id, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'starting', 1, '{}', 1, 1)",
    ).run("task-delete-blocked", workspaceId, threadId, "turn-delete-blocked");

    const ctx = {
      db,
      workspaces: new Map([[workspaceId, directory]]),
      threads: runtimeThreads,
      sessions: {
        beginThreadDeletion() { return () => {}; },
      },
      send(message: any) { sent.push(message); },
    } as unknown as ApiHandlerContext;

    await handleThreadsDelete(ctx, {
      t: "api.req", id: "delete-chat-workflow-blocked", method: "threads.delete", path: "/threads/delete",
      body: { workspaceId, threadId },
    } as ApiRequestMessage);

    const response = sent.find((message) => message.t === "api.res");
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.code, "thread_cleanup_active_orchestration");
    assert.equal(response?.body?.message, "当前会话有运行中的工作流，请先终止会话工作流后再删除。");
    assert.ok(db.threads.get(threadId));
    assert.ok(runtimeThreads.get(threadId));
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
