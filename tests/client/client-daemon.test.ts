import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

import {
  buildClientRestartEnv,
  buildDaemonChildProcessArgs,
  CLIENT_DAEMON_SUPERVISOR_ALREADY_RUNNING_EXIT_CODE,
  clearDaemonStateForPid,
  resolveClientDaemonExitAction,
  resolveClientDaemonSupervisorEntryPath,
  requestVerifiedDaemonSupervisorStop,
} from "../../apps/desktop/client/src/clientDaemon.ts";
import { CLIENT_PROCESS_EXIT_CODE_BLOCKED } from "../../apps/desktop/client/src/processExitCodes.ts";

test("buildDaemonChildProcessArgs preserves execArgv and converts daemon start to foreground run", () => {
  assert.deepEqual(
    buildDaemonChildProcessArgs({
      entryPath: "bin/codeflow.js",
      execArgv: ["--conditions", "development"],
      argv: ["--daemon"],
    }),
    ["--conditions", "development", path.resolve("bin/codeflow.js"), "--foreground"],
  );
});

test("buildDaemonChildProcessArgs does not duplicate foreground flag", () => {
  assert.deepEqual(
    buildDaemonChildProcessArgs({
      entryPath: "bin/codeflow.js",
      execArgv: [],
      argv: ["--foreground"],
    }),
    [path.resolve("bin/codeflow.js"), "--foreground"],
  );
});

test("buildClientRestartEnv records parent pid without dropping existing env", () => {
  const env = buildClientRestartEnv({
    CODEFLOWAI_TEST_MARKER: "1",
    CODEFLOWAI_DAEMON_CHILD: "1",
    CODEFLOWAI_DAEMON_SUPERVISOR: "1",
    CODEFLOWAI_DAEMON_SUPERVISOR_PID: "321",
    CODEFLOWAI_DAEMON_SUPERVISOR_TOKEN: "token",
    CODEFLOWAI_DAEMON_WORKER_ENTRY: "worker",
    CODEFLOWAI_RESTART_PARENT_PID: "456",
  }, 123.9);
  assert.equal(env.CODEFLOWAI_TEST_MARKER, "1");
  assert.equal(env.CODEFLOWAI_RESTART_PARENT_PID, "123");
  assert.equal(env.CODEFLOWAI_DAEMON_CHILD, undefined);
  assert.equal(env.CODEFLOWAI_DAEMON_SUPERVISOR, undefined);
  assert.equal(env.CODEFLOWAI_DAEMON_SUPERVISOR_PID, undefined);
  assert.equal(env.CODEFLOWAI_DAEMON_SUPERVISOR_TOKEN, undefined);
  assert.equal(env.CODEFLOWAI_DAEMON_WORKER_ENTRY, undefined);
});

test("resolveClientDaemonSupervisorEntryPath covers source and packaged entries", () => {
  assert.equal(
    resolveClientDaemonSupervisorEntryPath(path.join("repo", "apps", "desktop", "client", "src", "index.ts")),
    path.resolve("repo", "apps", "desktop", "client", "src", "clientDaemonSupervisor.ts"),
  );
  assert.equal(
    resolveClientDaemonSupervisorEntryPath(path.join("repo", "apps", "desktop", "client", "bin", "codeflow.js")),
    path.resolve("repo", "apps", "desktop", "client", "dist", "clientDaemonSupervisor.cjs"),
  );
});

test("clearDaemonStateForPid only removes the matching daemon state", (t) => {
  const tempDir = createTempDir(t);
  const statePath = path.join(tempDir, "client-daemon.json");
  const state = {
    pid: 456,
    startedAt: new Date(0).toISOString(),
    cwd: tempDir,
    stdoutPath: path.join(tempDir, "out.log"),
    stderrPath: path.join(tempDir, "err.log"),
  };
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

  assert.equal(clearDaemonStateForPid(statePath, 123), false);
  assert.equal(fs.existsSync(statePath), true);
  assert.equal(clearDaemonStateForPid(statePath, 456), true);
  assert.equal(fs.existsSync(statePath), false);
});

test("clearDaemonStateForPid accepts supervisor and client pid in v2 state", (t) => {
  const tempDir = createTempDir(t);
  const statePath = path.join(tempDir, "client-daemon.json");
  const createState = () => ({
    schemaVersion: 2,
    pid: 700,
    supervisorPid: 700,
    clientPid: 701,
    startedAt: new Date(0).toISOString(),
    clientStartedAt: new Date(1).toISOString(),
    cwd: tempDir,
    stdoutPath: path.join(tempDir, "out.log"),
    stderrPath: path.join(tempDir, "err.log"),
    restartCount: 0,
    status: "running",
    lastExit: null,
  });

  fs.writeFileSync(statePath, JSON.stringify(createState()), "utf8");
  assert.equal(clearDaemonStateForPid(statePath, 701), true);

  fs.writeFileSync(statePath, JSON.stringify(createState()), "utf8");
  assert.equal(clearDaemonStateForPid(statePath, 700), true);
});

test("daemon rejects the removed migration status", (t) => {
  const tempDir = createTempDir(t);
  const statePath = path.join(tempDir, "client-daemon.json");
  const now = new Date().toISOString();
  const state = {
    schemaVersion: 2,
    pid: 710,
    supervisorPid: 710,
    supervisorToken: crypto.randomUUID(),
    clientPid: 711,
    startedAt: now,
    clientStartedAt: now,
    cwd: tempDir,
    stdoutPath: path.join(tempDir, "out.log"),
    stderrPath: path.join(tempDir, "err.log"),
    restartCount: 0,
    status: "migrating",
    nextRetryAt: null,
    initialConnection: "pending",
    migrationStartedAt: now,
    migrationStage: "decrypting",
    migrationStageStartedAt: now,
    migrationLastProgressAt: now,
    migrationProcessedBytes: 0,
    migrationDatabaseBytes: 6 * 1024 ** 3,
    migrationWorkerPid: 712,
    lastExit: null,
  };

  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
  assert.throws(() => clearDaemonStateForPid(statePath, 711), /状态文件无效/);

  fs.writeFileSync(statePath, JSON.stringify({ ...state, migrationWorkerPid: null }), "utf8");
  assert.throws(() => clearDaemonStateForPid(statePath, 711), /状态文件无效/);

  fs.writeFileSync(statePath, JSON.stringify({
    ...state,
    clientPid: null,
    clientStartedAt: null,
    status: "restarting",
    migrationStage: null,
    migrationStageStartedAt: null,
    migrationLastProgressAt: null,
    migrationProcessedBytes: null,
    migrationDatabaseBytes: null,
    migrationWorkerPid: null,
  }), "utf8");
  assert.equal(clearDaemonStateForPid(statePath, 710), true);
});


