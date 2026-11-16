import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RawEngineEventEnvelope, ThreadId, TurnId, WorkspaceId } from "../../packages/shared/src/index.ts";
import { openClientDb, type ClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import {
  indexCodexProviderTurnStarted,
  type CodexProviderTurnIndexRuntime,
} from "../../apps/desktop/client/src/eventIndex/codexProviderTurnStarted.ts";

type IndexHarness = {
  db: ClientDb;
  runtime: CodexProviderTurnIndexRuntime;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  close: () => void;
};

/** 创建隔离 Client DB，供 provider turn ACK 索引测试复用。 */
function createIndexHarness(): IndexHarness {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-provider-turn-index-"));
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  const workspaceId = "ws-provider-turn-index" as WorkspaceId;
  const threadId = "thread-provider-turn-index" as ThreadId;
  db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "provider turn index" });
  return {
    db,
    runtime: {
      pendingCodexProviderTurnByClientTurnId: new Map(),
    },
    workspaceId,
    threadId,
    close: () => {
      db.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

/** 构造 Server 已分配 seq 的 Codex raw turn/started ACK。 */
function createRawStartedEvent(input: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  clientTurnId?: TurnId;
  providerTurnId?: string;
}): RawEngineEventEnvelope {
  return {
    schema: 1,
    seq: 30,
    ts: 3_000,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    engine: "codex",
    source: "codex.app-server.msg",
    ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}),
    data: {
      method: "turn/started",
      params: { threadId: "provider-thread", turn: { id: input.providerTurnId ?? "provider-turn" } },
    },
    handled: true,
    action: "ignored",
    emittedTypes: [],
  };
}

test("raw turn/started 可对账到已终态的精确本地 turn", () => {
  const harness = createIndexHarness();
  const turnId = "turn-terminal" as TurnId;
  try {
    harness.db.turns.insertStarted({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      turnId,
      startedAt: 1_000,
      startEventSeq: 10,
    });
    harness.db.turns.setEnded(turnId, { status: "error", endedAt: 2_000, endEventSeq: 20 });

    const result = indexCodexProviderTurnStarted({ db: harness.db, runtime: harness.runtime }, createRawStartedEvent({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      clientTurnId: turnId,
      providerTurnId: "provider-late",
    }));

    assert.deepEqual(result, {
      kind: "mapped",
      clientTurnId: turnId,
      providerTurnId: "provider-late",
      localTurnStatus: "error",
    });
    const checkpoint = JSON.parse(String(harness.db.turns.get(turnId)?.engineCheckpointJson));
    assert.equal(checkpoint.codexProviderTurn.engineTurnId, "provider-late");
    assert.equal(checkpoint.codexProviderTurn.source, "turn/started");
  } finally {
    harness.close();
  }
});

test("精确终态关联优先于同线程的新 running turn", () => {
  const harness = createIndexHarness();
  const oldTurnId = "turn-old-terminal" as TurnId;
  const newTurnId = "turn-new-running" as TurnId;
  try {
    harness.db.turns.insertStarted({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      turnId: oldTurnId,
      startedAt: 1_000,
      startEventSeq: 10,
    });
    harness.db.turns.setEnded(oldTurnId, { status: "error", endedAt: 2_000, endEventSeq: 20 });
    harness.db.turns.insertStarted({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      turnId: newTurnId,
      startedAt: 2_500,
      startEventSeq: 25,
    });
    const result = indexCodexProviderTurnStarted({ db: harness.db, runtime: harness.runtime }, createRawStartedEvent({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      clientTurnId: oldTurnId,
      providerTurnId: "provider-old-late",
    }));

    assert.equal(result.kind === "mapped" ? result.clientTurnId : null, oldTurnId);
    const oldCheckpoint = JSON.parse(String(harness.db.turns.get(oldTurnId)?.engineCheckpointJson));
    assert.equal(oldCheckpoint.codexProviderTurn.engineTurnId, "provider-old-late");
    assert.equal(harness.db.turns.get(newTurnId)?.engineCheckpointJson, null);
  } finally {
    harness.close();
  }
});

