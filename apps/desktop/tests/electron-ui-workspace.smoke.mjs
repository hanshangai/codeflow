import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { closeDesktop, createUiRoot, removeUiRoot, createWorkspace, expect, launchDesktop, listWorkspaces, openCreateWorkspaceDialog } from "./support/desktop-ui-smoke.mjs";

/**
 * 开发态 UI 验收：系统目录选择、取消/失败及工作区创建边界。
 * 前置：Vite 运行在 http://localhost:39281，且 Client/Desktop 已构建。
 */
const { root, env } = await createUiRoot("codeflow-ui-workspace-");
const firstDirectory = path.join(root, "project-a");
const secondDirectory = path.join(root, "project-b");
let application;
try {
  await fs.mkdir(firstDirectory);
  await fs.mkdir(secondDirectory);
  const launched = await launchDesktop({ root, env,
    webEntry: process.env.CODEFLOWAI_DESKTOP_UI_WEB_ENTRY || "http://localhost:39281",
    ...(process.env.CODEFLOWAI_DESKTOP_UI_ENTRY ? { entry: process.env.CODEFLOWAI_DESKTOP_UI_ENTRY } : {}),
  });
  application = launched.application;
  const page = launched.page;
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  if (await settings.isVisible()) await settings.getByRole("button", { name: "Close", exact: true }).click();

  const initialWorkspaces = await listWorkspaces(page);
  const create = await openCreateWorkspaceDialog(page);
  const titleInput = create.locator('input[name="codeflow-workspace-title"]');
  const pathInput = create.locator('input[name="codeflow-workspace-path"]');
  await expect(titleInput).toHaveAttribute("placeholder", "XXX项目 / XXX工作区");
  await expect(pathInput).not.toHaveAttribute("placeholder", /^例如/u);
  await expect(create.locator(".create-workspace-modal__path-hint")).toHaveCount(0);
  // 只替换系统交互边界，真实页面、preload、来源校验和主进程 IPC 均参与验收。
  await application.evaluate(({ dialog }, selected) => {
    globalThis.__directoryDialogCalls = [];
    globalThis.__directoryDialogResult = { canceled: false, filePaths: [selected] };
    dialog.showOpenDialog = async (owner, options) => {
      globalThis.__directoryDialogCalls.push({ ownerId: owner.id, ...options });
      if (globalThis.__directoryDialogResult === "failure") throw new Error("DIRECTORY_PICKER_SMOKE_FAILURE");
      return globalThis.__directoryDialogResult;
    };
  }, firstDirectory);
  const browse = create.getByRole("button", { name: /浏览目录/u });
  await browse.click();
  await expect(pathInput).toHaveValue(firstDirectory);
  const calls = await application.evaluate(() => globalThis.__directoryDialogCalls);
  assert.deepEqual(calls[0].properties, ["openDirectory"]);
  assert.equal(typeof calls[0].ownerId, "number");
  await expect(page.getByRole("dialog", { name: "选择 Client 本机目录", exact: true })).toHaveCount(0);
  await application.evaluate(() => { globalThis.__directoryDialogResult = { canceled: true, filePaths: [] }; });
  await browse.click();
  await expect.poll(() => application.evaluate(() => globalThis.__directoryDialogCalls.length)).toBe(2);
  await expect(browse).not.toHaveClass(/ant-btn-loading/u);
  await expect(pathInput).toHaveValue(firstDirectory);
  await application.evaluate(() => { globalThis.__directoryDialogResult = "failure"; });
  await browse.click();
  await expect(create.getByRole("alert")).toContainText("DIRECTORY_PICKER_SMOKE_FAILURE");
  await expect(pathInput).toHaveValue(firstDirectory);
  assert.equal((await listWorkspaces(page)).length, initialWorkspaces.length);
  await application.evaluate((_electron, selected) => {
    globalThis.__directoryDialogResult = { canceled: false, filePaths: [selected] };
  }, firstDirectory);
  await browse.click();
  await expect(create.getByRole("alert")).toHaveCount(0);
  await titleInput.fill("界面工作区A");
  if (process.env.CODEFLOWAI_DESKTOP_UI_SCREENSHOT) {
    await page.screenshot({ path: process.env.CODEFLOWAI_DESKTOP_UI_SCREENSHOT, fullPage: true });
  }
  await create.getByRole("button", { name: /^创\s*建$/ }).click();
  await expect(create).toBeHidden();
  await expect(page.getByRole("button", { name: /切换工作区，当前 界面工作区A/u })).toBeVisible();
  assert.equal((await listWorkspaces(page)).length, initialWorkspaces.length + 1);

  await createWorkspace(page, { title: "界面工作区B", directory: secondDirectory });
  const workspaces = await listWorkspaces(page);
  assert.deepEqual(workspaces.filter(item => !initialWorkspaces.some(initial => initial.id === item.id)).map(item => item.title).sort(), ["界面工作区A", "界面工作区B"].sort());

  // 非法目录必须显式失败：弹窗保持、工作区数量不变。
  const dialog = await openCreateWorkspaceDialog(page);
  await dialog.locator('input[name="codeflow-workspace-title"]').fill("非法路径");
  await dialog.locator('input[name="codeflow-workspace-path"]').fill(path.join(root, "missing-directory"));
  await dialog.getByRole("button", { name: /^创\s*建$/ }).click();
  await expect(dialog).toBeVisible();
  assert.equal((await listWorkspaces(page)).length, initialWorkspaces.length + 2);
  await page.keyboard.press("Escape");
  process.stdout.write("Electron 工作区验收通过：简化提示、系统目录选择回填、取消保留、失败提示与重试、创建及非法路径拒绝。\n");
} finally {
  await closeDesktop(application);
  await removeUiRoot(root);
}
