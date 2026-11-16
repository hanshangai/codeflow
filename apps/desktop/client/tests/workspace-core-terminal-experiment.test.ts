import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { ENGINE_MODEL_CATALOG_SCHEMA_VERSION, type ControlledExperimentRunStartRpcRequest, type WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { applyEngineModelCatalogSnapshot, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.js";
import { ControlledExperimentExecutor } from "../src/experiments/controlledExperimentExecutor.js";
import { handleControlledExperimentRunStatus } from "../src/app/handlers/controlledExperimentHandlers.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";
import { WorkspaceMigrationActivityInspector } from "../src/workspace-migration/workspaceMigrationActivityInspector.js";
import { WorkspaceMigrationService } from "../src/workspace-migration/workspaceMigrationService.js";
import type { StorageClassifier } from "../src/workspace-migration/storageClassifier.js";

const nativePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
mock.method(nativePty, "spawn", () => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} }));
const { TerminalManager } = await import("../src/terminal/terminalManager.js");

test("终端标签与删除沿原terminal携带工作区，持久化错误不得伪造成功", t => {
  const calls: unknown[][] = [];
  let rejectLabel = false;
  let rejectRemove = false;
  const manager = new TerminalManager({ workspaces: new Map([["workspace-a", process.cwd()], ["workspace-b", process.cwd()]]),
    writeWorkspaceLog() {}, onError(error) { throw error; },
    onCreated() {}, onOutput() {}, onExited() {}, persistence: {
      save() {}, listByWorkspace: () => [],
      updateLabel(...args) { if (rejectLabel) throw new Error("injected-label-failure"); calls.push(["label", ...args]); },
      remove(...args) { if (rejectRemove) throw new Error("injected-remove-failure"); calls.push(["remove", ...args]); },
    } });
  t.after(() => manager.dispose());
  const terminal = manager.create({ workspaceId: "workspace-b", shell: "powershell.exe", label: "原标签" });
  manager.rename(terminal.id, "新标签");
  assert.deepEqual(calls[0], ["label", terminal.id, "新标签", "workspace-b"]);
  rejectLabel = true;
  assert.throws(() => manager.rename(terminal.id, "不得提交"));
  assert.equal(manager.get(terminal.id)?.label, "新标签");
  rejectRemove = true;
  assert.throws(() => manager.close(terminal.id));
  assert.ok(manager.get(terminal.id));
  rejectRemove = false;
  manager.close(terminal.id);
  assert.deepEqual(calls.at(-1), ["remove", terminal.id, "workspace-b"]);
});

