import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const compiler = process.env.CF_NSIS_COMPILER;
const skip = process.platform !== "win32" ? "Windows NSIS runtime required" : !compiler ? "Set CF_NSIS_COMPILER to run native contracts" : false;
const source = fileURLToPath(new URL("../build/shell-launcher.nsi", import.meta.url));

/** 仅转义 NSIS 字面路径，参数由 spawn 直接传递。 */
function nsisPath(value: string): string {
  assert.doesNotMatch(value, /[\r\n\0]/u);
  return value.replaceAll("$", "$$").replaceAll('"', '$\\"');
}

/** 等实际 close，超时只终止本次所持进程句柄。 */
async function execute(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    child.stdout.on("data", bytes => { stdout += bytes.toString("utf8"); });
    child.stderr.on("data", bytes => { stderr += bytes.toString("utf8"); });
    child.once("error", error => { failure = error; });
    child.once("close", (code, signal) => {
      if (failure) reject(failure);
      else if (signal) reject(new Error(`NSIS_LAUNCHER_FIXTURE_INTERRUPTED:${signal}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

/** 仅等待夹具自己的原子标记；子程序自有有界退出，不扫描或结束其他进程。 */
async function waitForFile(file: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { await fs.access(file); return; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    assert.ok(Date.now() < deadline, `fixture did not finish: ${file}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** 编译真实启动器和只写标记的子程序；从不安装、卸载或运行产品。 */
async function fixture(exitCode = 0, ordinary = false, fault?: "wait" | "result" | "diagnostic" | "argument-read") {
  const parent = process.env.CF_NSIS_RUNTIME_ROOT ?? os.tmpdir();
  assert.ok(path.isAbsolute(parent));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "nsis-launcher-lifecycle-"));
  const temporary = path.join(root, "temporary"), shell = path.join(root, "shells/current");
  await fs.mkdir(temporary); await fs.mkdir(shell, { recursive: true });
  const env = { ...process.env, TEMP: temporary, TMP: temporary };
  /** 保留原始编译输入和输出，每次输出仅创建一次。 */
  async function compile(input: string, args: string[], name: string) {
    const result = await execute(compiler!, ["/V2", ...args, "/INPUTCHARSET", "UTF8", input], env);
    await fs.writeFile(path.join(root, `${name}-compile.log`), result.stdout + result.stderr, { encoding: "utf8", flag: "wx" });
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
  const child = path.join(root, "child.nsi");
  await fs.writeFile(child, `Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "Lifecycle fixture"
OutFile "${nsisPath(path.join(shell, "CodeFlowAI.exe"))}"
!include "FileFunc.nsh"
Section
  \${GetParameters} $0
  FileOpen $1 "$EXEDIR\\arguments.txt" w
  FileWrite $1 "$0"
  FileClose $1
  ${ordinary ? `StrCpy $2 0
  wait_release:
    IfFileExists "$EXEDIR\\release.txt" child_done
    Sleep 25
    IntOp $2 $2 + 1
    IntCmp $2 400 child_timeout wait_release child_timeout
  child_timeout:
    SetErrorLevel 99
    Quit
  child_done:` : "Sleep 250"}
  FileOpen $1 "$EXEDIR\\done.txt" w
  FileWrite $1 "done"
  FileClose $1
  SetErrorLevel ${exitCode}
SectionEnd
`, { encoding: "utf8", flag: "wx" });
  await compile(child, [], "child");
  const executable = path.join(root, "CodeFlowAI.exe");
  let input = source;
  if (fault) {
    const current = await fs.readFile(source, "utf8"), anchor = fault === "diagnostic"
      ? current.match(/  FileWrite \$0 [^\r\n]+\r?\n  IfErrors close_failed/gu)?.[0]
      : fault === "argument-read" ? "    System::Call '*$4(p .r5)'"
      : fault === "wait" ? "      System::Call 'kernel32::WaitForSingleObject(p r4, i -1) i.r3 ?e'"
      : "        System::Call 'kernel32::GetExitCodeProcess(p r4, *i .r2) i.r3 ?e'";
    assert.ok(anchor);
    assert.equal(current.split(anchor).length, 2, "fault must target one real native boundary");
    input = path.join(root, "fault-launcher.nsi");
    const injected = fault === "diagnostic" ? `${anchor}\n  System::Call 'kernel32::CloseHandle(p r0) i.r6'`
      : fault === "argument-read" ? `${anchor}
    System::Call 'kernel32::VirtualAlloc(p 0, p 8192, i 0x3000, i 4) p.r0'
    IntOp $1 $0 + 4096
    System::Call 'kernel32::VirtualProtect(p r1, p 4096, i 1, *i .r6) i.r2'
    System::Call 'kernel32::lstrlenW(p r5) i.r1'
    IntOp $1 $1 + 1
    IntOp $1 $1 * 2
    IntOp $2 4096 - $1
    IntOp $0 $0 + $2
    System::Call 'kernel32::lstrcpyW(p r0, p r5) p.r1'
    StrCpy $5 $0`
      : `    System::Call 'kernel32::CloseHandle(p r4) i.r6'\n${anchor}`;
    await fs.writeFile(input, current.replace(anchor, injected), { encoding: "utf8", flag: "wx" });
  }
  await compile(input, [`/DOUTPUT_FILE=${executable}`], "launcher");
  for (const file of ["web/index.html", "client/dist/index.cjs", "release-trust.json"]) {
    const target = path.join(shell, "resources", file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "fixture", { encoding: "ascii", flag: "wx" });
  }
  await fs.writeFile(path.join(root, "shell-launch.ini"), "[shell]\r\nschema=1\r\nactive=current\r\nprevious=\r\nbaseline=current\r\n", { encoding: "ascii", flag: "wx" });
  return { root, env, shell, executable };
}

for (const [args, exitCode] of [
  [["--codeflow-check-installation"], 0],
  [["--codeflow-check-installation"], 7],
  [["--codeflow-register-installation"], 0],
  [["--codeflow-register-installation"], 7],
  [["--codeflow-uninstall-maintenance", "nsis:request+1", "keep"], 0],
  [["--codeflow-uninstall-maintenance", "nsis:request+1", "remove"], 7],
  [["--codeflow-uninstall-maintenance", "nsis:request+1", "keep", "--resume-pending"], 0],
  [["--codeflow-uninstall-maintenance", "nsis:request+1", "remove", "--resume-pending"], 7],
  [["--codeflow-register-installation"], 259],
  [["--codeflow-register-installation"], 3010],
] as const) {
  test(`real launcher waits and returns lifecycle exit ${exitCode}: ${args.join(" ")}`, { skip }, async () => {
    const f = await fixture(exitCode), done = path.join(f.shell, "done.txt");
    try {
      const result = await execute(f.executable, [...args], f.env);
      assert.equal(result.code, exitCode, `launcher result: ${f.root}`);
      assert.equal(await fs.readFile(done, "ascii"), "done", "parent must wait for child work");
    } finally { await waitForFile(done); }
  });
}

for (const args of [
  ['--codeflow-check-installation', 'extra'], ['--codeflow-check-installation=bad'],
  ["--codeflow-register-installation", "extra"], ["--codeflow-register-installation=bad"],
  ["--codeflow-register-installation", "--resume-pending"],
  ["--codeflow-uninstall-maintenance", "bad/request", "keep"],
  ["--codeflow-uninstall-maintenance", "request", "other"],
  ["--codeflow-uninstall-maintenance", "request", "KEEP"],
  ["--codeflow-uninstall-maintenance", "request", "keep", "extra"],
  ["--codeflow-uninstall-maintenance", "request", "keep", "--resume-pending", "extra"],
  ["--codeflow-uninstall-maintenance", "request", "keep", "--RESUME-PENDING"],
  ["--codeflow-uninstall-maintenance", "request", "--resume-pending", "keep"],
  ["--codeflow-uninstall-maintenance", ".request", "keep"],
  ["ordinary-open", "--codeflow-register-installation"], ["--delete-app-data"],
]) {
  test(`real launcher rejects malformed lifecycle arguments: ${args.join(" ")}`, { skip }, async () => {
    const f = await fixture(), result = await execute(f.executable, args, f.env);
    assert.equal(result.code, 1, `malformed request: ${f.root}`);
    await assert.rejects(fs.access(path.join(f.shell, "arguments.txt")), { code: "ENOENT" });
    const record = JSON.parse((await fs.readFile(path.join(f.root, "shell-launch-errors.jsonl"), "utf8")).trim());
    assert.equal(record.rootCause, "LIFECYCLE_ARGUMENTS_INVALID");
  });
}

test("real launcher keeps ordinary opening asynchronous while its child waits for release", { skip }, async () => {
  const f = await fixture(7, true), done = path.join(f.shell, "done.txt");
  try {
    assert.equal((await execute(f.executable, ["ordinary-open"], f.env)).code, 0);
    await waitForFile(path.join(f.shell, "arguments.txt"));
    await assert.rejects(fs.access(done), { code: "ENOENT" });
  } finally {
    await fs.writeFile(path.join(f.shell, "release.txt"), "release", { encoding: "ascii", flag: "wx" });
    await waitForFile(done);
  }
});

for (const fault of ["wait", "result"] as const) {
  test(`real launcher fails explicitly on native lifecycle ${fault} failure`, { skip }, async () => {
    const f = await fixture(0, false, fault);
    try {
      assert.equal((await execute(f.executable, ["--codeflow-register-installation"], f.env)).code, 1);
      const record = JSON.parse((await fs.readFile(path.join(f.root, "shell-launch-errors.jsonl"), "utf8")).trim());
      assert.equal(record.rootCause, fault === "wait" ? "LIFECYCLE_WAIT_FAILED" : "LIFECYCLE_RESULT_FAILED");
      assert.equal(record.win32Error, 6); assert.equal(record.processCreated, true);
    } finally { await waitForFile(path.join(f.shell, "done.txt")); }
  });
}

test("real launcher reports a closed diagnostic handle as a logging failure", { skip }, async () => {
  const f = await fixture(0, false, "diagnostic");
  assert.equal((await execute(f.executable, ["--delete-app-data"], f.env)).code, 2);
  await assert.rejects(fs.access(path.join(f.shell, "arguments.txt")), { code: "ENOENT" });
});

test("real launcher retains separate diagnostics across repeated rejected requests", { skip }, async () => {
  const f = await fixture();
  for (let index = 0; index < 2; index++) assert.equal((await execute(f.executable, ["--delete-app-data"], f.env)).code, 1);
  const lines = (await fs.readFile(path.join(f.root, "shell-launch-errors.jsonl"), "utf8")).trim().split(/\r?\n/u);
  assert.equal(lines.length, 2);
  assert.notEqual(JSON.parse(lines[0]!).requestId, JSON.parse(lines[1]!).requestId);
});

test("real launcher reads short native arguments without crossing their guarded memory page", { skip }, async () => {
  const f = await fixture(0, false, "argument-read");
  assert.equal((await execute(f.executable, ["--codeflow-register-installation"], f.env)).code, 0);
  assert.equal(await fs.readFile(path.join(f.shell, "done.txt"), "ascii"), "done");
});
