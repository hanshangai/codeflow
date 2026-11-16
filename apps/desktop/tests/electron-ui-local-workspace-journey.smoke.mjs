import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { closeDesktop, createUiRoot, createWorkspace, expect, launchDesktop, listWorkspaces, removeUiRoot } from "./support/desktop-ui-smoke.mjs";

/**
 * 单机版未登录旅程：不注入任何账号会话，创建工作区后新建会话。
 * 前置：Vite 运行在 http://localhost:39281，Client/Desktop 已构建。
 */
const { root, env } = await createUiRoot("codeflow-ui-local-journey-");
const workspaceDirectory = path.join(root, "journey-project");
let application;
try {
  await fs.mkdir(workspaceDirectory);
  const launched = await launchDesktop({
    root,
    env,
    webEntry: process.env.CODEFLOWAI_DESKTOP_UI_WEB_ENTRY || "http://localhost:39281",
  });
  application = launched.application;
  const page = launched.page;
  // 有工作区时不会自动打开设置弹窗，按需关闭。
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  if (await settings.count()) {
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await expect(settings).toBeHidden();
  }

  // 未登录状态：顶栏只显示登录入口，不显示账号菜单。
  await expect(page.getByRole("button", { name: /登\s*录/u })).toBeVisible();
  await expect(page.locator(".user-menu-trigger")).toHaveCount(0);
  const before = await listWorkspaces(page);

  await createWorkspace(page, { title: "单机旅程工作区", directory: workspaceDirectory });
  const workspaces = await listWorkspaces(page);
  assert.equal(workspaces.length, before.length + 1);
  assert.ok(workspaces.some(workspace => workspace.title === "单机旅程工作区"));

  const newChat = page.getByRole("button", { name: "+ 新建", exact: true });
  await expect(newChat).toBeEnabled({ timeout: 30_000 });
  await newChat.click();
  const dialog = page.getByRole("dialog", { name: "新建会话", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[name="codeflow-thread-title"]').fill("单机旅程会话");
  await dialog.getByRole("button", { name: /^确\s*定$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText("单机旅程会话", { exact: true }).first()).toBeVisible();

  console.log("Electron local workspace journey passed");
} finally {
  await closeDesktop(application);
  await removeUiRoot(root);
}
