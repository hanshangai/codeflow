import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildClientUpgradeCommand,
  buildClientOfflineUpgradeCommand,
  buildClientUpgradeNpmArgs,
  buildClientUpgradeNpmEnv,
  buildNpmInstallArgs,
  buildNpmInstallAttemptPlan,
  buildNpmInstallEnv,
  isCurrentClientNpmGlobalInstall,
  normalizeNpmInstallNetwork,
  pinClientUpgradeNpmPrefix,
  resolveClaudeNativePackageName,
  resolveClientUpgradeEntryVerdict,
  resolveClientUpgradeInstallTarget,
  resolveNpmGlobalPrefixResult,
  shouldUseDetachedWindowsClientUpgrade,
  shouldUseSudoForGlobalInstall,
} from "../src/app/handlers/softwareUpdateHandlers.ts";

test("normalizeNpmInstallNetwork 默认使用 auto 模式", () => {
  const result = normalizeNpmInstallNetwork(undefined);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.network, { mode: "auto", proxyUrl: null });
});

test("normalizeNpmInstallNetwork 校验代理模式必须填写代理", () => {
  const result = normalizeNpmInstallNetwork({ mode: "proxyOfficial", proxyUrl: "" });

  assert.equal(result.ok, false);
});

test("normalizeNpmInstallNetwork 拒绝未知安装源", () => {
  const result = normalizeNpmInstallNetwork({ mode: "unknown" });

  assert.equal(result.ok, false);
});

test("buildNpmInstallAttemptPlan 按 auto fallback 顺序生成尝试源", () => {
  assert.deepEqual(
    buildNpmInstallAttemptPlan({ mode: "auto", proxyUrl: "http://127.0.0.1:7890" }),
    ["npmmirror", "official", "proxyOfficial"],
  );
  assert.deepEqual(
    buildNpmInstallAttemptPlan({ mode: "auto", proxyUrl: null }),
    ["npmmirror", "official"],
  );
});

test("buildNpmInstallEnv 对官方源禁用镜像 tarball 重写", () => {
  const env = buildNpmInstallEnv("official", null, {});

  assert.equal(env.npm_config_registry, "https://registry.npmjs.org/");
  assert.equal(env.npm_config_replace_registry_host, "never");
  assert.equal(env.npm_config_disturl, "https://nodejs.org/download/release");
  assert.equal(env.npm_config_include, "optional");
  assert.equal(env.npm_config_audit, "false");
  assert.equal(env.npm_config_fund, "false");
});

test("buildNpmInstallEnv 对代理官方源注入临时代理变量", () => {
  const env = buildNpmInstallEnv("proxyOfficial", "http://127.0.0.1:7890", { NO_PROXY: "example.test" });

  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.npm_config_proxy, "http://127.0.0.1:7890");
  assert.equal(env.npm_config_https_proxy, "http://127.0.0.1:7890");
  assert.equal(env.npm_config_registry, "https://registry.npmjs.org/");
  assert.equal(env.npm_config_replace_registry_host, "never");
  assert.equal(env.npm_config_disturl, "https://nodejs.org/download/release");
  assert.ok(String(env.NO_PROXY).includes("example.test"));
  assert.ok(String(env.NO_PROXY).includes("127.0.0.1"));
});

test("buildClientUpgradeNpmEnv 自升级移除废弃配置且保留 server tgz host", () => {
  const env = buildClientUpgradeNpmEnv({
    npm_config_disturl: "https://npm.taobao.org/dist",
    npm_config_optional: "true",
  });

  assert.equal(env.npm_config_registry, "https://registry.npmmirror.com");
  assert.equal(env.npm_config_disturl, undefined);
  assert.equal(env.npm_config_optional, undefined);
  assert.equal(env.npm_config_include, "optional");
  assert.equal(env.npm_config_replace_registry_host, "never");
});

