import fs from "node:fs/promises";
import path from "node:path";
import { closeDesktop, closeInitialSettings, createThreadFixture, createUiRoot, removeUiRoot, createWorkspace, expect, launchDesktop, listWorkspaces } from "./support/desktop-ui-smoke.mjs";

/**
 * 开发态 UI 验收：会话列表渲染、点击切换与搜索过滤。
 * 会话数据由真实桌面 API 准备，列表交互全部走页面。
 * 前置：Vite 运行在 http://localhost:39281，且 Client/Desktop 已构建。
 */
const { root, env } = await createUiRoot("codeflow-ui-threads-");
const workspaceDirectory = path.join(root, "project");
let application;
try {
  await fs.mkdir(workspaceDirectory);
  let launched = await launchDesktop({ root, env });
  application = launched.application;
  let page = launched.page;
  await closeInitialSettings(page);
  await createWorkspace(page, { title: "会话列表验收", directory: workspaceDirectory });
  const workspaceId = (await listWorkspaces(page))[0].id;
  await createThreadFixture(page, { workspaceId, title: "会话甲" });
  await createThreadFixture(page, { workspaceId, title: "会话乙" });

  // 重启后从真实 SQLite 恢复列表，避免依赖当前页面内存状态。
  await closeDesktop(application);
  launched = await launchDesktop({ root, env });
  application = launched.application;
  page = launched.page;

  const item = title => page.locator(".thread-list__item").filter({ hasText: title });
  await expect(item("会话甲")).toBeVisible({ timeout: 30_000 });
  await expect(item("会话乙")).toBeVisible();

  await item("会话甲").click();
  await expect(item("会话甲")).toHaveClass(/thread-list__item--active/);
  await item("会话乙").click();
  await expect(item("会话乙")).toHaveClass(/thread-list__item--active/);
  await expect(item("会话甲")).not.toHaveClass(/thread-list__item--active/);

  const search = page.locator(".thread-list__search-input input");
  await search.fill("会话甲");
  await expect(item("会话甲")).toBeVisible();
  await expect(item("会话乙")).toHaveCount(0);
  await search.fill("");
  await expect(item("会话乙")).toBeVisible();
} finally {
  await closeDesktop(application);
  await removeUiRoot(root);
}
