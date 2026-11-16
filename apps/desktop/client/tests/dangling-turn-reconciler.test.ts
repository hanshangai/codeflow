import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ThreadId, WorkspaceId } from "@codeflowai/shared";

import { openClientDb } from "../src/db/clientDb.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";
import { ThreadSessionManager } from "../src/engines/threadSessionManager.ts";
import { extractCodexThreadReadRecoveryOutcome } from "../src/engines/codex-app-server/codexTurnRecovery.ts";
import {
  finalizeDanglingTurnsOnStartup,
  reconcileDanglingTurnsWithProvider,
} from "../src/startup/danglingTurnReconciler.ts";

// 旧 provider 对账用例显式绑定新名字；生产启动入口不再调用 provider。
const reconcileDanglingTurnsOnStartup = reconcileDanglingTurnsWithProvider;

test("codex recovery marks completed turn with assistant text", () => {
  const outcome = extractCodexThreadReadRecoveryOutcome(
    {
      thread: {
        id: "engine-session-1",
        status: "idle",
        turns: [
          {
            id: "engine-turn-1",
            status: "completed",
            items: [
              { type: "agentMessage", id: "msg-1", text: "done" },
            ],
          },
        ],
      },
    },
    { engineSessionId: "engine-session-1", engineTurnId: "engine-turn-1", reason: "startup-reconcile" },
  );

  assert.deepEqual(outcome, {
    kind: "completed",
    responseText: "done",
    assistantItems: [{
      itemId: "msg-1",
      engineMessageId: "msg-1",
      text: "done",
      phase: undefined,
    }],
  });
});

test("codex recovery keeps pending when idle thread contradicts a running target turn", () => {
  const outcome = extractCodexThreadReadRecoveryOutcome(
    {
      thread: {
        id: "engine-session-2",
        status: "idle",
        turns: [
          {
            id: "engine-turn-2",
            status: "running",
            items: [],
          },
        ],
      },
    },
    { engineSessionId: "engine-session-2", engineTurnId: "engine-turn-2", reason: "startup-reconcile" },
  );

  assert.deepEqual(outcome, { kind: "pending" });
});

test("codex recovery keeps pending when target turn is still non-terminal", () => {
  const outcome = extractCodexThreadReadRecoveryOutcome(
    {
      thread: {
        id: "engine-session-3",
        status: "running",
        turns: [
          {
            id: "engine-turn-3",
            status: "running",
            items: [],
          },
        ],
      },
    },
    { engineSessionId: "engine-session-3", engineTurnId: "engine-turn-3", reason: "startup-reconcile" },
  );

  assert.deepEqual(outcome, { kind: "pending" });
});

test("codex recovery keeps pending when thread/read returns another thread", () => {
  const outcome = extractCodexThreadReadRecoveryOutcome(
    {
      thread: {
        id: "engine-session-wrong",
        status: "idle",
        turns: [{ id: "engine-turn-wrong-thread", status: "completed", items: [] }],
      },
    },
    {
      engineSessionId: "engine-session-expected",
      engineTurnId: "engine-turn-wrong-thread",
      reason: "startup-reconcile",
    },
  );

  assert.deepEqual(outcome, { kind: "pending" });
});

test("codex recovery keeps pending when a sibling provider turn is still running", () => {
  const outcome = extractCodexThreadReadRecoveryOutcome(
    {
      thread: {
        id: "engine-session-sibling-running",
        status: "idle",
        turns: [
          { id: "engine-turn-completed", status: "completed", items: [] },
          { id: "engine-turn-running", status: "inProgress", items: [] },
        ],
      },
    },
    {
      engineSessionId: "engine-session-sibling-running",
      engineTurnId: "engine-turn-completed",
      reason: "startup-reconcile",
    },
  );

  assert.deepEqual(outcome, { kind: "pending" });
});

test("codex recovery closes an exact terminal target while a sibling remains running", () => {
  const outcome = extractCodexThreadReadRecoveryOutcome(
    {
      thread: {
        id: "engine-session-exact-target",
        status: { type: "active" },
        turns: [
          { id: "engine-turn-target", status: "interrupted", items: [] },
          { id: "engine-turn-orphan", status: "inProgress", items: [] },
        ],
      },
    },
    {
      engineSessionId: "engine-session-exact-target",
      engineTurnId: "engine-turn-target",
      reason: "interrupt-recovery",
      allowSiblingRunning: true,
    },
  );

  assert.deepEqual(outcome, {
    kind: "error",
    message: "Codex turn ended as interrupted (interrupt-recovery)",
    code: "codex_interrupted",
  });
});

test("codex recovery keeps pending when target is terminal but thread is not terminal", () => {
  const outcome = extractCodexThreadReadRecoveryOutcome(
    {
      thread: {
        id: "engine-session-active",
        status: { type: "active" },
        turns: [{ id: "engine-turn-active", status: "completed", items: [] }],
      },
    },
    {
      engineSessionId: "engine-session-active",
      engineTurnId: "engine-turn-active",
      reason: "startup-reconcile",
    },
  );

  assert.deepEqual(outcome, { kind: "pending" });
});

test("codex recovery keeps pending when an idle thread omits the target turn", () => {
  const outcome = extractCodexThreadReadRecoveryOutcome(
    {
      thread: {
        id: "engine-session-missing-target",
        status: "idle",
        turns: [{ id: "engine-turn-older", status: "completed", items: [] }],
      },
    },
    {
      engineSessionId: "engine-session-missing-target",
      engineTurnId: "engine-turn-missing",
      reason: "startup-reconcile",
    },
  );

  assert.deepEqual(outcome, { kind: "pending" });
});

test("codex recovery keeps pending when a sibling provider turn has an unknown status", () => {
  const outcome = extractCodexThreadReadRecoveryOutcome(
    {
      thread: {
        id: "engine-session-sibling-unknown",
        status: "idle",
        turns: [
          { id: "engine-turn-target", status: "completed", items: [] },
          { id: "engine-turn-unknown", status: "futureStatus", items: [] },
        ],
      },
    },
    {
      engineSessionId: "engine-session-sibling-unknown",
      engineTurnId: "engine-turn-target",
      reason: "startup-reconcile",
    },
  );

  assert.deepEqual(outcome, { kind: "pending" });
});

test("codex recovery keeps pending when thread/read omits the requested turn history", () => {
  const outcome = extractCodexThreadReadRecoveryOutcome(
    {
      thread: {
        id: "engine-session-missing-history",
        status: "idle",
      },
    },
    {
      engineSessionId: "engine-session-missing-history",
      engineTurnId: "engine-turn-missing-history",
      reason: "startup-reconcile",
    },
  );

  assert.deepEqual(outcome, { kind: "pending" });
});

test("codex recovery preserves an explicit provider failure on a terminal thread", () => {
  const outcome = extractCodexThreadReadRecoveryOutcome(
    {
      thread: {
        id: "engine-session-failed",
        status: { type: "systemError" },
        turns: [{ id: "engine-turn-failed", status: "failed", items: [] }],
      },
    },
    {
      engineSessionId: "engine-session-failed",
      engineTurnId: "engine-turn-failed",
      reason: "startup-reconcile",
    },
  );

  assert.equal(outcome.kind, "error");
  assert.equal(outcome.code, "codex_failed");
});