test("POSIX 托管 Client 缺失或继承错误 prefix 时，升级探测与安装环境使用实际目录", async (t) => {
  const { root, prefix, entry } = createManagedInstallFixture(t);
  const nodePrefix = path.join(root, ".local", "opt", "node-v22.23.2-darwin-x64");
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, HOME: root };
  for (const key of Object.keys(baseEnv)) {
    if (key.toLowerCase() === "npm_config_prefix") delete baseEnv[key];
  }
  for (const overrides of [{}, { npm_config_prefix: nodePrefix, NPM_CONFIG_PREFIX: nodePrefix }]) {
    const originalEnv = { ...baseEnv, ...overrides };
    const env = buildClientUpgradeNpmEnv(originalEnv, entry);
    assert.equal(env.npm_config_prefix, prefix);
    assert.equal(env.NPM_CONFIG_PREFIX, prefix);
    assert.equal(originalEnv.npm_config_prefix, overrides.npm_config_prefix);
    const result = await resolveNpmGlobalPrefixResult(env);
    assert.equal(result.error, null);
    assert.equal(result.prefix, prefix);
    assert.deepEqual(resolveClientUpgradeEntryVerdict(result.prefix, result.error, entry), { allowed: true });
  }
});

test("本地源码入口不借用已安装托管 Client 的 prefix，继续拒绝升级", (t) => {
  const { root, prefix } = createManagedInstallFixture(t);
  const entry = path.join(root, "source", "apps", "desktop", "client", "bin", "codeflow.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, "");
  const env = buildClientUpgradeNpmEnv({ HOME: root, npm_config_prefix: prefix }, entry);
  assert.equal(env.npm_config_prefix, prefix);
  assert.equal(env.NPM_CONFIG_PREFIX, undefined);
  assert.equal(resolveClientUpgradeEntryVerdict(prefix, null, entry).allowed, false);
});

test("托管 Client 入口链接按真实路径识别，其他 npm 安装保留原 prefix", (t) => {
  const { root, prefix, entry } = createManagedInstallFixture(t);
  const linkedPackage = path.join(root, "linked-client");
  symlinkSync(path.dirname(path.dirname(entry)), linkedPackage, process.platform === "win32" ? "junction" : "dir");
  assert.equal(buildClientUpgradeNpmEnv({ HOME: root }, path.join(linkedPackage, "bin", "codeflow.js")).npm_config_prefix, prefix);

  const otherPrefix = path.join(root, "other-npm");
  const otherEntry = path.join(otherPrefix, "lib", "node_modules", "@codeflowai", "client", "bin", "codeflow.js");
  mkdirSync(path.dirname(otherEntry), { recursive: true });
  writeFileSync(otherEntry, "");
  const env = buildClientUpgradeNpmEnv({ HOME: root, npm_config_prefix: otherPrefix }, otherEntry);
  assert.equal(env.npm_config_prefix, otherPrefix);
  assert.equal(env.NPM_CONFIG_PREFIX, undefined);
  assert.deepEqual(resolveClientUpgradeEntryVerdict(otherPrefix, null, otherEntry), { allowed: true });
});

test("托管目录中指向源码的包链接不能获得升级许可", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeflow-linked-upgrade-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, ".codeflowai", "npm-global");
  const sourcePackage = path.join(root, "source-client");
  const scopeDir = path.join(prefix, "lib", "node_modules", "@codeflowai");
  mkdirSync(path.join(sourcePackage, "bin"), { recursive: true });
  writeFileSync(path.join(sourcePackage, "bin", "codeflow.js"), "");
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(sourcePackage, path.join(scopeDir, "client"), process.platform === "win32" ? "junction" : "dir");
  const entry = path.join(scopeDir, "client", "bin", "codeflow.js");
  const env = buildClientUpgradeNpmEnv({ HOME: root }, entry);
  assert.equal(env.npm_config_prefix, undefined);
  assert.equal(resolveClientUpgradeEntryVerdict(prefix, null, entry).allowed, false);
  // 实际调用点用候选判定：指向源码的包链接既无自有前缀证据，也不在探测前缀内，必须继续拒绝。
  const target = resolveClientUpgradeInstallTarget({
    npmGlobalPrefix: prefix, prefixError: null, platform: process.platform, env: { HOME: root }, entryPath: entry,
  });
  if (target.allowed) assert.fail("指向源码的包链接不得获得升级许可");
  assert.equal(target.code, "CLIENT_UPGRADE_REQUIRES_GLOBAL_INSTALL");
});

