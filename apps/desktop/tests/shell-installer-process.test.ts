import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import test, { after } from "node:test";
import type { ShellReleasePayload } from "@codeflowai/shared";
import { signShellReleaseManifest } from "@codeflowai/shared/desktop-shell-release-signing";
import { serializeShellLaunchState } from "../src/shellLaunchState.js";
import type { ProcessIdentity } from "../src/windowsProcessIdentity.js";

const implementation = existsSync(new URL("../src/shellInstallerProcess.ts", import.meta.url))
  ? await import("../src/shellInstallerProcess.js") : {};
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), "cf-shell-installer-process-"));
after(() => { process.stdout.write(`D13 installer process evidence: ${evidence}\n`); });

/** 缺入口的 RED 与真实执行行为共用同一调用边界，不运行合成 exe。 */
function install(input: any): Promise<any> {
  const entry = (implementation as Record<string, unknown>).installShellCandidate;
  assert.equal(typeof entry, "function", "installShellCandidate execution boundary is required");
  return (entry as (value: unknown) => Promise<unknown>)(input);
}

/** 受控 child 保留 exit 与真实 close 的差异；管道仍由执行边界消费。 */
class InstallerChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly pid: number, readonly spawnfile: string) { super(); }
  /** 测试明确触发直接进程退出，不替代 close。 */
  exit(code: number) { this.exitCode = code; this.emit("exit", code, null); }
  /** 已排空管道后交付 close，不能以 exit 充当完成。 */
  close(code = 0) { if (this.exitCode === null) this.exit(code); this.stdout.end(); this.stderr.end(); this.emit("close", code, null); }
}

/** 真实临时签名、完整库存和原 INI；只有 OS 进程边界受控。 */
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(evidence, "fixture-")));
  const installationDir = path.join(root, "installation"), temporaryParentDir = path.join(root, "temporary");
  await fs.mkdir(temporaryParentDir);
  for (const shell of ["old", "previous", "baseline"]) {
    await fs.mkdir(path.join(installationDir, "shells", shell, "resources"), { recursive: true });
    await fs.writeFile(path.join(installationDir, "shells", shell, "CodeFlowAI.exe"), "synthetic existing shell");
  }
  for (const name of ["web/index.html", "client/dist/index.cjs", "release-trust.json"]) {
    const target = path.join(installationDir, "shells", "baseline", "resources", name);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, "synthetic baseline");
  }
  const expectedState = { activeShellId: "old", previousShellId: "previous", baselineShellId: "baseline" };
  await fs.writeFile(path.join(installationDir, "shell-launch.ini"), serializeShellLaunchState(expectedState));
  const contents: Record<string, string> = { "CodeFlowAI.exe": "synthetic candidate", "resources/app.asar": "physical synthetic asar", "resources/release-trust.json": "synthetic trust inventory", "locales/zh-CN.pak": "synthetic locale" };
  const installerPath = path.join(root, "installer.exe"), installer = Buffer.from("synthetic installer; never executable");
  await fs.writeFile(installerPath, installer);
  const keys = crypto.generateKeyPairSync("ed25519");
  const payload: ShellReleasePayload = { schemaVersion: 1, protocol: "codeflow-desktop-shell-v1", shellId: "new", version: "1.1.0", platform: "win32", arch: "x64",
    installerSha256: crypto.createHash("sha256").update(installer).digest("hex"), installerSize: installer.length,
    files: Object.entries(contents).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => ({ path: name, size: Buffer.byteLength(bytes), sha256: crypto.createHash("sha256").update(bytes).digest("hex") })),
    createdAt: "2026-10-27T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z", keyId: "test-key" };
  const manifest = signShellReleaseManifest(payload, keys.privateKey), candidateDirectory = path.join(installationDir, "shells", "new");
  const input = { manifest, trustedKeys: { "test-key": keys.publicKey }, installerPath, installationDir, expectedState,
    requestId: "installer.operation+1", timeoutMs: 2_000, temporaryParentDir };
  /** 按真实签名库存落候选，不使用产品校验器生成期望结果。 */
  const materialize = async () => { for (const [name, bytes] of Object.entries(contents)) { const target = path.join(candidateDirectory, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); } };
  return { root, input, candidateDirectory, materialize, installer };
}

