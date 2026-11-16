import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import { formatWorkspaceLogEntry, writeWorkspaceLogFile } from "../src/logger.js";
import { resolveCodeFlowNodeLogPolicy } from "@codeflowai/shared/node-logger";

const loggerFile = fileURLToPath(new URL("../src/logger.ts", import.meta.url));

for (const desktop of [false, true]) test(`exit flush persists buffered and subsequent writes: desktop=${desktop}`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-client-logger-"));
  try {
    const script = `
      const fs = await import("node:fs");
      const { createRequire } = await import("node:module");
      const vm = await import("node:vm");
      const { transformSync } = await import("esbuild");
      const shared = await import("@codeflowai/shared/node-logger");
      const require = createRequire(${JSON.stringify(loggerFile)});
      const code = transformSync(fs.readFileSync(${JSON.stringify(loggerFile)}, "utf8"), { loader: "ts", format: "cjs" }).code;
      const module = { exports: {} };
      vm.runInNewContext(code, { process, module, exports: module.exports,
        require: name => name === "@codeflowai/shared/node-logger" ? shared : require(name) });
      const { logger, flushClientLogger } = module.exports;
      for (let i = 0; i < 120; i++) logger.info("exit-test", "shutdown prefix", { i });
      await new Promise(resolve => setImmediate(resolve));
      const pending = flushClientLogger();
      for (let i = 0; i < 120; i++) logger.info("exit-test", "late diagnostics", { i });
      const timer = setTimeout(() => { console.error("CLIENT_LOG_FLUSH_TEST_TIMEOUT"); process.exit(2); }, 1500);
      await pending;
      await flushClientLogger();
      clearTimeout(timer);
      process.exit(0);
    `;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_")));
    const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-"], {
      input: script, env: { ...env, CODEFLOWAI_CLIENT_LOG_DIR: directory,
        ...(desktop ? { CODEFLOWAI_DESKTOP_REQUEST_ID: "logger-startup-test" } : {}) }, cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8", windowsHide: true, timeout: 5_000, killSignal: "SIGKILL",
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const files = (await fs.readdir(directory)).filter(name => name.endsWith(".log"));
    const lines = (await Promise.all(files.map(name => fs.readFile(path.join(directory, name), "utf8")))).join("").trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(lines.filter(line => line.message === "shutdown prefix").length, 120);
    assert.deepEqual(lines.filter(line => line.message === "shutdown prefix").map(line => line.i), Array.from({ length: 120 }, (_, i) => i));
    assert.deepEqual(lines.filter(line => line.message === "late diagnostics").map(line => line.i), Array.from({ length: 120 }, (_, i) => i));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

/** 在真实 logger 模块入口注入失败 transport，验证退出刷写不吞错误或伪造成功。 */
async function loggerWithTransport(transport: object, destinationWrites?: number) {
  const source = await fs.readFile(loggerFile, "utf8");
  const code = transformSync(source, { loader: "ts", format: "cjs" }).code;
  const require = createRequire(loggerFile);
  const pino = require("pino");
  const shared = await import("@codeflowai/shared/node-logger");
  let clientOptions: Parameters<typeof shared.createCodeFlowNodeLogger>[0] | undefined;
  const module = { exports: {} as { flushClientLogger(): Promise<void>; formatWorkspaceLogEntry: typeof formatWorkspaceLogEntry } };
  vm.runInNewContext(code, { module, exports: module.exports, process, console,
    require(name: string) {
      if (name === "@codeflowai/shared/node-logger") return { ...shared, createCodeFlowNodeLogger: (options: Parameters<typeof shared.createCodeFlowNodeLogger>[0]) => {
        if (options.destination) {
          const destination = options.destination;
          return shared.createCodeFlowNodeLogger({ ...options, destination: { write(line) {
            for (let index = 0; index < (destinationWrites ?? 1); index++) destination.write(line);
          } } });
        }
        clientOptions = options;
        return { [pino.symbols.streamSym]: transport, flush: (callback: (error?: Error) => void) => callback() };
      } };
      return require(name);
    },
  }, { filename: loggerFile });
  return { ...module.exports, clientOptions };
}

test("only desktop Client enables nonblocking logger startup", async t => {
  const previous = process.env.CODEFLOWAI_DESKTOP_REQUEST_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEFLOWAI_DESKTOP_REQUEST_ID;
    else process.env.CODEFLOWAI_DESKTOP_REQUEST_ID = previous;
  });
  delete process.env.CODEFLOWAI_DESKTOP_REQUEST_ID;
  assert.equal((await loggerWithTransport({})).clientOptions?.bufferUntilReady, false);
  process.env.CODEFLOWAI_DESKTOP_REQUEST_ID = "logger-startup-test";
  assert.equal((await loggerWithTransport({})).clientOptions?.bufferUntilReady, true);
});

