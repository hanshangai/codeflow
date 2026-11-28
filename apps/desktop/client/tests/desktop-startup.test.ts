import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { openClientDb } from "../src/db/clientDb.js";
import { CLIENT_DB_SCHEMA_VERSION } from "../src/db/migrateClientDb.js";
import type { DesktopRuntimeRequest, DesktopApiResponse, DesktopStartupMode, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { terminateCliProcessTree } from "../src/app/handlers/engineHandlers.js";

/** 源码验收显式提供只读包目录；真实子进程只使用隔离配置和数据库。 */
async function startDesktopClient(directory: string, serverUrl: string, bundlesDirectory?: string, entryPath?: string, startup?: DesktopStartupMode) {
  const builtinDirectory = bundlesDirectory ?? path.join(directory, "test-package", "orchestration-builtin");
  if (bundlesDirectory === undefined) {
    await fs.mkdir(builtinDirectory, { recursive: true });
    await fs.copyFile(fileURLToPath(new URL("../assets/orchestration-builtin/defaultAssetBundle.v1.json", import.meta.url)),
      path.join(builtinDirectory, "defaultAssetBundle.v1.json"));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_")));
  const requestId = crypto.randomUUID();
  const child = fork(entryPath ?? fileURLToPath(new URL("../src/index.ts", import.meta.url)), ["--foreground"], {
    execArgv: entryPath ? [] : ["--conditions=development", "--import", "tsx"],
    env: { ...env, CODEFLOWAI_DESKTOP_REQUEST_ID: requestId, CODEFLOWAI_SERVER_WS: serverUrl,
      CODEFLOWAI_VERSION: "1.0.0",
      ...(startup?.mode === "held" ? { CODEFLOWAI_DESKTOP_STARTUP_MODE: "held", CODEFLOWAI_DESKTOP_STARTUP_CONTINUATION_ID: startup.continuationId } : {}),
      CODEFLOWAI_DESKTOP_BUILTIN_ASSET_DIR: builtinDirectory,
      CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(directory, "config.json"), CODEFLOWAI_CLIENT_DB_PATH: path.join(directory, "codeflowai.db"),
      CODEFLOWAI_CLIENT_LOG_DIR: path.join(directory, "logs") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  child.stdout!.resume();
  const ipcTimeline:Array<{at:string;t:unknown;id:unknown;requestId:unknown}>=[];
  let rejectReady!: (error: Error) => void;
  child.on("message",(message:unknown)=>{
    const request=message as {t?:unknown;requestId?:unknown;id?:unknown}|null;
    ipcTimeline.push({at:new Date().toISOString(),t:request?.t,id:request?.id,requestId:request?.requestId});
  });
  let closed = false, verifiedClose = false;
  let processError: Error | undefined;
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", error => { processError ??= error; rejectReady(error); });
    child.once("close", code => { closed = true; resolve(code); });
  });
  const ready = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DESKTOP_READY_TEST_TIMEOUT: ${JSON.stringify(ipcTimeline)}`)), 15_000);
    rejectReady=error=>{clearTimeout(timer);reject(error);};
    child.on("message", (message: any) => {
      if (message?.t !== "desktop.ready" || message.requestId !== requestId) return;
      clearTimeout(timer);
      resolve(message.health);
    });
    void exited.then((code) => { clearTimeout(timer); reject(new Error(`Client exited before ready: ${code}; ${stderr}`)); }, reject);
  });
  let readyFailure: unknown;
  void ready.then(undefined,error=>{readyFailure=error;});
  /** 始终等待实际 close；exitCode 或 signalCode 不能代替管道资源排空。 */
  const boundedClose = async (): Promise<number | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("DESKTOP_TEST_CLOSE_TIMEOUT")), 10_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  /** 任一停止失败都严格清理，终止与 close 副错保留在原主因之后。 */
  const failAndClose = async (cause: unknown): Promise<never> => {
    const secondary: unknown[] = [];
    if (!closed) {
      try {
        const failure = await terminateCliProcessTree(child, { timeoutMs: 10_000, strictTreeConfirmation: true });
        if (failure !== null) secondary.push(new Error(failure));
      } catch (error) { secondary.push(error); }
      try { await boundedClose(); } catch (error) { secondary.push(error); }
    }
    if (secondary.length) throw new AggregateError([cause, ...secondary], "DESKTOP_TEST_PROCESS_TREE_UNCONFIRMED", { cause });
    throw cause;
  };
  /** 只有实际 close 与期望退出码均验证成功，finally stop 才可复用该事实。 */
  const waitClosed = async (expectedExitCode: number | null): Promise<void> => {
    try {
      const code = await boundedClose();
      if (processError) throw processError;
      assert.equal(code, expectedExitCode, `unexpected Client close; IPC=${JSON.stringify(ipcTimeline)}; stderr=${stderr}`);
      verifiedClose = true;
    } catch (error) { await failAndClose(error); }
  };
  return {
    ready,
    waitClosed,
    /** 只暴露关联元数据，失败证据不包含 IPC 正文。 */
    get ipcTimeline(){return ipcTimeline;},
    /** 请求实际子进程，关联 ID 必须匹配且等待有界。 */
    async request(request: DesktopRuntimeRequest): Promise<DesktopApiResponse> {
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.off("message", onMessage); reject(new Error("DESKTOP_API_TEST_TIMEOUT")); }, 10_000);
        /** 只接受当前运行时父关联和当前 API ID 的响应。 */
        function onMessage(message: any): void {
          if (message?.t !== "desktop.api.res" || message.requestId !== requestId || message.id !== id) return;
          clearTimeout(timer);
          child.off("message", onMessage);
          resolve(message.response);
        }
        child.on("message", onMessage);
        child.send({ t: "desktop.api.req", requestId, id, request }, (error) => {
          if (!error) return;
          clearTimeout(timer);
          child.off("message", onMessage);
          reject(error);
        });
      });
    },
    /** 通过实际 IPC 关闭并核验退出；停止副错保留在测试原主因之后。 */
    async stop(primaryFailure?: { cause: unknown }): Promise<void> {
      if (verifiedClose) return;
      try {
        if (!closed && child.exitCode === null && child.signalCode === null) {
          try { await new Promise<void>((resolve, reject) => child.send({ t: "desktop.shutdown", requestId }, (error) => error ? reject(error) : resolve())); }
          catch (error) { await failAndClose(error); }
        }
        await waitClosed(0);
      }
      catch (closeError) {
        const closeFailure=new Error(`DESKTOP_TEST_SHUTDOWN_FAILED: IPC=${JSON.stringify(ipcTimeline)}; stderr=${stderr}`, { cause: closeError });
        if(primaryFailure)throw new AggregateError([primaryFailure.cause,closeFailure],"DESKTOP_TEST_AND_SHUTDOWN_FAILED",{cause:primaryFailure.cause});
        if(readyFailure)throw new AggregateError([readyFailure,closeFailure],"DESKTOP_READY_AND_SHUTDOWN_FAILED",{cause:readyFailure});
        throw closeFailure;
      }
    },
  };
}

test("ER01 F1 原 helper 不得把已退出的非零进程当正常停止", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cf-er01-helper-exit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "controlled.cjs");
  await fs.writeFile(entry, "process.send({t:'desktop.ready',requestId:process.env.CODEFLOWAI_DESKTOP_REQUEST_ID,health:{}});setTimeout(()=>process.exit(1),25);", "utf8");
  const client = await startDesktopClient(directory, "ws://127.0.0.1:1/ws/client", directory, entry);
  await client.ready; await new Promise(resolve => setTimeout(resolve, 200));
  await assert.rejects(client.stop(), error => { assert.match(String((error as Error).cause), /unexpected Client close/); return true; });
  await assert.rejects(client.stop({ cause: false }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, false);
    assert.equal(error.errors[0], false);
    assert.match(String(error.errors[1].cause), /unexpected Client close/);
    return true;
  });
});

test("ER01 F1 原 helper 发送失败仍确认关闭且保原错误", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cf-er01-helper-send-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "controlled.cjs");
  await fs.writeFile(entry, "process.send({t:'desktop.ready',requestId:process.env.CODEFLOWAI_DESKTOP_REQUEST_ID,health:{}});process.disconnect();setInterval(()=>{},1000);", "utf8");
  const client = await startDesktopClient(directory, "ws://127.0.0.1:1/ws/client", directory, entry);
  await client.ready; await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(client.stop(), error => { assert.equal(((error as Error).cause as NodeJS.ErrnoException).code, "ERR_IPC_CHANNEL_CLOSED"); return true; });
  await client.waitClosed(process.platform === "win32" ? 1 : null);
  await client.stop();
});

test("ER01 F1 原 helper 显式验证预期非零后 finally stop 复用实际 close", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cf-er01-helper-expected-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "controlled.cjs");
  await fs.writeFile(entry, "process.send({t:'desktop.ready',requestId:process.env.CODEFLOWAI_DESKTOP_REQUEST_ID,health:{}});setTimeout(()=>process.exit(1),25);", "utf8");
  const client = await startDesktopClient(directory, "ws://127.0.0.1:1/ws/client", directory, entry);
  await client.ready; await client.waitClosed(1); await client.stop();
});

test("desktop initializes and replays persisted history after restart without a key or any Server request", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-startup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId: crypto.randomUUID(), createdAt: new Date().toISOString() }), "utf8");
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.writeHead(503).end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serverUrl = `ws://127.0.0.1:${address.port}/ws/client`;
  let clientId: string | undefined;
  let workspaceId: string | undefined;
  const workspacePath = path.join(directory, "project");
  const threadId = "persisted-desktop-history" as ThreadId;
  const historySeq = Date.now();
  await fs.mkdir(workspacePath);
  for (let index = 0; index < 2; index += 1) {
    const client = await startDesktopClient(directory, serverUrl);
    try {
      assert.deepEqual(await client.ready, { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: CLIENT_DB_SCHEMA_VERSION, database: "ready" });
      assert.equal(client.ipcTimeline.some(message => typeof message.t === "string" && message.t.startsWith("desktop.orchAsset.")), false, "本地启动不应请求资产授权");
      const runtime = await client.request({ method: "runtime.info" });
      assert.equal(runtime.status, 200);
      assert.equal((runtime.body as any).client.version, "1.0.0");
      assert.equal((runtime.body as any).client.name, os.hostname());
      if (index === 0) {
        const created = await client.request({ method: "workspaces.upsert", body: { title: "Persisted local project", path: workspacePath } });
        assert.equal(created.status, 200);
        workspaceId = (created.body as any).workspace.id;
      }
      const listed = await client.request({ method: "workspaces.list" });
      assert.equal(listed.status, 200);
      assert.deepEqual((listed.body as any).workspaces.map((workspace: any) => [workspace.id, workspace.ownerClientId, workspace.kind]), [[workspaceId, (runtime.body as any).client.clientId, "local"]]);
      if (index === 1) {
        const historyBody = { workspaceId, threadId };
        const threads = await client.request({ method: "threads.list", body: { workspaceId, scope: "current" } });
        assert.equal(threads.status, 200);
        assert.deepEqual((threads.body as any).threads.map((thread: any) => thread.id), [threadId]);
        const history = await client.request({ method: "threads.load", body: historyBody });
        assert.equal(history.status, 200);
        assert.deepEqual((history.body as any).events.map((event: any) => event.seq), [historySeq]);
        const raw = await client.request({ method: "threads.events", body: historyBody });
        assert.equal(raw.status, 200);
        assert.deepEqual((raw.body as any).events.map((event: any) => event.seq), [historySeq + 1]);
        const prefs = await client.request({ method: "threads.prefs", body: historyBody });
        assert.equal(prefs.status, 200);
        assert.equal((prefs.body as any).prefs.model, "gpt-6.2-sol");
        assert.equal((await client.request({ method: "threads.summary", body: historyBody })).status, 200);
        assert.equal((await client.request({ method: "threads.latestPrefs", body: { workspaceId, engine: "codex" } })).status, 200);
        assert.equal((await client.request({ method: "threads.groups.list", body: { workspaceId } })).status, 200);
      }
      const roles = await client.request({ method: "orch.roles.list", body: { workspaceId } });
      assert.equal(roles.status, 200);
      assert.equal((roles.body as any).roles.length,
        JSON.parse(await fs.readFile(new URL("../assets/orchestration-builtin/defaultAssetBundle.v1.json", import.meta.url), "utf8")).roles.length);
      assert.equal((roles.body as any).roles.every((role: any) => role.kind === "builtin"), true);
    } finally {
      await client.stop();
    }
    const db = openSqliteDb(path.join(directory, "codeflowai.db"), { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'client_id'").get() as { value: string };
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workspaces").get() as { count: number }).count, 1);
      if (index === 0) clientId = row.value;
      else assert.equal(row.value, clientId);
    } finally {
      db.close();
    }
    if (index === 0) {
      const seedDb = openClientDb({ dbPath: path.join(directory, "codeflowai.db") });
      try {
        assert.ok(workspaceId);
        const workspaceDb = seedDb.forWorkspace(workspaceId as WorkspaceId);
        workspaceDb.threads.create({ id: threadId, workspaceId: workspaceId as WorkspaceId, engine: "codex", title: "重启后历史", prefs: { model: "gpt-5.5", effort: "high" } });
        workspaceDb.conversationEvents.appendEnvelope({ schema: 1, seq: historySeq, ts: historySeq, workspaceId: workspaceId as WorkspaceId, threadId, engine: "codex", type: "thread.started", payload: {} });
        workspaceDb.rawEvents.appendEnvelope({ schema: 1, seq: historySeq + 1, ts: historySeq, workspaceId: workspaceId as WorkspaceId, threadId, engine: "codex", source: "desktop-restart-test", data: {}, handled: true, action: "mapped", emittedTypes: ["thread.started"] });
      } finally {
        seedDb.close();
      }
    }
  }
  assert.equal(requests, 0, "local initialization must not attempt cloud authentication, registration or background sync");
});

for (const startupMode of ["automatic", "held"] as const) test(`desktop ready 后首次 tick 执行持久本机任务，ER01 ${startupMode} 坏配置后独立 API 可用`, { timeout: 180_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cf-desktop-local-task-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID();
  await fs.writeFile(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId, createdAt: new Date().toISOString() }), "utf8");
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.writeHead(503).end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serverUrl = `ws://127.0.0.1:${address.port}/ws/client`;
  const initial = await startDesktopClient(directory, serverUrl);
  let clientId: string, workspaceId: WorkspaceId;
  try {
    await initial.ready;
    const runtime = await initial.request({ method: "runtime.info" });
    clientId = (runtime.body as any).client.clientId;
    const created = await initial.request({ method: "workspaces.upsert", body: { title: "scheduled project", path: directory } });
    assert.equal(created.status, 200);
    workspaceId = (created.body as any).workspace.id;
  } finally { await initial.stop(); }
  const seed = openClientDb({ dbPath: path.join(directory, "codeflowai.db") });
  try { seed.withLocalScheduledTasks(workspaceId, repos => repos.configs.create({ at: 1, config: {
    id: "desktop-local-task", source: "local", clientId, deviceId, workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId },
    name: "启动本机任务", description: null, enabled: true, taskType: "script", cronExpr: "0 0 * * *", timezone: "UTC",
    payload: { contextWorkspaceId: workspaceId, shell: process.platform === "win32" ? "powershell" : "sh", command: process.platform === "win32"
      ? "[IO.File]::AppendAllText((Join-Path (Get-Location) 'local-executed'), 'run' + [Environment]::NewLine)" : "echo run >> local-executed" },
    concurrencyPolicy: "queue_one", missedPolicy: "run_once_on_reconnect", timeoutMs: 10_000,
  } })); } finally { seed.close(); }
  for (let index = 0; index < 2; index += 1) {
    const client = await startDesktopClient(directory, serverUrl);
    try {
      await client.ready;
      const deadline = Date.now() + 8_000;
      let complete = false;
      while (!complete) {
        const response = await client.request({ method: "scheduledTasks.local.runs", body: { taskId: "desktop-local-task", offset: 0, limit: 50 } });
        assert.equal(response.status, 200);
        complete = (response.body as any).items.some((run: any) => run.status === "success");
        if (!complete && Date.now() >= deadline) {
          const names = (await fs.readdir(path.join(directory, "logs"))).filter(name => name.endsWith(".log"));
          const logs = (await Promise.all(names.map(name => fs.readFile(path.join(directory, "logs", name), "utf8")))).join("\n");
          assert.fail(`ready tick did not finish local task; iteration=${index}; logs=${logs}`);
        }
        if (!complete) await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { await client.stop(); }
  }
  const result = openClientDb({ dbPath: path.join(directory, "codeflowai.db") });
  try {
    assert.equal(result.listLocalScheduledTaskRuns({ clientId, deviceId, offset: 0, limit: 50 }).total, 1);
    result.withLocalScheduledTasks(workspaceId, repos => repos.db.prepare("UPDATE scheduled_task_configs SET payload_json = ? WHERE id = ?").run("{PRIVATE_BAD_TASK_BODY", "desktop-local-task"));
  }
  finally { result.close(); }
  assert.equal((await fs.readFile(path.join(directory, "local-executed"), "utf8")).trim(), "run");
  const continuationId = "er01-real-continuation";
  const invalid = await startDesktopClient(directory, serverUrl, undefined, undefined,
    startupMode === "held" ? { mode: "held", continuationId } : { mode: "automatic" });
  let primaryFailure: { cause: unknown } | undefined;
  try {
    await invalid.ready;
    if (startupMode === "held") {
      assert.equal((await invalid.request({ method: "runtime.update.cancel" })).status, 409);
      assert.equal((await invalid.request({ method: "runtime.startup.continue", body: { continuationId } })).status, 200);
      assert.equal((await invalid.request({ method: "runtime.startup.continue", body: { continuationId } })).status, 200);
    }
    const deadline = Date.now() + 5_000;
    let diagnostic = false;
    while (!diagnostic) {
      const names = (await fs.readdir(path.join(directory, ".codeflowai"))).filter(name => name.endsWith(".log"));
      const text = (await Promise.all(names.map(name => fs.readFile(path.join(directory, ".codeflowai", name), "utf8")))).join("\n");
      assert.doesNotMatch(text, /PRIVATE_BAD_TASK_BODY/);
      diagnostic = text.includes("SCHEDULED_TASK_CONFIG_CORRUPT") && text.includes("payload_json");
      assert.ok(Date.now() < deadline, `first tick configuration failure did not preserve safe diagnostic; IPC=${JSON.stringify(invalid.ipcTimeline)}; logs=${text}`);
      if (!diagnostic) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await invalid.request({ method: "runtime.info" })).status, 200);
    assert.equal((await invalid.request({ method: "workspaces.list" })).status, 200);
    const corrupted = await invalid.request({ method: "scheduledTasks.local.list", body: {} });
    assert.equal(corrupted.status, 500);
    assert.equal((corrupted.body as any).details.reason, "SCHEDULED_TASK_CONFIG_CORRUPT");
    assert.equal((corrupted.body as any).details.field, "payload_json");
    if (startupMode === "automatic") {
      const repair = openSqliteDb(path.join(directory, ".codeflowai", "workspace.db"), { fileMustExist: true });
      try { repair.prepare("UPDATE scheduled_task_configs SET payload_json = ?, cron_expr = ? WHERE id = ?")
        .run(JSON.stringify({ contextWorkspaceId: workspaceId, shell: process.platform === "win32" ? "powershell" : "sh", command: process.platform === "win32"
          ? "[IO.File]::AppendAllText((Join-Path (Get-Location) 'local-executed'), 'run' + [Environment]::NewLine)" : "echo run >> local-executed" }), "* * * * *", "desktop-local-task"); }
      finally { repair.close(); }
      const recoveryDeadline = Date.now() + 75_000;
      let recovered = false;
      while (!recovered) {
        const response = await invalid.request({ method: "scheduledTasks.local.runs", body: { taskId: "desktop-local-task", offset: 0, limit: 50 } });
        assert.equal(response.status, 200);
        const runs = response.body as any;
        recovered = runs.total === 2 && runs.items.every((run: any) => run.status === "success");
        assert.ok(Date.now() < recoveryDeadline, "原60秒 timer 未在修复配置后恢复");
        assert.equal((await invalid.request({ method: "runtime.info" })).status, 200);
        if (!recovered) await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.equal((await fs.readFile(path.join(directory, "local-executed"), "utf8")).trim().split(/\r?\n/).length, 2);
    }
  } catch (cause) { primaryFailure = { cause }; throw cause; }
  finally { await invalid.stop(primaryFailure); }
  const appNames = (await fs.readdir(path.join(directory, "logs"))).filter(name => name.endsWith(".log"));
  const appLogs = (await Promise.all(appNames.map(name => fs.readFile(path.join(directory, "logs", name), "utf8")))).join("\n");
  assert.doesNotMatch(appLogs, /PRIVATE_BAD_TASK_BODY|local scheduled task configuration scan failed/);
  assert.equal(requests, 0);
});

test("ER01 非配置损坏扫描错误仍使真实 Client 非零退出并释放资源", { timeout: 50_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cf-desktop-unknown-scan-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId: crypto.randomUUID(), createdAt: new Date().toISOString() }), "utf8");
  const initial = await startDesktopClient(directory, "ws://127.0.0.1:1/ws/client");
  try {
    await initial.ready;
    const created = await initial.request({ method: "workspaces.upsert", body: { title: "unknown scan", path: directory } });
    assert.equal(created.status, 200);
  } finally { await initial.stop(); }
  const continuationId = "er01-unknown-scan-continuation";
  const invalid = await startDesktopClient(directory, "ws://127.0.0.1:1/ws/client", undefined, undefined, { mode: "held", continuationId });
  let primaryFailure: { cause: unknown } | undefined;
  try {
    await invalid.ready;
    const seed = openSqliteDb(path.join(directory, "codeflowai.db"), { fileMustExist: true });
    try { seed.exec("ALTER TABLE scheduled_task_configs RENAME TO unavailable_configs"); }
    finally { seed.close(); }
    assert.equal((await invalid.request({ method: "runtime.startup.continue", body: { continuationId } })).status, 200);
    await invalid.waitClosed(1);
  } catch (cause) { primaryFailure = { cause }; throw cause; }
  finally { await invalid.stop(primaryFailure); }
  const names = (await fs.readdir(path.join(directory, "logs"))).filter(name => name.endsWith(".log"));
  const logs = (await Promise.all(names.map(name => fs.readFile(path.join(directory, "logs", name), "utf8")))).join("\n");
  assert.match(logs, /DESKTOP_STARTUP_RECOVERY_FAILED/);
  assert.match(logs, /"stage":"scheduled_tasks"/);
  assert.match(logs, /"requestedExitCode":1/);
  assert.match(logs, /shutdown.complete/);
  const reopened = openSqliteDb(path.join(directory, "codeflowai.db"), { fileMustExist: true });
  try { reopened.exec("ALTER TABLE unavailable_configs RENAME TO scheduled_task_configs"); }
  finally { reopened.close(); }
});