test("daemon commands reject non-UUID supervisor tokens from persisted state", { timeout: 5000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({
    schemaVersion: 2,
    pid: process.pid,
    supervisorPid: process.pid,
    supervisorToken: "../invalid-control-path",
    clientPid: null,
    startedAt: new Date().toISOString(),
    clientStartedAt: null,
    cwd: process.cwd(),
    stdoutPath: path.join(daemonDir, "invalid.out.log"),
    stderrPath: path.join(daemonDir, "invalid.err.log"),
    restartCount: 0,
    status: "starting",
    nextRetryAt: null,
    lastExit: null,
  }, null, 2)}\n`, "utf8");

  const statusProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
      CODEFLOWAI_DAEMON_TEST_STATUS_LOOPS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  statusProcess.stdout?.setEncoding("utf8");
  statusProcess.stderr?.setEncoding("utf8");
  statusProcess.stdout?.on("data", (chunk) => { output += String(chunk); });
  statusProcess.stderr?.on("data", (chunk) => { output += String(chunk); });
  const closed = await waitForChildClose(statusProcess, 4000);
  assert.equal(closed.code, 1, output);
  assert.match(output, /状态文件无效/);
});

test("resolveClientDaemonExitAction keeps explicit stop and upgrade restart distinct", () => {
  assert.deepEqual(resolveClientDaemonExitAction({
    exitCode: 1,
    stopRequested: true,
    restartRequested: false,
    initialStart: false,
    uptimeMs: 10_000,
    crashCount: 1,
  }), { kind: "stop", reason: "requested" });
  assert.deepEqual(resolveClientDaemonExitAction({
    exitCode: 0,
    stopRequested: false,
    restartRequested: true,
    initialStart: false,
    uptimeMs: 10_000,
    crashCount: 0,
  }), { kind: "restart", reason: "requested", delayMs: 0 });
  assert.deepEqual(resolveClientDaemonExitAction({
    exitCode: 0,
    stopRequested: false,
    restartRequested: false,
    initialStart: false,
    uptimeMs: 10_000,
    crashCount: 0,
  }), { kind: "stop", reason: "clean_exit" });
});


test("resolveClientDaemonExitAction cools down startup failure and crash loops without exiting", () => {
  assert.deepEqual(resolveClientDaemonExitAction({
    exitCode: 1,
    stopRequested: false,
    restartRequested: false,
    initialStart: true,
    uptimeMs: 500,
    crashCount: 1,
  }), { kind: "restart", reason: "startup_exit", delayMs: 30_000 });
  assert.deepEqual(resolveClientDaemonExitAction({
    exitCode: 1,
    stopRequested: false,
    restartRequested: false,
    initialStart: false,
    uptimeMs: 500,
    crashCount: 6,
  }), { kind: "restart", reason: "crash_loop", delayMs: 300_000 });
});

test("resolveClientDaemonExitAction retries blocked workers slowly without treating them as crashes", () => {
  assert.deepEqual(resolveClientDaemonExitAction({
    exitCode: CLIENT_PROCESS_EXIT_CODE_BLOCKED,
    stopRequested: false,
    restartRequested: false,
    initialStart: true,
    uptimeMs: 100,
    crashCount: 99,
  }), { kind: "restart", reason: "blocked", delayMs: 60_000 });
});

test("resolveClientDaemonExitAction applies bounded restart backoff", () => {
  const delays = [1, 2, 3, 4, 5].map((crashCount) => resolveClientDaemonExitAction({
    exitCode: 1,
    stopRequested: false,
    restartRequested: false,
    initialStart: false,
    uptimeMs: 10_000,
    crashCount,
  }));

  assert.deepEqual(delays, [
    { kind: "restart", reason: "crash", delayMs: 1000 },
    { kind: "restart", reason: "crash", delayMs: 2000 },
    { kind: "restart", reason: "crash", delayMs: 5000 },
    { kind: "restart", reason: "crash", delayMs: 10_000 },
    { kind: "restart", reason: "crash", delayMs: 30_000 },
  ]);
});

test("supervisor lifecycle lock permits only one concurrent owner", { timeout: 12_000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const lockPath = path.join(daemonDir, "client-daemon-supervisor.lock");
  const counterPath = path.join(tempDir, "attempt.txt");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const supervisorEntryPath = fileURLToPath(new URL("../../apps/desktop/client/src/clientDaemonSupervisor.ts", import.meta.url));
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
    CODEFLOWAI_DAEMON_TEST_COUNTER_PATH: counterPath,
    CODEFLOWAI_DAEMON_TEST_STAY_RUNNING: "1",
  };
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    token: "stale-metadata",
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  const spawnSupervisor = () => spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    supervisorEntryPath,
    "--foreground",
  ], {
    cwd: process.cwd(),
    env: {
      ...fixtureEnv,
      CODEFLOWAI_DAEMON_SUPERVISOR: "1",
      CODEFLOWAI_DAEMON_WORKER_ENTRY: fixturePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const first = spawnSupervisor();
  const second = spawnSupervisor();
  if (!first.pid || !second.pid) throw new Error("并发 supervisor 测试未获得完整 PID");
  const managedPids = new Set<number>([first.pid, second.pid]);
  let cleanupNeeded = true;
  let diagnostics = "";
  for (const child of [first, second]) {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
    child.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
  }
  t.after(async () => {
    if (!cleanupNeeded) return;
    for (const pid of managedPids) forceKillTestProcess(pid);
    await Promise.allSettled([waitForChildClose(first, 2000), waitForChildClose(second, 2000)]);
  });

  const state = await waitForDaemonState(
    statePath,
    (candidate) => Number(candidate.clientPid) > 0 && fs.existsSync(counterPath),
    5000,
    () => diagnostics,
  );
  const ownerPid = Number(state.supervisorPid);
  const workerPid = Number(state.clientPid);
  managedPids.add(workerPid);
  assert.ok(ownerPid === first.pid || ownerPid === second.pid, diagnostics);
  const owner = ownerPid === first.pid ? first : second;
  const loser = owner === first ? second : first;
  const loserClosed = await waitForChildClose(loser, 4000);
  assert.equal(loserClosed.code, CLIENT_DAEMON_SUPERVISOR_ALREADY_RUNNING_EXIT_CODE, diagnostics);
  assert.equal(Number(fs.readFileSync(counterPath, "utf8")), 1);
  assert.equal(fs.existsSync(lockPath), true);
  const ownerLock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
  assert.equal(Number(ownerLock.pid), ownerPid);
  assert.equal(ownerLock.token, state.supervisorToken);
  assert.notEqual(ownerLock.token, "stale-metadata");

  const stopProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: { ...fixtureEnv, CODEFLOWAI_DAEMON_TEST_STOP: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!stopProcess.pid) throw new Error("并发 supervisor 测试 stop 进程未获得 PID");
  managedPids.add(stopProcess.pid);
  let stopOutput = "";
  stopProcess.stdout?.setEncoding("utf8");
  stopProcess.stderr?.setEncoding("utf8");
  stopProcess.stdout?.on("data", (chunk) => { stopOutput += String(chunk); });
  stopProcess.stderr?.on("data", (chunk) => { stopOutput += String(chunk); });
  const stopClosed = await waitForChildClose(stopProcess, 7000);
  assert.equal(stopClosed.code, 0, stopOutput);
  const ownerClosed = await waitForChildClose(owner, 5000);
  assert.equal(ownerClosed.code, 0, diagnostics);
  cleanupNeeded = false;
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(lockPath), false);
});

test("concurrent status probes do not occupy the supervisor lifecycle endpoint", { timeout: 20_000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const lockPath = path.join(daemonDir, "client-daemon-supervisor.lock");
  const counterPath = path.join(tempDir, "attempt.txt");
  const statusReadyPath = path.join(tempDir, "status-ready.txt");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const supervisorEntryPath = fileURLToPath(new URL("../../apps/desktop/client/src/clientDaemonSupervisor.ts", import.meta.url));
  const staleToken = crypto.randomUUID();
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
    CODEFLOWAI_DAEMON_TEST_COUNTER_PATH: counterPath,
    CODEFLOWAI_DAEMON_TEST_STAY_RUNNING: "1",
  };
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    token: staleToken,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(statePath, `${JSON.stringify({
    schemaVersion: 2,
    pid: process.pid,
    supervisorPid: process.pid,
    supervisorToken: staleToken,
    clientPid: null,
    startedAt: new Date().toISOString(),
    clientStartedAt: null,
    cwd: process.cwd(),
    stdoutPath: path.join(daemonDir, "status.out.log"),
    stderrPath: path.join(daemonDir, "status.err.log"),
    restartCount: 0,
    status: "starting",
    nextRetryAt: null,
    lastExit: null,
  }, null, 2)}\n`, "utf8");

  const statusProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: {
      ...fixtureEnv,
      CODEFLOWAI_DAEMON_TEST_STATUS_LOOPS: "2000",
      CODEFLOWAI_DAEMON_TEST_STATUS_READY_PATH: statusReadyPath,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const readyDeadline = Date.now() + 3000;
  while (!fs.existsSync(statusReadyPath) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(statusReadyPath), true);

  const supervisor = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    supervisorEntryPath,
    "--foreground",
  ], {
    cwd: process.cwd(),
    env: {
      ...fixtureEnv,
      CODEFLOWAI_DAEMON_SUPERVISOR: "1",
      CODEFLOWAI_DAEMON_WORKER_ENTRY: fixturePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!supervisor.pid) throw new Error("status 并发测试未获得 supervisor PID");
  const managedPids = new Set<number>([supervisor.pid]);
  let cleanupNeeded = true;
  let diagnostics = "";
  supervisor.stdout?.setEncoding("utf8");
  supervisor.stderr?.setEncoding("utf8");
  supervisor.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
  supervisor.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
  t.after(async () => {
    if (!cleanupNeeded) return;
    for (const pid of managedPids) forceKillTestProcess(pid);
    if (statusProcess.pid) forceKillTestProcess(statusProcess.pid);
    await Promise.allSettled([waitForChildClose(supervisor, 2000), waitForChildClose(statusProcess, 2000)]);
  });

  const running = await waitForDaemonState(
    statePath,
    (state) => Number(state.supervisorPid) === supervisor.pid && Number(state.clientPid) > 0,
    5000,
    () => diagnostics,
  );
  const clientPid = Number(running.clientPid);
  managedPids.add(clientPid);
  const statusClosed = await waitForChildClose(statusProcess, 10_000);
  assert.equal(statusClosed.code, 0);

  const stopProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: { ...fixtureEnv, CODEFLOWAI_DAEMON_TEST_STOP: "1" },
    stdio: "ignore",
    windowsHide: true,
  });
  const stopClosed = await waitForChildClose(stopProcess, 7000);
  assert.equal(stopClosed.code, 0);
  const supervisorClosed = await waitForChildClose(supervisor, 5000);
  assert.equal(supervisorClosed.code, 0, diagnostics);
  cleanupNeeded = false;
});

test("daemon lifecycle endpoint socket 忽略对端断开错误，不因 EPIPE 终止进程", () => {
  const source = fs.readFileSync(new URL("../../apps/desktop/client/src/clientDaemon.ts", import.meta.url), "utf8");
  const supervisorHandlerStart = source.indexOf("function handleDaemonSupervisorStopSocket(");
  const workerEndpointStart = source.indexOf("async function holdCurrentDaemonWorkerEndpoint(");
  assert.ok(supervisorHandlerStart >= 0 && workerEndpointStart > supervisorHandlerStart,
    "未找到 daemon lifecycle endpoint 处理边界");

  // 请求方（--status 探测、supervisor 探测）随时可能先断开，此时 socket.end() 写入会得到 EPIPE；
  // 缺少 error 监听就会升级成 unhandled 'error'，直接终止 daemon。
  assert.match(source,
    /function attachDaemonLifecycleSocketErrorHandler\(socket: net\.Socket\): void \{[\s\S]*?socket\.on\("error"/,
    "缺少 lifecycle endpoint socket 的 error 处理");

  const attachCall = "attachDaemonLifecycleSocketErrorHandler(socket);";
  assert.ok(source.slice(supervisorHandlerStart, workerEndpointStart).includes(attachCall),
    "supervisor endpoint 的 socket 未挂 error 处理：--status/--stop 探测超时断开时会被 EPIPE 终止 daemon");

  const workerEndpointBody = source.slice(workerEndpointStart, source.indexOf("\n}\n", workerEndpointStart));
  assert.ok(workerEndpointBody.includes(attachCall),
    "worker endpoint 的 socket 未挂 error 处理：supervisor 探测断开时会被 EPIPE 终止 daemon");
});

test("stop lets a blocked supervisor release its lifecycle lock", { timeout: 10_000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const lockPath = path.join(daemonDir, "client-daemon-supervisor.lock");
  const stopControlPath = path.join(daemonDir, "client-daemon-stop.json");
  const counterPath = path.join(tempDir, "attempt.txt");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const supervisorEntryPath = fileURLToPath(new URL("../../apps/desktop/client/src/clientDaemonSupervisor.ts", import.meta.url));
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
    CODEFLOWAI_DAEMON_TEST_COUNTER_PATH: counterPath,
    CODEFLOWAI_DAEMON_TEST_BLOCKED: "1",
  };
  const supervisor = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    supervisorEntryPath,
    "--foreground",
  ], {
    cwd: process.cwd(),
    env: {
      ...fixtureEnv,
      CODEFLOWAI_DAEMON_SUPERVISOR: "1",
      CODEFLOWAI_DAEMON_WORKER_ENTRY: fixturePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!supervisor.pid) throw new Error("blocked supervisor 测试未获得 PID");
  const managedPids = new Set<number>([supervisor.pid]);
  let cleanupNeeded = true;
  let diagnostics = "";
  supervisor.stdout?.setEncoding("utf8");
  supervisor.stderr?.setEncoding("utf8");
  supervisor.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
  supervisor.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
  t.after(async () => {
    if (!cleanupNeeded) return;
    for (const pid of managedPids) forceKillTestProcess(pid);
    await waitForChildClose(supervisor, 2000).catch(() => undefined);
  });

  const blocked = await waitForDaemonState(
    statePath,
    (state) => state.status === "blocked" && state.clientPid == null,
    5000,
    () => diagnostics,
  );
  assert.equal(Number(blocked.supervisorPid), supervisor.pid);
  assert.equal(fs.existsSync(lockPath), true);
  const delayedOldOwnerToken = crypto.randomUUID();
  fs.writeFileSync(`${stopControlPath}.${delayedOldOwnerToken}`, `${JSON.stringify({
    action: "stop",
    supervisorPid: blocked.supervisorPid,
    supervisorToken: delayedOldOwnerToken,
    clientPid: null,
    requestedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(supervisor.exitCode, null, diagnostics);
  const stateAfterStaleControl = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  assert.equal(stateAfterStaleControl.supervisorToken, blocked.supervisorToken);

  const stopProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: { ...fixtureEnv, CODEFLOWAI_DAEMON_TEST_STOP: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!stopProcess.pid) throw new Error("blocked supervisor stop 测试未获得 PID");
  managedPids.add(stopProcess.pid);
  let stopOutput = "";
  stopProcess.stdout?.setEncoding("utf8");
  stopProcess.stderr?.setEncoding("utf8");
  stopProcess.stdout?.on("data", (chunk) => { stopOutput += String(chunk); });
  stopProcess.stderr?.on("data", (chunk) => { stopOutput += String(chunk); });
  const stopClosed = await waitForChildClose(stopProcess, 7000);
  assert.equal(stopClosed.code, 0, stopOutput);
  const supervisorClosed = await waitForChildClose(supervisor, 5000);
  assert.equal(supervisorClosed.code, 0, diagnostics);
  cleanupNeeded = false;
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(lockPath), false);
});

test("stop force-terminates through a verified supervisor when repeated graceful signals cannot finish shutdown", { timeout: 20_000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const lockPath = path.join(daemonDir, "client-daemon-supervisor.lock");
  const counterPath = path.join(tempDir, "attempt.txt");
  const signalLogPath = path.join(tempDir, "signals.log");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const supervisorEntryPath = fileURLToPath(new URL("../../apps/desktop/client/src/clientDaemonSupervisor.ts", import.meta.url));
  // Windows 会直接执行 SIGTERM；测试中将其置空，确保只有 SIGKILL 能完成收口。
  const processKillProbe = `data:text/javascript,${encodeURIComponent([
    'import fs from "node:fs";',
    "const originalKill = process.kill.bind(process);",
    "const logPath = process.env.CODEFLOWAI_DAEMON_TEST_SIGNAL_LOG_PATH;",
    "process.kill = (pid, signal) => {",
    '  if (signal === "SIGTERM") {',
    '    if (logPath) fs.appendFileSync(logPath, "SIGTERM\\n");',
    "    return true;",
    "  }",
    '  if (signal === "SIGKILL" && logPath) fs.appendFileSync(logPath, "SIGKILL\\n");',
    "  return originalKill(pid, signal);",
    "};",
  ].join("\n"))}`;
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
    CODEFLOWAI_DAEMON_TEST_COUNTER_PATH: counterPath,
    CODEFLOWAI_DAEMON_TEST_STAY_RUNNING: "1",
    CODEFLOWAI_DAEMON_TEST_STOP_DELAY_ATTEMPT: "1",
    CODEFLOWAI_DAEMON_TEST_STOP_DELAY_MS: "20000",
  };
  const supervisor = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    supervisorEntryPath,
    "--foreground",
  ], {
    cwd: process.cwd(),
    env: {
      ...fixtureEnv,
      CODEFLOWAI_DAEMON_SUPERVISOR: "1",
      CODEFLOWAI_DAEMON_WORKER_ENTRY: fixturePath,
      CODEFLOWAI_DAEMON_TEST_SIGNAL_LOG_PATH: signalLogPath,
      NODE_OPTIONS: `${String(process.env.NODE_OPTIONS ?? "").trim()} --import=${processKillProbe}`.trim(),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!supervisor.pid) throw new Error("强制停止测试未获得 supervisor PID");

  const managedPids = new Set<number>([supervisor.pid]);
  let cleanupNeeded = true;
  let diagnostics = "";
  supervisor.stdout?.setEncoding("utf8");
  supervisor.stderr?.setEncoding("utf8");
  supervisor.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
  supervisor.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
  t.after(async () => {
    if (!cleanupNeeded) {
      return;
    }
    if (fs.existsSync(statePath)) {
      const current = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
      const clientPid = Number(current.clientPid ?? 0);
      if (clientPid > 0) managedPids.add(clientPid);
    }
    for (const pid of managedPids) forceKillTestProcess(pid);
    await waitForChildClose(supervisor, 2000).catch(() => undefined);
  });

  const running = await waitForDaemonState(
    statePath,
    (state) => Number(state.supervisorPid) === supervisor.pid && Number(state.clientPid) > 0,
    5000,
    () => diagnostics,
  );
  const clientPid = Number(running.clientPid);
  managedPids.add(clientPid);

  await requestVerifiedDaemonSupervisorStop(lockPath, String(running.supervisorToken), supervisor.pid);

  const stopProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: { ...fixtureEnv, CODEFLOWAI_DAEMON_TEST_STOP: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!stopProcess.pid) throw new Error("强制停止测试未获得 stop PID");
  managedPids.add(stopProcess.pid);
  stopProcess.stdout?.setEncoding("utf8");
  stopProcess.stderr?.setEncoding("utf8");
  stopProcess.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
  stopProcess.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });

  const stopClosed = await waitForChildClose(stopProcess, 15_000);
  assert.equal(stopClosed.code, 0, diagnostics);
  const supervisorClosed = await waitForChildClose(supervisor, 5000);
  assert.equal(supervisorClosed.code, 0, diagnostics);
  cleanupNeeded = false;
  assert.equal(isTestProcessRunning(clientPid), false);
  assert.deepEqual(fs.readFileSync(signalLogPath, "utf8").trim().split(/\r?\n/), ["SIGTERM", "SIGKILL"]);
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(lockPath), false);
});

