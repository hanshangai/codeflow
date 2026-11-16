import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";
import type { CodeFlowNodeLogger, CreateCodeFlowNodeLoggerOptions } from "../../packages/shared/src/nodeLogger.ts";

/** Loads the real factory with one destination seam while retaining real pino methods. */
function factoryWithTransport(transport: object, options?: Partial<CreateCodeFlowNodeLoggerOptions>) {
  const require = createRequire(new URL("../../packages/shared/package.json", import.meta.url));
  const pino = require("pino");
  let sync: unknown;
  const controlledPino = Object.assign((...args: unknown[]) => pino(...args), pino, {
    transport(options: { sync?: boolean }) { sync = options.sync; return transport; },
  });
  const source = stripTypeScriptTypes(fs.readFileSync(new URL("../../packages/shared/src/nodeLogger.ts", import.meta.url), "utf8"))
    .replace('import fs from "node:fs";', 'const fs = require("node:fs");')
    .replace('import path from "node:path";', 'const path = require("node:path");')
    .replace('import pino from "pino";', 'const pino = require("pino");')
    .replaceAll("export function ", "function ");
  const create = new Function("require", source + "\nreturn createCodeFlowNodeLogger;")(
    (name: string) => name === "pino" ? controlledPino : require(name),
  ) as (options: CreateCodeFlowNodeLoggerOptions) => CodeFlowNodeLogger;
  const logger = create({ defaultLogDir: os.tmpdir(), defaultLogFile: "unused.log",
    env: { levelKeys: [], logDirKeys: [], logFileKeys: [], rotateFrequencyKeys: [], rotateSizeKeys: [], retentionCountKeys: [] }, ...options });
  const stream = (logger as unknown as Record<symbol, { flushSync(): void }>)[pino.symbols.streamSym]!;
  return { logger, sync, stream };
}

/** 清理受控 transport 未发 ready 时留下的本次退出监听，避免污染测试进程。 */
function bufferedFactory(t: test.TestContext, transport: object) {
  const previous = new Set(process.rawListeners("exit"));
  t.after(() => {
    for (const listener of process.rawListeners("exit")) {
      if (!previous.has(listener)) process.removeListener("exit", listener);
    }
  });
  return factoryWithTransport(transport, { bufferUntilReady: true });
}

test("trusted synchronous destination preserves pino format and has zero path or transport effects", t => {
  const writes: string[] = [];
  for (const name of ["existsSync", "readdirSync", "mkdirSync", "unlinkSync"] as const) {
    t.mock.method(fs, name, () => { assert.fail(`${name} must not run for trusted destination`); });
  }
  const { logger, sync } = factoryWithTransport({ write() { assert.fail("transport must not run"); } }, {
    defaultLogDir: "\0unsafe", defaultLogFile: "\0unsafe", destination: { write: line => { writes.push(line); } },
  });
  const child = logger.child({ module: "工作区" });
  child.info({ password: "secret", error: new Error("failure"), requestId: "同步" }, "中文🙂\n整行");
  child.debug("filtered");
  assert.equal(sync, undefined); assert.equal(writes.length, 1);
  assert.equal(writes[0]!.split("\n").length, 2);
  const row = JSON.parse(writes[0]!);
  assert.equal(row.level, "INFO"); assert.equal(row.module, "工作区"); assert.equal(row.password, "[REDACTED]");
  assert.equal(row.message, "中文🙂\n整行"); assert.match(row.time, /^\d{4}-\d{2}-\d{2} /); assert.equal(row.error.message, "failure");
});

test("trusted destination preserves the exact synchronous write error", () => {
  const failure = false;
  const { logger } = factoryWithTransport({}, { destination: { write() { throw failure; } } });
  let thrown = false;
  try { logger.info("fail"); } catch (error) { thrown = true; assert.equal(error, failure); }
  assert.equal(thrown, true);
});

/** Models only the public destination state and records unchanged pino output. */
function publicTransport() {
  return Object.assign(new EventEmitter(), {
    ready: false, destroyed: false, closed: false, writable: true, writableErrored: null as unknown,
    writes: [] as string[], flushes: 0,
    /** Records writes while allowing failure cases to report backpressure. */
    write(value: string): boolean { this.writes.push(value); return true; },
    flushSync() { this.flushes += 1; },
    flush(callback: (error?: Error) => void) { callback(); },
    ref() {}, unref() {},
  });
}

