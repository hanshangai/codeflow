import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ConversationEventEnvelope,
  ThreadId,
  ThreadSessionCapabilities,
  TurnId,
  WorkspaceId,
} from "@codeflowai/shared";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { ThreadSessionManager } from "../../apps/desktop/client/src/engines/threadSessionManager.ts";
import {
  applyThreadStartedBinding,
  prepareThreadStartedBindingAck,
  resolveThreadStartedBinding,
} from "../../apps/desktop/client/src/eventIndex/threadStartedBinding.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";

/** 构造最小 thread.started ACK。 */
function createThreadStartedEvent(input: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  engine: "claude" | "codex";
  sessionId: string;
}): ConversationEventEnvelope {
  return {
    schema: 1,
    seq: 1,
    ts: Date.now(),
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    engine: input.engine,
    type: "thread.started",
    payload: { sessionId: input.sessionId as any },
  } as ConversationEventEnvelope;
}

test("缺失 thread 的 thread.started 不进入 canonical buffer，也不重建 thread", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-started-missing-"));
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  try {
    const workspaceId = "ws-thread-started-missing" as WorkspaceId;
    const threadId = "thread-started-missing" as ThreadId;
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: tempDir });
    const event = createThreadStartedEvent({
      workspaceId,
      threadId,
      engine: "codex",
      sessionId: "session-missing",
    });
    const pendingCanonicalAcks: ConversationEventEnvelope[] = [];
    const plan = prepareThreadStartedBindingAck(db, event, (ack) => pendingCanonicalAcks.push(ack));

    assert.equal(plan.kind, "missing_thread");
    assert.deepEqual(pendingCanonicalAcks, []);
    applyThreadStartedBinding(db, plan);
    assert.equal(db.threads.get(threadId), null);
    assert.equal(db.turns.listByThread(threadId).length, 0);
    assert.equal(db.conversationEvents.listByThread(threadId, { limit: 10 }).length, 0);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("仍存在的 thread 若 workspace 或 engine 不匹配则显式失败", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-started-scope-"));
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  try {
    const workspaceId = "ws-thread-started-scope" as WorkspaceId;
    const threadId = "thread-started-scope" as ThreadId;
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: tempDir });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "scope" });
    const pendingCanonicalAcks: ConversationEventEnvelope[] = [];

    assert.throws(() => prepareThreadStartedBindingAck(db, createThreadStartedEvent({
      workspaceId,
      threadId,
      engine: "claude",
      sessionId: "session-wrong-engine",
    }), (ack) => pendingCanonicalAcks.push(ack)), /scope 不匹配/);
    assert.throws(() => prepareThreadStartedBindingAck(db, createThreadStartedEvent({
      workspaceId: "ws-other" as WorkspaceId,
      threadId,
      engine: "codex",
      sessionId: "session-wrong-workspace",
    }), (ack) => pendingCanonicalAcks.push(ack)), /scope 不匹配/);
    assert.equal(pendingCanonicalAcks.length, 0);
    assert.equal(db.threads.get(threadId)?.sessionId, null);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude 回填 thread turns，而 Codex 只更新 thread binding", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-started-engine-"));
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  try {
    const workspaceId = "ws-thread-started-engine" as WorkspaceId;
    const claudeThreadId = "thread-started-claude" as ThreadId;
    const codexThreadId = "thread-started-codex" as ThreadId;
    const claudeTurnId = "turn-started-claude" as TurnId;
    const codexTurnId = "turn-started-codex" as TurnId;
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: tempDir });
    db.threads.create({ id: claudeThreadId, workspaceId, engine: "claude", title: "Claude" });
    db.threads.create({ id: codexThreadId, workspaceId, engine: "codex", title: "Codex" });
    db.turns.insertStarted({
      workspaceId,
      threadId: claudeThreadId,
      engine: "claude",
      turnId: claudeTurnId,
      startedAt: 1,
      startEventSeq: 1,
    });
    db.turns.insertStarted({
      workspaceId,
      threadId: codexThreadId,
      engine: "codex",
      turnId: codexTurnId,
      startedAt: 2,
      startEventSeq: 2,
    });

    applyThreadStartedBinding(db, resolveThreadStartedBinding(db, createThreadStartedEvent({
      workspaceId,
      threadId: claudeThreadId,
      engine: "claude",
      sessionId: "session-claude",
    })));
    db.threads.setSessionId(codexThreadId, "session-codex" as any);
    applyThreadStartedBinding(db, resolveThreadStartedBinding(db, createThreadStartedEvent({
      workspaceId,
      threadId: codexThreadId,
      engine: "codex",
      sessionId: "session-codex",
    }), "session-codex" as any));

    assert.equal(db.threads.get(claudeThreadId)?.sessionId, "session-claude");
    assert.equal(db.turns.get(claudeTurnId)?.engineSessionId, "session-claude");
    assert.equal(db.threads.get(codexThreadId)?.sessionId, "session-codex");
    assert.equal(db.turns.get(codexTurnId)?.engineSessionId, null);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Codex thread.started 仅确认已持久化 generation，分歧或 detached ACK 只保留证据", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-started-generation-"));
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  try {
    const workspaceId = "ws-thread-started-generation" as WorkspaceId;
    const threadId = "thread-started-generation" as ThreadId;
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: tempDir });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "generation" });
    db.threads.setSessionId(threadId, "session-b" as any);
    const pendingCanonicalAcks: ConversationEventEnvelope[] = [];

    const stale = prepareThreadStartedBindingAck(db, createThreadStartedEvent({
      workspaceId,
      threadId,
      engine: "codex",
      sessionId: "session-a",
    }), (ack) => pendingCanonicalAcks.push(ack), "session-b" as any);
    assert.equal(stale.kind, "stale_binding");
    applyThreadStartedBinding(db, stale);
    assert.equal(db.threads.get(threadId)?.sessionId, "session-b");
    assert.equal(pendingCanonicalAcks.length, 1);

    db.threads.setSessionId(threadId, "session-a" as any);
    const runtimeCannotReplacePersisted = prepareThreadStartedBindingAck(db, createThreadStartedEvent({
      workspaceId,
      threadId,
      engine: "codex",
      sessionId: "session-b",
    }), (ack) => pendingCanonicalAcks.push(ack), "session-b" as any);
    assert.equal(runtimeCannotReplacePersisted.kind, "stale_binding");
    if (runtimeCannotReplacePersisted.kind === "stale_binding") {
      assert.equal(runtimeCannotReplacePersisted.reason, "persisted_mismatch");
    }
    applyThreadStartedBinding(db, runtimeCannotReplacePersisted);
    assert.equal(db.threads.get(threadId)?.sessionId, "session-a");

    db.threads.setSessionId(threadId, "session-b" as any);
    const persistedCannotBeRolledBack = prepareThreadStartedBindingAck(db, createThreadStartedEvent({
      workspaceId,
      threadId,
      engine: "codex",
      sessionId: "session-a",
    }), (ack) => pendingCanonicalAcks.push(ack), "session-a" as any);
    assert.equal(persistedCannotBeRolledBack.kind, "stale_binding");
    if (persistedCannotBeRolledBack.kind === "stale_binding") {
      assert.equal(persistedCannotBeRolledBack.reason, "persisted_mismatch");
    }
    applyThreadStartedBinding(db, persistedCannotBeRolledBack);
    assert.equal(db.threads.get(threadId)?.sessionId, "session-b");

    const current = prepareThreadStartedBindingAck(db, createThreadStartedEvent({
      workspaceId,
      threadId,
      engine: "codex",
      sessionId: "session-b",
    }), (ack) => pendingCanonicalAcks.push(ack), "session-b" as any);
    assert.equal(current.kind, "apply");
    applyThreadStartedBinding(db, current);
    assert.equal(db.threads.get(threadId)?.sessionId, "session-b");

    db.threads.clearSessionId(threadId);
    const runtimeOnly = resolveThreadStartedBinding(db, createThreadStartedEvent({
      workspaceId,
      threadId,
      engine: "codex",
      sessionId: "session-b",
    }), "session-b" as any);
    assert.equal(runtimeOnly.kind, "stale_binding");
    if (runtimeOnly.kind === "stale_binding") {
      assert.equal(runtimeOnly.reason, "runtime_without_persisted");
    }
    applyThreadStartedBinding(db, runtimeOnly);
    assert.equal(db.threads.get(threadId)?.sessionId, null);

    const detached = resolveThreadStartedBinding(db, createThreadStartedEvent({
      workspaceId,
      threadId,
      engine: "codex",
      sessionId: "session-a",
    }), null);
    assert.equal(detached.kind, "stale_binding");
    if (detached.kind === "stale_binding") assert.equal(detached.reason, "detached");
    applyThreadStartedBinding(db, detached);
    assert.equal(db.threads.get(threadId)?.sessionId, null);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ThreadSessionManager 通过 ThreadRepo CAS 清理旧 binding，并拒绝换代值、兼容已空", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-binding-cas-"));
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  try {
    const workspaceId = "ws-thread-binding-cas" as WorkspaceId;
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: tempDir });
    const threads = new ThreadStore();
    const sessions = new ThreadSessionManager({
      writeWorkspaceLog: () => {},
      workspaces: new Map([[workspaceId, tempDir]]),
      threads,
      clearPersistedSessionBinding(threadId, expectedSessionId) {
        if (expectedSessionId) return db.threads.clearSessionBindingIfMatches(threadId, expectedSessionId);
        db.threads.clearSessionId(threadId);
      },
      sessionIdleCleanup: { enabled: false },
    });

    const clearedThreadId = "thread-binding-cas-cleared" as ThreadId;
    db.threads.create({ id: clearedThreadId, workspaceId, engine: "codex", title: "binding CAS cleared" });
    db.threads.setSessionBinding(clearedThreadId, "session-old" as any, {
      codexDynamicToolIds: ["runtime.example"],
      codexDynamicToolBindingVersion: "binding-old",
    });
    const clearedRuntime = threads.create({
      threadId: clearedThreadId,
      workspaceId,
      engine: "codex",
      title: "binding CAS cleared",
      sessionId: "session-old" as any,
    });
    const clearedSession = sessions.getOrCreate(clearedRuntime);

    (clearedSession as any).dropSessionBinding();
    assert.equal(db.threads.get(clearedThreadId)?.sessionId, null);
    assert.equal(db.threads.get(clearedThreadId)?.sessionCapabilities, null);
    assert.equal(clearedRuntime.sessionId, null);

    const successorThreadId = "thread-binding-cas-successor" as ThreadId;
    db.threads.create({ id: successorThreadId, workspaceId, engine: "codex", title: "binding CAS successor" });
    db.threads.setSessionBinding(successorThreadId, "session-old" as any, null);
    const successorRuntime = threads.create({
      threadId: successorThreadId,
      workspaceId,
      engine: "codex",
      title: "binding CAS successor",
      sessionId: "session-old" as any,
    });
    const successorSession = sessions.getOrCreate(successorRuntime);
    db.threads.setSessionBinding(successorThreadId, "session-successor" as any, {
      codexDynamicToolBindingVersion: "binding-successor",
    });

    assert.throws(
      () => (successorSession as any).dropSessionBinding(),
      /拒绝清除新 persisted 绑定.*expected=session-old.*actual=session-successor/,
    );
    assert.equal(db.threads.get(successorThreadId)?.sessionId, "session-successor");
    assert.equal(db.threads.get(successorThreadId)?.sessionCapabilities?.codexDynamicToolBindingVersion, "binding-successor");
    assert.equal(successorRuntime.sessionId, "session-old");

    db.threads.clearSessionId(successorThreadId);
    assert.equal(sessions.getOrCreate(successorRuntime), successorSession);
    assert.equal(db.threads.get(successorThreadId)?.sessionId, null);
    assert.equal(successorRuntime.sessionId, null);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ThreadRepo 按 provider binding CAS 回填能力，拒绝覆盖换代或缺失 thread", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-capability-restore-"));
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  try {
    const workspaceId = "ws-thread-capability-restore" as WorkspaceId;
    const threadId = "thread-capability-restore" as ThreadId;
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: tempDir });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "capability restore" });
    db.threads.setSessionBinding(threadId, "session-original" as any, {
      codexDynamicToolIds: ["runtime.z", "runtime.a", "runtime.a"],
      codexDynamicToolBindingVersion: "binding-original",
    });

    const restoredCapabilities: ThreadSessionCapabilities = {
      codexDynamicToolIds: ["runtime.new.z", "runtime.new.a", "runtime.new.a"],
      codexDynamicToolBindingVersion: "binding-restored",
    };
    assert.deepEqual(
      db.threads.restoreSessionCapabilitiesIfMatches(threadId, "session-original" as any, restoredCapabilities),
      { kind: "restored" },
    );
    assert.equal(db.threads.get(threadId)?.sessionId, "session-original");
    assert.deepEqual(db.threads.get(threadId)?.sessionCapabilities, {
      codexDynamicToolIds: ["runtime.new.a", "runtime.new.z"],
      codexDynamicToolBindingVersion: "binding-restored",
    });

    db.threads.setSessionBinding(threadId, "session-successor" as any, {
      codexDynamicToolIds: ["runtime.successor"],
      codexDynamicToolBindingVersion: "binding-successor",
    });
    assert.deepEqual(
      db.threads.restoreSessionCapabilitiesIfMatches(threadId, "session-original" as any, {
        codexDynamicToolIds: ["runtime.stale"],
        codexDynamicToolBindingVersion: "binding-stale",
      }),
      { kind: "session_mismatch", actualSessionId: "session-successor" },
    );
    assert.equal(db.threads.get(threadId)?.sessionId, "session-successor");
    assert.deepEqual(db.threads.get(threadId)?.sessionCapabilities, {
      codexDynamicToolIds: ["runtime.successor"],
      codexDynamicToolBindingVersion: "binding-successor",
    });

    db.threads.clearSessionId(threadId);
    assert.deepEqual(
      db.threads.restoreSessionCapabilitiesIfMatches(threadId, "session-successor" as any, {
        codexDynamicToolIds: ["runtime.after-clear"],
      }),
      { kind: "session_mismatch", actualSessionId: null },
    );
    assert.equal(db.threads.get(threadId)?.sessionCapabilities, null);

    assert.deepEqual(
      db.threads.restoreSessionCapabilitiesIfMatches("thread-missing" as ThreadId, "session-missing" as any, {
        codexDynamicToolIds: ["runtime.missing"],
      }),
      { kind: "thread_missing" },
    );
    assert.throws(
      () => db.threads.restoreSessionCapabilitiesIfMatches(threadId, "   " as any, { codexDynamicToolIds: [] }),
      (error: unknown) => (error as { code?: string }).code === "thread_session_capability_expected_id_invalid",
    );
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
