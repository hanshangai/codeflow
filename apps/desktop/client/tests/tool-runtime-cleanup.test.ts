import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ExecutableToolDescriptor } from "@codeflowai/shared";
import { ToolRuntimeService } from "../src/orchestration/toolRuntimeService.js";
import { logger } from "../src/logger.js";
import { openClientDb, type ClientDb } from "../src/db/clientDb.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";

const closedFixtureDbs = new Set<ClientDb>();

/** 本例拥有整个工作区；记录真实运行根，退出时只回收该独占 fixture。 */
function fixture(t: test.TestContext) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "codeflow-tool-cleanup-"));
  const workspacePath = path.join(root, "workspace 中文 空格'");
  fs.mkdirSync(workspacePath);
  const otherPath = path.join(root, "other"); fs.mkdirSync(otherPath);
  const gate = new WorkspaceOperationGate(), db = openClientDb({ dbPath: path.join(root, "application.db"), workspaceOperationGate: gate });
  const workspaceId = "cleanup-workspace" as any;
  db.workspaces.upsert({ id: workspaceId, title: "清理😀", path: workspacePath });
  db.workspaces.upsert({ id: "other" as any, title: "其他", path: otherPath });
  const leases: string[] = [];
  const errors: Record<string, unknown>[] = [];
  const applicationErrors: Record<string, unknown>[] = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data: Record<string, unknown>) => { errors.push(data); applicationErrors.push(data); });
  const write = db.writeWorkspaceLog.bind(db);
  t.mock.method(db, "writeWorkspaceLog", ((id, entry) => { errors.push(entry.data as Record<string, unknown>); write(id, entry); }) as typeof db.writeWorkspaceLog);
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", ((directory: fs.PathLike, ...args: any[]) => {
    const result = (mkdir as any)(directory, ...args);
    if (path.dirname(String(directory)) === path.join(workspacePath, ".codeflowai", "tool-runtime")) leases.push(String(directory));
    return result;
  }) as typeof fs.mkdirSync);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (!closedFixtureDbs.delete(db)) db.close();
    assert.equal(path.dirname(root), tempRoot);
    assert.ok(path.basename(root).startsWith("codeflow-tool-cleanup-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, db, gate, workspaceId, workspacePath, otherPath, leases, errors, applicationErrors,
    service: new ToolRuntimeService(workspacePath, { db, workspaceId }) };
}

/** 只读取真实 W 日志文件，验证物理归属及脱敏结果。 */
function workspaceLogs(workspacePath: string): any[] {
  const directory = path.join(workspacePath, ".codeflowai");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith(".log")).flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))) : [];
}

test("real Node execution retains input and source in the registered workspace", async t => {
  const { service, workspacePath, leases } = fixture(t);
  const result = await service.execute(tool({ code: "printJson({ value: INPUT.value, inputPath: process.env.CODEFLOWAI_TOOL_INPUT_PATH, cwd: process.cwd() });" }), { value: "保留😀" }, "current");
  assert.equal(result.ok, true);
  assert.equal(leases.length, 1, "execution must allocate one workspace runtime directory");
  assert.equal(path.dirname(leases[0]), path.join(workspacePath, ".codeflowai", "tool-runtime"));
  assert.deepEqual(result.output, { value: "保留😀", inputPath: path.join(leases[0], "input.json"), cwd: workspacePath });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(leases[0], "input.json"), "utf8")), { value: "保留😀" });
  assert.equal(fs.statSync(path.join(leases[0], "tool.mjs")).isFile(), true);
});

for (const runtime of ["shell", "python", "java"] as const) test(`real ${runtime} consumes input with source and generated artifacts in one retained root`, async t => {
  for (const command of runtime === "java" ? ["javac", "java", process.platform === "win32" ? "powershell" : "bash"] : [runtime === "python" ? "python" : process.platform === "win32" ? "powershell" : "bash"]) {
    const probe = childProcess.spawnSync(command, command === "powershell" ? ["-NoProfile", "-NonInteractive", "-Command", "exit 0"] : [command === "java" ? "-version" : "--version"], { windowsHide: true });
    if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") { t.skip(`本机缺少 ${command}，未验证该语言`); return; }
    if (probe.error) throw probe.error;
    assert.equal(probe.status, 0, probe.stderr.toString());
  }
  const { service, workspacePath, leases } = fixture(t);
  const code = runtime === "shell" ? (process.platform === "win32"
    ? "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\nif ('中文源码' -ne ([string][char]0x4e2d + [char]0x6587 + [char]0x6e90 + [char]0x7801)) { throw 'invalid script encoding' }\n(Get-Content -LiteralPath $env:CODEFLOWAI_TOOL_INPUT_PATH -Raw -Encoding UTF8 | ConvertFrom-Json) | ConvertTo-Json -Compress"
    : 'cat "$CODEFLOWAI_TOOL_INPUT_PATH"')
    : runtime === "python" ? "with open(os.environ['CODEFLOWAI_TOOL_INPUT_PATH'], encoding='utf-8') as source:\n    print_json(json.load(source))"
    : 'import java.nio.file.*; public class ToolMain { static class Nested {} public static void main(String[] args) throws Exception { new Nested(); Runnable task = new Runnable() { public void run() {} }; task.run(); System.out.print(Files.readString(Path.of(System.getenv("CODEFLOWAI_TOOL_INPUT_PATH")))); } }';
  const result = await service.execute(tool({ runtime, code, timeoutMs: 15_000 }), { value: "保留中文" }, "current");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.output, { value: "保留中文" });
  assert.equal(leases.length, 1);
  const source = runtime === "shell" ? process.platform === "win32" ? "tool.ps1" : "tool.sh" : runtime === "python" ? "tool.py" : "ToolMain.java";
  assert.equal(fs.statSync(path.join(leases[0], source)).isFile(), true);
  if (runtime === "shell" && process.platform === "win32") assert.equal(fs.readFileSync(path.join(leases[0], source)).subarray(0, 3).toString("hex"), "efbbbf");
  if (runtime === "java") {
    for (const artifact of ["ToolMain.class", "ToolMain$Nested.class", "ToolMain$1.class", ...(process.platform === "win32" ? ["tool-java.ps1"] : [])]) assert.equal(fs.statSync(path.join(leases[0], artifact)).isFile(), true);
    assert.equal(fs.existsSync(path.join(workspacePath, "ToolMain.class")), false);
    if (process.platform === "win32") assert.equal(fs.readFileSync(path.join(leases[0], "tool-java.ps1")).subarray(0, 3).toString("hex"), "efbbbf");
  }
});

