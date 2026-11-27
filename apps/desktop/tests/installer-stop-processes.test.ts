import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../build/stop-installed-processes.ps1", import.meta.url));
const powershell = path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");

for (const mode of ["empty-exited", "throw-exited", "unreadable-alive", "readable-alive"]) {
  test(`installer handles CIM path fallback ${mode}`, { skip: process.platform !== "win32" }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "installer-identity-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const log = path.join(root, "stop.jsonl");
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const command = `$global:reads=0; $global:held=$false
$global:candidate=New-Object PSObject
$global:candidate | Add-Member ScriptProperty Handle { $global:held=$true; return 1 }
$global:candidate | Add-Member ScriptProperty HasExited { $global:reads++; return ($global:reads -gt 1 -and ${mode.endsWith("alive") ? "$false" : "$true"}) }
$global:candidate | Add-Member ScriptProperty MainModule { if (-not $global:held) { throw 'HANDLE_NOT_HELD' }; ${mode === "throw-exited" ? "throw 'PROCESS_EXITED'" : mode === "readable-alive" ? "return [PSCustomObject]@{FileName='C:\\unrelated\\CodeFlowAI.exe'}" : "return $null"} }
$global:candidate | Add-Member ScriptMethod Dispose {}
function Get-CimInstance {
  $record=[PSCustomObject]@{Name='CodeFlowAI.exe';ProcessId=123;ParentProcessId=1;CreationDate=[DateTime]::UtcNow}
  $record | Add-Member ScriptProperty ExecutablePath { return $null }
  return $record
}
function Get-Process { return $global:candidate }
& ${quote(helper)} -InstallDirectory ${quote(root)} -LogPath ${quote(log)} -GracefulTimeoutSeconds 0`;
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: "ignore" });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const diagnostic = await fs.readFile(log, "utf8");
    assert.equal(code, mode === "unreadable-alive" ? 1 : 0, diagnostic);
    assert.match(diagnostic, mode === "unreadable-alive" ? /DESKTOP_INSTALL_PROCESS_STOP_FAILED/u : /DESKTOP_INSTALL_PROCESSES_STOPPED/u);
  });
}