/** 创建与 macOS/Linux 安装器相同的用户级目录，测试结束后清理。 */
function createManagedInstallFixture(t: TestContext): { root: string; prefix: string; entry: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeflow-managed-upgrade-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, ".codeflowai", "npm-global");
  const entry = path.join(prefix, "lib", "node_modules", "@codeflowai", "client", "bin", "codeflow.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, "");
  return { root, prefix, entry };
}

test("resolveClaudeNativePackageName 解析 Claude Code 平台 optional 包", () => {
  assert.equal(resolveClaudeNativePackageName("win32", "x64"), "@anthropic-ai/claude-code-win32-x64");
  assert.equal(resolveClaudeNativePackageName("linux", "arm64"), "@anthropic-ai/claude-code-linux-arm64");
  assert.equal(resolveClaudeNativePackageName("darwin", "arm64"), "@anthropic-ai/claude-code-darwin-arm64");
  assert.equal(resolveClaudeNativePackageName("freebsd", "x64"), null);
});

test("buildNpmInstallArgs 显式启用 optional 依赖", () => {
  assert.deepEqual(
    buildNpmInstallArgs("@anthropic-ai/claude-code"),
    ["install", "-g", "@anthropic-ai/claude-code", "--include=optional", "--no-audit", "--no-fund"],
  );
});

test("buildClientUpgradeNpmArgs 自升级不再传入 npm 11 废弃的 disturl", () => {
  assert.deepEqual(
    buildClientUpgradeNpmArgs("http://127.0.0.1/codeflow.tgz"),
    [
      "install",
      "-g",
      "--force",
      "--registry=https://registry.npmmirror.com",
      "--replace-registry-host=never",
      "http://127.0.0.1/codeflow.tgz",
      "--include=optional",
      "--no-audit",
      "--no-fund",
    ],
  );
});

test("CLI 离线升级只接受本地绝对路径并显式启用 offline 和安装校验脚本", () => {
  for (const [platform, archive] of [["linux", "/tmp/package with spaces/client.tgz"], ["darwin", "/tmp/中文包/client.tgz"], ["win32", "C:\\Temp\\O'Hara test\\client.tgz"]]) {
    const command = buildClientOfflineUpgradeCommand(archive, platform, {});
    assert.ok(command.args.includes(archive));
    assert.ok(command.args.includes("--offline"));
    assert.ok(command.args.includes("--ignore-scripts=false"));
    assert.ok(command.args.includes("--update-notifier=false"));
    assert.equal(command.command, platform === "win32" ? "npm" : "sudo");
  }
  assert.throws(() => buildClientOfflineUpgradeCommand("https://example.com/client.tgz", "linux", {}), /本地绝对路径/);
  assert.throws(() => buildClientOfflineUpgradeCommand("relative.tgz", "win32", {}), /本地绝对路径/);
});

test("Windows Client 自升级使用 detached 路径释放原生 DLL", () => {
  assert.equal(shouldUseDetachedWindowsClientUpgrade("windows"), true);
  assert.equal(shouldUseDetachedWindowsClientUpgrade("linux"), false);
  assert.equal(shouldUseDetachedWindowsClientUpgrade("mac"), false);
});

test("Windows 一键升级只允许 npm 全局 prefix 内的 Client 入口", () => {
  const prefix = path.resolve("test-fixtures", "npm-global");
  const globalEntry = path.join(prefix, "node_modules", "@codeflowai", "client", "bin", "codeflow.js");
  const localEntry = path.resolve("apps", "desktop", "client", "src", "index.ts");

  assert.equal(isCurrentClientNpmGlobalInstall(prefix, globalEntry), true);
  assert.equal(isCurrentClientNpmGlobalInstall(prefix, localEntry), false);
  assert.equal(isCurrentClientNpmGlobalInstall(null, globalEntry), false);
});