test("buffered startup returns before transport initialization and preserves formatted log snapshots", t => {
  const transport = publicTransport();
  transport.flushSync = () => { assert.fail("startup logging must not wait for the worker"); };
  const { logger } = bufferedFactory(t, transport);
  const child = logger.child({ module: "startup-child" }).child({ component: "nested" });
  const payload = { sequence: 1, password: "secret", value: "original" };
  logger.info(payload, "启动甲🙂");
  payload.value = "changed";
  child.warn({ sequence: 2 }, "启动乙🚀");
  logger.debug("filtered");
  assert.deepEqual(transport.writes, []);
  transport.flushSync = function () { this.flushes += 1; };
  transport.ready = true;
  transport.emit("ready");
  child.error({ sequence: 3 }, "ready");
  const rows = transport.writes.map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.sequence), [1, 2, 3]);
  assert.equal(rows[0].value, "original");
  assert.equal(rows[0].password, "[REDACTED]");
  assert.equal(rows[0].message, "启动甲🙂");
  assert.equal(rows[1].component, "nested");
  assert.equal(rows[1].module, "startup-child");
});

test("explicit flush drains buffered startup before worker readiness", t => {
  const transport = publicTransport();
  const { logger, stream } = bufferedFactory(t, transport);
  logger.info({ sequence: 1 }, "startup");
  assert.equal(transport.writes.length, 0);
  stream.flushSync();
  assert.equal(transport.flushes, 1);
  assert.equal(JSON.parse(transport.writes[0]).sequence, 1);
  transport.ready = true;
  transport.emit("ready");
  logger.info({ sequence: 2 }, "ready");
  assert.deepEqual(transport.writes.map(line => JSON.parse(line).sequence), [1, 2]);
});

test("buffered startup preserves order while the ready destination is still opening", t => {
  const transport = publicTransport();
  let opened!: (error?: Error) => void;
  transport.flush = callback => { opened = callback; };
  const previous = new Set(process.rawListeners("exit"));
  const { logger } = bufferedFactory(t, transport);
  logger.info({ sequence: 1 }, "before-ready");
  transport.ready = true;
  transport.emit("ready");
  logger.info({ sequence: 2 }, "before-open");
  assert.equal(transport.writes.length, 0);
  assert.equal(process.rawListeners("exit").filter(listener => !previous.has(listener)).length, 1);
  opened();
  assert.ok(process.rawListeners("exit").every(listener => previous.has(listener)));
  logger.info({ sequence: 3 }, "after-open");
  assert.deepEqual(transport.writes.map(line => JSON.parse(line).sequence), [1, 2, 3]);
});

test("initialization confirmation keeps an overlapping explicit flush alive until its callback", t => {
  const transport = publicTransport();
  const callbacks: Array<(error?: Error) => void> = [];
  let held = false, completed = false;
  transport.ref = () => { held = true; };
  transport.unref = () => { held = false; };
  transport.flush = callback => { callbacks.push(callback); };
  const { logger } = bufferedFactory(t, transport);
  logger.info("buffered");
  transport.ready = true;
  transport.emit("ready");
  logger.flush(() => { completed = true; });
  callbacks[0]!();
  assert.equal(completed, false);
  assert.equal(held, true, "显式刷写确认前不能释放日志线程保活");
  callbacks[1]!();
  assert.equal(completed, true);
  assert.equal(held, false);
});

test("buffered startup rejects known failures before enqueueing and preserves flush errors", t => {
  const transport = publicTransport();
  const { logger, stream } = bufferedFactory(t, transport);
  logger.info("buffered");
  const cause = new Error("WORKER_FAILED");
  transport.writableErrored = cause;
  assert.throws(() => logger.info("must fail"), error => error === cause);
  assert.throws(() => stream.flushSync(), error => error === cause);
  assert.equal(transport.writes.length, 0);
});