test("exit flush rejects a transport write failure", async () => {
  const cause = new Error("DISK_WRITE_FAILED");
  const logger = await loggerWithTransport({ destroyed: false, flushSync() { throw cause; } });
  await assert.rejects(logger.flushClientLogger(), error => error === cause);
});

test("exit flush rejects an already failed transport", async () => {
  const cause = new Error("WORKER_FAILED");
  const logger = await loggerWithTransport({ destroyed: true, writableErrored: cause,
    flushSync() { assert.fail("failed transport cannot be treated as flushed"); } });
  await assert.rejects(logger.flushClientLogger(), error => error === cause);
});

/** 隔离固定写入参数及真实文件；所有自有资源由被测同步边界关闭。 */
function workspaceLogs(t: test.TestContext, settings: Record<string, string> = {}) {
  const directory = fsSync.mkdtempSync(path.join(os.tmpdir(), "workspace-logger-"));
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) if (/^CODEFLOWAI_(?:CLIENT_)?LOG_/.test(key) && !key.endsWith("LOG_DIR")) delete process.env[key];
  Object.assign(process.env, settings);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    fsSync.rmSync(directory, { recursive: true, force: true });
  });
  const names = () => fsSync.existsSync(path.join(directory, ".codeflowai")) ? fsSync.readdirSync(path.join(directory, ".codeflowai")).filter(name => name.endsWith(".log")).sort() : [];
  return { directory, names, write: (line = '{"message":"中文🙂"}\n') => writeWorkspaceLogFile(directory, line, () => { assert.fail("healthy write cannot report unconfirmed close"); }) };
}

test("workspace formatter uses original pino redaction, level filtering and a complete UTF-8 line", () => {
  const line = formatWorkspaceLogEntry({ level: "error", tag: "prefs", message: "中文🙂\n下一行", data: { password: "private", error: new Error("problem") } });
  assert.ok(line); assert.equal(line.split("\n").length, 2);
  assert.equal(JSON.parse(line).message, "中文🙂\n下一行"); assert.equal(JSON.parse(line).password, "[REDACTED]");
  assert.equal(JSON.parse(line).error.message, "problem");
});

for (const outputs of [0, 2]) {
  test(`workspace formatter rejects enabled output count ${outputs}`, async () => {
    const logger = await loggerWithTransport({}, outputs);
    assert.throws(() => logger.formatWorkspaceLogEntry({ level: "error", tag: "prefs", message: "one-line" }), /WORKSPACE_LOG_FORMAT_INVALID/);
  });
}