test("concurrent real runs retain distinct files and leave sibling runtime data unchanged", async t => {
  const { service, workspacePath, leases } = fixture(t);
  const parent = path.join(workspacePath, ".codeflowai", "tool-runtime");
  fs.mkdirSync(path.join(parent, "older"), { recursive: true });
  fs.writeFileSync(path.join(parent, "older", "keep.txt"), "older");
  leases.length = 0;
  const results = await Promise.all([service.execute(tool(), { value: "one" }, "current"), service.execute(tool(), { value: "two" }, "current")]);
  assert.deepEqual(results.map(result => result.ok && result.output), [{ value: "one" }, { value: "two" }]);
  assert.equal(new Set(leases).size, 2);
  assert.deepEqual(leases.map(directory => JSON.parse(fs.readFileSync(path.join(directory, "input.json"), "utf8"))), [{ value: "one" }, { value: "two" }]);
  assert.equal(fs.readFileSync(path.join(parent, "older", "keep.txt"), "utf8"), "older");
});

test("direct child success retains input while its real descendant reads it later", async t => {
  const { service, workspacePath, leases } = fixture(t);
  const marker = path.join(workspacePath, "descendant.json");
  const descendant = "const fs=require('node:fs'); setTimeout(()=>fs.writeFileSync(process.env.DESCENDANT_MARKER,fs.readFileSync(process.env.CODEFLOWAI_TOOL_INPUT_PATH)),500);";
  const result = await service.execute(tool({ code: `import { spawn } from 'node:child_process'; import fs from 'node:fs'; const fd=fs.openSync(${JSON.stringify(`${marker}.err`)},'a'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','ignore',fd],env:{...process.env,DESCENDANT_MARKER:${JSON.stringify(marker)}}}); fs.closeSync(fd); child.unref(); printJson({pid:child.pid});` }), { value: "after-close" }, "current");
  assert.equal(result.ok, true);
  const pid = (result.output as { pid: number }).pid;
  let failed = false, failure: unknown;
  try {
    assert.equal(fs.existsSync(path.join(leases[0], "input.json")), true);
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(marker), true, fs.readFileSync(`${marker}.err`, "utf8"));
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), { value: "after-close" });
    assert.equal(await waitForFixtureProcessExit(pid, 5_000), true, "owned descendant must exit before fixture cleanup");
  } catch (error) {
    failed = true; failure = error; throw error;
  } finally {
    try {
      if (!await waitForFixtureProcessExit(pid, 0)) {
        try { process.kill(pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        assert.equal(await waitForFixtureProcessExit(pid, 5_000), true, "owned descendant stop must be confirmed");
      }
    } catch (closing) {
      if (failed) throw new AggregateError([failure, closing], "后代读取验证与所属进程回收均失败", { cause: failure });
      throw closing;
    }
  }
});

/** 只探测本例创建的 PID；ESRCH 明确表示退出，其余故障向上传递。 */
async function waitForFixtureProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
}

test("workspace replacement during original cwd preparation rejects the new physical root", async t => {
  const { service, root, workspacePath } = fixture(t), mkdir = fs.mkdirSync;
  let replaced = false;
  t.mock.method(fs, "mkdirSync", ((target: fs.PathLike, ...args: any[]) => {
    const result = (mkdir as any)(target, ...args);
    if (!replaced && String(target) === workspacePath) {
      replaced = true; fs.renameSync(workspacePath, path.join(root, "saved")); mkdir(workspacePath);
    }
    return result;
  }) as typeof mkdir);
  t.mock.method(childProcess, "spawn", () => assert.fail("replacement workspace must not dispatch")); syncBuiltinESMExports();
  await assert.rejects(service.execute(tool(), {}, "current"), /工具工作区在准备期间已被替换/);
  assert.equal(replaced, true);
  assert.equal(fs.existsSync(path.join(workspacePath, ".codeflowai", "tool-runtime")), false);
});