test("buffered startup preserves a failure exposed while draining", t => {
  const transport = publicTransport();
  const { logger, stream } = bufferedFactory(t, transport);
  logger.info("buffered");
  transport.write = function (line: string) { this.writes.push(line); this.writableErrored = false; return false; };
  let thrown = false;
  try { stream.flushSync(); } catch (error) { thrown = true; assert.equal(error, false); }
  assert.equal(thrown, true);
  assert.equal(transport.flushes, 0);
  assert.equal(transport.writes.length, 1);
});

test("startup calls flush real pino output once while ready calls and filtered calls do not", () => {
  const transport = publicTransport();
  const { logger, sync } = factoryWithTransport(transport);
  const child = logger.child({ module: "startup-child" });
  child.level = "warn";
  const nested = child.child({ component: "nested" });
  logger.info({ sequence: 1 }, "启动甲🙂");
  child.warn({ sequence: 2 }, "启动乙🚀");
  nested.error({ sequence: 3 }, "启动丙🙂");
  logger.debug("filtered-root");
  child.info("filtered-child");
  assert.equal(sync, true);
  assert.equal(transport.flushes, 3);
  transport.ready = true;
  logger.info({ sequence: 4 }, "ready root");
  child.warn({ sequence: 5 }, "ready child");
  nested.error({ sequence: 6 }, "ready nested");
  assert.equal(transport.flushes, 3);
  assert.deepEqual(transport.writes.map(line => JSON.parse(line).sequence), [1, 2, 3, 4, 5, 6]);
  assert.equal(JSON.parse(transport.writes[2]).component, "nested");
});

for (const ready of [false, true]) {
  test(`known transport failure is thrown before any pino write: ready=${ready}`, () => {
    const transport = publicTransport();
    transport.ready = ready;
    const cause = Object.freeze(new Error("DESTINATION_FAILED", { cause: false }));
    transport.writableErrored = cause;
    transport.destroyed = true;
    const { logger } = factoryWithTransport(transport);
    assert.throws(() => logger.info("must not write"), error => error === cause);
    assert.equal(transport.writes.length, 0);
    assert.equal(transport.flushes, 0);
  });
}

test("startup observes a destination failure after the original write and preserves it", () => {
  const transport = publicTransport();
  const cause = Object.freeze(new Error("WRITE_FAILED"));
  transport.write = function (value: string) { this.writes.push(value); this.writableErrored = cause; return false; };
  const { logger } = factoryWithTransport(transport);
  assert.throws(() => logger.info("write failed"), error => error === cause);
  assert.equal(transport.writes.length, 1);
  assert.equal(transport.flushes, 0);
});

for (const [field, value, code] of [["destroyed", true, "DESTROYED"], ["closed", true, "CLOSED"], ["writable", false, "NOT_WRITABLE"]] as const) {
  test(`public ${field} failure rejects before write without an original error`, () => {
    const transport = publicTransport();
    transport.ready = true;
    transport[field] = value;
    const { logger } = factoryWithTransport(transport);
    assert.throws(() => logger.info("must not write"), new RegExp(`NODE_LOG_TRANSPORT_${code}`));
    assert.equal(transport.writes.length, 0);
  });
}

test("startup rethrows the exact synchronous flush failure", () => {
  const transport = publicTransport();
  transport.flushSync = () => { throw false; };
  const { logger } = factoryWithTransport(transport);
  let thrown = false;
  try { logger.info("flush fails"); } catch (error) { thrown = true; assert.equal(error, false); }
  assert.equal(thrown, true);
  assert.equal(transport.writes.length, 1);
});

test("startup observes an error exposed by flush and preserves falsy transport errors", () => {
  const transport = publicTransport();
  transport.flushSync = function () { this.flushes += 1; this.writableErrored = false; };
  const { logger } = factoryWithTransport(transport);
  for (const sequence of [1, 2]) {
    let thrown = false;
    try { logger.info({ sequence }, "failed transport"); } catch (error) { thrown = true; assert.equal(error, false); }
    assert.equal(thrown, true);
  }
  assert.equal(transport.writes.length, 1);
  assert.equal(transport.flushes, 1);
});

