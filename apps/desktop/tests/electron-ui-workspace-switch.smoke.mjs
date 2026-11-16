import fs from "node:fs/promises";
import path from "node:path";
import { closeDesktop, closeInitialSettings, createThreadFixture, createUiRoot, removeUiRoot, createWorkspace, escapeRegExp, expect, launchDesktop, listWorkspaces } from "./support/desktop-ui-smoke.mjs";

/**
 * 开发态 UI 验收：两个工作区创建、切换器切换与会话数据隔离。
 * 前置：Vite 运行在 http://localhost:39281，Client/Desktop 已构建。
 */
const { root, env } = await createUiRoot("codeflow-ui-workspace-switch-");
const firstDirectory = path.join(root, "project-a");
const secondDirectory = path.join(root, "project-b");
let application;
try {
  await fs.mkdir(firstDirectory);
  await fs.mkdir(secondDirectory);
  const launched = await launchDesktop({ root, env });
  application = launched.application;
  const page = launched.page;
  await closeInitialSettings(page);

  await createWorkspace(page, { title: "切换工作区A", directory: firstDirectory });
  await createWorkspace(page, { title: "切换工作区B", directory: secondDirectory });
  const workspaces = await listWorkspaces(page);
  const firstId = workspaces.find(item => item.title === "切换工作区A").id;
  const secondId = workspaces.find(item => item.title === "切换工作区B").id;
  await createThreadFixture(page, { workspaceId: firstId, title: "仅属于A的会话" });

  /** 通过真实切换器切换，核对名称、重载地址范围及旧会话目标清理。 */
  const switchTo = async (title, workspaceId) => {
    await page.getByRole("button", { name: /切换工作区，当前/ }).click();
    const panel = page.locator(".ws-compact-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await panel.locator(".ws-compact-option").filter({ hasText: title }).click();
    await expect(page.getByRole("button", { name: new RegExp(`切换工作区，当前 ${escapeRegExp(title)}`) })).toBeVisible({ timeout: 30_000 });
    await page.waitForURL(url => url.pathname === "/chat" && url.searchParams.get("workspaceId") === workspaceId
      && !url.searchParams.has("threadId") && !url.searchParams.has("targetId"), { timeout: 30_000 });
  };

  // 当前在 B；切回 A 后应能看到 A 的会话。
  await switchTo("切换工作区A", firstId);
  const thread = page.locator(".thread-list__item").filter({ hasText: "仅属于A的会话" });
  await expect(thread).toBeVisible({ timeout: 30_000 });

  // 切到 B 后同一会话必须不可见，验证工作区级数据隔离。
  await switchTo("切换工作区B", secondId);
  await expect(thread).toHaveCount(0, { timeout: 30_000 });

  // 切回 A 后会话重新出现。
  await switchTo("切换工作区A", firstId);
  await expect(thread).toBeVisible({ timeout: 30_000 });
} finally {
  await closeDesktop(application);
  await removeUiRoot(root);
}
