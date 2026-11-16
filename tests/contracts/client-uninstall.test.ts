import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveEntryOwnedNpmPrefix } from "../../apps/desktop/client/src/app/clientInstallEntry.ts";
import {
  assertClientUninstallCompleted,
  clientUninstallManualHints,
  ClientUninstallError,
  ClientUninstallLifecycleError,
  removeNpmrcPrefix,
  removeShellPathEntries,
  resolveClientUninstallEntryVerdict,
  resolveClientUninstallPlan,
  runClientUninstallCleanup,
  runPosixClientUninstall,
  shellProfileEntryVariants,
  type ClientUninstallCommand,
  type ClientUninstallPlan,
} from "../../apps/desktop/client/src/update/clientUninstall.ts";

/** 用临时 HOME 承载同一份卸载清单所需的程序与数据路径，覆盖两平台的真实布局。 */
function createFixtureHome(): { home: string; plan: ClientUninstallPlan } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-home-"));
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-local-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: localAppData };
  const managedRoot = process.platform === "win32"
    ? path.join(localAppData, "CodeFlowAI")
    : path.join(home, ".codeflowai");
  const npmGlobalPrefix = process.platform === "win32"
    ? path.join(managedRoot, "npm")
    : path.join(managedRoot, "npm-global");
  return { home, plan: resolveClientUninstallPlan({ npmGlobalPrefix, platform: process.platform, env }) };
}

/** 用目录链接替代文件符号链接，Windows 未开启开发者模式时也能建立。 */
function tryCreateDirectoryLink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, "junction");
    return fs.lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 在临时目录造出「某个 npm 全局前缀下确有一份 Client 安装」的磁盘证据：包目录 + 包名 + npm 生成的命令 shim。
 * 层级用本机原生分隔符；`libForm` 追加 POSIX 的 `lib` 一层，用于验证剥离逻辑。
 */
function createInstalledNpmPrefixFixture(options?: { libForm?: boolean }): { prefix: string; entry: string; packageDir: string } {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-prefix-"));
  const packageDir = path.join(prefix, ...(options?.libForm ? ["lib"] : []), "node_modules", "@codeflowai", "client");
  const entry = path.join(packageDir, "bin", "codeflow.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@codeflowai/client" }));
  fs.writeFileSync(entry, "");
  const shim = commandShimPath(prefix);
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, "npm shim");
  return { prefix, entry, packageDir };
}

/** npm 在全局前缀下生成的命令 shim 路径，两平台布局不同。 */
function commandShimPath(prefix: string): string {
  return process.platform === "win32" ? path.join(prefix, "codeflow.cmd") : path.join(prefix, "bin", "codeflow");
}

/** 铺开「程序」与「数据」两组路径，卸载后只允许前者消失。 */
function seedFixture(plan: ClientUninstallPlan): void {
  fs.mkdirSync(plan.packageDir, { recursive: true });
  fs.writeFileSync(path.join(plan.packageDir, "package.json"), "{}");
  for (const commandPath of plan.npmCommandPaths) {
    fs.mkdirSync(path.dirname(commandPath), { recursive: true });
    fs.writeFileSync(commandPath, "npm shim");
  }
  for (const launcher of plan.launcherPaths) {
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "launcher");
  }
  for (const preserved of plan.preservedPaths) {
    fs.mkdirSync(preserved, { recursive: true });
    fs.writeFileSync(path.join(preserved, "keep.bin"), "keep");
  }
  fs.mkdirSync(plan.dataDir, { recursive: true });
  fs.writeFileSync(path.join(plan.dataDir, "config.json"), '{"keep":true}');
  fs.writeFileSync(path.join(plan.dataDir, "client.db"), "sqlite");
}

