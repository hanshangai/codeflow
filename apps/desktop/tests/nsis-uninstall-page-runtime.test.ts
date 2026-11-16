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

/** 原生参数直传，无 shell；失败只清理本次 spawn 所持句柄。 */
async function execute(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    child.stdout.on("data", bytes => { stdout += bytes.toString("utf8"); });
    child.stderr.on("data", bytes => { stderr += bytes.toString("utf8"); });
    child.once("error", error => { failure = error; });
    child.once("close", (code, signal) => {
      if (failure) reject(failure);
      else if (signal) reject(new Error(`NSIS_PAGE_FIXTURE_INTERRUPTED:${signal}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

/** 复用真实页面与维护宏，仅在 Show 前注入定时点击，不替换选择或维护分支。 */
async function fixture(choice: "default" | "remove" | "cancel" | "back" | "upgrade" | "unconfirmed" | "invalid") {
  const parent = process.env.CF_NSIS_RUNTIME_ROOT ?? os.tmpdir();
  assert.ok(path.isAbsolute(parent));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, `nsis-page-${choice}-`));
  const temporary = path.join(root, "temporary"); await fs.mkdir(temporary);
  const env = { ...process.env, TEMP: temporary, TMP: temporary };
  /** 保留完整输入与编译诊断；夹具不包含任何删除或注册表指令。 */
  async function compile(name: string, body: string) {
    const output = path.join(root, `${name}.exe`), source = path.join(root, `${name}.nsi`);
    await fs.writeFile(source, `Unicode true\nRequestExecutionLevel user\nAutoCloseWindow true\nName "NSIS page contract"\nOutFile "${output}"\n${body}`, { encoding: "utf8", flag: "wx" });
    const result = await execute(compiler!, ["/V2", "/INPUTCHARSET", "UTF8", source], env);
    await fs.writeFile(path.join(root, `${name}-compile.log`), result.stdout + result.stderr, { encoding: "utf8", flag: "wx" });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return output;
  }
  const child = await compile("child", `SilentInstall silent
!include "FileFunc.nsh"
Section
  \${GetParameters} $0
  FileOpen $1 "$EXEDIR\\maintenance.txt" w
  FileWrite $1 "$0"
  FileClose $1
SectionEnd
`);
  await fs.copyFile(child, path.join(root, "CodeFlowAI.exe"), fs.constants.COPYFILE_EXCL);
  const current = await fs.readFile(hook, "utf8"), anchor = "    nsDialogs::Show";
  assert.equal(current.split(anchor).length, 2);
  const inputHook = path.join(root, "observed-hook.nsh");
  await fs.writeFile(inputHook, current.replace(anchor, `    \${NSD_CreateTimer} un.TestNext 80\n${anchor}`), { encoding: "utf8", flag: "wx" });
  const generator = await compile("generator", `SilentInstall silent
!define BUILD_UNINSTALLER
!include "MUI2.nsh"
!include "${inputHook}"
!define isUpdated '"${choice === "upgrade" ? "updated" : "ordinary"}" == "updated"'
Var visits
!insertmacro customUnWelcomePage
${choice === "back" ? `UninstPage custom un.TestSecond
Function un.TestSecond
  nsDialogs::Create 1018
  Pop $0
  \${NSD_CreateTimer} un.TestBack 80
  nsDialogs::Show
FunctionEnd
Function un.TestBack
  \${NSD_KillTimer} un.TestBack
  \${If} $visits == 1
    GetDlgItem $0 $HWNDPARENT 3
  \${Else}
    GetDlgItem $0 $HWNDPARENT 1
  \${EndIf}
  System::Call 'user32::PostMessageW(p r0, i \${BM_CLICK}, p 0, p 0) i.r1'
FunctionEnd` : ""}
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Function un.onInit
  StrCpy $INSTDIR "$EXEDIR"
  StrCpy $visits 0
FunctionEnd
Function un.TestNext
  \${NSD_KillTimer} un.TestNext
  IntOp $visits $visits + 1
  ${choice === "remove" || choice === "back" ? `\${If} $visits == 1\n    \${NSD_Uncheck} $d16KeepData\n  \${EndIf}` : ""}
  \${NSD_GetState} $d16KeepData $0
  FileOpen $1 "$EXEDIR\\page-state.txt" a
  FileSeek $1 0 END
  FileWrite $1 "$0$\\r$\\n"
  FileClose $1
  FileOpen $1 "$EXEDIR\\page-copy.txt" a
  FileSeek $1 0 END
  System::Call 'user32::GetWindow(p $d16KeepData, i 3) p.r2'
  System::Call 'user32::GetWindowTextW(p r2, w .r0, i 1024) i.r3'
  FileWriteUTF16LE $1 "$0$\\r$\\n"
  System::Call 'user32::GetWindow(p $d16KeepData, i 2) p.r2'
  System::Call 'user32::GetWindowTextW(p r2, w .r0, i 1024) i.r3'
  FileWriteUTF16LE $1 "$0$\\r$\\n"
  FileClose $1
  ${choice === "invalid" ? `System::Call 'user32::DestroyWindow(p $d16KeepData) i.r0'\n  SetSilent silent` : ""}
  GetDlgItem $0 $HWNDPARENT ${choice === "cancel" ? 2 : 1}
  System::Call 'user32::PostMessageW(p r0, i \${BM_CLICK}, p 0, p 0) i.r1'
FunctionEnd
Section
  WriteUninstaller "$EXEDIR\\page-stub.exe"
SectionEnd
Section "Uninstall"
  !insertmacro customUnInstall
  FileOpen $1 "$EXEDIR\\continued.txt" w
  FileWrite $1 "continued"
  FileClose $1
  SetErrorLevel 0
  Quit
SectionEnd
`);
  assert.equal((await execute(generator, [], env)).code, 0);
  return { root, env, executable: path.join(root, "page-stub.exe") };
}

for (const [choice, expected, states] of [["default", "keep", "1\r\n"], ["remove", "remove", "0\r\n"], ["back", "remove", "0\r\n0\r\n"]] as const) {
  test(`real uninstall page preserves ${choice} choice after leaving its control`, { skip }, async () => {
    const f = await fixture(choice), result = await execute(f.executable, [`_?=${f.root}`], f.env);
    assert.equal(result.code, 0, JSON.stringify({ root: f.root, ...result }));
    assert.equal(await fs.readFile(path.join(f.root, "page-state.txt"), "ascii"), states);
    const copy = await fs.readFile(path.join(f.root, "page-copy.txt"), "utf16le");
    assert.match(copy, /仅影响本机应用数据/u);
    assert.match(copy, /项目和工作区 \.codeflow 始终保留/u);
    assert.match(copy, /两种选择都会移除安装身份/u);
    assert.match(copy, /敏感凭据需重新录入/u);
    const args = await fs.readFile(path.join(f.root, "maintenance.txt"), "ascii");
    assert.match(args, new RegExp(`^--codeflow-uninstall-maintenance "nsis-[0-9-]+" "${expected}" --resume-pending$`, "u"));
    assert.equal(await fs.readFile(path.join(f.root, "continued.txt"), "ascii"), "continued");
  });
}

test("real uninstall page cancellation never starts maintenance", { skip }, async () => {
  const f = await fixture("cancel"), result = await execute(f.executable, [`_?=${f.root}`], f.env);
  assert.notEqual(result.code, 0);
  assert.equal(await fs.readFile(path.join(f.root, "page-state.txt"), "ascii"), "1\r\n");
  for (const file of ["maintenance.txt", "continued.txt"]) await assert.rejects(fs.access(path.join(f.root, file)), { code: "ENOENT" });
});

test("real upgrade skips the choice page and maintenance while continuing its section", { skip }, async () => {
  const f = await fixture("upgrade"), result = await execute(f.executable, [`_?=${f.root}`], f.env);
  assert.equal(result.code, 0, result.stderr);
  for (const file of ["page-state.txt", "maintenance.txt"]) await assert.rejects(fs.access(path.join(f.root, file)), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(f.root, "continued.txt"), "ascii"), "continued");
});

for (const choice of ["unconfirmed", "invalid"] as const) {
  test(`real uninstall rejects ${choice} choice without calling maintenance`, { skip }, async () => {
    const f = await fixture(choice), args = [...(choice === "unconfirmed" ? ["/S"] : []), `_?=${f.root}`];
    const result = await execute(f.executable, args, f.env);
    assert.equal(result.code, 1, `invalid choice must fail after recording its diagnostic: ${f.root}`);
    for (const file of ["maintenance.txt", "continued.txt"]) await assert.rejects(fs.access(path.join(f.root, file)), { code: "ENOENT" });
    const records = [];
    for (const file of await fs.readdir(f.env.TEMP)) {
      const target = path.join(f.env.TEMP, file);
      if ((await fs.lstat(target)).isFile()) records.push(JSON.parse(await fs.readFile(target, "utf8")));
    }
    assert.equal(records.length, 1, "one persistent choice failure record is required");
    assert.equal(records[0].errorCode, "DESKTOP_UNINSTALL_CHOICE_INVALID");
    assert.equal(records[0].appId, "ai.codeflow.codeflowai");
    assert.equal(records[0].stage, "uninstall-choice");
    assert.match(records[0].requestId, /^nsis-choice-[A-Za-z0-9._-]+$/u);
    assert.equal(records[0].rootCause, choice === "invalid" ? "CONTROL_INVALID" : "MODE_UNCONFIRMED");
    assert.deepEqual(Object.keys(records[0]).sort(), ["appId", "errorCode", "requestId", "rootCause", "stage"]);
  });
}