for (const boundary of ["workspace", ".codeflowai", "parent", "run"] as const) test(`directory identity replacement rejects before dispatch (${boundary})`, async t => {
  const { service, root, workspacePath } = fixture(t);
  const open = fs.openSync;
  let replaced = false;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    if (!replaced && String(args[0]).endsWith(`${path.sep}input.json`)) {
      replaced = true;
      const directory = boundary === "workspace" ? workspacePath : boundary === ".codeflowai" ? path.join(workspacePath, ".codeflowai")
        : boundary === "parent" ? path.join(workspacePath, ".codeflowai", "tool-runtime") : path.dirname(String(args[0]));
      fs.renameSync(directory, path.join(root, "saved"));
      fs.mkdirSync(directory);
    }
    return open(...args);
  });
  t.mock.method(childProcess, "spawn", () => assert.fail("replaced directory must not dispatch")); syncBuiltinESMExports();
  await assert.rejects(service.execute(tool(), {}, "current"));
  assert.equal(replaced, true);
});

for (const boundary of ["parent", "run"] as const) test(`runtime junction rejects before input writes or dispatch (${boundary})`, async t => {
  const { service, root, workspacePath } = fixture(t);
  const outside = path.join(root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  const parent = path.join(workspacePath, ".codeflowai", "tool-runtime");
  if (boundary === "parent") { fs.mkdirSync(path.dirname(parent)); fs.symlinkSync(outside, parent, "junction"); }
  else {
    const mkdir = fs.mkdirSync;
    t.mock.method(fs, "mkdirSync", ((target: fs.PathLike, ...args: any[]) => {
      if (path.dirname(String(target)) === parent) { fs.symlinkSync(outside, target, "junction"); return undefined; }
      return (mkdir as any)(target, ...args);
    }) as typeof mkdir);
  }
  t.mock.method(childProcess, "spawn", () => assert.fail("junction must not dispatch")); syncBuiltinESMExports();
  await assert.rejects(service.execute(tool(), {}, "current"));
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
});

for (const boundary of ["hardlink", "symlink", "replacement"] as const) test(`managed input identity rejects before dispatch (${boundary})`, async t => {
  const { service, root } = fixture(t);
  const outside = path.join(root, "outside.txt"); fs.writeFileSync(outside, "outside");
  const open = fs.openSync, write = fs.writeFileSync;
  let filePath: string | undefined, inputFd: number | undefined;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    if (String(args[0]).endsWith(`${path.sep}input.json`)) {
      filePath = String(args[0]);
      if (boundary === "hardlink") fs.linkSync(outside, filePath);
      if (boundary === "symlink") fs.symlinkSync(outside, filePath, "file");
    }
    const fd = open(...args); if (String(args[0]) === filePath) inputFd = fd; return fd;
  });
  if (boundary === "replacement") t.mock.method(fs, "writeFileSync", ((file: fs.PathOrFileDescriptor, ...args: any[]) => {
    const result = (write as any)(file, ...args);
    if (file === inputFd) { fs.renameSync(filePath!, path.join(root, "saved-input")); fs.writeFileSync(filePath!, "replacement"); }
    return result;
  }) as typeof write);
  t.mock.method(childProcess, "spawn", () => assert.fail("replaced input must not dispatch")); syncBuiltinESMExports();
  await assert.rejects(service.execute(tool(), {}, "current"));
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
});

test("post-dispatch identity failure cannot hide the original process cause", async t => {
  const { service, leases, root, errors } = fixture(t), child = controlledChild(t), primary = new Error("process-root");
  const running = service.execute(tool(), {}, "current");
  fs.renameSync(path.join(leases[0], "input.json"), path.join(root, "saved-input"));
  fs.writeFileSync(path.join(leases[0], "input.json"), "changed");
  child.emit("error", primary); child.emit("close", -1, null);
  await assert.rejects(running, error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0].cause, primary); assert.equal(error.cause, error.errors[0]);
    assert.ok(error.errors[1] instanceof Error); return true;
  });
  assert.equal(errors.length, 1); assert.equal(errors[0].errorCode, "TOOL_RUNTIME_IDENTITY_FAILED");
});

test("real Git excludes retained artifacts while project files stay visible", async t => {
  const { service, workspacePath, leases } = fixture(t);
  childProcess.execFileSync("git", ["init", "--quiet"], { cwd: workspacePath, windowsHide: true });
  assert.equal((await service.execute(tool(), {}, "current")).ok, true);
  const relative = path.relative(workspacePath, leases[0]).split(path.sep).join("/");
  const ignored = childProcess.execFileSync("git", ["check-ignore", "--no-index", "--", `${relative}/input.json`, `${relative}/tool.mjs`], { cwd: workspacePath, windowsHide: true }).toString();
  assert.equal(ignored.trim().split(/\r?\n/).length, 2);
  fs.writeFileSync(path.join(workspacePath, "visible.txt"), "visible");
  const status = childProcess.execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspacePath, windowsHide: true }).toString();
  assert.match(status, /visible.txt/); assert.doesNotMatch(status, /tool-runtime/);
});

test("already tracked private runtime rejects before allocation and dispatch", async t => {
  const { service, workspacePath, leases } = fixture(t);
  childProcess.execFileSync("git", ["init", "--quiet"], { cwd: workspacePath, windowsHide: true });
  const relative = ".codeflowai/tool-runtime/older/input.json";
  fs.mkdirSync(path.dirname(path.join(workspacePath, relative)), { recursive: true }); fs.writeFileSync(path.join(workspacePath, relative), "tracked");
  childProcess.execFileSync("git", ["add", "--", relative], { cwd: workspacePath, windowsHide: true });
  leases.length = 0;
  t.mock.method(childProcess, "spawn", () => assert.fail("tracked private data must not dispatch")); syncBuiltinESMExports();
  await assert.rejects(service.execute(tool(), {}, "current"), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal((error.errors[0] as Error & { code: string }).code, "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
    assert.equal(error.cause, error.errors[0]); assert.ok(error.errors[1] instanceof Error); return true;
  });
  assert.equal(leases.length, 0); assert.equal(fs.readFileSync(path.join(workspacePath, relative), "utf8"), "tracked");
});

