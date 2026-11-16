import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-electron-smoke-"));

try {
  const webDir = path.join(root, "web");
  await fs.mkdir(path.join(webDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(webDir, "index.html"), '<!doctype html><script src="/assets/app.js"></script>', "utf8");
  await fs.writeFile(path.join(webDir, "assets", "app.js"), "window.assetLoaded = true;", "utf8");
  const entry = path.join(root, "smoke.mjs");
  await fs.writeFile(entry, `
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, ipcMain, protocol, net } from "electron";
import { createDesktopWebHandler } from ${JSON.stringify(new URL("../dist/webProtocol.js", import.meta.url).href)};

app.setPath("userData", ${JSON.stringify(path.join(root, "profile"))});
protocol.registerSchemesAsPrivileged([{ scheme: "codeflow", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window;
void (async () => {
try {
  await app.whenReady();
  const handler = createDesktopWebHandler({
    getWebDir: () => ${JSON.stringify(webDir)}, fetchFile: (url) => net.fetch(url), onError: () => {},
  });
  protocol.handle("codeflow", handler);
  ipcMain.handle("desktop:getState", () => ({ status: "ready" }));
  window = new BrowserWindow({ show: false, webPreferences: {
    preload: ${JSON.stringify(path.join(desktopDir, "dist", "preload.cjs"))},
    contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  await window.loadURL("codeflow://desktop/workspace/chat");
  assert.equal(await window.webContents.executeJavaScript("window.assetLoaded"), true);
  assert.equal(await window.webContents.executeJavaScript("typeof require"), "undefined");
  assert.equal(await window.webContents.executeJavaScript("window.codeflowDesktop.getState().then(state => state.status)"), "ready");
  await fs.rename(${JSON.stringify(webDir)}, ${JSON.stringify(`${webDir}-removed`)});
  await assert.rejects(() => window.loadURL("codeflow://desktop/unavailable"), /ERR_(?:FAILED|UNEXPECTED)/);
  console.log("Electron resource and sandbox preload checks passed");
  window.destroy();
  app.exit(0);
} catch (error) {
  console.error(error);
  window?.destroy();
  app.exit(1);
}
})();
`, "utf8");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)("electron");
  const result = await promisify(execFile)(electron, [entry], { env, windowsHide: true, timeout: 30_000 });
  process.stdout.write(result.stdout);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