test("Windows NVM 全局 prefix 链接与真实入口应判定为同一安装", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "codeflow-nvm-prefix-"));
  const actualPrefix = path.join(fixtureRoot, "nvm", "v24.18.0");
  const linkedPrefix = path.join(fixtureRoot, "nodejs");
  const globalEntry = path.join(actualPrefix, "node_modules", "@codeflowai", "client", "bin", "codeflow.js");

  try {
    mkdirSync(path.dirname(globalEntry), { recursive: true });
    writeFileSync(globalEntry, "");
    symlinkSync(actualPrefix, linkedPrefix, process.platform === "win32" ? "junction" : "dir");

    assert.equal(isCurrentClientNpmGlobalInstall(linkedPrefix, globalEntry), true);
    assert.deepEqual(resolveClientUpgradeEntryVerdict(linkedPrefix, null, globalEntry), { allowed: true });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("升级入口判定在探测值漂移时按入口自有前缀放行并回传安装目标", () => {
  const prefix = createInstalledNpmPrefixFixture();
  try {
    const entry = path.join(prefix, "node_modules", "@codeflowai", "client", "bin", "codeflow.js");
    // 报障形态：探测值被私有 launcher 注入的 npm_config_prefix 或 nvm 版本切换污染到别处。
    const drifted = `${prefix}-other-node-version`;
    const target = resolveClientUpgradeInstallTarget({
      npmGlobalPrefix: drifted, prefixError: null, platform: process.platform, env: { ...process.env }, entryPath: entry,
    });
    assert.deepEqual(target, { allowed: true, npmGlobalPrefix: prefix });
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test("升级入口判定仍拒绝没有磁盘归属证据的源码入口", (t) => {
  const { root, prefix } = createManagedInstallFixture(t);
  const entry = path.join(root, "source", "apps", "desktop", "client", "bin", "codeflow.js");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, "");

  const refused = resolveClientUpgradeInstallTarget({
    npmGlobalPrefix: prefix, prefixError: null, platform: process.platform, env: { HOME: root }, entryPath: entry,
  });
  if (refused.allowed) assert.fail("源码入口不得获得升级许可");
  assert.equal(refused.code, "CLIENT_UPGRADE_REQUIRES_GLOBAL_INSTALL");
  assert.deepEqual(refused.candidates, [prefix]);

  // prefix 探测失败属于环境故障：候选不命中时必须回报真实原因，且不得伪装成“本地源码运行”。
  const unresolved = resolveClientUpgradeInstallTarget({
    npmGlobalPrefix: null, prefixError: "npm config get prefix timeout", platform: process.platform, env: { HOME: root }, entryPath: entry,
  });
  if (unresolved.allowed) assert.fail("prefix 探测失败时必须拒绝升级");
  assert.equal(unresolved.code, "CLIENT_UPGRADE_PREFIX_UNRESOLVED");
  assert.match(unresolved.message, /npm config get prefix timeout/);
});

test("pinClientUpgradeNpmPrefix 显式钉住安装目标且不改写入参", () => {
  const base = { PATH: "/usr/bin", npm_config_prefix: "/opt/polluted" };
  const pinned = pinClientUpgradeNpmPrefix(base, "/usr/local");
  assert.deepEqual(pinned, {
    PATH: "/usr/bin",
    npm_config_prefix: "/usr/local",
    NPM_CONFIG_PREFIX: "/usr/local",
  });
  assert.equal(base.npm_config_prefix, "/opt/polluted");
  assert.equal(base.NPM_CONFIG_PREFIX, undefined);
});

/** 造出「某前缀下确有 Client 安装」的磁盘证据：包目录、包名与 npm 生成的命令 shim。 */
function createInstalledNpmPrefixFixture(): string {
  const prefix = mkdtempSync(path.join(os.tmpdir(), "codeflow-upgrade-prefix-"));
  const packageDir = path.join(prefix, "node_modules", "@codeflowai", "client");
  mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@codeflowai/client" }));
  writeFileSync(path.join(packageDir, "bin", "codeflow.js"), "");
  const shim = process.platform === "win32" ? path.join(prefix, "codeflow.cmd") : path.join(prefix, "bin", "codeflow");
  mkdirSync(path.dirname(shim), { recursive: true });
  writeFileSync(shim, "npm shim");
  return prefix;
}

test("升级入口判定必须区分 prefix 探测失败与确认非全局入口", () => {
  const prefix = path.resolve("test-fixtures", "npm-global");
  const globalEntry = path.join(prefix, "node_modules", "@codeflowai", "client", "bin", "codeflow.js");
  const localEntry = path.resolve("apps", "desktop", "client", "src", "index.ts");

  assert.deepEqual(resolveClientUpgradeEntryVerdict(prefix, null, globalEntry), { allowed: true });

  // prefix 探测失败属于环境故障，必须报出真实原因，不得降级成“非全局入口”结论
  const unresolved = resolveClientUpgradeEntryVerdict(null, "npm config get prefix timeout", globalEntry);
  if (unresolved.allowed) assert.fail("prefix 探测失败时必须拒绝升级");
  assert.equal(unresolved.code, "CLIENT_UPGRADE_PREFIX_UNRESOLVED");
  assert.match(unresolved.message, /npm config get prefix timeout/);

  const nonGlobal = resolveClientUpgradeEntryVerdict(prefix, null, localEntry);
  if (nonGlobal.allowed) assert.fail("非全局入口必须拒绝升级");
  assert.equal(nonGlobal.code, "CLIENT_UPGRADE_REQUIRES_GLOBAL_INSTALL");
});

test("shouldUseSudoForGlobalInstall 仅 macOS/Linux 需要 sudo", () => {
  assert.equal(shouldUseSudoForGlobalInstall("darwin"), true);
  assert.equal(shouldUseSudoForGlobalInstall("mac"), true);
  assert.equal(shouldUseSudoForGlobalInstall("linux", {}), true);
  assert.equal(shouldUseSudoForGlobalInstall("win32"), false);
});

test("buildClientUpgradeCommand 为系统级 macOS/Linux 自升级前置 sudo", () => {
  assert.deepEqual(
    buildClientUpgradeCommand("http://127.0.0.1/codeflow.tgz", "linux", {}),
    {
      command: "sudo",
      args: ["npm", ...buildClientUpgradeNpmArgs("http://127.0.0.1/codeflow.tgz")],
    },
  );
  assert.deepEqual(
    buildClientUpgradeCommand("http://127.0.0.1/codeflow.tgz", "linux", {
      HOME: "/home/dev",
      NVM_DIR: "/home/dev/.nvm",
      npm_config_prefix: "/home/dev/.nvm/versions/node/v22.23.1",
    }),
    {
      command: "npm",
      args: buildClientUpgradeNpmArgs("http://127.0.0.1/codeflow.tgz"),
    },
  );
  assert.deepEqual(
    buildClientUpgradeCommand(
      "http://127.0.0.1/codeflow.tgz",
      "linux",
      { HOME: "/home/dev" },
      {
        nodeExecPath: "/home/dev/.nvm/versions/node/v22.23.1/bin/node",
        entrypointPath: "/home/dev/.nvm/versions/node/v22.23.1/bin/codeflow",
      },
    ),
    {
      command: "npm",
      args: buildClientUpgradeNpmArgs("http://127.0.0.1/codeflow.tgz"),
    },
  );
  assert.deepEqual(
    buildClientUpgradeCommand("http://127.0.0.1/codeflow.tgz", "win32", {}),
    {
      command: "npm",
      args: buildClientUpgradeNpmArgs("http://127.0.0.1/codeflow.tgz"),
    },
  );
});
