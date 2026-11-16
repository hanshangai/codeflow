import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClientRuntime } from "../../../desktop/src/clientRuntime.js";
import { loadOrCreateDeviceIdentity } from "../../../desktop/src/deviceIdentity.js";
import { openClientDb } from "../src/db/clientDb.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { ClientConfig } from "../src/config.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduledTaskScheduler.js";
import { createDesktopStartupRecovery } from "../src/runtime/desktopStartupRecovery.js";
import { createDesktopLifecycle } from "../src/runtime/desktopLifecycle.js";
import { CLIENT_DB_SCHEMA_VERSION } from "../src/db/migrateClientDb.js";
import { logger } from "../src/logger.js";

test("first recovery registers existing owners in order without waiting for a long orchestration", async () => {
  const { createDesktopStartupRecovery } = await import("../src/runtime/desktopStartupRecovery.js");
  const calls: string[] = [], controller = new AbortController();
  const hooks = createDesktopStartupRecovery({
    scheduler: { start() { calls.push("start"); }, syncAndTick(reason: string) { calls.push(reason); return Promise.resolve(); }, isIsolatedLocalConfigScanFailure() { return false; } },
    recoverQueue() { calls.push("queue"); }, recoverOrchestrations() { calls.push("orchestration"); return new Promise<void>(() => {}); },
  });
  hooks.recover({ requestId: "startup", signal: controller.signal, fail() { assert.fail("unexpected recovery failure"); } });
  assert.deepEqual(calls, ["start", "desktop.ready", "queue", "orchestration"]);
});

test("synchronous queue failure stops later recovery while an earlier tick rejection stays observed", async () => {
  const { createDesktopStartupRecovery } = await import("../src/runtime/desktopStartupRecovery.js");
  const calls: string[] = [], failures: unknown[] = [], cause = new Error("queue preparation failed"), tickCause = new Error("tick entry failed");
  let rejectTick!: (error: unknown) => void;
  const hooks = createDesktopStartupRecovery({
    scheduler: { start() { calls.push("start"); }, syncAndTick() { calls.push("tick"); return new Promise<void>((_resolve, reject) => { rejectTick = reject; }); }, isIsolatedLocalConfigScanFailure() { return false; } },
    recoverQueue() { calls.push("queue"); throw cause; }, recoverOrchestrations() { calls.push("orchestration"); return Promise.resolve(); },
  });
  assert.throws(() => hooks.recover({ requestId: "startup", signal: new AbortController().signal, fail(error) { failures.push(error); } }), error => error === cause);
  rejectTick(tickCause); await new Promise(setImmediate);
  assert.deepEqual(calls, ["start", "tick", "queue"]); assert.deepEqual(failures, [tickCause]);
});

test("队列等待Writer后失败回到启动owner，禁止继续恢复编排", async () => {
  const calls: string[] = [], failures: unknown[] = [], cause = new Error("QUEUE_WRITER_PREPARATION_FAILED");
  let reject!: (cause: unknown) => void;
  const hooks = createDesktopStartupRecovery({
    scheduler: { start() { calls.push("scheduler"); }, syncAndTick() { return Promise.resolve(); }, isIsolatedLocalConfigScanFailure() { return false; } },
    recoverQueue() { calls.push("queue"); return new Promise<void>((_resolve, no) => { reject = no; }); },
    async recoverOrchestrations() { calls.push("orchestration"); },
  });
  hooks.recover({ requestId: "queue-recovery", signal: new AbortController().signal, fail(error, stage) { failures.push({ error, stage }); } });
  assert.deepEqual(calls, ["scheduler", "queue"]);
  reject(cause); await new Promise(setImmediate);
  assert.deepEqual(calls, ["scheduler", "queue"]);
  assert.deepEqual(failures, [{ error: cause, stage: "queue" }]);
});

