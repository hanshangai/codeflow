import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readDesktopRepairDownloadUrl, readInstalledUpdateOrigin } from "../src/updateConfiguration.js";

test("recovery downloads use the installed environment and a fixed package route for each platform", async t => {
  const f = await fixture(t);
  assert.equal(readDesktopRepairDownloadUrl(f.root, "win32", "x64"), undefined);
  await fs.writeFile(f.file, JSON.stringify({ serverOrigin: "https://updates.example.test" }));
  for (const [platform, arch, target] of [["win32", "x64", "windows-x64"], ["darwin", "arm64", "darwin-arm64"], ["darwin", "x64", "darwin-x64"]] as const) {
    assert.equal(readDesktopRepairDownloadUrl(f.root, platform, arch), `https://updates.example.test/api/public/desktop-download/${target}`);
  }
  assert.equal(readDesktopRepairDownloadUrl(f.root, "linux", "x64"), undefined);
  await fs.writeFile(f.file, JSON.stringify({ serverOrigin: "https://updates.example.test/other" }));
  assert.throws(() => readDesktopRepairDownloadUrl(f.root, "win32", "x64"), { code: "DESKTOP_UPDATE_CONFIG_INVALID" });
});

/** 每例独占安装资源目录，不读取用户环境或现有安装配置。 */
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-update-configuration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "desktop-update.json") };
}

test("installed update origin takes precedence over environment configuration", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify({ serverOrigin: "https://updates.example.test" }), "utf8");
  assert.equal(readInstalledUpdateOrigin(f.root, "https://other.example.test"), "https://updates.example.test");
});

test("an offline package preserves explicit environment configuration or no updates", async t => {
  const f = await fixture(t);
  assert.equal(readInstalledUpdateOrigin(f.root), undefined);
  assert.equal(readInstalledUpdateOrigin(f.root, " http://127.0.0.1:39280 "), "http://127.0.0.1:39280");
});

test("damaged installed configuration fails without exposing its body or using the environment", async t => {
  const f = await fixture(t), secret = "synthetic-private-value";
  for (const contents of [Buffer.from('{"serverOrigin":"' + secret), Buffer.from([0xff]), Buffer.from(JSON.stringify({ serverOrigin: secret }))]) {
    await fs.writeFile(f.file, contents);
    assert.throws(() => readInstalledUpdateOrigin(f.root, "https://other.example.test"), error => {
      assert.equal((error as Error).message.includes(secret), false);
      return (error as { code?: string }).code === "DESKTOP_UPDATE_CONFIG_INVALID";
    });
  }
});

test("only a fixed HTTPS or loopback HTTP origin is accepted", async t => {
  const f = await fixture(t);
  for (const serverOrigin of ["http://remote.example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test/?token=secret", "https://example.test/#fragment", "https://example.test/", "", null]) {
    await fs.writeFile(f.file, JSON.stringify({ serverOrigin }), "utf8");
    assert.throws(() => readInstalledUpdateOrigin(f.root), { code: "DESKTOP_UPDATE_CONFIG_INVALID" });
  }
  for (const serverOrigin of ["https://example.test", "http://localhost:39280", "http://127.0.0.1:39280", "http://[::1]:39280"]) {
    await fs.writeFile(f.file, JSON.stringify({ serverOrigin }), "utf8");
    assert.equal(readInstalledUpdateOrigin(f.root), serverOrigin);
  }
});

test("configuration read errors and non-file entries fail explicitly", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.file);
  assert.throws(() => readInstalledUpdateOrigin(f.root));
});
