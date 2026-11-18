import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const compiler = process.env.CF_NSIS_COMPILER;
const skip = process.platform !== "win32" ? "Windows NSIS runtime required" : !compiler ? "Set CF_NSIS_COMPILER to run native contracts" : false;
const hook = fileURLToPath(new URL("../build/installer.nsh", import.meta.url));

/** 只转义 NSIS 源码路径，不把路径拼接到 shell 命令。 */
function nsisPath(value: string): string {
  assert.doesNotMatch(value, /[\r\n\0]/u);
  return value.replaceAll("$", "$$").replaceAll('"', '$\\"');
}

/** 等待本次 spawn 的实际 close；超时仅终止其原始句柄并保留失败。 */
async function execute(file: string, args: string[], env = process.env) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    child.stdout.on("data", bytes => { stdout += bytes.toString("utf8"); });
    child.stderr.on("data", bytes => { stderr += bytes.toString("utf8"); });
    child.once("error", error => { failure = error; });
    child.once("close", (code, signal) => {
      if (failure) reject(failure);
      else if (signal) reject(new Error(`NSIS_FIXTURE_INTERRUPTED:${signal}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

/** 将真实 hook 编进仅写标记的夹具，不包含安装、删除或注册表操作。 */
async function fixture(kind: "missing" | "invalid" | "nonzero" | "success" | "preflight" | "log-unavailable" | "close-failure" | "flush-failure") {
  const parent = process.env.CF_NSIS_RUNTIME_ROOT ?? os.tmpdir();
  assert.ok(path.isAbsolute(parent));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, `nsis-${kind}-`));
  const app = path.join(root, "app"), temporary = path.join(root, "temporary");
  await fs.mkdir(app); await fs.mkdir(temporary);
  const env = { ...process.env, TEMP: temporary, TMP: temporary };
  /** 每个编译输入及诊断均保留于本夹具目录，编译失败立即显式失败。 */
  async function compile(name: string, content: string) {
    const source = path.join(root, `${name}.nsi`), executable = path.join(root, `${name}.exe`);
    await fs.writeFile(source, `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nAutoCloseWindow true\nName "NSIS contract"\nOutFile "${nsisPath(executable)}"\n${content}`, { encoding: "utf8", flag: "wx" });
    const result = await execute(compiler!, ["/V2", "/INPUTCHARSET", "UTF8", source], env);
    await fs.writeFile(path.join(root, `${name}-compile.log`), result.stdout + result.stderr, { encoding: "utf8", flag: "wx" });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return executable;
  }
  const child = path.join(app, "CodeFlowAI.exe");
  if (kind === "invalid") await fs.writeFile(child, "not a PE executable", { encoding: "ascii", flag: "wx" });
  if (kind === "nonzero" || kind === "success" || kind === "preflight") {
    const executable = await compile("child", `!include "FileFunc.nsh"
Section
  \${GetParameters} $0
  FileOpen $1 "$EXEDIR\\arguments.txt" w
  FileWrite $1 "$0"
  FileClose $1
  FileOpen $1 "$EXEDIR\\order.txt" w
  FileWrite $1 "started$\\r$\\n"
  Sleep 150
  FileWrite $1 "closed-work$\\r$\\n"
  FileClose $1
  SetErrorLevel ${kind === "success" || kind === "preflight" ? 0 : 7}
SectionEnd
`);
    await fs.copyFile(executable, child, fs.constants.COPYFILE_EXCL);
  }
  let includedHook = hook;
  if (kind === 'log-unavailable') {
    const source = await fs.readFile(hook, 'utf8'), anchor = 'GetTempFileName $d16InstallLog';
    assert.equal(source.split(anchor).length, 2);
    includedHook = path.join(root, 'fault-hook.nsh');
    // 精确让真实临时日志创建命令命中不存在的父目录，避免移动 NSIS 正占用的 TEMP。
    await fs.writeFile(includedHook, source.replace(anchor, `${anchor} "$EXEDIR\\missing-log-directory"`), { encoding: 'utf8', flag: 'wx' });
  }
  if (kind === "close-failure" || kind === "flush-failure") {
    const source = await fs.readFile(hook, "utf8"), anchor = kind === "flush-failure"
      ? "\n  System::Call 'kernel32::FlushFileBuffers(p r1) i.r2'"
      : "\n  System::Call 'kernel32::CloseHandle(p r1) i.r2'";
    assert.equal(source.split(anchor).length, 2, "I/O fault must target the real diagnostic boundary once");
    includedHook = path.join(root, "fault-hook.nsh");
    await fs.writeFile(includedHook, source.replace(anchor, `\n  System::Call 'kernel32::CloseHandle(p r1) i.r2'${anchor}`), { encoding: "utf8", flag: "wx" });
  }
  const executable = await compile("parent", `!define CODEFLOW_STOP_INSTALLED_HELPER "${nsisPath(fileURLToPath(new URL("../build/stop-installed-processes.ps1", import.meta.url)))}"
!include "${nsisPath(includedHook)}"
Section
  StrCpy $INSTDIR "$EXEDIR\\app"
  StrCpy $0 0
  ClearErrors
  ${kind === 'preflight' ? '!ifmacrodef customCheckAppRunning\n  !insertmacro customCheckAppRunning\n  !endif' : ''}
  !insertmacro customInstall
  FileOpen $1 "$INSTDIR\\order.txt" a
  FileSeek $1 0 END
  FileWrite $1 "continued$\\r$\\n"
  FileClose $1
SectionEnd
Function .onInstFailed
  FileOpen $1 "$EXEDIR\\failure-context.json" w
  FileWrite $1 '{"requestId":"$d16InstallRequestId","rootCause":"$d16InstallCause"}'
  FileClose $1
FunctionEnd
`);
  return { root, app, temporary, executable, env };
}

for (const kind of ["missing", "invalid", "nonzero"] as const) {
  test(`real NSIS registration rejects ${kind} executable before continuing`, { skip }, async () => {
    const f = await fixture(kind);
    const result = await execute(f.executable, [], f.env);
    await fs.writeFile(path.join(f.root, "result.json"), JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    assert.equal(result.code, 1, `registration failure must be nonzero: ${f.root}`);
    if (kind === "nonzero") {
      assert.equal(await fs.readFile(path.join(f.app, "order.txt"), "ascii"), "started\r\nclosed-work\r\n");
    } else await assert.rejects(fs.access(path.join(f.app, "order.txt")), { code: "ENOENT" });
    const files = await fs.readdir(f.temporary);
    const records = [];
    for (const file of files) {
      const target = path.join(f.temporary, file);
      if ((await fs.lstat(target)).isFile()) records.push(JSON.parse(await fs.readFile(target, "utf8")));
    }
    assert.equal(records.length, 1, "one persistent NSIS failure record is required");
    assert.equal(records[0].errorCode, "DESKTOP_INSTALL_REGISTRATION_FAILED");
    assert.equal(records[0].appId, "ai.codeflow.codeflowai");
    assert.equal(records[0].stage, "installation-registration");
    assert.match(records[0].requestId, /^nsis-install-[A-Za-z0-9._-]+$/u);
    assert.equal(records[0].rootCause, kind === "nonzero" ? "PROCESS_EXIT_NONZERO" : "PROCESS_START_FAILED");
    assert.equal(records[0].exitCode, kind === "nonzero" ? 7 : null);
    assert.deepEqual(Object.keys(records[0]).sort(), ["appId", "errorCode", "exitCode", "requestId", "rootCause", "stage"]);
  });
}

test("real NSIS registration waits for successful child work before continuing", { skip }, async () => {
  const f = await fixture("success"), result = await execute(f.executable, [], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await fs.readFile(path.join(f.app, "arguments.txt"), "ascii"), /^--codeflow-register-installation "nsis-install-/u);
  assert.equal(await fs.readFile(path.join(f.app, "order.txt"), "ascii"), "started\r\nclosed-work\r\ncontinued\r\n");
  assert.deepEqual(await fs.readdir(f.temporary), []);
});

test("real NSIS stops old processes but does not run old shell preflight before replacing files", { skip }, async () => {
  const f = await fixture("preflight"), result = await execute(f.executable, [], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await fs.readFile(path.join(f.app, "arguments.txt"), "ascii"), /^--codeflow-register-installation "nsis-install-/u);
  assert.equal(await fs.readFile(path.join(f.app, "order.txt"), "ascii"), "started\r\nclosed-work\r\ncontinued\r\n");
});

test("real NSIS registration fails explicitly when its failure log cannot be created", { skip }, async () => {
  const f = await fixture("log-unavailable"), result = await execute(f.executable, [], f.env);
  assert.equal(result.code, 2, `a diagnostic failure must remain nonzero: ${f.root}`);
  await assert.rejects(fs.access(path.join(f.app, "order.txt")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(f.root, 'missing-log-directory')), { code: 'ENOENT' });
  for (const entry of await fs.readdir(f.temporary)) assert.ok((await fs.lstat(path.join(f.temporary, entry))).isDirectory(), 'failed log creation must not publish a file');
  const context = JSON.parse(await fs.readFile(path.join(f.root, "failure-context.json"), "utf8"));
  assert.match(context.requestId, /^nsis-install-[A-Za-z0-9._-]+$/u);
  assert.equal(context.rootCause, "PROCESS_START_FAILED");
});

for (const kind of ["close-failure", "flush-failure"] as const) {
  test(`real NSIS registration reports native diagnostic ${kind}`, { skip }, async () => {
    const f = await fixture(kind), result = await execute(f.executable, [], f.env);
    assert.equal(result.code, 2, `failed native I/O cannot be reported as a persisted diagnostic: ${f.root}`);
    await assert.rejects(fs.access(path.join(f.app, "order.txt")), { code: "ENOENT" });
  });
}