for (const { sideBySide, terminationDenied } of [
  { sideBySide: false, terminationDenied: null },
  { sideBySide: true, terminationDenied: null },
  { sideBySide: true, terminationDenied: "exiting" },
  { sideBySide: true, terminationDenied: "alive" },
]) {
const scenario = terminationDenied === "exiting" ? "installation tree whose root exits after termination is denied"
  : sideBySide ? "side-by-side installation tree" : "root installation tree";
const name = terminationDenied === "alive" ? "installer reports Win32 access denied when the held process stays alive"
  : `installer stops only its ${scenario} and preserves data`;
test(name, {
  skip: process.platform !== "win32" || (terminationDenied !== null && !process.env.CF_NSIS_COMPILER), timeout: 45000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "installer-stop-"));
  const install = path.join(root, "old installation"), other = path.join(root, "other");
  const external = path.join(root, "engine.exe");
  await fs.mkdir(install); await fs.mkdir(other);
  const executableDirectory = sideBySide ? path.join(install, "shells", "old-shell") : install;
  await fs.mkdir(executableDirectory, { recursive: true });
  const source = path.join(root, "fixture.cs"), binary = path.join(executableDirectory, "CodeFlowAI.exe");
  const exitSignal = path.join(root, "exit-signal");
  await fs.writeFile(source, `using System; using System.Diagnostics; using System.IO; using System.Threading;
class Fixture { static void Main(string[] args) {
  if (args.Length > 0 && args[0] == "foreign") { Console.WriteLine("FOREIGN_READY " + Process.GetCurrentProcess().Id); Thread.Sleep(Timeout.Infinite); return; }
  if (args.Length > 0) { Console.WriteLine("CHILD_READY " + Process.GetCurrentProcess().Id); Thread.Sleep(Timeout.Infinite); return; }
  Process.Start(new ProcessStartInfo(@"${external.replaceAll('"', '""')}", "child") { UseShellExecute = false });
  Process.Start(new ProcessStartInfo(@"${path.join(other, "CodeFlowAI.exe").replaceAll('"', '""')}", "foreign") { UseShellExecute = false });
  Console.WriteLine("ROOT_READY");
  var signal = Environment.GetEnvironmentVariable("CODEFLOW_TEST_EXIT_SIGNAL");
  if (signal == null) { Thread.Sleep(Timeout.Infinite); return; }
  while (!File.Exists(signal)) Thread.Sleep(20);
  Thread.Sleep(500);
} }`);
  execFileSync(path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), ["/nologo", "/platform:x64", `/out:${binary}`, source]);
  await fs.copyFile(binary, external);
  await fs.copyFile(binary, path.join(other, "CodeFlowAI.exe"));
  await fs.writeFile(path.join(install, "user-data.db"), "preserve-me");
  const children: ReturnType<typeof spawn>[] = [];
  const engineIds: number[] = [];
  const foreignIds: number[] = [];
  /** 启动进程树，指定退出信号时仅让该树的根进程模拟异步退出。 */
  async function start(executable: string, signal?: string) {
    const child = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, CODEFLOW_TEST_EXIT_SIGNAL: signal } });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("FIXTURE_START_TIMEOUT")), 10000);
      let output = "";
      const ready = (chunk: Buffer) => {
        output += chunk;
        const engine = output.match(/CHILD_READY (\d+)/u), foreign = output.match(/FOREIGN_READY (\d+)/u);
        if (output.includes("ROOT_READY") && engine && foreign) {
          engineIds.push(Number(engine[1])); foreignIds.push(Number(foreign[1]));
          child.stdout!.off("data", ready); clearTimeout(timer); resolve();
        }
      };
      child.stdout!.on("data", ready);
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    return child;
  }
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) {
      try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
    }
    for (const processId of foreignIds) {
      try { execFileSync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const target = await start(binary, terminationDenied === "exiting" ? exitSignal : undefined);
  const unrelated = await start(path.join(other, "CodeFlowAI.exe"));
  let log = path.join(root, "stop.jsonl");
  let program = powershell;
  let args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
    "-InstallDirectory", install, "-LogPath", log, "-GracefulTimeoutSeconds", "0"];
  const logs = path.join(root, "logs");
  await fs.mkdir(logs);
  if (sideBySide && process.env.CF_NSIS_COMPILER) {
    const quote = (value: string) => value.replaceAll("$", "$$").replaceAll('"', '$\\"');
    program = path.join(root, "installer-fixture.exe");
    const installer = path.join(root, "installer-fixture.nsi");
    let stopInclude = "";
    if (terminationDenied) {
      const stopScript = path.join(root, "stop-installed-processes.nsh");
      const script = await fs.readFile(new URL("../build/stop-installed-processes.nsh", import.meta.url), "utf8");
      const nativeCall = "System::Call 'kernel32::TerminateProcess(p $d16StopHandle, i 0) i.r0 ?e'";
      assert.ok(script.includes(nativeCall));
      // 只替换目标进程的 Win32 返回，保留真实句柄、退出等候与重新枚举。
      await fs.writeFile(stopScript, script.replace(nativeCall,
        `\${If} $d16StopPid == ${target.pid}\n      FileOpen $0 "${quote(exitSignal)}" w\n      FileClose $0\n      StrCpy $0 0\n      Push 5\n    \${Else}\n      ${nativeCall}\n    \${EndIf}`));
      stopInclude = `!define CODEFLOW_STOP_INSTALLED_INCLUDE "${quote(stopScript)}"\n`;
    }
    await fs.writeFile(installer, `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nAutoCloseWindow true\nName "Stop process fixture"\nOutFile "${quote(program)}"\n${stopInclude}!include "${quote(fileURLToPath(new URL("../build/installer.nsh", import.meta.url)))}"\nSection\nStrCpy $INSTDIR "${quote(install)}"\n!insertmacro D16StopInstalledProcesses false\nSectionEnd\n`);
    execFileSync(process.env.CF_NSIS_COMPILER, ["/V2", "/INPUTCHARSET", "UTF8", installer]);
    args = [];
  }
  const result = spawn(program, args, { windowsHide: true, env: { ...process.env, TEMP: logs, TMP: logs }, stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  result.stderr!.on("data", chunk => { errors += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { result.once("error", reject); result.once("close", resolve); });
  if (sideBySide && process.env.CF_NSIS_COMPILER) {
    const candidates = await fs.readdir(logs);
    for (const candidate of candidates) {
      const file = path.join(logs, candidate);
      if ((await fs.stat(file)).isFile() && (await fs.readFile(file, "utf8")).includes("DESKTOP_INSTALL_PROCESS_STOP_STARTED")) { log = file; break; }
    }
  }
  const stopLog = await fs.readFile(log, "utf8");
  if (terminationDenied === "alive") {
    assert.equal(code, 1, errors + stopLog);
    const entries = stopLog.trim().split(/\r?\n/u).map(line => JSON.parse(line));
    assert.equal(entries.at(-1).processId, target.pid);
    assert.equal(entries.at(-1).rootCause, "PROCESS_TERMINATION_FAILED");
    assert.equal(entries.at(-1).win32Error, 5);
    const summaries = await Promise.all((await fs.readdir(logs)).map(file => fs.readFile(path.join(logs, file), "utf8")));
    const summary = summaries.map(value => value.trim()).find(value => value.startsWith('{"errorCode":"DESKTOP_INSTALL_PROCESS_STOP_FAILED"'));
    assert.ok(summary);
    assert.equal(JSON.parse(summary).win32Error, 5);
    assert.equal(target.exitCode, null);
    assert.equal(await fs.readFile(path.join(install, "user-data.db"), "utf8"), "preserve-me");
    return;
  }
  assert.equal(code, 0, errors + stopLog);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.notEqual(target.exitCode, null);
  assert.equal(unrelated.exitCode, null);
  assert.throws(() => process.kill(engineIds[0]!, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(engineIds[1]!, 0));
  for (const processId of foreignIds) assert.doesNotThrow(() => process.kill(processId, 0));
  assert.equal(await fs.readFile(path.join(install, "user-data.db"), "utf8"), "preserve-me");
  const entries = stopLog.trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.ok(entries.some(entry => entry.code === "DESKTOP_INSTALL_PROCESS_FORCED"));
  assert.equal(entries.at(-1).code, "DESKTOP_INSTALL_PROCESSES_STOPPED");
  assert.ok(entries.every(entry => entry.requestId));
  let repeated: Buffer;
  try {
    repeated = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
      "-InstallDirectory", install, "-LogPath", log, "-GracefulTimeoutSeconds", "0"], { windowsHide: true });
  } catch { assert.fail(await fs.readFile(log, "utf8")); }
  assert.equal(repeated.length, 0);
  assert.equal(unrelated.exitCode, null);
  assert.throws(() => execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
    "-InstallDirectory", install, "-LogPath", path.join(root, "missing", "stop.jsonl")], { windowsHide: true, stdio: "pipe" }), { status: 1 });
});
}