test("failed real execution logs only to registered A with per-call parent and turn", async t => {
  const { service, workspacePath, otherPath, leases, applicationErrors } = fixture(t);
  const result = await service.execute(tool({ code: "import fs from 'node:fs'; fs.appendFileSync('once.txt','once'); process.exit(17);" }),
    { value: "SECRET_INPUT" }, "current", { requestId: "父请求😀", turnId: "turn-one" });
  assert.equal(result.ok, false);
  const logs = workspaceLogs(workspacePath);
  assert.equal(logs.length, 1); assert.equal(workspaceLogs(otherPath).length, 0); assert.equal(applicationErrors.length, 0);
  assert.equal(logs[0].parentRequestId, "父请求😀"); assert.equal(logs[0].turnId, "turn-one");
  assert.equal(logs[0].workspaceId, "cleanup-workspace"); assert.match(logs[0].requestId, /^tool-runtime:/);
  assert.equal(JSON.stringify(logs).includes("SECRET_"), false);
  assert.equal(fs.readFileSync(path.join(workspacePath, "once.txt"), "utf8"), "once");
  assert.equal(fs.existsSync(path.join(leases[0], "input.json")), true);
});

/** 完整工具描述符只运行本机 Node，避免依赖外部服务或其他脚本运行时。 */
function tool(overrides: Partial<ExecutableToolDescriptor> = {}): ExecutableToolDescriptor {
  return {
    toolsetId: "cleanup-toolset" as any, toolsetName: "清理测试", toolId: "cleanup-tool" as any,
    name: "清理测试工具", alias: null, description: "测试临时目录清理", runtime: "node",
    usageGuidance: null, invocationHint: null, code: "printJson({ value: INPUT.value });",
    inputSchema: null, outputSchema: null, timeoutMs: 5_000, workingDirectory: ".",
    permissions: { requiresWrite: false }, envPolicy: { inheritWorkspaceEnv: true, extraEnv: null },
    required: false, ...overrides,
  };
}

/** 仅在真实输入 fd 写入边界注入故障，其余文件和日志仍执行真实操作。 */
function denyInputWrite(t: test.TestContext, error: unknown): void {
  const open = fs.openSync, write = fs.writeFileSync;
  let inputFd: number | undefined;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    const fd = open(...args);
    if (String(args[0]).endsWith(`${path.sep}input.json`)) inputFd = fd;
    return fd;
  });
  t.mock.method(fs, "writeFileSync", ((file: fs.PathOrFileDescriptor, ...args: any[]) => {
    if (file === inputFd) throw error;
    return (write as any)(file, ...args);
  }) as typeof write);
}

/** 仅替换原 spawn 边界，文件准备、execute 消费和 finally 仍执行真实代码。 */
function controlledChild(t: test.TestContext, pid: number | null = 43123) {
  const child = Object.assign(new EventEmitter(), {
    pid: pid ?? undefined, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null, killed: false,
    kill: (_signal?: NodeJS.Signals): boolean => true,
  });
  t.mock.method(childProcess, "spawn", (() => child) as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  return child;
}

/** 排空本次执行的 Promise 微任务，避免用真实时间猜测事件结算。 */
async function flushExecution(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("child error cannot settle or delete input before close and close zero cannot hide it", async t => {
  const { service, leases, errors } = fixture(t);
  const child = controlledChild(t), primary = Object.assign(new Error("private-child-error"), { code: "EIO" });
  let settled = false;
  const running = service.execute(tool(), { value: "private-input" }, "current");
  const outcome = running.then(result => { settled = true; return { result }; }, (error: unknown) => { settled = true; return { error }; });
  try {
    child.emit("error", primary);
    await flushExecution();
    assert.equal(settled, false, "error is not a close acknowledgement");
    assert.equal(fs.existsSync(path.join(leases[0], "input.json")), true);
  } finally { child.emit("close", 0, null); await outcome; }
  const result = await outcome;
  assert.ok("error" in result && result.error instanceof Error);
  assert.equal((result.error as Error & { code: string }).code, "TOOL_EXECUTION_FAILED");
  assert.equal(result.error.cause, primary);
  assert.equal(fs.existsSync(leases[0]), true, "spawned child tree remains unconfirmed");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].retainedDirectory, leases[0]);
  assert.equal(JSON.stringify(errors).includes("private-child-error"), false);
  assert.equal(JSON.stringify(errors).includes("private-input"), false);
});

for (const mode of ["false", "throw", "close-then-false", "close-then-throw"] as const) {
  test(`timeout stop ${mode} remains a failure even after close`, async t => {
    const { service, leases, errors } = fixture(t);
    const child = controlledChild(t), primary = Object.assign(new Error("private-stop-error"), { code: "EACCES" });
    child.kill = () => {
      if (mode.startsWith("close-then")) child.emit("close", 0, null);
      if (mode.endsWith("throw")) throw primary;
      return false;
    };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const running = service.execute(tool({ timeoutMs: 1_000 }), {}, "current");
    const failure = assert.rejects(running, error => {
      assert.ok(error instanceof Error);
      const result = error as Error & { code: string; retryable: boolean; retainedDirectory: string };
      assert.equal(result.code, "TOOL_RUNTIME_STOP_FAILED");
      assert.equal(result.retryable, false);
      assert.equal(result.retainedDirectory, leases[0]);
      if (mode.endsWith("throw")) assert.equal(result.cause, primary);
      return true;
    });
    try { t.mock.timers.tick(1_000); }
    finally { child.emit("close", 0, null); await failure; }
    assert.equal(fs.existsSync(leases[0]), true);
    assert.equal(errors.length, 1);
    assert.equal(JSON.stringify(errors).includes("private-stop-error"), false);
  });
}

