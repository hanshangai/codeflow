import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
const { _electron: electron, expect } = webRequire("@playwright/test");
const executablePath = createRequire(import.meta.url)("electron");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-electron-workspace-"));
const workspacePath = path.join(root, "project");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_") && key !== "ELECTRON_RUN_AS_NODE"));
let application;
const threadId = "electron-offline-history";
const historySeq = Date.now();

/** 仅写本脚本独占目录，在 Client 停止时准备真实历史，实时验证也先提交再发送。 */
function saveHistory(workspaceId, events, createThread = false) {
  const db = new DatabaseSync(path.join(root, "runtime", "codeflowai.db"));
  try {
    db.exec("BEGIN");
    if (createThread) db.prepare("INSERT INTO threads (id, workspace_id, engine, title, thread_type, created_at, updated_at) VALUES (?, ?, 'codex', ?, 'chat', ?, ?)")
      .run(threadId, workspaceId, "离线历史", historySeq, historySeq);
    if (createThread) db.prepare("INSERT INTO threads (id, workspace_id, engine, title, thread_type, created_at, updated_at) VALUES (?, ?, 'codex', ?, 'chat', ?, ?)")
      .run("electron-second-history", workspaceId, "另一会话", historySeq - 1, historySeq - 1);
    if (createThread) {
      const raw = { schema: 1, seq: historySeq, ts: historySeq, workspaceId, threadId, engine: "codex", source: "offline-inspector",
        data: { message: "离线原始事件" }, handled: true, action: "mapped", emittedTypes: [] };
      db.prepare("INSERT INTO raw_engine_events (seq, thread_id, workspace_id, engine, source, event_json, ts) VALUES (?, ?, ?, 'codex', ?, ?, ?)")
        .run(historySeq, threadId, workspaceId, raw.source, JSON.stringify(raw), historySeq);
    }
    for (const event of events) db.prepare("INSERT INTO conversation_events (seq, thread_id, workspace_id, engine, type, event_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(event.seq, threadId, workspaceId, event.engine, event.type, JSON.stringify(event), event.ts);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'event_seq'").run(String(events.at(-1).seq));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}

/** 最小 canonical 正文夹具使用真实 shared 信封字段，不调用引擎。 */
function message(workspaceId, seq, text) {
  return { schema: 1, seq, ts: seq, workspaceId, threadId, engine: "codex", type: "item.agentMessage.completed",
    payload: { itemId: `assistant-${seq}`, engineMessageId: `provider-${seq}`, text, revision: 1 } };
}

/** 所有业务均使用真实 Electron preload、Client 和 SQLite，不启动 Server。 */
async function launch() {
  application = await electron.launch({
    executablePath, args: [fileURLToPath(new URL("../dist/main.js", import.meta.url)), `--user-data-dir=${path.join(root, "profile")}`],
    env: { ...env, CODEFLOWAI_DESKTOP_DATA_DIR: path.join(root, "runtime"), CODEFLOWAI_DESKTOP_WEB_ENTRY: "http://localhost:39281" },
    timeout: 60_000,
  });
  const page = await application.firstWindow({ timeout: 60_000 });
  await page.waitForURL("**/chat", { timeout: 60_000 });
  return page;
}

/** 请求壳的实际关闭入口，等待其 Client 和窗口清理后退出。 */
async function close() {
  if (!application) return;
  const current = application;
  await Promise.all([
    current.waitForEvent("close", { timeout: 20_000 }),
    current.evaluate(({ app }) => { app.quit(); }),
  ]);
  application = undefined;
}

try {
  await fs.mkdir(workspacePath);
  let page = await launch();
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible({ timeout: 60_000 });
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await page.getByRole("button", { name: "新建工作区", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建工作区", exact: true });
  await expect(create).toBeVisible();
  await expect(create.getByText("目标 Client", { exact: true })).toHaveCount(0);
  await create.locator('input[name="codeflow-workspace-title"]').fill("离线项目");
  await create.locator('input[name="codeflow-workspace-path"]').fill(workspacePath);
  await create.getByRole("button", { name: /^创\s*建$/ }).click();
  await expect(create).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /切换工作区，当前 离线项目/ })).toBeVisible({ timeout: 30_000 });
  const first = await page.evaluate(() => window.codeflowDesktop.request({ method: "workspaces.list" }));
  assert.equal(first.status, 200);
  assert.equal(first.body.workspaces.length, 1);
  const workspaceId = first.body.workspaces[0].id;
  const saved = await page.evaluate((workspaceId) => window.codeflowDesktop.request({ method: "workspaceExecutionProfile.update", body: { workspaceId, profileText: "离线项目规范" } }), workspaceId);
  assert.equal(saved.status, 200);
  await close();
  saveHistory(workspaceId, [message(workspaceId, historySeq, "本机历史正文")], true);
  page = await launch();
  await expect(page.getByRole("button", { name: /切换工作区，当前 离线项目/ })).toBeVisible({ timeout: 60_000 });
  const retained = await page.evaluate((workspaceId) => window.codeflowDesktop.request({ method: "workspaceExecutionProfile.get", body: { workspaceId } }), workspaceId);
  assert.equal(retained.status, 200);
  assert.equal(retained.body.profile.profileText, "离线项目规范");
  await expect(page.getByText("离线历史", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByText("离线历史", { exact: true }).first().click();
  await expect(page.getByText("本机历史正文", { exact: true })).toBeVisible({ timeout: 30_000 });
  const live = message(workspaceId, historySeq + 1, "本机实时正文");
  saveHistory(workspaceId, [live]);
  await application.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0].webContents.mainFrame.send("desktop:event", { t: "conversation.event", event });
  }, live);
  await expect(page.getByText("本机实时正文", { exact: true })).toBeVisible({ timeout: 30_000 });
  saveHistory(workspaceId, [message(workspaceId, historySeq + 2, "重新打开补齐历史")]);
  await page.getByText("另一会话", { exact: true }).first().click();
  await page.getByText("离线历史", { exact: true }).first().click();
  await expect(page.getByText("重新打开补齐历史", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "更多", exact: true }).first().click();
  await page.getByRole("menuitem", { name: /调试/ }).click();
  await page.locator(".inspector__tab").filter({ hasText: "事件" }).click();
  await expect(page.getByText("offline-inspector", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByText("本机历史正文", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("本机实时正文", { exact: true })).toBeVisible({ timeout: 30_000 });
  const navigationProbe = await application.evaluate(({ BrowserWindow }, modulePath) => {
    const { bindMainFrameEvents } = process.getBuiltinModule("module").createRequire(modulePath)(modulePath);
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const listeners = new Set();
    const steps = [];
    const dispose = bindMainFrameEvents(contents, "http://localhost:39281", (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const started = () => steps.push("started");
    const failed = () => steps.push("failed");
    const cancelled = (event) => { steps.push("cancelled"); event.preventDefault(); };
    contents.on("did-start-navigation", started);
    contents.on("did-fail-load", failed);
    contents.once("will-navigate", cancelled);
    globalThis.desktopNavigationProbe = { listeners, steps, dispose: () => {
      dispose(); contents.removeListener("did-start-navigation", started); contents.removeListener("did-fail-load", failed);
      contents.removeListener("will-navigate", cancelled);
    } };
    return listeners.size;
  }, fileURLToPath(new URL("../dist/mainFrameEvents.js", import.meta.url)));
  assert.equal(navigationProbe, 1);
  await page.evaluate(() => { window.location.href = `${window.location.origin}/cancelled`; });
  await expect.poll(() => application.evaluate(() => globalThis.desktopNavigationProbe.steps.includes("cancelled"))).toBe(true);
  const cancelled = await application.evaluate(() => ({ listeners: globalThis.desktopNavigationProbe.listeners.size, steps: globalThis.desktopNavigationProbe.steps }));
  assert.equal(cancelled.listeners, 1, JSON.stringify(cancelled.steps));
  await application.evaluate(() => { globalThis.desktopNavigationProbe.dispose(); delete globalThis.desktopNavigationProbe; });
  await page.goto("http://localhost:39281/orchestration/assets");
  await expect(page.getByRole("tab", { name: "Agent", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "复制为个人资产", exact: true })).toBeVisible({ timeout: 30_000 });
  const beforeCopy = await page.evaluate((workspaceId) => window.codeflowDesktop.request({ method: "orch.roles.list", body: { workspaceId } }), workspaceId);
  assert.equal(beforeCopy.status, 200);
  assert.equal(beforeCopy.body.roles.filter(role => role.kind === "builtin").length, 20);
  await page.getByRole("button", { name: "复制为个人资产", exact: true }).click();
  await expect(page.getByRole("button", { name: "复制为个人资产", exact: true })).toHaveCount(0, { timeout: 30_000 });
  const afterCopy = await page.evaluate((workspaceId) => window.codeflowDesktop.request({ method: "orch.roles.list", body: { workspaceId } }), workspaceId);
  const copy = afterCopy.body.roles.find(role => role.kind === "custom");
  assert.ok(copy?.name.endsWith("_复制"));
  const localDependencies = await page.evaluate(async (workspaceId) => {
    const definitions = [
      ["orch.knowledgeBundles.upsert", "bundle", { name: "验收本机知识", scope: "role", sourceRefs: [], content: "本机知识正文" }],
      ["orch.skills.upsert", "skill", { name: "验收本机技能", skillMd: "# 本机技能", targetEngines: ["codex", "claude"] }],
      ["orch.toolsets.upsert", "toolset", { name: "验收本机工具", tools: [{ id: "check", name: "验收可选工具", runtime: "prompt", prompt: "检查当前任务" }] }],
    ];
    const results = [];
    for (const [method, field, definition] of definitions) {
      const result = await window.codeflowDesktop.request({ method, body: { workspaceId, [field]: definition } });
      if (result.status !== 200) throw new Error(JSON.stringify({ method, result }));
      results.push(result.body[field].id);
    }
    return results;
  }, workspaceId);
  await page.reload();
  await page.getByRole("tab", { name: "Agent", exact: true }).click();
  await page.getByText(copy.name, { exact: true }).first().click();
  const tabs = page.locator(".role-form__tab");
  await tabs.filter({ hasText: "知识" }).click();
  await expect(page.getByText("验收本机知识", { exact: true })).toBeVisible();
  await page.locator(".role-form__check-card").filter({ hasText: "验收本机知识" }).getByRole("checkbox").check();
  await tabs.filter({ hasText: "Skills" }).click();
  await expect(page.getByText("验收本机技能", { exact: true })).toBeVisible();
  await page.locator(".role-form__check-card").filter({ hasText: "验收本机技能" }).getByRole("checkbox").check();
  await tabs.filter({ hasText: "工具" }).click();
  await expect(page.getByText("验收可选工具", { exact: true })).toBeVisible();
  await page.locator(".role-form__check-card").filter({ hasText: "验收可选工具" }).getByRole("checkbox").check();
  await tabs.filter({ hasText: "基本" }).click();
  await expect(page.locator(".role-form__header-actions").getByRole("button", { name: /保存/ })).toBeEnabled();
  await page.locator(".role-form__input").first().fill("离线个人角色");
  await page.locator(".role-form__header-actions").getByRole("button", { name: /保存/ }).click();
  await expect.poll(async () => {
    const result = await page.evaluate((workspaceId) => window.codeflowDesktop.request({ method: "orch.roles.list", body: { workspaceId } }), workspaceId);
    return result.body.roles.find(role => role.id === copy.id)?.name;
  }).toBe("离线个人角色");
  const savedRole = await page.evaluate(async ({ workspaceId, roleId }) => {
    const result = await window.codeflowDesktop.request({ method: "orch.roles.list", body: { workspaceId } });
    return result.body.roles.find(role => role.id === roleId);
  }, { workspaceId, roleId: copy.id });
  assert.ok(savedRole.defaultKnowledgeBundleIds.includes(localDependencies[0]));
  assert.ok(savedRole.defaultSkillIds.includes(localDependencies[1]));
  assert.ok(savedRole.toolRefs.some(ref => ref.toolsetId === localDependencies[2] && ref.toolId === "check"));
  await page.goto("http://localhost:39281/chat");
  await page.getByText("离线历史", { exact: true }).first().click();
  const composer = page.locator(".composer__textarea");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "WorkFlow", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Spec", exact: true })).toHaveCount(0);
  await composer.fill("本机草稿重启后保留");
  await expect.poll(async () => {
    const response = await page.evaluate(({ workspaceId, threadId }) => window.codeflowDesktop.request({ method: "threads.draft.get", body: { workspaceId, threadId } }), { workspaceId, threadId });
    assert.equal(response.status, 200);
    return response.body.draft?.text;
  }, { timeout: 15_000 }).toBe("本机草稿重启后保留");
  await page.locator(".composer__role-select").click();
  await expect(page.locator(".composer__role-dropdown").getByText("离线个人角色", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await close();
  page = await launch();
  await page.getByText("离线历史", { exact: true }).first().click();
  await expect(page.locator(".composer__textarea")).toHaveValue("本机草稿重启后保留", { timeout: 30_000 });
  const newChatButton = page.getByRole("button", { name: "+ 新建", exact: true });
  await expect(newChatButton).toBeEnabled();
  await newChatButton.click();
  const newChatDialog = page.getByRole("dialog", { name: "新建会话", exact: true });
  await expect(newChatDialog).toBeVisible();
  await newChatDialog.locator('input[name="codeflow-thread-title"]').fill("离线手动会话");
  const confirmCreate = newChatDialog.getByRole("button", { name: /^确\s*定$/ });
  if (await confirmCreate.isEnabled()) {
    await confirmCreate.click();
    await expect(newChatDialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText("离线手动会话", { exact: true }).first()).toBeVisible();
  } else {
    await expect(newChatDialog.locator(".ant-alert-message")).toBeVisible();
    await newChatDialog.getByRole("button", { name: /^取\s*消$/ }).click();
  }
  console.log("Electron offline workspace, persisted history, renderer event bridge and reload checks passed");
} catch (error) {
  console.error("Electron verification failed", error);
  if (application) {
    const pages = application.windows();
    if (pages.length) console.error((await pages[0].locator("body").innerText()).slice(0, 5000));
  }
  throw error;
} finally {
  try { await close(); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
