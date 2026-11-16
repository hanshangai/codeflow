import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ClientToServerMessage, WorkspaceId } from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { handleOrchRuntimeEvidenceGet } from "../../apps/desktop/client/src/app/handlers/orchestrationHandlers.ts";

test("runtime evidence reports raw trace gaps for the requested execution", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-runtime-evidence-"));
  const workspaceId = "ws-runtime-evidence" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const sent: ClientToServerMessage[] = [];
  try {
    db.workspaces.upsert({ id: workspaceId, title: "runtime evidence", path: tempDir });
    const threadId = "thread-runtime-evidence" as any;
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "node thread", threadType: "orchestration", threadSubtype: "node" });
    const instance = db.orchInstances.create({
      workspaceId,
      workflowId: "workflow-runtime-evidence" as any,
      workflowSnapshot: {
        id: "workflow-runtime-evidence",
        workspaceId,
        name: "runtime evidence",
        description: "",
        nodes: [{ id: "node-a", type: "role", label: "Node A", roleId: "role-a", position: { x: 0, y: 0 } }],
        edges: [],
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      } as any,
      intakeSnapshot: { id: "intake-runtime-evidence", workspaceId, title: "runtime evidence", goal: "test", triggerMode: "manual", taskType: "test", createdAt: 1, updatedAt: 1 } as any,
    });
    db.orchInstances.updateNodeStates(instance.id, {
      ...instance.nodeStates,
      "node-a": { ...instance.nodeStates["node-a"], attemptNo: 2, threadId },
    });
    const snapshot = db.orchPromptSnapshots.create({
      instanceId: instance.id,
      nodeId: "node-a",
      attemptNo: 2,
      threadId,
      turnId: "turn-2",
      engine: "codex",
      model: "test-model",
      effort: null,
      promptEnvelope: {} as any,
      systemMessage: "system",
      developerMessage: null,
      userMessage: "user",
      renderedInputPreview: "preview",
      runtimePolicy: {} as any,
      toolRegistry: null,
      knowledgeCatalogs: [],
      artifactInput: {} as any,
      createdAt: 200,
    });
    db.db.prepare("INSERT INTO conversation_events (seq, thread_id, workspace_id, engine, type, event_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(100, threadId, workspaceId, "codex", "turn.completed", "{}", 200);
    db.db.prepare("INSERT INTO conversation_events (seq, thread_id, workspace_id, engine, type, event_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(101, threadId, workspaceId, "codex", "turn.completed", "{}", 300);
    db.db.prepare("INSERT INTO raw_engine_events (seq, thread_id, workspace_id, engine, source, event_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(201, threadId, workspaceId, "codex", "engine", "{}", 200);
    db.db.prepare("INSERT INTO thread_turns (thread_id, turn_id, workspace_id, engine, status, started_at, ended_at, start_event_seq, end_event_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(threadId, "turn-2", workspaceId, "codex", "completed", 250, 300, 101, 101);

    handleOrchRuntimeEvidenceGet({
      db,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (message: ClientToServerMessage) => sent.push(message),
    } as any, {
      t: "api.req",
      id: "runtime-evidence-1",
      method: "orch.runtimeEvidence.get",
      body: { workspaceId, instanceId: instance.id, nodeId: "node-a", attemptNo: 2, limit: 10 },
    } as any);

    const response = sent.at(-1) as any;
    assert.equal(response.status, 200);
    assert.equal(response.body.scopeStatus, "available");
    assert.equal(response.body.promptSnapshotTotal, 1);
    assert.equal(response.body.promptSnapshotsTruncated, false);
    assert.equal(response.body.status.promptSnapshot, "available");
    assert.equal(response.body.status.conversationTrace, "available");
    assert.equal(response.body.status.rawTrace, "incomplete");
    assert.equal(response.body.promptSnapshots[0].id, snapshot.id);
    assert.equal(response.body.threads[0].conversationEventCount, 1);
    assert.equal(response.body.threads[0].rawEngineEventCount, 0);
    assert.equal(response.body.threads[0].latestTurns[0].turnId, "turn-2");

    const traceSnapshot = db.orchPromptSnapshots.create({
      instanceId: instance.id,
      nodeId: "node-a",
      attemptNo: 3,
      threadId,
      turnId: "turn-3",
      engine: "codex",
      model: "gpt-5",
      effort: "high",
      promptEnvelope: { meta: { trace: true } } as any,
      systemMessage: "trace system",
      developerMessage: "trace developer",
      userMessage: "trace user",
      renderedInputPreview: "trace preview",
      runtimePolicy: {} as any,
      toolRegistry: null,
      knowledgeCatalogs: [],
      artifactInput: {} as any,
      createdAt: 400,
    });
    const canonicalEvent = {
      schema: 1,
      seq: 102,
      ts: 450,
      workspaceId,
      threadId,
      engine: "codex",
      type: "item.agentMessage.completed",
      payload: { itemId: "item-trace", text: "trace output", phase: "final_answer" },
    };
    const rawEvent = {
      schema: 1,
      seq: 202,
      ts: 440,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      data: { method: "item/agentMessage/delta" },
      handled: true,
      action: "mapped",
      emittedTypes: ["item.agentMessage.completed"],
    };
    db.db.prepare("INSERT INTO conversation_events (seq, thread_id, workspace_id, engine, type, event_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(102, threadId, workspaceId, "codex", canonicalEvent.type, JSON.stringify(canonicalEvent), canonicalEvent.ts);
    db.db.prepare("INSERT INTO raw_engine_events (seq, thread_id, workspace_id, engine, source, event_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(202, threadId, workspaceId, "codex", rawEvent.source, JSON.stringify(rawEvent), rawEvent.ts);
    db.db.prepare("INSERT INTO thread_turns (thread_id, turn_id, workspace_id, engine, status, started_at, ended_at, start_event_seq, end_event_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(threadId, "turn-3", workspaceId, "codex", "completed", 400, 500, 102, 102);

    handleOrchRuntimeEvidenceGet({
      db,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (message: ClientToServerMessage) => sent.push(message),
    } as any, {
      t: "api.req",
      id: "runtime-evidence-trace-detail",
      method: "orch.runtimeEvidence.get",
      body: { workspaceId, instanceId: instance.id, nodeId: "node-a", attemptNo: 3, promptSnapshotId: traceSnapshot.id, limit: 10 },
    } as any);
    const traceResponse = sent.at(-1) as any;
    assert.equal(traceResponse.status, 200);
    assert.equal(traceResponse.body.promptSnapshotTotal, 1);
    assert.equal(traceResponse.body.traceDetail.promptSnapshot.userMessage, "trace user");
    assert.equal(traceResponse.body.traceDetail.turn.turnId, "turn-3");
    assert.equal(traceResponse.body.traceDetail.conversationEventCount, 1);
    assert.equal(traceResponse.body.traceDetail.conversationEvents[0].payload.text, "trace output");
    assert.equal(traceResponse.body.traceDetail.rawEngineEventCount, 1);
    assert.equal(traceResponse.body.traceDetail.rawEngineEvents[0].source, "codex.app-server.msg");

    handleOrchRuntimeEvidenceGet({
      db,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (message: ClientToServerMessage) => sent.push(message),
    } as any, {
      t: "api.req",
      id: "runtime-evidence-trace-mismatch",
      method: "orch.runtimeEvidence.get",
      body: { workspaceId, instanceId: instance.id, nodeId: "node-a", attemptNo: 2, promptSnapshotId: traceSnapshot.id, limit: 10 },
    } as any);
    assert.equal((sent.at(-1) as any).status, 409);

    db.db.prepare("UPDATE raw_engine_events SET event_json = '{}' WHERE seq = 202").run();
    assert.throws(() => handleOrchRuntimeEvidenceGet({
      db,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (message: ClientToServerMessage) => sent.push(message),
    } as any, {
      t: "api.req",
      id: "runtime-evidence-corrupt-body",
      method: "orch.runtimeEvidence.get",
      body: { workspaceId, instanceId: instance.id, nodeId: "node-a", attemptNo: 3, promptSnapshotId: traceSnapshot.id, limit: 10 },
    } as any), /运行证据事件身份不一致.*seq=202/);

    handleOrchRuntimeEvidenceGet({
      db,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (message: ClientToServerMessage) => sent.push(message),
    } as any, {
      t: "api.req",
      id: "runtime-evidence-invalid-scope",
      method: "orch.runtimeEvidence.get",
      body: { workspaceId, instanceId: instance.id, attemptNo: 2 },
    } as any);
    assert.equal((sent.at(-1) as any).status, 400);

    handleOrchRuntimeEvidenceGet({
      db,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (message: ClientToServerMessage) => sent.push(message),
    } as any, {
      t: "api.req",
      id: "runtime-evidence-invalid-prompt-id",
      method: "orch.runtimeEvidence.get",
      body: { workspaceId, instanceId: instance.id, promptSnapshotId: { id: traceSnapshot.id } },
    } as any);
    assert.equal((sent.at(-1) as any).status, 400);

    handleOrchRuntimeEvidenceGet({
      db,
      workspaces: new Map([[workspaceId, tempDir]]),
      send: (message: ClientToServerMessage) => sent.push(message),
    } as any, {
      t: "api.req",
      id: "runtime-evidence-invalid-limit",
      method: "orch.runtimeEvidence.get",
      body: { workspaceId, instanceId: instance.id, nodeId: "node-a", limit: 101 },
    } as any);
    assert.equal((sent.at(-1) as any).status, 400);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
