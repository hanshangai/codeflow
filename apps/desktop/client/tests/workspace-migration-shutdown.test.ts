import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { openClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { migrateClientDb } from "../src/db/migrateClientDb.js";

/** 有界观察真实进程/API事实，超时保留具体等待边界。 */
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`WORKSPACE_SHUTDOWN_TIMEOUT:${label}`);
}

/** 真实 index、原云端 WS API 和固定 Worker，测试注入仅阻塞自身资源边界。 */
async function shutdownFixture(scenario: "snapshot" | "committed" | "unclosed", t: test.TestContext): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `d18-shutdown-${scenario}-`));
  const source = path.join(root, "source"), targetParent = path.join(root, "destination"), target = path.join(targetParent, "moved");
  await fs.mkdir(path.join(source, ".codeflowai"), { recursive: true }); await fs.mkdir(targetParent);
  await fs.writeFile(path.join(source, "README.md"), "stable-static-tree\n", "utf8");
  const database = openSqliteDb(path.join(source, ".codeflowai", "workspace.db"));
  try { migrateClientDb(database, { scope: "workspace" }); database.exec("INSERT INTO workspace_prefs VALUES ('shutdown:workspace','codex','general',1,88,NULL)"); }
  finally { database.close(); }
  const workerPath = path.join(root, "worker.ts"), preload = path.join(root, "preload.mjs");
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
  const clientRoot = fileURLToPath(new URL("..", import.meta.url));
  const workerSource = fileURLToPath(new URL("../src/workspace-migration/workspaceMigrationFileWorker.ts", import.meta.url));
  await fs.writeFile(workerPath, `import fs from 'node:fs';
import { workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(${JSON.stringify(path.join(clientRoot, "package.json"))});
process.on('uncaughtExceptionMonitor', error => fs.writeFileSync(${JSON.stringify(path.join(root, "worker-error"))}, error.stack ?? String(error)));
const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
const originalOpen = fs.promises.open;
fs.promises.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (workerData.command.type === 'workspace-db.snapshot' && String(args[0]).endsWith('.snapshot')) {
    fs.writeFileSync(${JSON.stringify(path.join(root, "snapshot-open"))}, String(process.pid));
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (${JSON.stringify(scenario)} !== 'unclosed' && Atomics.load(new Int32Array(workerData.cancelBuffer), 0)) {
          clearInterval(timer); resolve();
        }
      }, 10);
    });
  }
  return handle;
};
await tsImport(${JSON.stringify(pathToFileURL(workerSource).href)}, import.meta.url);
`, "utf8");
  const serviceUrl = pathToFileURL(fileURLToPath(new URL("../src/workspace-migration/workspaceMigrationService.ts", import.meta.url))).href;
  const workerClientUrl = pathToFileURL(fileURLToPath(new URL("../src/workspace-migration/workspaceMigrationFileWorkerClient.ts", import.meta.url))).href;
  const classifierUrl = pathToFileURL(fileURLToPath(new URL("../src/workspace-migration/storageClassifier.ts", import.meta.url))).href;
  await fs.writeFile(preload, `import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceMigrationService } from ${JSON.stringify(serviceUrl)};
import { WorkspaceMigrationFileWorkerClient } from ${JSON.stringify(workerClientUrl)};
import { StorageClassifier } from ${JSON.stringify(classifierUrl)};
fs.writeFileSync(${JSON.stringify(path.join(root, "preload-loaded"))}, 'loaded');
StorageClassifier.prototype.assertSupportedTarget = async target => ({ platform: process.platform, realPath: target, mountPoint: path.parse(target).root, fileSystemType: process.platform === 'win32' ? 'ntfs' : 'ext4', deviceIds: ['fixture'], busTypes: ['fixture'] });
const snapshot = WorkspaceMigrationFileWorkerClient.prototype.snapshotWorkspaceDb;
WorkspaceMigrationFileWorkerClient.prototype.snapshotWorkspaceDb = function(input) {
  fs.writeFileSync(${JSON.stringify(path.join(root, "snapshot-command"))}, JSON.stringify(input));
  const task = snapshot.call(new WorkspaceMigrationFileWorkerClient({ workerPath: ${JSON.stringify(workerPath)} }), input);
  task.promise = task.promise.catch(error => { fs.writeFileSync(${JSON.stringify(path.join(root, "task-error"))}, error.cause?.stack ?? error.stack ?? String(error)); throw error; });
  if (${JSON.stringify(scenario)} === 'unclosed') task.terminate = async () => { throw new Error('OWNED_WORKER_TERMINATION_FAILED'); };
  return task;
};
const stop = WorkspaceMigrationService.prototype.stop;
let resume;
WorkspaceMigrationService.prototype.stop = function() { stop.call(this); resume?.(); };
if (${JSON.stringify(scenario)} === 'committed') {
  const finalize = WorkspaceMigrationService.prototype.finalizeCommittedOperation;
  WorkspaceMigrationService.prototype.finalizeCommittedOperation = async function(...args) {
    fs.writeFileSync(${JSON.stringify(path.join(root, "committed"))}, 'committed');
    await new Promise(resolve => { resume = resolve; });
    return await finalize.apply(this, args);
  };
  WorkspaceMigrationFileWorkerClient.prototype.snapshotWorkspaceDb = snapshot;
}
if (${JSON.stringify(scenario)} === 'unclosed') {
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay >= 29000 && delay <= 30000 ? 1500 : delay, ...args);
}
`, "utf8");
  const received: Array<Record<string, unknown>> = [];
  const bundle = JSON.parse(await fs.readFile(fileURLToPath(new URL("../assets/orchestration-builtin/defaultAssetBundle.v1.json", import.meta.url)), "utf8"));
  let socket: WebSocket | undefined, childExit: number | null | undefined, output = "";
  const server = http.createServer((req, res) => {
    const body = req.url?.startsWith("/api/orch/default-bundle") ? { ok: true, bundle }
      : req.url === "/api/client-db/startup-context" ? { ok: true, accountNamespace: "acct_d18shutdown" } : { ok: true, tasks: [], serverNow: Date.now() };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  const wss = new WebSocketServer({ server });
  const row = { catalogItemId: "codex-default", engine: "codex", providerId: "openai", providerLabel: "OpenAI", modelId: "gpt-6.1-sol", displayName: "Codex", description: "test", inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null, contextWindow: 100000, maxContextWindow: null, supportsFastMode: false, supports1MContext: false, isDefault: true, sortOrder: 1, runtimeProfileId: "native", transportModelId: null, fastTaskModelId: null, subagentModelId: null };
  wss.on("connection", current => {
    socket = current;
    current.on("message", raw => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>; received.push(message);
      if (message.t === "client.hello") current.send(JSON.stringify({ t: "client.helloAck", keyHash: "test-hash", serverNow: Date.now(), accountSessionId: "shutdown-session",
        userSummary: { userId: "shutdown-user", email: "shutdown@example.test", fullName: "shutdown", phone: "", avatarUrl: null, accountRole: "personal_normal", status: "active", enterpriseId: null, enterpriseName: null },
        engineModelCatalog: { schemaVersion: "engine-model-catalog/v1", configVersion: 1, capturedAt: 1, rows: [row, { ...row, catalogItemId: "claude-default", engine: "claude", providerId: "anthropic", providerLabel: "Anthropic", modelId: "claude-fable-5" }] }, capabilities: {} }));
      if (message.t === "engine.models.applied") current.send(JSON.stringify({ t: "engine.models.appliedConfirmed", ...(message.ack as object) }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_")));
  const child = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), ["--foreground"], {
    execArgv: ["--conditions=development", "--import", "tsx", "--import", pathToFileURL(preload).href],
    env: { ...env, CODEFLOWAI_API_KEY: "d18-isolated-key", CODEFLOWAI_CLIENT_ID: "shutdown", CODEFLOWAI_VERSION: "1.0.0",
      CODEFLOWAI_SERVER_WS: `ws://127.0.0.1:${address.port}/ws/client`, CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(root, "config.json"),
      CODEFLOWAI_WORKSPACES_JSON: JSON.stringify([{ id: "workspace", path: source, label: "shutdown fixture" }]),
      CODEFLOWAI_CLIENT_DB_PATH: path.join(root, "client.db"), CODEFLOWAI_CLIENT_LOG_DIR: path.join(root, "logs") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout!.on("data", value => { output += String(value); }); child.stderr!.on("data", value => { output += String(value); });
  child.once("exit", code => { childExit = code; });
  const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
  /** 请求真实云端 API，拒绝非成功及退出前无响应。 */
  const request = async (method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = `${scenario}:${method}:${received.length}`;
    assert.ok(socket); socket.send(JSON.stringify({ t: "api.req", id, method, path: `/${method}`, body }));
    const response = await waitFor(() => {
      if (childExit !== undefined) throw new Error(`CLIENT_EARLY_EXIT:${childExit}:${output}`);
      return received.find(message => message.t === "api.res" && message.id === id);
    }, method);
    assert.ok(Number(response.status) < 400, JSON.stringify(response)); return response.body as Record<string, unknown>;
  };
  try {
    await waitFor(() => { if (childExit !== undefined) throw new Error(`STARTUP_EXIT:${childExit}:${output}`); return received.find(message => message.t === "client.workspaceDirectoryMigrationActivationSnapshot"); }, "hello-ready");
    const created = await request("workspaces.upsert", { workspaceId: "workspace", title: "shutdown", path: source });
    const workspaceId = (created.workspace as { id: string }).id;
    const prepared = await request("workspaceDirectoryMigration.prepare", { workspaceId, idempotencyKey: scenario, targetParentPath: targetParent, targetDirectoryName: "moved" });
    const operationId = (prepared.operation as { operationId: string }).operationId;
    await waitFor(async () => { const result = await request("workspaceDirectoryMigration.get", { workspaceId, operationId }); return (result.operation as { state: string }).state === "awaiting_confirmation" ? true : undefined; }, "preflight");
    const attempted = await request("workspaceDirectoryMigration.prepareStart", { workspaceId, operationId, startAttemptId: "shutdown-attempt", externalWritesPausedConfirmed: true, targetNotSyncManagedConfirmed: true });
    await request("workspaceDirectoryMigration.executeStart", { workspaceId, operationId, startAttemptId: "shutdown-attempt", expectedStateVersion: (attempted.operation as { stateVersion: number }).stateVersion });
    const boundary = path.join(root, scenario === "committed" ? "committed" : "snapshot-open");
    await waitFor(async () => {
      const result = await request("workspaceDirectoryMigration.get", { workspaceId, operationId });
      const state = (result.operation as { state: string }).state;
      if (state === "recovery_required" || state === "failed") {
        throw new Error(`MIGRATION_BOUNDARY_FAILED:${JSON.stringify(result)}`);
      }
      try { await fs.stat(boundary); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }, "resource-boundary");
    await request("client.exit", { clientId: "shutdown" });
    await waitFor(() => childExit === undefined ? undefined : true, "shutdown-exit"); await exited;
    assert.equal(childExit, scenario === "unclosed" ? 1 : 0, output);
    const logs = (await Promise.all((await fs.readdir(path.join(root, "logs"))).filter(name => name.endsWith(".log")).map(name => fs.readFile(path.join(root, "logs", name), "utf8")))).join("");
    const rows = logs.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    if (scenario === "unclosed") {
      const migrationFailure = rows.find(row => row.event?.action === "shutdown.workspace_migration_drain" && row.event.outcome === "fail");
      assert.equal(migrationFailure?.rootCause?.code, "WORKSPACE_MIGRATION_RECOVERY_REQUIRED");
      const closeFailure = rows.find(row => row.event?.action === "shutdown.db_close" && row.event.outcome === "fail");
      assert.equal(closeFailure?.rootCause?.code, "CLIENT_RESOURCES_NOT_DRAINED");
      assert.equal(rows.some(row => row.event?.action === "shutdown.db_close" && row.event.outcome === "success"), false);
      const complete = rows.find(row => row.event?.action === "shutdown.complete" && row.event.outcome === "fail");
      assert.ok(complete.failedSteps.includes("workspace_migration_drain"));
      assert.ok(complete.failedSteps.includes("db_close"));
    } else assert.ok(rows.some(row => row.event?.action === "shutdown.db_close" && row.event.outcome === "success"));
    const recovered = openClientDb({ dbPath: path.join(root, "client.db") });
    try {
      assert.equal(recovered.workspaces.get(workspaceId)?.path, scenario === "committed" ? target : source);
      assert.notEqual(recovered.workspaceDirectoryMigrations.require(operationId).state, "path_committed");
    } finally { recovered.close(); }
    const unlocked = openSqliteDb(path.join(scenario === "committed" ? target : source, ".codeflowai", "workspace.db"), { fileMustExist: true, busyTimeoutMs: 0 });
    try { unlocked.exec("BEGIN EXCLUSIVE; ROLLBACK"); } finally { unlocked.close(); }
  } finally {
    if (childExit === undefined) { child.kill(); await exited; }
    for (const current of wss.clients) current.terminate();
    await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    t.diagnostic(`shutdown evidence: ${root}`);
  }
}

for (const scenario of ["snapshot", "committed", "unclosed"] as const) {
  test(`D18 真实 index 迁移 API 与统一退出 ${scenario}`, async t => { await shutdownFixture(scenario, t); });
}
