import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { removeMacOSUninstallData, runMacOSUninstall, waitForMacOSParentExit } from "../src/macosUninstall.js";

/** 建立可核对的 macOS 包、应用数据与定位文件，全部位于测试独占目录。 */
async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cf-macos-uninstall-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationRoot = path.join(root, "Applications", "CodeFlow.app");
  const userDataDir = path.join(root, "profile");
  const dataDir = path.join(userDataDir, "runtime");
  const sessionDataDir = path.join(root, "session");
  await fs.mkdir(path.join(applicationRoot, "Contents"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "releases", "bundle"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "workspace"), { recursive: true });
  await fs.mkdir(path.join(userDataDir, "Cache"), { recursive: true });
  await fs.mkdir(sessionDataDir, { recursive: true });
  await fs.writeFile(path.join(applicationRoot, "Contents", "Info.plist"), "plist", "utf8");
  await fs.writeFile(path.join(dataDir, "config.json"), "{}", "utf8");
  await fs.writeFile(path.join(dataDir, "device-identity.json"), "{}", "utf8");
  await fs.writeFile(path.join(userDataDir, "desktop-uninstall-result.json"), "{}", "utf8");
  await fs.writeFile(path.join(dataDir, "codeflowai.db"), "db", "utf8");
  await fs.writeFile(path.join(dataDir, "releases", "bundle", "index.html"), "release", "utf8");
  await fs.writeFile(path.join(dataDir, "workspace", "main.ts"), "project", "utf8");
  await fs.writeFile(path.join(dataDir, "unknown.txt"), "keep", "utf8");
  await fs.writeFile(path.join(userDataDir, "Cache", "cache.bin"), "cache", "utf8");
  await fs.writeFile(path.join(sessionDataDir, "session.bin"), "session", "utf8");
  await fs.writeFile(path.join(userDataDir, "desktop-data-location.json"), JSON.stringify({
    schemaVersion: 1, appId: "ai.codeflow.codeflowai", installRoot: applicationRoot, dataDir, clientId: null, deviceId: null,
  }), "utf8");
  const logFile = path.join(root, "logs", "uninstall.log");
  return { root, applicationRoot, userDataDir, dataDir, sessionDataDir, logFile };
}

test("macOS 卸载只清理授权数据并保留默认工作区与未知文件", async t => {
  const f = await fixture(t), trashed: string[] = [];
  const result = await runMacOSUninstall({ ...f, parentPid: process.pid },
    { waitForExit: async () => {}, prepareTrash: async () => {}, trashApplication: async root => { trashed.push(root); } });
  assert.deepEqual(trashed, [f.applicationRoot]);
  await assert.rejects(fs.access(path.join(f.dataDir, "config.json")));
  await assert.rejects(fs.access(path.join(f.dataDir, "codeflowai.db")));
  await assert.rejects(fs.access(path.join(f.dataDir, "releases")));
  await assert.rejects(fs.access(path.join(f.userDataDir, "desktop-data-location.json")));
  await assert.rejects(fs.access(path.join(f.dataDir, "device-identity.json")));
  await assert.rejects(fs.access(path.join(f.userDataDir, "desktop-uninstall-result.json")));
  await assert.rejects(fs.access(path.join(f.userDataDir, "Cache")));
  await assert.rejects(fs.access(path.join(f.sessionDataDir, "session.bin")));
  assert.equal(await fs.readFile(path.join(f.dataDir, "workspace", "main.ts"), "utf8"), "project");
  assert.equal(await fs.readFile(path.join(f.dataDir, "unknown.txt"), "utf8"), "keep");
  assert.deepEqual(result.retained.sort(), [path.join(f.dataDir, "unknown.txt"), path.join(f.dataDir, "workspace")].sort());
  assert.match(await fs.readFile(f.logFile, "utf8"), /DESKTOP_MACOS_UNINSTALL_COMPLETED/u);
  await fs.access(f.applicationRoot);
});

test("macOS 卸载拒绝与定位文件不一致的数据目录", async t => {
  const f = await fixture(t), other = path.join(f.root, "other");
  await fs.mkdir(other);
  await assert.rejects(removeMacOSUninstallData({ ...f, dataDir: other }), /DESKTOP_MACOS_UNINSTALL_LOCATOR_INVALID/u);
  assert.equal(await fs.readFile(path.join(f.dataDir, "config.json"), "utf8"), "{}");
});

test("macOS 卸载等待必须收到有效 pid", async () => {
  await assert.rejects(waitForMacOSParentExit(0, 10), /DESKTOP_MACOS_UNINSTALL_PID_INVALID/u);
});