test("installer re-evaluates a restarted process instead of failing on a stale snapshot", { skip: process.platform !== "win32", timeout: 45000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "installer-stale-identity-"));
  const log = path.join(root, "stop.jsonl");
  const source = path.join(root, "fixture.cs"), binary = path.join(root, "CodeFlowAI.exe");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(source, `using System; using System.Diagnostics; using System.Threading;
class Fixture { static void Main() { Console.WriteLine("READY " + Process.GetCurrentProcess().Id); Thread.Sleep(Timeout.Infinite); } }`);
  execFileSync(path.join(process.env.SystemRoot!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), ["/nologo", "/platform:x64", `/out:${binary}`, source]);
  const child = spawn(binary, [], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  t.after(() => {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("FIXTURE_START_TIMEOUT")), 10000);
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk; if (output.includes("READY")) { clearTimeout(timer); resolve(); } });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  // CIM 快照故意保留过期创建时间，模拟停止期间进程重启或 PID 复用。
  const command = `function global:Get-CimInstance { param($ClassName, $OperationTimeoutSec)
  return @([PSCustomObject]@{ Name='CodeFlowAI.exe'; ProcessId=${child.pid}; ParentProcessId=0; CreationDate=[DateTime]::UtcNow.AddSeconds(-30); ExecutablePath=${quote(binary)} })
}
. ${quote(helper)} -InstallDirectory ${quote(root)} -LogPath ${quote(log)} -GracefulTimeoutSeconds 0`;
  const result = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  result.stderr!.on("data", chunk => { errors += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { result.once("error", reject); result.once("close", resolve); });
  const diagnostic = await fs.readFile(log, "utf8").catch(() => "NO_STOP_LOG");
  assert.equal(code, 0, errors + diagnostic);
  assert.match(diagnostic, /DESKTOP_INSTALL_PROCESSES_STOPPED/u);
  assert.doesNotMatch(diagnostic, /DESKTOP_INSTALL_PROCESS_IDENTITY_CHANGED/u);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
});
