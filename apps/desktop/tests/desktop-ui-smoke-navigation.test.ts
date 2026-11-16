import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";

const require = createRequire(import.meta.url);
const smoke = require("./support/desktop-ui-smoke.mjs");
const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
const { chromium } = webRequire("@playwright/test");

type FixtureOptions = { currentTitle?: string; selectorDisabled?: boolean; createDisabled?: boolean; settingsOpen?: boolean; settingsDelayMs?: number; settingsCloseDisabled?: boolean; otherModalOpen?: boolean };

/** 用真实浏览器保留隐藏弹层与原生表单副作用，避免 mock 点击产生假成功。 */
async function workspacePage(t: TestContext, options: FixtureOptions = {}) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.setContent(`<button id="selector" type="button">工作区</button>
    <div class="ws-compact-panel" hidden><button id="open-create" type="button">新建工作区</button></div>
    <dialog aria-label="新建工作区"><form>
      <input name="codeflow-workspace-title" required><input name="codeflow-workspace-path" required>
      <button id="confirm-create" type="submit">创建</button><button id="cancel-create" type="button">取消</button>
    </form></dialog>
    ${options.settingsOpen ? '<dialog id="settings" aria-label="设置"><button id="settings-close" type="button" aria-label="Close">Close</button></dialog>' : ""}
    ${options.otherModalOpen ? '<dialog id="other" aria-label="其他确认"><button type="button" aria-label="Close">Close</button></dialog>' : ""}
    <script>
      const options=${JSON.stringify(options)};
      const selector=document.getElementById('selector'), panel=document.querySelector('.ws-compact-panel');
      const dialog=document.querySelector('dialog'), form=document.querySelector('form');
      const title=document.querySelector('[name="codeflow-workspace-title"]'), directory=document.querySelector('[name="codeflow-workspace-path"]');
      window.created=[];
      selector.setAttribute('aria-label', options.currentTitle ? '切换工作区，当前 '+options.currentTitle : '切换工作区');
      selector.disabled=Boolean(options.selectorDisabled);
      document.getElementById('confirm-create').disabled=Boolean(options.createDisabled);
      selector.onclick=()=>{panel.hidden=false;};
      document.getElementById('open-create').onclick=()=>{panel.hidden=true;form.reset();dialog.showModal();};
      form.onsubmit=event=>{event.preventDefault();window.created.push({title:title.value,directory:directory.value});selector.setAttribute('aria-label','切换工作区，当前 '+title.value);dialog.close();};
      document.getElementById('cancel-create').onclick=()=>dialog.close();
      if(options.settingsOpen){const settings=document.getElementById('settings'), close=document.getElementById('settings-close');close.disabled=Boolean(options.settingsCloseDisabled);close.onclick=()=>settings.close();if(options.settingsDelayMs){selector.disabled=true;setTimeout(()=>{settings.showModal();selector.disabled=Boolean(options.selectorDisabled);},options.settingsDelayMs);}else settings.showModal();}
      if(options.otherModalOpen)document.getElementById('other').showModal();
    </script>`);
  return page;
}

test("createWorkspace opens the compact menu when no workspace is selected", async t => {
  const page = await workspacePage(t);
  await smoke.createWorkspace(page, { title: "本机工作区A", directory: "C:/isolated/project-a" });
  assert.deepEqual(await page.evaluate("window.created"), [{ title: "本机工作区A", directory: "C:/isolated/project-a" }]);
  assert.equal(await page.locator("dialog").isVisible(), false);
});

test("createWorkspace reopens the compact menu for each consecutive creation", async t => {
  const page = await workspacePage(t, { currentTitle: "既有工作区" });
  await smoke.createWorkspace(page, { title: "本机工作区A", directory: "C:/isolated/project-a" });
  await smoke.createWorkspace(page, { title: "本机工作区B", directory: "C:/isolated/project-b" });
  assert.deepEqual(await page.evaluate("window.created"), [
    { title: "本机工作区A", directory: "C:/isolated/project-a" },
    { title: "本机工作区B", directory: "C:/isolated/project-b" },
  ]);
  assert.equal(await page.locator("#selector").getAttribute("aria-label"), "切换工作区，当前 本机工作区B");
});

