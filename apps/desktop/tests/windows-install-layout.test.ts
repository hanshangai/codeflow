import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { build, Platform, Arch } from "electron-builder";
import { resolveInstalledElectronDist } from "../scripts/package-local-builder.mjs";
import { readShellLaunchState } from "../src/shellLaunchState.js";

const moduleUrl = new URL("../scripts/windows-install-layout.mjs", import.meta.url);

/** 独占目录模拟 builder 已完成的平铺 Electron 包，不接触运行安装。 */
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-install-layout-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const appOutDir = path.join(root, "win-unpacked"), launcherExecutable = path.join(root, "launcher.exe");
  const files = { "CodeFlowAI.exe": "electron", "chrome_100_percent.pak": "pak", "locales/zh-CN.pak": "中文",
    "resources/app.asar": "application", "resources/web/index.html": "web", "resources/client/dist/index.cjs": "client",
    "resources/client/dist/desktopUninstallWorker.cjs": "worker", "resources/release-trust.json": "{}",
    "resources/baseline-release-manifest.json": "{}" };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(appOutDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, "utf8");
  }
  await fs.writeFile(launcherExecutable, "fixed launcher", "ascii");
  return { root, appOutDir, launcherExecutable, files };
}

/** 缺失入口作为行为断言失败，避免把未实现误报成加载错误。 */
async function layout() {
  const exists = await fs.access(moduleUrl).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  assert.equal(exists, true, "完整安装包尚未生成版本化壳布局");
  return await import(moduleUrl.href) as typeof import("../scripts/windows-install-layout.mjs");
}

test("full installer layout preserves the entire Electron payload and selects its own baseline", async t => {
  const f = await fixture(t), { prepareWindowsInstallLayout } = await layout();
  await prepareWindowsInstallLayout(f);
  assert.deepEqual((await fs.readdir(f.appOutDir)).sort(), ["CodeFlowAI.exe", "shell-launch.ini", "shells"]);
  assert.equal(await fs.readFile(path.join(f.appOutDir, "CodeFlowAI.exe"), "ascii"), "fixed launcher");
  for (const [relative, contents] of Object.entries(f.files)) {
    assert.equal(await fs.readFile(path.join(f.appOutDir, "shells/installation", relative), "utf8"), contents);
  }
  const launch = await readShellLaunchState(f.appOutDir);
  assert.deepEqual(launch.state, { activeShellId: "installation", previousShellId: null, baselineShellId: "installation" });
  assert.equal(launch.executablePath, path.join(f.appOutDir, "shells/installation/CodeFlowAI.exe"));
  assert.equal(launch.initialReleaseDir, path.join(f.appOutDir, "shells/installation/resources"));
  await assert.rejects(prepareWindowsInstallLayout(f), /DESKTOP_WINDOWS_INSTALL_LAYOUT_ALREADY_VERSIONED/u);
  assert.deepEqual((await fs.readdir(path.join(f.appOutDir, "shells"))).sort(), ["installation"]);
});

for (const missing of ["CodeFlowAI.exe", "resources/app.asar", "resources/baseline-release-manifest.json",
  "resources/client/dist/desktopUninstallWorker.cjs", "resources/web/index.html", "resources/release-trust.json"]) {
  test(`missing full installer payload ${missing} fails before moving any files`, async t => {
    const f = await fixture(t), { prepareWindowsInstallLayout } = await layout();
    await fs.unlink(path.join(f.appOutDir, missing));
    const before = await fs.readdir(f.appOutDir);
    await assert.rejects(prepareWindowsInstallLayout(f), /ENOENT/u);
    assert.deepEqual(await fs.readdir(f.appOutDir), before);
    await assert.rejects(fs.access(path.join(f.appOutDir, "shells")), { code: "ENOENT" });
  });
}

test("a launcher inside the payload is rejected before layout mutation", async t => {
  const f = await fixture(t), { prepareWindowsInstallLayout } = await layout();
  await assert.rejects(prepareWindowsInstallLayout({ ...f, launcherExecutable: path.join(f.appOutDir, "CodeFlowAI.exe") }),
    /DESKTOP_WINDOWS_INSTALL_LAYOUT_LAUNCHER_OVERLAP/u);
  assert.equal(await fs.readFile(path.join(f.appOutDir, "CodeFlowAI.exe"), "ascii"), "electron");
  await assert.rejects(fs.access(path.join(f.appOutDir, "shells")), { code: "ENOENT" });
});