/** 快照、精确停止与输出均为受控 OS 边界，不模拟工件或 INI 校验。 */
function processBoundary(f: Awaited<ReturnType<typeof fixture>>, onSpawn?: (child: InstallerChild, args: string[]) => Promise<void>) {
  let child: InstallerChild | undefined, calls = 0, samples = 0;
  let processes: ProcessIdentity[] = [];
  const stopped: ProcessIdentity[] = [], options: SpawnOptions[] = [], argumentsList: string[][] = [];
  const boundary = {
    spawn(executable: string, args: readonly string[], spawnOptions: SpawnOptions) {
      calls++; options.push(spawnOptions); argumentsList.push([...args]);
      child = new InstallerChild(700 + calls, executable);
      processes.push({ pid: child.pid, parentPid: process.pid, created: Date.now(), executable, commandLine: JSON.stringify(args) });
      child.once("exit", () => { processes = processes.filter(item => item.pid !== child!.pid); });
      const current = child;
      setImmediate(() => { void (onSpawn ? onSpawn(current, [...args]) : f.materialize().then(() => current.close())).catch(cause => current.emit("error", cause)); });
      return current as unknown as ChildProcess;
    },
    async snapshot() { samples++; return structuredClone(processes); },
    async stop(identity: ProcessIdentity) { stopped.push(structuredClone(identity)); processes = processes.filter(item => item.pid !== identity.pid); if (identity.pid === child?.pid) child.close(1); },
  };
  return { boundary, stopped, options, argumentsList, child: () => child!, calls: () => calls, samples: () => samples,
    processes: () => processes, replaceProcesses: (value: ProcessIdentity[]) => { processes = value; } };
}

/** 异步条件只等待受控夹具状态，不承担产品超时语义。 */
async function eventually(condition: () => boolean) { const end = Date.now() + 3_000; while (!condition()) { if (Date.now() >= end) throw new Error("fixture condition timed out"); await new Promise(resolve => setTimeout(resolve, 5)); } }

/** 搜索内存 cause/聚合实体，确保 undefined 也不会被哨兵吞掉。 */
function containsCause(value: unknown, expected: unknown): boolean {
  if (Object.is(value, expected)) return true;
  if (!(value instanceof Error)) return false;
  return Object.hasOwn(value, "cause") && containsCause(value.cause, expected)
    || value instanceof AggregateError && value.errors.some(cause => containsCause(cause, expected));
}

test("successful installation waits for close and verifies candidate entries without changing S0", async () => {
  const f = await fixture(); let release!: () => void, exited = false, settled = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const p = processBoundary(f, async child => { await f.materialize(); child.exit(0); exited = true; await gate; child.close(); });
  const running = install({ ...f.input, boundary: p.boundary }).then(value => { settled = true; return value; });
  await eventually(() => exited); assert.equal(settled, false); release();
  const result = await running; assert.deepEqual(result, { manifest: f.input.manifest, candidateDirectory: f.candidateDirectory });
  assert.equal(p.calls(), 1); assert.equal(p.stopped.length, 0);
  assert.equal(await fs.readFile(path.join(f.input.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(f.input.expectedState));
  const args = p.argumentsList[0]; assert.deepEqual(args.slice(0, 4), ["--codeflow-candidate-install", "--installation-root", f.input.installationDir, "--request-id"]);
  assert.match(args[4], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u); assert.notEqual(args[4], f.input.requestId);
  const env = p.options[0].env!; assert.equal(env.TEMP, env.TMP); assert.equal(env.TMP, env.TMPDIR);
  assert.equal(path.dirname(env.TEMP!), f.input.temporaryParentDir); assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  for (const [key, value] of Object.entries(process.env)) if (!["TEMP", "TMP", "TMPDIR", "ELECTRON_RUN_AS_NODE"].includes(key.toUpperCase())) assert.ok(env[key] === value, `environment key must remain unchanged: ${key}`);
  assert.equal(p.options[0].windowsHide, true); assert.deepEqual(p.options[0].stdio, ["ignore", "pipe", "pipe"]);
});

for (const existing of [false, true]) test(`${existing ? "existing" : "new"} candidate reads installer only at its required verification boundaries`, async t => {
  const f = await fixture(), open = fs.open; let installerBytes = 0;
  if (existing) await f.materialize();
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]) === f.input.installerPath) {
      const read = file.read.bind(file);
      t.mock.method(file, "read", async (...values: any[]) => {
        const result = await (read as any)(...values); installerBytes += result.bytesRead; return result;
      });
    }
    return file;
  });
  const p = processBoundary(f), result = await install({ ...f.input, boundary: p.boundary });
  assert.equal(result.candidateDirectory, f.candidateDirectory);
  assert.equal(installerBytes, f.installer.length * (existing ? 1 : 2));
  assert.equal(p.calls(), existing ? 0 : 1);
});