test("终端持久化保存工作区相对cwd，PTY与页面仍使用已校验绝对路径", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-terminal-cwd-"));
  fs.mkdirSync(path.join(root, "nested"));
  const saved: any[] = [];
  const manager = new TerminalManager({ workspaces: new Map([["workspace", root]]), onCreated() {}, onOutput() {}, onExited() {},
    writeWorkspaceLog() {}, onError(error) { throw error; },
    persistence: { save: config => { saved.push(config); }, remove() {}, updateLabel() {}, listByWorkspace: () => [] } });
  t.after(() => { manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const nested = manager.create({ workspaceId: "workspace", shell: "powershell.exe", cwd: path.join(root, "nested") });
  manager.create({ workspaceId: "workspace", shell: "powershell.exe" });
  assert.equal(nested.cwd, path.join(root, "nested"));
  assert.deepEqual(saved.map(config => config.cwd), ["nested", "."]);
});

/** 真实工作区库、原迁移服务和文件 Worker；仅替换固定磁盘证明。 */
function migrationFixture(t: test.TestContext, beforeSnapshot?: (source: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-terminal-migration-"));
  const source = path.join(root, "source"), parent = path.join(root, "destination"), target = path.join(parent, "migrated");
  fs.mkdirSync(path.join(source, "nested"), { recursive: true }); fs.mkdirSync(parent);
  fs.writeFileSync(path.join(source, "nested", "file.txt"), "preserved", "utf8");
  const gate = new WorkspaceOperationGate(), workspaceId = "terminal:workspace" as WorkspaceId;
  const db = openClientDb({ dbPath: path.join(root, "application.db"), workspaceOperationGate: gate });
  db.workspaces.upsert({ id: workspaceId, title: "终端迁移", path: source });
  const view = db.forWorkspace(workspaceId), workspaces = new Map([[workspaceId, source]]);
  const service = new WorkspaceMigrationService({ db, gate, workspaces,
    activityInspector: new WorkspaceMigrationActivityInspector({ db, gate }),
    storageClassifier: { assertSupportedTarget: async (realPath: string) => ({ platform: process.platform, realPath,
      mountPoint: path.parse(realPath).root, fileSystemType: process.platform === "win32" ? "ntfs" : "ext4",
      deviceIds: ["test-device"], busTypes: ["test-bus"] }) } as StorageClassifier,
    indexCoordinator: { reserveForMigration: async () => ({ kind: "not_applicable" }) },
    disposeWorkspaceSessions: async () => { beforeSnapshot?.(source); } });
  t.after(async () => { await service.stopAndDrain(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  /** 沿原入口等待预检和实际迁移，返回权威持久态。 */
  async function migrate() {
    const operation = await service.prepare({ requestId: "terminal-migrate", workspaceId, idempotencyKey: "terminal-migrate",
      targetParentPath: parent, targetDirectoryName: "migrated" });
    await service.waitForIdle(operation.operationId);
    const scanned = db.workspaceDirectoryMigrations.require(operation.operationId);
    if (scanned.state !== "awaiting_confirmation") return scanned;
    const prepared = service.prepareStartAttempt({ operationId: scanned.operationId, startAttemptId: "terminal-attempt",
      externalWritesPausedConfirmed: true, targetNotSyncManagedConfirmed: true });
    service.executeStart({ requestId: "terminal-start", operationId: prepared.operationId, startAttemptId: "terminal-attempt",
      expectedStateVersion: prepared.stateVersion });
    await service.waitForIdle(prepared.operationId);
    return db.workspaceDirectoryMigrations.require(prepared.operationId);
  }
  return { db, view, source, target, workspaceId, workspaces, service, migrate };
}

test("终端W相对配置随最终快照迁移，app旧绝对配置仍在原CAS内转换", async t => {
  const f = migrationFixture(t);
  f.view.terminalConfigs.insert({ id: "workspace-terminal", workspaceId: f.workspaceId, label: "工作区", shell: null, cwd: "nested" });
  f.db.terminalConfigs.insert({ id: "legacy-terminal", workspaceId: f.workspaceId, label: "旧配置", shell: null, cwd: path.join(f.source, "nested") });
  const completed = await f.migrate();
  assert.equal(completed.state, "completed", JSON.stringify(completed));
  assert.equal(f.workspaces.get(f.workspaceId), f.target);
  assert.equal(f.view.terminalConfigs.listByWorkspace(f.workspaceId)[0]?.cwd, "nested");
  assert.equal(f.db.terminalConfigs.listByWorkspace(f.workspaceId)[0]?.cwd, "nested");
  const source = openSqliteDb(path.join(f.source, ".codeflowai", "workspace.db"), { readonly: true, fileMustExist: true });
  try { assert.equal((source.prepare("SELECT cwd FROM terminal_configs WHERE id='workspace-terminal'").get() as { cwd: string }).cwd, "nested"); }
  finally { source.close(); }
});

test("终端W既有绝对cwd在迁移预检显式拒绝，保持源配置和路径", async t => {
  const f = migrationFixture(t), absolute = path.join(f.source, "nested");
  f.view.terminalConfigs.insert({ id: "absolute-terminal", workspaceId: f.workspaceId, label: "旧绝对路径", shell: null, cwd: absolute });
  const failed = await f.migrate();
  assert.equal(failed.state, "failed");
  assert.equal(failed.errorCode, "WORKSPACE_MIGRATION_TARGET_INVALID");
  assert.equal((failed.errorDetails as { terminalId: string }).terminalId, "absolute-terminal");
  assert.equal(f.db.workspaces.get(f.workspaceId)?.path, f.source);
  assert.equal(f.view.terminalConfigs.listByWorkspace(f.workspaceId)[0]?.cwd, absolute);
  assert.equal(fs.existsSync(f.target), false);
});

test("最终快照前W终端被外部改为绝对路径时禁止提交，不补写W伪造相对值", async t => {
  const f = migrationFixture(t, source => {
    const writer = openSqliteDb(path.join(source, ".codeflowai", "workspace.db"), { fileMustExist: true });
    try { writer.prepare("UPDATE terminal_configs SET cwd=? WHERE id='workspace-terminal'").run(path.join(source, "nested")); }
    finally { writer.close(); }
  });
  f.view.terminalConfigs.insert({ id: "workspace-terminal", workspaceId: f.workspaceId, label: "工作区", shell: null, cwd: "nested" });
  const failed = await f.migrate();
  assert.equal(failed.state, "recovery_required");
  assert.equal(failed.errorCode, "WORKSPACE_MIGRATION_TARGET_INVALID");
  assert.equal(f.db.workspaces.get(f.workspaceId)?.path, f.source);
  assert.equal(f.workspaces.get(f.workspaceId), f.source);
  const source = openSqliteDb(path.join(f.source, ".codeflowai", "workspace.db"), { readonly: true, fileMustExist: true });
  try { assert.equal((source.prepare("SELECT cwd FROM terminal_configs WHERE id='workspace-terminal'").get() as { cwd: string }).cwd, path.join(f.source, "nested")); }
  finally { source.close(); }
});

test("原app路径CAS失败保留W原配置与源字节，不先提交W终端转换", async t => {
  const f = migrationFixture(t);
  f.view.terminalConfigs.insert({ id: "workspace-terminal", workspaceId: f.workspaceId, label: "工作区", shell: null, cwd: "nested" });
  f.db.terminalConfigs.insert({ id: "legacy-terminal", workspaceId: f.workspaceId, label: "旧配置", shell: null, cwd: path.join(f.source, "nested") });
  f.db.applicationDb.exec("CREATE TEMP TRIGGER reject_path_commit BEFORE UPDATE OF path ON workspaces BEGIN SELECT RAISE(ABORT,'injected-path-cas-failure'); END");
  const commit = f.db.workspaceDirectoryMigrations.commitPath.bind(f.db.workspaceDirectoryMigrations);
  let sourceHash: string | undefined;
  t.mock.method(f.db.workspaceDirectoryMigrations, "commitPath", input => {
    sourceHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(f.source, ".codeflowai", "workspace.db"))).digest("hex");
    return commit(input);
  });
  const failed = await f.migrate();
  assert.equal(failed.state, "recovery_required");
  assert.ok(sourceHash);
  assert.equal(f.db.workspaces.get(f.workspaceId)?.path, f.source);
  assert.equal(f.workspaces.get(f.workspaceId), f.source);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(f.source, ".codeflowai", "workspace.db"))).digest("hex"), sourceHash);
  assert.equal(f.db.terminalConfigs.listByWorkspace(f.workspaceId)[0]?.cwd, path.join(f.source, "nested"));
});

