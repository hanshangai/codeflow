import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openClientDb } from "../src/db/clientDb.js";
import { OrchestrationEngine } from "../src/orchestration/orchestrationEngine.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";
import { WorkspaceMigrationActivityInspector } from "../src/workspace-migration/workspaceMigrationActivityInspector.js";
import { WorkspaceMigrationService } from "../src/workspace-migration/workspaceMigrationService.js";
import { createWorkspaceMigrationRuntimeCallbacks } from "../src/workspace-migration/workspaceMigrationRuntimeCallbacks.js";
import { WorkspacePathIndexService } from "../src/fs/workspacePathIndexService.js";
import { WorkspaceMigrationIndexCoordinatorService } from "../src/workspace-migration/workspaceMigrationIndexCoordinator.js";

test("真实迁移沿原运行回调在独占期释放会话并提交，只通知路径变更", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-runtime-migration-"));
  const sourcePath = path.join(root, "source"), targetParentPath = path.join(root, "target");
  fs.mkdirSync(sourcePath); fs.mkdirSync(targetParentPath);
  const gate = new WorkspaceOperationGate();
  const db = openClientDb({ dbPath: path.join(root, "app.db"), workspaceOperationGate: gate });
  const workspaceId = "runtime-migration";
  db.workspaces.upsert({ id: workspaceId, title: "迁移", path: sourcePath });
  db.forWorkspace(workspaceId).threads.create({ id: "thread", workspaceId, engine: "codex", title: "会话" });
  const workspaces = new Map([[workspaceId, sourcePath]]);
  const pathIndex = new WorkspacePathIndexService({ warmupDelayMs: 0, writeWorkspaceLog: (id, entry) => db.writeWorkspaceLog(id, entry) });
  pathIndex.upsertWorkspace(workspaceId, sourcePath, { prepareOnly: true });
  const coordinator = new WorkspaceMigrationIndexCoordinatorService({ db, pathIndex });
  let operationId = "", builds = 0;
  pathIndex.subscribeLifecycle(event => {
    if (event.type !== "building") return;
    builds++;
    assert.equal(gate.getMigrationOperationId(workspaceId), null);
    assert.equal(db.workspaceDirectoryMigrations.require(operationId).state, "completed");
    assert.equal(db.workspaces.get(workspaceId)?.path, path.join(targetParentPath, "moved"));
  });
  const disposed: string[] = [], notifications: string[] = [], paths: string[] = [];
  const hooks = createWorkspaceMigrationRuntimeCallbacks({ db, gate,
    sessions: { async disposeThread(id) {
      assert.ok(gate.getMigrationOperationId(workspaceId));
      assert.equal(gate.listActivities(workspaceId).length, 0);
      disposed.push(id);
    } },
    pathIndex: { upsertWorkspace(id, directory, options) {
      assert.equal(id, workspaceId); assert.deepEqual(options, { prepareOnly: true });
      assert.ok(gate.getMigrationOperationId(id)); paths.push(directory);
      pathIndex.upsertWorkspace(id, directory, options);
      assert.equal(builds, 0);
    } },
    async onWorkspacesChanged(reason) {
      assert.ok(gate.getMigrationOperationId(workspaceId));
      notifications.push(reason);
      if (reason !== "migration") db.forWorkspace(workspaceId).orchRoles.listByWorkspace(workspaceId);
    },
  });
  const service = new WorkspaceMigrationService({ db, gate, workspaces, ...hooks,
    activityInspector: new WorkspaceMigrationActivityInspector({ db, gate }),
    storageClassifier: { async assertSupportedTarget(realPath: string) {
      return { platform: process.platform, realPath, mountPoint: path.parse(realPath).root,
        fileSystemType: process.platform === "win32" ? "ntfs" : "ext4", deviceIds: ["test"], busTypes: ["test"] };
    } } as never,
    indexCoordinator: coordinator });
  t.after(async () => {
    try { await service.stopAndDrain(); }
    finally { try { await coordinator.dispose(); } finally { try { await pathIndex.dispose(); } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); } } }
  });
  const prepared = await service.prepare({ requestId: "runtime-migration", workspaceId,
    idempotencyKey: "runtime-migration", targetParentPath, targetDirectoryName: "moved" });
  operationId = prepared.operationId;
  await service.waitForIdle(prepared.operationId);
  assert.equal(db.workspaceDirectoryMigrations.require(prepared.operationId).state, "awaiting_confirmation");
  const accepted = service.prepareStartAttempt({ operationId: prepared.operationId, startAttemptId: "attempt",
    externalWritesPausedConfirmed: true, targetNotSyncManagedConfirmed: true });
  service.executeStart({ requestId: "runtime-migration", operationId: accepted.operationId, startAttemptId: "attempt",
    expectedStateVersion: accepted.stateVersion });
  await service.waitForIdle(accepted.operationId);
  const completed = db.workspaceDirectoryMigrations.require(accepted.operationId);
  assert.equal(completed.state, "completed", JSON.stringify(completed));
  assert.deepEqual(disposed, ["thread"]);
  assert.deepEqual(notifications, ["migration"]);
  assert.deepEqual(paths, [path.join(targetParentPath, "moved")]);
  assert.equal(db.forWorkspace(workspaceId).threads.get("thread")?.title, "会话");
  assert.equal(gate.getMigrationOperationId(workspaceId), null);
  await pathIndex.waitForIdle();
  assert.equal(builds, 1);
  assert.equal(pathIndex.search(workspaceId, path.join(targetParentPath, "moved"), "x").indexStatus, "ready");
  assert.equal(db.workspaceDirectoryMigrations.require(operationId).indexRebuildStatus, "ready");
});

test("内存执行入口拒绝把另一工作区同名会话复用为现有会话", () => {
  const store = new ThreadStore();
  const first = store.create({ threadId: "same", workspaceId: "a", engine: "codex", title: "甲" });
  assert.throws(() => store.create({ threadId: "same", workspaceId: "b", engine: "codex", title: "乙" }), /THREAD_RUNTIME_SCOPE_CONFLICT/);
  assert.equal(store.get("same"), first);
});

test("编排异步 owner 固定工作区且根引擎等待各工作区收口", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-engine-"));
  const db = openClientDb({ dbPath: path.join(root, "app.db") });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const id of ["a", "b"]) {
    const directory = path.join(root, id);
    fs.mkdirSync(directory);
    db.workspaces.upsert({ id, title: id, path: directory });
  }
  const engine = new OrchestrationEngine({ db, threads: new ThreadStore(), sessions: {} as any,
    workspaces: new Map(), timeoutPolicy: { mode: "activity", startupTimeoutMs: 1000, engineIdleTimeoutMs: 1000 },
    emitConversation() {}, emitRaw() {} });
  const a = engine.forWorkspace("a"), b = engine.forWorkspace("b");
  assert.equal(engine.forWorkspace("a"), a);
  assert.notEqual(a, b);
  assert.equal((a as any).ctx.db.workspaceId, "a");
  assert.equal((b as any).ctx.db.workspaceId, "b");
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  (a as any).continuationPromises.add(waiting);
  assert.equal(engine.hasInFlightWork(), true);
  let drained = false;
  const drain = engine.stopAndDrain().then(() => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  assert.equal((a as any).stopping, true);
  assert.equal((b as any).stopping, true);
  release();
  await drain;
  assert.equal(engine.hasInFlightWork(), false);
});