for (const elapsed of [1_999, 2_000, 2_001])
test(`installer completion deadline checks a successful final observation at ${elapsed}ms`, async t => {
  const f = await fixture(), p = processBoundary(f, async () => {}), snapshot = p.boundary.snapshot;
  const startedAt = Date.now(); let now = startedAt, samples = 0;
  t.mock.method(Date, "now", () => now);
  /** 最后一次查询期间完成真实夹具文件和close，只用时钟控制返回时刻。 */
  p.boundary.snapshot = async () => {
    if (++samples === 2) { await f.materialize(); p.child().close(); now = startedAt + elapsed; }
    return await snapshot();
  };
  try {
    const running = install({ ...f.input, boundary: p.boundary });
    if (elapsed < f.input.timeoutMs) assert.deepEqual(await running, { manifest: f.input.manifest, candidateDirectory: f.candidateDirectory });
    else await assert.rejects(running, (error: any) => {
      assert.equal(error.code, "DESKTOP_SHELL_INSTALLER_PROCESS_FAILED");
      assert.equal(error.phase, "process");
      assert.equal(error.cause.code, "DESKTOP_SHELL_INSTALLER_PROCESS_TIMEOUT");
      assert.equal(error.details.exitCode, 0);
      return true;
    });
  } finally { t.mock.restoreAll(); }
  assert.equal(p.calls(), 1);
  assert.equal(p.stopped.length, 0);
  assert.equal(await fs.readFile(path.join(f.candidateDirectory, "CodeFlowAI.exe"), "utf8"), "synthetic candidate");
  assert.equal(await fs.readFile(path.join(f.input.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(f.input.expectedState));
});

test("installer completion deadline preserves a late query failure and its exact cleanup owner", async t => {
  const f = await fixture(), p = processBoundary(f, async () => {}), snapshot = p.boundary.snapshot;
  const original = Object.freeze(Object.assign(new Error("controlled query failure"), { code: "EACCES" }));
  const startedAt = Date.now(); let now = startedAt, samples = 0;
  t.mock.method(Date, "now", () => now);
  /** 观察失败与预算同时到期时，仍由原失败路径清理已确认实例。 */
  p.boundary.snapshot = async () => {
    if (++samples === 2) { now = startedAt + f.input.timeoutMs; throw original; }
    return await snapshot();
  };
  try {
    await assert.rejects(install({ ...f.input, boundary: p.boundary }), (error: any) => {
      assert.equal(error.phase, "process"); assert.equal(error.cause, original); return true;
    });
  } finally { t.mock.restoreAll(); }
  assert.equal(p.calls(), 1);
  assert.equal(p.stopped.length, 1);
  assert.equal(p.stopped[0]!.pid, p.child().pid);
  assert.equal(p.stopped[0]!.executable, f.input.installerPath);
  assert.equal(existsSync(f.candidateDirectory), false);
});

test("installer completion deadline preserves a nonzero exit observed at the deadline", async t => {
  const f = await fixture(), p = processBoundary(f, async () => {}), snapshot = p.boundary.snapshot;
  const startedAt = Date.now(); let now = startedAt, samples = 0;
  t.mock.method(Date, "now", () => now);
  /** 非零退出仍优先于同轮超时，避免用预算错误替换实际退出结果。 */
  p.boundary.snapshot = async () => {
    if (++samples === 2) { p.child().close(7); now = startedAt + f.input.timeoutMs; }
    return await snapshot();
  };
  try {
    await assert.rejects(install({ ...f.input, boundary: p.boundary }), (error: any) => {
      assert.equal(error.phase, "process");
      assert.equal(error.cause.code, "DESKTOP_SHELL_INSTALLER_PROCESS_EXIT_FAILED");
      assert.equal(error.details.exitCode, 7);
      return true;
    });
  } finally { t.mock.restoreAll(); }
  assert.equal(p.stopped.length, 0);
  assert.equal(existsSync(f.candidateDirectory), false);
});

test("installer completion deadline preserves cancellation observed with a successful close", async t => {
  const f = await fixture(), p = processBoundary(f, async () => {}), snapshot = p.boundary.snapshot;
  const controller = new AbortController(), reason = Object.freeze(new Error("controlled cancellation"));
  const startedAt = Date.now(); let now = startedAt, samples = 0;
  t.mock.method(Date, "now", () => now);
  /** 已关闭的同轮取消保原reason，不再终止已结束的实例。 */
  p.boundary.snapshot = async () => {
    if (++samples === 2) { controller.abort(reason); p.child().close(); now = startedAt + f.input.timeoutMs; }
    return await snapshot();
  };
  try {
    await assert.rejects(install({ ...f.input, boundary: p.boundary, signal: controller.signal }), (error: any) => {
      assert.equal(error.phase, "process"); assert.equal(error.cause, reason); return true;
    });
  } finally { t.mock.restoreAll(); }
  assert.equal(p.stopped.length, 0);
  assert.equal(existsSync(f.candidateDirectory), false);
});

test("bad signature rejects before executing any installer", async () => {
  const f = await fixture(), p = processBoundary(f), signature = Buffer.from(f.input.manifest.signature, "base64"); signature[0] ^= 1;
  await assert.rejects(install({ ...f.input, manifest: { ...f.input.manifest, signature: signature.toString("base64") }, boundary: p.boundary }));
  assert.equal(p.calls(), 0); assert.equal(existsSync(f.candidateDirectory), false);
});

test("an installer file alias fails before executing its resolved target", async t => {
  const f = await fixture(), p = processBoundary(f), retained = path.join(f.root, "retained-installer.exe"), realpath = fs.realpath, lstat = fs.lstat;
  await fs.writeFile(retained, f.installer);
  // Windows 无文件符号链接权限时仍按 OS 返回的别名元数据验证执行边界。
  t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => args[0] === f.input.installerPath ? retained : await realpath(...args));
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await lstat(...args);
    if (args[0] === f.input.installerPath) Object.assign(stat, { isSymbolicLink: () => true });
    return stat;
  });
  await assert.rejects(install({ ...f.input, boundary: p.boundary }));
  assert.equal(p.calls(), 0);
});