test("timeout keeps input after direct child close because its tree is unconfirmed", async t => {
  const { service, leases, errors } = fixture(t);
  const child = controlledChild(t);
  child.kill = () => { child.emit("close", null, "SIGTERM"); return true; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = service.execute(tool({ timeoutMs: 1_000 }), { value: "still-readable" }, "current");
  const failure = assert.rejects(running, { code: "TOOL_TIMEOUT", retryable: false });
  t.mock.timers.tick(1_000);
  await failure;
  assert.equal(JSON.parse(fs.readFileSync(path.join(leases[0], "input.json"), "utf8")).value, "still-readable");
  assert.equal(errors.length, 1);
});

test("unconfirmed close has a five second bound and late close never deletes input", async t => {
  const { service, leases, errors } = fixture(t);
  const child = controlledChild(t), primary = new Error("private-close-error");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const running = service.execute(tool(), {}, "current");
  void running.then(() => { settled = true; }, () => { settled = true; });
  const failure = assert.rejects(running, error => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code: string }).code, "TOOL_RUNTIME_CLOSE_UNCONFIRMED");
    assert.equal(error.cause, primary);
    return true;
  });
  child.emit("error", primary);
  t.mock.timers.tick(4_999);
  await flushExecution();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await failure;
  child.emit("close", 0, null);
  await flushExecution();
  assert.equal(fs.existsSync(leases[0]), true);
  assert.equal(errors.length, 1);
});

/** 未确认关闭已交付失败后，继续排空管道而不再转换输出、重复结算或清理。 */
test("settled close failure drains late stdout and stderr without materializing output", async t => {
  const { service, leases, errors } = fixture(t);
  const child = controlledChild(t);
  child.kill = () => false;
  let materialized = 0, settlements = 0, removals = 0;
  const chunk = { toString() { materialized++; return "private-late-output"; } };
  const rm = fs.rmSync;
  t.mock.method(fs, "rmSync", (target: fs.PathLike, options: fs.RmOptions) => {
    if (leases.includes(String(target))) removals++;
    return rm(target, options);
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const outcome = service.execute(tool({ timeoutMs: 1_000 }), {}, "current").then(
    result => { settlements++; return { result }; },
    (error: unknown) => { settlements++; return { error }; },
  );
  child.stdout.emit("data", chunk);
  child.stderr.emit("data", chunk);
  assert.equal(materialized, 2, "live output is still collected before settlement");
  t.mock.timers.tick(1_000);
  t.mock.timers.tick(5_000);
  const result = await outcome;
  assert.ok("error" in result && result.error instanceof Error);
  assert.equal((result.error as Error & { code: string }).code, "TOOL_RUNTIME_CLOSE_UNCONFIRMED");
  try {
    for (let index = 0; index < 8; index++) {
      child.stdout.emit("data", chunk);
      child.stderr.emit("data", chunk);
    }
    assert.equal(materialized, 2, "settled output must never be materialized again");
    child.stdout.write(Buffer.alloc(32_768));
    child.stderr.write(Buffer.alloc(32_768));
    assert.equal(child.stdout.readableLength, 0);
    assert.equal(child.stderr.readableLength, 0);
  } finally { child.emit("close", 0, null); await flushExecution(); }
  assert.equal(settlements, 1);
  assert.equal(errors.length, 1);
  assert.equal(removals, 0);
  assert.equal(fs.existsSync(path.join(leases[0], "input.json")), true);
  assert.equal(JSON.stringify(errors).includes("private-late-output"), false);
});

test("unspawned error still waits for close then retains input and preserves its cause", async t => {
  const { service, leases, errors } = fixture(t);
  const child = controlledChild(t, null), primary = Object.assign(new Error("private-spawn-error"), { code: "ENOENT" });
  const running = service.execute(tool(), {}, "current");
  const failure = assert.rejects(running, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, primary);
    assert.equal((error as Error & { retainedDirectory?: string }).retainedDirectory, leases[0]);
    return true;
  });
  child.emit("error", primary);
  assert.equal(fs.existsSync(leases[0]), true);
  child.emit("close", -1, null);
  await failure;
  assert.equal(fs.existsSync(leases[0]), true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].retainedDirectory, leases[0]);
});

test("synchronous spawn failure retains input and the original failure", async t => {
  const { service, leases } = fixture(t);
  const primary = new Error("synchronous-spawn-failure");
  t.mock.method(childProcess, "spawn", () => { throw primary; });
  syncBuiltinESMExports();
  await assert.rejects(service.execute(tool(), {}, "current"), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, primary);
    assert.equal((error as Error & { retainedDirectory?: string }).retainedDirectory, leases[0]);
    return true;
  });
  assert.equal(fs.existsSync(leases[0]), true);
});

