import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { closeDesktop, closeInitialSettings, createThreadFixture, createUiRoot, removeUiRoot, createWorkspace, desktopRequest, expect, launchDesktop, listWorkspaces } from "./support/desktop-ui-smoke.mjs";
import { prepareProvider } from "./support/controlled-codex-provider.mjs";
import { isolatedEnvironment } from "./support/packaged-app.mjs";

/**
 * 开发态 UI 验收：真实输入、发送、受控回复与中断。
 * 前置：Vite 运行在 http://localhost:39281，Client/Desktop 已构建。
 * 受控 provider 延迟 2.5 秒完成，给中断留出可观察窗口；不调用真实模型。
 * HOME与CLI配置隔离；合成自配Key只供本次受控provider通过正常凭据门禁。
 */
const { root } = await createUiRoot("codeflow-ui-chat-send-");
const workspaceDirectory = path.join(root, "project");
const providerPath = path.join(root, "provider");
let application;
try {
  await fs.mkdir(workspaceDirectory);
  await prepareProvider(providerPath);
  const env = await isolatedEnvironment(root);
  const providerEnv = { ...env, PATH: `${providerPath}${path.delimiter}${env.PATH ?? env.Path ?? ""}` };

  let launched = await launchDesktop({ root, env: providerEnv });
  application = launched.application;
  let page = launched.page;
  await closeInitialSettings(page);
  await createWorkspace(page, { title: "聊天发送验收", directory: workspaceDirectory });
  const workspaceId = (await listWorkspaces(page))[0].id;
  // 通过正式API建立合成凭据，保持产品准入；回环地址防止测试误触真实模型服务。
  const credential = await desktopRequest(page, { method: "engineKeys.upsert", body: {
    workspaceId, label: "受控UI验收", engine: "codex", providerId: "openai", apiKey: "ui-fixture-only",
    baseUrl: "http://127.0.0.1:1/v1",
  } });
  assert.equal(credential.status, 200);
  assert.equal(credential.body?.ok, true);
  await createThreadFixture(page, { workspaceId, title: "聊天发送会话" });

  // 重启后从真实 SQLite 加载会话，避免依赖创建时的页面内存状态。
  await closeDesktop(application);
  launched = await launchDesktop({ root, env: providerEnv });
  application = launched.application;
  page = launched.page;

  await page.locator(".thread-list__item").filter({ hasText: "聊天发送会话" }).click();
  const textarea = page.locator(".composer textarea").first();
  const send = page.locator(".composer__send-btn");
  await expect(textarea).toBeVisible({ timeout: 30_000 });

  // 第一条：验证发送与受控回复。
  await textarea.fill("你好，本机 UI 发送验收");
  await expect(send).toHaveAttribute("aria-label", /发送|入队/u);
  await send.click();
  const reply = page.getByText("本机受控普通聊天回复。", { exact: true });
  await expect(reply).toHaveCount(1, { timeout: 30_000 });

  // 第二条：验证可重复发送。
  await textarea.fill("第二条：重试验证");
  await send.click();
  await expect(reply).toHaveCount(2, { timeout: 30_000 });

  // 第三条：在受控 provider 延迟窗口内点击终止，不得产生第三条回复。
  await textarea.fill("第三条：中断验证");
  await send.click();
  await expect(send).toHaveAttribute("aria-label", "终止", { timeout: 10_000 });
  await send.click();
  await expect(send).not.toHaveAttribute("aria-label", "终止", { timeout: 10_000 });
  await page.waitForTimeout(3_000);
  await expect(reply).toHaveCount(2);
} finally {
  await closeDesktop(application);
  await removeUiRoot(root);
}