test("installer bytes changed during preflight are reverified immediately before spawn", async t => {
  const f = await fixture(), p = processBoundary(f), mkdtemp = fs.mkdtemp;
  t.mock.method(fs, "mkdtemp", async (...args: Parameters<typeof fs.mkdtemp>) => {
    const directory = await mkdtemp(...args); await fs.writeFile(f.input.installerPath, Buffer.alloc(f.installer.length)); return directory;
  });
  await assert.rejects(install({ ...f.input, boundary: p.boundary })); assert.equal(p.calls(), 0);
});

test("a changed original INI before spawn starts no installer", async t => {
  const f = await fixture(), p = processBoundary(f), mkdtemp = fs.mkdtemp;
  const changed = { ...f.input.expectedState, previousShellId: null };
  t.mock.method(fs, "mkdtemp", async (...args: Parameters<typeof fs.mkdtemp>) => {
    const directory = await mkdtemp(...args); await fs.writeFile(path.join(f.input.installationDir, "shell-launch.ini"), serializeShellLaunchState(changed)); return directory;
  });
  await assert.rejects(install({ ...f.input, boundary: p.boundary })); assert.equal(p.calls(), 0);
});

test("an installer cached below the temporary parent uses a separate new temporary root", async () => {
  const f = await fixture(), installerPath = path.join(f.input.temporaryParentDir, "cached-installer.exe");
  await fs.rename(f.input.installerPath, installerPath);
  const p = processBoundary(f);
  assert.deepEqual(await install({ ...f.input, installerPath, boundary: p.boundary }), { manifest: f.input.manifest, candidateDirectory: f.candidateDirectory });
  assert.equal(path.dirname(p.options[0].env!.TEMP!), f.input.temporaryParentDir);
  assert.notEqual(p.options[0].env!.TEMP, installerPath); assert.deepEqual(await fs.readFile(installerPath), f.installer);
});