test("undefined stop cause remains present after close", async t => {
  const { service, leases } = fixture(t);
  const child = controlledChild(t);
  child.kill = () => { throw undefined; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = service.execute(tool({ timeoutMs: 1_000 }), {}, "current");
  const failure = assert.rejects(running, error => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code: string }).code, "TOOL_RUNTIME_STOP_FAILED");
    assert.equal(Object.prototype.hasOwnProperty.call(error, "cause"), true);
    assert.equal(error.cause, undefined);
    return true;
  });
  t.mock.timers.tick(1_000);
  child.emit("close", -1, null);
  await failure;
  assert.equal(fs.existsSync(leases[0]), true);
});

test("undefined preparation cause remains an explicit failure with the preparation event", async t => {
  const { service, leases, errors } = fixture(t);
  denyInputWrite(t, undefined);
  await service.execute(tool(), {}, "current").then(() => assert.fail("preparation must fail"), error => assert.equal(error, undefined));
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].event, { category: "tool", action: "prepare", outcome: "fail" });
  assert.deepEqual(errors[0].operationCause, { name: "NonError" });
  assert.equal(fs.existsSync(leases[0]), true);
});

test("unspawned error and logging failures preserve both original causes", async t => {
  const { service, leases, db } = fixture(t);
  const child = controlledChild(t, null), primary = Object.assign(new Error("private-spawn"), { code: "ENOENT" });
  const logging = new Error("private-log");
  t.mock.method(db, "writeWorkspaceLog", () => { throw logging; });
  const running = service.execute(tool(), {}, "current");
  const failure = assert.rejects(running, error => {
    assert.ok(error instanceof AggregateError);
    const [executionFailure, logCause] = error.errors;
    assert.equal(logCause, logging);
    assert.equal(executionFailure.cause, primary);
    assert.equal(error.cause, executionFailure);
    assert.equal((error as AggregateError & { code: string }).code, "TOOL_EXECUTION_FAILED");
    return true;
  });
  child.emit("error", primary);
  child.emit("close", -1, null);
  await failure;
  assert.equal(fs.existsSync(leases[0]), true);
});

test("error during timeout stop preserves process and kill causes in one safe log", async t => {
  const { service, leases, errors } = fixture(t);
  const child = controlledChild(t), primary = Object.assign(new Error("secret-process-text"), { code: "EIO" });
  const stopping = Object.assign(new Error("secret-stop-text"), { code: "EACCES" });
  child.kill = () => { child.emit("error", primary); throw stopping; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = service.execute(tool({ timeoutMs: 1_000 }), {}, "current");
  const failure = assert.rejects(running, error => {
    assert.ok(error instanceof Error && error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [primary, stopping]);
    return true;
  });
  t.mock.timers.tick(1_000);
  child.emit("close", -1, null);
  await failure;
  assert.equal(fs.existsSync(leases[0]), true);
  assert.equal(errors.length, 1);
  const log = JSON.stringify(errors);
  assert.ok(log.includes("EIO") && log.includes("EACCES"));
  assert.equal(log.includes("secret-"), false);
});

for (const mode of ["signal", "stop-failed"] as const) test(`timeout ${mode} without close retains failure context after the fixed budget`, async t => {
  const { service, leases, errors } = fixture(t);
  const child = controlledChild(t), primary = Object.assign(new Error("private-timeout-stop"), { code: "EACCES" });
  child.kill = () => { if (mode === "stop-failed") throw primary; return true; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = service.execute(tool({ timeoutMs: 1_000 }), {}, "current");
  const failure = assert.rejects(running, error => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code: string }).code, "TOOL_RUNTIME_CLOSE_UNCONFIRMED");
    if (mode === "stop-failed") assert.equal(error.cause, primary);
    return true;
  });
  t.mock.timers.tick(1_000);
  t.mock.timers.tick(5_000);
  await failure;
  child.emit("close", -1, null);
  await flushExecution();
  assert.equal(fs.existsSync(leases[0]), true);
  assert.equal(errors.length, 1);
});

test("successful script keeps all runtime files without invoking automatic removal", async (t) => {
  const { service, workspacePath, leases, errors } = fixture(t);
  const rm = fs.rmSync;
  t.mock.method(fs, "rmSync", (target: fs.PathLike, options: fs.RmOptions) => {
    if (leases.includes(String(target))) assert.fail("runtime files must be retained");
    return rm(target, options);
  });
  const result = await service.execute(tool({
    code: "import fs from 'node:fs'; fs.appendFileSync('executed.txt', 'once'); printJson({ value: INPUT.value });",
  }), { value: "input-value" }, "current");
  assert.equal(result.ok, true);
  assert.equal(errors.length, 0);
  assert.equal(fs.readFileSync(path.join(workspacePath, "executed.txt"), "utf8"), "once");
  assert.equal(leases.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(leases[0], "input.json"), "utf8")), { value: "input-value" });
});

test("input serialization failure retains the allocated directory and rethrows the original error", async (t) => {
  const { service, leases, errors } = fixture(t);
  const primary = Object.assign(new Error("input serialization failed"), { code: "INPUT_SERIALIZATION_FAILED" });
  await assert.rejects(service.execute(tool(), { toJSON() { throw primary; } }, "current"), (error: unknown) => error === primary);
  assert.equal(leases.length, 1);
  assert.equal(fs.existsSync(leases[0]), true);
  assert.equal(errors.length, 1);
});