test("desktop rejects a missing package before ready even with no workspace", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-no-builtin-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId: crypto.randomUUID(), createdAt: new Date().toISOString() }), "utf8");
  const client = await startDesktopClient(directory, "ws://127.0.0.1:1/ws/client", path.join(directory, "missing-package"));
  try { await assert.rejects(client.ready, /missing-package/); await client.waitClosed(1); }
  finally { await client.stop(); }
});

test("bundled desktop Client uses only its own builtin payload and rejects its removal", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-bundled-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId: crypto.randomUUID(), createdAt: new Date().toISOString() }), "utf8");
  const payload = path.join(directory, "client", "dist");
  await fs.mkdir(path.join(payload, "orchestration-builtin"), { recursive: true });
  await fs.symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(directory, "client", "node_modules"), "junction");
  const entry = path.join(payload, "index.cjs");
  const { build } = await import("esbuild");
  await build({ entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))], outfile: entry,
    bundle: true, platform: "node", format: "cjs", target: "node22", conditions: ["development"], logLevel: "silent",
    external: ["node-pty", "@napi-rs/keyring", "pino", "pino-roll", "word-extractor", "unpdf", "ppt-codec"] });
  await fs.copyFile(fileURLToPath(new URL("../assets/orchestration-builtin/defaultAssetBundle.v1.json", import.meta.url)),
    path.join(payload, "orchestration-builtin", "builtin.json"));
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(503).end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serverUrl = `ws://127.0.0.1:${address.port}/ws/client`;
  const ignoredOverride = path.join(directory, "ignored-source-override");
  const client = await startDesktopClient(directory, serverUrl, ignoredOverride, entry);
  try {
    await client.ready;
    const project = path.join(directory, "project");
    await fs.mkdir(project);
    const created = await client.request({ method: "workspaces.upsert", body: { title: "Bundled", path: project } });
    assert.equal(created.status, 200);
    const roles = await client.request({ method: "orch.roles.list", body: { workspaceId: (created.body as any).workspace.id } });
    assert.equal(roles.status, 200);
    assert.equal((roles.body as any).roles.length,
      JSON.parse(await fs.readFile(path.join(payload, "orchestration-builtin", "builtin.json"), "utf8")).roles.length);
  } finally { await client.stop(); }
  await fs.rename(path.join(payload, "orchestration-builtin"), path.join(payload, "removed-builtin"));
  const missing = await startDesktopClient(directory, serverUrl, ignoredOverride, entry);
  try { await assert.rejects(missing.ready, /orchestration-builtin/); await missing.waitClosed(1); }
  finally { await missing.stop(); }
  assert.equal(requests, 0);
});