test("a temporary parent containing the installation creates only a separate sibling root", async () => {
  const f = await fixture(), p = processBoundary(f);
  assert.deepEqual(await install({ ...f.input, temporaryParentDir: f.root, boundary: p.boundary }), { manifest: f.input.manifest, candidateDirectory: f.candidateDirectory });
  assert.equal(path.dirname(p.options[0].env!.TEMP!), f.root);
  assert.notEqual(p.options[0].env!.TEMP, f.input.installationDir);
  assert.equal(path.dirname(p.options[0].env!.TEMP!), path.dirname(f.input.installationDir));
});

test("a temporary parent inside the installation is rejected before creating directories", async () => {
  const f = await fixture(), p = processBoundary(f), before = await fs.readdir(f.input.installationDir);
  await assert.rejects(install({ ...f.input, temporaryParentDir: f.input.installationDir, boundary: p.boundary }));
  assert.deepEqual(await fs.readdir(f.input.installationDir), before); assert.equal(p.calls(), 0);
});

test("an existing candidate is reused after installer and entry verification without starting the installer", async () => {
  const f = await fixture(), p = processBoundary(f); await f.materialize();
  assert.deepEqual(await install({ ...f.input, boundary: p.boundary }), { manifest: f.input.manifest, candidateDirectory: f.candidateDirectory });
  assert.equal(p.calls(), 0); assert.equal(p.samples(), 0); assert.deepEqual(await fs.readdir(f.input.temporaryParentDir), []);
});

