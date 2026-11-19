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
async function fixture(kind: "missing" | "invalid" | "nonzero" | "success" | "preflight" | "running" | "versioned-running" | "drive-root" | "junction-root" | "marker-directory" | "marker-existing" | "marker-hardlink" | "marker-commit-failure" | "log-unavailable" | "close-failure" | "flush-failure", fault?: "enumeration" | "path" | "termination") {
  const parent = process.env.CF_NSIS_RUNTIME_ROOT ?? os.tmpdir();
  assert.ok(path.isAbsolute(parent));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, `nsis-${kind}-`));
  const app = path.join(root, "app"), temporary = path.join(root, "temporary");
  await fs.mkdir(app); await fs.mkdir(temporary);
  if (kind === "marker-directory") await fs.mkdir(path.join(app, "installation-completed.ini"));
  await fs.writeFile(path.join(app, "profile.json"), '{"account":"账号","deviceId":"device-keep","tasks":[1]}', "utf8");
  if (kind === "marker-existing") await fs.writeFile(path.join(app, "installation-completed.ini"), "stale fact", { encoding: "ascii", flag: "wx" });
  if (kind === "marker-hardlink") await fs.link(path.join(app, "profile.json"), path.join(app, "installation-completed.ini"));
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
  const child = path.join(app, ...(kind === "versioned-running" ? ["shells", "current"] : []), "CodeFlowAI.exe");
  await fs.mkdir(path.dirname(child), { recursive: true });
  if (kind === "invalid") await fs.writeFile(child, "not a PE executable", { encoding: "ascii", flag: "wx" });
  if (["nonzero", "success", "preflight", "running", "versioned-running"].includes(kind)) {
    const executable = await compile("child", `!include "FileFunc.nsh"
Section
  \${GetParameters} $0
  FileOpen $1 "$EXEDIR\\arguments.txt" w
  FileWrite $1 "$0"
  FileClose $1
  FileOpen $1 "$EXEDIR\\order.txt" w
  FileWrite $1 "started$\\r$\\n"
  Sleep ${kind === "running" || kind === "versioned-running" ? 20000 : 150}
  FileWrite $1 "closed-work$\\r$\\n"
  FileClose $1
  SetErrorLevel ${kind === "success" || kind === "preflight" ? 0 : 7}
SectionEnd
`);
    await fs.copyFile(executable, child, fs.constants.COPYFILE_EXCL);
  }
  let includedHook = hook;
  if (kind === "marker-commit-failure") {
    const source = await fs.readFile(hook, "utf8"), anchor = 'w "$INSTDIR\\installation-completed.ini", i 9)';
    assert.equal(source.split(anchor).length, 2);
    includedHook = path.join(root, "fault-hook.nsh");
    await fs.writeFile(includedHook, source.replace(anchor, 'w "$INSTDIR\\missing\\installation-completed.ini", i 9)'), { encoding: "utf8", flag: "wx" });
  }
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
  let nativeInclude = fileURLToPath(new URL("../build/stop-installed-processes.nsh", import.meta.url));
  if (fault) {
    const source = await fs.readFile(nativeInclude, "utf8");
    const anchor = fault === "enumeration"
      ? "kernel32::Process32FirstW(p $d16StopSnapshot, p $d16StopEntry)"
      : fault === "path" ? "kernel32::QueryFullProcessImageNameW(p $d16StopHandle,"
      : "kernel32::TerminateProcess(p $d16StopHandle,";
    assert.equal(source.split(anchor).length, 2, "fault must target exactly one real Windows boundary");
    nativeInclude = path.join(root, "fault-stop.nsh");
    await fs.writeFile(nativeInclude, source.replace(anchor, anchor.replace(/p \$d16Stop(?:Snapshot|Handle)/u, "p 0")), { encoding: "utf8", flag: "wx" });
  }
  if (kind === "junction-root") {
    await fs.rename(app, path.join(root, "actual-app"));
    await fs.symlink(path.join(root, "actual-app"), app, "junction");
  }
  const executable = await compile("parent", `!define CODEFLOW_STOP_INSTALLED_INCLUDE "${nsisPath(nativeInclude)}"
!define CODEFLOW_UPGRADE_INSTALLED_INCLUDE "${nsisPath(fileURLToPath(new URL("../build/upgrade-installed-files.nsh", import.meta.url)))}"
!include "${nsisPath(includedHook)}"
Section
  StrCpy $INSTDIR "$EXEDIR\\app"
  ${kind === "drive-root" ? `StrCpy $INSTDIR "${nsisPath(path.parse(root).root)}"` : ""}
  StrCpy $0 0
  ClearErrors
  ${kind === 'preflight' || kind === 'versioned-running' ? '!insertmacro customCheckAppRunning' : ''}
  ${fault || ["running", "drive-root", "junction-root"].includes(kind) ? "!insertmacro D16StopInstalledProcesses false" : ""}
  ${["log-unavailable", "close-failure", "flush-failure"].includes(kind) ? `StrCpy $d16InstallErrorCode DESKTOP_INSTALL_PROCESS_STOP_FAILED
  StrCpy $d16InstallStage "installation-process-stop"
  StrCpy $d16InstallCause "PROCESS_STOP_FAILED"
  Call D16FailInstallation` : "!insertmacro customInstall"}
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
  return { root, app, temporary, executable, env, child };
}

for (const variant of ["same-root", "junction", "wrong-type", "different-root", "different-scope"] as const) {
  test(`native legacy replacement ${variant} never invokes the old uninstaller`, { skip }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nsis-legacy-replace-")), app = path.join(root, "app");
    await fs.mkdir(path.join(app, "resources"), { recursive: true });
    await fs.mkdir(path.join(app, "shells/old"), { recursive: true });
    await fs.writeFile(path.join(app, "unknown-user.txt"), "账号、身份、任务原样保留", "utf8");
    await fs.writeFile(path.join(app, "shells/old/obsolete.txt"), "old shell", "ascii");
    if (variant === "wrong-type") await fs.mkdir(path.join(app, "CodeFlowAI.exe"));
    else await fs.writeFile(path.join(app, "CodeFlowAI.exe"), "old executable", "ascii");
    if (variant === "junction") {
      await fs.mkdir(path.join(root, "external"));
      await fs.writeFile(path.join(root, "external/user.txt"), "external", "ascii");
      await fs.symlink(path.join(root, "external"), path.join(app, "resources/alias"), "junction");
    }
    const source = path.join(root, "upgrade.nsi"), executable = path.join(root, "upgrade.exe");
    await fs.writeFile(source, `Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "Legacy replacement fixture"
OutFile "${nsisPath(executable)}"
!include "${nsisPath(hook)}"
!define INSTALL_REGISTRY_KEY "fixture-install"
!define UNINSTALL_REGISTRY_KEY "fixture-uninstall"
Var installMode
!macro readReg OUTPUT ROOT KEY NAME
  !if "\${NAME}" == "InstallLocation"
    StrCpy \${OUTPUT} "$EXEDIR\\${variant === "different-root" ? "other" : "app"}"
  !else
    StrCpy \${OUTPUT} "old-uninstaller.exe"
  !endif
!macroend
Function uninstallOldVersion
  FileOpen $0 "$EXEDIR\\legacy-ran.txt" w
  FileWrite $0 "legacy executed"
  FileClose $0
FunctionEnd
!macro uninstallOldVersion ROOT
  Call uninstallOldVersion
!macroend
Section
  StrCpy $INSTDIR "$EXEDIR\\app"
  StrCpy $installMode ${variant === "different-scope" ? "all" : "CurrentUser"}
  !insertmacro customCheckAppRunning
  !insertmacro uninstallOldVersion ${variant === "different-scope" ? "HKEY_CURRENT_USER" : "SHELL_CONTEXT"}
  FileOpen $0 "$EXEDIR\\continued.txt" w
  FileWrite $0 "continued"
  FileClose $0
SectionEnd
Function .onInstFailed
  FileOpen $0 "$EXEDIR\\failure.txt" w
  FileWrite $0 "$d16InstallCause"
  FileClose $0
FunctionEnd
`, "utf8");
    const compiled = await execute(compiler!, ["/V2", "/INPUTCHARSET", "UTF8", source]);
    assert.equal(compiled.code, 0, compiled.stdout + compiled.stderr);
    const result = await execute(executable, []);
    assert.equal(result.code, variant === "same-root" ? 0 : 1, root);
    await assert.rejects(fs.access(path.join(root, "legacy-ran.txt")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(app, "unknown-user.txt"), "utf8"), "账号、身份、任务原样保留");
    if (variant === "same-root") {
      await assert.rejects(fs.access(path.join(app, "CodeFlowAI.exe")), { code: "ENOENT" });
      await assert.rejects(fs.access(path.join(app, "shells")), { code: "ENOENT" });
    } else {
      assert.equal(await fs.readFile(path.join(app, "shells/old/obsolete.txt"), "ascii"), "old shell", "read-only preflight must reject before deleting any program file");
      assert.equal(await fs.readFile(path.join(root, "failure.txt"), "ascii"), variant === "junction" ? "PROGRAM_PATH_REPARSE"
        : variant === "wrong-type" ? "PROGRAM_PATH_TYPE_INVALID" : variant === "different-root" ? "LEGACY_INSTALL_ROOT_CONFLICT" : "LEGACY_INSTALL_SCOPE_CONFLICT");
      if (variant === "junction") assert.equal(await fs.readFile(path.join(root, "external/user.txt"), "ascii"), "external");
    }
  });
}

for (const kind of ["missing", "invalid", "nonzero", "success", "preflight", "marker-existing"] as const) {
  test(`real NSIS install continues without running ${kind} business executable`, { skip }, async () => {
    const f = await fixture(kind);
    const result = await execute(f.executable, [], f.env);
    await fs.writeFile(path.join(f.root, "result.json"), JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    assert.equal(result.code, 0, `program installation must be independent: ${f.root}`);
    const marker = path.join(f.app, "installation-completed.ini");
    assert.equal(await fs.access(marker).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), true, "program file copy must leave its independent completion fact");
    assert.match(await fs.readFile(marker, "ascii"), /^\[installation\]\r\nschema=1\r\nrequestId=nsis-install-[0-9-]+\r\n$/u);
    assert.equal(await fs.readFile(path.join(f.app, "order.txt"), "ascii"), "continued\r\n");
    await assert.rejects(fs.access(path.join(f.app, "arguments.txt")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(f.app, "profile.json"), "utf8"), '{"account":"账号","deviceId":"device-keep","tasks":[1]}');
  });
}

for (const kind of ["marker-directory", "marker-hardlink", "marker-commit-failure"] as const) {
  test(`installation completion refuses ${kind} without touching profile or claiming completion`, { skip }, async () => {
    const f = await fixture(kind), result = await execute(f.executable, [], f.env);
    assert.equal(result.code, 1, f.root);
    const context = JSON.parse(await fs.readFile(path.join(f.root, "failure-context.json"), "utf8"));
    assert.equal(context.rootCause, kind === "marker-commit-failure" ? "INSTALLATION_MARKER_WRITE_FAILED" : "INSTALLATION_MARKER_PATH_INVALID");
    assert.equal(await fs.readFile(path.join(f.app, "profile.json"), "utf8"), '{"account":"账号","deviceId":"device-keep","tasks":[1]}');
    await assert.rejects(fs.access(path.join(f.app, "order.txt")), { code: "ENOENT" });
    if (kind === "marker-commit-failure") await assert.rejects(fs.access(path.join(f.app, "installation-completed.ini")), { code: "ENOENT" });
  });
}

test("real NSIS process-stop failure remains explicit when its failure log cannot be created", { skip }, async () => {
  const f = await fixture("log-unavailable"), result = await execute(f.executable, [], f.env);
  assert.equal(result.code, 2, `a diagnostic failure must remain nonzero: ${f.root}`);
  await assert.rejects(fs.access(path.join(f.app, "order.txt")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(f.root, 'missing-log-directory')), { code: 'ENOENT' });
  for (const entry of await fs.readdir(f.temporary)) assert.ok((await fs.lstat(path.join(f.temporary, entry))).isDirectory(), 'failed log creation must not publish a file');
  const context = JSON.parse(await fs.readFile(path.join(f.root, "failure-context.json"), "utf8"));
  assert.match(context.requestId, /^nsis-install-[A-Za-z0-9._-]+$/u);
  assert.equal(context.rootCause, "PROCESS_STOP_FAILED");
});

for (const kind of ["close-failure", "flush-failure"] as const) {
  test(`real NSIS process-stop reports native diagnostic ${kind}`, { skip }, async () => {
    const f = await fixture(kind), result = await execute(f.executable, [], f.env);
    assert.equal(result.code, 2, `failed native I/O cannot be reported as a persisted diagnostic: ${f.root}`);
    await assert.rejects(fs.access(path.join(f.app, "order.txt")), { code: "ENOENT" });
  });
}

for (const kind of ["drive-root", "junction-root"] as const) {
  test(`real native process cleanup rejects ${kind} before ownership checks`, { skip }, async () => {
    const f = await fixture(kind), result = await execute(f.executable, [], f.env);
    assert.equal(result.code, 1, f.root);
    const failure = JSON.parse(await fs.readFile(path.join(f.root, "failure-context.json"), "utf8"));
    assert.equal(failure.rootCause, "INSTALL_ROOT_INVALID");
    assert.equal(await fs.readFile(path.join(f.app, "profile.json"), "utf8"), '{"account":"账号","deviceId":"device-keep","tasks":[1]}');
  });
}

test("real native process enumeration failure aborts installation", { skip }, async () => {
  const f = await fixture("preflight", "enumeration"), result = await execute(f.executable, [], f.env);
  assert.equal(result.code, 1, f.root);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, "failure-context.json"), "utf8")).rootCause, "PROCESS_ENUMERATION_FAILED");
  await assert.rejects(fs.access(path.join(f.app, "order.txt")), { code: "ENOENT" });
});

for (const fault of [undefined, "path", "termination", "versioned-running"] as const) {
  test(`real native process cleanup ${fault ?? "waits for actual exit"}`, { skip }, async t => {
    const failureExpected = fault === "path" || fault === "termination";
    const f = await fixture(fault === "versioned-running" ? fault : "running", failureExpected ? fault : undefined);
    const child = spawn(f.child, [], { windowsHide: true, stdio: "ignore" });
    const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    t.after(async () => { if (child.exitCode === null) child.kill(); await closed; });
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await fs.access(path.join(path.dirname(f.child), "arguments.txt")); break; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      assert.ok(Date.now() < deadline, "isolated process did not start");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const result = await execute(f.executable, [], f.env);
    assert.equal(result.code, failureExpected ? 1 : 0, f.root);
    if (failureExpected) {
      const failure = JSON.parse(await fs.readFile(path.join(f.root, "failure-context.json"), "utf8"));
      assert.equal(failure.rootCause, fault === "path" ? "PROCESS_PATH_UNAVAILABLE" : "PROCESS_TERMINATION_FAILED");
      assert.equal(child.exitCode, null, "failed cleanup must not claim that the process exited");
    } else {
      assert.notEqual(child.exitCode, null, "program replacement must stop a versioned shell even if the root executable is missing");
      await closed;
      assert.equal(child.exitCode, 0, "the exact held process must exit before installation continues");
      assert.equal(await fs.readFile(path.join(f.app, "order.txt"), "ascii"), fault === "versioned-running" ? "continued\r\n" : "started\r\ncontinued\r\n");
    }
  });
}
