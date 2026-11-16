import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ThreadId, WorkspaceId } from "../../packages/shared/src/index.ts";
import {
  findCodexClientUserMessageIdsFromHistory,
  findCodexProviderTurnIdentityFromHistory,
  findCodexProviderTurnPairFromHistory,
  findCodexTurnIdFromHistory,
} from "../../apps/desktop/client/src/app/utils/codexTurnHistory.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { ConversationEventRepo } from "../../apps/desktop/client/src/db/repos/eventRepo.ts";
import {
  decideCodexProviderTurnMapping,
  type CodexProviderTurnMappingCandidate,
} from "../../apps/desktop/client/src/db/repos/codexProviderTurnMapping.ts";

/** 同步和异步仓储测试共用数据库生命周期，异步读取结束后才清理。 */
function withCodexTurnHistoryDb<T>(
  slug: string,
  run: (input: {
    db: ReturnType<typeof openClientDb>;
    workspaceId: WorkspaceId;
    threadId: ThreadId;
  }) => T,
): T {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), `codeflowai-${slug}-`));
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  const workspaceId = `ws-${slug}` as WorkspaceId;
  const threadId = `thread-${slug}` as ThreadId;
  /** 只清理当前测试创建的临时数据库。 */
  const cleanup = () => {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  };
  let pending = false;
  try {
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: slug });
    const result = run({ db, workspaceId, threadId });
    if (result instanceof Promise) {
      pending = true;
      return result.finally(cleanup) as T;
    }
    return result;
  } finally {
    if (!pending) cleanup();
  }
}

test("Codex start attempt 在 canonical ACK 前落入 thread checkpoint 并可跨 reopen 读取", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-start-attempt-reopen-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-codex-start-attempt-reopen" as WorkspaceId;
  const threadId = "thread-codex-start-attempt-reopen" as ThreadId;
  const turnId = "turn-codex-start-attempt-reopen" as any;
  let db = openClientDb({ dbPath });
  try {
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "start attempt" });
    db.turns.setCodexStartAttempt({
      workspaceId,
      threadId,
      turnId,
      clientUserMessageId: "item-user-start-attempt",
      providerThreadId: "provider-thread-start-attempt" as any,
      provisionalProviderTurnId: "provider-turn-start-attempt",
      attemptId: 1,
      observedAt: 1_000,
    });
    assert.equal(db.turns.get(turnId)?.startEventSeq, null);
    db.close();

    db = openClientDb({ dbPath });
    assert.deepEqual(db.turns.getCodexStartAttempt(turnId), {
      v: 1,
      clientUserMessageId: "item-user-start-attempt",
      providerThreadId: "provider-thread-start-attempt",
      provisionalProviderTurnId: "provider-turn-start-attempt",
      attemptId: 1,
      observedAt: 1_000,
    });
    assert.deepEqual(findCodexProviderTurnIdentityFromHistory(db, { threadId, clientTurnId: turnId }), {
      engineSessionId: "provider-thread-start-attempt",
      engineTurnId: "provider-turn-start-attempt",
      engineSessionSource: "start_attempt",
    });
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("Codex canonical turn.started 回填 provisional 预建行但不复活终态", () => {
  withCodexTurnHistoryDb("start-attempt-terminal-ack", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-start-attempt-terminal-ack" as any;
    db.turns.setCodexStartAttempt({
      workspaceId,
      threadId,
      turnId,
      clientUserMessageId: "item-user-start-attempt-terminal-ack",
      providerThreadId: "provider-thread-start-attempt-terminal-ack" as any,
      provisionalProviderTurnId: "provider-turn-start-attempt-terminal-ack",
      attemptId: 1,
      observedAt: 2_000,
    });
    db.turns.setEnded(turnId, { status: "error", endedAt: 2_100, endEventSeq: 4 });

    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId,
      startedAt: 1_900,
      startEventSeq: 3,
    });

    const turn = db.turns.get(turnId);
    assert.equal(turn?.status, "error");
    assert.equal(turn?.startedAt, 1_900);
    assert.equal(turn?.startEventSeq, 3);
    assert.equal(db.turns.getCodexStartAttempt(turnId)?.provisionalProviderTurnId, "provider-turn-start-attempt-terminal-ack");
  });
});

test("Codex start attempt 只允许同一 client ownership 的单调 attempt 更新", () => {
  withCodexTurnHistoryDb("start-attempt-fence", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-start-attempt-fence" as any;
    const base = {
      workspaceId,
      threadId,
      turnId,
      clientUserMessageId: "item-user-start-attempt-fence",
      providerThreadId: "provider-thread-start-attempt-fence" as any,
      provisionalProviderTurnId: "provider-turn-start-attempt-1",
      attemptId: 1,
      observedAt: 1_000,
    };
    db.turns.setCodexStartAttempt(base);
    db.turns.setCodexStartAttempt(base);
    db.turns.setCodexStartAttempt({
      ...base,
      provisionalProviderTurnId: "provider-turn-start-attempt-2",
      attemptId: 2,
      observedAt: 2_000,
    });
    db.turns.setCodexStartAttempt(base);
    assert.equal(db.turns.getCodexStartAttempt(turnId)?.provisionalProviderTurnId, "provider-turn-start-attempt-2");
    assert.throws(
      () => db.turns.setCodexStartAttempt({
        ...base,
        provisionalProviderTurnId: "provider-turn-start-attempt-conflict",
        attemptId: 2,
        observedAt: 2_100,
      }),
      /settlement conflict/,
    );
    assert.throws(
      () => db.turns.setCodexStartAttempt({
        ...base,
        clientUserMessageId: "item-user-start-attempt-foreign",
        attemptId: 3,
        observedAt: 3_000,
      }),
      /clientUserMessageId mismatch|ownership conflict/,
    );
  });
});

test("Codex 已确权历史 turn B 覆盖 start attempt ghost A，但沿用 attempt 的 provider thread", () => {
  withCodexTurnHistoryDb("start-attempt-provider-successor", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-start-attempt-provider-successor" as any;
    db.turns.setCodexStartAttempt({
      workspaceId,
      threadId,
      turnId,
      clientUserMessageId: "item-user-start-attempt-provider-successor",
      providerThreadId: "provider-thread-start-attempt-provider-successor" as any,
      provisionalProviderTurnId: "provider-turn-ghost-a",
      attemptId: 1,
      observedAt: 1_000,
    });
    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 2,
      ts: 1_100,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      clientTurnId: turnId,
      data: {
        method: "turn/started",
        params: { turn: { id: "provider-turn-confirmed-b" } },
      },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    } as any);

    assert.deepEqual(findCodexProviderTurnIdentityFromHistory(db, { threadId, clientTurnId: turnId }), {
      engineSessionId: "provider-thread-start-attempt-provider-successor",
      engineTurnId: "provider-turn-confirmed-b",
      engineSessionSource: "start_attempt",
    });
  });
});

