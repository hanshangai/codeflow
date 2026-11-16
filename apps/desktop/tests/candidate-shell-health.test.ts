import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import ts from "typescript";
import * as health from "../src/candidateShellHealth.js";
import { createClientRuntime } from "../src/clientRuntime.js";
import { loadOrCreateDeviceIdentity, readDeviceIdentity } from "../src/deviceIdentity.js";

/** 仅隔离外部spawn和进程查询；等待、清理及错误翻译仍执行源码。 */
async function ownedProcessMethods(overrides: Record<string, unknown> = {}) {
  const source = await fs.readFile(new URL("../src/candidateShellHealth.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("health.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ["observeOwned", "bounded", "finishOwned", "runOwned", "sanitizeStructuredFailure", "combine", "fail"];
  const methods = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ""))
    .map(statement => statement.getFullText(ast)).join("\n");
  const compiled = ts.transpileModule(`${methods}\n({observeOwned,finishOwned,runOwned})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return vm.runInNewContext(compiled, { Error, AggregateError, Promise, Date, Map, setTimeout, clearTimeout,
    process: { pid: process.pid, platform: "win32" }, samePath: (left: string, right: string) => left === right, ...overrides });
}

test("owned health process still waits for close after a successful exit", async () => {
  const methods = await ownedProcessMethods();
  const child = new EventEmitter();
  const owned = methods.observeOwned(child);
  let settled = false;
  const finish = methods.finishOwned(owned, 1_000).then(() => { settled = true; });
  child.emit("exit", 0, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(owned.didClose, false);
  child.emit("close", 0, null);
  await finish;
  assert.equal(owned.didClose, true);
});

test("owned health cleanup retains timeout and full-query failure instead of reporting success", async () => {
  const queryFailure = new Error("controlled full query failure");
  const methods = await ownedProcessMethods({ processSnapshot: async () => { throw queryFailure; } });
  const child = Object.assign(new EventEmitter(), { pid: 512 });
  const owned = methods.observeOwned(child);
  await assert.rejects(methods.finishOwned(owned, 1), (failure: unknown) => {
    const causes = (error: unknown): unknown[] => error instanceof AggregateError ? [error, ...error.errors.flatMap(causes)] : [error];
    const errors = causes(failure);
    assert.ok(errors.includes(queryFailure));
    assert.ok(errors.some(error => error instanceof Error && error.message === "DESKTOP_SHELL_HEALTH_PROCESS_TIMEOUT"));
    assert.ok(errors.some(error => error instanceof Error && error.message === "DESKTOP_SHELL_HEALTH_PROCESS_REMAINS"));
    return true;
  });
});

test("owned health cleanup excludes a reused root PID and descendants born after its exit", async () => {
  const stopped: number[] = [], start = Date.now();
  const child = Object.assign(new EventEmitter(), { pid: 512, exitCode: 0, signalCode: null });
  const originalChild = { pid: 513, parentPid: 512, created: start - 20, executable: "owned", commandLine: "owned child" };
  let calls = 0;
  const methods = await ownedProcessMethods({
    processSnapshot: async () => ++calls === 1 ? [originalChild,
      { pid: 512, parentPid: process.pid, created: start + 1_000, executable: "other", commandLine: "reused root" },
      { pid: 514, parentPid: 512, created: start + 1_001, executable: "other", commandLine: "unrelated child" }] : [],
    stopIdentity: async (identity: { pid: number }) => { stopped.push(identity.pid); child.emit("close", 0, null); },
    sameIdentity: (left: unknown, right: unknown) => left === right,
  });
  const owned = methods.observeOwned(child);
  child.emit("exit", 0, null);
  await assert.rejects(methods.finishOwned(owned, 1), /DESKTOP_SHELL_HEALTH_PROCESS_TIMEOUT/u);
  assert.deepEqual(stopped, [513]); assert.equal(owned.didClose, true);
});

test("owned health errors preserve every event before a successful close", async () => {
  const methods = await ownedProcessMethods(), child = new EventEmitter();
  const first = Object.freeze(new Error("first child failure")), second = Object.freeze(new Error("second child failure"));
  const owned = methods.observeOwned(child), running = methods.finishOwned(owned, 1_000);
  child.emit("error", first); child.emit("error", second); child.emit("close", 0, null);
  await assert.rejects(running, (failure: unknown) => {
    assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, [first, second]);
    return true;
  });
  assert.equal(owned.didClose, true);
});

for (const original of [undefined, false, Object.freeze(new Error("single child failure"))])
test(`owned health errors preserve one ${String(original)} event instead of accepting successful close`, async () => {
  const methods = await ownedProcessMethods(), child = new EventEmitter();
  const owned = methods.observeOwned(child), running = methods.finishOwned(owned, 1_000);
  child.emit("error", original); child.emit("close", 0, null);
  await assert.rejects(running, (failure: unknown) => { assert.equal(failure, original); return true; });
  assert.equal(owned.didClose, true);
});

for (const rejectQuery of [false, true])
test(`owned health errors retain a cleanup event when its query ${rejectQuery ? "rejects" : "completes"}`, async () => {
  const late = Object.freeze(new Error("child error during cleanup")), queryFailure = Object.freeze(new Error("cleanup query failed"));
  const child = Object.assign(new EventEmitter(), { pid: 512, exitCode: 0, signalCode: null });
  let queries = 0, stops = 0;
  const methods = await ownedProcessMethods({
    /** 在原超时清理入口触发真实事件结算，不模拟finishOwned的错误结果。 */
    processSnapshot: async () => {
      if (++queries === 1) {
        child.emit("error", late); child.emit("close", 0, null);
        if (rejectQuery) throw queryFailure;
      }
      return [];
    },
    stopIdentity: async () => { stops++; },
  });
  const owned = methods.observeOwned(child);
  child.emit("exit", 0, null);
  await assert.rejects(methods.finishOwned(owned, 1), (failure: unknown) => {
    /** 展开最终聚合以核对原始实体，期望原因独立于产品聚合层级。 */
    const causes = (value: unknown): unknown[] => value instanceof AggregateError ? [value, ...value.errors.flatMap(causes)] : [value];
    const errors = causes(failure);
    assert.ok(errors.some(value => value instanceof Error && value.message === "DESKTOP_SHELL_HEALTH_PROCESS_TIMEOUT"));
    assert.ok(errors.includes(late));
    if (rejectQuery) assert.ok(errors.includes(queryFailure));
    return true;
  });
  assert.equal(owned.didClose, true);
  assert.equal(queries, rejectQuery ? 1 : 2);
  assert.equal(stops, 0);
});

for (const pipe of ["stdout", "stderr"] as const)
test(`owned health pipes route ${pipe} errors through close settlement`, async () => {
  const methods = await ownedProcessMethods();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const original = Object.freeze(Object.assign(new Error(`${pipe} read failed`), { code: "EIO" }));
  const owned = methods.observeOwned(child);
  try {
    assert.doesNotThrow(() => child[pipe].emit("error", original));
    child.emit("close", 0, null);
    await assert.rejects(methods.finishOwned(owned, 1_000), failure => failure === original);
  } finally {
    if (!owned.didClose) child.emit("close", 0, null);
    child.stdout.destroy(); child.stderr.destroy();
  }
});

test("owned health pipes preserve child and both output errors in the same settlement", async () => {
  const methods = await ownedProcessMethods();
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const primary = new Error("child failure"), output = new Error("stdout failure"), diagnostic = new Error("stderr failure");
  const owned = methods.observeOwned(child);
  try {
    child.emit("error", primary);
    assert.doesNotThrow(() => child.stdout.emit("error", output));
    assert.doesNotThrow(() => child.stderr.emit("error", diagnostic));
    child.emit("close", 0, null);
    await assert.rejects(methods.finishOwned(owned, 1_000), (failure: unknown) => {
      assert.ok(failure instanceof AggregateError);
      assert.deepEqual(failure.errors, [primary, output, diagnostic]);
      return true;
    });
  } finally {
    if (!owned.didClose) child.emit("close", 0, null);
    child.stdout.destroy(); child.stderr.destroy();
  }
});

for (const pipe of ["stdout", "stderr"] as const)
test(`owned health pipes preserve ${pipe} errors through the original runner`, async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const original = Object.freeze(Object.assign(new Error(`${pipe} read failed`), { code: "EIO" }));
  let emit!: () => void;
  const emitted = new Promise<void>((resolve, reject) => {
    /** 事件自身失败也作为显式失败态结算，RED不能留下未处理拒绝或悬挂进程。 */
    emit = () => {
      try { child[pipe].emit("error", original); resolve(); }
      catch (cause) { reject(cause); }
      finally { child.emit("close", 0, null); }
    };
  });
  const methods = await ownedProcessMethods({ spawn: () => { queueMicrotask(emit); return child; } });
  try {
    const [completed, event] = await Promise.allSettled([
      methods.runOwned("controlled.exe", [], { cwd: os.tmpdir(), env: {}, timeoutMs: 1_000 }), emitted,
    ]);
    assert.deepEqual([completed.status, event.status], ["rejected", "fulfilled"]);
    if (completed.status !== "rejected") assert.fail("a pipe failure cannot report a successful process");
    assert.equal(completed.reason.code, "DESKTOP_SHELL_HEALTH_PROCESS_FAILED");
    assert.equal(completed.reason.cause, original);
  } finally { child.stdout.destroy(); child.stderr.destroy(); }
});

for (const pipe of ["stdout", "stderr"] as const)
test(`owned health pipes keep ${pipe} cleanup errors without aborting the process query`, async () => {
  const child = Object.assign(new EventEmitter(), { pid: 512, exitCode: 0, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough() });
  const original = new Error(`${pipe} failed during cleanup`);
  let queries = 0, stops = 0;
  const methods = await ownedProcessMethods({
    /** 流错误应交owner结算，独立系统查询仍须完成并复核清理结果。 */
    processSnapshot: async () => {
      if (++queries === 1) {
        try { child[pipe].emit("error", original); }
        finally { child.emit("close", 0, null); }
      }
      return [];
    },
    stopIdentity: async () => { stops++; },
  });
  const owned = methods.observeOwned(child);
  child.emit("exit", 0, null);
  try {
    await assert.rejects(methods.finishOwned(owned, 1), (failure: unknown) => {
      /** 只核对原始错误实体和超时事实，不固定聚合的内部层级。 */
      const causes = (value: unknown): unknown[] => value instanceof AggregateError ? [value, ...value.errors.flatMap(causes)] : [value];
      const errors = causes(failure);
      assert.ok(errors.includes(original));
      assert.ok(errors.some(value => value instanceof Error && value.message === "DESKTOP_SHELL_HEALTH_PROCESS_TIMEOUT"));
      return true;
    });
    assert.equal(queries, 2);
    assert.equal(stops, 0);
    assert.equal(owned.didClose, true);
  } finally { child.stdout.destroy(); child.stderr.destroy(); }
});

const evidence = await fs.mkdtemp(path.join(os.tmpdir(), "cf-d13-health-unit-"));
after(() => { process.stdout.write(`D13 candidate health evidence: ${evidence}\n`); });

/** 独占最小安装夹具不包含真实配置、数据库或已安装应用。 */
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(evidence, "fixture-")));
  const installationDir = path.join(root, "installation"), sourceDataDir = path.join(root, "source");
  await fs.mkdir(sourceDataDir);
  for (const id of ["baseline", "candidate"]) {
    const shell = path.join(installationDir, "shells", id);
    await fs.mkdir(path.join(shell, "resources", "web"), { recursive: true });
    await fs.mkdir(path.join(shell, "resources", "client", "dist"), { recursive: true });
    await fs.writeFile(path.join(shell, "CodeFlowAI.exe"), "explicit candidate fixture", "ascii");
    await fs.writeFile(path.join(shell, "resources", "web", "index.html"), "<html></html>", "utf8");
    await fs.writeFile(path.join(shell, "resources", "client", "dist", "index.cjs"), "fixture", "ascii");
    await fs.writeFile(path.join(shell, "resources", "release-trust.json"), "{}\n", "ascii");
  }
  await fs.writeFile(path.join(installationDir, "shell-launch.ini"),
    "[shell]\r\nschema=1\r\nactive=baseline\r\nprevious=\r\nbaseline=baseline\r\n", "ascii");
  await fs.writeFile(path.join(sourceDataDir, "config.json"), "source secret never read", "utf8");
  await fs.writeFile(path.join(sourceDataDir, "codeflowai.db"), "source database never opened", "utf8");
  const temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(root, "attempt-")));
  for (const directory of ["home", "appdata", "local-appdata", "codex", "claude", "config", "data", "tmp", "user-data", "session-data"]) {
    await fs.mkdir(path.join(temporaryRoot, directory));
  }
  return { root, installationDir, sourceDataDir, temporaryRoot,
    candidateExecutablePath: path.join(installationDir, "shells", "candidate", "CodeFlowAI.exe") };
}

/** 请求固定字段使用手写值；源摘要由父 runner 另行验证。 */
function request(f: Awaited<ReturnType<typeof fixture>>): health.CandidateShellHealthRequest {
  return { schemaVersion: 1, requestId: crypto.randomUUID(), candidateShellId: "candidate",
    installationDir: f.installationDir, sourceDataDir: f.sourceDataDir,
    candidateExecutablePath: f.candidateExecutablePath, temporaryRoot: f.temporaryRoot, timeoutMs: 120_000 };
}

test("health flags distinguish ordinary startup from malformed candidate invocation", () => {
  assert.equal(typeof health.readCandidateShellHealthRequest, "function");
  assert.equal(health.readCandidateShellHealthRequest(["CodeFlowAI.exe", "--ordinary"]), null);
  for (const args of [["--codeflow-shell-health"], ["--codeflow-shell-health=other"],
    ["--codeflow-shell-health", "one", "--codeflow-shell-health", "two"]]) {
    assert.throws(() => health.readCandidateShellHealthRequest(args), /DESKTOP_SHELL_HEALTH_REQUEST_INVALID/u);
  }
});

test("a bounded ordinary request accepts an inactive candidate and keeps all source bytes", async () => {
  const f = await fixture(), input = request(f), file = path.join(f.temporaryRoot, "request.json");
  await fs.writeFile(file, JSON.stringify(input), "utf8");
  const before = await fs.readFile(file);
  assert.equal(typeof health.readCandidateShellHealthRequest, "function");
  assert.deepEqual(health.readCandidateShellHealthRequest(["--codeflow-shell-health", file], f.candidateExecutablePath), input);
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal(await fs.readFile(path.join(f.sourceDataDir, "config.json"), "utf8"), "source secret never read");
  assert.equal(await fs.readFile(path.join(f.sourceDataDir, "codeflowai.db"), "utf8"), "source database never opened");
});

test("requests reject extra fields, bad identity, invalid budgets and oversized bytes", async () => {
  const f = await fixture(), input = request(f), file = path.join(f.temporaryRoot, "request.json");
  assert.equal(typeof health.readCandidateShellHealthRequest, "function");
  for (const invalid of [{ ...input, extra: "ignored" }, { ...input, requestId: "not-an-id" },
    { ...input, candidateShellId: "baseline" }, { ...input, timeoutMs: 0 }, { ...input, timeoutMs: 300_001 },
    { ...input, candidateExecutablePath: path.join(f.root, "CodeFlowAI.exe") }]) {
    await fs.writeFile(file, JSON.stringify(invalid), "utf8");
    assert.throws(() => health.readCandidateShellHealthRequest(["--codeflow-shell-health", file], f.candidateExecutablePath), /DESKTOP_SHELL_HEALTH_/u);
  }
  await fs.writeFile(file, Buffer.alloc(65_537, "a"));
  assert.throws(() => health.readCandidateShellHealthRequest(["--codeflow-shell-health", file], f.candidateExecutablePath), /DESKTOP_SHELL_HEALTH_REQUEST_INVALID/u);
});

test("candidate requests reject overlapping outputs and internal directory junctions", async () => {
  const f = await fixture(), input = request(f), file = path.join(f.temporaryRoot, "request.json");
  assert.equal(typeof health.readCandidateShellHealthRequest, "function");
  for (const temporaryRoot of [f.installationDir, f.sourceDataDir, f.root]) {
    await fs.writeFile(file, JSON.stringify({ ...input, temporaryRoot }), "utf8");
    assert.throws(() => health.readCandidateShellHealthRequest(["--codeflow-shell-health", file], f.candidateExecutablePath), /DESKTOP_SHELL_HEALTH_/u);
  }
  await fs.writeFile(file, JSON.stringify(input), "utf8");
  const candidate = path.dirname(f.candidateExecutablePath), retained = path.join(f.installationDir, "retained");
  await fs.rename(candidate, retained); await fs.symlink(retained, candidate, "junction");
  assert.throws(() => health.readCandidateShellHealthRequest(["--codeflow-shell-health", file], f.candidateExecutablePath), /DESKTOP_SHELL_HEALTH_PATH_INVALID/u);
});

test("the parent environment keeps only system prerequisites and isolated directories", async () => {
  const f = await fixture();
  assert.equal(typeof health.createCandidateShellHealthEnvironment, "function");
  const source = { Path: "system-path", SystemRoot: "C:\\Windows", COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    NODE_OPTIONS: "injected", NODE_PATH: "real-node", HTTPS_PROXY: "proxy-secret", CODEFLOWAI_API_KEY: "secret",
    CODEFLOWAI_WORKSPACE_PATH: "real-workspace", HOME: "real-home", USERPROFILE: "real-user", CODEX_HOME: "real-cli",
    LOGONSERVER: "os-logon", USERDOMAIN: "os-domain", USERNAME: "os-user" };
  const before = { ...source };
  const env = await health.createCandidateShellHealthEnvironment(f.temporaryRoot, source);
  assert.deepEqual(source, before);
  assert.equal(env.Path, "system-path"); assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.LOGONSERVER, "os-logon"); assert.equal(env.USERDOMAIN, "os-domain"); assert.equal(env.USERNAME, "os-user");
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "HTTPS_PROXY", "CODEFLOWAI_API_KEY", "CODEFLOWAI_WORKSPACE_PATH"]) assert.equal(env[key], undefined);
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMP", "TEMP", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    const relative = path.relative(f.temporaryRoot, env[key]!);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assert.equal((await fs.lstat(env[key]!)).isDirectory(), true);
  }
  if (process.platform === "win32") {
    const isolatedHome = path.join(f.temporaryRoot, "home"), root = path.parse(isolatedHome).root;
    assert.equal(env.HOMEDRIVE, root.slice(0, -1));
    assert.equal(env.HOMEPATH, path.sep + path.relative(root, isolatedHome));
    health.assertCandidateShellHealthEnvironment(request(f), env);
    assert.throws(() => health.assertCandidateShellHealthEnvironment(request(f), { ...env, HOMEDRIVE: "C:", HOMEPATH: "\\Users\\real-user" }),
      /DESKTOP_SHELL_HEALTH_ENVIRONMENT_INVALID/u);
  }
});

test("a missing candidate fails before creating output or touching the source configuration", async () => {
  const f = await fixture();
  assert.equal(typeof health.runCandidateShellHealth, "function");
  await fs.unlink(f.candidateExecutablePath);
  await assert.rejects(health.runCandidateShellHealth({ ...f, temporaryParentDir: f.root }), /DESKTOP_SHELL_HEALTH_PATH_INVALID/u);
  assert.equal(await fs.readFile(path.join(f.sourceDataDir, "config.json"), "utf8"), "source secret never read");
  assert.deepEqual((await fs.readdir(f.root)).sort(), [path.basename(f.temporaryRoot), "installation", "source"].sort());
});

test("profile directory junctions and nonempty profiles fail synchronously before Electron writes", async () => {
  for (const directory of ["user-data", "session-data"]) {
    const f = await fixture(), input = request(f), file = path.join(f.temporaryRoot, "request.json");
    await fs.writeFile(file, JSON.stringify(input), "utf8");
    const profile = path.join(f.temporaryRoot, directory);
    await fs.rmdir(profile); await fs.symlink(f.sourceDataDir, profile, "junction");
    assert.throws(() => health.readCandidateShellHealthRequest(["--codeflow-shell-health", file], f.candidateExecutablePath), /DESKTOP_SHELL_HEALTH_PATH_INVALID/u);
    assert.equal(await fs.readFile(path.join(f.sourceDataDir, "config.json"), "utf8"), "source secret never read");
  }
  const f = await fixture(), file = path.join(f.temporaryRoot, "request.json");
  await fs.writeFile(file, JSON.stringify(request(f)), "utf8");
  await fs.writeFile(path.join(f.temporaryRoot, "user-data", "real-profile"), "retained", "ascii");
  assert.throws(() => health.readCandidateShellHealthRequest(["--codeflow-shell-health", file], f.candidateExecutablePath), /DESKTOP_SHELL_HEALTH_OUTPUT_NOT_FRESH/u);
});

test("manual candidate invocation rejects inherited secrets before any source read or directory write", async () => {
  const f = await fixture(), input = request(f);
  assert.equal(typeof health.assertCandidateShellHealthEnvironment, "function");
  const env = await health.createCandidateShellHealthEnvironment(f.temporaryRoot, { SystemRoot: "C:\\Windows" });
  for (const [key, value] of Object.entries({ NODE_OPTIONS: "injected", CODEFLOWAI_API_KEY: "secret", HTTP_PROXY: "secret" })) {
    assert.throws(() => health.assertCandidateShellHealthEnvironment(input, { ...env, [key]: value }), /DESKTOP_SHELL_HEALTH_ENVIRONMENT_INVALID/u);
  }
  health.assertCandidateShellHealthEnvironment(input, env);
  assert.equal(await fs.readFile(path.join(f.sourceDataDir, "config.json"), "utf8"), "source secret never read");
  assert.deepEqual(await fs.readdir(path.join(f.temporaryRoot, "user-data")), []);
  await assert.rejects(fs.stat(path.join(f.temporaryRoot, "report.json")), { code: "ENOENT" });
});

test("a successful report must cover the exact baseline and signed active selection once each", async () => {
  const f = await fixture(), input = request(f);
  const selections = [{ role: "baseline" as const, releaseId: "installation", releaseDir: path.join(f.installationDir, "shells", "baseline", "resources") },
    { role: "active" as const, releaseId: "binding-1", releaseDir: path.join(f.sourceDataDir, "releases", "binding-1") }];
  const checks = selections.map(selected => ({ ...selected, childClosed: true as const,
    health: { protocolVersion: 1, clientVersion: "1", dbSchemaVersion: 92, database: "ready" as const },
    native: { loaded: ["a.node", "b.node", "c.node", "keyring.node"], credentialsAccessed: false as const, ptyCreated: false as const },
    web: { files: ["codeflow://desktop/"] }, database: { integrity: "ok" as const, schemaVersion: 92 } }));
  const report = { schemaVersion: 1, requestId: input.requestId, candidateShellId: input.candidateShellId,
    temporaryRoot: input.temporaryRoot, status: "passed", checks, phase: "complete" };
  assert.deepEqual(health.validateCandidateShellHealthReport(report, input, selections), report);
  for (const invalid of [checks.slice(0, 1), [checks[0], checks[0]], [checks[0], { ...checks[1], releaseDir: f.root }]]) {
    assert.throws(() => health.validateCandidateShellHealthReport({ ...report, checks: invalid }, input, selections), /DESKTOP_SHELL_HEALTH_REPORT_INVALID/u);
  }
});

for (const failedStage of ["native", "client"]) test(`an active ${failedStage} failure is logged with the verified binding ID and child phase`, async t => {
  const f = await fixture(), releaseId = "verified-active-7", releaseDir = path.join(f.sourceDataDir, "releases", releaseId);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  await fs.writeFile(path.join(path.dirname(f.candidateExecutablePath), "resources", "release-trust.json"),
    JSON.stringify({ fixture: publicKey.export({ type: "spki", format: "pem" }) }), "utf8");
  await fs.mkdir(path.join(releaseDir, "web"), { recursive: true });
  await fs.mkdir(path.join(releaseDir, "client", "dist"), { recursive: true });
  await fs.writeFile(path.join(releaseDir, "web", "index.html"), "web", "utf8");
  await fs.writeFile(path.join(releaseDir, "client", "dist", "index.cjs"), "client", "utf8");
  const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
  const webSha256 = hash(`index.html\0${hash("web")}\n`), clientSha256 = hash(`dist/index.cjs\0${hash("client")}\n`);
  await fs.writeFile(path.join(releaseDir, "manifest.json"), JSON.stringify(signReleaseBundleManifest({
    schemaVersion: 2, releaseId, version: "2.0.0", webVersion: "2.1.0", clientVersion: "2.2.0", protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 92,
    platform: process.platform, arch: process.arch, keyId: "fixture", archiveSha256: "f".repeat(64), archiveSize: 100,
    webSha256, clientSha256, packageSha256: hash(`client\0${clientSha256}\nweb\0${webSha256}\n`),
    files: [{ path: "client/dist/index.cjs", size: 6, sha256: hash("client") }, { path: "web/index.html", size: 3, sha256: hash("web") }],
    createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2099-10-24T00:00:00.000Z",
  }, privateKey)), "utf8");
  await fs.writeFile(path.join(f.sourceDataDir, "active-release.json"), JSON.stringify({ releaseId }), "utf8");
  const mocked = t.mock.method(childProcess, "spawn", ((_file: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    queueMicrotask(() => {
      child.emit("spawn");
      void (async () => {
        const input = JSON.parse(await fs.readFile(args[1]!, "utf8"));
        const baseline = { role: "baseline", releaseId: "installation", releaseDir: path.join(f.installationDir, "shells", "baseline", "resources"), childClosed: true,
          health: { protocolVersion: 1, clientVersion: "1", dbSchemaVersion: 92, database: "ready" },
          native: { loaded: ["a.node", "b.node", "c.node", "keyring.node"], credentialsAccessed: false, ptyCreated: false },
          web: { files: ["codeflow://desktop/"] }, database: { integrity: "ok", schemaVersion: 92 } };
        await fs.writeFile(path.join(input.temporaryRoot, "report.json"), JSON.stringify({ schemaVersion: 1, requestId: input.requestId,
          candidateShellId: input.candidateShellId, temporaryRoot: input.temporaryRoot, status: "failed", checks: [baseline], phase: `active:${failedStage}`,
          error: { code: failedStage === "native" ? "ERR_DLOPEN_FAILED" : "EACCES" }, releaseId: "untrusted-report-id" }), "utf8");
        child.emit("exit", 1, null); child.emit("close", 1, null);
      })().catch(error => { child.emit("error", error); child.emit("close", 1, null); });
    });
    return child;
  }) as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try {
    let attemptRoot = "";
    await assert.rejects(health.runCandidateShellHealth({ ...f, temporaryParentDir: f.root }), error => {
      attemptRoot = (error as Error & { temporaryRoot: string }).temporaryRoot;
      assert.ok(attemptRoot); return true;
    });
    const report = JSON.parse(await fs.readFile(path.join(attemptRoot, "parent-report.json"), "utf8"));
    const log = JSON.parse(await fs.readFile(path.join(attemptRoot, "health-errors.jsonl"), "utf8"));
    assert.equal(report.releaseId, releaseId); assert.equal(report.childPhase, `active:${failedStage}`);
    assert.equal(log.releaseId, releaseId); assert.equal(log.childPhase, `active:${failedStage}`);
    assert.equal(log.requestId, report.requestId);
    assert.equal(JSON.stringify(log).includes("untrusted-report-id"), false);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("physical snapshot hashes an asar ordinary file despite Electron's virtual directory metadata", async () => {
  const f = await fixture(), archive = path.join(f.root, "payload", "resources", "app.asar");
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(archive, "physical archive bytes", "ascii");
  const source = await fs.readFile(new URL("../src/candidateShellHealth.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("health.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ["hashTree", "assertOrdinary", "samePath", "fail", "isHealthError"];
  const methods = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ""))
    .map(statement => statement.getFullText(ast)).join("\n");
  const patched = { ...fsSync, lstatSync: ((file: Parameters<typeof fsSync.lstatSync>[0]) => {
    const stat = fsSync.lstatSync(file);
    if (String(file) === archive) return Object.assign(stat, { isFile: () => false, isDirectory: () => true });
    return stat;
  }) as typeof fsSync.lstatSync };
  const compiled = ts.transpileModule(`${methods}\n({hashTree})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const helpers = vm.runInNewContext(compiled, { fs: patched, fsp: fs, path, crypto, Error, process });
  const hashes: Record<string, string> = {};
  await helpers.hashTree(path.join(f.root, "payload"), hashes, fsSync);
  assert.equal(hashes[archive], crypto.createHash("sha256").update("physical archive bytes").digest("hex"));
});

