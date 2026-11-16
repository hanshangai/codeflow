import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { detectEngineClis } from "../src/app/handlers/engineHandlers.js";
import {
  assertPrivateInstallVersion,
  buildPrivateSoftwareUpdateItems,
  readPrivateCliRuntimeConfig,
} from "../src/app/handlers/privateCliRuntime.js";
import {
  handleNpmInstall,
  handleSoftwareUpdateStatus,
} from "../src/app/handlers/softwareUpdateHandlers.js";

const fixtureNpmCli = fileURLToPath(new URL("./fixtures/fake-npm-cli.cjs", import.meta.url));

const manifest = {
  schemaVersion: 1 as const,
  npm: { version: "12.2.2" },
  engines: {
    claude: { npmPackage: "@anthropic-ai/claude-code", version: "2.1.318", estimatedBytes: 350000000 },
    codex: { npmPackage: "@openai/codex", version: "0.166.0", estimatedBytes: 520000000 },
  },
};

const PRIVATE_ENV_KEYS = [
  "CODEFLOWAI_CLI_RUNTIME_ROOT",
  "CODEFLOWAI_CLI_NPM_CLI",
  "CODEFLOWAI_CLI_RUNTIME_MANIFEST",
] as const;

type SavedEnv = Record<(typeof PRIVATE_ENV_KEYS)[number], string | undefined>;