test("thread turn repo lists running turns by workspace", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-turn-repo-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-turns" as WorkspaceId;

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      db.threads.create({
        id: "thread-running" as ThreadId,
        workspaceId,
        engine: "codex",
        title: "运行中会话",
      });
      db.threads.create({
        id: "thread-completed" as ThreadId,
        workspaceId,
        engine: "codex",
        title: "已完成会话",
      });

      db.turns.insertStarted({
        workspaceId,
        threadId: "thread-running" as ThreadId,
        engine: "codex",
        turnId: "turn-running" as any,
        startedAt: 200,
        startEventSeq: 2,
      });
      db.turns.insertStarted({
        workspaceId,
        threadId: "thread-completed" as ThreadId,
        engine: "codex",
        turnId: "turn-completed" as any,
        startedAt: 100,
        startEventSeq: 1,
      });
      db.turns.setEnded("turn-completed" as any, {
        status: "completed",
        endedAt: 150,
        endEventSeq: 3,
      });

      assert.deepEqual(db.turns.listRunningByWorkspace(workspaceId), {
        "thread-running": {
          runningTurnId: "turn-running",
          runningTurnStartedAt: 200,
        },
      });
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread turn repo can answer thread real-turn activity via exists query", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-turn-exists-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-turn-exists" as WorkspaceId;

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      db.threads.create({
        id: "thread-empty" as ThreadId,
        workspaceId,
        engine: "codex",
        title: "空会话",
      });
      db.threads.create({
        id: "thread-active" as ThreadId,
        workspaceId,
        engine: "codex",
        title: "有 turn 的会话",
      });

      assert.equal(db.turns.hasAnyByThread("thread-empty" as ThreadId), false);

      db.turns.insertStarted({
        workspaceId,
        threadId: "thread-active" as ThreadId,
        engine: "codex",
        turnId: "turn-active" as any,
        startedAt: 300,
        startEventSeq: 5,
      });

      assert.equal(db.turns.hasAnyByThread("thread-active" as ThreadId), true);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread turn repo shallow-merges engine checkpoints without dropping legacy keys", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-turn-checkpoint-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-turn-checkpoint" as WorkspaceId;
  const threadId = "thread-checkpoint" as ThreadId;
  const turnId = "turn-checkpoint" as any;

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "checkpoint" });
      db.turns.insertStarted({
        workspaceId,
        threadId,
        engine: "codex",
        turnId,
        startedAt: 100,
        startEventSeq: 1,
      });
      db.turns.setEngineCheckpoint(turnId, JSON.stringify({
        sessionFileByteLen: 42,
        legacyKey: { keep: true },
        codexFileChanges: { v: 1, paths: ["old.txt"], status: "pending" },
      }));

      const serialized = db.turns.mergeEngineCheckpoint(turnId, {
        codexFileChanges: { v: 1, paths: ["new.txt"], status: "complete" },
      });
      const expected = {
        sessionFileByteLen: 42,
        legacyKey: { keep: true },
        codexFileChanges: { v: 1, paths: ["new.txt"], status: "complete" },
      };
      assert.deepEqual(JSON.parse(serialized), expected);
      assert.deepEqual(JSON.parse(String(db.turns.get(turnId)?.engineCheckpointJson)), expected);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread turn repo persists and authoritatively replaces Codex provider turn mappings", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-turn-provider-map-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-turn-provider-map" as WorkspaceId;
  const threadId = "thread-provider-map" as ThreadId;
  const turnId = "turn-provider-map" as any;
  const siblingTurnId = "turn-provider-map-sibling" as any;

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "provider map" });
      db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
      db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId: siblingTurnId, startedAt: 90, startEventSeq: 0 });
      db.turns.setEngineCheckpoint(turnId, JSON.stringify({ legacyKey: { keep: true } }));

      db.turns.setCodexProviderTurnId(turnId, {
        engineTurnId: "provider-raw",
        source: "turn/started",
        eventSeq: 2,
        observedAt: 110,
      });
      db.turns.setCodexProviderTurnId(turnId, {
        engineTurnId: "provider-authoritative",
        engineSessionId: "session-provider-map" as any,
        previousEngineTurnId: "provider-raw",
        source: "turn.engineBound",
        eventSeq: 3,
        observedAt: 120,
      });

      const checkpoint = JSON.parse(String(db.turns.get(turnId)?.engineCheckpointJson));
      assert.deepEqual(checkpoint.legacyKey, { keep: true });
      assert.deepEqual(checkpoint.codexProviderTurn, {
        v: 1,
        source: "turn.engineBound",
        engineTurnId: "provider-authoritative",
        engineSessionId: "session-provider-map",
        previousEngineTurnId: "provider-raw",
        supersededEngineTurnIds: ["provider-raw"],
        eventSeq: 3,
        observedAt: 120,
      });
      assert.equal(db.turns.get(turnId)?.engineSessionId, "session-provider-map");
      assert.equal(db.turns.get(siblingTurnId)?.engineSessionId, null);
      const authoritativeCheckpoint = String(db.turns.get(turnId)?.engineCheckpointJson);
      assert.equal(
        db.turns.setCodexProviderTurnId(turnId, {
          engineTurnId: "provider-raw",
          source: "turn/started",
          eventSeq: 4,
          observedAt: 130,
        }),
        authoritativeCheckpoint,
      );
      assert.throws(
        () => db.turns.setCodexProviderTurnId(turnId, {
          engineTurnId: "provider-conflict",
          source: "turn/started",
          eventSeq: 4,
          observedAt: 130,
        }),
        /mapping conflict/,
      );
      assert.throws(
        () => db.turns.setCodexProviderTurnId(turnId, {
          engineTurnId: "provider-stale-replacement",
          engineSessionId: "session-provider-map" as any,
          previousEngineTurnId: "provider-authoritative",
          source: "turn.engineBound",
          eventSeq: 2,
          observedAt: 140,
        }),
        /mapping conflict/,
      );
      assert.throws(
        () => db.turns.setCodexProviderTurnId(turnId, {
          engineTurnId: "provider-wrong-session",
          engineSessionId: "session-other" as any,
          previousEngineTurnId: "provider-authoritative",
          source: "turn.engineBound",
          eventSeq: 5,
          observedAt: 150,
        }),
        /session mismatch/,
      );
      assert.equal(String(db.turns.get(turnId)?.engineCheckpointJson), authoritativeCheckpoint);

      db.turns.setCodexProviderTurnId(turnId, {
        engineTurnId: "provider-final",
        engineSessionId: "session-provider-map" as any,
        previousEngineTurnId: "provider-authoritative",
        source: "turn.engineBound",
        eventSeq: 6,
        observedAt: 160,
      });
      const finalCheckpoint = String(db.turns.get(turnId)?.engineCheckpointJson);
      assert.deepEqual(JSON.parse(finalCheckpoint).codexProviderTurn.supersededEngineTurnIds, [
        "provider-raw",
        "provider-authoritative",
      ]);
      assert.equal(db.turns.setCodexProviderTurnId(turnId, {
        engineTurnId: "provider-raw",
        source: "turn/started",
        eventSeq: 7,
        observedAt: 170,
      }), finalCheckpoint);
      db.rawEvents.appendEnvelope({
        schema: 1,
        seq: 7,
        ts: 170,
        workspaceId,
        threadId,
        engine: "codex",
        source: "codex.app-server.msg",
        data: { method: "turn/started", params: { turn: { id: "provider-raw" } } },
        handled: true,
        action: "mapped",
        emittedTypes: [],
      });
      assert.equal(findCodexTurnIdFromHistory(db, { threadId, clientTurnId: turnId }), "provider-final");

      // 模拟旧版本只写 checkpoint、遗漏 thread_turns.engine_session_id 的数据；
      // pair fallback 在完成跨证据校验后会精确自愈当前 turn。
      db.db.prepare("UPDATE thread_turns SET engine_session_id = NULL WHERE turn_id = ?").run(String(turnId));
      assert.equal(db.turns.get(turnId)?.engineSessionId, null);
      assert.deepEqual(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }), {
        engineSessionId: "session-provider-map",
        engineTurnId: "provider-final",
      });
      assert.equal(db.turns.get(turnId)?.engineSessionId, "session-provider-map");
      assert.equal(db.turns.get(siblingTurnId)?.engineSessionId, null);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("Codex canonical turn binding repairs legacy thread-wide session backfill without touching siblings", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-turn-session-repair-"));
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  const workspaceId = "ws-turn-session-repair" as WorkspaceId;
  const threadId = "thread-turn-session-repair" as ThreadId;
  const targetTurnId = "turn-session-repair-target" as any;
  const rawTargetTurnId = "turn-session-repair-raw-target" as any;
  const siblingTurnId = "turn-session-repair-sibling" as any;

  try {
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "session repair" });
    for (const [turnId, seq] of [[targetTurnId, 1], [rawTargetTurnId, 2], [siblingTurnId, 3]] as const) {
      db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: seq * 100, startEventSeq: seq });
    }
    db.turns.setCodexProviderTurnId(rawTargetTurnId, {
      engineTurnId: "provider-raw-before-canonical",
      source: "turn/started",
      eventSeq: 4,
      observedAt: 400,
    });

    // 模拟旧版本用新 generation B 污染同线程全部空 session 的历史 turn。
    db.turns.setEngineSessionIdByThread(threadId, "session-generation-b" as any);
    db.turns.setCodexProviderTurnId(targetTurnId, {
      engineTurnId: "provider-target-a",
      engineSessionId: "session-generation-a" as any,
      source: "turn.engineBound",
      eventSeq: 5,
      observedAt: 500,
    });
    db.turns.setCodexProviderTurnId(rawTargetTurnId, {
      engineTurnId: "provider-target-c",
      engineSessionId: "session-generation-c" as any,
      previousEngineTurnId: "provider-raw-before-canonical",
      source: "turn.engineBound",
      eventSeq: 6,
      observedAt: 600,
    });

    assert.equal(db.turns.get(targetTurnId)?.engineSessionId, "session-generation-a");
    assert.equal(db.turns.get(rawTargetTurnId)?.engineSessionId, "session-generation-c");
    assert.equal(db.turns.get(siblingTurnId)?.engineSessionId, "session-generation-b");
    assert.equal(
      JSON.parse(String(db.turns.get(targetTurnId)?.engineCheckpointJson)).codexProviderTurn.engineTurnId,
      "provider-target-a",
    );
    assert.equal(
      JSON.parse(String(db.turns.get(rawTargetTurnId)?.engineCheckpointJson)).codexProviderTurn.engineTurnId,
      "provider-target-c",
    );
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("Codex provider history atomically replays canonical binding over a polluted turn row", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-turn-history-session-repair-"));
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  const workspaceId = "ws-turn-history-session-repair" as WorkspaceId;
  const threadId = "thread-turn-history-session-repair" as ThreadId;
  const turnId = "turn-history-session-repair" as any;
  const siblingTurnId = "turn-history-session-repair-sibling" as any;

  try {
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "history session repair" });
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId: siblingTurnId, startedAt: 200, startEventSeq: 3 });
    db.turns.setEngineSessionIdByThread(threadId, "session-generation-b" as any);
    db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 2,
      ts: 150,
      workspaceId,
      threadId,
      engine: "codex",
      type: "turn.engineBound",
      payload: {
        turnId,
        engineTurnId: "provider-turn-a",
        engineSessionId: "session-generation-a",
        previousEngineTurnId: null,
      },
    } as any);

    assert.equal(db.turns.get(turnId)?.engineCheckpointJson, null);
    assert.deepEqual(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }), {
      engineSessionId: "session-generation-a",
      engineTurnId: "provider-turn-a",
    });
    assert.equal(db.turns.get(turnId)?.engineSessionId, "session-generation-a");
    assert.equal(db.turns.get(siblingTurnId)?.engineSessionId, "session-generation-b");
    assert.equal(
      JSON.parse(String(db.turns.get(turnId)?.engineCheckpointJson)).codexProviderTurn.source,
      "turn.engineBound",
    );
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("Codex canonical mapping rejects a conflicting delayed raw session without changing storage", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-turn-session-conflict-"));
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  const workspaceId = "ws-turn-session-conflict" as WorkspaceId;
  const threadId = "thread-turn-session-conflict" as ThreadId;
  const turnId = "turn-session-conflict" as any;

  try {
    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "session conflict" });
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
    db.turns.setCodexProviderTurnId(turnId, {
      engineTurnId: "provider-turn-a",
      engineSessionId: "session-a" as any,
      source: "turn.engineBound",
      eventSeq: 2,
      observedAt: 200,
    });
    const before = db.turns.get(turnId)!;

    assert.throws(
      () => db.turns.setCodexProviderTurnId(turnId, {
        engineTurnId: "provider-turn-a",
        engineSessionId: "session-b" as any,
        source: "turn/started",
        eventSeq: 3,
        observedAt: 300,
      }),
      (error: any) => error?.code === "codex_provider_turn_mapping_conflict",
    );
    const after = db.turns.get(turnId)!;
    assert.equal(after.engineSessionId, before.engineSessionId);
    assert.equal(after.engineCheckpointJson, before.engineCheckpointJson);
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("Codex provider history ignores unrelated canonical events beyond the recovery window", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-turn-history-type-filter-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-turn-history-type-filter" as WorkspaceId;
  const threadId = "thread-turn-history-type-filter" as ThreadId;
  const turnId = "turn-history-type-filter" as any;

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "provider type filter" });
      db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
      db.conversationEvents.appendEnvelope({
        seq: 2,
        ts: 200,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: {
          turnId,
          engineTurnId: "provider-filtered",
          engineSessionId: "session-filtered",
          previousEngineTurnId: null,
        },
      } as any);
      db.conversationEvents.appendEnvelopes(Array.from({ length: 5_001 }, (_, index) => ({
        schema: 1,
        seq: index + 3,
        ts: index + 300,
        workspaceId,
        threadId,
        engine: "codex",
        type: "item.tool.outputDelta",
        payload: { itemId: `item-${index}`, delta: "x" },
      } as any)));

      assert.deepEqual(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }), {
        engineSessionId: "session-filtered",
        engineTurnId: "provider-filtered",
      });
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("Codex raw ownership excludes foreign clientTurnId but accepts an exact late ACK", () => {
  withCodexTurnHistoryDb("turn-history-raw-owner", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-raw-owner-target" as any;
    const successorTurnId = "turn-raw-owner-successor" as any;
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
    db.turns.setEnded(turnId, { status: "completed", endedAt: 200, endEventSeq: 10 });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId: successorTurnId,
      startedAt: 300,
      startEventSeq: 11,
    });
    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 2,
      ts: 120,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      clientTurnId: successorTurnId,
      data: { method: "turn/started", params: { threadId: "session-foreign", turn: { id: "provider-foreign" } } },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    } as any);
    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 12,
      ts: 320,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      clientTurnId: turnId,
      data: { method: "turn/started", params: { threadId: "session-target", turn: { id: "provider-target" } } },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    } as any);

    assert.deepEqual(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }), {
      engineSessionId: "session-target",
      engineTurnId: "provider-target",
    });
    assert.equal(db.turns.get(successorTurnId)?.engineSessionId, null);
    assert.equal(
      JSON.parse(String(db.turns.get(turnId)?.engineCheckpointJson)).codexProviderTurn.engineTurnId,
      "provider-target",
    );
  });
});

