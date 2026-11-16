import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPrivateCliRuntimeEntry } from "../src/cli-runtime/privateCliPaths.js";
import { commitPrivateCliStaging, installPrivateCli, readPrivateCliRuntimeConfig } from "../src/app/handlers/privateCliRuntime.js";
import { acquireGlobalNpmInstall } from "../src/app/handlers/globalNpmInstallLock.js";

const fixtureNpmCli = fileURLToPath(new URL("./fixtures/fake-npm-cli.cjs", import.meta.url));
const manifest = { schemaVersion: 1 as const, npm: { version: "12.2.2" }, engines: {
  claude: { npmPackage: "@anthropic-ai/claude-code", version: "2.1.318", estimatedBytes: 350000000 },
  codex: { npmPackage: "@openai/codex", version: "0.166.0", estimatedBytes: 520000000 },
} };
const CODEX_BIN = "node_modules/@openai/codex/bin/codex.js";
const CLAUDE_BIN = "node_modules/@anthropic-ai/claude-code/bin/claude.exe";

/** 仅在临时目录准备候选，真实执行提交与回退，隔离 npm 网络和外部引擎。 */
async function swapFixture(t: test.TestContext, installed = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-swap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const staging = path.join(root, ".staging-claude-test"), engineRoot = path.join(root, "claude");
  await fs.mkdir(staging);
  await fs.writeFile(path.join(staging, "candidate"), "new");
  if (installed) { await fs.mkdir(engineRoot); await fs.writeFile(path.join(engineRoot, "previous"), "old"); }
  return { root, staging, engineRoot,
    commit: (probe = async () => ({ version: "2.1.318", binPath: CLAUDE_BIN })) => commitPrivateCliStaging({
      root, staging, engine: "claude", version: "2.1.318", npmPackage: "@anthropic-ai/claude-code", probe,
    }) };
}