/** 保存并设置私有运行时环境；返回还原函数，保证每个测试都恢复进程环境。 */
async function installPrivateRuntimeEnv(tempRoot: string): Promise<() => void> {
  const saved = Object.fromEntries(PRIVATE_ENV_KEYS.map((key) => [key, process.env[key]])) as SavedEnv;
  const npmCliPath = path.join(tempRoot, "npm-cli.js");
  await fs.copyFile(fixtureNpmCli, npmCliPath);
  const manifestPath = path.join(tempRoot, "cli-runtime.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  process.env.CODEFLOWAI_CLI_RUNTIME_ROOT = path.join(tempRoot, "cli-runtime");
  process.env.CODEFLOWAI_CLI_NPM_CLI = npmCliPath;
  process.env.CODEFLOWAI_CLI_RUNTIME_MANIFEST = manifestPath;
  return () => {
    for (const key of PRIVATE_ENV_KEYS) {
      const previous = saved[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  };
}

/** 捕获 handler 发送的唯一响应，测试只关心状态码与响应体。 */
function createCapturedContext(): { ctx: never; response: () => any } {
  let captured: any;
  return {
    ctx: { send: (message: unknown) => { captured = message; } } as never,
    response: () => captured,
  };
}

test("private update status pins versions, reports size and never requires sudo", () => {
  const items = buildPrivateSoftwareUpdateItems({
    manifest,
    claude: { engineType: "claude", installed: true, version: "2.1.318", binPath: "/data/cli-runtime/claude/bin/claude.exe", features: {}, models: [] } as never,
    codex: { engineType: "codex", installed: false, version: null, binPath: null, features: {}, models: [] } as never,
  });
  assert.deepEqual(items.find(item => item.engineType === "claude")?.latestVersion, "2.1.318");
  assert.equal(items.find(item => item.engineType === "claude")?.installSizeBytes, 350000000);
  assert.equal(items.find(item => item.engineType === "codex")?.updateAvailable, false);
});

test("private install rejects a version different from the pinned manifest", () => {
  assert.throws(() => assertPrivateInstallVersion(manifest, "codex", "0.1.0"), /PRIVATE_CLI_VERSION_MISMATCH/u);
});

test("readPrivateCliRuntimeConfig returns null when any runtime env is missing", async () => {
  assert.equal(await readPrivateCliRuntimeConfig({} as NodeJS.ProcessEnv), null);
});

test("readPrivateCliRuntimeConfig validates paths and surfaces an invalid manifest", async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-config-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const manifestPath = path.join(tempRoot, "cli-runtime.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  const env = {
    CODEFLOWAI_CLI_RUNTIME_ROOT: path.join(tempRoot, "cli-runtime"),
    CODEFLOWAI_CLI_NPM_CLI: path.join(tempRoot, "npm", "npm-cli.js"),
    CODEFLOWAI_CLI_RUNTIME_MANIFEST: manifestPath,
  } as NodeJS.ProcessEnv;

  const config = await readPrivateCliRuntimeConfig(env);
  assert.deepEqual(config?.manifest, manifest);

  await assert.rejects(
    readPrivateCliRuntimeConfig({ ...env, CODEFLOWAI_CLI_RUNTIME_ROOT: "relative/cli-runtime" }),
    /PRIVATE_CLI_RUNTIME_CONFIG_INVALID/u,
  );
  await assert.rejects(
    readPrivateCliRuntimeConfig({ ...env, CODEFLOWAI_CLI_NPM_CLI: path.join(tempRoot, "npm", "npm.cmd") }),
    /PRIVATE_CLI_RUNTIME_CONFIG_INVALID/u,
  );
  await fs.writeFile(manifestPath, "{bad", "utf8");
  await assert.rejects(readPrivateCliRuntimeConfig(env), /PRIVATE_CLI_RUNTIME_MANIFEST_INVALID/u);
});

test("invalid private claude runtime isolates the failure to the claude detection", async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-detect-isolation-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const saved = Object.fromEntries(PRIVATE_ENV_KEYS.map((key) => [key, process.env[key]])) as SavedEnv;
  try {
    const claudeRoot = path.join(tempRoot, "claude");
    await fs.mkdir(claudeRoot, { recursive: true });
    await fs.writeFile(path.join(claudeRoot, "runtime.json"), "{bad", "utf8");
    process.env.CODEFLOWAI_CLI_RUNTIME_ROOT = tempRoot;

    const detected = await detectEngineClis();

    assert.equal(detected.claude.installed, false);
    assert.equal(detected.claude.detectionStatus, "unavailable");
    assert.match(detected.claude.error ?? "", /PRIVATE_CLI_RUNTIME_ENTRY_INVALID/u);
    // codex 不得因 claude 的私有记录损坏而被整体拒绝或降级为同一错误。
    assert.equal(typeof detected.codex.installed, "boolean");
    assert.ok(detected.codex.detectionStatus);
    assert.notEqual(detected.codex.error, detected.claude.error);
    assert.doesNotMatch(String(detected.codex.error ?? ""), /PRIVATE_CLI_RUNTIME_ENTRY_INVALID/u);
  } finally {
    for (const key of PRIVATE_ENV_KEYS) {
      const previous = saved[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
});

test("handleSoftwareUpdateStatus reports private install mode without sudo", async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-status-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const restoreEnv = await installPrivateRuntimeEnv(tempRoot);
  try {
    const { ctx, response } = createCapturedContext();
    await handleSoftwareUpdateStatus(ctx, {
      id: "req-private-status",
      body: { forceRefresh: true },
    } as never);

    const sent = response();
    assert.equal(sent.status, 200);
    assert.equal(sent.body.environment.installMode, "private");
    assert.equal(sent.body.environment.requiresPrivilege, false);
    assert.equal(sent.body.environment.npmGlobalPrefix, null);
    assert.equal(sent.body.environment.npmGlobalInstallWritable, null);
    const claude = sent.body.items.find((item: any) => item.engineType === "claude");
    assert.equal(claude.latestVersion, "2.1.318");
    assert.equal(claude.installSizeBytes, 350000000);
    assert.equal(claude.installMode, "private");
  } finally {
    restoreEnv();
  }
});

test("handleNpmInstall installs into the private runtime without sudo or global prefix probing", async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-handler-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const restoreEnv = await installPrivateRuntimeEnv(tempRoot);
  try {
    const { ctx, response } = createCapturedContext();
    await handleNpmInstall(ctx, {
      id: "req-private-install",
      body: { npmPackage: "@openai/codex", version: "0.166.0", network: { mode: "official" } },
    } as never);

    const sent = response();
    assert.equal(sent.status, 200);
    assert.equal(sent.body.success, true, sent.body.error ?? "");
    assert.equal(sent.body.installedVersion, "0.166.0");
    assert.equal(sent.body.requiresPrivilege, false);
    assert.equal(sent.body.nextAction, null);
    assert.match(String(sent.body.message), /私有/u);
    assert.equal(sent.body.attempts[0].source, "official");

    const entry = JSON.parse(await fs.readFile(path.join(tempRoot, "cli-runtime", "codex", "runtime.json"), "utf8"));
    assert.equal(entry.version, "0.166.0");
  } finally {
    restoreEnv();
  }
});

test("handleNpmInstall rejects a version different from the pinned manifest with 400", async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-handler-version-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const restoreEnv = await installPrivateRuntimeEnv(tempRoot);
  try {
    const { ctx, response } = createCapturedContext();
    await handleNpmInstall(ctx, {
      id: "req-private-version",
      body: { npmPackage: "@openai/codex", version: "0.1.0", network: { mode: "official" } },
    } as never);

    const sent = response();
    assert.equal(sent.status, 400);
    assert.equal(sent.body.ok, false);
    assert.equal(sent.body.code, "PRIVATE_CLI_VERSION_MISMATCH");
  } finally {
    restoreEnv();
  }
});