test("workspace size interpretation matches finite pino-roll values and rejects malformed capacity", () => {
  const require = createRequire(loggerFile), { parseSize } = require("pino-roll/lib/utils.js");
  const key = "WORKSPACE_LOG_TEST_SIZE", previous = process.env[key];
  try {
    for (const size of ["50m", "1", "1k", "2G", "42b", "1q", "0", ".5m", "1.m"]) {
      process.env[key] = size;
      assert.equal(resolveCodeFlowNodeLogPolicy({ defaultLogDir: "", defaultLogFile: "", env: {
        levelKeys: [], logDirKeys: [], logFileKeys: [], rotateFrequencyKeys: [], rotateSizeKeys: [key], retentionCountKeys: [],
      } }).sizeBytes, parseSize(size));
    }
    for (const size of ["1..2m", "Infinity", "1e309", "-1b"]) {
      process.env[key] = size;
      assert.throws(() => resolveCodeFlowNodeLogPolicy({ defaultLogDir: "", defaultLogFile: "", env: {
        levelKeys: [], logDirKeys: [], logFileKeys: [], rotateFrequencyKeys: [], rotateSizeKeys: [key], retentionCountKeys: [],
      } }), /Invalid log rotate size/);
    }
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});

test("workspace policy retains Client key precedence and ignores application DIR and FILE", t => {
  const f = workspaceLogs(t, { CODEFLOWAI_LOG_LEVEL: "fatal", CODEFLOWAI_CLIENT_LOG_LEVEL: "error",
    CODEFLOWAI_LOG_ROTATE_SIZE: "999m", CODEFLOWAI_CLIENT_LOG_ROTATE_SIZE: "1b",
    CODEFLOWAI_LOG_RETENTION_COUNT: "7", CODEFLOWAI_CLIENT_LOG_RETENTION_COUNT: "1",
    CODEFLOWAI_CLIENT_LOG_DIR: path.join(os.tmpdir(), "must-not-create-workspace-log-here"), CODEFLOWAI_CLIENT_LOG_FILE: "ignored.log" });
  const line = formatWorkspaceLogEntry({ level: "error", tag: "prefs", message: "selected-client-key" });
  assert.ok(line);
  f.write(line); f.write(line); f.write(line);
  assert.equal(f.names().length, 2); assert.ok(f.names().every(name => /^client-\d{8}\.[1-9]\d*\.log$/.test(name)));
});

for (const frequency of ["daily", "hourly", "60000"]) {
  test(`workspace ${frequency} rotation reuses current mtime bucket and advances old bucket`, t => {
    const now = new Date(2026, 9, 29, 12, 30, 15);
    t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });
    const f = workspaceLogs(t, { CODEFLOWAI_CLIENT_LOG_ROTATE_FREQUENCY: frequency, CODEFLOWAI_CLIENT_LOG_ROTATE_SIZE: "0" });
    const directory = path.join(f.directory, ".codeflowai"); fsSync.mkdirSync(directory);
    const file = path.join(directory, "client-20261029.1.log"); fsSync.writeFileSync(file, "first\n");
    fsSync.utimesSync(file, now, now); f.write("second\n"); assert.equal(f.names().length, 1);
    const old = new Date(now.getTime() - (frequency === "daily" ? 86400000 : frequency === "hourly" ? 3600000 : 60000));
    fsSync.utimesSync(file, old, old); f.write("third\n");
    assert.deepEqual(f.names(), ["client-20261029.1.log", "client-20261029.2.log"]);
    assert.equal(fsSync.readFileSync(file, "utf8"), "first\nsecond\n");
  });
}

test("workspace full lines rotate by UTF-8 bytes and oversized lines remain whole", t => {
  const f = workspaceLogs(t, { CODEFLOWAI_CLIENT_LOG_ROTATE_SIZE: "8b", CODEFLOWAI_CLIENT_LOG_ROTATE_FREQUENCY: "daily" });
  f.write("中🙂\n"); f.write("complete oversized line🙂\n"); f.write("last\n");
  assert.equal(f.names().length, 3);
  assert.deepEqual(f.names().map(name => fsSync.readFileSync(path.join(f.directory, ".codeflowai", name), "utf8")), ["中🙂\n", "complete oversized line🙂\n", "last\n"]);
});

test("workspace count and calendar days clean only strict names after a completed write", t => {
  const now = new Date(2026, 9, 29, 12);
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  const f = workspaceLogs(t, { CODEFLOWAI_CLIENT_LOG_ROTATE_SIZE: "1b", CODEFLOWAI_CLIENT_LOG_RETENTION_COUNT: "1", CODEFLOWAI_CLIENT_LOG_RETENTION_DAYS: "2" });
  const directory = path.join(f.directory, ".codeflowai"); fsSync.mkdirSync(directory);
  const originals = ["client-20261027.1.log", "client-20261028.1.log", "client-20261029.1.log", "client-20261029.01.log", "client-20261301.1.log", "other.log"];
  for (const name of originals) { const file = path.join(directory, name); fsSync.writeFileSync(file, "old\n"); fsSync.utimesSync(file, now, now); }
  f.write("new\n");
  assert.deepEqual(f.names(), ["client-20261029.01.log", "client-20261029.1.log", "client-20261029.2.log", "client-20261301.1.log", "other.log"]);
});

test("workspace short writes finish remaining UTF-8 bytes before fsync and close", t => {
  const f = workspaceLogs(t), original = fsSync.writeSync;
  let calls = 0;
  t.mock.method(fsSync, "writeSync", ((fd: number, buffer: Buffer, offset: number, length: number) => {
    calls++; return original(fd, buffer, offset, Math.min(length, 2));
  }) as typeof fsSync.writeSync);
  f.write(); assert.ok(calls > 2);
  assert.equal(fsSync.readFileSync(path.join(f.directory, ".codeflowai", f.names()[0]!), "utf8"), '{"message":"中文🙂"}\n');
});

