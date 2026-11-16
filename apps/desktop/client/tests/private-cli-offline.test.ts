import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPrivateCliRuntimeEntry } from "../src/cli-runtime/privateCliPaths.js";
import { installPrivateCli } from "../src/app/handlers/privateCliRuntime.js";
import {
  installPrivateCliFromOffline,
  offlinePrivateCliSource,
} from "../src/app/handlers/privateCliOffline.js";

const fixtureNpmCli = fileURLToPath(new URL("./fixtures/fake-npm-cli.cjs", import.meta.url));
const manifest = { schemaVersion: 1 as const, npm: { version: "12.2.2" }, engines: {
  claude: { npmPackage: "@anthropic-ai/claude-code", version: "2.1.318", estimatedBytes: 350000000 },
  codex: { npmPackage: "@openai/codex", version: "0.166.0", estimatedBytes: 520000000 },
} };
const CODEX_BIN = "node_modules/@openai/codex/bin/codex.js";
const RUNTIME_ENTRY = {
  schemaVersion: 1,
  engine: "codex",
  npmPackage: "@openai/codex",
  version: "0.166.0",
  installedAt: "2026-11-05T00:00:00.000Z",
  verifiedAt: "2026-11-05T00:00:01.000Z",
  binPath: CODEX_BIN,
};

/** 按固定离线目录布局写入一个企业 IT 预置包，version 可覆盖以构造版本不匹配。 */
async function writeOfflinePack(root: string, version = "0.166.0"): Promise<string> {
  const source = path.join(root, "offline", "codex");
  await fs.mkdir(path.join(source, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  await fs.writeFile(path.join(source, CODEX_BIN), "console.log('0.166.0')");
  await fs.writeFile(
    path.join(source, "runtime.json"),
    JSON.stringify({ ...RUNTIME_ENTRY, version }),
  );
  return source;
}

test("imports a verified offline CLI tree without npm and rejects version mismatch", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-offline-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "offline", "codex");
  await fs.mkdir(path.join(source, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  await fs.writeFile(path.join(source, "node_modules", "@openai", "codex", "bin", "codex.js"), "console.log('0.166.0')");
  await fs.writeFile(path.join(source, "runtime.json"), JSON.stringify({ schemaVersion: 1, engine: "codex",
    npmPackage: "@openai/codex", version: "0.166.0", installedAt: "2026-11-05T00:00:00.000Z",
    verifiedAt: "2026-11-05T00:00:01.000Z", binPath: "node_modules/@openai/codex/bin/codex.js" }));
  assert.equal(offlinePrivateCliSource(root, "codex", "0.166.0"), source);
  assert.equal(offlinePrivateCliSource(root, "codex", "0.1.0"), null);
  const result = await installPrivateCliFromOffline({ root, engine: "codex", version: "0.166.0", requestId: "req-offline" });
  assert.equal(result.success, true);
  assert.equal(readPrivateCliRuntimeEntry(root, "codex")?.version, "0.166.0");
});

test("offline source requires a valid runtime.json and an existing bin", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-offline-validate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await writeOfflinePack(root);
  await fs.writeFile(path.join(source, "runtime.json"), "{not-json");
  assert.equal(offlinePrivateCliSource(root, "codex", "0.166.0"), null);
  await fs.writeFile(path.join(source, "runtime.json"), JSON.stringify(RUNTIME_ENTRY));
  await fs.rm(path.join(source, CODEX_BIN));
  assert.equal(offlinePrivateCliSource(root, "codex", "0.166.0"), null);
});

test("installPrivateCli prefers a valid offline pack and never runs npm", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-offline-prefer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeOfflinePack(root);
  const result = await installPrivateCli({
    root, engine: "codex", manifest, requestId: "req-offline-prefer",
    // 不可用的 npm 入口：若走网络安装路径必然失败。
    npmCliPath: path.join(root, "missing-npm-cli.js"),
    attempts: [{ source: "official", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }],
  });
  assert.equal(result.success, true, result.error ?? "");
  assert.deepEqual(result.attempts, []);
  assert.equal(readPrivateCliRuntimeEntry(root, "codex")?.version, "0.166.0");
});

test("offline import runs the existing disk preflight before copying", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-offline-disk-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeOfflinePack(root);
  const result = await installPrivateCli({
    root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-offline-disk",
    attempts: [{ source: "official", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }],
    freeBytes: async () => 1,
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /PRIVATE_CLI_DISK_INSUFFICIENT/u);
  assert.equal(readPrivateCliRuntimeEntry(root, "codex"), null);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith(".staging-")), false);
});

test("invalid offline pack fails without falling back to npm", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-offline-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeOfflinePack(root, "0.1.0");
  const result = await installPrivateCli({
    root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-offline-invalid",
    attempts: [{ source: "official", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }],
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /PRIVATE_CLI_OFFLINE_INVALID/u);
  assert.deepEqual(result.attempts, []);
  assert.equal(readPrivateCliRuntimeEntry(root, "codex"), null);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith(".staging-")), false);
});
