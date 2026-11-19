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

/** 复用真实保留说明页，仅注入定时点击；夹具不调用业务维护。 */
async function fixture(choice: "default" | "cancel" | "back" | "upgrade") {
  const parent = process.env.CF_NSIS_RUNTIME_ROOT ?? os.tmpdir();
  assert.ok(path.isAbsolute(parent));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, `nsis-page-${choice}-`));
  const temporary = path.join(root, "temporary"); await fs.mkdir(temporary);
  await fs.writeFile(path.join(root, "profile.json"), '{"account":"账号","deviceId":"keep","tasks":[1]}', "utf8");
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
!define CODEFLOW_STOP_INSTALLED_INCLUDE "${fileURLToPath(new URL("../build/stop-installed-processes.nsh", import.meta.url))}"
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
  FileOpen $1 "$EXEDIR\\page-state.txt" a
  FileSeek $1 0 END
  FileWrite $1 "$visits$\\r$\\n"
  FileClose $1
  FileOpen $1 "$EXEDIR\\page-copy.txt" a
  FileSeek $1 0 END
  System::Call 'user32::GetWindow(p $HWNDPARENT, i 5) p.r2'
  scan_dialog:
  StrCmp $2 0 page_copy_done
  System::Call 'user32::GetWindow(p r2, i 5) p.r4'
  scan_label:
  StrCmp $4 0 next_dialog
  System::Call 'user32::GetWindowTextW(p r4, w .r0, i 1024) i.r3'
  FileWriteUTF16LE $1 "$0$\\r$\\n"
  System::Call 'user32::GetWindow(p r4, i 2) p.r4'
  Goto scan_label
  next_dialog:
  System::Call 'user32::GetWindowTextW(p r2, w .r0, i 1024) i.r3'
  FileWriteUTF16LE $1 "$0$\\r$\\n"
  System::Call 'user32::GetWindow(p r2, i 2) p.r2'
  Goto scan_dialog
  page_copy_done:
  FileClose $1
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

for (const [choice, states] of [["default", "1\r\n"], ["back", "1\r\n2\r\n"]] as const) {
  test(`real uninstall page preserves all data on ${choice} navigation`, { skip }, async () => {
    const f = await fixture(choice), result = await execute(f.executable, [`_?=${f.root}`], f.env);
    assert.equal(result.code, 0, JSON.stringify({ root: f.root, ...result }));
    assert.equal(await fs.readFile(path.join(f.root, "page-state.txt"), "ascii"), states);
    const copy = await fs.readFile(path.join(f.root, "page-copy.txt"), "utf16le");
    assert.match(copy, /账号、设备身份、配置和业务任务原样保留/u);
    assert.match(copy, /项目和工作区 \.codeflow 始终保留/u);
    assert.match(copy, /在应用内显式操作并确认清理结果/u);
    await assert.rejects(fs.access(path.join(f.root, "maintenance.txt")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(f.root, "profile.json"), "utf8"), '{"account":"账号","deviceId":"keep","tasks":[1]}');
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