for (const level of ["info", "debug"]) {
  test(`共享日志真实落盘、级别过滤与敏感信息脱敏：${level}`, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-node-logger-"));
    // 独立进程覆盖 transport worker 初始化和关闭，避免测试间共享日志或环境变量。
    const source = `
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createCodeFlowNodeLogger, createCodeFlowModuleLogger } from ${JSON.stringify(new URL("../../packages/shared/src/nodeLogger.ts", import.meta.url).href)};
const pino = createRequire(${JSON.stringify(new URL("../../packages/shared/package.json", import.meta.url).href)})('pino');
const root = createCodeFlowNodeLogger({
  defaultLogDir: process.env.CODEFLOW_LOGGER_TEST_DIR, defaultLogFile: 'client.log',
  env: { levelKeys: ['CODEFLOW_LOGGER_TEST_LEVEL'], logDirKeys: [], logFileKeys: [], rotateFrequencyKeys: [], rotateSizeKeys: [], retentionCountKeys: [] }
});
const stream = root[pino.symbols.streamSym];
const logger = createCodeFlowModuleLogger(root, 'installer-test');
logger.info({ startup: true }, '启动日志🙂');
await once(stream, 'ready');
stream.ref();
logger.trace('below threshold');
logger.debug('debug message');
logger.info({ requestId: 'logger-test', password: 'test-password', apiKey: 'test-key', headers: { authorization: 'Bearer test-token' } }, '已连接服务器');
logger.warn('warning message');
logger.error({ code: 'TEST_ERROR', requestId: 'logger-test' }, 'error message');
const closed = once(stream, 'close');
stream.end();
await closed;
`;
    try {
      const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "--eval", source], {
        encoding: "utf8", timeout: 15000, windowsHide: true,
        env: { ...process.env, CODEFLOW_LOGGER_TEST_DIR: tempDir, CODEFLOW_LOGGER_TEST_LEVEL: level },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, "", "日志初始化不应产生 Pino transport warning");
      const files = fs.readdirSync(tempDir).filter(file => /client-\d{8}.*\.log$/.test(file));
      assert.ok(files.length > 0, "必须实际生成日志文件");
      const text = files.map(file => fs.readFileSync(path.join(tempDir, file), "utf8")).join("\n");
      const records = text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      assert.deepEqual(records.map(record => record.level), level === "debug" ? ["INFO", "DEBUG", "INFO", "WARN", "ERROR"] : ["INFO", "INFO", "WARN", "ERROR"]);
      assert.equal(records[0].message, "启动日志🙂");
      for (const record of records) {
        assert.equal(record.module, "installer-test");
        assert.match(record.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      }
      const info = records.find(record => record.requestId === "logger-test" && record.level === "INFO");
      assert.equal(info.message, "已连接服务器");
      assert.equal(info.requestId, "logger-test");
      assert.equal(info.password, "[REDACTED]");
      assert.equal(info.apiKey, "[REDACTED]");
      assert.equal(info.headers.authorization, "[REDACTED]");
      assert.doesNotMatch(text, /test-password|test-key|test-token/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

test("buffered startup lets the event loop release a waiting real log worker", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-gated-logger-"));
  const fixture = path.join(tempDir, "gated-transport.cjs");
  fs.writeFileSync(fixture, `module.exports = options => {
    const gate = new Int32Array(options.gate);
    if (Atomics.wait(gate, 0, 0, 2000) === 'timed-out') throw new Error('LOGGER_MAIN_THREAD_BLOCKED');
    return require(options.pinoRoll)(options);
  };`, "utf8");
  const source = `
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createCodeFlowNodeLogger } from ${JSON.stringify(new URL("../../packages/shared/src/nodeLogger.ts", import.meta.url).href)};
const require = createRequire(${JSON.stringify(new URL("../../packages/shared/package.json", import.meta.url).href)});
const pino = require('pino'), original = pino.transport;
const gate = new Int32Array(new SharedArrayBuffer(4));
let transport;
pino.transport = options => transport = original({ ...options, target: process.env.CODEFLOW_LOGGER_TEST_FIXTURE,
  options: { ...options.options, gate: gate.buffer, pinoRoll: require.resolve('pino-roll') } });
const logger = createCodeFlowNodeLogger({ defaultLogDir: process.env.CODEFLOW_LOGGER_TEST_DIR,
  defaultLogFile: 'client.log', bufferUntilReady: true,
  env: { levelKeys: [], logDirKeys: [], logFileKeys: [], rotateFrequencyKeys: [], rotateSizeKeys: [], retentionCountKeys: [] } });
const ready = once(transport, 'ready');
const release = setTimeout(() => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); }, 30);
logger.info({ sequence: 1 }, 'before-ready');
const heartbeat = setInterval(() => logger.info({ sequence: 2 }, 'during-startup'), 5);
await ready;
clearTimeout(release); clearInterval(heartbeat);
transport.ref();
logger.info({ sequence: 3 }, 'after-ready');
await new Promise((resolve, reject) => logger.flush(error => error ? reject(error) : resolve()));
transport.ref();
const closed = once(transport, 'close'); transport.end(); await closed;
`;
  try {
    const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-"], {
      input: source, encoding: "utf8", timeout: 10000, windowsHide: true,
      env: { ...process.env, CODEFLOW_LOGGER_TEST_DIR: tempDir, CODEFLOW_LOGGER_TEST_FIXTURE: fixture },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const rows = fs.readdirSync(tempDir).filter(file => file.endsWith(".log"))
      .flatMap(file => fs.readFileSync(path.join(tempDir, file), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line)));
    assert.equal(rows[0].sequence, 1);
    assert.equal(rows.at(-1).sequence, 3);
    assert.ok(rows.some(row => row.sequence === 2), "主线程定时器必须能在线程就绪前执行");
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test("buffered startup exposes a real log destination initialization failure", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-failed-logger-"));
  const blockedDir = path.join(tempDir, "blocked");
  fs.writeFileSync(blockedDir, "not-a-directory", "utf8");
  const source = `
import { createCodeFlowNodeLogger } from ${JSON.stringify(new URL("../../packages/shared/src/nodeLogger.ts", import.meta.url).href)};
const logger = createCodeFlowNodeLogger({ defaultLogDir: process.env.CODEFLOW_LOGGER_TEST_DIR,
  defaultLogFile: 'client.log', bufferUntilReady: true,
  env: { levelKeys: [], logDirKeys: [], logFileKeys: [], rotateFrequencyKeys: [], rotateSizeKeys: [], retentionCountKeys: [] } });
logger.info({ requestId: 'logger-startup-failure' }, 'before-failure');
`;
  try {
    const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-"], {
      input: source, encoding: "utf8", timeout: 10000, windowsHide: true,
      env: { ...process.env, CODEFLOW_LOGGER_TEST_DIR: blockedDir },
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOTDIR|EEXIST/);
    assert.equal(fs.readFileSync(blockedDir, "utf8"), "not-a-directory");
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test("buffered startup persists complete oversized UTF-8 lines on immediate process exit", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-buffered-logger-"));
  const source = `
import { createCodeFlowNodeLogger } from ${JSON.stringify(new URL("../../packages/shared/src/nodeLogger.ts", import.meta.url).href)};
const logger = createCodeFlowNodeLogger({
  defaultLogDir: process.env.CODEFLOW_LOGGER_TEST_DIR, defaultLogFile: 'client.log', bufferUntilReady: true,
  env: { levelKeys: [], logDirKeys: [], logFileKeys: [], rotateFrequencyKeys: [], rotateSizeKeys: [], retentionCountKeys: [] }
});
const child = logger.child({ module: 'startup' });
child.info({ sequence: 1 }, 'before');
child.info({ sequence: 2, body: '中🙂'.repeat(700000), password: 'must-redact' }, 'large');
child.info({ sequence: 3 }, 'after');
process.exit(0);
`;
  try {
    const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-"], {
      input: source, encoding: "utf8", timeout: 15000, windowsHide: true,
      env: { ...process.env, CODEFLOW_LOGGER_TEST_DIR: tempDir },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const text = fs.readdirSync(tempDir).filter(file => file.endsWith(".log"))
      .map(file => fs.readFileSync(path.join(tempDir, file), "utf8")).join("");
    const rows = text.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.sequence), [1, 2, 3]);
    assert.equal(rows[1].body, "中🙂".repeat(700000));
    assert.equal(rows[1].password, "[REDACTED]");
    assert.doesNotMatch(text, /must-redact/);
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});
