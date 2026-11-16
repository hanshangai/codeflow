import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  closeDesktop, closeInitialSettings, createThreadFixture, createUiRoot, createWorkspace,
  desktopRequest, expect, launchDesktop, listWorkspaces,
} from "./support/desktop-ui-smoke.mjs";
import { prepareProvider } from "./support/controlled-codex-provider.mjs";
import { isolatedEnvironment } from "./support/packaged-app.mjs";
import { killProcessTree } from "./support/smoke-process.mjs";

/**
 * 关闭期资源排空回归：回合结束后与回合进行中关闭，均须正常退出且 Client 无清理失败。
 * 受控 provider 不调用真实模型；两个场景使用各自独占目录。
 */
const failures = [];

/** 读取 Client 关闭日志，返回失败步骤与资源未排空标记。 */
async function readShutdownFailures(runtimeDir) {
  const logDir = path.join(runtimeDir, "logs");
  const files = await fs.readdir(logDir);
  const lines = [];
  for (const file of files) lines.push(...(await fs.readFile(path.join(logDir, file), "utf8")).split("\n"));
  return {
    files: files.length,
    completeLines: lines.filter((line) => line.includes("shutdown.complete")).length,
    failingSteps: lines.filter((line) => /shutdown\.complete.*"outcome":"fail"/u.test(line)),
    notDrained: lines.filter((line) => line.includes("CLIENT_RESOURCES_NOT_DRAINED")),
  };
}

/** 关闭壳；超时返回 false 并强制结束，供日志取证。 */
async function closeAndWait(application, timeoutMs = 20_000) {
  const closed = application.waitForEvent("close", { timeout: timeoutMs }).then(() => true).catch(() => false);
  await application.evaluate(({ app }) => { app.quit(); }).catch(() => {});
  if (await closed) return true;
  await killProcessTree(application.process()?.pid).catch((error) => console.log(`WARN ${error.message}`));
  await application.waitForEvent("close", { timeout: 10_000 }).catch(() => {});
  return false;
}

/** 创建夹具后重启一次，让会话从真实 SQLite 加载。 */
async function launchAndPrepare({ root, providerEnv, workspaceDirectory }) {
  let launched = await launchDesktop({ root, env: providerEnv });
  let application = launched.application;
  let page = launched.page;
  await closeInitialSettings(page);
  await createWorkspace(page, { title: "关闭排空验收", directory: workspaceDirectory });
  const workspaceId = (await listWorkspaces(page))[0].id;
  const credential = await desktopRequest(page, { method: "engineKeys.upsert", body: {
    workspaceId, label: "关闭排空受控", engine: "codex", providerId: "openai", apiKey: "ui-fixture-only",
    baseUrl: "http://127.0.0.1:1/v1",
  } });
  assert.equal(credential.status, 200);
  await createThreadFixture(page, { workspaceId, title: "关闭排空会话", engine: "codex" });
  await closeDesktop(application);
  launched = await launchDesktop({ root, env: providerEnv });
  return { application: launched.application, page: launched.page, workspaceId };
}

/** 执行一个关闭场景并记录失败原因。 */
async function runScenario(name, inFlight) {
  const { root } = await createUiRoot(`codeflow-shutdown-${name}-`);
  const env = await isolatedEnvironment(root);
  const workspaceDirectory = path.join(root, "project");
  const providerPath = path.join(root, "provider");
  let application;
  try {
    await fs.mkdir(workspaceDirectory);
    await prepareProvider(providerPath);
    const providerEnv = { ...env, PATH: `${providerPath}${path.delimiter}${env.PATH ?? env.Path ?? ""}` };
    const prepared = await launchAndPrepare({ root, providerEnv, workspaceDirectory });
    application = prepared.application;
    const page = prepared.page;
    await page.locator(".thread-list__item").filter({ hasText: "关闭排空会话" }).click();
    await page.locator(".composer textarea").first().fill(inFlight ? "回合进行中关闭验收" : "关闭排空验收");
    await page.locator(".composer__send-btn").click();
    if (inFlight) {
      await expect(page.locator(".composer__send-btn")).toHaveAttribute("aria-label", "终止", { timeout: 10_000 });
    } else {
      await expect(page.getByText("本机受控普通聊天回复。", { exact: true })).toHaveCount(1, { timeout: 30_000 });
    }
    const clean = await closeAndWait(application);
    let result;
    try { result = await readShutdownFailures(path.join(root, "runtime")); }
    catch (error) { result = null; failures.push(`${name}: 读取关闭日志失败 ${error?.message ?? error}`); }
    application = null;
    if (!clean) failures.push(`${name}: 关闭超时`);
    if (result && result.completeLines < 1) failures.push(`${name}: 缺少 shutdown.complete 证据`);
    if (result?.notDrained.length) failures.push(`${name}: 资源未排空 ${result.notDrained.length} 条`);
    if (result?.failingSteps.length) failures.push(`${name}: 关闭失败步骤 ${result.failingSteps.length} 条`);
  } finally {
    if (application) await closeAndWait(application).catch(() => {});
    if (process.env.D06_SMOKE_KEEP_ROOT === "1") {
      console.log(`KEEP root: ${root}`);
    } else {
      try { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
      catch (error) { console.log(`WARN cleanup failed: ${root}: ${error?.code ?? error}`); }
    }
  }
}

const only = process.env.D06_SHUTDOWN_SCENARIO;
if (only !== "in-flight") await runScenario("after-turn", false);
if (only !== "after-turn") await runScenario("in-flight", true);
assert.deepEqual(failures, [], failures.join("；"));
console.log("Desktop shutdown drain smoke passed");
process.exit(0);
