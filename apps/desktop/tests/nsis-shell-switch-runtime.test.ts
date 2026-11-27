import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const compiler = process.env.CF_NSIS_COMPILER;
const skip = process.platform !== "win32" || !compiler ? "Windows NSIS compiler required" : false;
const source = fileURLToPath(new URL("../build/shell-switch.nsi", import.meta.url));
const requestId = "a2b17190-9093-4f0b-b028-27c4fd87234d";
const original = "[shell]\r\nschema=1\r\nactive=old\r\nprevious=\r\nbaseline=old\r\n";

test("native switch builder reuses protected compiler/cache paths", { skip }, async () => {
  const url = new URL("../scripts/build-shell-switch.mjs", import.meta.url);
  assert.equal(await fs.access(url).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), true, "native switch builder is missing");
  const { buildShellSwitch } = await import(url.href);
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  await assert.rejects(buildShellSwitch({ outputDir: path.join(repository, "forbidden-switch-output") }), /DESKTOP_SHELL_BUILD_PATH_OVERLAP/u);
});

/** 只转义编译源码字面值，执行参数直接交给 spawn。 */
function literal(value: string): string {
  assert.doesNotMatch(value, /[\r\n\0]/u);
  return value.replaceAll("$", "$$").replaceAll('"', '$\\"');
}

/** 保留原始句柄和真实退出码；超时作为测试失败向上传递。 */
async function execute(file: string, args: string[]) {
  return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", failure: Error | undefined;
    child.stdout.on("data", value => { output += value; });
    child.stderr.on("data", value => { output += value; });
    child.once("error", error => { failure = error; });
    child.once("close", (code, signal) => failure ? reject(failure) : signal ? reject(new Error(`SWITCH_INTERRUPTED:${signal}`)) : resolve({ code, output }));
  });
}