test("a signed target already in previous is reused without adding another selection policy", async () => {
  const f = await fixture(), p = processBoundary(f); await f.materialize();
  const expectedState = { ...f.input.expectedState, previousShellId: "new" };
  await fs.writeFile(path.join(f.input.installationDir, "shell-launch.ini"), serializeShellLaunchState(expectedState));
  assert.deepEqual(await install({ ...f.input, expectedState, boundary: p.boundary }), { manifest: f.input.manifest, candidateDirectory: f.candidateDirectory });
  assert.equal(p.calls(), 0);
  assert.equal(await fs.readFile(path.join(f.input.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(expectedState));
});

for (const existing of [false, true]) test(`${existing ? "existing" : "new"} candidate with a missing entry explicitly fails and is retained`, async () => {
  const f = await fixture();
  const corrupt = async () => { await f.materialize(); await fs.unlink(path.join(f.candidateDirectory, "resources/app.asar")); };
  if (existing) await corrupt();
  const p = processBoundary(f, async child => { await corrupt(); child.close(); });
  await assert.rejects(install({ ...f.input, boundary: p.boundary })); assert.equal(p.calls(), existing ? 0 : 1); assert.equal(existsSync(f.candidateDirectory), true);
});

test("nonzero close preserves only the correlated safe NSIS diagnostic and business request context", async () => {
  const f = await fixture(), p = processBoundary(f, async (child, args) => {
    child.stdout.write("untrusted output with secret=never-record-this");
    child.stderr.write(`${JSON.stringify({ errorCode: "DESKTOP_SHELL_INSTALL_FAILED", requestId: args[4], shellId: "new", stage: "create-target", win32Error: 32, rootCause: "TARGET_CREATE_FAILED", cleanupWin32Error: 5 })}\n`); child.close(1);
  });
  await assert.rejects(install({ ...f.input, boundary: p.boundary }), (error: any) => {
    assert.equal(error.requestId, f.input.requestId); assert.equal(error.installerRequestId, p.argumentsList[0][4]);
    assert.deepEqual(error.details.diagnostic, { errorCode: "DESKTOP_SHELL_INSTALL_FAILED", requestId: error.installerRequestId, shellId: "new", stage: "create-target", win32Error: 32, rootCause: "TARGET_CREATE_FAILED", cleanupWin32Error: 5 });
    assert.equal(JSON.stringify(error).includes("never-record-this"), false); return true;
  });
});

test("foreign or malformed stderr fails without retaining arbitrary output", async () => {
  const f = await fixture(), secret = "arbitrary-private-output", p = processBoundary(f, async child => { child.stderr.write(secret); child.close(0); });
  await assert.rejects(install({ ...f.input, boundary: p.boundary }), (error: any) => { assert.equal(JSON.stringify(error).includes(secret), false); return true; });
});

for (const field of ["stage", "rootCause"] as const) test(`NSIS ${field} arrays are rejected as an invalid diagnostic structure`, async () => {
  const f = await fixture(), p = processBoundary(f, async (child, args) => {
    const diagnostic: Record<string, unknown> = { errorCode: "DESKTOP_SHELL_INSTALL_FAILED", requestId: args[4], shellId: "new", stage: "create-target", win32Error: 32, rootCause: "TARGET_CREATE_FAILED" };
    diagnostic[field] = [diagnostic[field]]; child.stderr.write(JSON.stringify(diagnostic)); child.close(1);
  });
  await assert.rejects(install({ ...f.input, boundary: p.boundary }), (error: any) => {
    assert.equal(error.details.diagnostic, undefined); assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.some((cause: any) => cause.code === "DESKTOP_SHELL_INSTALLER_PROCESS_DIAGNOSTIC_INVALID"), true); return true;
  });
});

test("a signal already aborted starts no process", async () => {
  const f = await fixture(), p = processBoundary(f), controller = new AbortController(), reason = new Error("controlled abort"); controller.abort(reason);
  await assert.rejects(install({ ...f.input, signal: controller.signal, boundary: p.boundary }), error => containsCause(error, reason)); assert.equal(p.calls(), 0);
});

for (const mode of ["abort", "timeout"]) test(`${mode} cleans the exact installer and known descendant before failing`, async () => {
  const f = await fixture(), controller = new AbortController(), reason = new Error("cancel install");
  const p = processBoundary(f, async child => { p.replaceProcesses([...p.processes(), { pid: 900, parentPid: child.pid, created: Date.now(), executable: path.join(f.input.temporaryParentDir, "owned-child.exe"), commandLine: "controlled descendant" }]); });
  const running = install({ ...f.input, signal: controller.signal, timeoutMs: mode === "timeout" ? 70 : 2_000, boundary: p.boundary });
  if (mode === "abort") { await eventually(() => p.samples() >= 2); controller.abort(reason); }
  await assert.rejects(running, error => mode === "timeout" || containsCause(error, reason));
  assert.deepEqual(p.stopped.map(item => item.pid), [900, 701]); assert.equal(p.child().exitCode, 1);
});

test("query and cleanup failures retain both causes including an undefined primary", async () => {
  const f = await fixture(), cleanup = new Error("cleanup query failed"), p = processBoundary(f, async () => {}); let calls = 0;
  p.boundary.snapshot = async () => { calls++; if (calls === 2) throw undefined; if (calls > 2) { p.child().close(1); throw cleanup; } return structuredClone(p.processes()); };
  await assert.rejects(install({ ...f.input, boundary: p.boundary }), (error: any) => {
    assert.ok(error.cause instanceof AggregateError); assert.equal(error.cause.errors[0], undefined);
    assert.equal(containsCause(error.cause.errors[1], cleanup), true); return true;
  });
  assert.equal(p.stopped.length, 0);
});

test("a child error and independent stop failure are both retained", async () => {
  const f = await fixture(), primary = new Error("installer error"), secondary = new Error("stop failure"), p = processBoundary(f, async child => { child.emit("error", primary); });
  p.boundary.stop = async () => { p.child().close(1); throw secondary; };
  await assert.rejects(install({ ...f.input, boundary: p.boundary }), error => containsCause(error, primary) && containsCause(error, secondary));
});

test("an additional child error during cleanup is retained with the primary", async () => {
  const f = await fixture(), primary = new Error("first process error"), secondary = new Error("cleanup pipe error");
  const p = processBoundary(f, async child => { child.emit("error", primary); });
  p.boundary.stop = async () => { p.child().stderr.emit("error", secondary); p.child().close(1); };
  await assert.rejects(install({ ...f.input, boundary: p.boundary }), error => containsCause(error, primary) && containsCause(error, secondary));
});

test("a descendant stop failure still closes the independently identified installer and retains both causes", async () => {
  const f = await fixture(), primary = new Error("owned process failed"), secondary = new Error("descendant stop failed");
  const p = processBoundary(f, async child => {
    p.replaceProcesses([...p.processes(), { pid: 902, parentPid: child.pid, created: Date.now(), executable: child.spawnfile, commandLine: "known child" }]);
    await eventually(() => p.samples() >= 2); child.emit("error", primary);
  });
  const stop = p.boundary.stop;
  p.boundary.stop = async identity => { if (identity.pid === 902) throw secondary; await stop(identity); };
  await assert.rejects(install({ ...f.input, timeoutMs: 100, boundary: p.boundary }), error => containsCause(error, primary) && containsCause(error, secondary));
  assert.equal(p.child().exitCode, 1); assert.deepEqual(p.stopped.map(item => item.pid), [701]);
});

test("an unobserved descendant after direct process death is never killed or treated as success", async () => {
  const f = await fixture(), p = processBoundary(f, async child => { p.replaceProcesses([{ pid: 901, parentPid: child.pid, created: Date.now(), executable: child.spawnfile, commandLine: "unknown descendant" }]); child.close(1); });
  await assert.rejects(install({ ...f.input, boundary: p.boundary })); assert.equal(p.stopped.length, 0); assert.equal(p.processes()[0].pid, 901);
});

test("a reused installer PID is not stopped", async () => {
  const f = await fixture(), p = processBoundary(f, async child => { const original = p.processes()[0]; child.emit("error", new Error("lost process")); child.close(1);
    p.replaceProcesses([{ ...original, created: original.created + 10, commandLine: "foreign reused PID" }]); });
  await assert.rejects(install({ ...f.input, boundary: p.boundary })); assert.equal(p.stopped.length, 0); assert.equal(p.processes()[0].commandLine, "foreign reused PID");
});

test("bounded output overflow aborts and cleans the owned installer", async () => {
  const f = await fixture(), p = processBoundary(f, async child => { child.stdout.write(Buffer.alloc(65_537)); });
  await assert.rejects(install({ ...f.input, boundary: p.boundary })); assert.deepEqual(p.stopped.map(item => item.pid), [701]);
});

test("a changed complete INI after installation fails without restoring or activating anything", async () => {
  const f = await fixture(), changed = { ...f.input.expectedState, previousShellId: null };
  const p = processBoundary(f, async child => { await f.materialize(); await fs.writeFile(path.join(f.input.installationDir, "shell-launch.ini"), serializeShellLaunchState(changed)); child.close(); });
  await assert.rejects(install({ ...f.input, boundary: p.boundary }));
  assert.equal(await fs.readFile(path.join(f.input.installationDir, "shell-launch.ini"), "utf8"), serializeShellLaunchState(changed)); assert.equal(p.calls(), 1);
});