test("stop removes a stale supervised state after both recorded processes exited", { timeout: 5000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const exited = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (!exited.pid) throw new Error("stale stop 测试未获得退出进程 PID");
  const exitedPid = exited.pid;
  await waitForChildClose(exited, 3000);
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({
    schemaVersion: 2,
    pid: exitedPid,
    supervisorPid: exitedPid,
    supervisorToken: crypto.randomUUID(),
    clientPid: exitedPid,
    startedAt: new Date().toISOString(),
    clientStartedAt: new Date().toISOString(),
    cwd: process.cwd(),
    stdoutPath: path.join(daemonDir, "stale.out.log"),
    stderrPath: path.join(daemonDir, "stale.err.log"),
    restartCount: 0,
    status: "running",
    nextRetryAt: null,
    initialConnection: null,
    lastExit: null,
  }, null, 2)}\n`, "utf8");

  const stopProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
      CODEFLOWAI_DAEMON_TEST_STOP: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  stopProcess.stdout?.setEncoding("utf8");
  stopProcess.stderr?.setEncoding("utf8");
  stopProcess.stdout?.on("data", (chunk) => { output += String(chunk); });
  stopProcess.stderr?.on("data", (chunk) => { output += String(chunk); });
  const stopped = await waitForChildClose(stopProcess, 4000);
  assert.equal(stopped.code, 0, output);
  assert.match(output, /已清理 stale state/);
  assert.equal(fs.existsSync(statePath), false);
});

test("unverified stale PIDs are never signaled and do not block a new supervisor", { timeout: 15_000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const lockPath = path.join(daemonDir, "client-daemon-supervisor.lock");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (!unrelated.pid) throw new Error("stale PID stop 测试未获得无关进程 PID");
  const unrelatedPid = unrelated.pid;
  const managedPids = new Set<number>([unrelatedPid]);
  let cleanupNeeded = true;
  t.after(async () => {
    if (cleanupNeeded) {
      for (const pid of managedPids) forceKillTestProcess(pid);
    }
    await waitForChildClose(unrelated, 2000).catch(() => undefined);
  });

  const supervisorToken = crypto.randomUUID();
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    token: supervisorToken,
    pid: unrelatedPid,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(statePath, `${JSON.stringify({
    schemaVersion: 2,
    pid: unrelatedPid,
    supervisorPid: unrelatedPid,
    supervisorToken,
    clientPid: unrelatedPid,
    startedAt: new Date().toISOString(),
    clientStartedAt: new Date().toISOString(),
    cwd: process.cwd(),
    stdoutPath: path.join(daemonDir, "stale.out.log"),
    stderrPath: path.join(daemonDir, "stale.err.log"),
    restartCount: 0,
    status: "running",
    nextRetryAt: null,
    lastExit: null,
  }, null, 2)}\n`, "utf8");

  const stopProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
      CODEFLOWAI_DAEMON_TEST_STOP: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stopOutput = "";
  stopProcess.stdout?.setEncoding("utf8");
  stopProcess.stderr?.setEncoding("utf8");
  stopProcess.stdout?.on("data", (chunk) => { stopOutput += String(chunk); });
  stopProcess.stderr?.on("data", (chunk) => { stopOutput += String(chunk); });
  const stopClosed = await waitForChildClose(stopProcess, 5000);
  assert.equal(stopClosed.code, 1, stopOutput);
  assert.match(stopOutput, /未向 PID 发送停止信号/);
  assert.equal(isTestProcessRunning(unrelatedPid), true);

  const tokenlessState = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  tokenlessState.supervisorToken = null;
  fs.writeFileSync(statePath, `${JSON.stringify(tokenlessState, null, 2)}\n`, "utf8");
  const legacyStopProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
      CODEFLOWAI_DAEMON_TEST_STOP: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let legacyStopOutput = "";
  legacyStopProcess.stdout?.setEncoding("utf8");
  legacyStopProcess.stderr?.setEncoding("utf8");
  legacyStopProcess.stdout?.on("data", (chunk) => { legacyStopOutput += String(chunk); });
  legacyStopProcess.stderr?.on("data", (chunk) => { legacyStopOutput += String(chunk); });
  const legacyStopClosed = await waitForChildClose(legacyStopProcess, 5000);
  assert.equal(legacyStopClosed.code, 1, legacyStopOutput);
  assert.match(legacyStopOutput, /缺少 owner token/);
  assert.equal(isTestProcessRunning(unrelatedPid), true);

  const recoveryToken = crypto.randomUUID();
  tokenlessState.supervisorToken = recoveryToken;
  fs.writeFileSync(statePath, `${JSON.stringify(tokenlessState, null, 2)}\n`, "utf8");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    token: recoveryToken,
    pid: unrelatedPid,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  const counterPath = path.join(tempDir, "recovery-attempt.txt");
  const supervisorEntryPath = fileURLToPath(new URL("../../apps/desktop/client/src/clientDaemonSupervisor.ts", import.meta.url));
  const supervisorEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
    CODEFLOWAI_DAEMON_TEST_COUNTER_PATH: counterPath,
    CODEFLOWAI_DAEMON_TEST_STAY_RUNNING: "1",
  };
  const supervisor = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    supervisorEntryPath,
    "--foreground",
  ], {
    cwd: process.cwd(),
    env: {
      ...supervisorEnv,
      CODEFLOWAI_DAEMON_SUPERVISOR: "1",
      CODEFLOWAI_DAEMON_WORKER_ENTRY: fixturePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!supervisor.pid) throw new Error("stale PID recovery 测试未获得 supervisor PID");
  managedPids.add(supervisor.pid);
  let supervisorOutput = "";
  supervisor.stdout?.setEncoding("utf8");
  supervisor.stderr?.setEncoding("utf8");
  supervisor.stdout?.on("data", (chunk) => { supervisorOutput += String(chunk); });
  supervisor.stderr?.on("data", (chunk) => { supervisorOutput += String(chunk); });
  const recovered = await waitForDaemonState(
    statePath,
    (state) => Number(state.supervisorPid) === supervisor.pid && Number(state.clientPid) > 0,
    5000,
    () => supervisorOutput,
  );
  managedPids.add(Number(recovered.clientPid));
  assert.equal(isTestProcessRunning(unrelatedPid), true);

  const recoveredStop = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: { ...supervisorEnv, CODEFLOWAI_DAEMON_TEST_STOP: "1" },
    stdio: "ignore",
    windowsHide: true,
  });
  const recoveredStopClosed = await waitForChildClose(recoveredStop, 7000);
  assert.equal(recoveredStopClosed.code, 0);
  const supervisorClosed = await waitForChildClose(supervisor, 5000);
  assert.equal(supervisorClosed.code, 0, supervisorOutput);
  assert.equal(isTestProcessRunning(unrelatedPid), true);

  forceKillTestProcess(unrelatedPid);
  await waitForChildClose(unrelated, 2000);
  cleanupNeeded = false;
});

test("a second start recovers an orphan worker after timeout and reports replacement startup failure", { timeout: 25_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-daemon-test-"));
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const lockPath = path.join(daemonDir, "client-daemon-supervisor.lock");
  const counterPath = path.join(tempDir, "attempt.txt");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
    CODEFLOWAI_DAEMON_TEST_COUNTER_PATH: counterPath,
    CODEFLOWAI_DAEMON_TEST_STAY_RUNNING: "1",
    CODEFLOWAI_DAEMON_TEST_STOP_DELAY_ATTEMPT: "1",
    CODEFLOWAI_DAEMON_TEST_STOP_DELAY_MS: "9000",
    CODEFLOWAI_STARTUP_TIMEOUT_MS: "5000",
  };
  const retiredSupervisor = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (!retiredSupervisor.pid) throw new Error("orphan recovery 测试未获得 retired supervisor PID");
  const retiredSupervisorPid = retiredSupervisor.pid;
  await waitForChildClose(retiredSupervisor, 3000);
  const supervisorToken = crypto.randomUUID();
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    token: supervisorToken,
    pid: retiredSupervisorPid,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(statePath, `${JSON.stringify({
    schemaVersion: 2,
    pid: retiredSupervisorPid,
    supervisorPid: retiredSupervisorPid,
    supervisorToken,
    clientPid: null,
    startedAt: new Date().toISOString(),
    clientStartedAt: null,
    cwd: process.cwd(),
    stdoutPath: path.join(daemonDir, "orphan.out.log"),
    stderrPath: path.join(daemonDir, "orphan.err.log"),
    restartCount: 0,
    status: "starting",
    nextRetryAt: null,
    lastExit: null,
  }, null, 2)}\n`, "utf8");

  const orphanWorker = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
    "--foreground",
  ], {
    cwd: process.cwd(),
    env: {
      ...fixtureEnv,
      CODEFLOWAI_DAEMON_CHILD: "1",
      CODEFLOWAI_DAEMON_SUPERVISOR_PID: String(retiredSupervisorPid),
      CODEFLOWAI_DAEMON_SUPERVISOR_TOKEN: supervisorToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!orphanWorker.pid) throw new Error("orphan recovery 测试未获得 worker PID");
  const orphanPid = orphanWorker.pid;
  const managedPids = new Set<number>([orphanPid]);
  let cleanupNeeded = true;
  let diagnostics = "";
  orphanWorker.stdout?.setEncoding("utf8");
  orphanWorker.stderr?.setEncoding("utf8");
  orphanWorker.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
  orphanWorker.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
  t.after(async () => {
    if (cleanupNeeded) {
      if (fs.existsSync(statePath)) {
        const current = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
        const supervisorPid = Number(current.supervisorPid ?? 0);
        const clientPid = Number(current.clientPid ?? 0);
        if (supervisorPid > 0 && supervisorPid !== retiredSupervisorPid) managedPids.add(supervisorPid);
        if (clientPid > 0) managedPids.add(clientPid);
      }
      for (const pid of managedPids) forceKillTestProcess(pid);
      await waitForChildClose(orphanWorker, 2000);
      const deadline = Date.now() + 2000;
      while ([...managedPids].some(isTestProcessRunning) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      for (const pid of managedPids) assert.equal(isTestProcessRunning(pid), false, `测试进程未退出 pid=${pid}`);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForDaemonState(
    statePath,
    (state) => Number(state.clientPid) === orphanPid && state.status === "running",
    5000,
    () => diagnostics,
  );
  assert.equal(isTestProcessRunning(orphanPid), true);

  let startOutput = "";
  /** 原 daemon 启动入口配合受控握手失败，独立验证恢复协议而不依赖真实认证耗时。 */
  const spawnStart = () => {
    const child = spawn(process.execPath, [
      "--conditions=development",
      "--import",
      "tsx",
      fixturePath,
    ], {
      cwd: process.cwd(),
      env: { ...fixtureEnv, CODEFLOWAI_DAEMON_TEST_START_MODE: "plain", CODEFLOWAI_DAEMON_TEST_INITIAL_CONNECTION_OUTCOME: "failed" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child.pid) throw new Error("orphan recovery start 测试未获得 PID");
    managedPids.add(child.pid);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { startOutput += String(chunk); });
    child.stderr?.on("data", (chunk) => { startOutput += String(chunk); });
    return child;
  };

  const firstStart = spawnStart();
  const firstStartClosed = await waitForChildClose(firstStart, 9000);
  assert.equal(firstStartClosed.code, 1, startOutput);
  assert.equal(isTestProcessRunning(orphanPid), true);

  const retryStart = spawnStart();
  const retryStartClosed = await waitForChildClose(retryStart, 9000);
  assert.equal(retryStartClosed.code, 1, startOutput);
  // worker 已明确发布失败时可立即返回，不必等 supervisor 异步转入 cooldown。
  assert.match(startOutput, /后台 Client 启动失败/u);
  assert.match(startOutput, /未确认服务器连接成功/u);
  assert.doesNotMatch(startOutput, /===== 启动成功/u);

  const recovered = await waitForDaemonState(
    statePath,
    (state) => Number(state.supervisorPid) !== retiredSupervisorPid
      && state.supervisorToken !== supervisorToken
      && (state.status === "cooldown" || state.status === "restarting") && state.clientPid == null,
    5000,
    () => startOutput,
  );
  const recoveredSupervisorPid = Number(recovered.supervisorPid);
  assert.equal((recovered.lastExit as { code: number }).code, 1);
  const recoveredClientPid = Number(recovered.clientPid ?? 0);
  managedPids.add(recoveredSupervisorPid);
  if (recoveredClientPid > 0) managedPids.add(recoveredClientPid);
  assert.equal(isTestProcessRunning(orphanPid), false);
  assert.equal(Number(fs.readFileSync(counterPath, "utf8")), 2);

  const stopProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: { ...fixtureEnv, CODEFLOWAI_DAEMON_TEST_STOP: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!stopProcess.pid) throw new Error("orphan recovery stop 测试未获得 PID");
  managedPids.add(stopProcess.pid);
  const stopClosed = await waitForChildClose(stopProcess, 7000);
  assert.equal(stopClosed.code, 0);
  assert.equal(isTestProcessRunning(recoveredSupervisorPid), false);
  if (recoveredClientPid > 0) assert.equal(isTestProcessRunning(recoveredClientPid), false);
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(lockPath), false);
  cleanupNeeded = false;
});

test("supervisor handles crash recovery, requested replacement, and explicit stop", { timeout: 15_000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const statePath = path.join(homeDir, ".codeflowai", "client-daemon.json");
  const counterPath = path.join(tempDir, "attempt.txt");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const supervisorEntryPath = fileURLToPath(new URL("../../apps/desktop/client/src/clientDaemonSupervisor.ts", import.meta.url));
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEFLOWAI_CLIENT_LOG_DIR: path.join(homeDir, ".codeflowai", "logs"),
    CODEFLOWAI_DAEMON_TEST_COUNTER_PATH: counterPath,
    CODEFLOWAI_DAEMON_TEST_RESTART_ATTEMPT: "2",
  };
  const supervisor = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    supervisorEntryPath,
    "--foreground",
  ], {
    cwd: process.cwd(),
    env: {
      ...fixtureEnv,
      CODEFLOWAI_DAEMON_SUPERVISOR: "1",
      CODEFLOWAI_DAEMON_WORKER_ENTRY: fixturePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!supervisor.pid) throw new Error("测试 supervisor 未获得 PID");

  const managedPids = new Set<number>([supervisor.pid]);
  let cleanupNeeded = true;
  let stderr = "";
  supervisor.stderr?.setEncoding("utf8");
  supervisor.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  t.after(async () => {
    if (!cleanupNeeded) return;
    for (const pid of managedPids) forceKillTestProcess(pid);
    await waitForChildClose(supervisor, 2000).catch((error) => {
      throw new Error(`测试 supervisor 清理失败：${error instanceof Error ? error.message : String(error)}`);
    });
  });

  const first = await waitForDaemonState(statePath, (state) => Number(state.clientPid) > 0, 4000, () => stderr);
  const firstClientPid = Number(first.clientPid);
  managedPids.add(firstClientPid);
  assert.equal(Number(first.supervisorPid), supervisor.pid);

  const second = await waitForDaemonState(
    statePath,
    (state) => Number(state.clientPid) > 0
      && Number(state.clientPid) !== firstClientPid
      && fs.existsSync(counterPath)
      && Number(fs.readFileSync(counterPath, "utf8")) === 2,
    7000,
    () => stderr,
  );
  const secondClientPid = Number(second.clientPid);
  managedPids.add(secondClientPid);
  assert.equal(Number(second.supervisorPid), supervisor.pid);
  assert.equal(Number(fs.readFileSync(counterPath, "utf8")), 2);

  const third = await waitForDaemonState(
    statePath,
    (state) => Number(state.clientPid) > 0
      && Number(state.clientPid) !== secondClientPid
      && Number(fs.readFileSync(counterPath, "utf8")) === 3,
    4000,
    () => stderr,
  );
  const thirdClientPid = Number(third.clientPid);
  managedPids.add(thirdClientPid);
  assert.equal(Number(third.supervisorPid), supervisor.pid);

  const stopProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: { ...fixtureEnv, CODEFLOWAI_DAEMON_TEST_STOP: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!stopProcess.pid) throw new Error("测试 stop 进程未获得 PID");
  managedPids.add(stopProcess.pid);
  let stopOutput = "";
  stopProcess.stdout?.setEncoding("utf8");
  stopProcess.stderr?.setEncoding("utf8");
  stopProcess.stdout?.on("data", (chunk) => { stopOutput += String(chunk); });
  stopProcess.stderr?.on("data", (chunk) => { stopOutput += String(chunk); });
  const stopClosed = await waitForChildClose(stopProcess, 7000);
  assert.equal(stopClosed.code, 0, stopOutput);

  const closed = await waitForChildClose(supervisor, 5000);
  assert.equal(closed.code, 0, stderr);
  cleanupNeeded = false;
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(Number(fs.readFileSync(counterPath, "utf8")), 3);
});

test("repeated start reuses an active daemon and explicit key start safely replaces it", { timeout: 20_000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const counterPath = path.join(tempDir, "attempt.txt");
  const explicitKey = "codeflowai_test_restart_key_not_logged";
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const supervisorEntryPath = fileURLToPath(new URL("../../apps/desktop/client/src/clientDaemonSupervisor.ts", import.meta.url));
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
    CODEFLOWAI_DAEMON_TEST_COUNTER_PATH: counterPath,
    CODEFLOWAI_DAEMON_TEST_INITIAL_CONNECTION_OUTCOME: "succeeded",
    CODEFLOWAI_DAEMON_TEST_STAY_RUNNING: "1",
    CODEFLOWAI_DAEMON_TEST_BLOCKED_ATTEMPT: "1",
    CODEFLOWAI_STARTUP_TIMEOUT_MS: "5000",
  };
  const supervisor = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    supervisorEntryPath,
    "--foreground",
  ], {
    cwd: process.cwd(),
    env: {
      ...fixtureEnv,
      CODEFLOWAI_DAEMON_SUPERVISOR: "1",
      CODEFLOWAI_DAEMON_WORKER_ENTRY: fixturePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!supervisor.pid) throw new Error("重复启动测试未获得初始 supervisor PID");

  const managedPids = new Set<number>([supervisor.pid]);
  let cleanupNeeded = true;
  let diagnostics = "";
  supervisor.stdout?.setEncoding("utf8");
  supervisor.stderr?.setEncoding("utf8");
  supervisor.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
  supervisor.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
  t.after(async () => {
    if (!cleanupNeeded) return;
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
      const supervisorPid = Number(state.supervisorPid ?? 0);
      const clientPid = Number(state.clientPid ?? 0);
      if (supervisorPid > 0) managedPids.add(supervisorPid);
      if (clientPid > 0) managedPids.add(clientPid);
    }
    for (const pid of managedPids) forceKillTestProcess(pid);
    await waitForChildClose(supervisor, 2000).catch(() => undefined);
  });

  await waitForDaemonState(
    statePath,
    (state) => Number(state.supervisorPid) === supervisor.pid
      && state.status === "blocked"
      && state.clientPid == null,
    5000,
    () => diagnostics,
  );

  /** 以隔离进程执行一次用户启动命令并汇总诊断输出。 */
  const runStart = (mode: "plain" | "key") => {
    const child = spawn(process.execPath, [
      "--conditions=development",
      "--import",
      "tsx",
      fixturePath,
    ], {
      cwd: process.cwd(),
      env: {
        ...fixtureEnv,
        CODEFLOWAI_DAEMON_TEST_START_MODE: mode,
        ...(mode === "key" ? { CODEFLOWAI_DAEMON_TEST_EXPLICIT_KEY: explicitKey } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child.pid) throw new Error(`重复启动测试未获得 ${mode} 命令 PID`);
    managedPids.add(child.pid);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
    child.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
    return child;
  };

  const recoveryStart = runStart("plain");
  const recoveryClosed = await waitForChildClose(recoveryStart, 12_000);
  assert.equal(recoveryClosed.code, 0, diagnostics);
  const firstSupervisorClosed = await waitForChildClose(supervisor, 5000);
  assert.equal(firstSupervisorClosed.code, 0, diagnostics);
  const recovered = await waitForDaemonState(
    statePath,
    (state) => Number(state.supervisorPid) > 0
      && Number(state.supervisorPid) !== supervisor.pid
      && Number(state.clientPid) > 0,
    5000,
    () => diagnostics,
  );
  const recoveredSupervisorPid = Number(recovered.supervisorPid);
  const recoveredClientPid = Number(recovered.clientPid);
  managedPids.add(recoveredSupervisorPid);
  managedPids.add(recoveredClientPid);
  assert.equal(Number(fs.readFileSync(counterPath, "utf8")), 2);

  const plainStart = runStart("plain");
  const plainClosed = await waitForChildClose(plainStart, 5000);
  assert.equal(plainClosed.code, 0, diagnostics);
  const reused = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  assert.equal(Number(reused.supervisorPid), recoveredSupervisorPid);
  assert.equal(Number(reused.clientPid), recoveredClientPid);
  assert.equal(Number(fs.readFileSync(counterPath, "utf8")), 2);

  const keyStart = runStart("key");
  const keyClosed = await waitForChildClose(keyStart, 12_000);
  assert.equal(keyClosed.code, 0, diagnostics);

  const replaced = await waitForDaemonState(
    statePath,
    (state) => Number(state.supervisorPid) > 0
      && Number(state.supervisorPid) !== recoveredSupervisorPid
      && Number(state.clientPid) > 0
      && Number(state.clientPid) !== recoveredClientPid,
    5000,
    () => diagnostics,
  );
  const replacementSupervisorPid = Number(replaced.supervisorPid);
  const replacementClientPid = Number(replaced.clientPid);
  managedPids.add(replacementSupervisorPid);
  managedPids.add(replacementClientPid);
  assert.equal(Number(fs.readFileSync(counterPath, "utf8")), 3);
  assert.equal(diagnostics.includes(explicitKey), false);
  assert.equal(fs.readFileSync(statePath, "utf8").includes(explicitKey), false);

  const stopProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: { ...fixtureEnv, CODEFLOWAI_DAEMON_TEST_STOP: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!stopProcess.pid) throw new Error("重复启动测试 stop 进程未获得 PID");
  managedPids.add(stopProcess.pid);
  stopProcess.stdout?.setEncoding("utf8");
  stopProcess.stderr?.setEncoding("utf8");
  stopProcess.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
  stopProcess.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
  const stopClosed = await waitForChildClose(stopProcess, 7000);
  assert.equal(stopClosed.code, 0, diagnostics);
  cleanupNeeded = false;
  assert.equal(isTestProcessRunning(replacementSupervisorPid), false);
  assert.equal(isTestProcessRunning(replacementClientPid), false);
  assert.equal(fs.existsSync(statePath), false);
});

test("explicit key startup records initial handshake failure and does not retry", { timeout: 10_000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const counterPath = path.join(tempDir, "attempt.txt");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const supervisorEntryPath = fileURLToPath(new URL("../../apps/desktop/client/src/clientDaemonSupervisor.ts", import.meta.url));
  const explicitKey = "codeflowai_test_key_never_logged";
  const supervisor = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    supervisorEntryPath,
    "--foreground",
    "--key",
    explicitKey,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
      CODEFLOWAI_DAEMON_TEST_COUNTER_PATH: counterPath,
      CODEFLOWAI_DAEMON_TEST_INITIAL_CONNECTION_OUTCOME: "failed",
      CODEFLOWAI_DAEMON_SUPERVISOR: "1",
      CODEFLOWAI_DAEMON_WORKER_ENTRY: fixturePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!supervisor.pid) throw new Error("显式 key 失败测试未获得 supervisor PID");
  let output = "";
  supervisor.stdout?.setEncoding("utf8");
  supervisor.stderr?.setEncoding("utf8");
  supervisor.stdout?.on("data", (chunk) => { output += String(chunk); });
  supervisor.stderr?.on("data", (chunk) => { output += String(chunk); });
  t.after(async () => {
    if (supervisor.exitCode == null && supervisor.pid) forceKillTestProcess(supervisor.pid);
    await waitForChildClose(supervisor, 2000).catch(() => undefined);
  });

  const closed = await waitForChildClose(supervisor, 7000);
  assert.equal(closed.code, 1, output);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  assert.equal(state.initialConnection, "failed");
  assert.equal(Number(fs.readFileSync(counterPath, "utf8")), 1);
  assert.equal(output.includes(explicitKey), false);
});

test("plain startup returns nonzero when the first worker enters blocked state", { timeout: 12_000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const counterPath = path.join(tempDir, "attempt.txt");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
    CODEFLOWAI_DAEMON_TEST_COUNTER_PATH: counterPath,
    CODEFLOWAI_DAEMON_TEST_BLOCKED: "1",
    CODEFLOWAI_DAEMON_TEST_START_MODE: "plain",
  };
  fs.mkdirSync(daemonDir, { recursive: true });
  const start = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: fixtureEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!start.pid) throw new Error("普通启动 blocked 测试未获得进程 PID");
  const managedPids = new Set<number>([start.pid]);
  let output = "";
  start.stdout?.setEncoding("utf8");
  start.stderr?.setEncoding("utf8");
  start.stdout?.on("data", (chunk) => { output += String(chunk); });
  start.stderr?.on("data", (chunk) => { output += String(chunk); });
  t.after(async () => {
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
      const supervisorPid = Number(state.supervisorPid ?? 0);
      const clientPid = Number(state.clientPid ?? 0);
      if (supervisorPid > 0) managedPids.add(supervisorPid);
      if (clientPid > 0) managedPids.add(clientPid);
    }
    for (const pid of managedPids) forceKillTestProcess(pid);
    await waitForChildClose(start, 2000).catch(() => undefined);
  });

  const closed = await waitForChildClose(start, 10_000);
  assert.equal(closed.code, 1, output);
  assert.match(output, /后台 Client 启动失败 status=blocked/u);
  assert.equal(output.includes("已在后台守护启动"), false);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  assert.equal(state.status, "blocked");
  assert.equal(Number(fs.readFileSync(counterPath, "utf8")), 1);
});

test("explicit key startup records initial handshake success", { timeout: 10_000 }, async (t) => {
  const tempDir = createTempDir(t);
  const homeDir = path.join(tempDir, "home");
  const daemonDir = path.join(homeDir, ".codeflowai");
  const statePath = path.join(daemonDir, "client-daemon.json");
  const counterPath = path.join(tempDir, "attempt.txt");
  const fixturePath = fileURLToPath(new URL("../fixtures/client-daemon-supervisor-fixture.ts", import.meta.url));
  const supervisorEntryPath = fileURLToPath(new URL("../../apps/desktop/client/src/clientDaemonSupervisor.ts", import.meta.url));
  const explicitKey = "codeflowai_test_key_success_not_logged";
  const fixtureEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CODEFLOWAI_CLIENT_LOG_DIR: path.join(daemonDir, "logs"),
    CODEFLOWAI_DAEMON_TEST_COUNTER_PATH: counterPath,
    CODEFLOWAI_DAEMON_TEST_INITIAL_CONNECTION_OUTCOME: "succeeded",
    CODEFLOWAI_DAEMON_TEST_STAY_RUNNING: "1",
    CODEFLOWAI_DAEMON_SUPERVISOR: "1",
    CODEFLOWAI_DAEMON_WORKER_ENTRY: fixturePath,
  };
  const supervisor = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    supervisorEntryPath,
    "--foreground",
    "--key",
    explicitKey,
  ], {
    cwd: process.cwd(),
    env: fixtureEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!supervisor.pid) throw new Error("显式 key 成功测试未获得 supervisor PID");
  let output = "";
  supervisor.stdout?.setEncoding("utf8");
  supervisor.stderr?.setEncoding("utf8");
  supervisor.stdout?.on("data", (chunk) => { output += String(chunk); });
  supervisor.stderr?.on("data", (chunk) => { output += String(chunk); });
  t.after(async () => {
    if (supervisor.exitCode == null && supervisor.pid) forceKillTestProcess(supervisor.pid);
    await waitForChildClose(supervisor, 2000).catch(() => undefined);
  });

  const state = await waitForDaemonState(
    statePath,
    (value) => value.initialConnection === "succeeded" && Number(value.clientPid) > 0,
    7000,
    () => output,
  );
  assert.equal(state.initialConnection, "succeeded");
  assert.equal(Number(fs.readFileSync(counterPath, "utf8")), 1);
  assert.equal(output.includes(explicitKey), false);

  const stopProcess = spawn(process.execPath, [
    "--conditions=development",
    "--import",
    "tsx",
    fixturePath,
  ], {
    cwd: process.cwd(),
    env: { ...fixtureEnv, CODEFLOWAI_DAEMON_TEST_STOP: "1" },
    stdio: "ignore",
    windowsHide: true,
  });
  const stopClosed = await waitForChildClose(stopProcess, 7000);
  assert.equal(stopClosed.code, 0);
  const supervisorClosed = await waitForChildClose(supervisor, 5000);
  assert.equal(supervisorClosed.code, 0, output);
});

type TestDaemonState = Record<string, unknown>;

/** 轮询临时 HOME 下的 daemon 状态，直到命中断言或超时。 */
async function waitForDaemonState(
  statePath: string,
  predicate: (state: TestDaemonState) => boolean,
  timeoutMs: number,
  diagnostics: () => string,
): Promise<TestDaemonState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as TestDaemonState;
      if (predicate(state)) return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待 daemon 状态超时：${statePath}\n${diagnostics()}`);
}

/** 等待测试子进程关闭，并在超时时显式失败。 */
function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待进程退出超时 pid=${child.pid ?? "null"}`)), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** 强制清理测试创建的临时进程；已退出按幂等成功处理。 */
function forceKillTestProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (typeof error === "object" && error != null && (error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
}

function isTestProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error != null && (error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function createTempDir(t: TestContext): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-daemon-test-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}
