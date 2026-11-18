import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { supersedeDesktopInstallationAttempt } from "../src/installationRepair.js";

/** 仅建立独立安装与用户目录，不接触真实配置。 */
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "installation-repair-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installationDir = path.join(root, "installation"), userDataDir = path.join(root, "profile"), dataDir = path.join(userDataDir, "runtime");
  await fs.mkdir(installationDir); await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(userDataDir, "desktop-data-location.json"), JSON.stringify({ schemaVersion: 1, appId: "ai.codeflow.codeflowai",
    installRoot: installationDir, dataDir, clientId: null, deviceId: null }));
  const input = { installationDir, userDataDir, requestId: "nsis-install-test" };
  return { root, dataDir, input };
}

for (const contents of ['{"phase":"failed","recovery":{"terminalEvidence":null},"binding":{"releaseId":"obsolete"}}', '{broken-json', '{"schemaVersion":999}']) {
  test(`完整安装原样归档历史记录 ${contents}`, { skip: process.platform !== "win32" }, async t => {
    const f = await fixture(t), bytes = Buffer.from(contents);
    await fs.writeFile(path.join(f.dataDir, "shell-update-attempt.json"), bytes);
    await fs.writeFile(path.join(f.dataDir, "codeflowai.db"), "user-data");
    const result = await supersedeDesktopInstallationAttempt(f.input);
    assert.equal(result.outcome, "superseded");
    assert.deepEqual(await fs.readFile(path.join(f.dataDir, "logs", result.archive!)), bytes);
    assert.equal(await fs.readFile(path.join(f.dataDir, "codeflowai.db"), "utf8"), "user-data");
    await assert.rejects(fs.access(path.join(f.dataDir, "shell-update-attempt.json")), { code: "ENOENT" });
    assert.equal((await supersedeDesktopInstallationAttempt(f.input)).outcome, "no-attempt");
  });
}

test("拒绝无效的安装请求关联且保留旧任务", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), contents = "unfinished";
  await fs.writeFile(path.join(f.dataDir, "shell-update-attempt.json"), contents);
  await assert.rejects(supersedeDesktopInstallationAttempt({ ...f.input, requestId: "" }), /DESKTOP_INSTALL_REQUEST_INVALID/);
  assert.equal(await fs.readFile(path.join(f.dataDir, "shell-update-attempt.json"), "utf8"), contents);
});

test("没有用户目录的新安装不建立运行数据", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), userDataDir = path.join(f.root, "fresh-profile");
  assert.equal((await supersedeDesktopInstallationAttempt({ ...f.input, userDataDir })).outcome, "no-attempt");
  await assert.rejects(fs.access(userDataDir), { code: "ENOENT" });
});

test("旧任务是链接时拒绝归档且保留外部目标", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), external = path.join(f.root, "external.json");
  await fs.writeFile(external, "external");
  await fs.link(external, path.join(f.dataDir, "shell-update-attempt.json"));
  await assert.rejects(supersedeDesktopInstallationAttempt(f.input));
  assert.equal(await fs.readFile(external, "utf8"), "external");
});