test("Codex provider history paginates past foreign raw events", () => {
  withCodexTurnHistoryDb("turn-history-raw-pagination", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-raw-pagination-target" as any;
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
    db.turns.setEnded(turnId, { status: "completed", endedAt: 200, endEventSeq: 2 });
    db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 2,
      ts: 200,
      workspaceId,
      threadId,
      engine: "codex",
      type: "turn.engineBound",
      payload: {
        turnId,
        engineTurnId: "provider-pagination-target",
        engineSessionId: "session-pagination-target",
        previousEngineTurnId: null,
      },
    } as any);
    for (let index = 0; index < 801; index += 1) {
      db.rawEvents.appendEnvelope({
        schema: 1,
        seq: index + 3,
        ts: index + 300,
        workspaceId,
        threadId,
        engine: "codex",
        source: "codex.app-server.msg",
        clientTurnId: `turn-foreign-${index}`,
        data: { method: "item/outputText/delta", params: { delta: "x" } },
        handled: true,
        action: "mapped",
        emittedTypes: [],
      } as any);
    }

    assert.deepEqual(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }), {
      engineSessionId: "session-pagination-target",
      engineTurnId: "provider-pagination-target",
    });
  });
});

test("Codex raw provider repair rolls back checkpoint when session backfill conflicts", () => {
  withCodexTurnHistoryDb("turn-history-raw-atomic", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-raw-atomic-target" as any;
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
    db.turns.backfillEngineSessionId(turnId, "session-polluted" as any);
    for (const [seq, engineSessionId] of [[2, null], [3, "session-authoritative-raw"]] as const) {
      db.rawEvents.appendEnvelope({
        schema: 1,
        seq,
        ts: seq * 100,
        workspaceId,
        threadId,
        engine: "codex",
        source: "codex.app-server.msg",
        clientTurnId: turnId,
        data: {
          method: "turn/started",
          params: {
            ...(engineSessionId ? { threadId: engineSessionId } : {}),
            turn: { id: "provider-raw-atomic" },
          },
        },
        handled: true,
        action: "mapped",
        emittedTypes: [],
      } as any);
    }
    const before = db.turns.get(turnId)!;

    assert.throws(
      () => findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }),
      /session mismatch/i,
    );
    const after = db.turns.get(turnId)!;
    assert.equal(after.engineSessionId, before.engineSessionId);
    assert.equal(after.engineCheckpointJson, before.engineCheckpointJson);
  });
});

