import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { closeDesktop, closeInitialSettings, createThreadFixture, createUiRoot, removeUiRoot, createWorkspace, expect, launchDesktop, listWorkspaces } from "./support/desktop-ui-smoke.mjs";

/**
 * 开发态 UI 验收：聊天输入、发送按钮状态与清空。
 * 不调用真实模型；不可发送时必须显式禁用，禁止把阻塞状态伪装成成功。
 * 前置：Vite 运行在 http://localhost:39281，且 Client/Desktop 已构建。
 */
const { root, env } = await createUiRoot("codeflow-ui-composer-");
const workspaceDirectory = path.join(root, "project");
const SEND_LABELS = ["待输入", "发送", "入队", "执行", "未连接", "模型不可用", "请选择模型", "不可发送"];
let application;
try {
  await fs.mkdir(workspaceDirectory);
  let launched = await launchDesktop({ root, env });
  application = launched.application;
  let page = launched.page;
  await closeInitialSettings(page);
  await createWorkspace(page, { title: "输入框验收", directory: workspaceDirectory });
  const workspaceId = (await listWorkspaces(page))[0].id;
  await createThreadFixture(page, { workspaceId, title: "输入框会话" });

  await closeDesktop(application);
  launched = await launchDesktop({ root, env });
  application = launched.application;
  page = launched.page;

  await page.locator(".thread-list__item").filter({ hasText: "输入框会话" }).click();
  const textarea = page.locator(".composer textarea").first();
  await expect(textarea).toBeVisible({ timeout: 30_000 });
  const send = page.locator(".composer__send-btn");
  await expect(send).toBeVisible();

  const initial = await send.getAttribute("aria-label");
  assert.ok(SEND_LABELS.includes(initial), `unexpected initial send label: ${initial}`);

  await textarea.fill("桌面端 UI 自动化草稿");
  await expect(textarea).toHaveValue("桌面端 UI 自动化草稿");
  const typed = await send.getAttribute("aria-label");
  assert.ok(SEND_LABELS.includes(typed), `unexpected typed send label: ${typed}`);
  // 只有真正可发送时按钮才可用；其余状态必须显式禁用。
  if (typed === "发送" || typed === "入队" || typed === "执行") await expect(send).toBeEnabled();
  else await expect(send).toBeDisabled();

  await textarea.fill("");
  await expect(textarea).toHaveValue("");
} finally {
  await closeDesktop(application);
  await removeUiRoot(root);
}
