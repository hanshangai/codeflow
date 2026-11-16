import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";

const require = createRequire(import.meta.url);
const smoke = require("./support/desktop-ui-smoke.mjs");
const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
const { _electron: electron } = webRequire("@playwright/test");

/** 仅替换产品入口及故障等待，保留真实 Electron 进程、页面和退出副作用。 */
async function launchFixture(t: TestContext, configure?: (application: any) => void, status = 200) {
  const { root, env } = await smoke.createUiRoot("codeflow-ui-launch-cleanup-");
  const server = http.createServer((_request, response) => {
    response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Isolated lifecycle fixture</title>");
  });
  let application: any;
  let childProcess: ChildProcess | undefined;
  t.after(async () => {
    t.mock.restoreAll();
    if (application && childProcess?.exitCode === null && childProcess.signalCode === null) await application.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const webEntry = `http://127.0.0.1:${address.port}/chat`;
  const entry = path.join(root, "fixture.cjs");
  await fs.writeFile(entry, `const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.argv.find(value => value.startsWith("--user-data-dir=")).slice("--user-data-dir=".length));
app.on("window-all-closed", () => app.quit());
globalThis.fixtureReady = app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await window.loadURL(process.env.CODEFLOWAI_DESKTOP_WEB_ENTRY);
});
globalThis.fixtureReady.catch(error => { console.error(error); app.exit(1); });
`, "utf8");
  const launch = electron.launch.bind(electron);
  t.mock.method(electron, "launch", async (options: any) => {
    application = await launch({ ...options, args: [entry, ...options.args.slice(1)] });
    childProcess = application.process();
    await application.evaluate("globalThis.fixtureReady");
    configure?.(application);
    return application;
  });
  return { run: () => smoke.launchDesktop({ root, env, webEntry }), application: () => application, process: () => childProcess };
}

/** 验证已观测的本测试子进程真正退出，不以 mock 关闭次数代替清理结果。 */
async function assertExited(child: ChildProcess | undefined) {
  assert.ok(child?.pid);
  const pid = child.pid;
  await smoke.expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("first-window failure closes the launched Electron process and preserves the original error", async t => {
  const failure = new Error("FIRST_WINDOW_FAILED");
  const fixture = await launchFixture(t, application => {
    t.mock.method(application, "firstWindow", async () => { throw failure; });
  });
  await assert.rejects(fixture.run(), error => error === failure);
  await assertExited(fixture.process());
});

test("chat-page wait failure closes the launched Electron process and preserves the original error", async t => {
  const failure = new Error("CHAT_PAGE_WAIT_FAILED");
  const fixture = await launchFixture(t, application => {
    const firstWindow = application.firstWindow.bind(application);
    t.mock.method(application, "firstWindow", async (options: any) => {
      const page = await firstWindow(options);
      t.mock.method(page, "waitForURL", async () => { throw failure; });
      return page;
    });
  });
  await assert.rejects(fixture.run(), error => error === failure);
  await assertExited(fixture.process());
});

test("successful startup returns a live application and page for caller-owned shutdown", async t => {
  const fixture = await launchFixture(t);
  const { application, page } = await fixture.run();
  assert.equal(application, fixture.application());
  assert.equal(application.process().exitCode, null);
  assert.match(page.url(), /\/chat$/);
  assert.equal(await page.title(), "Isolated lifecycle fixture");
  await smoke.closeDesktop(application);
  await assertExited(fixture.process());
});

test("an unavailable Web entry fails before launching Electron", async t => {
  const fixture = await launchFixture(t, undefined, 503);
  await assert.rejects(fixture.run(), /DESKTOP_UI_WEB_ENTRY_UNAVAILABLE/);
  assert.equal(fixture.application(), undefined);
});

test("Electron launch rejection preserves its error without attempting caller cleanup", async t => {
  const failure = new Error("ELECTRON_LAUNCH_FAILED");
  const fixture = await launchFixture(t);
  t.mock.restoreAll();
  t.mock.method(electron, "launch", async () => { throw failure; });
  await assert.rejects(fixture.run(), error => error === failure);
  assert.equal(fixture.application(), undefined);
});

test("startup and cleanup failures remain independently inspectable", async t => {
  for (const { name, primary, cleanup } of [
    { name: "original error objects", primary: new Error("STARTUP_FAILED"), cleanup: new Error("CLOSE_ACK_FAILED") },
    { name: "falsy rejection values", primary: undefined, cleanup: false },
  ]) await t.test(name, async child => {
    const fixture = await launchFixture(child, application => {
      child.mock.method(application, "firstWindow", async () => { throw primary; });
      const wait = application.waitForEvent.bind(application);
      child.mock.method(application, "waitForEvent", async (...args: any[]) => { await wait(...args); throw cleanup; });
    });
    await assert.rejects(fixture.run(), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], primary);
      assert.equal(error.errors[1], cleanup);
      return true;
    });
    await assertExited(fixture.process());
  });
});

test("falsy startup rejection still closes Electron and remains the original rejection", async t => {
  for (const failure of [undefined, null, false, 0, ""]) await t.test(String(failure), async child => {
    const fixture = await launchFixture(child, application => {
      child.mock.method(application, "firstWindow", async () => { throw failure; });
    });
    await assert.rejects(fixture.run(), error => error === failure);
    await assertExited(fixture.process());
  });
});