test("Codex legacy raw ownership requires a closed turn window and reports row-only provenance", () => {
  withCodexTurnHistoryDb("turn-history-legacy-window", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-legacy-window" as any;
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 2,
      ts: 120,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      data: { method: "turn/started", params: { threadId: "session-legacy", turn: { id: "provider-legacy" } } },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    });

    assert.equal(findCodexTurnIdFromHistory(db, { threadId, clientTurnId: turnId }), null);
    assert.equal(db.turns.get(turnId)?.engineCheckpointJson, null);
    db.turns.backfillEngineSessionId(turnId, "session-row-only" as any);
    assert.deepEqual(findCodexProviderTurnIdentityFromHistory(db, { threadId, clientTurnId: turnId }), {
      engineSessionId: "session-row-only",
      engineTurnId: null,
      engineSessionSource: "turn_row",
    });
    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 3,
      ts: 130,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      clientTurnId: "",
      data: { method: "turn/started", params: { threadId: "session-empty", turn: { id: "provider-empty" } } },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    } as any);
    assert.throws(
      () => findCodexTurnIdFromHistory(db, { threadId, clientTurnId: turnId }),
      /clientTurnId 字段无效/,
    );
    assert.equal(db.turns.get(turnId)?.engineCheckpointJson, null);
  });
});

test("Codex unscoped legacy ACK inside a closed window does not claim the target turn", () => {
  withCodexTurnHistoryDb("turn-history-unscoped-late-ack", ({ db, workspaceId, threadId }) => {
    const previousTurnId = "turn-unscoped-previous" as any;
    const targetTurnId = "turn-unscoped-target" as any;
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId: previousTurnId,
      startedAt: 100,
      startEventSeq: 1,
    });
    db.turns.setEnded(previousTurnId, { status: "completed", endedAt: 400, endEventSeq: 4 });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId: targetTurnId,
      startedAt: 500,
      startEventSeq: 5,
    });
    db.turns.setEnded(targetTurnId, { status: "error", endedAt: 1_000, endEventSeq: 10 });
    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 6,
      ts: 600,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      data: {
        method: "turn/started",
        params: { threadId: "session-previous", turn: { id: "provider-previous-late" } },
      },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    } as any);

    assert.equal(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: targetTurnId }), null);
    assert.equal(db.turns.get(targetTurnId)?.engineSessionId, null);
    assert.equal(db.turns.get(targetTurnId)?.engineCheckpointJson, null);
  });
});

test("Codex legacy raw ownership accepts an exact userMessage clientId correlation in an open window", () => {
  withCodexTurnHistoryDb("turn-history-legacy-client-id", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-legacy-client-id" as any;
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
    db.turns.setUserMessage(turnId, {
      userItemId: "item-user-legacy-client-id" as any,
      userText: "legacy exact owner",
    });
    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 2,
      ts: 120,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      data: { method: "turn/start", params: { threadId: "session-legacy-exact", turn: { id: "provider-legacy-exact" } } },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    } as any);
    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 3,
      ts: 130,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      data: {
        method: "item/started",
        params: {
          threadId: "session-legacy-exact",
          turnId: "provider-legacy-exact",
          item: { type: "userMessage", clientId: "item-user-legacy-client-id" },
        },
      },
      handled: true,
      action: "mapped",
      emittedTypes: [],
    } as any);

    assert.deepEqual(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }), {
      engineSessionId: "session-legacy-exact",
      engineTurnId: "provider-legacy-exact",
    });
  });
});

test("Codex canonical replay is idempotent at the checkpoint tail and accepts a newer canonical checkpoint", () => {
  withCodexTurnHistoryDb("turn-history-checkpoint-tail", ({ db, workspaceId, threadId }) => {
    const exactTurnId = "turn-checkpoint-exact" as any;
    const aheadTurnId = "turn-checkpoint-ahead" as any;
    for (const [turnId, startSeq] of [[exactTurnId, 1], [aheadTurnId, 20]] as const) {
      db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: startSeq * 100, startEventSeq: startSeq });
      db.turns.setEnded(turnId, { status: "completed", endedAt: startSeq * 100 + 90, endEventSeq: startSeq + 9 });
    }

    db.turns.setEngineCheckpoint(exactTurnId, JSON.stringify({
      codexProviderTurn: {
        v: 1,
        engineTurnId: "provider-exact-c",
        engineSessionId: null,
        previousEngineTurnId: "provider-exact-a",
        supersededEngineTurnIds: ["provider-exact-a"],
        source: "turn/started",
        eventSeq: 3,
        observedAt: 130,
      },
    }));
    db.db.prepare("UPDATE thread_turns SET engine_session_id = ? WHERE turn_id = ?")
      .run("session-polluted", String(exactTurnId));
    for (const [seq, engineTurnId, previousEngineTurnId] of [
      [4, "provider-exact-a", null],
      [5, "provider-exact-c", "provider-exact-a"],
    ] as const) {
      db.conversationEvents.appendEnvelope({
        schema: 1,
        seq,
        ts: seq * 100,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: { turnId: exactTurnId, engineTurnId, engineSessionId: "session-canonical", previousEngineTurnId },
      } as any);
    }

    db.turns.setCodexProviderTurnId(aheadTurnId, {
      engineTurnId: "provider-ahead-b",
      engineSessionId: "session-ahead" as any,
      previousEngineTurnId: "provider-ahead-a",
      source: "turn.engineBound",
      eventSeq: 25,
      observedAt: 2_500,
    });
    db.db.prepare("UPDATE thread_turns SET engine_session_id = ? WHERE turn_id = ?")
      .run("session-ahead-polluted", String(aheadTurnId));
    db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 24,
      ts: 2_400,
      workspaceId,
      threadId,
      engine: "codex",
      type: "turn.engineBound",
      payload: {
        turnId: aheadTurnId,
        engineTurnId: "provider-ahead-a",
        engineSessionId: "session-ahead",
        previousEngineTurnId: null,
      },
    } as any);

    assert.deepEqual(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: exactTurnId }), {
      engineSessionId: "session-canonical",
      engineTurnId: "provider-exact-c",
    });
    assert.equal(db.turns.get(exactTurnId)?.engineSessionId, "session-canonical");
    assert.equal(
      JSON.parse(String(db.turns.get(exactTurnId)?.engineCheckpointJson)).codexProviderTurn.source,
      "turn.engineBound",
    );
    assert.deepEqual(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: aheadTurnId }), {
      engineSessionId: "session-ahead",
      engineTurnId: "provider-ahead-b",
    });
    assert.equal(db.turns.get(aheadTurnId)?.engineSessionId, "session-ahead");
  });
});

test("Codex checkpoint lineage 补合 ACK 缓冲丢失的 canonical replacement 中段", () => {
  withCodexTurnHistoryDb("turn-history-canonical-gap", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-canonical-gap" as any;
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
    db.turns.setEnded(turnId, { status: "completed", endedAt: 500, endEventSeq: 5 });
    db.turns.setEngineCheckpoint(turnId, JSON.stringify({
      codexProviderTurn: {
        v: 1,
        engineTurnId: "provider-gap-c",
        engineSessionId: "session-gap",
        previousEngineTurnId: "provider-gap-b",
        supersededEngineTurnIds: ["provider-gap-a", "provider-gap-b"],
        source: "turn.engineBound",
        eventSeq: 4,
        observedAt: 400,
      },
    }));
    for (const [seq, engineTurnId, previousEngineTurnId] of [
      [2, "provider-gap-a", null],
      [4, "provider-gap-c", "provider-gap-b"],
    ] as const) {
      db.conversationEvents.appendEnvelope({
        schema: 1,
        seq,
        ts: seq * 100,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: { turnId, engineTurnId, engineSessionId: "session-gap", previousEngineTurnId },
      } as any);
    }

    assert.deepEqual(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }), {
      engineSessionId: "session-gap",
      engineTurnId: "provider-gap-c",
    });
    assert.equal(db.turns.get(turnId)?.engineSessionId, "session-gap");
  });
});