test("同一本地 turn 收到冲突 provider ID 时显式失败", () => {
  const harness = createIndexHarness();
  const turnId = "turn-provider-conflict" as TurnId;
  try {
    harness.db.turns.insertStarted({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      turnId,
      startedAt: 1_000,
      startEventSeq: 10,
    });
    indexCodexProviderTurnStarted({ db: harness.db, runtime: harness.runtime }, createRawStartedEvent({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      clientTurnId: turnId,
      providerTurnId: "provider-first",
    }));

    assert.throws(
      () => indexCodexProviderTurnStarted({ db: harness.db, runtime: harness.runtime }, createRawStartedEvent({
        workspaceId: harness.workspaceId,
        threadId: harness.threadId,
        clientTurnId: turnId,
        providerTurnId: "provider-conflict",
      })),
      /Codex provider turn mapping conflict/,
    );
  } finally {
    harness.close();
  }
});

test("raw turn/started 早于 canonical turn 行时暂存精确映射", () => {
  const harness = createIndexHarness();
  const turnId = "turn-pending" as TurnId;
  try {
    const result = indexCodexProviderTurnStarted({ db: harness.db, runtime: harness.runtime }, createRawStartedEvent({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      clientTurnId: turnId,
      providerTurnId: "provider-pending",
    }));

    assert.equal(result.kind, "mapped");
    assert.equal(result.kind === "mapped" ? result.localTurnStatus : null, "pending");
    assert.equal(
      harness.runtime.pendingCodexProviderTurnByClientTurnId.get(turnId)?.engineTurnId,
      "provider-pending",
    );
  } finally {
    harness.close();
  }
});

test("缺少精确关联时即使存在 runtime 与唯一 running 候选也结构化忽略", () => {
  const harness = createIndexHarness();
  const turnId = "turn-legacy-candidate" as TurnId;
  try {
    harness.db.turns.insertStarted({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      engine: "codex",
      turnId,
      startedAt: 1_000,
      startEventSeq: 10,
    });
    const runtimeWithLegacyCandidate = harness.runtime as CodexProviderTurnIndexRuntime & {
      activeTurnByThreadId: Map<ThreadId, { turnId: TurnId }>;
    };
    runtimeWithLegacyCandidate.activeTurnByThreadId = new Map([
      [harness.threadId, { turnId }],
    ]);

    const result = indexCodexProviderTurnStarted(
      { db: harness.db, runtime: runtimeWithLegacyCandidate },
      createRawStartedEvent({
        workspaceId: harness.workspaceId,
        threadId: harness.threadId,
        providerTurnId: "provider-unowned",
      }),
    );

    assert.deepEqual(result, {
      kind: "ignored",
      reason: "missing_client_turn_id",
      providerTurnId: "provider-unowned",
    });
    assert.equal(harness.db.turns.get(turnId)?.engineCheckpointJson, null);
    assert.equal(harness.runtime.pendingCodexProviderTurnByClientTurnId.size, 0);
  } finally {
    harness.close();
  }
});

test("显式 clientTurnId 但缺少 provider turnId 时显式失败", () => {
  const harness = createIndexHarness();
  const turnId = "turn-missing-provider" as TurnId;
  try {
    const event = createRawStartedEvent({
      workspaceId: harness.workspaceId,
      threadId: harness.threadId,
      clientTurnId: turnId,
      providerTurnId: "provider-placeholder",
    });
    (event.data as any).params.turn.id = "";

    assert.throws(
      () => indexCodexProviderTurnStarted({ db: harness.db, runtime: harness.runtime }, event),
      /缺少 provider turnId.*clientTurnId=turn-missing-provider.*eventSeq=/,
    );
    assert.equal(harness.runtime.pendingCodexProviderTurnByClientTurnId.size, 0);
  } finally {
    harness.close();
  }
});