test("resolveClientUninstallPlan keeps POSIX program dirs separate from user data", () => {
  const plan = resolveClientUninstallPlan({
    npmGlobalPrefix: "/home/u/.codeflowai/npm-global",
    platform: "linux",
    env: { HOME: "/home/u" },
  });
  assert.equal(plan.dataDir, "/home/u/.codeflowai");
  assert.equal(plan.packageDir, "/home/u/.codeflowai/npm-global/lib/node_modules/@codeflowai/client");
  assert.deepEqual(plan.launcherPaths, ["/home/u/.codeflowai/bin/codeflow"]);
  assert.deepEqual(plan.pathEntries, ["/home/u/.codeflowai/bin", "/home/u/.codeflowai/npm-global/bin"]);
  assert.deepEqual(plan.stableCommandLinks, ["/home/u/.local/bin/codeflow"]);
  assert.deepEqual(plan.preservedPaths, ["/home/u/.codeflowai/runtime"]);
  assert.ok(plan.preservedPaths.includes("/home/u/.codeflowai/runtime"));
});

test("resolveClientUninstallPlan keeps macOS free of Linux-only leftovers and hints", () => {
  const plan = resolveClientUninstallPlan({
    npmGlobalPrefix: "/Users/u/.codeflowai/npm-global",
    platform: "darwin",
    env: { HOME: "/Users/u" },
  });
  assert.equal(plan.platform, "darwin");
  assert.deepEqual(plan.stableCommandLinks, []);
  assert.deepEqual(clientUninstallManualHints(plan), ["用户数据与配置已保留：/Users/u/.codeflowai"]);

  const linuxPlan = resolveClientUninstallPlan({
    npmGlobalPrefix: "/home/u/.codeflowai/npm-global",
    platform: "linux",
    env: { HOME: "/home/u" },
  });
  assert.equal(clientUninstallManualHints(linuxPlan).length, 2);
});

test("resolveClientUninstallPlan never reclaims a system npm bin directory", () => {
  const plan = resolveClientUninstallPlan({
    npmGlobalPrefix: "/usr/local",
    platform: "linux",
    env: { HOME: "/home/u" },
  });
  // 系统级前缀安装不动托管目录：那里的启动器与 PATH 条目可能属于另一套私有安装。
  assert.deepEqual(plan.pathEntries, []);
  assert.equal(plan.managedArtifactsSkipped, true);
  assert.equal(plan.packageDir, "/usr/local/lib/node_modules/@codeflowai/client");
});