test("input write and close failures preserve both original error objects", async (t) => {
  const { service, leases } = fixture(t);
  const primary = Object.assign(new Error("input write failed"), { code: "EIO" });
  const closing = Object.assign(new Error("input close failed"), { code: "EIO" });
  denyInputWrite(t, primary);
  const open = fs.openSync, close = fs.closeSync;
  let inputFd: number | undefined;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    const fd = open(...args); if (String(args[0]).endsWith(`${path.sep}input.json`)) inputFd = fd; return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => { close(fd); if (fd === inputFd) { inputFd = undefined; throw closing; } });
  await assert.rejects(service.execute(tool(), {}, "current"), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, closing]);
    assert.equal(error.cause, primary);
    return true;
  });
  assert.equal(leases.length, 1);
  assert.equal(fs.existsSync(path.join(leases[0], "tool.mjs")), false);
});

for (const scenario of [
  { name: "execution", code: "process.exit(17);", outputSchema: null, expectedCode: "TOOL_EXECUTION_FAILED", expectedStage: "executing", expectedExitCode: 17 },
  { name: "output", code: "printJson({});", outputSchema: '{"type":"object","required":["value"]}', expectedCode: "TOOL_OUTPUT_INVALID", expectedStage: "parsing", expectedExitCode: 0 },
]) {
  test(`${scenario.name} failure remains visible with retained runtime files`, async (t) => {
    const { service, leases, errors } = fixture(t);
    const result = await service.execute(tool({ code: scenario.code, outputSchema: scenario.outputSchema }), {}, "current");
    assert.equal(result.ok, false); if (result.ok) assert.fail("scenario must fail");
    assert.equal(result.code, scenario.expectedCode);
    assert.equal(result.stage, scenario.expectedStage);
    assert.equal(result.exitCode, scenario.expectedExitCode);
    assert.equal(errors.length, 1);
    assert.equal(fs.existsSync(path.join(leases[0], "input.json")), true);
    assert.equal(leases.length, 1);
  });
}

test("working directory rejection fails before allocating runtime files or running the script", async (t) => {
  const { service, workspacePath, leases } = fixture(t);
  await assert.rejects(service.execute(tool({ workingDirectory: "../outside" }), {}, "current"), /工具工作目录越界/);
  assert.equal(leases.length, 0);
  assert.equal(fs.existsSync(path.join(workspacePath, ".codeflowai", "tool-runtime")), false);
});

test("normal script output is unchanged and all runtime files are retained", async (t) => {
  const { service, leases } = fixture(t);
  const result = await service.execute(tool(), { value: "input-value" }, "current");
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { value: "input-value" });
  assert.equal(result.exitCode, 0);
  assert.equal(leases.length, 1);
  assert.equal(fs.existsSync(path.join(leases[0], "tool.mjs")), true);
});

for (const primary of [undefined, null, false, 0, "", NaN]) test(`falsy preparation cause survives fixed log failure ${String(primary)}`, async t => {
  const { service, leases, db } = fixture(t), logging = new Error("logging");
  denyInputWrite(t, primary); t.mock.method(db, "writeWorkspaceLog", () => { throw logging; });
  await assert.rejects(service.execute(tool(), {}, "current"), (error: any) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], logging);
    assert.equal(Object.is(error.errors[0], primary), true);
    assert.equal(Object.is(error.cause, primary), true); return true;
  });
  assert.equal(fs.existsSync(leases[0]), true);
});

for (const mode of ["getters", "reflection", "array-reflection"] as const) test(`failure diagnostic never executes unknown code ${mode}`, async t => {
  const { service, leases, db, errors } = fixture(t), reflection = new Error("reflection-root");
  let executed = 0, writes = 0;
  const trap = () => { executed++; throw new Error("unknown executed"); };
  let primary: unknown;
  if (mode === "reflection") primary = new Proxy({}, { getOwnPropertyDescriptor() { throw reflection; }, get: trap });
  else if (mode === "array-reflection") primary = Object.assign(new Error("SECRET"), { errors: new Proxy([], { getOwnPropertyDescriptor() { throw reflection; }, get: trap }) });
  else {
    const array: unknown[] = []; Object.defineProperty(array, "0", { get: trap }); array.length = 1;
    primary = Object.defineProperties(new Error("SECRET"), { code: { get: trap }, name: { get: trap }, cause: { get: trap }, errors: { value: array }, toString: { value: trap } });
  }
  const fixedWrite = db.writeWorkspaceLog.bind(db);
  denyInputWrite(t, primary);
  t.mock.method(db, "writeWorkspaceLog", ((id, entry) => { writes++; fixedWrite(id, entry); }) as typeof db.writeWorkspaceLog);
  await assert.rejects(service.execute(tool(), {}, "current"), (error: any) => {
    if (mode === "getters") assert.equal(error, primary);
    else { assert.equal(error.errors[0], primary); assert.equal(error.errors[1], reflection); assert.equal(error.cause, primary); }
    return true;
  });
  assert.equal(executed, 0); assert.equal(writes, mode === "getters" ? 1 : 0);
  assert.equal(JSON.stringify(errors).includes("SECRET"), false);
  assert.equal(fs.existsSync(leases[0]), true);
});

test("script workspace mismatch fails before allocating input or spawning", async t => {
  const { db, otherPath, leases } = fixture(t);
  const service = new ToolRuntimeService(otherPath, { db, workspaceId: "cleanup-workspace" as any });
  const spawn = t.mock.method(childProcess, "spawn", () => assert.fail("invalid identity must not spawn")); syncBuiltinESMExports();
  await assert.rejects(service.execute(tool(), {}, "current"), /工具工作区/);
  assert.equal(leases.length, 0); assert.equal(spawn.mock.callCount(), 0);
});

