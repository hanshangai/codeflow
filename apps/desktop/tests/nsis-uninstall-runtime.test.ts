import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const compiler = process.env.CF_NSIS_COMPILER;
const plugins = process.env.CF_NSIS_PLUGIN_DIR;
const skip = process.platform !== "win32" ? "Windows NSIS runtime required" : !compiler ? "Set CF_NSIS_COMPILER to run native contracts" : false;
const initSkip = skip || (!plugins ? "Set CF_NSIS_PLUGIN_DIR to the electron-builder x86-unicode plugins" : false);
const hook = fileURLToPath(new URL("../build/installer.nsh", import.meta.url));
type Kind = "missing" | "invalid" | "nonzero" | "success" | "prior-errors" | "log-unavailable" | "flush-failure" | "close-failure";

/** 只转义 NSIS 字符串，所有程序参数均直接传给 spawn。 */
function nsisPath(value: string): string {
  assert.doesNotMatch(value, /[\r\n\0]/u);
  return value.replaceAll("$", "$$").replaceAll('"', '$\\"');
}

/** 等待实际 close；超时只结束本次持有的进程句柄，并向上报告失败。 */
async function execute(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    child.stdout.on("data", bytes => { stdout += bytes.toString("utf8"); });
    child.stderr.on("data", bytes => { stderr += bytes.toString("utf8"); });
    child.once("error", error => { failure = error; });
    child.once("close", (code, signal) => {
      if (failure) reject(failure);
      else if (signal) reject(new Error(`NSIS_UNINSTALL_FIXTURE_INTERRUPTED:${signal}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

/** 编译真实 hook 与模板初始化；夹具只写标记，不执行产品安装、删除或注册表操作。 */
async function fixture(kind: Kind, initialized = false) {
  const parent = process.env.CF_NSIS_RUNTIME_ROOT ?? os.tmpdir();
  assert.ok(path.isAbsolute(parent));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, `nsis-uninstall-${kind}-`));
  const temporary = path.join(root, "temporary");
  await fs.mkdir(temporary);
  await fs.writeFile(path.join(root, "profile.json"), '{"account":"账号","deviceId":"unchanged","tasks":[1]}', "utf8");
  const env = { ...process.env, TEMP: temporary, TMP: temporary };
  /** 每次编译保留输入和完整诊断，任何编译失败均立即中止测试。 */
  async function compile(name: string, body: string) {
    const source = path.join(root, `${name}.nsi`), output = path.join(root, `${name}.exe`);
    await fs.writeFile(source, `Unicode true\nRequestExecutionLevel user\nAutoCloseWindow true\nName "NSIS uninstall contract"\nOutFile "${nsisPath(output)}"\n${body}`, { encoding: "utf8", flag: "wx" });
    const result = await execute(compiler!, ["/V2", "/INPUTCHARSET", "UTF8", source], env);
    await fs.writeFile(path.join(root, `${name}-compile.log`), result.stdout + result.stderr, { encoding: "utf8", flag: "wx" });
    assert.equal(result.code, 0, `${root}\n${result.stdout}${result.stderr}`);
    return output;
  }
  if (kind === "invalid") await fs.writeFile(path.join(root, "CodeFlowAI.exe"), "invalid executable", { encoding: "ascii", flag: "wx" });
  if (kind === "success" || kind === "prior-errors" || kind === "nonzero") {
    const child = await compile("child", `SilentInstall silent
!include "FileFunc.nsh"
Section
  \${GetParameters} $0
  StrCmp $0 "--codeflow-check-installation" 0 preflight_done
  FileOpen $1 "$EXEDIR\\preflight.txt" w
  FileWrite $1 "checked"
  FileClose $1
  SetErrorLevel ${kind === 'nonzero' ? 7 : 0}
  Quit
  preflight_done:
  FileOpen $1 "$EXEDIR\\maintenance.txt" w
  FileWrite $1 "$0"
  FileClose $1
  FileOpen $1 "$EXEDIR\\order.txt" w
  FileWrite $1 "started$\\r$\\n"
  Sleep 150
  FileWrite $1 "finished$\\r$\\n"
  FileClose $1
  SetErrorLevel ${kind === "nonzero" ? 7 : 0}
SectionEnd
`);
    await fs.copyFile(child, path.join(root, "CodeFlowAI.exe"), fs.constants.COPYFILE_EXCL);
  }
  let source = await fs.readFile(hook, "utf8");
  // 旧实现没有静默默认值，仅补对话框默认响应以观测真实分支和退出码。
  source = source.replace(/^([ \t]*MessageBox MB_ICONSTOP\|MB_OK[^\r\n]*)(\r?)$/gmu, (line: string) => line.includes(" /SD ") ? line : `${line.trimEnd()} /SD IDOK`);
  if (kind === "flush-failure" || kind === "close-failure") {
    const anchor = kind === "flush-failure"
      ? "\n    System::Call 'kernel32::FlushFileBuffers(p r3) i.r2'"
      : "\n    System::Call 'kernel32::CloseHandle(p r3) i.r2'";
    assert.equal(source.split(anchor).length, 2, "I/O fault must target the real uninstall diagnostic boundary once");
    source = source.replace(anchor, `\n    System::Call 'kernel32::CloseHandle(p r3) i.r2'${anchor}`);
  }
  const includedHook = path.join(root, "observed-hook.nsh");
  await fs.writeFile(includedHook, source, { encoding: "utf8", flag: "wx" });
  let initialization = `Function un.onInit
  StrCpy $INSTDIR "$EXEDIR"
  SetSilent silent
FunctionEnd`;
  let definitions = '!define isUpdated \'"ordinary" == "updated"\'';
  if (initialized) {
    const require = createRequire(await fs.realpath(fileURLToPath(new URL("../node_modules/electron-builder/package.json", import.meta.url))));
    const builder = path.dirname(require.resolve("app-builder-lib/package.json"));
    const template = await fs.readFile(path.join(builder, "templates/nsis/uninstaller.nsh"), "utf8");
    const original = template.match(/^Function un\.onInit\r?\n[\s\S]*?^FunctionEnd/gmu);
    assert.equal(original?.length, 1, "the installed template must expose exactly one un.onInit");
    const { NsisScriptGenerator } = require(path.join(builder, "out/targets/nsis/nsisScriptGenerator.js"));
    const generator = new NsisScriptGenerator();
    generator.flags(["updated"]);
    definitions = `!addplugindir /x86-unicode "${nsisPath(plugins!)}"
!include "${nsisPath(path.join(builder, "templates/nsis/include/StdUtils.nsh"))}"
${generator.build()}
!define LogSet '!insertmacro TestLogSet'
!macro TestLogSet setting
!macroend
!macro check64BitAndSetRegView
!macroend
!macro initMultiUser
!macroend
Function un.checkAppRunning
FunctionEnd`;
    // 保留原初始化和参数解析，只设定夹具根；原初始化完成后再隐藏无页面窗口。
    initialization = original![0].replace(/(Function un\.onInit\r?\n)/u, '$1  StrCpy $INSTDIR "$EXEDIR"\n')
      .replace(/^FunctionEnd/mu, "  SetSilent silent\nFunctionEnd");
    await fs.writeFile(path.join(root, "template-init.nsh"), original![0], { encoding: "utf8", flag: "wx" });
  }
  const generator = await compile("generator", `SilentInstall silent
!define BUILD_UNINSTALLER
!define CODEFLOW_STOP_INSTALLED_INCLUDE "${nsisPath(fileURLToPath(new URL("../build/stop-installed-processes.nsh", import.meta.url)))}"
!include "${nsisPath(includedHook)}"
${definitions}
${initialization}
Section
  WriteUninstaller "$EXEDIR\\uninstall-stub.exe"
SectionEnd
Section "Uninstall"
  StrCpy $0 0
  ${kind === "log-unavailable" ? `ClearErrors
  Rename "${nsisPath(temporary)}" "$EXEDIR\\moved-temp"
  IfErrors 0 +3
    SetErrorLevel 99
    Quit` : ""}
  ${kind === "prior-errors" ? "SetErrors" : "ClearErrors"}
  ${["log-unavailable", "flush-failure", "close-failure"].includes(kind) ? `Call un.D16NewRequestId
  StrCpy $d16FailureCode DESKTOP_INSTALL_PROCESS_STOP_FAILED
  StrCpy $d16FailureDetails '\"stage\":\"installation-process-stop\",\"rootCause\":\"PROCESS_STOP_FAILED\"'
  Call un.D16FailUninstall` : "!insertmacro customUnInstall"}
  FileOpen $1 "$EXEDIR\\order.txt" a
  FileSeek $1 0 END
  FileWrite $1 "continued$\\r$\\n"
  FileClose $1
  SetErrorLevel 0
  Quit
SectionEnd
`);
  assert.equal((await execute(generator, [], env)).code, 0);
  return { root, temporary, env, executable: path.join(root, "uninstall-stub.exe") };
}

/** 仅读取本夹具 TEMP 中的诊断文件，插件临时目录不计入业务日志。 */
async function diagnostics(temporary: string) {
  const records = [];
  for (const name of await fs.readdir(temporary)) {
    const file = path.join(temporary, name);
    if ((await fs.lstat(file)).isFile()) {
      for (const line of (await fs.readFile(file, "utf8")).trim().split(/\r?\n/u)) {
        const record = JSON.parse(line);
        if (record.errorCode) records.push(record);
      }
    }
  }
  return records;
}

for (const kind of ["missing", "invalid", "nonzero", "success", "prior-errors"] as const) {
  test(`real keep uninstall continues without running ${kind} business executable`, { skip }, async () => {
    const f = await fixture(kind), result = await execute(f.executable, [`_?=${f.root}`], f.env);
    await fs.writeFile(path.join(f.root, "result.json"), JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    assert.equal(result.code, 0, `program removal must be independent: ${f.root}`);
    assert.equal(await fs.readFile(path.join(f.root, "order.txt"), "ascii"), "continued\r\n");
    for (const file of ["maintenance.txt", "preflight.txt"]) await assert.rejects(fs.access(path.join(f.root, file)), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(f.root, "profile.json"), "utf8"), '{"account":"账号","deviceId":"unchanged","tasks":[1]}');
    assert.deepEqual(await diagnostics(f.temporary), []);
  });
}

for (const kind of ["log-unavailable", "flush-failure", "close-failure"] as const) {
  test(`real uninstall maintenance reports diagnostic ${kind} as failure`, { skip }, async () => {
    const f = await fixture(kind), result = await execute(f.executable, [`_?=${f.root}`], f.env);
    assert.equal(result.code, 2, `diagnostic failure must be distinguished: ${f.root}`);
    await assert.rejects(fs.access(path.join(f.root, "order.txt")), { code: "ENOENT" });
  });
}

for (const [name, args, expected] of [
  ["ordinary", [], "maintenance"],
  ["upgrade", ["--updated", "/S"], "upgrade"],
  ["interactive upgrade", ["--updated"], "upgrade"],
  ["silent", ["/S"], "ordinary"],
  ["template upgrade alias", ["/updated", "/S"], "upgrade"],
  ["similar upgrade spelling", ["--updated-other", "/S"], "ordinary"],
  ["explicit deletion", ["--delete-app-data", "/S"], "DELETE_APP_DATA_UNSUPPORTED"],
  ["upgrade with explicit deletion", ["--updated", "--delete-app-data", "/S"], "DELETE_APP_DATA_UNSUPPORTED"],
] as const) {
  test(`real template initialization handles ${name} parameters before maintenance`, { skip: initSkip }, async () => {
    const f = await fixture("success", true), result = await execute(f.executable, [...args, `_?=${f.root}`], f.env);
    if (expected === "maintenance" || expected === "upgrade" || expected === "ordinary") {
      assert.equal(result.code, 0, `valid initialization must continue: ${f.root}`);
      assert.equal(await fs.readFile(path.join(f.root, "order.txt"), "ascii"), "continued\r\n");
      assert.deepEqual(await diagnostics(f.temporary), []);
      if (expected === "upgrade") await assert.rejects(fs.access(path.join(f.root, "maintenance.txt")), { code: "ENOENT" });
    } else {
      assert.equal(result.code, 1, `unsupported initialization must fail: ${f.root}`);
      for (const file of ["maintenance.txt", "order.txt"]) await assert.rejects(fs.access(path.join(f.root, file)), { code: "ENOENT" });
      const records = await diagnostics(f.temporary);
      assert.equal(records.length, 1, "initialization refusal requires its own diagnostic");
      assert.equal(records[0].errorCode, "DESKTOP_UNINSTALL_INVOCATION_REJECTED");
      assert.equal(records[0].stage, "uninstall-init");
      assert.equal(records[0].appId, "ai.codeflow.codeflowai");
      assert.equal(records[0].rootCause, expected);
      assert.match(records[0].requestId, /^nsis-[A-Za-z0-9._-]+$/u);
      assert.deepEqual(Object.keys(records[0]).sort(), ["appId", "errorCode", "requestId", "rootCause", "stage"]);
    }
  });
}

test('real template upgrade never asks the old business executable for admission', { skip: initSkip }, async () => {
  const f = await fixture('nonzero', true), result = await execute(f.executable, ['--updated', '/S', `_?=${f.root}`], f.env);
  assert.equal(result.code, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'order.txt'), 'ascii'), 'continued\r\n');
  for (const file of ['maintenance.txt', 'preflight.txt']) await assert.rejects(fs.access(path.join(f.root, file)), { code: 'ENOENT' });
  assert.deepEqual(await diagnostics(f.temporary), []);
});

test("standard silent keep uninstall succeeds without any business executable and preserves profile bytes", { skip: initSkip }, async () => {
  const f = await fixture("missing", true), before = await fs.readFile(path.join(f.root, "profile.json"));
  const result = await execute(f.executable, ["/S", "/currentuser", `_?=${f.root}`], f.env);
  assert.equal(result.code, 0, f.root);
  assert.equal(await fs.readFile(path.join(f.root, "order.txt"), "ascii"), "continued\r\n");
  assert.deepEqual(await fs.readFile(path.join(f.root, "profile.json")), before);
  assert.deepEqual(await diagnostics(f.temporary), []);
});