test("Codex 较晚 checkpoint 仍可补合较早的 canonical replacement 缺口", () => {
  withCodexTurnHistoryDb("turn-history-canonical-gap-later-checkpoint", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-canonical-gap-later-checkpoint" as any;
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
    db.turns.setEnded(turnId, { status: "completed", endedAt: 600, endEventSeq: 6 });
    db.turns.setEngineCheckpoint(turnId, JSON.stringify({
      codexProviderTurn: {
        v: 1,
        engineTurnId: "provider-gap-d",
        engineSessionId: "session-gap-later",
        previousEngineTurnId: "provider-gap-c",
        supersededEngineTurnIds: ["provider-gap-a", "provider-gap-b", "provider-gap-c"],
        source: "turn.engineBound",
        eventSeq: 5,
        observedAt: 500,
      },
    }));
    for (const [seq, engineTurnId, previousEngineTurnId] of [
      [2, "provider-gap-a", null],
      [4, "provider-gap-c", "provider-gap-b"],
      [5, "provider-gap-d", "provider-gap-c"],
    ] as const) {
      db.conversationEvents.appendEnvelope({
        schema: 1,
        seq,
        ts: seq * 100,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: { turnId, engineTurnId, engineSessionId: "session-gap-later", previousEngineTurnId },
      } as any);
    }

    assert.deepEqual(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }), {
      engineSessionId: "session-gap-later",
      engineTurnId: "provider-gap-d",
    });
  });
});

test("Codex checkpoint lineage 不补合分叉或跨 session 的 canonical 缺口", () => {
  for (const kind of ["fork", "session"] as const) {
    withCodexTurnHistoryDb(`turn-history-canonical-gap-${kind}`, ({ db, workspaceId, threadId }) => {
      const turnId = `turn-canonical-gap-${kind}` as any;
      db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
      db.turns.setEnded(turnId, { status: "completed", endedAt: 500, endEventSeq: 5 });
      db.turns.setEngineCheckpoint(turnId, JSON.stringify({
        codexProviderTurn: {
          v: 1,
          engineTurnId: "provider-gap-c",
          engineSessionId: "session-gap",
          previousEngineTurnId: "provider-gap-b",
          supersededEngineTurnIds: ["provider-gap-a", "provider-gap-b"],
          source: "turn.engineBound",
          eventSeq: 4,
          observedAt: 400,
        },
      }));
      db.conversationEvents.appendEnvelope({
        schema: 1,
        seq: 2,
        ts: 200,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: {
          turnId,
          engineTurnId: "provider-gap-a",
          engineSessionId: "session-gap",
          previousEngineTurnId: null,
        },
      } as any);
      db.conversationEvents.appendEnvelope({
        schema: 1,
        seq: 4,
        ts: 400,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: {
          turnId,
          engineTurnId: "provider-gap-c",
          engineSessionId: kind === "session" ? "session-foreign" : "session-gap",
          previousEngineTurnId: kind === "fork" ? "provider-gap-x" : "provider-gap-b",
        },
      } as any);

      assert.throws(
        () => findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }),
        /replacement 链冲突/,
      );
      assert.equal(db.turns.get(turnId)?.engineSessionId, null);
    });
  }
});

test("Codex malformed canonical or raw ownership evidence fails before any repair write", () => {
  for (const kind of ["canonical", "raw"] as const) {
    withCodexTurnHistoryDb(`turn-history-malformed-${kind}`, ({ db, workspaceId, threadId }) => {
      const turnId = `turn-malformed-${kind}` as any;
      db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
      db.turns.setEnded(turnId, { status: "completed", endedAt: 300, endEventSeq: 10 });
      db.conversationEvents.appendEnvelope({
        schema: 1,
        seq: 2,
        ts: 200,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: { turnId, engineTurnId: "provider-valid", engineSessionId: "session-valid", previousEngineTurnId: null },
      } as any);
      db.rawEvents.appendEnvelope({
        schema: 1,
        seq: 3,
        ts: 220,
        workspaceId,
        threadId,
        engine: "codex",
        source: "codex.app-server.msg",
        clientTurnId: turnId,
        data: { method: "turn/started", params: { threadId: "session-valid", turn: { id: "provider-valid" } } },
        handled: true,
        action: "mapped",
        emittedTypes: [],
      } as any);
      const table = kind === "canonical" ? "conversation_events" : "raw_engine_events";
      const seq = kind === "canonical" ? 2 : 3;
      db.db.prepare(`UPDATE ${table} SET event_json = ? WHERE seq = ?`).run("{", seq);

      assert.throws(
        () => findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }),
        new RegExp(`Codex ${kind} event JSON 无法解析`),
      );
      assert.equal(db.turns.get(turnId)?.engineSessionId, null);
      assert.equal(db.turns.get(turnId)?.engineCheckpointJson, null);
    });
  }
});

test("Codex turn history ignores malformed evidence before the current turn boundary", () => {
  withCodexTurnHistoryDb("turn-history-current-window", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-history-current-window" as any;
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 1_000, startEventSeq: 100 });
    db.conversationEvents.appendEnvelopes([
      {
        schema: 1,
        seq: 10,
        ts: 100,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: { turnId: "turn-older", engineTurnId: "provider-older", engineSessionId: "session-older" },
      },
      {
        schema: 1,
        seq: 11,
        ts: 110,
        workspaceId,
        threadId,
        engine: "codex",
        type: "item.userMessage.created",
        payload: { turnId: "turn-older", itemId: "item-user-older", text: "older" },
      },
      {
        schema: 1,
        seq: 101,
        ts: 1_010,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: {
          turnId,
          engineTurnId: "provider-current-window",
          engineSessionId: "session-current-window",
          previousEngineTurnId: null,
        },
      },
      {
        schema: 1,
        seq: 102,
        ts: 1_020,
        workspaceId,
        threadId,
        engine: "codex",
        type: "item.userMessage.created",
        payload: { turnId, itemId: "item-user-current-window", text: "current" },
      },
    ] as any);
    db.db.prepare("UPDATE conversation_events SET event_json = ? WHERE seq IN (?, ?)")
      .run("{", 10, 11);

    assert.deepEqual(findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }), {
      engineSessionId: "session-current-window",
      engineTurnId: "provider-current-window",
    });
    assert.deepEqual(findCodexClientUserMessageIdsFromHistory(db, { threadId, clientTurnId: turnId }), {
      kind: "candidates",
      clientUserMessageIds: ["item-user-current-window"],
    });
  });
});

test("Codex turn history keeps strict full-history validation without a turn boundary", () => {
  withCodexTurnHistoryDb("turn-history-missing-window", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-history-missing-window" as any;
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 1_000, startEventSeq: 100 });
    db.db.prepare("UPDATE thread_turns SET start_event_seq = NULL WHERE turn_id = ?").run(String(turnId));
    db.conversationEvents.appendEnvelopes([
      {
        schema: 1,
        seq: 10,
        ts: 100,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: { turnId: "turn-older", engineTurnId: "provider-older", engineSessionId: "session-older" },
      },
      {
        schema: 1,
        seq: 11,
        ts: 110,
        workspaceId,
        threadId,
        engine: "codex",
        type: "item.userMessage.created",
        payload: { turnId: "turn-older", itemId: "item-user-older", text: "older" },
      },
      {
        schema: 1,
        seq: 101,
        ts: 1_010,
        workspaceId,
        threadId,
        engine: "codex",
        type: "turn.engineBound",
        payload: {
          turnId,
          engineTurnId: "provider-missing-window",
          engineSessionId: "session-missing-window",
          previousEngineTurnId: null,
        },
      },
    ] as any);
    db.db.prepare("UPDATE conversation_events SET event_json = ? WHERE seq IN (?, ?)").run("{", 10, 11);

    const clientIdLookup = findCodexClientUserMessageIdsFromHistory(db, { threadId, clientTurnId: turnId });
    assert.equal(clientIdLookup.kind, "incomplete");
    if (clientIdLookup.kind !== "incomplete") assert.fail("missing startEventSeq should preserve strict history validation");
    assert.match(clientIdLookup.message, /本地 userMessage 历史损坏/);
    assert.throws(
      () => findCodexProviderTurnPairFromHistory(db, { threadId, clientTurnId: turnId }),
      /Codex canonical event JSON 无法解析/,
    );
    assert.equal(db.turns.get(turnId)?.engineSessionId, null);
  });
});