test("resolveClientUninstallPlan covers both Windows install shapes", () => {
  const env = { USERPROFILE: "C:\\Users\\u", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  const systemPlan = resolveClientUninstallPlan({
    npmGlobalPrefix: "C:\\Users\\u\\AppData\\Roaming\\npm",
    platform: "win32",
    env,
  });
  assert.equal(systemPlan.dataDir, "C:\\Users\\u\\.codeflowai");
  assert.equal(systemPlan.packageDir, "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@codeflowai\\client");
  assert.deepEqual(systemPlan.launcherPaths, []);
  assert.deepEqual(systemPlan.pathEntries, []);
  assert.equal(systemPlan.managedArtifactsSkipped, true);
  assert.deepEqual(systemPlan.npmCommandPaths, [
    "C:\\Users\\u\\AppData\\Roaming\\npm\\codeflow",
    "C:\\Users\\u\\AppData\\Roaming\\npm\\codeflow.cmd",
    "C:\\Users\\u\\AppData\\Roaming\\npm\\codeflow.ps1",
  ]);
  assert.deepEqual(systemPlan.preservedPaths, [
    "C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\runtime",
    "C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\Git",
    "C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\Installer",
    "C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\npm",
  ]);

  const privatePlan = resolveClientUninstallPlan({
    npmGlobalPrefix: "C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\npm",
    platform: "win32",
    env,
  });
  assert.equal(privatePlan.managedArtifactsSkipped, false);
  assert.deepEqual(privatePlan.launcherPaths, [
    "C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\bin\\codeflow.cmd",
    "C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\bin\\codeflow.ps1",
  ]);
  assert.ok(privatePlan.pathEntries.includes("C:\\Users\\u\\AppData\\Local\\CodeFlowAI\\npm"));
});

test("runClientUninstallCleanup leaves a coexisting private install untouched for a system prefix", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-home-"));
  const systemPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-prefix-"));
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-local-"));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: localAppData };
    const privatePrefix = process.platform === "win32"
      ? path.join(localAppData, "CodeFlowAI", "npm")
      : path.join(home, ".codeflowai", "npm-global");
    const privatePlan = resolveClientUninstallPlan({ npmGlobalPrefix: privatePrefix, platform: process.platform, env });
    seedFixture(privatePlan);

    // 系统级前缀安装：只处理它自己那一份，托管目录下的私有安装整体保留，否则私有安装会变砖且不报错。
    const systemPlan = resolveClientUninstallPlan({ npmGlobalPrefix: systemPrefix, platform: process.platform, env });
    assert.equal(systemPlan.managedArtifactsSkipped, true);
    assert.deepEqual(systemPlan.launcherPaths, []);
    assert.deepEqual(systemPlan.pathEntries, []);
    assert.equal(systemPlan.packageDir.startsWith(systemPrefix), true);

    const report = runClientUninstallCleanup(systemPlan);
    assert.deepEqual(report.removedLaunchers, []);
    for (const launcher of privatePlan.launcherPaths) assert.equal(fs.existsSync(launcher), true);
    assert.equal(fs.existsSync(path.join(privatePlan.packageDir, "package.json")), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(systemPrefix, { recursive: true, force: true });
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
});

test("resolveClientUninstallEntryVerdict refuses non-managed entries without upgrade wording", () => {
  const prefix = path.posix.join("/usr/local");
  const entry = path.posix.join("/home/u", ".codeflowai", "npm-global", "lib", "node_modules", "@codeflowai", "client", "bin", "codeflow.js");
  const check = resolveClientUninstallEntryVerdict(prefix, null, "linux", { HOME: "/home/u" }, entry);
  assert.equal(check.allowed, false);
  assert.equal(check.allowed === false && check.code, "CLIENT_UNINSTALL_REQUIRES_GLOBAL_INSTALL");
  assert.equal(check.allowed === false && /升级/u.test(check.message), false);
  assert.match(check.allowed === false ? check.message : "", /卸载/u);
  // 失败结果必须带回本次试过的候选前缀，日志才能区分“前缀漂移”与“源码运行”。
  assert.deepEqual(check.allowed === false ? check.candidates : [], ["/usr/local"]);
});

test("resolveClientUninstallEntryVerdict reports unresolved prefix instead of guessing", () => {
  const check = resolveClientUninstallEntryVerdict(null, "npm config get prefix 执行失败", "linux", { HOME: "/home/u" }, "/home/u/.codeflowai/bin/codeflow");
  assert.equal(check.allowed, false);
  assert.equal(check.allowed === false && check.code, "CLIENT_UNINSTALL_PREFIX_UNRESOLVED");
});

test("resolveClientUninstallEntryVerdict accepts a managed POSIX entry", () => {
  const home = path.join(os.tmpdir(), "cf-verdict-home");
  const prefix = path.join(home, ".codeflowai", "npm-global");
  const entry = path.join(prefix, "lib", "node_modules", "@codeflowai", "client", "bin", "codeflow.js");
  assert.deepEqual(resolveClientUninstallEntryVerdict(prefix, null, "linux", { HOME: home }, entry), { allowed: true, npmGlobalPrefix: prefix });
});

test("resolveClientUninstallEntryVerdict covers the Windows private launcher shape", () => {
  const localAppData = path.win32.join("C:\\Users\\u\\AppData\\Local");
  const privatePrefix = path.win32.join(localAppData, "CodeFlowAI", "npm");
  const entry = path.win32.join(privatePrefix, "node_modules", "@codeflowai", "client", "bin", "codeflow.js");
  // 绕过 launcher 直接 node 调用时 npm prefix 会落到 %APPDATA%\npm，私有 prefix 候选必须兜住，
  // 且必须回传命中的私有前缀，否则删除清单会按 %APPDATA%\npm 解析出错误包目录并误报卸载成功。
  const check = resolveClientUninstallEntryVerdict(
    path.win32.join("C:\\Users\\u\\AppData\\Roaming\\npm"),
    null,
    "win32",
    { LOCALAPPDATA: localAppData },
    entry,
  );
  assert.deepEqual(check, { allowed: true, npmGlobalPrefix: privatePrefix });
});

test("resolveEntryOwnedNpmPrefix strips the POSIX lib segment and requires full disk evidence", () => {
  const { prefix, entry, packageDir } = createInstalledNpmPrefixFixture({ libForm: true });
  try {
    // 剥离必须落在 <X> 而不是 <X>/lib，否则删除清单会整体错位一层。
    assert.equal(resolveEntryOwnedNpmPrefix(entry, process.platform), prefix);
    assert.equal(resolveEntryOwnedNpmPrefix(path.join(packageDir, "lib", "index.js"), process.platform), null);
    assert.equal(
      resolveEntryOwnedNpmPrefix(path.join(prefix, "node_modules", "@codeflowai", "other", "bin", "codeflow.js"), process.platform),
      null,
    );
    assert.equal(resolveEntryOwnedNpmPrefix(path.join(os.tmpdir(), "aidt-code", "apps", "desktop", "client", "src", "index.ts"), process.platform), null);
    assert.equal(resolveEntryOwnedNpmPrefix("node_modules/@codeflowai/client/bin/codeflow.js", process.platform), null);
    assert.equal(resolveEntryOwnedNpmPrefix("apps/desktop/client/node_modules/@codeflowai/client/bin/codeflow.js", process.platform), null);
    assert.equal(resolveEntryOwnedNpmPrefix(null, process.platform), null);
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test("resolveEntryOwnedNpmPrefix refuses entries missing the npm command shim or the package name", () => {
  const { prefix, entry, packageDir } = createInstalledNpmPrefixFixture();
  try {
    // 工程内 `npm i @codeflowai/client` 有包目录但没有 npm 生成的全局命令 shim，这条是防误删的关键。
    fs.rmSync(commandShimPath(prefix), { force: true });
    assert.equal(resolveEntryOwnedNpmPrefix(entry, process.platform), null);

    fs.writeFileSync(commandShimPath(prefix), "npm shim");
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@codeflowai/other" }));
    assert.equal(resolveEntryOwnedNpmPrefix(entry, process.platform), null);

    fs.rmSync(path.join(packageDir, "package.json"));
    assert.equal(resolveEntryOwnedNpmPrefix(entry, process.platform), null);
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test("resolveEntryOwnedNpmPrefix refuses a package dir that is a link to source", (t) => {
  const { prefix, entry, packageDir } = createInstalledNpmPrefixFixture();
  const linkPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-link-"));
  try {
    const linkPath = path.join(linkPrefix, "node_modules", "@codeflowai", "client");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    if (!tryCreateDirectoryLink(packageDir, linkPath)) {
      t.skip("当前环境不允许创建符号链接");
      return;
    }
    fs.mkdirSync(path.dirname(commandShimPath(linkPrefix)), { recursive: true });
    fs.writeFileSync(commandShimPath(linkPrefix), "npm shim");

    // 包目录是链接即 npm link 或工程内软链，不算独立安装。
    assert.equal(resolveEntryOwnedNpmPrefix(path.join(linkPath, "bin", "codeflow.js"), process.platform), null);
    assert.equal(resolveEntryOwnedNpmPrefix(entry, process.platform), prefix);
  } finally {
    fs.rmSync(linkPrefix, { recursive: true, force: true });
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test("resolveClientUninstallEntryVerdict accepts a real global install whose probe prefix is polluted", () => {
  const { prefix, entry } = createInstalledNpmPrefixFixture();
  try {
    // 报障形态：entry 属某个全局前缀，而探测值被私有 launcher 注入的 npm_config_prefix 污染成私有目录。
    const polluted = path.join(os.tmpdir(), "cf-uninstall-polluted-prefix");
    const check = resolveClientUninstallEntryVerdict(
      polluted,
      null,
      process.platform,
      { ...process.env, LOCALAPPDATA: polluted },
      entry,
    );
    assert.deepEqual(check, { allowed: true, npmGlobalPrefix: prefix });
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test("resolveClientUninstallEntryVerdict keeps a probe hit even when another candidate misses", () => {
  const { prefix, packageDir } = createInstalledNpmPrefixFixture();
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-local-"));
  try {
    // 入口不是包入口文件时反推不出自有前缀，但探测值确实“包含”入口；该命中不得被未命中的候选改写成拒绝。
    const entry = path.join(packageDir, "lib", "index.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "");
    const check = resolveClientUninstallEntryVerdict(
      prefix,
      null,
      process.platform,
      { ...process.env, LOCALAPPDATA: localAppData },
      entry,
    );
    assert.deepEqual(check, { allowed: true, npmGlobalPrefix: prefix });
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true });
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test("resolveClientUninstallEntryVerdict prefers the probe failure over a source-run verdict", () => {
  // npm 探测失败时 Windows 仍有私有 prefix 候选；候选不命中必须回报探测原因，而不是说用户在跑源码。
  const check = resolveClientUninstallEntryVerdict(null, "npm config get prefix 执行失败", "win32", {
    LOCALAPPDATA: path.win32.join("C:\\Users\\u\\AppData\\Local"),
  }, path.win32.join("D:\\code\\aidt-code\\apps\\client\\src\\index.ts"));
  assert.equal(check.allowed, false);
  assert.equal(check.allowed === false && check.code, "CLIENT_UNINSTALL_PREFIX_UNRESOLVED");
  assert.match(check.allowed === false ? check.message : "", /npm config get prefix 执行失败/u);
});

test("removeShellPathEntries removes only the installer block and stays idempotent", () => {
  const binDirs = ["/home/u/.codeflowai/bin", "/home/u/.codeflowai/npm-global/bin"];
  const original = [
    'export PATH="/usr/local/bin:$PATH"',
    "",
    "# CodeFlowAI npm global bin",
    `export PATH="${binDirs[0]}:$PATH"`,
    "",
    "# CodeFlowAI npm global bin",
    `export PATH="${binDirs[1]}:$PATH"`,
    "",
    "alias ll='ls -la'",
    "",
  ].join("\n");

  const first = removeShellPathEntries(original, binDirs);
  assert.equal(first.removed, 2);
  assert.equal(first.content, ['export PATH="/usr/local/bin:$PATH"', "", "alias ll='ls -la'", ""].join("\n"));

  const second = removeShellPathEntries(first.content, binDirs);
  assert.equal(second.removed, 0);
  assert.equal(second.content, first.content);
});

test("removeShellPathEntries preserves mixed line endings byte for byte", () => {
  const original = "export A=1\r\nexport B=2\n\n# CodeFlowAI npm global bin\n"
    + 'export PATH="/home/u/.codeflowai/bin:$PATH"\r\nexport C=3\r\n';
  const result = removeShellPathEntries(original, ["/home/u/.codeflowai/bin"]);
  assert.equal(result.removed, 1);
  assert.equal(result.content, "export A=1\r\nexport B=2\nexport C=3\r\n");
});

test("removeShellPathEntries matches the $HOME literal form the installer writes", () => {
  const content = [
    "export EDITOR=vim",
    "",
    "# CodeFlowAI npm global bin",
    'export PATH="$HOME/.codeflowai/npm-global/bin:$PATH"',
    "",
  ].join("\n");
  const result = removeShellPathEntries(content, ["$HOME/.codeflowai/npm-global/bin"]);
  assert.equal(result.removed, 1);
  assert.equal(result.content, "export EDITOR=vim\n");
});

test("shellProfileEntryVariants expands the managed dirs into the $HOME literal form", () => {
  // 安装器把 NPM_USER_PREFIX、stable_dir、launcher_dir 写成 $HOME 字面量，只按绝对路径匹配会整块漏删。
  assert.deepEqual(
    shellProfileEntryVariants("/home/u/.codeflowai/bin", "/home/u"),
    ["/home/u/.codeflowai/bin", "$HOME/.codeflowai/bin"],
  );
  assert.deepEqual(shellProfileEntryVariants("/usr/local/bin", "/home/u"), ["/usr/local/bin"]);
});

test("runClientUninstallCleanup strips the $HOME literal block of the stable command dir", () => {
  const { home, plan } = createFixtureHome();
  try {
    const profilePath = path.join(plan.homeDir, ".zshrc");
    fs.writeFileSync(profilePath, [
      "export EDITOR=vim",
      "",
      "# CodeFlowAI npm global bin",
      'export PATH="$HOME/.local/bin:$PATH"',
      "",
    ].join("\n"));

    const report = runClientUninstallCleanup({
      ...plan,
      stableCommandLinks: [path.join(plan.homeDir, ".local", "bin", "codeflow")],
    });
    assert.deepEqual(report.strippedProfiles, [profilePath]);
    assert.equal(fs.readFileSync(profilePath, "utf8"), "export EDITOR=vim\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runClientUninstallCleanup removes a link pointing at the system npm prefix", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-home-"));
  const systemPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-prefix-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-outside-"));
  try {
    // 系统级 prefix 可写时安装器不建私有启动器，链接直接指向 <prefix>/bin/codeflow。
    const managedTarget = path.join(systemPrefix, "bin", "codeflow");
    const foreignTarget = path.join(outside, "codeflow");
    fs.mkdirSync(managedTarget, { recursive: true });
    fs.mkdirSync(foreignTarget, { recursive: true });
    const managedLink = path.join(home, "managed-codeflow");
    const foreignLink = path.join(home, "foreign-codeflow");
    if (!tryCreateDirectoryLink(managedTarget, managedLink) || !tryCreateDirectoryLink(foreignTarget, foreignLink)) {
      t.skip("当前环境不允许创建符号链接");
      return;
    }
    // npm uninstall 已删除链接目标，此时链接必须仍被判为托管残留。
    fs.rmSync(managedTarget, { recursive: true, force: true });

    const plan = resolveClientUninstallPlan({
      npmGlobalPrefix: systemPrefix,
      platform: process.platform,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    const report = runClientUninstallCleanup({ ...plan, stableCommandLinks: [managedLink, foreignLink] });

    assert.deepEqual(report.removedStableLinks, [managedLink]);
    assert.equal(fs.existsSync(managedLink), false);
    assert.equal(fs.lstatSync(foreignLink).isSymbolicLink(), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(systemPrefix, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("removeShellPathEntries leaves foreign PATH blocks untouched", () => {
  const content = [
    "# CodeFlowAI npm global bin",
    'export PATH="/other/tool/bin:$PATH"',
    "",
  ].join("\n");
  const result = removeShellPathEntries(content, ["/home/u/.codeflowai/bin"]);
  assert.equal(result.removed, 0);
  assert.equal(result.content, content);
});

test("removeNpmrcPrefix only rolls back the managed prefix", () => {
  const managed = "/home/u/.codeflowai/npm-global";
  const matched = removeNpmrcPrefix(`registry=https://registry.npmjs.org\nprefix=${managed}\n`, managed);
  assert.equal(matched.removed, true);
  assert.equal(matched.content, "registry=https://registry.npmjs.org\n");

  const foreign = removeNpmrcPrefix("prefix=/opt/custom-npm\n", managed);
  assert.equal(foreign.removed, false);
  assert.equal(foreign.mismatchedValue, "/opt/custom-npm");
  assert.equal(foreign.content, "prefix=/opt/custom-npm\n");
});

test("runClientUninstallCleanup deletes programs and scripts but keeps every data path", () => {
  const { home, plan } = createFixtureHome();
  try {
    seedFixture(plan);
    const profilePath = path.join(plan.homeDir, ".zshrc");
    const foreignPath = path.join(plan.homeDir, ".bashrc");
    fs.writeFileSync(profilePath, [
      "export EDITOR=vim",
      "",
      "# CodeFlowAI npm global bin",
      `export PATH="${plan.pathEntries[0]}:$PATH"`,
      "",
    ].join("\n"));
    fs.writeFileSync(foreignPath, "# 用户自有配置\nexport LANG=zh_CN.UTF-8\n");
    const npmrcPath = path.join(plan.homeDir, ".npmrc");
    fs.writeFileSync(npmrcPath, `registry=https://registry.npmjs.org\nprefix=${plan.npmGlobalPrefix}\n`);

    const report = runClientUninstallCleanup(plan);

    assert.deepEqual(report.removedLaunchers, plan.launcherPaths);
    assert.deepEqual(report.strippedProfiles, [profilePath]);
    assert.equal(report.rolledBackNpmrcPrefix, true);
    assert.equal(report.npmrcHint, null);

    for (const launcher of plan.launcherPaths) assert.equal(fs.existsSync(launcher), false);
    assert.equal(fs.readFileSync(profilePath, "utf8"), "export EDITOR=vim\n");
    assert.equal(fs.readFileSync(foreignPath, "utf8"), "# 用户自有配置\nexport LANG=zh_CN.UTF-8\n");
    assert.equal(fs.readFileSync(npmrcPath, "utf8"), "registry=https://registry.npmjs.org\n");

    // npm 未删除的包目录由 npm uninstall 负责，清理步骤不得替它越权删除任何数据。
    assert.equal(fs.existsSync(plan.packageDir), true);
    for (const preserved of plan.preservedPaths) {
      assert.equal(fs.existsSync(path.join(preserved, "keep.bin")), true);
    }
    assert.equal(fs.readFileSync(path.join(plan.dataDir, "config.json"), "utf8"), '{"keep":true}');
    assert.equal(fs.readFileSync(path.join(plan.dataDir, "client.db"), "utf8"), "sqlite");

    const again = runClientUninstallCleanup(plan);
    assert.deepEqual(again.strippedProfiles, []);
    assert.equal(again.rolledBackNpmrcPrefix, false);
    assert.equal(fs.readFileSync(profilePath, "utf8"), "export EDITOR=vim\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runClientUninstallCleanup removes only stable links that point into the managed root", (t) => {
  const { home, plan } = createFixtureHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cf-uninstall-outside-"));
  try {
    const managedLink = path.join(plan.homeDir, "managed-codeflow");
    const foreignLink = path.join(plan.homeDir, "foreign-codeflow");
    // 链接目标位于托管目录内（可能已被 npm 删除），链接本身仍是必须清理的残留。
    const managedTarget = path.join(plan.managedRoot, "bin");
    fs.mkdirSync(managedTarget, { recursive: true });
    if (!tryCreateDirectoryLink(managedTarget, managedLink)
      || !tryCreateDirectoryLink(outside, foreignLink)) {
      t.skip("当前环境不允许创建符号链接");
      return;
    }

    const report = runClientUninstallCleanup({ ...plan, stableCommandLinks: [managedLink, foreignLink] });
    assert.deepEqual(report.removedStableLinks, [managedLink]);
    assert.equal(fs.existsSync(managedLink), false);
    assert.equal(fs.lstatSync(foreignLink).isSymbolicLink(), true);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("assertClientUninstallCompleted lists every leftover instead of reporting success", () => {
  const { home, plan } = createFixtureHome();
  try {
    seedFixture(plan);
    assert.throws(
      () => assertClientUninstallCompleted(plan),
      (error: unknown) => error instanceof ClientUninstallError && error.code === "CLIENT_UNINSTALL_VERIFY_FAILED",
    );

    for (const target of [plan.packageDir, ...plan.npmCommandPaths, ...plan.launcherPaths]) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    assertClientUninstallCompleted(plan);
    assert.equal(fs.existsSync(path.join(plan.dataDir, "client.db")), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runPosixClientUninstall refuses a non-managed entry before any destructive step", () => {
  const calls: string[] = [];
  assert.throws(
    () => runPosixClientUninstall({
      entryCheck: {
        allowed: false,
        code: "CLIENT_UNINSTALL_REQUIRES_GLOBAL_INSTALL",
        message: "入口不在全局安装目录内",
        candidates: ["/tmp/managed-npm"],
      },
      daemonRunning: true,
      preparePrivilege: () => calls.push("auth"),
      run: (args) => { calls.push(args.join(" ")); return { status: 0 }; },
      uninstall: () => calls.push("uninstall"),
      cleanup: () => calls.push("cleanup"),
      verify: () => calls.push("verify"),
    }),
    (error: unknown) => error instanceof ClientUninstallLifecycleError
      && error.stage === "prepare"
      && error.cause instanceof ClientUninstallError
      && error.cause.code === "CLIENT_UNINSTALL_REQUIRES_GLOBAL_INSTALL",
  );
  assert.deepEqual(calls, []);
});

test("runPosixClientUninstall authorizes before stopping and never restarts the daemon on success", () => {
  const calls: string[] = [];
  runPosixClientUninstall({
    entryCheck: { allowed: true, npmGlobalPrefix: "/tmp/managed-npm" },
    daemonRunning: true,
    preparePrivilege: () => calls.push("auth"),
    run: (args) => { calls.push(`codeflow ${args.join(" ")}`); return { status: 0 }; },
    uninstall: () => calls.push("uninstall"),
    cleanup: () => calls.push("cleanup"),
    verify: () => calls.push("verify"),
  });
  assert.deepEqual(calls, ["auth", "codeflow --stop", "uninstall", "cleanup", "verify"]);
});

test("runPosixClientUninstall skips stop when no daemon is running", () => {
  const calls: string[] = [];
  runPosixClientUninstall({
    entryCheck: { allowed: true, npmGlobalPrefix: "/tmp/managed-npm" },
    daemonRunning: false,
    preparePrivilege: () => calls.push("auth"),
    run: (args) => { calls.push(`codeflow ${args.join(" ")}`); return { status: 0 }; },
    uninstall: () => calls.push("uninstall"),
    cleanup: () => calls.push("cleanup"),
    verify: () => calls.push("verify"),
  });
  assert.deepEqual(calls, ["auth", "uninstall", "cleanup", "verify"]);
});

test("runPosixClientUninstall restores the daemon when the package is still installed", () => {
  const calls: string[] = [];
  assert.throws(
    () => runPosixClientUninstall({
      entryCheck: { allowed: true, npmGlobalPrefix: "/tmp/managed-npm" },
      daemonRunning: true,
      preparePrivilege: () => calls.push("auth"),
      run: (args) => { calls.push(`codeflow ${args.join(" ")}`); return { status: 0 }; },
      uninstall: () => { calls.push("uninstall"); throw new Error("npm uninstall 退出码: 1"); },
      cleanup: () => calls.push("cleanup"),
      verify: () => calls.push("verify"),
    }),
    (error: unknown) => error instanceof ClientUninstallLifecycleError && error.stage === "uninstall"
      && error.recoveryError === undefined,
  );
  assert.deepEqual(calls, ["auth", "codeflow --stop", "uninstall", "codeflow --daemon"]);
});

test("runPosixClientUninstall never rolls back after the package is removed", () => {
  const calls: string[] = [];
  const run: ClientUninstallCommand = (args) => { calls.push(`codeflow ${args.join(" ")}`); return { status: 0 }; };
  assert.throws(
    () => runPosixClientUninstall({
      entryCheck: { allowed: true, npmGlobalPrefix: "/tmp/managed-npm" },
      daemonRunning: true,
      preparePrivilege: () => calls.push("auth"),
      run,
      uninstall: () => calls.push("uninstall"),
      cleanup: () => { calls.push("cleanup"); throw new Error("写入 shell 配置失败"); },
      verify: () => calls.push("verify"),
    }),
    (error: unknown) => error instanceof ClientUninstallLifecycleError && error.stage === "cleanup"
      && error.recoveryError === undefined,
  );
  assert.deepEqual(calls, ["auth", "codeflow --stop", "uninstall", "cleanup"]);
});

test("runPosixClientUninstall records a failed recovery without turning it into success", () => {
  const calls: string[] = [];
  assert.throws(
    () => runPosixClientUninstall({
      entryCheck: { allowed: true, npmGlobalPrefix: "/tmp/managed-npm" },
      daemonRunning: true,
      preparePrivilege: () => calls.push("auth"),
      run: (args) => {
        calls.push(`codeflow ${args.join(" ")}`);
        return args[0] === "--daemon" ? { status: 1 } : { status: 0 };
      },
      uninstall: () => { throw new Error("npm uninstall 退出码: 1"); },
      cleanup: () => calls.push("cleanup"),
      verify: () => calls.push("verify"),
    }),
    (error: unknown) => error instanceof ClientUninstallLifecycleError && error.stage === "uninstall"
      && error.recoveryError instanceof Error,
  );
  assert.deepEqual(calls, ["auth", "codeflow --stop", "codeflow --daemon"]);
});
