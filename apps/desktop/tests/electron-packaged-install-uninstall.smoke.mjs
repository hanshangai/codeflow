import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePackagedApp, isolatedEnvironment, launchPackagedApp, waitUntil } from "./support/packaged-app.mjs";
import { createWorkspace, expect } from "./support/desktop-ui-smoke.mjs";

/**
 * 打包态安装 → 卸载 → 重装验收，按 electron-builder NSIS 契约执行。
 * 用法：node tests/electron-packaged-install-uninstall.smoke.mjs <安装包 exe> <新工作目录>
 *
 * 契约：
 * - 安装器支持 `/S` 静默安装与 `/D=<目录>` 指定安装目录；
 * - 安装目录内存在 `Uninstall*.exe`，支持 `/S` 静默卸载；
 * - 卸载必须删除安装身份；
 * - 卸载不得删除项目目录、工作区或其 `.codeflow` 数据。
 *
 * 注意：D16 自定义卸载向导尚未实现时，身份未删除会明确失败，这是预期 RED。
 */
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) throw new Error("用法：electron-packaged-install-uninstall.smoke.mjs <安装包 exe> <新工作目录>");
if (process.platform !== "win32") throw new Error("DESKTOP_INSTALL_WINDOWS_REQUIRED");
const installer = path.resolve(input);
if (path.extname(installer).toLowerCase() !== ".exe") throw new Error("DESKTOP_INSTALL_INSTALLER_REQUIRED");
const work = path.resolve(output);
const relativeWork = path.relative(repositoryRoot, work);
if (!relativeWork || (!relativeWork.startsWith(`..${path.sep}`) && relativeWork !== ".." && !path.isAbsolute(relativeWork))) {
  throw new Error("DESKTOP_INSTALL_WORKDIR_INSIDE_REPOSITORY");
}
await fs.mkdir(work);

const installDir = path.join(work, "installation");
const projectDir = path.join(work, "project");
const sentinel = path.join(projectDir, "keep.txt");
const identityFile = path.join(work, "runtime", "device-identity.json");
const report = { requestId: crypto.randomUUID(), status: "running", installer, installDir, steps: [] };
const observedPids = new Set();
let application;
let child;

/** 执行安装器/卸载器；非零退出保留状态与 stderr。 */
function runInstaller(file, args, code) {
  const result = spawnSync(file, args, { cwd: work, env, timeout: 300_000, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`${code}: ${result.error?.message ?? `status=${result.status} stderr=${(result.stderr ?? "").slice(-400)}`}`);
  }
  report.steps.push({ file: path.basename(file), args, status: result.status });
}

/** 等待路径消失；超时显式失败。 */
async function waitGone(target, code) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await fs.lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(code);
}

/** 读取安装身份；文件不存在返回 null，损坏显式失败。 */
async function readDeviceId() {
  try {
    return JSON.parse(await fs.readFile(identityFile, "utf8")).deviceId;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const env = await isolatedEnvironment(work);
try {
  // 1. 静默安装并等待真实 exe 落地。
  runInstaller(installer, ["/S", `/D=${installDir}`], "DESKTOP_INSTALL_FAILED");
  const installedExe = path.join(installDir, "CodeFlowAI.exe");
  await waitUntil(async () => {
    try { await fs.access(installedExe); return true; } catch { return false; }
  }, 120_000, "DESKTOP_INSTALLED_EXE_MISSING");
  report.steps.push("installed");

  // 2. 首次启动并创建工作区，生成安装身份与项目数据。
  await fs.mkdir(projectDir);
  await fs.writeFile(sentinel, "keep\n", "utf8");
  let launched = await launchPackagedApp({ executablePath: installedExe, userDataDir: path.join(work, "profile"), env, cwd: work, observedPids });
  application = launched.application;
  child = launched.child;
  let page = await application.firstWindow({ timeout: 60_000 });
  await page.waitForURL("**/chat", { timeout: 60_000 });
  await createWorkspace(page, { title: "卸载验收", directory: projectDir });
  const firstDeviceId = await readDeviceId();
  assert.ok(firstDeviceId, "DESKTOP_INSTALL_IDENTITY_MISSING");
  await expect(page.locator('[data-testid="left-sidebar"]')).toBeVisible({ timeout: 30_000 });
  await closePackagedApp({ application, observedPids, children: [child] });
  application = undefined;
  child = undefined;
  report.steps.push("first-launch");

  // 3. 静默卸载：exe 消失、安装身份删除、项目与工作区保留。
  const uninstaller = (await fs.readdir(installDir)).find(name => /^Uninstall.*\.exe$/iu.test(name));
  assert.ok(uninstaller, "DESKTOP_UNINSTALLER_MISSING");
  runInstaller(path.join(installDir, uninstaller), ["/S"], "DESKTOP_UNINSTALL_FAILED");
  await waitGone(installedExe, "DESKTOP_UNINSTALL_EXE_REMAINED");
  assert.equal(await readDeviceId(), null, "DESKTOP_UNINSTALL_IDENTITY_RETAINED");
  assert.equal(await fs.readFile(sentinel, "utf8"), "keep\n", "DESKTOP_UNINSTALL_PROJECT_LOST");
  report.steps.push("uninstalled");

  // 4. 重装并验证新安装身份，不复用旧身份。
  runInstaller(installer, ["/S", `/D=${installDir}`], "DESKTOP_REINSTALL_FAILED");
  await waitUntil(async () => {
    try { await fs.access(installedExe); return true; } catch { return false; }
  }, 120_000, "DESKTOP_REINSTALLED_EXE_MISSING");
  launched = await launchPackagedApp({ executablePath: installedExe, userDataDir: path.join(work, "profile"), env, cwd: work, observedPids });
  application = launched.application;
  child = launched.child;
  page = await application.firstWindow({ timeout: 60_000 });
  await page.waitForURL("**/chat", { timeout: 60_000 });
  const secondDeviceId = await readDeviceId();
  assert.ok(secondDeviceId, "DESKTOP_REINSTALL_IDENTITY_MISSING");
  assert.notEqual(secondDeviceId, firstDeviceId, "DESKTOP_REINSTALL_IDENTITY_RETAINED");
  await closePackagedApp({ application, observedPids, children: [child] });
  application = undefined;
  child = undefined;
  report.steps.push("reinstalled");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = { name: error?.name, message: error?.message, stack: error?.stack };
  throw error;
} finally {
  if (application) {
    try { await closePackagedApp({ application, observedPids, children: [child] }); }
    catch (error) { report.cleanupFailure = error.message; }
  }
  await fs.writeFile(path.join(work, "verification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