test("conversation replay streams aggregate diffs while preserving raw pagination boundaries", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-replay-diff-compaction-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-replay-diff-compaction" as WorkspaceId;
  const threadId = "thread-replay-diff-compaction" as ThreadId;

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "replay diff compaction" });
      db.turns.insertStarted({
        workspaceId,
        threadId,
        engine: "codex",
        turnId: "turn-replay-diff-compaction" as any,
        startedAt: 100,
        startEventSeq: 1,
      });
      db.conversationEvents.appendEnvelopes([
        { schema: 1, seq: 1, ts: 100, workspaceId, threadId, engine: "codex", type: "system.notice", payload: { level: "info", text: "older" } },
        { schema: 1, seq: 2, ts: 200, workspaceId, threadId, engine: "codex", type: "item.diff.created", payload: { itemId: "diff-1", title: "Diff", diff: "old" } },
        { schema: 1, seq: 3, ts: 300, workspaceId, threadId, engine: "codex", type: "system.notice", payload: { level: "info", text: "middle" } },
        { schema: 1, seq: 4, ts: 400, workspaceId, threadId, engine: "codex", type: "item.diff.created", payload: { itemId: "diff-1", title: "Diff", diff: "latest" } },
        { schema: 1, seq: 5, ts: 500, workspaceId, threadId, engine: "codex", type: "system.notice", payload: { level: "info", text: "newest" } },
      ] as any);

      const replay = await db.conversationEvents.listByThreadForReplay(threadId, { limit: 4 });
      assert.equal(replay.rawEventCount, 4);
      assert.equal(replay.oldestSeq, 2);
      assert.equal(replay.latestSeq, 5);
      assert.equal(replay.hasMore, true);
      assert.deepEqual(replay.events.map((event) => event.seq), [3, 4, 5]);
      const diff = replay.events.find((event) => event.type === "item.diff.created");
      assert.equal(diff?.type === "item.diff.created" ? diff.payload.diff : null, "latest");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

for (const completed of [false, true]) test(`子任务高频事件不挤占主会话历史分页：${completed ? "已完成" : "执行中"}`, async () => {
  await withCodexTurnHistoryDb(`subagent-history-${completed}`, async ({ db, workspaceId, threadId }) => {
    const events: any[] = [];
    /** 生成连续序号，验证分页后仍能回放完整的子任务过程。 */
    const append = (type: string, payload: Record<string, unknown>) => events.push({
      schema: 1, seq: events.length + 1, ts: events.length + 1, workspaceId, threadId, engine: "codex", type, payload,
    });
    append("item.userMessage.created", { itemId: "old-user", text: "较早的问题" });
    append("item.agentMessage.completed", { itemId: "old-answer", text: "较早的回复" });
    append("item.userMessage.created", { itemId: "new-user", text: "当前的问题" });
    append("item.agentMessage.completed", { itemId: "new-answer", text: "生成正文已保存" });
    append("item.subagent.started", { itemId: "review", taskId: "task", description: "复检" });
    for (let index = 0; index < 5_000; index++) append("item.subagent.childEvent", {
      itemId: "review", taskId: "task", innerEventType: "item.reasoning.delta", innerPayload: { itemId: "reason", delta: "核" },
    });
    append("item.subagent.childEvent", { itemId: "review", taskId: "task", innerEventType: "item.agentMessage.completed", innerPayload: { itemId: "review-answer", text: "复检依据已核实" } });
    if (completed) append("item.subagent.completed", { itemId: "review", taskId: "task", status: "completed", summary: "复检通过" });
    db.conversationEvents.appendEnvelopes(events);

    let bodyReads = 0;
    let largestBatch = 0;
    const replayRepo = new ConversationEventRepo({
      ...db.db,
      transaction: fn => db.db.transaction(fn),
      prepare: sql => {
        const statement = db.db.prepare(sql);
        if (!sql.includes("SELECT seq, event_json FROM conversation_events")) return statement;
        return { ...statement, all: (...params: unknown[]) => {
          const rows = statement.all(...params);
          bodyReads++;
          largestBatch = Math.max(largestBatch, rows.length);
          return rows;
        } } as typeof statement;
      },
    });
    let progressed = false;
    const pendingRead = replayRepo.listByThreadForReplay(threadId, { limit: 4 });
    const interleaved = new Promise<void>(resolve => setImmediate(() => {
      assert.equal(db.threads.get(threadId)?.id, threadId);
      db.conversationEvents.appendEnvelope({ schema: 1, seq: events.length + 1, ts: events.length + 1, workspaceId, threadId, engine: "codex", type: "system.notice", payload: { level: "info", text: "读取期间新事件" } });
      progressed = true;
      resolve();
    }));
    const page = await pendingRead;
    assert.equal(progressed, true);
    await interleaved;
    assert.ok(largestBatch <= 256);
    assert.ok(bodyReads < events.length / 100);
    assert.ok(page.events.some(event => event.type === "item.userMessage.created" && event.payload.text === "当前的问题"));
    assert.ok(page.events.some(event => event.type === "item.agentMessage.completed" && event.payload.text === "生成正文已保存"));
    assert.ok(page.events.some(event => event.type === "item.subagent.started"));
    const reasoning = page.events.filter(event => event.type === "item.subagent.childEvent" && event.payload.innerEventType === "item.reasoning.delta");
    assert.equal(reasoning.length, 1);
    assert.equal(reasoning[0]!.replayFromSeq, 6);
    assert.equal((reasoning[0]!.payload as any).innerPayload.delta, "核".repeat(5_000));
    assert.ok(page.events.some(event => event.type === "item.subagent.childEvent" && (event.payload.innerPayload as { text?: string }).text === "复检依据已核实"));
    assert.equal(page.latestSeq, events.at(-1)!.seq);
    assert.ok(page.events.every(event => event.seq <= events.length));
    assert.equal(page.rawEventCount, events.length - page.oldestSeq! + 1);
    assert.equal(page.hasMore, true);
    const previous = await db.conversationEvents.listByThreadForReplay(threadId, { limit: 4, beforeSeq: page.oldestSeq });
    assert.ok(previous.events.some(event => event.type === "item.userMessage.created" && event.payload.text === "较早的问题"));
    assert.equal(previous.hasMore, false);
    assert.ok(previous.latestSeq! < page.oldestSeq!);
    assert.equal(db.conversationEvents.listByThread(threadId, { limit: 10_000 }).length, events.length + 1);
  });
});

test("省略旧 diff 正文仍保留子事件的分页压缩边界", async () => {
  await withCodexTurnHistoryDb("replay-child-diff-boundary", async ({ db, workspaceId, threadId }) => {
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId: "turn-boundary" as any, startedAt: 1, startEventSeq: 1 });
    const child = (seq: number, delta: string) => ({
      schema: 1, seq, ts: seq, workspaceId, threadId, engine: "codex", type: "item.subagent.childEvent", payload: {
        itemId: "review", taskId: "task", innerEventType: "item.reasoning.delta", innerPayload: { itemId: "reason", delta },
      },
    });
    db.conversationEvents.appendEnvelopes([
      { schema: 1, seq: 1, ts: 1, workspaceId, threadId, engine: "codex", type: "item.subagent.started", payload: { itemId: "review", taskId: "task", description: "复检" } },
      child(2, "A"),
      { schema: 1, seq: 3, ts: 3, workspaceId, threadId, engine: "codex", type: "item.diff.created", payload: { itemId: "diff", title: "Diff", diff: "old" } },
      child(4, "B"),
      { schema: 1, seq: 5, ts: 5, workspaceId, threadId, engine: "codex", type: "item.diff.created", payload: { itemId: "diff", title: "Diff", diff: "latest" } },
    ] as any);
    const page = await db.conversationEvents.listByThreadForReplay(threadId, { limit: 5 });
    assert.deepEqual(page.events.filter(event => event.type === "item.subagent.childEvent").map(event => event.seq), [2, 4]);
    assert.deepEqual(page.events.filter(event => event.type === "item.diff.created").map(event => event.seq), [5]);
  });
});