/** 独占应用库与工作区；冻结证据和运行事实全部写入原仓储。 */
function experimentFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-experiments-"));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  const workspaces = new Map<WorkspaceId, string>();
  for (const name of ["a", "b"]) {
    const workspaceId = `experiment-client:${name}` as WorkspaceId, directory = path.join(root, name);
    fs.mkdirSync(directory); workspaces.set(workspaceId, directory);
    db.workspaces.upsert({ id: workspaceId, title: name, path: directory });
  }
  applyEngineModelCatalogSnapshot({ schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION, configVersion: 1, capturedAt: 1,
    rows: [{ catalogItemId: "workspace-test-model", engine: "claude", providerId: "anthropic", providerLabel: "Anthropic",
      modelId: "claude-test", displayName: "Test", description: "", inputModalities: ["text"], supportedReasoningEfforts: [],
      defaultReasoningEffort: null, contextWindow: 200_000, maxContextWindow: null, supportsFastMode: false,
      supports1MContext: false, isDefault: true, sortOrder: 1, runtimeProfileId: "native", transportModelId: null,
      fastTaskModelId: null, subagentModelId: null },
    { catalogItemId: "workspace-test-codex", engine: "codex", providerId: "openai", providerLabel: "OpenAI",
      modelId: "codex-test", displayName: "Codex Test", description: "", inputModalities: ["text"], supportedReasoningEfforts: [],
      defaultReasoningEffort: null, contextWindow: 200_000, maxContextWindow: null, supportsFastMode: false,
      supports1MContext: false, isDefault: true, sortOrder: 1, runtimeProfileId: "native", transportModelId: null,
      fastTaskModelId: null, subagentModelId: null }] });
  db.engineKeys.insert({ label: "测试", engine: "claude", providerId: "anthropic", apiKey: "local-test-key" });
  const inputSha256 = "1".repeat(64), configSha256 = hash(JSON.stringify({ engine: "claude", model: "claude-test", effort: null, providerId: "anthropic" }));
  for (const workspaceId of workspaces.keys()) db.forWorkspace(workspaceId).controlledExperiments.commitFreeze({ experimentId: "same-experiment", freezeRevision: 1,
    freezeDigest: "2".repeat(64), snapshots: [{ id: "same-snapshot", experimentId: "same-experiment", freezeRevision: 1,
      freezeDigest: "2".repeat(64), workspaceId, sampleId: "same-sample", evaluationItemId: "same-evaluation", sourceInstanceId: "source",
      nodeId: "node", promptSnapshotId: "prompt", ordinal: 0, variantKey: "candidate", engine: "claude", model: "claude-test", effort: null,
      catalogVersion: 1, promptEnvelope: {} as any, systemMessage: "system", developerMessage: null, userMessage: workspaceId,
      artifactInput: { artifacts: [], fieldBindings: {} }, inputSha256, configSha256, promptDefinitionSha256: "3".repeat(64),
      priceSnapshot: null, priceSnapshotSha256: "0".repeat(64), perRunTimeoutMs: 60_000, createdAt: 1 }] });
  t.after(() => { resetEngineModelCatalogRuntimeForTest(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, workspaces,
    request: { contractVersion: 1, experimentId: "same-experiment", runId: "same-run", assignmentId: "same-assignment", sampleId: "same-sample",
      variantKey: "candidate", attemptNo: 1, dispatchToken: "test-dispatch", inputSha256, configSha256, deadlineAt: Date.now() + 60_000 } as ControlledExperimentRunStartRpcRequest };
}

/** 文本摘要与实际执行器的冻结契约一致。 */
function hash(text: string): string { return crypto.createHash("sha256").update(text).digest("hex"); }

test("实验同名run在两个工作区独立执行，root停止等待全部真实子owner", async t => {
  const f = experimentFixture(t), ids = [...f.workspaces.keys()];
  const release = new Map<WorkspaceId, () => void>(), entered = new Set<WorkspaceId>();
  const sessionKeys = new Set<string>();
  let allStarted!: () => void;
  const started = new Promise<void>(resolve => { allStarted = resolve; });
  const executor = new ControlledExperimentExecutor({ db: f.db, workspaces: f.workspaces, sessions: {
    getWorkspacePath: workspaceId => f.workspaces.get(workspaceId) ?? null,
    createIsolatedSession(input: any) {
      sessionKeys.add(input.sessionKey);
      input.onSessionId(`session:${input.workspaceId}`);
      return { session: {
        async sendMessage(_input: unknown, emitters: any) {
          emitters.conversation({ type: "tokenUsage.updated", payload: { source: "cumulative", tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } });
          await new Promise<void>(resolve => { release.set(input.workspaceId, resolve); entered.add(input.workspaceId); if (entered.size === 2) allStarted(); });
          return { responseText: input.workspaceId };
        }, async interrupt() { return true; },
      }, async dispose() {} } as any;
    }, async interruptCodexTurnByEngineIds() { throw new Error("unexpected"); }, async reconcileCodexDanglingTurn() { throw new Error("unexpected"); },
  } });
  t.after(async () => { for (const finish of release.values()) finish(); await executor.dispose(); });
  for (const workspaceId of ids) executor.forWorkspace(workspaceId).start(f.request);
  await started;
  assert.equal(sessionKeys.size, 2);
  assert.equal(executor.hasInFlightWork(), true);
  let stopped = false;
  const stopping = executor.stopForUpdate({ requestId: "root-stop" }).then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  for (const finish of release.values()) finish();
  await stopping;
  assert.equal(executor.hasInFlightWork(), false);
  for (const workspaceId of ids) assert.equal(f.db.forWorkspace(workspaceId).controlledExperiments.getRun(f.request.runId)?.status, "cancelled");
  assert.equal(f.db.applicationDb.prepare("SELECT COUNT(*) AS n FROM controlled_experiment_runs").get()?.n, 0);
  await assert.rejects(executor.status({ contractVersion: 1, experimentId: f.request.experimentId, runId: f.request.runId, dispatchTokenSha256: hash(f.request.dispatchToken) }));
});

test("实验root dispose等待活跃子执行器释放且关闭后拒绝新作用域", async t => {
  const f = experimentFixture(t), workspaceId = [...f.workspaces.keys()][0]!;
  let signalStarted!: () => void, releaseSend!: () => void, releaseCleanup!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const sending = new Promise<void>(resolve => { releaseSend = resolve; });
  const cleaning = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const executor = new ControlledExperimentExecutor({ db: f.db, workspaces: f.workspaces, sessions: {
    getWorkspacePath: id => f.workspaces.get(id) ?? null,
    createIsolatedSession() {
      return { session: { async sendMessage(_input: unknown, emitters: any) {
        emitters.conversation({ type: "tokenUsage.updated", payload: { source: "cumulative", tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } });
        signalStarted(); await sending; return { responseText: "完成" };
      }, async interrupt() { return true; } }, async dispose() { await cleaning; } } as any;
    }, async interruptCodexTurnByEngineIds() { throw new Error("unexpected"); }, async reconcileCodexDanglingTurn() { throw new Error("unexpected"); },
  } });
  t.after(async () => { releaseSend(); releaseCleanup(); await executor.dispose(); });
  executor.forWorkspace(workspaceId).start(f.request);
  await started;
  let disposed = false;
  const disposing = executor.dispose().then(() => { disposed = true; });
  releaseSend();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, false);
  assert.equal(executor.hasInFlightWork(), true);
  releaseCleanup();
  await disposing;
  assert.equal(executor.hasInFlightWork(), false);
  assert.throws(() => executor.forWorkspace(workspaceId), /CONTROLLED_EXPERIMENT_EXECUTOR_DISPOSED/);
});