test("startup reconciler closes dangling turns in local db", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-dangling-turn-"));
  const dbPath = path.join(tempDir, "client.db");
  const application = openClientDb({ dbPath });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-reconcile" as WorkspaceId;
    const threadId = "thread-reconcile-1" as ThreadId;
    const turnId = "turn-reconcile-1" as any;

    application.workspaces.upsert({
      id: workspaceId,
      title: "测试工作区",
      path: tempDir,
    });
    db = application.forWorkspace(workspaceId);
    db.threads.create({
      id: threadId,
      workspaceId,
      engine: "claude",
      title: "悬挂回合测试",
    });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "claude",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({ kind: "error", message: "unused", code: "unused", dropSessionBinding: false }),
      } as any,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.errored, 1);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.type, "turn.error");
    assert.ok(Number(result.events[0]?.seq ?? 0) > 0);

    const turn = db.turns.get(turnId);
    assert.equal(turn?.status, "error");

    const events = db.conversationEvents.listByThread(threadId);
    const last = events.at(-1);
    assert.equal(last?.type, "turn.error");
    assert.equal(last?.seq, result.events[0]?.seq);
    assert.equal(String((last?.payload as any)?.turnId ?? ""), String(turnId));
    assert.equal(String((last?.payload as any)?.code ?? ""), "client_restarted");
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler keeps a Codex turn pending when provider session is missing", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-"));
  const dbPath = path.join(tempDir, "client.db");
  const application = openClientDb({ dbPath });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile" as WorkspaceId;
    const threadId = "thread-codex-reconcile-1" as ThreadId;
    const turnId = "turn-codex-reconcile-1" as any;

    application.workspaces.upsert({
      id: workspaceId,
      title: "Codex 测试工作区",
      path: tempDir,
    });
    db = application.forWorkspace(workspaceId);
    db.threads.create({
      id: threadId,
      workspaceId,
      engine: "codex",
      title: "Codex 悬挂回合测试",
    });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    const threads = new ThreadStore();

    let reconcileCalls = 0;
    let detachCalls = 0;
    let disposeCalls = 0;
    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => {
          reconcileCalls += 1;
          throw new Error("missing session must not reach provider reconcile");
        },
        detachCodexProviderGeneration: () => {
          detachCalls += 1;
        },
        disposeThreadWithOptions: async () => {
          disposeCalls += 1;
        },
      } as any,
    });

    assert.equal(reconcileCalls, 0);
    assert.equal(detachCalls, 0);
    assert.equal(disposeCalls, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.equal(result.droppedSessionBindings, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.threads.get(threadId)?.sessionId, null);
    assert.equal(threads.get(threadId), null);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler keeps a thread-only session pending when local clientId is missing", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-thread-session-no-client-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-thread-session-no-client" as WorkspaceId;
    const threadId = "thread-codex-reconcile-thread-session-no-client" as ThreadId;
    const turnId = "turn-codex-reconcile-thread-session-no-client" as any;
    const engineSessionId = "engine-session-thread-only-no-client" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Codex thread session no client", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex thread session no client" });
    db.threads.setSessionId(threadId, engineSessionId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    let providerCalls = 0;
    const threads = new ThreadStore();

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => {
          providerCalls += 1;
          throw new Error("missing clientId must not query provider");
        },
        detachCodexProviderGeneration: () => {
          providerCalls += 1;
        },
        disposeThreadWithOptions: async () => {
          providerCalls += 1;
        },
      } as any,
    });

    assert.equal(providerCalls, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.threads.get(threadId)?.sessionId, engineSessionId);
    assert.equal(threads.get(threadId), null);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler does not guess a thread-only session across multiple started turns", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-thread-session-ambiguous-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-thread-session-ambiguous" as WorkspaceId;
    const threadId = "thread-codex-reconcile-thread-session-ambiguous" as ThreadId;
    const firstTurnId = "turn-codex-reconcile-thread-session-ambiguous-1" as any;
    const secondTurnId = "turn-codex-reconcile-thread-session-ambiguous-2" as any;
    const engineSessionId = "engine-session-thread-only-ambiguous" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Codex thread session ambiguous", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex thread session ambiguous" });
    db.threads.setSessionId(threadId, engineSessionId);
    for (const [index, turnId] of [firstTurnId, secondTurnId].entries()) {
      db.turns.insertStarted({
        workspaceId,
        threadId,
        engine: "codex",
        turnId,
        startedAt: Date.now() - 1_000 + index,
        startEventSeq: 100 + index,
      });
      db.turns.setUserMessage(turnId, { userItemId: `item-user-thread-session-${index}` as any, userText: "hi" });
    }
    db.turns.setEngineSessionIdByThread(threadId, engineSessionId);
    let providerCalls = 0;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => {
          providerCalls += 1;
          throw new Error("ambiguous thread session must not query provider");
        },
        detachCodexProviderGeneration: () => {
          providerCalls += 1;
        },
        disposeThreadWithOptions: async () => {
          providerCalls += 1;
        },
      } as any,
    });

    assert.equal(providerCalls, 0);
    assert.equal(result.pending, 2);
    assert.equal(result.errored, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(firstTurnId)?.status, "started");
    assert.equal(db.turns.get(secondTurnId)?.status, "started");
    assert.equal(db.threads.get(threadId)?.sessionId, engineSessionId);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler keeps Codex turn running when provider remains pending", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-pending-"));
  const dbPath = path.join(tempDir, "client.db");
  const application = openClientDb({ dbPath });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-pending" as WorkspaceId;
    const threadId = "thread-codex-reconcile-pending" as ThreadId;
    const turnId = "turn-codex-reconcile-pending" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Codex pending", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex pending" });
    db.threads.setSessionId(threadId, "engine-session-pending" as any);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setEngineSessionIdByThread(threadId, "engine-session-pending" as any);
    db.turns.setUserMessage(turnId, { userItemId: "item-user-pending" as any, userText: "pending" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineTurnId: "engine-turn-pending",
      engineSessionId: "engine-session-pending" as any,
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });
    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "pending",
          message: "provider 仍在运行",
          code: "client_restart_reconcile_timeout",
          dropSessionBinding: false,
        }),
      } as any,
    });

    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.conversationEvents.listByThread(threadId).some((event) => event.type === "turn.error"), false);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler session_invalidated 恢复失败时保留原绑定与 running", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-invalidated-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-invalidated" as WorkspaceId;
    const threadId = "thread-codex-reconcile-invalidated" as ThreadId;
    const turnId = "turn-codex-reconcile-invalidated" as any;
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "Codex invalidated", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex invalidated" });
    db.threads.setSessionId(threadId, "engine-session-invalidated" as any);
    threads.create({
      threadId,
      workspaceId,
      engine: "codex",
      title: "Codex invalidated",
      sessionId: "engine-session-invalidated" as any,
    });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-invalidated" as any, userText: "invalidated" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId: "engine-session-invalidated" as any,
      engineTurnId: "engine-turn-invalidated",
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });

    let detachCalls = 0;
    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "error",
          message: "Codex 引擎会话已失效，client 重启后无法恢复该回合。",
          code: "session_invalidated",
          dropSessionBinding: true,
        }),
        detachCodexProviderGeneration: () => {
          detachCalls += 1;
        },
      } as any,
    });

    assert.equal(result.errored, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.droppedSessionBindings, 0);
    assert.equal(detachCalls, 0);
    assert.equal(db.threads.get(threadId)?.sessionId, "engine-session-invalidated");
    assert.equal(threads.get(threadId)?.sessionId, "engine-session-invalidated");
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.deepEqual(result.events, []);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler session_invalidated 不调用 provider cleanup 并保持 pending", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-invalidated-cleanup-failed-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-invalidated-cleanup-failed" as WorkspaceId;
    const threadId = "thread-codex-reconcile-invalidated-cleanup-failed" as ThreadId;
    const turnId = "turn-codex-reconcile-invalidated-cleanup-failed" as any;
    const engineSessionId = "engine-session-invalidated-cleanup-failed" as any;
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "Codex invalidated cleanup", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex invalidated cleanup" });
    db.threads.setSessionId(threadId, engineSessionId);
    threads.create({
      threadId,
      workspaceId,
      engine: "codex",
      title: "Codex invalidated cleanup",
      sessionId: engineSessionId,
    });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-invalidated-cleanup" as any, userText: "invalidated" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId,
      engineTurnId: "engine-turn-invalidated-cleanup",
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });

    let detachCalls = 0;
    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "error",
          message: "provider session invalidated",
          code: "session_invalidated",
          dropSessionBinding: true,
        }),
        detachCodexProviderGeneration: () => {
          detachCalls += 1;
        },
      } as any,
    });

    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.equal(result.droppedSessionBindings, 0);
    assert.equal(detachCalls, 0);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.threads.get(threadId)?.sessionId, engineSessionId);
    assert.equal(threads.get(threadId)?.sessionId, engineSessionId);
    assert.deepEqual(result.events, []);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup finalizer discards dangling turns locally without provider access", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-dangling-turn-discard-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-discard" as WorkspaceId;
    const threadId = "thread-discard-1" as ThreadId;
    const turnId = "turn-discard-1" as any;
    const providerThreadId = "provider-thread-discard" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Discard", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Discard" });
    db.threads.setSessionId(threadId, providerThreadId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });

    const historicalRawSeq = Date.now() + 60_000;
    db.rawEvents.appendEnvelope({
      schema: 1, seq: historicalRawSeq, ts: Date.now(), workspaceId, threadId, engine: "codex",
      source: "history", data: {}, handled: true, action: "mapped", emittedTypes: [],
    });
    t.mock.method(Date, "now", () => historicalRawSeq - 60_000);

    const result = await finalizeDanglingTurnsOnStartup({ db: application });

    assert.equal(result.scanned, 1);
    assert.equal(result.completed, 0);
    assert.equal(result.errored, 1);
    assert.equal(result.pending, 0);
    assert.equal(result.droppedSessionBindings, 0);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.seq, historicalRawSeq + 1);
    assert.deepEqual(application.applicationDb.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get(), { value: String(historicalRawSeq + 1) });
    assert.deepEqual(db.db.prepare("SELECT value FROM meta WHERE key = 'event_seq_floor'").get(), { value: String(historicalRawSeq + 1) });
    assert.equal(result.events[0]?.type, "turn.error");
    assert.equal(String((result.events[0]?.payload as any)?.code ?? ""), "client_restarted");
    assert.equal(String((result.events[0]?.payload as any)?.recoveryReason ?? ""), "client_restart_discard");
    assert.equal(String((result.events[0]?.payload as any)?.providerThreadId ?? ""), providerThreadId);
    assert.equal(db.turns.get(turnId)?.status, "error");
    assert.equal(db.threads.get(threadId)?.sessionId, providerThreadId);

    const second = await finalizeDanglingTurnsOnStartup({ db: application });
    assert.equal(second.scanned, 0);
    assert.deepEqual(second.events, []);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler 恢复错误无 provider 终态时保留 binding 与 running", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-unrecoverable-choice-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-unrecoverable-choice" as WorkspaceId;
    const threadId = "thread-codex-reconcile-unrecoverable-choice" as ThreadId;
    const turnId = "turn-codex-reconcile-unrecoverable-choice" as any;
    const engineSessionId = "engine-session-unrecoverable-choice" as any;
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "Codex unrecoverable choice", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex unrecoverable choice" });
    db.threads.setSessionId(threadId, engineSessionId);
    threads.create({
      threadId,
      workspaceId,
      engine: "codex",
      title: "Codex unrecoverable choice",
      sessionId: engineSessionId,
    });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-unrecoverable-choice" as any, userText: "continue" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId,
      engineTurnId: "engine-turn-unrecoverable-choice",
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });
    let detachCalls = 0;
    let disposeCalls = 0;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "error",
          message: "resume 与 read 均确认原 provider thread 不存在",
          code: "codex_thread_resume_unrecoverable",
          dropSessionBinding: false,
          providerThreadId: engineSessionId,
          userChoiceRequired: true,
          recoveryStrategies: ["retry-existing", "new-thread"],
        }),
        detachCodexProviderGeneration: () => {
          detachCalls += 1;
        },
        disposeThreadWithOptions: async () => {
          disposeCalls += 1;
        },
      } as any,
    });

    assert.equal(result.errored, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.droppedSessionBindings, 0);
    assert.equal(detachCalls, 0);
    assert.equal(disposeCalls, 0);
    assert.equal(db.threads.get(threadId)?.sessionId, engineSessionId);
    assert.equal(threads.get(threadId)?.sessionId, engineSessionId);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.deepEqual(result.events, []);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler uses clientUserMessageId for a weak session-only Codex turn", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-session-only-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-session-only" as WorkspaceId;
    const threadId = "thread-codex-reconcile-session-only" as ThreadId;
    const turnId = "turn-codex-reconcile-session-only" as any;
    const engineSessionId = "engine-session-only" as any;
    const clientUserMessageId = "item-user-session-only" as any;
    const actualEngineTurnId = "engine-turn-session-only-actual";
    application.workspaces.upsert({ id: workspaceId, title: "Codex session only", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex session only" });
    db.threads.setSessionId(threadId, engineSessionId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setEngineSessionIdByThread(threadId, engineSessionId);
    db.turns.setUserMessage(turnId, { userItemId: clientUserMessageId, userText: "hi" });
    let disposeCalls = 0;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async (input: any) => {
          assert.equal(input.engineSessionId, engineSessionId);
          assert.equal(input.engineTurnId, null);
          assert.equal(input.exactProviderTurn, false);
          assert.deepEqual(input.clientUserMessageIds, [clientUserMessageId]);
          return {
            kind: "completed",
            responseText: "recovered",
            assistantEvents: [],
            actualEngineTurnId,
          };
        },
        disposeThreadWithOptions: async () => {
          disposeCalls += 1;
        },
      } as any,
    });

    assert.equal(disposeCalls, 0);
    assert.equal(result.completed, 1);
    assert.equal(result.pending, 0);
    assert.deepEqual(result.events.map((event) => event.type), ["turn.engineBound", "turn.completed"]);
    assert.equal((result.events[0]?.payload as any)?.engineTurnId, actualEngineTurnId);
    assert.equal((result.events[0]?.payload as any)?.previousEngineTurnId, null);
    assert.equal(db.turns.get(turnId)?.status, "completed");
    const checkpoint = JSON.parse(String(db.turns.get(turnId)?.engineCheckpointJson));
    assert.equal(checkpoint.codexProviderTurn.engineTurnId, actualEngineTurnId);
    assert.equal(checkpoint.codexProviderTurn.engineSessionId, engineSessionId);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler recovers a unique thread-only Codex session before engineBound ACK", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-thread-session-only-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-thread-session-only" as WorkspaceId;
    const threadId = "thread-codex-reconcile-thread-session-only" as ThreadId;
    const turnId = "turn-codex-reconcile-thread-session-only" as any;
    const engineSessionId = "engine-session-thread-only" as any;
    const clientUserMessageId = "item-user-thread-session-only" as any;
    const actualEngineTurnId = "engine-turn-thread-session-only-actual";
    application.workspaces.upsert({ id: workspaceId, title: "Codex thread session only", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex thread session only" });
    db.threads.setSessionId(threadId, engineSessionId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: clientUserMessageId, userText: "hi" });

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async (input: any) => {
          assert.equal(input.engineSessionId, engineSessionId);
          assert.equal(input.engineTurnId, null);
          assert.deepEqual(input.clientUserMessageIds, [clientUserMessageId]);
          return {
            kind: "completed",
            responseText: "recovered before ACK",
            assistantEvents: [],
            actualEngineTurnId,
          };
        },
      } as any,
    });

    assert.equal(result.completed, 1);
    assert.equal(result.pending, 0);
    assert.deepEqual(result.events.map((event) => event.type), ["turn.engineBound", "turn.completed"]);
    assert.equal((result.events[0]?.payload as any)?.engineTurnId, actualEngineTurnId);
    assert.equal((result.events[0]?.payload as any)?.engineSessionId, engineSessionId);
    assert.equal(db.turns.get(turnId)?.status, "completed");
    assert.equal(db.turns.get(turnId)?.engineSessionId, engineSessionId);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler preserves an unmaterialized unique thread-only session candidate", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-thread-session-unmaterialized-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-thread-session-unmaterialized" as WorkspaceId;
    const threadId = "thread-codex-reconcile-thread-session-unmaterialized" as ThreadId;
    const turnId = "turn-codex-reconcile-thread-session-unmaterialized" as any;
    const engineSessionId = "engine-session-thread-only-unmaterialized" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Codex thread candidate", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex thread candidate" });
    db.threads.setSessionId(threadId, engineSessionId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-thread-only-unmaterialized" as any, userText: "hi" });
    const threads = new ThreadStore();
    let detachCalls = 0;
    let disposeCalls = 0;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "pending",
          message: "clientUserMessageId 未在此 provider thread 中物化",
          code: "codex_turn_ownership_unmaterialized",
          dropSessionBinding: false,
        }),
        detachCodexProviderGeneration: (_threadId: string, expectedSessionId: string, recovery: any) => {
          assert.equal(expectedSessionId, engineSessionId);
          assert.equal(recovery.clientUserMessageId, "item-user-thread-only-unmaterialized");
          assert.equal(threads.get(threadId)?.sessionId, engineSessionId);
          detachCalls += 1;
          db.threads.clearSessionId(threadId);
          threads.dropSessionBinding(threadId);
        },
        disposeThreadWithOptions: async () => {
          disposeCalls += 1;
        },
      } as any,
    });

    assert.equal(detachCalls, 0);
    assert.equal(disposeCalls, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.threads.get(threadId)?.sessionId, engineSessionId);
    assert.equal(threads.get(threadId), null);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler does not hydrate or detach an unmaterialized provider binding", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-real-detach-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  const threads = new ThreadStore();
  let disposeRealSession: (() => Promise<void>) | null = null;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-real-detach" as WorkspaceId;
    const threadId = "thread-codex-reconcile-real-detach" as ThreadId;
    const turnId = "turn-codex-reconcile-real-detach" as any;
    const engineSessionId = "engine-session-real-detach" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Codex real detach", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex real detach" });
    db.threads.setSessionId(threadId, engineSessionId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    const provisionalEngineTurnId = "engine-turn-unmaterialized-provisional";
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId,
      engineTurnId: provisionalEngineTurnId,
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-real-detach" as any, userText: "hi" });
    const sessions = new ThreadSessionManager({
      writeWorkspaceLog: testEngineWorkspaceLog,
      workspaces: new Map([[workspaceId, tempDir]]),
      threads,
      clearPersistedSessionBinding: (targetThreadId) => db.threads.clearSessionId(targetThreadId),
      sessionIdleCleanup: { enabled: false },
    });
    const originalDispose = sessions.disposeThreadWithOptions.bind(sessions);
    disposeRealSession = async () => await originalDispose(threadId, { flushActiveTurn: false });
    (sessions as any).reconcileCodexDanglingTurn = async () => ({
      kind: "pending",
      message: "clientUserMessageId 未物化",
      code: "codex_turn_ownership_unmaterialized",
      dropSessionBinding: false,
    });

    assert.equal(threads.get(threadId), null);
    const result = await reconcileDanglingTurnsOnStartup({ db: application, threads, sessions });

    assert.equal(result.errored, 0);
    assert.equal(result.pending, 1);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.threads.get(threadId)?.sessionId, engineSessionId);
    assert.equal(threads.get(threadId), null);
  } finally {
    await disposeRealSession?.();
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler preserves an unmaterialized Codex turn without touching a foreign Goal", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-unmaterialized-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-unmaterialized" as WorkspaceId;
    const threadId = "thread-codex-reconcile-unmaterialized" as ThreadId;
    const turnId = "turn-codex-reconcile-unmaterialized" as any;
    const engineSessionId = "engine-session-unmaterialized" as any;
    const clientUserMessageId = "item-user-unmaterialized" as any;
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "Codex unmaterialized", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex unmaterialized" });
    db.threads.setSessionId(threadId, engineSessionId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    const provisionalEngineTurnId = "engine-turn-unmaterialized-provisional";
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId,
      engineTurnId: provisionalEngineTurnId,
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });
    db.turns.setUserMessage(turnId, { userItemId: clientUserMessageId, userText: "hi" });
    let detachCalls = 0;
    let disposeCalls = 0;
    let interruptCalls = 0;
    let detachedRecovery: any = null;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "pending",
          message: "clientUserMessageId 未物化；provider thread 中存在 foreign Goal",
          code: "codex_turn_ownership_unmaterialized",
          dropSessionBinding: false,
        }),
        detachCodexProviderGeneration: (detachedThreadId: string, expectedSessionId: string, recovery: any) => {
          assert.equal(detachedThreadId, threadId);
          assert.equal(expectedSessionId, engineSessionId);
          assert.equal(recovery.clientTurnId, turnId);
          assert.equal(recovery.clientUserMessageId, clientUserMessageId);
          assert.equal(recovery.provisionalProviderTurnId, provisionalEngineTurnId);
          assert.equal(typeof recovery.onProviderTurnRecovered, "function");
          assert.equal(threads.get(threadId)?.title, "Codex unmaterialized");
          assert.equal(threads.get(threadId)?.sessionId, engineSessionId);
          detachedRecovery = recovery;
          detachCalls += 1;
          db.threads.clearSessionId(threadId);
          threads.dropSessionBinding(threadId);
        },
        disposeThreadWithOptions: async () => {
          disposeCalls += 1;
        },
        interrupt: async () => {
          interruptCalls += 1;
          return true;
        },
      } as any,
    });

    assert.equal(detachCalls, 0);
    assert.equal(disposeCalls, 0);
    assert.equal(interruptCalls, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.equal(result.droppedSessionBindings, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.turns.get(turnId)?.engineSessionId, engineSessionId);
    assert.equal(db.threads.get(threadId)?.sessionId, engineSessionId);
    assert.equal(threads.get(threadId), null);
    assert.equal(detachedRecovery, null);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup unmaterialized recovery preserves the provisional provider binding", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-late-same-provider-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-late-same-provider" as WorkspaceId;
    const threadId = "thread-codex-reconcile-late-same-provider" as ThreadId;
    const turnId = "turn-codex-reconcile-late-same-provider" as any;
    const engineSessionId = "engine-session-late-same-provider" as any;
    const engineTurnId = "engine-turn-late-same-provider";
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "Codex late same provider", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex late same provider" });
    db.threads.setSessionId(threadId, engineSessionId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-late-same-provider" as any, userText: "hi" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId,
      engineTurnId,
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });
    let detachedRecovery: any = null;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "pending",
          message: "clientUserMessageId 尚未物化",
          code: "codex_turn_ownership_unmaterialized",
          dropSessionBinding: false,
        }),
        detachCodexProviderGeneration: (_threadId: string, _sessionId: string, recovery: any) => {
          assert.equal(threads.get(threadId)?.sessionId, engineSessionId);
          assert.equal(recovery.provisionalProviderTurnId, engineTurnId);
          detachedRecovery = recovery;
          db.threads.clearSessionId(threadId);
          threads.dropSessionBinding(threadId);
        },
      } as any,
    });

    assert.equal(result.errored, 0);
    assert.equal(result.pending, 1);
    assert.equal(detachedRecovery, null);
    assert.equal(db.turns.get(turnId)?.engineSessionId, engineSessionId);
    assert.equal(db.turns.get(turnId)?.status, "started");
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler keeps an unmaterialized Codex turn pending without detach", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-detach-failed-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-detach-failed" as WorkspaceId;
    const threadId = "thread-codex-reconcile-detach-failed" as ThreadId;
    const turnId = "turn-codex-reconcile-detach-failed" as any;
    const engineSessionId = "engine-session-detach-failed" as any;
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "Codex detach failed", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex detach failed" });
    db.threads.setSessionId(threadId, engineSessionId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId,
      engineTurnId: "engine-turn-detach-failed",
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-detach-failed" as any, userText: "hi" });
    let disposeCalls = 0;
    let interruptCalls = 0;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "pending",
          message: "ownership 未物化",
          code: "codex_turn_ownership_unmaterialized",
          dropSessionBinding: false,
        }),
        detachCodexProviderGeneration: () => {
          throw new Error("detach failed");
        },
        disposeThreadWithOptions: async () => {
          disposeCalls += 1;
        },
        interrupt: async () => {
          interruptCalls += 1;
          return true;
        },
      } as any,
    });

    assert.equal(disposeCalls, 0);
    assert.equal(interruptCalls, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.turns.get(turnId)?.engineSessionId, engineSessionId);
    assert.equal(db.threads.get(threadId)?.sessionId, engineSessionId);
    assert.equal(threads.get(threadId), null);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler repeatedly preserves binding while ownership is unmaterialized", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-detached-retry-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-detached-retry" as WorkspaceId;
    const threadId = "thread-codex-reconcile-detached-retry" as ThreadId;
    const turnId = "turn-codex-reconcile-detached-retry" as any;
    const engineSessionId = "engine-session-detached-retry" as any;
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "Codex detached retry", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex detached retry" });
    db.threads.setSessionId(threadId, engineSessionId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-detached-retry" as any, userText: "hi" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId,
      engineTurnId: "engine-turn-detached-retry",
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });
    const originalClear = db.turns.clearEngineSessionId.bind(db.turns);
    (db.turns as any).clearEngineSessionId = () => {
      throw new Error("terminal transaction failed");
    };
    let detachCalls = 0;
    const sessions = {
      getWorkspacePath: () => tempDir,
      reconcileCodexDanglingTurn: async () => ({
        kind: "pending",
        message: "ownership 未物化",
        code: "codex_turn_ownership_unmaterialized",
        dropSessionBinding: false,
      }),
      detachCodexProviderGeneration: () => {
        detachCalls += 1;
        db.threads.clearSessionId(threadId);
        threads.dropSessionBinding(threadId);
      },
    } as any;

    const first = await reconcileDanglingTurnsOnStartup({ db: application, threads, sessions });
    assert.equal(first.pending, 1);
    assert.equal(first.errored, 0);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.turns.get(turnId)?.engineSessionId, engineSessionId);
    assert.equal(db.threads.get(threadId)?.sessionId, engineSessionId);

    (db.turns as any).clearEngineSessionId = originalClear;
    const second = await reconcileDanglingTurnsOnStartup({ db: application, threads, sessions });
    assert.equal(detachCalls, 0);
    assert.equal(second.pending, 1);
    assert.equal(second.errored, 0);
    assert.equal(second.droppedSessionBindings, 0);
    assert.deepEqual(second.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.turns.get(turnId)?.engineSessionId, engineSessionId);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler keeps incomplete, ambiguous, and failed session-only recovery pending", async () => {
  const scenarios = [
    {
      name: "incomplete",
      reconcile: async () => ({
        kind: "pending" as const,
        message: "provider 历史扫描不完整",
        code: "codex_turn_correlation_scan_incomplete",
        dropSessionBinding: false,
      }),
    },
    {
      name: "ambiguous",
      reconcile: async () => ({
        kind: "pending" as const,
        message: "clientUserMessageId 命中多个 provider turn",
        code: "codex_turn_ownership_ambiguous",
        dropSessionBinding: false,
      }),
    },
    {
      name: "read-failed",
      reconcile: async () => {
        throw new Error("thread/read failed");
      },
    },
  ];

  for (const scenario of scenarios) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `codeflowai-codex-reconcile-${scenario.name}-`));
    const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
    let db: ReturnType<typeof application.forWorkspace>;
    try {
      const workspaceId = `client-test:ws-codex-reconcile-${scenario.name}` as WorkspaceId;
      const threadId = `thread-codex-reconcile-${scenario.name}` as ThreadId;
      const turnId = `turn-codex-reconcile-${scenario.name}` as any;
      const engineSessionId = `engine-session-${scenario.name}` as any;
      application.workspaces.upsert({ id: workspaceId, title: scenario.name, path: tempDir });
      db = application.forWorkspace(workspaceId);
      db.threads.create({ id: threadId, workspaceId, engine: "codex", title: scenario.name });
      db.threads.setSessionId(threadId, engineSessionId);
      db.turns.insertStarted({
        workspaceId,
        threadId,
        engine: "codex",
        turnId,
        startedAt: Date.now() - 1_000,
        startEventSeq: 100,
      });
      db.turns.setEngineSessionIdByThread(threadId, engineSessionId);
      db.turns.setUserMessage(turnId, { userItemId: `item-user-${scenario.name}` as any, userText: "hi" });
      let detachCalls = 0;
      let disposeCalls = 0;

      const request = reconcileDanglingTurnsOnStartup({
        db: application,
        threads: new ThreadStore(),
        sessions: {
          getWorkspacePath: () => tempDir,
          reconcileCodexDanglingTurn: scenario.reconcile,
          detachCodexProviderGeneration: () => {
            detachCalls += 1;
          },
          disposeThreadWithOptions: async () => {
            disposeCalls += 1;
          },
        } as any,
      });

      if (scenario.name === "read-failed") {
        await assert.rejects(request, /thread\/read failed/);
        assert.equal(detachCalls, 0);
        assert.equal(disposeCalls, 0);
        assert.equal(db.turns.get(turnId)?.status, "started");
        continue;
      }
      const result = await request;

      assert.equal(detachCalls, 0, scenario.name);
      assert.equal(disposeCalls, 0, scenario.name);
      assert.equal(result.pending, 1, scenario.name);
      assert.equal(result.errored, 0, scenario.name);
      assert.deepEqual(result.events, [], scenario.name);
      assert.equal(db.turns.get(turnId)?.status, "started", scenario.name);
      assert.equal(db.turns.get(turnId)?.engineSessionId, engineSessionId, scenario.name);
    } finally {
      application.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("startup reconciler does not attempt local terminal cleanup for a sessionless Codex turn", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-local-cleanup-failed-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-local-cleanup-failed" as WorkspaceId;
    const threadId = "thread-codex-reconcile-local-cleanup-failed" as ThreadId;
    const turnId = "turn-codex-reconcile-local-cleanup-failed" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Codex local cleanup failed", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex local cleanup failed" });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    (db.turns as any).clearEngineSessionId = () => {
      throw new Error("local cleanup failed");
    };
    let providerCalls = 0;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => {
          providerCalls += 1;
          throw new Error("sessionless cleanup must not query provider");
        },
        detachCodexProviderGeneration: () => {
          providerCalls += 1;
        },
        disposeThreadWithOptions: async () => {
          providerCalls += 1;
        },
      } as any,
    });

    assert.equal(providerCalls, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler reconciles exact durable provider A/a without touching current binding B", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-pair-"));
  const dbPath = path.join(tempDir, "client.db");
  const application = openClientDb({ dbPath });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-pair" as WorkspaceId;
    const threadId = "thread-codex-reconcile-pair" as ThreadId;
    const turnId = "turn-codex-reconcile-pair" as any;
    const providerThreadId = "provider-thread-A" as any;
    const providerTurnId = "provider-turn-a";
    const currentBindingId = "provider-thread-B" as any;
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "Codex pair", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex pair" });
    db.threads.setSessionId(threadId, currentBindingId);
    threads.create({
      threadId,
      workspaceId,
      engine: "codex",
      title: "Codex pair",
      sessionId: currentBindingId,
    });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId: providerThreadId,
      engineTurnId: providerTurnId,
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });

    let reconcileCalls = 0;
    let bindingMutationCalls = 0;
    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async (input: any) => {
          reconcileCalls += 1;
          assert.equal(input.engineSessionId, providerThreadId);
          assert.equal(input.engineTurnId, providerTurnId);
          assert.equal(input.exactProviderTurn, true);
          assert.equal("clientUserMessageIds" in input, false);
          return {
            kind: "pending",
            message: "provider 仍待确认",
            code: "client_restart_reconcile_timeout",
            dropSessionBinding: false,
          };
        },
        detachCodexProviderGeneration: () => {
          bindingMutationCalls += 1;
        },
        disposeThreadWithOptions: async () => {
          bindingMutationCalls += 1;
        },
      } as any,
    });

    assert.equal(reconcileCalls, 1);
    assert.equal(bindingMutationCalls, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.threads.get(threadId)?.sessionId, currentBindingId);
    assert.equal(threads.get(threadId)?.sessionId, currentBindingId);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler repairs a polluted turn-row session from canonical checkpoint", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-pair-conflict-"));
  const dbPath = path.join(tempDir, "client.db");
  const application = openClientDb({ dbPath });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-pair-conflict" as WorkspaceId;
    const threadId = "thread-codex-reconcile-pair-conflict" as ThreadId;
    const turnId = "turn-codex-reconcile-pair-conflict" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Codex pair conflict", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex pair conflict" });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId: "engine-session-checkpoint" as any,
      engineTurnId: "engine-turn-conflict",
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-pair-conflict" as any, userText: "hi" });
    // 模拟旧版本或外部损坏留下的冲突行；正常仓储写入现在会阻止这种覆盖。
    db.db.prepare("UPDATE thread_turns SET engine_session_id = ? WHERE turn_id = ?")
      .run("engine-session-turn-row", String(turnId));
    let reconcileCalls = 0;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async (input: any) => {
          reconcileCalls += 1;
          assert.equal(String(input.engineSessionId), "engine-session-checkpoint");
          return {
            kind: "pending",
            message: "provider 仍待确认",
            code: "client_restart_reconcile_timeout",
            dropSessionBinding: false,
          };
        },
      } as any,
    });

    assert.equal(reconcileCalls, 1);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.turns.get(turnId)?.engineSessionId, "engine-session-checkpoint");
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler isolates a malformed Codex checkpoint as a pending warning", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-bad-checkpoint-"));
  const dbPath = path.join(tempDir, "client.db");
  const application = openClientDb({ dbPath });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-bad-checkpoint" as WorkspaceId;
    const threadId = "thread-codex-reconcile-bad-checkpoint" as ThreadId;
    const turnId = "turn-codex-reconcile-bad-checkpoint" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Codex bad checkpoint", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex bad checkpoint" });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    // 绕过正常仓储校验注入磁盘损坏，验证恢复入口而非输入校验。
    db.db.prepare("UPDATE thread_turns SET engine_checkpoint_json=? WHERE turn_id=?").run("{not-json", turnId);
    let reconcileCalls = 0;

    await assert.rejects(reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => {
          reconcileCalls += 1;
          throw new Error("malformed history must not reach provider reconcile");
        },
      } as any,
    }), /checkpoint 无法解析/);

    assert.equal(reconcileCalls, 0);
    assert.equal(db.turns.get(turnId)?.status, "started");
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler keeps codex assistant reconcile events on the original client turn", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-turnid-"));
  const dbPath = path.join(tempDir, "client.db");
  const application = openClientDb({ dbPath });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-turnid" as WorkspaceId;
    const threadId = "thread-codex-reconcile-turnid-1" as ThreadId;
    const turnId = "turn-codex-reconcile-turnid-1" as any;
    const threadStore = new ThreadStore();

    application.workspaces.upsert({
      id: workspaceId,
      title: "Codex turnId 测试工作区",
      path: tempDir,
    });
    db = application.forWorkspace(workspaceId);
    db.threads.create({
      id: threadId,
      workspaceId,
      engine: "codex",
      title: "Codex turnId 恢复测试",
    });
    db.threads.setSessionId(threadId, "engine-session-1" as any);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-reconcile-turnid" as any, userText: "recover" });
    db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 101,
      ts: Date.now() - 900,
      workspaceId,
      threadId,
      engine: "codex",
      type: "turn.started",
      payload: { turnId },
    } as any);
    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 102,
      ts: Date.now() - 800,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      data: {
        method: "turn/start",
        params: {
          threadId: "engine-session-1",
          turn: { id: "engine-turn-1" },
        },
      },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    } as any);

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: threadStore,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "completed",
          responseText: "final recovered text",
          assistantEvents: [{
            ts: Date.now(),
            workspaceId,
            threadId,
            engine: "codex",
            type: "item.agentMessage.completed",
            payload: {
              itemId: "msg-recovered" as any,
              engineMessageId: "msg-recovered",
              turnId,
              text: "final recovered text",
              revision: 1,
              phase: "final_answer",
              completionSource: "snapshot_reconcile",
              structuredPayloadJson: null,
            },
          }],
        }),
      } as any,
    });

    assert.equal(result.completed, 1);
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0]?.type, "item.agentMessage.completed");
    assert.equal(String((result.events[0] as any)?.payload?.turnId ?? ""), String(turnId));
    assert.equal(result.events[1]?.type, "turn.completed");
    assert.equal(String((result.events[1] as any)?.payload?.turnId ?? ""), String(turnId));
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler 原子替换 manager 返回的实际 provider mapping", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-ghost-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-ghost" as WorkspaceId;
    const threadId = "thread-codex-reconcile-ghost" as ThreadId;
    const turnId = "turn-codex-reconcile-ghost" as any;
    const engineSessionId = "engine-session-ghost" as any;
    const ghostEngineTurnId = "engine-turn-ghost";
    const actualEngineTurnId = "engine-turn-actual";
    const initialClientUserMessageId = "item-user-initial" as any;
    const clientUserMessageId = "item-user-ghost" as any;

    application.workspaces.upsert({ id: workspaceId, title: "Codex ghost mapping", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex ghost mapping" });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: initialClientUserMessageId, userText: "first" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId,
      engineTurnId: ghostEngineTurnId,
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });
    db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 102,
      ts: Date.now() - 800,
      workspaceId,
      threadId,
      engine: "codex",
      type: "item.userMessage.created",
      payload: {
        turnId,
        itemId: clientUserMessageId,
        text: "latest steer",
        activeTurnAppend: true,
      },
    } as any);

    const historicalRawSeq = Date.now() + 60_000;
    db.rawEvents.appendEnvelope({
      schema: 1, seq: historicalRawSeq, ts: Date.now(), workspaceId, threadId, engine: "codex",
      source: "history", data: {}, handled: true, action: "mapped", emittedTypes: [],
    });
    t.mock.method(Date, "now", () => historicalRawSeq - 60_000);

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async (input: any) => {
          assert.equal(input.exactProviderTurn, true);
          assert.equal("clientUserMessageIds" in input, false);
          return {
            kind: "completed",
            responseText: "done",
            assistantEvents: [],
            actualEngineTurnId,
          };
        },
      } as any,
    });

    assert.equal(result.completed, 1);
    assert.deepEqual(result.events.map((event) => event.type), ["turn.engineBound", "turn.completed"]);
    assert.deepEqual(result.events.map((event) => event.seq), [historicalRawSeq + 1, historicalRawSeq + 2]);
    assert.deepEqual(application.applicationDb.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get(), { value: String(historicalRawSeq + 2) });
    assert.deepEqual(db.db.prepare("SELECT value FROM meta WHERE key = 'event_seq_floor'").get(), { value: String(historicalRawSeq + 2) });
    const bindingEvent = result.events[0]!;
    assert.equal((bindingEvent.payload as any).engineTurnId, actualEngineTurnId);
    assert.equal((bindingEvent.payload as any).previousEngineTurnId, ghostEngineTurnId);

    const turn = db.turns.get(turnId)!;
    assert.equal(turn.status, "completed");
    const checkpoint = JSON.parse(String(turn.engineCheckpointJson));
    assert.equal(checkpoint.codexProviderTurn.engineTurnId, actualEngineTurnId);
    assert.equal(checkpoint.codexProviderTurn.previousEngineTurnId, ghostEngineTurnId);
    assert.deepEqual(checkpoint.codexProviderTurn.supersededEngineTurnIds, [ghostEngineTurnId]);
    assert.equal(checkpoint.codexProviderTurn.source, "turn.engineBound");
    assert.equal(checkpoint.codexProviderTurn.eventSeq, bindingEvent.seq);
    assert.equal(checkpoint.codexProviderTurn.observedAt, bindingEvent.ts);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler provider mapping 冲突时回滚 binding 并隔离为 pending", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-atomic-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-atomic" as WorkspaceId;
    const threadId = "thread-codex-reconcile-atomic" as ThreadId;
    const turnId = "turn-codex-reconcile-atomic" as any;
    const engineSessionId = "engine-session-atomic" as any;
    const ghostEngineTurnId = "engine-turn-ghost";

    application.workspaces.upsert({ id: workspaceId, title: "Codex atomic mapping", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex atomic mapping" });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-atomic" as any, userText: "hi" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId,
      engineTurnId: ghostEngineTurnId,
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });

    await assert.rejects(reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => {
          db.turns.setCodexProviderTurnId(turnId, {
            engineSessionId,
            engineTurnId: "engine-turn-competing",
            previousEngineTurnId: ghostEngineTurnId,
            source: "turn.engineBound",
            eventSeq: 102,
            observedAt: Date.now() - 800,
          });
          return {
            kind: "pending",
            message: "provider 仍在运行",
            code: "client_restart_reconcile_timeout",
            dropSessionBinding: false,
            actualEngineTurnId: "engine-turn-actual",
          };
        },
      } as any,
    }), /mapping conflict/);

    assert.deepEqual(
      db.conversationEvents.listByThread(threadId).map((event) => event.type),
      [],
    );
    const checkpoint = JSON.parse(String(db.turns.get(turnId)?.engineCheckpointJson));
    assert.equal(checkpoint.codexProviderTurn.engineTurnId, "engine-turn-competing");
    assert.equal(checkpoint.codexProviderTurn.supersededEngineTurnIds.includes("engine-turn-actual"), false);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler session 恢复失败时保留已换代 binding 与旧 turn pending", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-invalidated-successor-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-invalidated-successor" as WorkspaceId;
    const threadId = "thread-codex-reconcile-invalidated-successor" as ThreadId;
    const turnId = "turn-codex-reconcile-invalidated-successor" as any;
    const oldSessionId = "engine-session-invalidated-old" as any;
    const successorSessionId = "engine-session-successor" as any;
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "Codex invalidated successor", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex invalidated successor" });
    db.threads.setSessionId(threadId, successorSessionId);
    threads.create({
      threadId,
      workspaceId,
      engine: "codex",
      title: "Codex invalidated successor",
      sessionId: successorSessionId,
    });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-invalidated-successor" as any, userText: "old" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId: oldSessionId,
      engineTurnId: "engine-turn-invalidated-old",
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });

    let disposeCalls = 0;
    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "error",
          message: "old provider session invalidated",
          code: "session_invalidated",
          dropSessionBinding: true,
        }),
        disposeThreadWithOptions: async () => {
          disposeCalls += 1;
        },
      } as any,
    });

    assert.equal(disposeCalls, 0);
    assert.equal(result.errored, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.droppedSessionBindings, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.turns.get(turnId)?.engineSessionId, oldSessionId);
    assert.equal(db.threads.get(threadId)?.sessionId, successorSessionId);
    assert.equal(threads.get(threadId)?.sessionId, successorSessionId);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler ownership 未物化时保留旧 turn pending 且不触碰 successor binding", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-unmaterialized-successor-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-unmaterialized-successor" as WorkspaceId;
    const threadId = "thread-codex-reconcile-unmaterialized-successor" as ThreadId;
    const turnId = "turn-codex-reconcile-unmaterialized-successor" as any;
    const oldSessionId = "engine-session-unmaterialized-old" as any;
    const successorSessionId = "engine-session-unmaterialized-successor" as any;
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "Codex unmaterialized successor", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex unmaterialized successor" });
    db.threads.setSessionId(threadId, successorSessionId);
    threads.create({
      threadId,
      workspaceId,
      engine: "codex",
      title: "Codex unmaterialized successor",
      sessionId: successorSessionId,
    });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-unmaterialized-successor" as any, userText: "old" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId: oldSessionId,
      engineTurnId: "engine-turn-unmaterialized-old",
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });

    let detachCalls = 0;
    const sessions = {
      getWorkspacePath: () => tempDir,
      reconcileCodexDanglingTurn: async () => ({
        kind: "pending",
        message: "old provider ownership did not materialize",
        code: "codex_turn_ownership_unmaterialized",
        dropSessionBinding: false,
      }),
      detachCodexProviderGeneration: () => {
        detachCalls += 1;
      },
    } as any;

    const result = await reconcileDanglingTurnsOnStartup({ db: application, threads, sessions });

    assert.equal(detachCalls, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.equal(result.droppedSessionBindings, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.turns.get(turnId)?.engineSessionId, oldSessionId);
    assert.equal(db.threads.get(threadId)?.sessionId, successorSessionId);
    assert.equal(threads.get(threadId)?.sessionId, successorSessionId);
    assert.equal(db.conversationEvents.listByThread(threadId).some((event) => event.type === "turn.error"), false);

    const retried = await reconcileDanglingTurnsOnStartup({ db: application, threads, sessions });
    assert.equal(retried.scanned, 1);
    assert.equal(retried.pending, 1);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler ownership 未物化时不进入 detach 竞态", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-unmaterialized-race-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-unmaterialized-race" as WorkspaceId;
    const threadId = "thread-codex-reconcile-unmaterialized-race" as ThreadId;
    const turnId = "turn-codex-reconcile-unmaterialized-race" as any;
    const oldSessionId = "engine-session-unmaterialized-race-old" as any;
    const successorSessionId = "engine-session-unmaterialized-race-successor" as any;
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "Codex unmaterialized race", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex unmaterialized race" });
    db.threads.setSessionId(threadId, oldSessionId);
    threads.create({
      threadId,
      workspaceId,
      engine: "codex",
      title: "Codex unmaterialized race",
      sessionId: oldSessionId,
    });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-unmaterialized-race" as any, userText: "old" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId: oldSessionId,
      engineTurnId: "engine-turn-unmaterialized-race-old",
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });

    let detachCalls = 0;
    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "pending",
          message: "old provider ownership did not materialize",
          code: "codex_turn_ownership_unmaterialized",
          dropSessionBinding: false,
        }),
        detachCodexProviderGeneration: () => {
          detachCalls += 1;
          db.threads.setSessionId(threadId, successorSessionId);
          threads.setSessionBinding(threadId, successorSessionId, null);
          throw new Error("old generation detach raced with successor binding");
        },
      } as any,
    });

    assert.equal(detachCalls, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.equal(result.droppedSessionBindings, 0);
    assert.deepEqual(result.events, []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.turns.get(turnId)?.engineSessionId, oldSessionId);
    assert.equal(db.threads.get(threadId)?.sessionId, oldSessionId);
    assert.equal(threads.get(threadId)?.sessionId, oldSessionId);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler completed 持久化失败时回滚 assistant 与 terminal", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-completed-atomic-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-completed-atomic" as WorkspaceId;
    const threadId = "thread-codex-reconcile-completed-atomic" as ThreadId;
    const turnId = "turn-codex-reconcile-completed-atomic" as any;
    const engineSessionId = "engine-session-completed-atomic" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Codex completed atomic", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex completed atomic" });
    db.threads.setSessionId(threadId, engineSessionId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-completed-atomic" as any, userText: "recover" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId,
      engineTurnId: "engine-turn-completed-atomic",
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });
    (db.turns as any).setEnded = () => {
      throw new Error("setEnded failed");
    };

    await assert.rejects(reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "completed",
          responseText: "recovered",
          assistantEvents: [{
            ts: Date.now(),
            workspaceId,
            threadId,
            engine: "codex",
            type: "item.agentMessage.completed",
            payload: {
              itemId: "item-assistant-completed-atomic" as any,
              engineMessageId: "item-assistant-completed-atomic",
              turnId,
              text: "recovered",
              revision: 1,
              completionSource: "snapshot_reconcile",
              structuredPayloadJson: null,
            },
          }],
        }),
      } as any,
    }), /setEnded failed/);

    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.deepEqual(db.conversationEvents.listByThread(threadId), []);
    assert.equal(db.db.prepare("SELECT value FROM meta WHERE key = 'event_seq_floor'").get(), undefined);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler 不把已删除且未落库的恢复消息计入成功", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-reconcile-tombstone-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:reconcile-tombstone" as WorkspaceId;
    const threadId = "thread-reconcile-tombstone" as ThreadId;
    const turnId = "turn-reconcile-tombstone" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Tombstone", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Tombstone" });
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: Date.now(), startEventSeq: 1 });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId: "provider-tombstone" as any, engineTurnId: "provider-turn-tombstone",
      source: "turn.engineBound", eventSeq: 2, observedAt: Date.now(),
    });
    db.conversationEvents.deleteMessage(threadId, "deleted-assistant");
    await assert.rejects(reconcileDanglingTurnsWithProvider({
      db: application, threads: new ThreadStore(), sessions: {
        getWorkspacePath: () => tempDir,
        /** provider 已完成，但本地删除事实禁止恢复这条正文。 */
        reconcileCodexDanglingTurn: async () => ({
          kind: "completed", responseText: "deleted", assistantEvents: [{
            ts: Date.now(), workspaceId, threadId, engine: "codex", type: "item.agentMessage.completed",
            payload: { itemId: "deleted-assistant", engineMessageId: "deleted-assistant", turnId, text: "deleted",
              revision: 1, completionSource: "snapshot_reconcile", structuredPayloadJson: null },
          }],
        }),
      } as any,
    }), /Canonical event 未写入/);
    assert.deepEqual(db.conversationEvents.listByThread(threadId), []);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.db.prepare("SELECT value FROM meta WHERE key = 'event_seq_floor'").get(), undefined);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler 精确 durable provider pair 跳过损坏 userMessage 历史", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-bad-user-message-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-bad-user-message" as WorkspaceId;
    const threadId = "thread-codex-reconcile-bad-user-message" as ThreadId;
    const turnId = "turn-codex-reconcile-bad-user-message" as any;
    const engineSessionId = "engine-session-bad-user-message" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Codex bad userMessage", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex bad userMessage" });
    db.threads.setSessionId(threadId, engineSessionId);
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 100,
    });
    db.turns.setUserMessage(turnId, { userItemId: "item-user-row-still-valid" as any, userText: "recover" });
    db.turns.setCodexProviderTurnId(turnId, {
      engineSessionId,
      engineTurnId: "engine-turn-bad-user-message",
      source: "turn.engineBound",
      eventSeq: 101,
      observedAt: Date.now() - 900,
    });
    db.db.prepare(
      "INSERT INTO conversation_events (seq, thread_id, workspace_id, engine, type, event_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(102, String(threadId), String(workspaceId), "codex", "item.userMessage.created", "{broken-json", Date.now());
    let providerCalls = 0;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async (input: any) => {
          providerCalls += 1;
          assert.equal(input.engineSessionId, engineSessionId);
          assert.equal(input.engineTurnId, "engine-turn-bad-user-message");
          assert.equal(input.exactProviderTurn, true);
          assert.equal("clientUserMessageIds" in input, false);
          return {
            kind: "pending",
            message: "provider 仍待确认",
            code: "client_restart_reconcile_timeout",
            dropSessionBinding: false,
          };
        },
        detachCodexProviderGeneration: () => {
          providerCalls += 1;
        },
        disposeThreadWithOptions: async () => {
          providerCalls += 1;
        },
      } as any,
    });

    assert.equal(providerCalls, 1);
    assert.equal(result.errored, 0);
    assert.equal(result.pending, 1);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.deepEqual(result.events, []);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler 使用启动快照保持双 started turn 的弱 session 歧义", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-reconcile-startup-snapshot-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-reconcile-startup-snapshot" as WorkspaceId;
    const threadId = "thread-codex-reconcile-startup-snapshot" as ThreadId;
    const firstTurnId = "turn-codex-reconcile-startup-snapshot-1" as any;
    const secondTurnId = "turn-codex-reconcile-startup-snapshot-2" as any;
    const oldSessionId = "engine-session-startup-snapshot-old" as any;
    const currentSessionId = "engine-session-startup-snapshot-current" as any;
    application.workspaces.upsert({ id: workspaceId, title: "Codex startup snapshot", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Codex startup snapshot" });
    db.threads.setSessionId(threadId, currentSessionId);
    for (const [index, turnId] of [firstTurnId, secondTurnId].entries()) {
      db.turns.insertStarted({
        workspaceId,
        threadId,
        engine: "codex",
        turnId,
        startedAt: Date.now() - 2_000 + index,
        startEventSeq: 100 + index,
      });
      db.turns.setUserMessage(turnId, { userItemId: `item-user-startup-snapshot-${index}` as any, userText: "recover" });
    }
    db.turns.setCodexProviderTurnId(firstTurnId, {
      engineSessionId: oldSessionId,
      engineTurnId: "engine-turn-startup-snapshot-old",
      source: "turn.engineBound",
      eventSeq: 102,
      observedAt: Date.now() - 1_500,
    });
    let reconcileCalls = 0;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async (input: any) => {
          reconcileCalls += 1;
          assert.equal(input.turnId, firstTurnId);
          return { kind: "completed", responseText: "old complete", assistantEvents: [] };
        },
      } as any,
    });

    assert.equal(reconcileCalls, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.pending, 1);
    assert.equal(db.turns.get(firstTurnId)?.status, "completed");
    assert.equal(db.turns.get(secondTurnId)?.status, "started");
    assert.equal(db.threads.get(threadId)?.sessionId, currentSessionId);
    assert.deepEqual(result.events.map((event) => event.type), ["turn.completed"]);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler 直接使用 start attempt 中完整的 provider pair", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-start-attempt-actual-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-start-attempt-actual" as WorkspaceId;
    const threadId = "thread-codex-start-attempt-actual" as ThreadId;
    const turnId = "turn-codex-start-attempt-actual" as any;
    application.workspaces.upsert({ id: workspaceId, title: "start attempt actual", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "start attempt actual" });
    db.turns.setCodexStartAttempt({
      workspaceId,
      threadId,
      turnId,
      clientUserMessageId: "item-user-codex-start-attempt-actual",
      providerThreadId: "provider-thread-codex-start-attempt-actual" as any,
      provisionalProviderTurnId: "provider-turn-ghost-a",
      attemptId: 1,
      observedAt: Date.now() - 1_000,
    });

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads: new ThreadStore(),
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async (input: any) => {
          assert.equal(input.engineSessionId, "provider-thread-codex-start-attempt-actual");
          assert.equal(input.engineTurnId, "provider-turn-ghost-a");
          assert.equal(input.exactProviderTurn, true);
          assert.equal("clientUserMessageIds" in input, false);
          return {
            kind: "pending",
            message: "provider turn 仍在运行",
            code: "client_restart_reconcile_timeout",
            dropSessionBinding: false,
            actualEngineTurnId: "provider-turn-ghost-a",
          };
        },
      } as any,
    });

    const checkpoint = JSON.parse(String(db.turns.get(turnId)?.engineCheckpointJson));
    assert.equal(result.pending, 1);
    assert.equal(checkpoint.codexStartAttempt.provisionalProviderTurnId, "provider-turn-ghost-a");
    assert.equal(checkpoint.codexProviderTurn.engineTurnId, "provider-turn-ghost-a");
    assert.equal(checkpoint.codexProviderTurn.engineSessionId, "provider-thread-codex-start-attempt-actual");
    assert.equal(checkpoint.codexProviderTurn.supersededEngineTurnIds, undefined);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler 在 start attempt ownership 未物化时保留 provider 证据与 running", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-start-attempt-unmaterialized-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-start-attempt-unmaterialized" as WorkspaceId;
    const threadId = "thread-codex-start-attempt-unmaterialized" as ThreadId;
    const turnId = "turn-codex-start-attempt-unmaterialized" as any;
    const providerThreadId = "provider-thread-codex-start-attempt-unmaterialized";
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "start attempt unmaterialized", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "start attempt unmaterialized" });
    db.turns.setCodexStartAttempt({
      workspaceId,
      threadId,
      turnId,
      clientUserMessageId: "item-user-codex-start-attempt-unmaterialized",
      providerThreadId: providerThreadId as any,
      provisionalProviderTurnId: "provider-turn-codex-start-attempt-unmaterialized",
      attemptId: 1,
      observedAt: Date.now() - 1_000,
    });
    let detachCalls = 0;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "pending",
          message: "clientUserMessageId 未在 provider 历史中物化",
          code: "codex_turn_ownership_unmaterialized",
          dropSessionBinding: false,
        }),
        detachCodexProviderGeneration: (_threadId: string, expectedSessionId: string, recovery: any) => {
          detachCalls += 1;
          assert.equal(expectedSessionId, providerThreadId);
          assert.equal(recovery.provisionalProviderTurnId, "provider-turn-codex-start-attempt-unmaterialized");
          threads.dropSessionBinding(threadId);
        },
      } as any,
    });

    assert.equal(detachCalls, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.equal(result.droppedSessionBindings, 0);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.deepEqual(result.events, []);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("startup reconciler 保留 start attempt 旧 turn pending 且不触碰 successor generation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-start-attempt-successor-"));
  const application = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  let db: ReturnType<typeof application.forWorkspace>;
  try {
    const workspaceId = "client-test:ws-codex-start-attempt-successor" as WorkspaceId;
    const threadId = "thread-codex-start-attempt-successor" as ThreadId;
    const turnId = "turn-codex-start-attempt-successor" as any;
    const oldProviderThreadId = "provider-thread-codex-start-attempt-old";
    const successorProviderThreadId = "provider-thread-codex-start-attempt-successor";
    const threads = new ThreadStore();
    application.workspaces.upsert({ id: workspaceId, title: "start attempt successor", path: tempDir });
    db = application.forWorkspace(workspaceId);
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "start attempt successor" });
    db.threads.setSessionId(threadId, successorProviderThreadId as any);
    threads.create({
      threadId,
      workspaceId,
      engine: "codex",
      title: "start attempt successor",
      sessionId: successorProviderThreadId as any,
    });
    db.turns.setCodexStartAttempt({
      workspaceId,
      threadId,
      turnId,
      clientUserMessageId: "item-user-codex-start-attempt-successor",
      providerThreadId: oldProviderThreadId as any,
      provisionalProviderTurnId: "provider-turn-codex-start-attempt-old",
      attemptId: 1,
      observedAt: Date.now() - 1_000,
    });
    let detachCalls = 0;

    const result = await reconcileDanglingTurnsOnStartup({
      db: application,
      threads,
      sessions: {
        getWorkspacePath: () => tempDir,
        reconcileCodexDanglingTurn: async () => ({
          kind: "pending",
          message: "old start attempt ownership 未物化",
          code: "codex_turn_ownership_unmaterialized",
          dropSessionBinding: false,
        }),
        detachCodexProviderGeneration: () => {
          detachCalls += 1;
        },
      } as any,
    });

    assert.equal(detachCalls, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.errored, 0);
    assert.equal(result.droppedSessionBindings, 0);
    assert.equal(db.turns.get(turnId)?.status, "started");
    assert.equal(db.threads.get(threadId)?.sessionId, successorProviderThreadId);
    assert.equal(threads.get(threadId)?.sessionId, successorProviderThreadId);
  } finally {
    application.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