test("回放历史损坏时显式失败，不返回部分成功", async () => {
  await withCodexTurnHistoryDb("replay-corrupt-row", async ({ db, workspaceId, threadId }) => {
    db.conversationEvents.appendEnvelope({ schema: 1, seq: 1, ts: 1, workspaceId, threadId, engine: "codex", type: "system.notice", payload: { level: "info", text: "记录" } });
    db.db.prepare("UPDATE conversation_events SET event_json = ? WHERE thread_id = ?").run("{", threadId);
    await assert.rejects(db.conversationEvents.listByThreadForReplay(threadId), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /会话历史读取失败/);
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    });
  });
});

test("conversation storage keeps only the latest full aggregate diff snapshot per turn", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-diff-snapshot-storage-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-diff-snapshot-storage" as WorkspaceId;
  const threadId = "thread-diff-snapshot-storage" as ThreadId;
  const turnId = "turn-diff-snapshot-storage" as any;
  const bodyPrefix = "diff --git a/large.txt b/large.txt\n" + "x".repeat(16 * 1024);

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "diff snapshot storage" });
      db.turns.insertStarted({
        workspaceId,
        threadId,
        engine: "codex",
        turnId,
        startedAt: 100,
        startEventSeq: 1,
      });
      db.conversationEvents.appendEnvelopes(Array.from({ length: 300 }, (_, index) => ({
        schema: 1,
        seq: index + 2,
        ts: index + 200,
        workspaceId,
        threadId,
        engine: "codex",
        type: "item.diff.created",
        payload: {
          itemId: `diff_${turnId}`,
          title: "Diff",
          diff: `${bodyPrefix}\nversion=${index}`,
          turnId,
          engineTurnId: "provider-diff-snapshot-storage",
        },
      } as any)));

      const canonical = db.db.prepare(`
        SELECT COUNT(*) AS count, SUM(LENGTH(event_json)) AS chars
        FROM conversation_events
        WHERE thread_id = ? AND type = 'item.diff.created'
      `).get(String(threadId)) as { count?: number; chars?: number };
      const snapshots = db.db.prepare(`
        SELECT event_seq, diff_text, diff_bytes
        FROM conversation_diff_snapshots
        WHERE thread_id = ?
      `).all(String(threadId)) as Array<{ event_seq?: number; diff_text?: string; diff_bytes?: number }>;

      assert.equal(Number(canonical.count), 300);
      assert.ok(Number(canonical.chars) < 300_000, `canonical metadata unexpectedly large: ${String(canonical.chars)}`);
      assert.equal(snapshots.length, 1);
      assert.equal(Number(snapshots[0]?.event_seq), 301);
      assert.equal(snapshots[0]?.diff_text, `${bodyPrefix}\nversion=299`);
      assert.equal(Number(snapshots[0]?.diff_bytes), Buffer.byteLength(`${bodyPrefix}\nversion=299`, "utf8"));

      const storedLatest = db.db.prepare(
        "SELECT event_json FROM conversation_events WHERE thread_id = ? AND seq = ?",
      ).get(String(threadId), 301) as { event_json?: string } | undefined;
      const storedLatestEvent = JSON.parse(String(storedLatest?.event_json ?? "{}"));
      assert.equal(storedLatestEvent.payload?.diff, "");
      assert.equal(storedLatestEvent.payload?.diffRef?.kind, "client_latest_snapshot");
      assert.equal(Number(storedLatestEvent.payload?.diffRef?.bytes), Buffer.byteLength(`${bodyPrefix}\nversion=299`, "utf8"));

      const storedEvents = db.conversationEvents.listByThread(threadId, { limit: 400 });
      const fullDiffs = storedEvents.filter((event) => event.type === "item.diff.created" && event.payload.diff.length > 0);
      assert.equal(fullDiffs.length, 1);
      assert.equal(fullDiffs[0]?.seq, 301);

      const replay = await db.conversationEvents.listByThreadForReplay(threadId, { limit: 400 });
      const replayDiffs = replay.events.filter((event) => event.type === "item.diff.created");
      assert.equal(replayDiffs.length, 1);
      assert.equal(replayDiffs[0]?.seq, 301);
      assert.equal(replayDiffs[0]?.type === "item.diff.created" ? replayDiffs[0].payload.diff : null, `${bodyPrefix}\nversion=299`);

      assert.equal(db.conversationEvents.deleteAfterSeq(threadId, 300), 1);
      const remainingSnapshots = db.db.prepare(
        "SELECT COUNT(*) AS count FROM conversation_diff_snapshots WHERE thread_id = ?",
      ).get(String(threadId)) as { count?: number };
      assert.equal(Number(remainingSnapshots.count), 0);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("provider mapping decision accepts delayed raw ancestors after A to B to C replacements", () => {
  let current: CodexProviderTurnMappingCandidate | null = null;
  for (const incoming of [
    { engineTurnId: "provider-a", source: "turn.engineBound" as const, eventSeq: 1, observedAt: 100 },
    { engineTurnId: "provider-b", previousEngineTurnId: "provider-a", source: "turn.engineBound" as const, eventSeq: 2, observedAt: 200 },
    { engineTurnId: "provider-c", previousEngineTurnId: "provider-b", source: "turn.engineBound" as const, eventSeq: 3, observedAt: 300 },
  ]) {
    const decision = decideCodexProviderTurnMapping(current, incoming);
    assert.equal(decision.action, "replace");
    if (decision.action === "replace") current = decision.mapping;
  }

  assert.deepEqual(current?.supersededEngineTurnIds, ["provider-a", "provider-b"]);
  assert.equal(decideCodexProviderTurnMapping(current, {
    engineTurnId: "provider-a",
    source: "turn/started",
    eventSeq: 4,
    observedAt: 400,
  }).action, "keep");
  assert.equal(decideCodexProviderTurnMapping(current, {
    engineTurnId: "provider-unknown",
    source: "turn/started",
    eventSeq: 5,
    observedAt: 500,
  }).action, "conflict");
});

test("provider mapping decision merges delayed canonical ancestors without moving the current head", () => {
  const current = decideCodexProviderTurnMapping(null, {
    engineTurnId: "provider-c",
    engineSessionId: "session-canonical-order" as any,
    previousEngineTurnId: "provider-b",
    source: "turn.engineBound",
    eventSeq: 30,
    observedAt: 300,
  });
  if (current.action !== "replace") assert.fail("provider-c should establish the current head");

  const delayedB = decideCodexProviderTurnMapping(current.mapping, {
    engineTurnId: "provider-b",
    engineSessionId: "session-canonical-order" as any,
    previousEngineTurnId: "provider-a",
    source: "turn.engineBound",
    eventSeq: 20,
    observedAt: 200,
  });
  if (delayedB.action !== "replace") assert.fail("delayed provider-b should extend canonical lineage");
  assert.equal(delayedB.mapping.engineTurnId, "provider-c");
  assert.equal(delayedB.mapping.eventSeq, 30);
  assert.deepEqual(delayedB.mapping.supersededEngineTurnIds, ["provider-a", "provider-b"]);

  assert.equal(decideCodexProviderTurnMapping(delayedB.mapping, {
    engineTurnId: "provider-a",
    engineSessionId: "session-canonical-order" as any,
    source: "turn.engineBound",
    eventSeq: 10,
    observedAt: 100,
  }).action, "keep");
});

test("provider mapping decision rejects a delayed canonical ancestor with a conflicting previous turn", () => {
  let current: CodexProviderTurnMappingCandidate | null = null;
  for (const incoming of [
    {
      engineTurnId: "provider-a",
      engineSessionId: "session-lineage" as any,
      source: "turn.engineBound" as const,
      eventSeq: 10,
      observedAt: 100,
    },
    {
      engineTurnId: "provider-b",
      engineSessionId: "session-lineage" as any,
      previousEngineTurnId: "provider-a",
      source: "turn.engineBound" as const,
      eventSeq: 20,
      observedAt: 200,
    },
    {
      engineTurnId: "provider-c",
      engineSessionId: "session-lineage" as any,
      previousEngineTurnId: "provider-b",
      source: "turn.engineBound" as const,
      eventSeq: 30,
      observedAt: 300,
    },
  ]) {
    const decision = decideCodexProviderTurnMapping(current, incoming);
    if (decision.action !== "replace") assert.fail(`expected replace, got ${decision.action}`);
    current = decision.mapping;
  }

  assert.equal(decideCodexProviderTurnMapping(current, {
    engineTurnId: "provider-b",
    engineSessionId: "session-lineage" as any,
    previousEngineTurnId: "provider-x",
    source: "turn.engineBound",
    eventSeq: 15,
    observedAt: 150,
  }).action, "conflict");
});