for (const identityFailure of [false, true]) test(identityFailure ? "active identity persistence failure retains the current Client phase"
  : "each isolated Client can read its own temporary identity before startup without copying the source identity", async t => {
  const f = await fixture(), input = { ...request(f), candidateExecutablePath: process.execPath };
  const sourceIdentity = path.join(f.sourceDataDir, "device-identity.json");
  await fs.writeFile(sourceIdentity, "source-private-identity-must-not-be-read", "utf8");
  const source = await fs.readFile(new URL("../src/candidateShellHealth.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("health.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const method = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "executeCandidateShellHealth")!;
  const compiled = ts.transpileModule(`${method.getFullText(ast).replace("export async", "async")}\n({executeCandidateShellHealth})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const identities: string[] = [], completed = new Set<unknown>();
  const healthy = { protocolVersion: 1, clientVersion: "1", dbSchemaVersion: 92, database: "ready" as const };
  const selections = [{ role: "baseline", releaseId: "installation", releaseDir: path.join(f.root, "baseline") },
    { role: "active", releaseId: "active-identity-test", releaseDir: path.join(f.root, "active") }];
  if (identityFailure) {
    const open = fs.open;
    t.mock.method(fs, "open", (async (file: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
      if (String(file).startsWith(path.join(f.temporaryRoot, "client-1", "device-identity.json."))) {
        throw Object.assign(new Error("identity write denied"), { code: "EACCES" });
      }
      return Reflect.apply(open, fs, [file, ...args]);
    }) as typeof fs.open);
  }
  let recorded: health.CandidateShellHealthReport | undefined;
  const context = vm.runInNewContext(compiled, {
    fs: fsSync, fsp: fs, path, Error, process: { versions: { electron: "45.0.0" }, platform: "win32", arch: "x64", execPath: process.execPath },
    validateRequest: () => input, assertCandidateShellHealthEnvironment: () => undefined,
    captureSources: async () => ({}), selectReleases: async () => selections,
    checkWeb: async () => ({ files: ["codeflow://desktop/"] }),
    checkNative: async () => ({ loaded: ["a.node", "b.node", "c.node", "keyring.node"], credentialsAccessed: false, ptyCreated: false }),
    loadOrCreateDeviceIdentity, createClientRuntime, samePath: (left: string, right: string) => path.relative(left, right) === "",
    /** 只替换外部进程；真实 runtime 启动时按 Client 合同读取已经存在的身份。 */
    spawn: (_file: string, _args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      const child = Object.assign(new EventEmitter(), { pid: 123, send: (_message: unknown, callback: (error: Error | null) => void) => {
        callback(null); queueMicrotask(() => { child.emit("exit", 0, null); completed.add(child); child.emit("close", 0, null); }); return true;
      } });
      queueMicrotask(() => { void readDeviceIdentity(options.cwd).then(identity => {
        identities.push(identity.deviceId); child.emit("spawn");
        child.emit("message", { t: "desktop.ready", requestId: options.env.CODEFLOWAI_DESKTOP_REQUEST_ID, health: healthy });
      }, error => child.emit("error", error)); });
      return child;
    },
    observeOwned: (child: unknown) => child,
    finishOwned: async (child: unknown) => { assert.equal(completed.has(child), true); },
    checkDatabase: async () => ({ integrity: "ok", schemaVersion: 92 }),
    safeFailure: (error: Error) => ({ code: error.message }),
    combine: (first: unknown, second: unknown) => first === undefined ? second : new AggregateError([first, second]),
    fail: (code: string) => { throw new Error(code); },
    writeReport: async (_request: unknown, report: health.CandidateShellHealthReport) => { recorded = report; },
  });
  if (identityFailure) {
    await assert.rejects(context.executeCandidateShellHealth(input), (error: unknown) => {
      assert.equal((error as Error).cause instanceof Error && ((error as Error).cause as NodeJS.ErrnoException).code, "EACCES");
      return true;
    });
    assert.equal(recorded?.status, "failed"); assert.equal(recorded.phase, "active:client");
    assert.equal(recorded.checks.length, 1);
    assert.equal(JSON.stringify(recorded).includes("privateKeyBase64"), false);
    assert.equal(await fs.readFile(sourceIdentity, "utf8"), "source-private-identity-must-not-be-read");
    return;
  }
  const report = await context.executeCandidateShellHealth(input);
  assert.equal(report.status, "passed"); assert.equal(report.checks.length, 2);
  assert.equal(identities.length, 2); assert.notEqual(identities[0], identities[1]);
  for (const [index, deviceId] of identities.entries()) {
    const dataDir = path.join(f.temporaryRoot, `client-${index}`);
    assert.equal((await readDeviceIdentity(dataDir)).deviceId, deviceId);
  }
  assert.equal(await fs.readFile(sourceIdentity, "utf8"), "source-private-identity-must-not-be-read");
  assert.equal(JSON.stringify(report).includes("privateKeyBase64"), false);
});