test("desktop startup environment is strict and never infers held identity from a partial input", async () => {
  const { readDesktopStartupMode } = await import("../src/runtime/desktopStartupRecovery.js");
  assert.deepEqual(readDesktopStartupMode(undefined, undefined), { mode: "automatic" });
  assert.deepEqual(readDesktopStartupMode("held", "candidate-1"), { mode: "held", continuationId: "candidate-1" });
  for (const pair of [["held", undefined], [undefined, "candidate-1"], ["automatic", "candidate-1"], ["other", undefined], ["held", "../escape"]]) {
    assert.throws(() => readDesktopStartupMode(pair[0], pair[1]), /DESKTOP_STARTUP_INPUT_INVALID/u);
  }
});

for (const mode of ["automatic", "held"] as const) for (const failure of ["corrupt", "storage", "logging"] as const)
test(`ER01 原 lifecycle 与真实 Scheduler ${mode} ${failure} 保登记和失败归属`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-er01-continuation-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const channel = new EventEmitter() as EventEmitter & { connected: boolean; send(message: unknown, callback: (error: Error | null) => void): void };
  const sent: any[] = [], calls: string[] = [], logs: unknown[][] = [], closed: unknown[] = [];
  channel.connected = true; channel.send = (message, callback) => { sent.push(message); callback(null); };
  const lifecycle = createDesktopLifecycle(channel, "er01-parent", { startup: mode === "held" ? { mode, continuationId: "er01-continue" } : { mode }, abortStartup() { assert.fail("unexpected emergency exit"); } });
  const context = { clientId: "er01-client", db, workspaces: new Map(), sessions: {}, localWorkspaceOnly: true } as unknown as ApiHandlerContext;
  const scheduler = new ScheduledTaskScheduler({ config: { clientId: "er01-client", serverWsUrl: "ws://127.0.0.1:1/ws" } as ClientConfig,
    deviceId: "er01-device", apiContext: context, localApiContext: context, isTaskAdmissionPaused: () => lifecycle.isTaskAdmissionPaused() });
  db.scheduledTaskConfigs.create({ at: 1, config: { id: "er01-bad", source: "local", clientId: "er01-client", deviceId: "er01-device", workspaceScope: null,
    name: "bad config", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "UTC", enabled: true,
    payload: { shell: "sh", command: "PRIVATE_NEVER_RUN" }, concurrencyPolicy: "queue_one", missedPolicy: "run_once_on_reconnect", timeoutMs: 1_000 } });
  if (failure === "storage") db.db.exec("ALTER TABLE scheduled_task_configs RENAME TO hidden_configs");
  else db.db.prepare("UPDATE scheduled_task_configs SET payload_json = ?").run("{PRIVATE_CONTINUATION_CONFIG");
  const logError = new Error("controlled scan log failure");
  t.mock.method(logger, "error", (...args: unknown[]) => {
    logs.push(args);
    if (failure === "logging" && args[1] === "local scheduled task configuration scan failed") throw logError;
  });
  try {
    await lifecycle.ready(async (_reason, error) => {
      calls.push("shutdown"); closed.push(error); await lifecycle.drainRequests();
      // 已知首个业务故障仍由排空明确拒绝；断言原因，不能误当成功或清理异常。
      if (failure === "corrupt") await scheduler.stopAndDrain();
      else await assert.rejects(scheduler.stopAndDrain(), reason => {
        const primary = (error as AggregateError).cause;
        return reason === primary || reason instanceof AggregateError && reason.errors.includes(primary);
      });
      calls.push("cleaned");
    },
      () => ({ protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: CLIENT_DB_SCHEMA_VERSION, database: "ready" }),
      async () => ({ status: 200, body: { ok: true } }), undefined,
      createDesktopStartupRecovery({ scheduler, recoverQueue() { calls.push("queue"); }, recoverOrchestrations() { calls.push("orch"); return new Promise<void>(() => {}); } }));
    if (mode === "held") {
      assert.equal(lifecycle.isTaskAdmissionPaused(), true); assert.deepEqual(calls, []); assert.equal(logs.length, 0);
      channel.emit("message", { t: "desktop.api.req", requestId: "er01-parent", id: "continue-first", request: { method: "runtime.startup.continue", body: { continuationId: "er01-continue" } } });
    }
    await new Promise(setImmediate); await new Promise(setImmediate);
    assert.equal(sent[0].t, "desktop.ready");
    assert.deepEqual(calls.slice(0, 2), ["queue", "orch"]);
    assert.equal(db.scheduledTaskRuns.list({}).total, 0);
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_CONTINUATION_CONFIG|PRIVATE_NEVER_RUN/);
    if (failure === "corrupt") {
      assert.deepEqual(closed, []); assert.equal(lifecycle.isTaskAdmissionPaused(), false);
      assert.equal(logs.length, 1); assert.match(JSON.stringify(logs), /SCHEDULED_TASK_CONFIG_CORRUPT/);
      channel.emit("message", { t: "desktop.api.req", requestId: "er01-parent", id: "info-after-corrupt", request: { method: "runtime.info" } });
      if (mode === "held") channel.emit("message", { t: "desktop.api.req", requestId: "er01-parent", id: "continue-replay", request: { method: "runtime.startup.continue", body: { continuationId: "er01-continue" } } });
      await new Promise(setImmediate);
      assert.equal(sent.find(message => message.id === "info-after-corrupt").response.status, 200);
      assert.deepEqual(calls, ["queue", "orch"]);
      if (mode === "held") assert.equal(sent.find(message => message.id === "continue-replay").response.status, 200);
    } else {
      assert.equal(closed.length, 1); assert.equal(lifecycle.isTaskAdmissionPaused(), true);
      assert.deepEqual(calls, ["queue", "orch", "shutdown", "cleaned"]);
      const startupError = closed[0] as AggregateError;
      assert.ok(startupError instanceof AggregateError);
      if (failure === "logging") {
        const cause = startupError.cause as AggregateError;
        assert.equal((cause as AggregateError & { code: string }).code, "SCHEDULED_TASK_SCAN_LOG_FAILED"); assert.equal(cause.errors[1], logError);
      }
    }
  } finally { await lifecycle.drainRequests(); await scheduler.stopAndDrain(); db.close(); await fs.rm(root, { recursive: true }); }
});

