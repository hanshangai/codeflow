import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRoleExecutionConfig, createDefaultRoleInputDefinition, createDefaultRoleOutputDefinition,
  type RoleDefinition, type ThreadId, type WorkspaceId } from "@codeflowai/shared";
import { openClientDb, type ClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";
import { WorkspaceMigrationActivityInspector } from "../src/workspace-migration/workspaceMigrationActivityInspector.js";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.js";
import { ThreadStore } from "../src/threads/threadStore.js";

/** 每W使用独立真实库，根库只保存注册和迁移权威。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-core-migration-scope-"));
  const gate = new WorkspaceOperationGate();
  const db = openClientDb({ dbPath: path.join(root, "application.db"), workspaceOperationGate: gate });
  const views: ClientDb[] = [];
  for (const name of ["a", "b"]) {
    const workspaceId = `migration:${name}` as WorkspaceId, directory = path.join(root, name);
    fs.mkdirSync(directory);
    db.workspaces.upsert({ id: workspaceId, title: name, path: directory });
    views.push(db.forWorkspace(workspaceId));
  }
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, views, gate };
}

/** 从真实完整Repo创建运行实验，迁移门禁必须读取W内快照和Run。 */
function addExperiment(view: ClientDb) {
  view.controlledExperiments.commitFreeze({ experimentId: "same-experiment", freezeRevision: 1, freezeDigest: "a".repeat(64), snapshots: [{
    id: "same-snapshot", experimentId: "same-experiment", freezeRevision: 1, freezeDigest: "a".repeat(64), workspaceId: view.workspaceId!,
    sampleId: "sample", evaluationItemId: "item", sourceInstanceId: "instance", nodeId: "node", promptSnapshotId: "prompt", ordinal: 1,
    variantKey: "baseline", engine: "codex", model: "model", effort: null, catalogVersion: 1, promptEnvelope: {} as never,
    systemMessage: "执行", developerMessage: null, userMessage: "工作", artifactInput: {} as never, inputSha256: "b".repeat(64),
    configSha256: "c".repeat(64), promptDefinitionSha256: "d".repeat(64), priceSnapshot: null,
    priceSnapshotSha256: "e".repeat(64), perRunTimeoutMs: 60_000, createdAt: 1,
  }] });
  view.controlledExperiments.createDispatchedRun({ id: "same-run", experimentId: "same-experiment", assignmentId: "assignment",
    sampleId: "sample", variantKey: "baseline", attemptNo: 1, snapshotId: "same-snapshot", dispatchTokenSha256: "f".repeat(64),
    clientTurnId: "experiment-turn", engine: "codex", deadlineAt: 100_000, now: 1 });
}

test("迁移检查器从指定W汇总turn、queue、草案、实验及child engine，不漏读应用空表", t => {
  const f = fixture(t), [a, b] = f.views;
  const threadId = "same-thread" as ThreadId;
  for (const view of f.views) view.threads.create({ id: threadId, workspaceId: view.workspaceId!, engine: "codex", title: "会话" });
  a!.turns.insertStarted({ workspaceId: a!.workspaceId!, threadId, engine: "codex", turnId: "same-turn" as never, startedAt: 1, startEventSeq: null });
  const queue = a!.threadMessageQueue.appendItem({ workspaceId: a!.workspaceId!, threadId, text: "运行输入", images: [], files: [],
    sendOptions: { workMode: "general", planMode: false, accessMode: null, model: null, effort: null }, originWebSessionId: null }).item;
  a!.db.prepare("UPDATE thread_message_queue SET status='sending' WHERE id=?").run(queue.id);
  const job = a!.orchAssetGenerationJobs.create({ workspaceId: a!.workspaceId!, assetKind: "role", mode: "create", status: "generating",
    targetAssetId: null, clientRequestId: null, baseVersionId: null, draftId: null, threadId, prompt: "生成", requestJson: null,
    interactionRequest: null, progress: null, failure: null });
  addExperiment(a!);
  const engineScopes: WorkspaceId[] = [];
  const inspector = new WorkspaceMigrationActivityInspector({ db: f.db, gate: f.gate, orchEngine: {
    existingWorkspace(workspaceId: WorkspaceId) { engineScopes.push(workspaceId); return { listManagedServicesForThread() {
      return workspaceId === a!.workspaceId ? [{ serviceId: "service-a", status: "ready" }] : [];
    } }; },
    forWorkspace() { throw new Error("UNEXPECTED_ENGINE_INITIALIZATION"); },
    listManagedServicesForThread() { throw new Error("UNSCOPED_ENGINE_READ"); },
  } as never });
  assert.deepEqual(inspector.inspect(a!.workspaceId!), [
    { type: "asset_generation_job", count: 1, resourceIds: [job.id] },
    { type: "controlled_experiment", count: 1, resourceIds: ["experiment-turn"] },
    { type: "managed_service", count: 1, resourceIds: ["service-a"] },
    { type: "queue_dispatch", count: 1, resourceIds: [queue.id] },
    { type: "turn", count: 1, resourceIds: [`${threadId}:same-turn`] },
  ]);
  assert.deepEqual(inspector.inspect(b!.workspaceId!), []);
  assert.deepEqual(engineScopes, [a!.workspaceId, b!.workspaceId]);
});

test("持有迁移owner后检查现有W活动不自锁，也不创建新引擎owner", async t => {
  const f = fixture(t), [a] = f.views;
  const threadId = "migration-thread" as ThreadId;
  a!.threads.create({ id: threadId, workspaceId: a!.workspaceId!, engine: "codex", title: "迁移会话" });
  a!.turns.insertStarted({ workspaceId: a!.workspaceId!, threadId, engine: "codex", turnId: "running-turn" as never,
    startedAt: 1, startEventSeq: null });
  const inspector = new WorkspaceMigrationActivityInspector({ db: f.db, gate: f.gate, orchEngine: {
    existingWorkspace() { return null; },
    forWorkspace() { throw new Error("UNEXPECTED_ENGINE_INITIALIZATION"); },
  } as never });
  const release = await f.gate.acquireMigration(a!.workspaceId!, "inspect-owner");
  try {
    assert.deepEqual(inspector.inspect(a!.workspaceId!), [
      { type: "turn", count: 1, resourceIds: [`${threadId}:running-turn`] },
    ]);
    assert.equal(f.gate.getMigrationOperationId(a!.workspaceId!), "inspect-owner");
    assert.equal(f.gate.hasActiveWrites(), false);
    assert.throws(() => a!.threads.get(threadId), error => (error as { code?: string }).code === "WORKSPACE_MIGRATION_IN_PROGRESS");
  } finally { release(); }
});

test("迁移门禁内读取真实子引擎进程事实复用已核会话，不重开写连接", async t => {
  const f = fixture(t), [a] = f.views;
  const threadId = "engine-thread" as ThreadId;
  a!.threads.create({ id: threadId, workspaceId: a!.workspaceId!, engine: "codex", title: "引擎会话" });
  const engine = new OrchestrationEngine({ db: f.db, threads: new ThreadStore(),
    sessions: { listEngineManagedServices: () => [{ serviceId: "engine-managed", status: "ready", startedAt: 1 }] } as never,
    workspaces: new Map(),
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 },
    emitConversation() {}, emitRaw() {} });
  engine.forWorkspace(a!.workspaceId!);
  const inspector = new WorkspaceMigrationActivityInspector({ db: f.db, gate: f.gate, orchEngine: engine });
  const release = await f.gate.acquireMigration(a!.workspaceId!, "engine-inspect-owner");
  try { assert.deepEqual(inspector.inspect(a!.workspaceId!), [
    { type: "managed_service", count: 1, resourceIds: ["engine-managed"] },
  ]); }
  finally { release(); await engine.stopAndDrain(); }
});
