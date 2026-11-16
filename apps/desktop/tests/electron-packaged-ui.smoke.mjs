import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPackagedExecutable, closePackagedApp, isolatedEnvironment, launchPackagedApp } from "./support/packaged-app.mjs";
import { expect } from "./support/desktop-ui-smoke.mjs";

/**
 * 打包态主界面 UI 验收：真实 exe 启动、主界面可见、侧栏折叠与上下文隔离。
 * 用法：node tests/electron-packaged-ui.smoke.mjs <工件 exe> [报告目录]
 * 前置：已用 electron-builder 生成 Windows x64 打包产物。
 */
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const [input, output, ...extra] = process.argv.slice(2);
if (!input || extra.length) throw new Error("用法：electron-packaged-ui.smoke.mjs <工件 exe> [报告目录]");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-packaged-ui-"));
const reportDir = output ? path.resolve(output) : path.join(root, "report");
await fs.mkdir(reportDir, { recursive: true });
const report = { requestId: crypto.randomUUID(), status: "running", executable: null, checks: [] };
const observedPids = new Set();
let application;
let child;
try {
  const executablePath = await assertPackagedExecutable(input, repositoryRoot);
  report.executable = executablePath;
  const userData = path.join(root, "profile");
  await fs.mkdir(userData);
  const env = await isolatedEnvironment(root);
  const launched = await launchPackagedApp({ executablePath, userDataDir: userData, env, cwd: root, observedPids });
  application = launched.application;
  child = launched.child;

  const page = await application.firstWindow({ timeout: 60_000 });
  await page.waitForURL("**/chat", { timeout: 60_000 });
  await expect(page.locator(".composer")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="left-sidebar"]')).toBeVisible({ timeout: 30_000 });
  report.checks.push("main-ui-visible");

  // 首装可能自动弹出设置层；先关闭，避免遮挡侧栏按钮。
  await page.keyboard.press("Escape");

  const toggle = page.locator('[data-testid="desktop-sidebar-toggle"]');
  await expect(toggle).toHaveCount(1);
  const expanded = await toggle.getAttribute("aria-expanded");
  await toggle.click();
  await expect(toggle).not.toHaveAttribute("aria-expanded", expanded);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", expanded);
  report.checks.push("sidebar-toggle");

  assert.equal(await page.evaluate(() => typeof window.require), "undefined", "context isolation must stay enabled");
  report.checks.push("context-isolation");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = { name: error?.name, message: error?.message, stack: error?.stack };
  throw error;
} finally {
  const failures = [];
  try {
    await closePackagedApp({ application, observedPids, children: [child] });
  } catch (error) {
    failures.push(error);
  }
  await fs.writeFile(path.join(reportDir, "verification.json"),
    `${JSON.stringify({ ...report, cleanupFailures: failures.map(error => error.message) }, null, 2)}\n`, "utf8");
  await fs.rm(root, { recursive: true, force: true });
  if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, "DESKTOP_PACKAGED_UI_CLEANUP_FAILED");
}