test("createWorkspace preserves exact title characters when checking the selected workspace", async t => {
  const page = await workspacePage(t, { currentTitle: "旧 [A]+" });
  await smoke.createWorkspace(page, { title: "新 (A) [1]+.$", directory: "C:/isolated/project-special" });
  assert.deepEqual(await page.evaluate("window.created"), [{ title: "新 (A) [1]+.$", directory: "C:/isolated/project-special" }]);
});

test("opening the shared create dialog does not submit or change the selected workspace", async t => {
  const page = await workspacePage(t, { currentTitle: "既有工作区" });
  const dialog = await smoke.openCreateWorkspaceDialog(page);
  assert.equal(await dialog.isVisible(), true);
  assert.deepEqual(await page.evaluate("window.created"), []);
  assert.equal(await page.locator("#selector").getAttribute("aria-label"), "切换工作区，当前 既有工作区");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
});

test("a disabled workspace selector fails without opening the form or submitting", async t => {
  const page = await workspacePage(t, { selectorDisabled: true });
  page.setDefaultTimeout(300);
  await assert.rejects(smoke.openCreateWorkspaceDialog(page), /Timeout/);
  assert.equal(await page.locator("dialog").isVisible(), false);
  assert.deepEqual(await page.evaluate("window.created"), []);
});

test("a disabled create action fails without a false creation or selected-workspace change", async t => {
  const page = await workspacePage(t, { currentTitle: "既有工作区", createDisabled: true });
  page.setDefaultTimeout(300);
  await assert.rejects(smoke.createWorkspace(page, { title: "未创建", directory: "C:/isolated/not-created" }), /Timeout/);
  assert.deepEqual(await page.evaluate("window.created"), []);
  assert.equal(await page.locator("#selector").getAttribute("aria-label"), "切换工作区，当前 既有工作区");
});

test("the explicit first-run settings step allows workspace creation", async t => {
  const page = await workspacePage(t, { settingsOpen: true });
  await smoke.closeInitialSettings(page);
  await smoke.createWorkspace(page, { title: "首装工作区", directory: "C:/isolated/first-run" });
  assert.deepEqual(await page.evaluate("window.created"), [{ title: "首装工作区", directory: "C:/isolated/first-run" }]);
  assert.equal(await page.getByRole("dialog", { name: "设置", exact: true }).isVisible(), false);
});

test("settings appearing while the workspace selector becomes ready do not block creation", async t => {
  const page = await workspacePage(t, { settingsOpen: true, settingsDelayMs: 500 });
  await smoke.closeInitialSettings(page);
  await smoke.createWorkspace(page, { title: "延迟首装", directory: "C:/isolated/delayed-first-run" });
  assert.deepEqual(await page.evaluate("window.created"), [{ title: "延迟首装", directory: "C:/isolated/delayed-first-run" }]);
  assert.equal(await page.getByRole("dialog", { name: "设置", exact: true }).isVisible(), false);
});

test("a disabled settings close action fails without bypassing the modal", async t => {
  const page = await workspacePage(t, { settingsOpen: true, settingsCloseDisabled: true });
  page.setDefaultTimeout(300);
  await assert.rejects(smoke.closeInitialSettings(page), /Timeout/);
  assert.equal(await page.getByRole("dialog", { name: "设置", exact: true }).isVisible(), true);
  assert.deepEqual(await page.evaluate("window.created"), []);
});

test("an unrelated modal is never dismissed to force workspace navigation", async t => {
  const page = await workspacePage(t, { otherModalOpen: true });
  page.setDefaultTimeout(300);
  await assert.rejects(smoke.openCreateWorkspaceDialog(page), /Timeout/);
  assert.equal(await page.getByRole("dialog", { name: "其他确认", exact: true }).isVisible(), true);
  assert.deepEqual(await page.evaluate("window.created"), []);
});
