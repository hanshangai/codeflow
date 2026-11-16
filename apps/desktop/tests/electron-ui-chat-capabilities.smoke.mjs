import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { closeDesktop, createThreadFixture, createUiRoot, removeUiRoot, createWorkspace, desktopRequest, expect, listWorkspaces } from "./support/desktop-ui-smoke.mjs";
import { prepareProvider } from "./support/controlled-codex-provider.mjs";
import { isolatedEnvironment, killProcessTree, observeProcess } from "./support/packaged-app.mjs";

const clientRequire = createRequire(new URL("../client/package.json", import.meta.url));
const { _electron: electron } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test");
const XLSX = clientRequire("xlsx");
const { root } = await createUiRoot("codeflow-chat-capabilities-");
const workspaceDirectory = path.join(root, "project");
let application;
let child;
let processOutput;
let stage = "启动";
let failed = false;
let failure;
const browserErrors = [];

/** 复制本地构建到独占目录，避免开发监听器清理 dist 干扰正在运行的验收。 */
async function snapshotBuild() {
  const source = fileURLToPath(new URL("..", import.meta.url));
  const target = path.join(root, "build");
  await fs.cp(path.join(source, "dist"), path.join(target, "dist"), { recursive: true });
  await fs.cp(path.join(source, "client", "dist"), path.join(target, "client", "dist"), { recursive: true });
  await fs.mkdir(path.join(target, "build"));
  await fs.copyFile(path.join(source, "build", "icon.png"), path.join(target, "build", "icon.png"));
  await fs.mkdir(path.join(root, "web", "public"), { recursive: true });
  await fs.copyFile(path.join(source, "..", "web", "public", "favicon-32x32.png"), path.join(root, "web", "public", "favicon-32x32.png"));
  await fs.copyFile(path.join(source, "package.json"), path.join(target, "package.json"));
  await fs.symlink(path.join(source, "node_modules"), path.join(target, "node_modules"), "junction");
  await fs.symlink(path.join(source, "client", "node_modules"), path.join(target, "client", "node_modules"), "junction");
  await fs.access(path.join(target, "client", "dist", "index.cjs"));
  const entry = path.join(target, "observed-main.cjs");
  await fs.writeFile(entry, `const { dialog, ipcMain } = require("electron");
dialog.showErrorBox = (title, message) => process.stderr.write(title + ": " + message + "\\n");
const reads = globalThis.__chatCapabilityReads = { loads: 0, polls: 0 };
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
  const method = channel === "desktop:request" ? args[1]?.method : null;
  if (method === "threads.load") reads.loads++;
  const result = await listener(...args);
  if (method === "runtime.info") reads.polls++;
  return result;
});
import("./dist/main.js");
`, "utf8");
  return entry;
}

/** 本机桥失败立即终止验收，不以空快照继续页面操作。 */
async function request(page, input) {
  const result = await desktopRequest(page, input);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body?.ok, true, JSON.stringify(result.body));
  return result.body;
}