test("thread turn repo keeps the canonical head when its ancestor ACK arrives late", () => {
  withCodexTurnHistoryDb("turn-canonical-ancestor-order", ({ db, workspaceId, threadId }) => {
    const turnId = "turn-canonical-ancestor-order" as any;
    db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
    db.turns.setCodexProviderTurnId(turnId, {
      engineTurnId: "provider-b",
      engineSessionId: "session-canonical-ancestor-order" as any,
      previousEngineTurnId: "provider-a",
      source: "turn.engineBound",
      eventSeq: 20,
      observedAt: 200,
    });

    assert.doesNotThrow(() => db.turns.setCodexProviderTurnId(turnId, {
      engineTurnId: "provider-a",
      engineSessionId: "session-canonical-ancestor-order" as any,
      source: "turn.engineBound",
      eventSeq: 10,
      observedAt: 100,
    }));
    const turn = db.turns.get(turnId)!;
    const checkpoint = JSON.parse(String(turn.engineCheckpointJson)).codexProviderTurn;
    assert.equal(turn.status, "started");
    assert.equal(turn.engineSessionId, "session-canonical-ancestor-order");
    assert.equal(checkpoint.engineTurnId, "provider-b");
    assert.deepEqual(checkpoint.supersededEngineTurnIds, ["provider-a"]);
  });
});

test("provider mapping decision rejects a self-referencing initial mapping", () => {
  assert.equal(decideCodexProviderTurnMapping(null, {
    engineTurnId: "provider-a",
    previousEngineTurnId: "provider-a",
    source: "turn.engineBound",
    eventSeq: 1,
    observedAt: 100,
  }).action, "conflict");
});

test("provider mapping decision rejects A to B to A cycles and malformed lineage values", () => {
  const first = decideCodexProviderTurnMapping(null, {
    engineTurnId: "provider-a",
    source: "turn.engineBound",
    eventSeq: 1,
    observedAt: 100,
  });
  if (first.action !== "replace") assert.fail("provider-a should establish the initial mapping");
  const second = decideCodexProviderTurnMapping(first.mapping, {
    engineTurnId: "provider-b",
    previousEngineTurnId: "provider-a",
    source: "turn.engineBound",
    eventSeq: 2,
    observedAt: 200,
  });
  if (second.action !== "replace") assert.fail("provider-b should replace provider-a");
  assert.equal(decideCodexProviderTurnMapping(second.mapping, {
    engineTurnId: "provider-a",
    previousEngineTurnId: "provider-b",
    source: "turn.engineBound",
    eventSeq: 3,
    observedAt: 300,
  }).action, "conflict");

  assert.equal(decideCodexProviderTurnMapping(null, {
    engineTurnId: "provider-c",
    supersededEngineTurnIds: ["provider-a", "  "],
    source: "turn.engineBound",
    eventSeq: 4,
    observedAt: 400,
  }).action, "conflict");
  assert.equal(decideCodexProviderTurnMapping(null, {
    engineTurnId: "provider-c",
    supersededEngineTurnIds: ["provider-a", 42] as any,
    source: "turn.engineBound",
    eventSeq: 5,
    observedAt: 500,
  }).action, "conflict");
});

test("Codex turn history rejects a canonical A to B to A replacement cycle", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-turn-history-cycle-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-turn-history-cycle" as WorkspaceId;
  const threadId = "thread-turn-history-cycle" as ThreadId;
  const turnId = "turn-history-cycle" as any;

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "provider cycle" });
      db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 100, startEventSeq: 1 });
      for (const [seq, engineTurnId, previousEngineTurnId] of [
        [2, "provider-a", null],
        [3, "provider-b", "provider-a"],
        [4, "provider-a", "provider-b"],
      ] as const) {
        db.conversationEvents.appendEnvelope({
          seq,
          ts: seq * 100,
          workspaceId,
          threadId,
          engine: "codex",
          type: "turn.engineBound",
          payload: {
            turnId,
            engineTurnId,
            engineSessionId: "session-cycle",
            previousEngineTurnId,
          },
        } as any);
      }

      assert.throws(
        () => findCodexTurnIdFromHistory(db, { threadId, clientTurnId: turnId }),
        /replacement 链冲突/,
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread turn repo rejects Codex provider mappings on non-Codex turns", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-turn-provider-engine-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-turn-provider-engine" as WorkspaceId;
  const threadId = "thread-provider-engine" as ThreadId;
  const turnId = "turn-provider-engine" as any;

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      db.threads.create({ id: threadId, workspaceId, engine: "claude", title: "provider engine" });
      db.turns.insertStarted({ workspaceId, threadId, engine: "claude", turnId, startedAt: 100, startEventSeq: 1 });

      assert.throws(
        () => db.turns.setCodexProviderTurnId(turnId, {
          engineTurnId: "provider-invalid-engine",
          source: "turn/started",
          eventSeq: 2,
          observedAt: 110,
        }),
        /cannot target claude turn/,
      );
      assert.equal(db.turns.get(turnId)?.engineCheckpointJson, null);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread turn repo rejects malformed checkpoints and missing turns", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-turn-checkpoint-invalid-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-turn-checkpoint-invalid" as WorkspaceId;
  const threadId = "thread-checkpoint-invalid" as ThreadId;
  const turnId = "turn-checkpoint-invalid" as any;

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "checkpoint invalid" });
      db.turns.insertStarted({
        workspaceId,
        threadId,
        engine: "codex",
        turnId,
        startedAt: 100,
        startEventSeq: 1,
      });

      db.db.prepare("UPDATE thread_turns SET engine_checkpoint_json = ? WHERE turn_id = ?").run("[]", turnId);
      assert.throws(
        () => db.turns.mergeEngineCheckpoint(turnId, { codexFileChanges: {} }),
        /expected an object/,
      );
      assert.throws(
        () => db.turns.mergeEngineCheckpoint("missing-turn" as any, { codexFileChanges: {} }),
        /Turn not found/,
      );
      assert.throws(
        () => db.turns.mergeEngineCheckpoint(turnId, [] as any),
        /checkpoint patch/,
      );
      assert.throws(
        () => db.turns.mergeEngineCheckpoint(turnId, new Date() as any),
        /checkpoint patch/,
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("thread rollback repo updates pending operations to terminal or partial results", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-thread-rollback-repo-"));
  const dbPath = path.join(workspacePath, "client.db");
  const workspaceId = "ws-rollback-repo" as WorkspaceId;
  const threadId = "thread-rollback-repo" as ThreadId;

  try {
    const db = openClientDb({ dbPath });
    try {
      db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
      db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "rollback repo" });

      const rollbackId = db.rollbacks.insert({
        threadId,
        toTurnId: "turn-target" as any,
        droppedTurnCount: 2,
        droppedEventSeqGt: 10,
        createdAt: 100,
        result: "pending",
        error: null,
      });
      db.rollbacks.updateResult(rollbackId, { result: "partial", error: "local trim failed" });
      assert.equal(db.rollbacks.listByThread(threadId)[0]?.result, "partial");
      assert.equal(db.rollbacks.listByThread(threadId)[0]?.error, "local trim failed");

      db.rollbacks.updateResult(rollbackId, { result: "success", error: null });
      assert.equal(db.rollbacks.listByThread(threadId)[0]?.result, "success");
      assert.equal(db.rollbacks.listByThread(threadId)[0]?.error, null);
      assert.throws(
        () => db.rollbacks.updateResult(rollbackId + 1, { result: "failed", error: "missing" }),
        /Rollback record not found/,
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});