/** 精确模拟 Windows rename 返回的系统错误，不能把普通业务错误当占用重试。 */
function renameFailure(source: string, target: string, code = "EPERM"): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename temporarily denied`), { code, syscall: "rename", path: source, dest: target });
}

for (const installed of [false, true])
test(`Windows 短暂占用后成功提交私有引擎，已有旧版=${installed}`, { skip: process.platform !== "win32" }, async t => {
  const f = await swapFixture(t, installed), rename = fs.rename.bind(fs);
  let refusals = 0, promoted = 0;
  t.mock.method(fs, "rename", async (source, target) => {
    if (String(source) === f.staging && refusals++ < 2) throw renameFailure(f.staging, f.engineRoot);
    await rename(source, target);
    if (String(source) === f.staging) promoted++;
  });
  await f.commit();
  assert.equal(promoted, 1);
  assert.equal(refusals, 3);
  assert.equal(readPrivateCliRuntimeEntry(f.root, "claude")?.version, "2.1.318");
  assert.equal(await fs.readFile(path.join(f.engineRoot, "candidate"), "utf8"), "new");
  assert.deepEqual(await fs.readdir(f.root), ["claude"]);
});

test("Windows 持续拒绝目录切换时有界失败并恢复旧引擎", { skip: process.platform !== "win32" }, async t => {
  const f = await swapFixture(t, true), rename = fs.rename.bind(fs);
  let attempts = 0;
  t.mock.method(fs, "rename", async (source, target) => {
    if (String(source) === f.staging) { attempts++; throw renameFailure(f.staging, f.engineRoot); }
    await rename(source, target);
  });
  await assert.rejects(f.commit(), /EPERM/);
  assert.ok(attempts > 1 && attempts <= 6);
  assert.equal(await fs.readFile(path.join(f.engineRoot, "previous"), "utf8"), "old");
  assert.equal(await fs.readFile(path.join(f.staging, "candidate"), "utf8"), "new");
});

test("Windows 旧引擎移出及回退恢复均支持短暂占用", { skip: process.platform !== "win32" }, async t => {
  const f = await swapFixture(t, true), rename = fs.rename.bind(fs);
  let moveOld = 0, restoreOld = 0;
  t.mock.method(fs, "rename", async (source, target) => {
    if (String(source) === f.engineRoot && moveOld++ === 0) throw renameFailure(String(source), String(target), "EBUSY");
    if (String(source).includes(".previous-") && restoreOld++ === 0) throw renameFailure(String(source), String(target), "EACCES");
    await rename(source, target);
  });
  let probes = 0;
  await assert.rejects(f.commit(async () => {
    if (++probes === 2) throw new Error("候选提交后探测失败");
    return { version: "2.1.318", binPath: CLAUDE_BIN };
  }), /候选提交后探测失败/);
  assert.equal(moveOld, 2); assert.equal(restoreOld, 2);
  assert.equal(await fs.readFile(path.join(f.engineRoot, "previous"), "utf8"), "old");
});

for (const code of ["EIO", "ENOSPC", "EPERM_WITHOUT_RENAME_CONTEXT"])
test(`目录提交不重试无关错误 ${code}`, async t => {
  const f = await swapFixture(t);
  let attempts = 0;
  const error = Object.assign(new Error("permanent failure"), { code: code === "EPERM_WITHOUT_RENAME_CONTEXT" ? "EPERM" : code });
  t.mock.method(fs, "rename", async () => { attempts++; throw error; });
  await assert.rejects(f.commit(), cause => cause === error);
  assert.equal(attempts, 1);
});

for (const changed of ["source", "target"])
test(`Windows 重试时 ${changed} 目录被替换则停止且不覆盖其他内容`, { skip: process.platform !== "win32" }, async t => {
  const f = await swapFixture(t), rename = fs.rename.bind(fs);
  let attempts = 0;
  t.mock.method(fs, "rename", async (source, target) => {
    attempts++;
    if (changed === "source") {
      await rename(source, path.join(f.root, "displaced"));
      await fs.mkdir(source);
      await fs.writeFile(path.join(String(source), "unrelated"), "keep");
    } else {
      await fs.mkdir(target);
      await fs.writeFile(path.join(String(target), "unrelated"), "keep");
    }
    throw renameFailure(String(source), String(target));
  });
  await assert.rejects(f.commit(), error => error instanceof AggregateError && error.message.startsWith("PRIVATE_CLI_SWAP_RECHECK_FAILED"));
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(path.join(changed === "source" ? f.staging : f.engineRoot, "unrelated"), "utf8"), "keep");
});

test("Windows 重试后发生磁盘错误时安装结果保留两次系统原因", { skip: process.platform !== "win32" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-retry-error-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rename = fs.rename.bind(fs);
  let attempts = 0;
  t.mock.method(fs, "rename", async (source, target) => {
    if (String(target) === path.join(root, "codex")) {
      attempts++;
      throw renameFailure(String(source), String(target), attempts === 1 ? "EPERM" : "EIO");
    }
    await rename(source, target);
  });
  const result = await installPrivateCli({ root, engine: "codex", manifest, npmCliPath: fixtureNpmCli,
    requestId: "retry-error-context", attempts: officialAttempt() });
  assert.equal(result.success, false);
  assert.equal(attempts, 2);
  assert.match(result.error ?? "", /EPERM[\s\S]*EIO/);
  assert.deepEqual(await fs.readdir(root), []);
});

/** 每次尝试都必须显式声明 Electron Node 模式，模拟桌面端安装环境。 */
function officialAttempt(extraEnv: NodeJS.ProcessEnv = {}) {
  return [{ source: "official" as const, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extraEnv } }];
}

/** 返回一个必然与当前平台不同的原生包变体，用于多平台包冲突断言。 */
function foreignVariant(): string {
  const candidates = ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
  return candidates.find((variant) => variant !== `${process.platform}-${process.arch}`) ?? "linux-x64";
}

test("installs pinned Codex into staging, verifies and swaps atomically", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await installPrivateCli({
    root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-1",
    attempts: [{ source: "official", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }],
  });
  assert.equal(result.success, true);
  assert.equal(result.installedVersion, "0.166.0");
  const entry = readPrivateCliRuntimeEntry(root, "codex");
  assert.equal(entry?.version, "0.166.0");
  assert.equal((await fs.readdir(root)).some(name => name.startsWith(".staging-")), false);
  // 假 npm 记录实际 argv/env/依赖；去掉 --ignore-scripts、版本改成 latest 或去掉 Electron Node 模式都会失败。
  const record = JSON.parse(await fs.readFile(path.join(root, "codex", "fake-npm-record.json"), "utf8"));
  assert.deepEqual(record.argv.slice(0, 2), ["install", "--prefix"]);
  assert.match(record.argv[2], /[\\/]\.staging-codex-[0-9a-f-]+$/u);
  assert.deepEqual(record.argv.slice(3), ["--ignore-scripts", "--include=optional", "--no-audit", "--no-fund"]);
  assert.equal(record.electronRunAsNode, "1");
  assert.deepEqual(record.dependencies, { "@openai/codex": "0.166.0" });
});

test("failed install keeps the previous runtime and cleans staging", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await installPrivateCli({ root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-ok",
    attempts: [{ source: "official", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }] });
  assert.equal(first.success, true, first.error ?? "");
  const result = await installPrivateCli({ root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-fail",
    attempts: [{ source: "official", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FAKE_NPM_FAIL: "1" } }] });
  assert.equal(result.success, false);
  assert.equal(readPrivateCliRuntimeEntry(root, "codex")?.version, "0.166.0");
  assert.equal((await fs.readdir(root)).some(name => name.startsWith(".staging-")), false);
});

test("insufficient disk space fails with a coded error before creating staging", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-disk-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await installPrivateCli({
    root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-disk",
    attempts: officialAttempt(), freeBytes: async () => 1,
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /PRIVATE_CLI_DISK_INSUFFICIENT/u);
  assert.deepEqual(await fs.readdir(root), []);
});

test("retries with the next attempt after npm failure", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-retry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await installPrivateCli({
    root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-retry",
    attempts: [
      { source: "official", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FAKE_NPM_FAIL: "1" } },
      { source: "npmmirror", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    ],
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.attempts.map((attempt) => [attempt.source, attempt.success]), [["official", false], ["npmmirror", true]]);
});

test("foreign platform native packages are rejected", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-platform-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const foreign = `@openai/codex-${foreignVariant()}`;
  const result = await installPrivateCli({
    root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-platform",
    attempts: officialAttempt({ FAKE_NPM_EXTRA_PACKAGE: foreign }),
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /PRIVATE_CLI_PLATFORM_PACKAGE_INVALID/u);
  assert.equal(readPrivateCliRuntimeEntry(root, "codex"), null);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith(".staging-")), false);
});

test("post-swap probe failure restores the previous runtime", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-rollback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await installPrivateCli({ root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-first",
    attempts: officialAttempt() });
  assert.equal(first.success, true, first.error ?? "");
  let probeCalls = 0;
  const result = await installPrivateCli({
    root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-swap",
    attempts: officialAttempt(),
    probe: async () => {
      probeCalls += 1;
      if (probeCalls >= 2) throw new Error("probe rejected the swapped runtime");
      return { version: "0.166.0", binPath: CODEX_BIN };
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.attempts.every(attempt => attempt.success === false), true);
  assert.equal(readPrivateCliRuntimeEntry(root, "codex")?.version, "0.166.0", result.error ?? "");
  const entries = await fs.readdir(root);
  assert.equal(entries.some(name => name.startsWith(".staging-")), false);
  assert.equal(entries.some(name => name.startsWith(".previous-")), false);
});

test("stale staging directories older than one hour are removed", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-stale-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stale = path.join(root, ".staging-codex-stale");
  await fs.mkdir(stale, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(stale, old, old);
  const result = await installPrivateCli({
    root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-stale", attempts: officialAttempt(),
  });
  assert.equal(result.success, true);
  await assert.rejects(fs.access(stale), { code: "ENOENT" });
});

test("Claude postinstall runs under Electron Node mode with the package directory as cwd", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-claude-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await installPrivateCli({
    root, engine: "claude", manifest, npmCliPath: fixtureNpmCli, requestId: "req-claude",
    attempts: officialAttempt(),
    probe: async () => ({ version: "2.1.318", binPath: CLAUDE_BIN }),
  });
  assert.equal(result.success, true);
  const engineRoot = path.join(root, "claude");
  const packageDir = path.join(engineRoot, "node_modules", "@anthropic-ai", "claude-code");
  const record = JSON.parse(await fs.readFile(path.join(packageDir, "install-record.json"), "utf8"));
  assert.equal(record.electronRunAsNode, "1");
  assert.equal(record.npmConfigOmit, "");
  // install.cjs 在 staging 阶段执行，工作目录必须是 staging 内的 Claude 包目录。
  assert.equal(path.basename(record.cwd), "claude-code");
  assert.match(record.cwd, /[\\/]\.staging-claude-[^\\/]+[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code$/u);
  assert.equal(readPrivateCliRuntimeEntry(root, "claude")?.binPath, CLAUDE_BIN);
  // Claude 同样固定精确版本并保留 --ignore-scripts。
  const npmRecord = JSON.parse(await fs.readFile(path.join(engineRoot, "fake-npm-record.json"), "utf8"));
  assert.deepEqual(npmRecord.dependencies, { "@anthropic-ai/claude-code": "2.1.318" });
  assert.deepEqual(npmRecord.argv.slice(3), ["--ignore-scripts", "--include=optional", "--no-audit", "--no-fund"]);
  assert.equal(npmRecord.electronRunAsNode, "1");
});

test("probe version different from the pinned manifest is rejected", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-version-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await installPrivateCli({
    root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-version",
    attempts: officialAttempt(),
    probe: async () => ({ version: "0.1.0", binPath: CODEX_BIN }),
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /PRIVATE_CLI_PROBE_FAILED/u);
  assert.equal(readPrivateCliRuntimeEntry(root, "codex"), null);
});

/** 构造一个完整可用的旧运行时目录，用于崩溃恢复与过期清理断言。 */
async function writePreviousRuntime(root: string, ageMs = 0): Promise<string> {
  const directory = path.join(root, `.previous-codex-recover-${Date.now()}`);
  await fs.mkdir(path.join(directory, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  await fs.writeFile(path.join(directory, CODEX_BIN), "console.log('0.166.0')");
  await fs.writeFile(path.join(directory, "runtime.json"), JSON.stringify({
    schemaVersion: 1, engine: "codex", npmPackage: "@openai/codex", version: "0.166.0",
    installedAt: "2026-11-05T00:00:00.000Z", verifiedAt: "2026-11-05T00:00:01.000Z", binPath: CODEX_BIN,
  }));
  const stamp = new Date(Date.now() - ageMs);
  await fs.utimes(directory, stamp, stamp);
  return directory;
}

test("missing live runtime is recovered from the newest valid previous directory before install", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-recover-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writePreviousRuntime(root, 2 * 60 * 60 * 1000);
  const result = await installPrivateCli({
    root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-recover",
    attempts: officialAttempt({ FAKE_NPM_FAIL: "1" }),
  });
  assert.equal(result.success, false);
  // 安装失败也不能丢失恢复出来的旧运行时。
  assert.equal(readPrivateCliRuntimeEntry(root, "codex")?.version, "0.166.0");
});

test("status config read recovers a crashed previous runtime for both engines", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-config-recover-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "cli-runtime.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  await writePreviousRuntime(path.join(root, "cli-runtime"));
  const config = await readPrivateCliRuntimeConfig({
    CODEFLOWAI_CLI_RUNTIME_ROOT: path.join(root, "cli-runtime"),
    CODEFLOWAI_CLI_NPM_CLI: path.join(root, "npm", "npm-cli.js"),
    CODEFLOWAI_CLI_RUNTIME_MANIFEST: manifestPath,
  } as NodeJS.ProcessEnv);
  assert.equal(config?.manifest.schemaVersion, 1);
  assert.equal(readPrivateCliRuntimeEntry(path.join(root, "cli-runtime"), "codex")?.version, "0.166.0");
});

test("status config read skips crash recovery while an install lock is held", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-config-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "cli-runtime.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  const runtimeRoot = path.join(root, "cli-runtime");
  await writePreviousRuntime(runtimeRoot);
  const lock = acquireGlobalNpmInstall("test-private-cli-install");
  assert.equal(lock.ok, true);
  try {
    await readPrivateCliRuntimeConfig({
      CODEFLOWAI_CLI_RUNTIME_ROOT: runtimeRoot,
      CODEFLOWAI_CLI_NPM_CLI: path.join(root, "npm", "npm-cli.js"),
      CODEFLOWAI_CLI_RUNTIME_MANIFEST: manifestPath,
    } as NodeJS.ProcessEnv, "req-lock");
  } finally {
    if (lock.ok) lock.release();
  }
  // 安装锁持有期间不能消费正在替换的 .previous 目录。
  assert.equal(readPrivateCliRuntimeEntry(runtimeRoot, "codex"), null);
  assert.equal((await fs.readdir(runtimeRoot)).some(name => name.startsWith(".previous-codex-")), true);
});

test("stale previous directories are removed only when the live runtime is valid", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await installPrivateCli({ root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-live",
    attempts: officialAttempt() });
  assert.equal(first.success, true, first.error ?? "");
  const stale = await writePreviousRuntime(root, 2 * 60 * 60 * 1000);
  const second = await installPrivateCli({ root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-cleanup",
    attempts: officialAttempt() });
  assert.equal(second.success, true, second.error ?? "");
  await assert.rejects(fs.access(stale), { code: "ENOENT" });
});

test("previous directory cleanup failure is logged but does not fail the install", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-install-cleanup-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await installPrivateCli({ root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-live-busy",
    attempts: officialAttempt() });
  assert.equal(first.success, true, first.error ?? "");
  const stale = await writePreviousRuntime(root, 2 * 60 * 60 * 1000);
  const rm = fs.rm.bind(fs);
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (path.resolve(String(args[0])) === path.resolve(stale)) {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    }
    return rm(...args);
  });
  const second = await installPrivateCli({ root, engine: "codex", manifest, npmCliPath: fixtureNpmCli, requestId: "req-busy",
    attempts: officialAttempt() });
  assert.equal(second.success, true, second.error ?? "");
  assert.equal(readPrivateCliRuntimeEntry(root, "codex")?.version, "0.166.0");
  await fs.access(stale);
});