test("a nested junction is rejected without moving its external target", async t => {
  const f = await fixture(t), { prepareWindowsInstallLayout } = await layout(), external = path.join(f.root, "external");
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, "marker"), "keep", "ascii");
  await fs.symlink(external, path.join(f.appOutDir, "locales/alias"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareWindowsInstallLayout(f), /DESKTOP_WINDOWS_INSTALL_LAYOUT_ENTRY_INVALID/u);
  assert.equal(await fs.readFile(path.join(external, "marker"), "ascii"), "keep");
  await assert.rejects(fs.access(path.join(f.appOutDir, "shells")), { code: "ENOENT" });
});

test("real NSIS build archives the versioned layout after builder validates and edits Electron", {
  skip: process.platform !== "win32" || process.env.CF_WINDOWS_INSTALL_LAYOUT_SMOKE !== "1",
}, async t => {
  let registryCleanup: string | undefined;
  t.after(async () => { if (registryCleanup) { const result = await execute(registryCleanup, []); assert.equal(result.code, 0, result.output); } });
  const f = await fixture(t), projectDir = path.join(f.root, "project"), output = path.join(f.root, "output");
  const guid = crypto.randomUUID(), shortcutName = `CodeFlow upgrade fixture ${guid}`, installDirectory = path.join(f.root, "installed");
  const packageName = `codeflow-layout-fixture-${guid}`;
  /** 编译并执行隔离NSIS辅助程序，只操作此随机GUID的注册项与本夹具路径。 */
  async function nativeFixture(name: string, section: string) {
    const input = path.join(f.root, `${name}.nsi`), executable = path.join(f.root, `${name}.exe`);
    await fs.writeFile(input, `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nAutoCloseWindow true\nName "Isolated fixture"\nOutFile "${executable}"\nSection\nSetRegView 64\n${section}\nSectionEnd\n`, "utf8");
    assert.ok(process.env.CF_NSIS_COMPILER, "set CF_NSIS_COMPILER for the actual upgrade fixture");
    const compiled = await execute(process.env.CF_NSIS_COMPILER!, ["/V2", "/INPUTCHARSET", "UTF8", input]);
    assert.equal(compiled.code, 0, compiled.output);
    return executable;
  }
  /** 等待原始子进程关闭，安装与故障夹具均保留非零退出码。 */
  async function execute(file: string, args: string[]) {
    return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(file, args, { windowsHide: true, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", failure: Error | undefined;
      child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
      child.once("error", error => { failure = error; });
      child.once("close", (code, signal) => failure ? reject(failure) : signal ? reject(new Error(`UPGRADE_FIXTURE_INTERRUPTED:${signal}`)) : resolve({ code, output }));
    });
  }
  await fs.mkdir(projectDir);
  await fs.writeFile(path.join(projectDir, "package.json"),
    JSON.stringify({ name: packageName, version: "1.0.0", main: "main.js", description: "Isolated layout smoke", author: "CodeFlow" }), "utf8");
  const argumentsFile = path.join(f.root, "arguments.json");
  await fs.writeFile(path.join(projectDir, "main.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(process.argv)); process.exit(7);`, "ascii");
  const icon = path.join(f.root, "shell icon.ico");
  await fs.copyFile(fileURLToPath(new URL("../build/icon.ico", import.meta.url)), icon);
  const { electronDist, electronVersion } = await resolveInstalledElectronDist({ platform: "win32", arch: "x64" });
  const artifacts = await build({ projectDir, targets: Platform.WINDOWS.createTarget("nsis", Arch.x64), publish: "never",
    config: { appId: `ai.codeflow.layout-fixture.${guid}`, productName: "CodeFlowAI", directories: { output }, npmRebuild: false,
      electronDist, electronVersion, files: ["main.js", "package.json"],
      extraResources: [{ from: path.join(f.appOutDir, "resources"), to: ".", filter: ["**/*", "!app.asar"] }],
      win: { executableName: "CodeFlowAI", signExecutable: false, icon },
      afterSign: fileURLToPath(moduleUrl),
      nsis: { oneClick: false, guid, shortcutName, include: fileURLToPath(new URL("../build/installer.nsh", import.meta.url)) } } });
  assert.equal(artifacts.filter(file => file.endsWith(".exe")).length, 1);
  const installation = path.join(output, "win-unpacked"), launch = await readShellLaunchState(installation);
  assert.equal(launch.state.activeShellId, "installation");
  const launcher = await fs.readFile(path.join(installation, "CodeFlowAI.exe"));
  assert.equal(launcher.subarray(0, 2).toString("ascii"), "MZ");
  assert.equal(launcher.includes(Buffer.from("1.0.0.0\0", "utf16le")), true, "固定启动器应保留安装包版本资源");
  assert.ok(launcher.length < (await fs.stat(launch.executablePath)).size);
  assert.equal(await fs.readFile(path.join(launch.initialReleaseDir, "baseline-release-manifest.json"), "ascii"), "{}");
  assert.deepEqual(await fs.readdir(path.join(installation, "resources")), ["elevate.exe"]);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(path.join(installation, "CodeFlowAI.exe"), ["--codeflow-check-installation"], { env, windowsHide: true, timeout: 30_000 });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => signal ? reject(new Error(`LAYOUT_SMOKE_INTERRUPTED:${signal}`)) : resolve({ code, stderr }));
  });
  assert.equal(result.code, 7, `根启动器必须同步保留维护进程退出码：${result.stderr}`);
  assert.ok(JSON.parse(await fs.readFile(argumentsFile, "utf8")).includes("--codeflow-check-installation"));

  const uninstallKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`, installKey = `Software\\${guid}`;
  registryCleanup = await nativeFixture("cleanup-registry", `DeleteRegKey HKCU "${uninstallKey}"
DeleteRegKey HKCU "${installKey}"
Delete "$DESKTOP\\${shortcutName}.lnk"
Delete "$SMPROGRAMS\\${shortcutName}.lnk"
RMDir /r "$LOCALAPPDATA\\${packageName}-updater"`);
  await fs.mkdir(installDirectory);
  const sentinel = path.join(f.root, "old-uninstaller-ran.txt");
  const legacy = await nativeFixture("legacy-uninstaller", `FileOpen $0 "${sentinel}" w\nFileWrite $0 "legacy executed"\nFileClose $0`);
  await fs.copyFile(legacy, path.join(installDirectory, "Uninstall CodeFlowAI.exe"));
  await fs.copyFile(legacy, path.join(installDirectory, "CodeFlowAI.exe"));
  for (const relative of ["shells/old/obsolete.txt", "resources/obsolete.txt", "locales/old.pak"]) {
    const target = path.join(installDirectory, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, "obsolete", "ascii");
  }
  await fs.writeFile(path.join(installDirectory, "unknown-user-file.txt"), "保留账号身份配置任务", "utf8");
  const seed = await nativeFixture("seed-registry", `WriteRegStr HKCU "${installKey}" InstallLocation "${installDirectory}"
WriteRegStr HKCU "${installKey}" KeepShortcuts "true"
WriteRegStr HKCU "${installKey}" ShortcutName "${shortcutName}"
CreateShortCut "$SMPROGRAMS\\${shortcutName}.lnk" "${path.join(installDirectory, "CodeFlowAI.exe")}"
WriteRegStr HKCU "${uninstallKey}" UninstallString '$\\"${path.join(installDirectory, "Uninstall CodeFlowAI.exe")}$\\" /currentuser'`);
  assert.equal((await execute(seed, [])).code, 0);
  const upgrade = await execute(artifacts.find(file => file.endsWith(".exe"))!, ["/S", "/currentuser", `/D=${installDirectory}`]);
  assert.equal(upgrade.code, 0, upgrade.output);
  await assert.rejects(fs.access(sentinel), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(installDirectory, "shells/old")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(installDirectory, "resources/obsolete.txt")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(installDirectory, "unknown-user-file.txt"), "utf8"), "保留账号身份配置任务");
  assert.equal((await readShellLaunchState(installDirectory)).state.activeShellId, "installation");
  assert.match(await fs.readFile(path.join(installDirectory, "installation-completed.ini"), "ascii"), /requestId=nsis-install-/u);
  const inspect = await nativeFixture("inspect-registry", `ReadRegStr $0 HKCU "${uninstallKey}" UninstallString
FileOpen $1 "${path.join(f.root, "installed-registration.txt")}" w
FileWrite $1 "$0$\\r$\\n"
ReadRegStr $0 HKCU "${installKey}" InstallLocation
FileWrite $1 "$0$\\r$\\n"
FileClose $1
IfFileExists "$SMPROGRAMS\\${shortcutName}.lnk" +3
SetErrorLevel 9
Quit`);
  assert.equal((await execute(inspect, [])).code, 0, "new template must preserve uninstall registration and start-menu shortcut");
  assert.match(await fs.readFile(path.join(f.root, "installed-registration.txt"), "ascii"), /Uninstall CodeFlowAI\.exe/u);
});