for (const phase of ["open", "zero", "write", "verify", "fsync", "close", "cleanup"] as const) {
  test(`workspace ${phase} failure is explicit and does not continue later side effects`, t => {
    const f = workspaceLogs(t, { CODEFLOWAI_CLIENT_LOG_ROTATE_SIZE: "1b", CODEFLOWAI_CLIENT_LOG_RETENTION_COUNT: "1" });
    f.write("old\n"); f.write("older\n");
    const failure = new Error(`${phase}-failure`), originalOpen = fsSync.openSync, originalClose = fsSync.closeSync, originalStat = fsSync.fstatSync;
    let logFd: number | undefined, closeCount = 0, notifications = 0, deletions = 0;
    t.mock.method(fsSync, "openSync", ((...args: Parameters<typeof fsSync.openSync>) => {
      if (phase === "open" && String(args[0]).endsWith(".log")) throw failure;
      const fd = originalOpen(...args); if (String(args[0]).endsWith(".log")) logFd = fd; return fd;
    }) as typeof fsSync.openSync);
    t.mock.method(fsSync, "closeSync", (fd: number) => { originalClose(fd); if (fd === logFd) { closeCount++; if (phase === "close") throw failure; } });
    const unlink = fsSync.unlinkSync;
    t.mock.method(fsSync, "unlinkSync", (file: fsSync.PathLike) => { deletions++; if (phase === "cleanup") throw failure; unlink(file); });
    if (phase === "write" || phase === "zero") t.mock.method(fsSync, "writeSync", (() => { if (phase === "zero") return 0; throw failure; }) as typeof fsSync.writeSync);
    if (phase === "fsync") t.mock.method(fsSync, "fsyncSync", () => { throw failure; });
    if (phase === "verify") {
      let checks = 0;
      t.mock.method(fsSync, "fstatSync", ((...args: Parameters<typeof fsSync.fstatSync>) => { if (args[0] === logFd && ++checks === 2) throw failure; return originalStat(...args); }) as typeof fsSync.fstatSync);
    }
    assert.throws(() => writeWorkspaceLogFile(f.directory, "new\n", () => { notifications++; }), phase === "zero" ? /WORKSPACE_LOG_WRITE_NO_PROGRESS/ : error => error === failure);
    assert.equal(closeCount, phase === "open" ? 0 : 1); assert.equal(notifications, phase === "close" ? 1 : 0);
    assert.equal(deletions, phase === "cleanup" ? 1 : 0);
  });
}

test("workspace write plus close and notification failures retain exact causes in order", t => {
  const f = workspaceLogs(t), originalClose = fsSync.closeSync;
  const writeFailure = false, closeFailure = undefined, notifyFailure = new Error("notification-failed");
  t.mock.method(fsSync, "writeSync", (() => { throw writeFailure; }) as typeof fsSync.writeSync);
  t.mock.method(fsSync, "closeSync", (fd: number) => { originalClose(fd); throw closeFailure; });
  assert.throws(() => writeWorkspaceLogFile(f.directory, "new\n", (_phase, combined) => {
    assert.ok(combined instanceof AggregateError); assert.deepEqual(combined.errors, [writeFailure, closeFailure]); throw notifyFailure;
  }), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [writeFailure, closeFailure, notifyFailure]); assert.equal(error.cause, writeFailure); return true;
  });
});

test("workspace fsync and close double failure retains both causes and never cleans old logs", t => {
  const f = workspaceLogs(t), close = fsSync.closeSync;
  const primary = new Error("fsync-failed"), secondary = new Error("close-failed");
  let notified: unknown, deleted = 0;
  t.mock.method(fsSync, "fsyncSync", () => { throw primary; });
  t.mock.method(fsSync, "closeSync", (fd: number) => { close(fd); throw secondary; });
  t.mock.method(fsSync, "unlinkSync", () => { deleted++; });
  assert.throws(() => writeWorkspaceLogFile(f.directory, "line\n", (_phase, error) => { notified = error; }), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [primary, secondary]); assert.equal(error.cause, primary); return true;
  });
  assert.ok(notified instanceof AggregateError); assert.deepEqual(notified.errors, [primary, secondary]); assert.equal(deleted, 0);
});

test("workspace format filtering and invalid capacity have zero workspace file effects", t => {
  const f = workspaceLogs(t, { CODEFLOWAI_CLIENT_LOG_LEVEL: "fatal", CODEFLOWAI_CLIENT_LOG_ROTATE_SIZE: "1..2m" });
  assert.equal(formatWorkspaceLogEntry({ level: "error", tag: "prefs", message: "filtered" }), undefined);
  assert.throws(() => f.write(), /Invalid log rotate size/);
  assert.equal(fsSync.existsSync(path.join(f.directory, ".codeflowai")), false);
});