test("real current Client stays held until one trusted continuation and closes its owned process", { timeout: 60_000 }, async t => {
  const evidence = process.env.CF_CONTINUATION_EVIDENCE_ROOT ?? path.join(os.tmpdir(), "cf-startup-continuation");
  await fs.mkdir(evidence, { recursive: true });
  const root = await fs.mkdtemp(path.join(evidence, "current-client-")), dataDir = path.join(root, "data"), builtin = path.join(root, "builtin");
  await fs.mkdir(builtin); await loadOrCreateDeviceIdentity(dataDir);
  await fs.copyFile(fileURLToPath(new URL("../assets/orchestration-builtin/defaultAssetBundle.v1.json", import.meta.url)), path.join(builtin, "defaultAssetBundle.v1.json"));
  const clientId = `continuation-${crypto.randomUUID()}`, dbPath = path.join(dataDir, "codeflowai.db"), marker = path.join(root, "executed.txt");
  await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ clientId, apiKey: "" }), "utf8");
  const db = openClientDb({ dbPath, localCanonicalEvents: true });
  try { db.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('client_id',?), ('built_in_relay_auto_enable_v1','1')").run(clientId); }
  finally { db.close(); }
  await fs.writeFile(`${dbPath}.meta.json`, JSON.stringify({ schemaVersion: 3, storageMode: "plain_sqlite", ownership: "local_os_user", initializationState: "ready" }), "utf8");
  const continuationId = `candidate-${crypto.randomUUID()}`, output: string[] = [], messages: unknown[] = [];
  let child: ChildProcess | undefined, closed = false, exitCode: number | null = null;
  const runtime = createClientRuntime({ entry: fileURLToPath(new URL("../src/index.ts", import.meta.url)), dataDir, startup: { mode: "held", continuationId },
    spawn(file, args, options) {
      const keep = ["CODEFLOWAI_DESKTOP_REQUEST_ID", "CODEFLOWAI_CLIENT_CONFIG_PATH", "CODEFLOWAI_CLIENT_DB_PATH", "CODEFLOWAI_CLIENT_LOG_DIR", "CODEFLOWAI_DESKTOP_STARTUP_MODE", "CODEFLOWAI_DESKTOP_STARTUP_CONTINUATION_ID"];
      const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => !key.startsWith("CODEFLOWAI_") || keep.includes(key)));
      child = spawn(file, ["--conditions=development", "--import", "tsx", ...args], { ...options, cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...env, CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), CODEFLOWAI_VERSION: "2026.10.28.01", CODEFLOWAI_DESKTOP_BUILTIN_ASSET_DIR: builtin } });
      child.stdout!.on("data", chunk => output.push(String(chunk))); child.stderr!.on("data", chunk => output.push(String(chunk)));
      child.on("message", message => messages.push(message)); child.once("close", code => { closed = true; exitCode = code; });
      return child as ChildProcess & { send(message: unknown, callback: (error: Error | null) => void): boolean };
    } });
  t.after(async () => {
    try { await runtime.drain(20_000); }
    finally {
      await fs.writeFile(path.join(root, "stdout-stderr.log"), output.join(""), "utf8");
      await fs.writeFile(path.join(root, "ipc.json"), JSON.stringify(messages, null, 2), "utf8");
      await fs.writeFile(path.join(root, "owned.json"), JSON.stringify({ closed, exitCode, pid: child?.pid ?? null, runtime: runtime.snapshot() }, null, 2), "utf8");
    }
  });
  await runtime.start(); await runtime.waitReady(25_000);
  assert.deepEqual(runtime.snapshot().startup, { continuationId, admission: "paused" });
  const create = await runtime.request({ method: "scheduledTasks.local.create", body: { name: "startup continuation probe", description: null, taskType: "script", cronExpr: "0 0 1 1 *", timezone: "UTC", enabled: true,
    payload: { shell: process.platform === "win32" ? "powershell" : "sh", command: process.platform === "win32" ? `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'executed')` : `printf executed > '${marker.replaceAll("'", "'\\''")}'` },
    concurrencyPolicy: "queue_one", missedPolicy: "skip_missed", timeoutMs: 10_000 } });
  assert.equal(create.status, 200, JSON.stringify(create.body));
  const taskId = (create.body as { task: { id: string } }).task.id;
  const held = await runtime.request({ method: "scheduledTasks.local.runNow", body: { taskId } });
  assert.equal(held.status, 409, JSON.stringify(held.body));
  const heldHistory = await runtime.request({ method: "scheduledTasks.local.runs", body: { taskId } });
  assert.equal(heldHistory.status, 200); assert.equal((heldHistory.body as { total: number }).total, 0);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  assert.equal((await runtime.request({ method: "runtime.update.cancel" })).status, 409);
  assert.deepEqual(await runtime.request({ method: "runtime.startup.continue", body: { continuationId } }), { status: 200, body: { ok: true } });
  assert.deepEqual(await runtime.request({ method: "runtime.startup.continue", body: { continuationId } }), { status: 200, body: { ok: true } });
  const run = await runtime.request({ method: "scheduledTasks.local.runNow", body: { taskId } }, 20_000);
  assert.equal(run.status, 200, JSON.stringify(run.body)); assert.equal((run.body as { run: { status: string } }).run.status, "success");
  assert.equal(await fs.readFile(marker, "utf8"), "executed");
  const history = await runtime.request({ method: "scheduledTasks.local.runs", body: { taskId } }); assert.equal((history.body as { total: number }).total, 1);
  await runtime.drain(20_000); assert.equal(closed, true); assert.equal(exitCode, 0); assert.equal(runtime.snapshot().pid, null);
});