/** 仅等待自有夹具标记，缺失以外的文件错误立即上抛。 */
async function waitFor(file: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await fs.access(file); return; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    assert.ok(Date.now() < deadline, `fixture marker missing: ${file}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** 独占隔离目录编译旧/新壳及真实切换器，不包含Client、数据库、安装和注册表操作。 */
async function fixture(kind: "normal" | "wait" | "invalid-target" | "early-exit" | "timeout" | "replace-failure" | "partial-replace" | "late-exit" | "hang" | "slow-ready" | "wrong-ready-pid" | "stale-ready" | "forged-client" = "normal") {
  assert.equal(await fs.access(source).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), true, "independent native shell switch is missing");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nsis-switch-"));
  const userData = path.join(root, "用户 空间 $"), sessionData = path.join(root, "会话 空间 $");
  await fs.mkdir(userData); await fs.mkdir(sessionData);
  /** 所有编译输入和完整输出均留在此夹具，任何编译错误直接失败。 */
  async function compile(input: string, args: string[] = []) {
    const result = await execute(compiler!, ["/V2", "/INPUTCHARSET", "UTF8", ...args, input]);
    assert.equal(result.code, 0, `${root}\n${result.output}`);
  }
  for (const id of kind === "forged-client" ? ["old", "new", "forger"] : ["old", "new"]) {
    const directory = path.join(root, "shells", id);
    await fs.mkdir(directory, { recursive: true });
    const input = path.join(root, `${id}.nsi`);
    await fs.writeFile(input, `Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "Isolated switch shell"
OutFile "${literal(path.join(directory, "CodeFlowAI.exe"))}"
!include "LogicLib.nsh"
Section
  System::Call 'kernel32::GetCommandLineW() p.r0'
  System::Call 'shell32::CommandLineToArgvW(p r0, *i .r1) p.r2'
  \${If} $1 == 4
    FileOpen $6 "$EXEDIR\\argv.txt" w
    IntOp $3 $2 + 4
    System::Call '*$3(p .r4)'
    System::Call 'kernel32::lstrcpynW(w .r5, p r4, i 8192) p'
    FileWriteUTF16LE $6 "$5$\\r$\\n"
    IntOp $3 $2 + 8
    System::Call '*$3(p .r4)'
    System::Call 'kernel32::lstrcpynW(w .r5, p r4, i 8192) p'
    FileWriteUTF16LE $6 "$5$\\r$\\n"
    FileClose $6
    IntOp $3 $2 + 12
    System::Call '*$3(p .r4)'
    System::Call 'kernel32::lstrcpynW(w .r5, p r4, i 8192) p'
    StrCpy $7 $5 36 23
    StrCpy $8 "\\\\.\\pipe\\codeflow-shell-ready-$7"
  \${EndIf}
  System::Call 'kernel32::LocalFree(p r2) p.r0'
  FileOpen $0 "$EXEDIR\\started.txt" w
  FileWrite $0 "started"
  FileClose $0
  ${id === "new" && kind === "forged-client" ? `Exec '$\\"$EXEDIR\\\\..\\\\forger\\\\CodeFlowAI.exe$\\" --user-data-dir=x --codeflow-session-data-dir=y --codeflow-shell-ready=${requestId}'` : ""}
  ${id !== "old" && !(id === "new" && kind === "forged-client") && !["early-exit", "late-exit", "hang"].includes(kind) ? `Sleep ${kind === "slow-ready" ? 3500 : 0}
  System::Call 'kernel32::GetCurrentProcessId() i.r9'
  ${kind === "wrong-ready-pid" ? 'StrCpy $9 1' : ""}
  ${kind === "stale-ready" ? 'StrCpy $7 "00000000-0000-4000-8000-000000000000"' : ""}
  System::Call 'kernel32::CreateFileW(w "$8", i 0xC0000000, i 0, p 0, i 3, i 0, p 0) p.r0'
  FileWrite $0 "$7:$9$\\r$\\n"
  System::Call 'kernel32::ReadFile(p r0, *i .r1, i 1, *i .r2, p 0) i.r3'
  System::Call 'kernel32::CloseHandle(p r0) i.r1'` : ""}
  Sleep ${id === "old" ? kind === "timeout" || kind === "wait" ? 2500 : 500 : kind === "early-exit" ? 50 : kind === "late-exit" ? 3500 : kind === "hang" ? 8000 : 4000}
  FileOpen $0 "$EXEDIR\\done.txt" w
  FileWrite $0 "done"
  FileClose $0
SectionEnd
`, { encoding: "utf8", flag: "wx" });
    await compile(input);
  }
  if (kind === "invalid-target") await fs.writeFile(path.join(root, "shells/new/CodeFlowAI.exe"), "invalid", "ascii");
  await fs.writeFile(path.join(root, "shell-launch.ini"), original, "ascii");
  await fs.writeFile(path.join(root, "profile.json"), '{"deviceId":"原样","tasks":[1]}', "utf8");
  let input = source;
  if (kind === "replace-failure" || kind === "partial-replace") {
    const current = await fs.readFile(source, "utf8"), anchor = 'kernel32::ReplaceFileW(w "$root\\shell-launch.ini", w "$temporary",';
    assert.equal(current.split(anchor).length, 2);
    input = path.join(root, "fault-switch.nsi");
    const changed = kind === "replace-failure" ? current.replace(anchor, 'kernel32::ReplaceFileW(w "$root\\nonexistent.ini", w "$temporary",')
      : current.replace("    StrCpy $committed true", "    StrCpy $win32Error 1177\n    Goto replace_failed\n    StrCpy $committed true");
    await fs.writeFile(input, changed, "utf8");
  }
  const executable = path.join(root, "switch.exe");
  await compile(input, [`/DOUTPUT_FILE=${executable}`, `/DSWITCH_WAIT_MS=${kind === "timeout" ? 100 : 5000}`, "/DSHELL_READY_WAIT_MS=4500"]);
  const args = ["--root", root, "--previous", "old", "--target", "new", "--pid", "2147483646", "--request-id", requestId,
    "--user-data-dir", userData, "--session-data-dir", sessionData];
  return { root, executable, args, userData, sessionData };
}

for (const kind of ["late-exit", "hang", "wrong-ready-pid", "stale-ready", "forged-client"] as const) {
  test(`native switch rejects ${kind} and stops its real candidate before rollback`, { skip }, async () => {
    const f = await fixture(kind), result = await execute(f.executable, f.args);
    assert.notEqual(result.code, 0, f.root);
    assert.equal(await fs.readFile(path.join(f.root, "shell-launch.ini"), "ascii"), original);
    const journal = await fs.readFile(path.join(f.root, "shell-switch.ini"), "ascii");
    assert.match(journal, /phase=failed\r\n/u);
    await waitFor(path.join(f.root, "shells/old/started.txt"));
    assert.match(journal, new RegExp(`requestId=${requestId}\\r\\n`));
    assert.match(journal, /candidatePid=[1-9][0-9]*\r\n/u);
    assert.match(journal, new RegExp(`errorCode=${kind === "late-exit" ? "TARGET_EXITED_EARLY" : kind === "hang" ? "TARGET_READY_TIMEOUT" : kind === "forged-client" ? "TARGET_READY_IDENTITY_INVALID" : "TARGET_READY_RESPONSE_INVALID"}\\r\\n`));
    if (kind !== "late-exit") await assert.rejects(fs.access(path.join(f.root, "shells/new/done.txt")), { code: "ENOENT" });
    if (kind === "forged-client") await waitFor(path.join(f.root, "shells/forger/done.txt"));
  });
}

test("native switch waits beyond three seconds for an explicit shell ready confirmation", { skip }, async () => {
  const f = await fixture("slow-ready"), began = Date.now(), result = await execute(f.executable, f.args);
  assert.equal(result.code, 0, f.root);
  assert.ok(Date.now() - began >= 3500);
  assert.match(await fs.readFile(path.join(f.root, "shell-switch.ini"), "ascii"), /phase=started\r\n/u);
  await waitFor(path.join(f.root, "shells/new/done.txt"));
});

test("interrupting the native switch before readiness leaves the original selection", { skip }, async () => {
  const f = await fixture("hang");
  const child = spawn(f.executable, f.args, { windowsHide: true, stdio: "ignore" });
  const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
  try {
    await waitFor(path.join(f.root, "shells/new/started.txt"));
    assert.ok(child.kill());
    await closed;
    assert.equal(await fs.readFile(path.join(f.root, "shell-launch.ini"), "ascii"), original);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
});

test("native switch waits for the exact old process, commits selection and starts without business resources", { skip }, async () => {
  const f = await fixture("wait");
  const child = spawn(path.join(f.root, "shells/old/CodeFlowAI.exe"), [], { windowsHide: true, stdio: "ignore" });
  const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
  f.args[7] = String(child.pid);
  const switching = execute(f.executable, f.args);
  await waitFor(path.join(f.root, "shell-switch.ini"));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(child.exitCode, null, "the wait fixture must still be alive before commit");
  assert.equal(await fs.readFile(path.join(f.root, "shell-launch.ini"), "ascii"), original);
  await assert.rejects(fs.access(path.join(f.root, "shells/new/started.txt")), { code: "ENOENT" });
  assert.match(await fs.readFile(path.join(f.root, "shell-switch.ini"), "ascii"), /phase=waiting\r\n/u, "the next shell can read the transaction while its writer remains held");
  assert.notEqual((await execute(f.executable, f.args)).code, 0, "a second helper cannot acquire the same transaction writer");
  const result = await switching;
  await closed;
  assert.equal(result.code, 0, result.output);
  assert.equal(await fs.readFile(path.join(f.root, "shell-launch.ini"), "ascii"), original.replace("active=old", "active=new").replace("previous=\r", "previous=old\r"));
  await waitFor(path.join(f.root, "shells/new/done.txt"));
  assert.deepEqual((await fs.readFile(path.join(f.root, "shells/new/argv.txt"), "utf16le")).trimEnd().split("\r\n"),
    [`--user-data-dir=${f.userData}`, `--codeflow-session-data-dir=${f.sessionData}`], "the actual native argv must preserve both isolated profile roots");
  assert.match(await fs.readFile(path.join(f.root, "shell-switch.ini"), "ascii"), /phase=started\r\n/u);
  assert.equal(await fs.readFile(path.join(f.root, "profile.json"), "utf8"), '{"deviceId":"原样","tasks":[1]}');
});

for (const kind of ["invalid-target", "early-exit", "replace-failure", "partial-replace"] as const) {
  test(`native switch retains original selection on ${kind}`, { skip }, async () => {
    const f = await fixture(kind), result = await execute(f.executable, f.args);
    assert.notEqual(result.code, 0, f.root);
    assert.equal(await fs.readFile(path.join(f.root, "shell-launch.ini"), "ascii"), original);
    assert.match(await fs.readFile(path.join(f.root, "shell-switch.ini"), "ascii"), kind === "partial-replace" ? /phase=rolled-back\r\n/u : /phase=failed\r\n/u);
    if (kind === "invalid-target") await assert.rejects(fs.access(path.join(f.root, "shells/new/started.txt")), { code: "ENOENT" });
  });
}

test("native switch times out without modifying selection or killing the old process", { skip }, async () => {
  const f = await fixture("timeout"), child = spawn(path.join(f.root, "shells/old/CodeFlowAI.exe"), [], { windowsHide: true, stdio: "ignore" });
  const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
  f.args[7] = String(child.pid);
  const result = await execute(f.executable, f.args);
  assert.notEqual(result.code, 0, f.root);
  assert.equal(child.exitCode, null, "the switch never terminates the business process");
  assert.equal(await fs.readFile(path.join(f.root, "shell-launch.ini"), "ascii"), original);
  assert.match(await fs.readFile(path.join(f.root, "shell-switch.ini"), "ascii"), /errorCode=OLD_PROCESS_TIMEOUT\r\n/u);
  await closed;
});

for (const mutation of ["wrong-pid", "traversal", "extra", "state-mismatch", "junction", "root-junction", "reserved-id", "bad-request", "missing-profile", "relative-profile", "profile-junction"] as const) {
  test(`native switch rejects ${mutation} before selection changes`, { skip }, async () => {
    const f = await fixture();
    if (mutation === "wrong-pid") f.args[7] = String(process.pid);
    if (mutation === "traversal") f.args[5] = "../escape";
    if (mutation === "extra") f.args.push("--unknown");
    if (mutation === "state-mismatch") f.args[3] = "other";
    if (mutation === "reserved-id") f.args[5] = "COM1.exe";
    if (mutation === "bad-request") f.args[9] = "not-a-uuid";
    if (mutation === "missing-profile") f.args.splice(10);
    if (mutation === "relative-profile") f.args[11] = "relative-profile";
    if (mutation === "profile-junction") {
      const alias = path.join(f.root, "profile-alias");
      await fs.symlink(f.userData, alias, "junction");
      f.args[11] = alias;
    }
    if (mutation === "root-junction") {
      const alias = path.join(f.root, "..", `${path.basename(f.root)}-alias`);
      await fs.symlink(f.root, alias, "junction");
      f.args[1] = alias;
    }
    if (mutation === "junction") {
      await fs.rename(path.join(f.root, "shells/new"), path.join(f.root, "actual-new"));
      await fs.symlink(path.join(f.root, "actual-new"), path.join(f.root, "shells/new"), "junction");
    }
    assert.notEqual((await execute(f.executable, f.args)).code, 0, f.root);
    assert.equal(await fs.readFile(path.join(f.root, "shell-launch.ini"), "ascii"), original);
    await assert.rejects(fs.access(path.join(f.root, "shells/new/started.txt")), { code: "ENOENT" });
  });
}

test("native switch preserves trailing backslashes in isolated profile argv", { skip }, async () => {
  const f = await fixture();
  f.args[11] += "\\";
  f.args[13] += "\\";
  assert.equal((await execute(f.executable, f.args)).code, 0, f.root);
  await waitFor(path.join(f.root, "shells/new/done.txt"));
  assert.deepEqual((await fs.readFile(path.join(f.root, "shells/new/argv.txt"), "utf16le")).trimEnd().split("\r\n"),
    [`--user-data-dir=${f.userData}\\`, `--codeflow-session-data-dir=${f.sessionData}\\`]);
});

for (const change of ["BOM", "LF", "duplicate", "extra-bytes", "baseline-path"] as const) {
  test(`native switch rejects ${change} selection without repairing or changing its bytes`, { skip }, async () => {
    const f = await fixture();
    const invalid = change === "BOM" ? Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(original)])
      : Buffer.from(change === "LF" ? original.replaceAll("\r\n", "\n")
        : change === "duplicate" ? original + "active=old\r\n"
        : change === "extra-bytes" ? original + "x"
        : original.replace("baseline=old", "baseline=../other"));
    await fs.writeFile(path.join(f.root, "shell-launch.ini"), invalid);
    assert.notEqual((await execute(f.executable, f.args)).code, 0, f.root);
    assert.deepEqual(await fs.readFile(path.join(f.root, "shell-launch.ini")), invalid);
    await assert.rejects(fs.access(path.join(f.root, "shells/new/started.txt")), { code: "ENOENT" });
  });
}