test("migration gate rejects fixed logging with all causes while another workspace stays usable", async t => {
  const { service, db, gate, workspaceId, otherPath, applicationErrors } = fixture(t), primary = new Error("input-write");
  denyInputWrite(t, primary);
  const release = await gate.acquireMigration(workspaceId, "tool-migration");
  try {
    await assert.rejects(service.execute(tool(), {}, "current"), (error: any) => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], primary);
      assert.equal(error.cause, error.errors[0]); assert.ok(error.errors[1] instanceof Error); return true;
    });
    db.writeWorkspaceLog("other" as any, { level: "error", tag: "other", message: "other stays usable" });
    assert.equal(workspaceLogs(otherPath).length, 1); assert.equal(applicationErrors.length, 0);
  } finally { release(); }
});

test("unknown diagnostic scalar cannot smuggle input through code or syscall", async t => {
  const { service, errors } = fixture(t);
  const primary = Object.assign(new Error("SECRET_TEXT"), { code: "TOOL_SECRET_TOKEN", syscall: "SECRET_SYSCALL", name: "SECRET_NAME" });
  denyInputWrite(t, primary);
  await assert.rejects(service.execute(tool(), {}, "current"), error => error === primary);
  assert.equal(JSON.stringify(errors).includes("SECRET_"), false);
});

test("unsafe runtime and log root preserves both causes without fallback while another workspace stays writable", async t => {
  const { service, workspacePath, otherPath, db, leases, applicationErrors } = fixture(t);
  fs.writeFileSync(path.join(workspacePath, ".codeflowai"), "unsafe-root");
  await assert.rejects(service.execute(tool(), {}, "current"), (error: any) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0].code, "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE"); assert.equal(error.cause, error.errors[0]);
    assert.ok(error.errors[1] instanceof Error); return true;
  });
  assert.equal(applicationErrors.length, 0); assert.equal(fs.readFileSync(path.join(workspacePath, ".codeflowai"), "utf8"), "unsafe-root");
  assert.equal(leases.length, 0);
  db.writeWorkspaceLog("other" as any, { level: "error", tag: "other", message: "other stays usable" }); assert.equal(workspaceLogs(otherPath).length, 1);
});

test("unconfirmed log close fences only its workspace and preserves close failure after actual fd release", async t => {
  const { service, workspaceId, otherPath, db, applicationErrors } = fixture(t), primary = new Error("input-write"), logging = new Error("close-root");
  denyInputWrite(t, primary);
  const open = fs.openSync, close = fs.closeSync; let fd: number | undefined;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => { const result = open(...args); if (String(args[0]).endsWith(".log")) fd = result; return result; });
  const failedClose = t.mock.method(fs, "closeSync", (value: number) => { if (value === fd) throw logging; close(value); });
  await assert.rejects(service.execute(tool(), {}, "current"), (error: any) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], primary); assert.equal(error.errors[1], logging); return true;
  });
  assert.equal(applicationErrors.length, 0);
  assert.throws(() => db.writeWorkspaceLog(workspaceId, { level: "error", tag: "probe", message: "fenced" }));
  failedClose.mock.restore(); assert.notEqual(fd, undefined); close(fd!);
  db.writeWorkspaceLog("other" as any, { level: "error", tag: "probe", message: "available" }); assert.equal(workspaceLogs(otherPath).length, 1);
  assert.throws(() => db.close(), (error: any) => error.message === "CLIENT_DB_CLOSE_FAILED" && error.errors[0].cause === logging);
  closedFixtureDbs.add(db);
});

test("normal exit17 remains explicit ok false with original execution fields", async t => {
  const { service, leases, errors } = fixture(t);
  const result = await service.execute(tool({ code: "process.stdout.write('out'); process.stderr.write('err'); process.exit(17);" }), {}, "current");
  assert.equal(result.ok, false); if (result.ok) assert.fail("exit17 must fail");
  assert.equal(result.code, "TOOL_EXECUTION_FAILED"); assert.equal(result.stage, "executing"); assert.equal(result.retryable, false);
  assert.equal(result.exitCode, 17); assert.equal(result.stdout, "out"); assert.equal(result.stderr, "err");
  assert.equal(errors.length, 1); assert.equal(fs.existsSync(leases[0]), true);
});

test("preparation cannot impersonate owned Skill diagnostic to skip preparation logging", async t => {
  const { service, db } = fixture(t);
  const primary = Object.assign(new Error("prepared-input-root"), { code: "SKILL_RUNTIME_FAILURE_LOG_FAILED" });
  denyInputWrite(t, primary);
  const log = t.mock.method(db, "writeWorkspaceLog", () => {});
  await assert.rejects(service.execute(tool(), {}, "current"), (error: any) => {
    assert.equal(error, primary); return true;
  });
  assert.equal(log.mock.callCount(), 1);
});

test("database closing after process start preserves process and fixed log failure", async t => {
  const { service, db, leases, applicationErrors } = fixture(t), child = controlledChild(t), primary = new Error("process-root");
  const pending = service.execute(tool(), {}, "current");
  db.close(); closedFixtureDbs.add(db); child.emit("error", primary); child.emit("close", 0, null);
  await assert.rejects(pending, (error: any) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0].cause, primary); assert.ok(error.errors[1] instanceof Error);
    assert.equal(error.cause, error.errors[0]); return true;
  });
  assert.equal(applicationErrors.length, 0);
  assert.equal(fs.existsSync(leases[0]), true);
});