try {
  await fs.mkdir(workspaceDirectory);
  await fs.writeFile(path.join(workspaceDirectory, "参考.txt"), "文件引用验收", "utf8");
  const providerPath = path.join(root, "provider");
  await prepareProvider(providerPath);
  const env = await isolatedEnvironment(root);
  const entry = await snapshotBuild();
  const webEntry = process.env.CODEFLOWAI_CHAT_CAPABILITIES_WEB_ENTRY || "http://localhost:39281";
  application = await electron.launch({ executablePath: createRequire(import.meta.url)("electron"),
    args: [entry, `--user-data-dir=${path.join(root, "profile")}`],
    env: { ...env, CODEFLOWAI_DESKTOP_WEB_ENTRY: webEntry, PATH: `${providerPath}${path.delimiter}${env.PATH ?? env.Path ?? ""}` }, timeout: 60_000 });
  child = application.process();
  processOutput = observeProcess(child, new Set());
  const page = await application.firstWindow();
  page.on("pageerror", error => { browserErrors.push(error.message); });
  page.setDefaultTimeout(30_000);
  await page.waitForURL("**/chat", { timeout: 30_000 });
  stage = "创建工作区";
  const initialSettings = page.getByRole("dialog", { name: "设置", exact: true });
  if (await initialSettings.isVisible()) await initialSettings.getByRole("button", { name: "Close", exact: true }).click();
  await createWorkspace(page, { title: "会话能力验收", directory: workspaceDirectory });
  const workspaceId = (await listWorkspaces(page))[0].id;
  stage = "创建会话";
  await request(page, { method: "engineKeys.upsert", body: { workspaceId, label: "本机验收", engine: "codex", providerId: "openai", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1/v1" } });
  const threadId = await createThreadFixture(page, { workspaceId, title: "能力恢复会话" });
  await page.reload();
  stage = "打开会话";
  await page.locator(".thread-list__item").filter({ hasText: "能力恢复会话" }).click();
  const composer = page.locator(".composer");
  const textarea = composer.locator("textarea").first();
  await expect(textarea).toBeEditable();
  stage = "空会话轮询稳定性";
  await expect(page.locator(".chat-panel__loading-overlay")).toBeHidden();
  const emptyConversation = page.locator(".chat-panel__conversation-empty");
  await expect(emptyConversation).toBeVisible();
  await expect(emptyConversation).toContainText("暂无消息，发送第一条消息开始对话");
  const messagesBounds = await page.locator(".chat-panel__messages").boundingBox();
  const emptyBounds = await emptyConversation.locator(".ant-empty").boundingBox();
  const composerBounds = await composer.boundingBox();
  assert.ok(messagesBounds && emptyBounds && composerBounds, "消息区、空提示和输入框必须可见");
  assert.ok(Math.abs(emptyBounds.x + emptyBounds.width / 2 - messagesBounds.x - messagesBounds.width / 2) < 2, "空提示应水平居中");
  assert.ok(Math.abs(emptyBounds.y + emptyBounds.height / 2 - messagesBounds.y - messagesBounds.height / 2) < 2, "空提示应在消息区垂直居中");
  assert.ok(messagesBounds.y + messagesBounds.height <= composerBounds.y + 1, "空提示不能占用输入框区域");
  await page.evaluate(() => {
    window.__emptyThreadLoadingFlashes = 0;
    window.__emptyThreadLoadingObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(".chat-panel__loading-overlay") || node.querySelector(".chat-panel__loading-overlay"))) {
            window.__emptyThreadLoadingFlashes++;
          }
        }
      }
    });
    window.__emptyThreadLoadingObserver.observe(document.body, { subtree: true, childList: true });
  });
  const beforePolling = await application.evaluate(() => ({ ...globalThis.__chatCapabilityReads }));
  await expect.poll(() => application.evaluate(() => globalThis.__chatCapabilityReads.polls), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(beforePolling.polls + 2);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const afterPolling = await application.evaluate(() => ({ ...globalThis.__chatCapabilityReads }));
  const flashes = await page.evaluate(() => {
    window.__emptyThreadLoadingObserver.disconnect();
    return window.__emptyThreadLoadingFlashes;
  });
  assert.equal(afterPolling.loads, beforePolling.loads, "空会话轮询不能重读历史");
  assert.equal(flashes, 0, "空会话不能闪现读取事件中");
  await expect(emptyConversation).toBeVisible();
  await expect(textarea).toBeEditable();
  if (process.env.CODEFLOWAI_CHAT_CAPABILITIES_SCREENSHOT) {
    await page.screenshot({ path: process.env.CODEFLOWAI_CHAT_CAPABILITIES_SCREENSHOT, fullPage: true });
  }
  stage = "会话能力";
  await expect(composer.getByRole("button", { name: "添加附件", exact: true })).toBeVisible();
  // 空会话尚无用量，核对原上下文组件已挂载，实际用量仍由组件决定是否展示。
  await expect(composer.locator(".composer__context-bar")).toBeAttached();
  await expect(composer.getByRole("button", { name: "常用提示词", exact: true })).toBeDisabled();
  await expect(composer.getByRole("button", { name: "Spec", exact: true })).toBeVisible();
  const workflow = composer.getByRole("button", { name: "WorkFlow", exact: true });
  await expect(workflow).toHaveAttribute("aria-pressed", "false");
  await workflow.click();
  await expect(workflow).toHaveAttribute("aria-pressed", "true");
  const snapshot = await request(page, { method: "orch.chat.get", body: { workspaceId, threadId } });
  assert.equal(snapshot.recommendationEnabled, true);
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toBeHidden();

  stage = "文件引用";
  // 新工作区索引异步建立，先等待真实候选可读再操作选择器。
  await expect.poll(async () => {
    const paths = await request(page, { method: "fs.search", body: { workspaceId, query: "参考", kind: "all" } });
    return paths.results.some(item => item.path === "参考.txt");
  }, { timeout: 30_000 }).toBe(true);
  await textarea.fill("@参考");
  await expect(composer.locator(".composer__mention-picker")).toBeVisible();
  const reference = composer.locator(".composer__mention-option").filter({ hasText: "参考.txt" });
  await expect(reference).toBeVisible();
  await reference.click();
  await expect(textarea).toHaveValue(/参考\.txt/u);
  await textarea.fill("/");
  stage = "命令候选";
  await expect(composer.locator(".composer__input-action-picker")).toBeVisible();
  await expect(composer.locator(".composer__input-action-picker .composer__mention-option").first()).toBeVisible();
  await textarea.fill("");

  const workbook = XLSX.utils.book_new();
  stage = "附件解析与预览";
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["名称", "说明"], ["附件验收", "完整中文内容"]]), "验收表");
  await composer.locator('input[type="file"]').setInputFiles([
    { name: "文本附件.txt", mimeType: "text/plain", buffer: Buffer.from("文本附件内容", "utf8") },
    { name: "表格附件.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) },
  ]);
  await expect(composer.locator(".composer__attachment")).toHaveCount(2);
  await composer.locator(".composer__attachment").filter({ hasText: "表格附件.xlsx" }).getByRole("button", { name: "预览", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "附件预览" });
  await expect(preview).toContainText("完整中文内容");
  await preview.getByRole("button", { name: "Close", exact: true }).click();
  stage = "首条消息隐藏空提示";
  await textarea.fill("空会话提示验收");
  await composer.locator(".composer__send-btn").click();
  await expect(emptyConversation).toBeHidden();
  await expect(page.getByText("本机受控普通聊天回复。", { exact: true })).toBeVisible();
  assert.deepEqual(browserErrors, [], "页面不能保留未处理异常");
  process.stdout.write("Electron 会话能力验收通过：空会话提示与轮询稳定性、首条消息、附件/Office 预览、@ 文件、命令、Spec/WorkFlow、上下文和账号提示词边界。\n");
} catch (error) {
  failed = true;
  failure = new Error(`Electron 会话能力验收失败：${stage}；诊断目录：${root}；页面异常：${browserErrors.join("；")}；进程输出：${processOutput?.stderr ?? ""}`, { cause: error });
  throw failure;
} finally {
  try {
    if (application && child?.exitCode === null) {
      if (failed) await killProcessTree(child.pid);
      else await closeDesktop(application);
    }
    if (!failed) await removeUiRoot(root);
  } catch (cleanupError) {
    throw failed ? new AggregateError([failure, cleanupError], "会话能力验收及清理失败") : cleanupError;
  }
}