test("实验状态RPC在首次Run读取前选择可信工作区并拒绝裸ID", async t => {
  const f = experimentFixture(t), ids = [...f.workspaces.keys()];
  for (const workspaceId of ids) {
    const repo = f.db.forWorkspace(workspaceId).controlledExperiments;
    repo.createDispatchedRun({ id: f.request.runId, experimentId: f.request.experimentId, assignmentId: f.request.assignmentId,
      sampleId: f.request.sampleId, variantKey: "candidate", attemptNo: 1, snapshotId: "same-snapshot",
      dispatchTokenSha256: hash(f.request.dispatchToken), clientTurnId: "same-turn", engine: "claude", deadlineAt: f.request.deadlineAt, now: 1 });
    repo.finishRun(f.request.runId, { status: "succeeded", completedAt: 2, outputText: workspaceId,
      outputSha256: hash(workspaceId), usage: null, errorCode: null });
  }
  const executor = new ControlledExperimentExecutor({ db: f.db, workspaces: f.workspaces, sessions: {} as any });
  const sent: any[] = [], ctx = { db: f.db, workspaces: f.workspaces, controlledExperiments: executor,
    send: (message: unknown) => { sent.push(message); } } as unknown as ApiHandlerContext;
  const body = { contractVersion: 1, experimentId: f.request.experimentId, runId: f.request.runId, dispatchTokenSha256: hash(f.request.dispatchToken) };
  await handleControlledExperimentRunStatus(ctx, { t: "api.req", id: "selected-run", method: "orch.experiments.run.status", path: "/test", body: { ...body, workspaceId: ids[1] } });
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.outputSha256, hash(ids[1]!));
  await handleControlledExperimentRunStatus(ctx, { t: "api.req", id: "bare-run", method: "orch.experiments.run.status", path: "/test", body });
  assert.equal(sent[1].status, 400);
  await executor.dispose();
});
