import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileFunction } from "node:vm";
import { formatDesktopVersion } from "@codeflowai/shared";
import { assertTrustedReleaseKeys, verifyReleaseBundlePayload, readReleaseBundleFiles, computeReleaseDirectorySha256, computeReleasePackageSha256, signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import { createBuilderProject, removeBuilderProject, toBuilderVersion } from "../scripts/package-local-builder.mjs";
import { createDesktopReleasePlan, readDesktopReleasePlan } from "../../../tools/release/desktop-release-plan.mjs";
import { readDesktopShellInputs } from "../../../tools/release/desktop-shell-version.mjs";

const script = await fs.readFile(new URL("../scripts/package-local-win.mjs", import.meta.url), "utf8");
const builderEntry = createRequire(import.meta.url).resolve("electron-builder");

/** 基线资源日期对应的对外展示版本，安装包文件名必须与界面一致。 */
function localDisplayVersion() {
  return "1.0.1110";
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** 只创建本测试独占夹具；显式证据目录保留现场，不读取公共 dist 或运行真实 builder。 */
async function fixture(t: TestContext) {
  const base = process.env.CF_DESKTOP_PACKAGE_GUARD_TEST_ROOT ?? os.tmpdir();
  const root = await fs.mkdtemp(path.join(base, "package-input-"));
  if (!process.env.CF_DESKTOP_PACKAGE_GUARD_TEST_ROOT) t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources"), shell = path.join(root, "desktop");
  const files = {
    "resources/client/package.json": "{}", "resources/client/dist/index.cjs": "client",
    "resources/client/dist/desktopUninstallWorker.cjs": "uninstall worker",
    "resources/client/node_modules/dependency/index.js": "dependency", "resources/web/index.html": "web",
    "resources/client/npm/package.json": JSON.stringify({ name: "npm", version: "12.2.2" }),
    "resources/client/npm/bin/npm-cli.js": "npm cli",
    "resources/client/cli-runtime.json": JSON.stringify({ schemaVersion: 1, npm: { version: "12.2.2" }, engines: {} }),
    "resources/release-trust.json": "{}",
    "desktop/dist/main.js": "main", "desktop/dist/preload.cjs": "preload",
    "desktop/build/icon.png": "fixed shell icon",
    "desktop/node_modules/dep/package.json": "{}",
    "desktop/package.json": '{"version":"1.0"}', "desktop/electron-builder.yml": JSON.stringify({ files: ["dist/**", "package.json"],
      nsis: { allowToChangeInstallationDirectory: true }, win: { target: "nsis" }, mac: { target: "dmg" } }),
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
  }
  return { root, resources, shell };
}

/** 执行原完整 CLI；隔离本机 Electron 和 builder 边界，所有写入留在独占夹具。 */
async function runScript(f: Fixture, output: string, input = f.resources, extra: string[] = [], argv = [input, output, ...extra],
  builderResult?: (executable: string) => Promise<string[]>, installedElectronVersion = "45.0.0", nativeFailure?: Error) {
  const state: { argv: string[]; platform: string; env: Record<string, string>; exitCode?: number } = {
    argv: [process.execPath, path.join(f.shell, "scripts/package-local-win.mjs"), ...argv], platform: "win32", env: {},
  };
  const messages: Array<Record<string, unknown>> = [];
  const calls: Array<{ projectDir: string; targets: unknown; publish: string; config: string;
    effectiveOptionComputed?: (options: [Record<string, string>, unknown]) => Promise<boolean> }> = [];
  const manifests: Array<{ version: string; shellVersion: string }> = [];
  const nativeTools: Array<{ outputDir: string; version: string }> = [];
  /** 仅隔离 NSIS 编译；实际资源装配和临时项目清理继续执行原逻辑。 */
  const buildShellSwitch = async (input: { outputDir: string; version: string }) => {
    nativeTools.push(input);
    await fs.mkdir(input.outputDir);
    const executable = path.join(input.outputDir, "shell-switch.exe");
    await fs.writeFile(executable, "native shell switch", "ascii");
    if (nativeFailure) throw nativeFailure;
    return executable;
  };
  /** 目录选择和 PE 校验另有真实测试；此处只隔离构建机依赖并核对打包目标。 */
  const resolveInstalledElectronDist = async (target: { platform: string; arch: string }) => {
    assert.deepEqual(target, { platform: "win32", arch: "x64" });
    return { electronDist: path.join(f.root, "electron-dist"), electronVersion: installedElectronVersion };
  };
  // 隔离 Electron/NSIS 构建；布局钩子仍使用真实文件转换，仅启动器编译以夹具代替。
  const build = async (options: typeof calls[number]) => {
    calls.push(options);
    manifests.push(JSON.parse(await fs.readFile(path.join(options.projectDir, "package.json"), "utf8")));
    await fs.access(path.join(options.projectDir, "node_modules/dep/package.json"));
    const config = JSON.parse(await fs.readFile(options.config, "utf8"));
    const artifactName = String(config.artifactName).replaceAll("${ext}", "exe").replaceAll("${arch}", "x64").replaceAll("${os}", "win");
    const executable = path.join(config.directories.output, (options.targets as string[])[0] === "nsis" ? artifactName : "win-unpacked/CodeFlowAI.exe");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "fixture", "utf8");
    const appOutDir = path.join(config.directories.output, "win-unpacked");
    await fs.mkdir(appOutDir, { recursive: true });
    if ((options.targets as string[])[0] === "nsis") await fs.writeFile(path.join(appOutDir, "CodeFlowAI.exe"), "electron", "ascii");
    await fs.cp(f.resources, path.join(appOutDir, "resources"), { recursive: true });
    const nativeTool = config.extraResources.find((entry: { to: string }) => entry.to === "shell-switch.exe");
    if (nativeTool) await fs.copyFile(nativeTool.from, path.join(appOutDir, "resources/shell-switch.exe"));
    const icon = config.extraResources.find((entry: { to: string }) => entry.to === "shell-icon.png");
    if (icon) await fs.copyFile(icon.from, path.join(appOutDir, "resources/shell-icon.png"));
    await fs.writeFile(path.join(appOutDir, "resources/app.asar"), "application", "ascii");
    if (config.afterSign) {
      assert.equal(config.afterSign, path.join(f.shell, "scripts/windows-install-layout.mjs"));
      const { prepareWindowsInstallLayout } = await import("../scripts/windows-install-layout.mjs");
      const launcherExecutable = path.join(f.root, "fixed-launcher.exe");
      await fs.writeFile(launcherExecutable, "fixed launcher", "ascii");
      await prepareWindowsInstallLayout({ appOutDir, launcherExecutable });
    }
    return builderResult ? await builderResult(executable) : [executable];
  };
  const source = script.replace(/^import .*;\r?\n/gmu, "")
    .replaceAll('import.meta.resolve("electron-builder")', JSON.stringify(pathToFileURL(builderEntry).href))
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(path.join(f.shell, "scripts/package-local-win.mjs")).href));
  const execute = compileFunction(`return (async () => {${source}\n})();`,
    ["fs", "path", "crypto", "createRequire", "fileURLToPath", "build", "Platform", "Arch", "process", "console", "formatDesktopVersion",
      "createBuilderProject", "removeBuilderProject", "resolveInstalledElectronDist", "toBuilderVersion",
      "assertTrustedReleaseKeys", "verifyReleaseBundlePayload", "readDesktopReleasePlan", "readDesktopShellInputs", "buildShellSwitch"]);
  await execute(fs, { ...path, resolve: (...segments: string[]) => path.resolve(f.root, ...segments) }, crypto, createRequire, fileURLToPath, build,
    { WINDOWS: { createTarget: (target: string, arch: number) => [target, arch] } }, { x64: 1 }, state,
    { log: (line: string) => messages.push(JSON.parse(line)), error: (line: string) => messages.push(JSON.parse(line)) }, formatDesktopVersion,
    createBuilderProject, removeBuilderProject, resolveInstalledElectronDist, toBuilderVersion,
    assertTrustedReleaseKeys, verifyReleaseBundlePayload,
    (options: Parameters<typeof readDesktopReleasePlan>[0]) => readDesktopReleasePlan({ ...options, root: fileURLToPath(new URL("../../..", import.meta.url)) }),
    () => readDesktopShellInputs(fileURLToPath(new URL("../../..", import.meta.url))), buildShellSwitch);
  return { state, messages, calls, manifests, nativeTools };
}

test("planned packaging injects the exact allocated shell version and refuses a different installed Electron", async t => {
  const f = await fixture(t), output = path.join(f.root, "planned-output");
  const { file, plan } = await createDesktopReleasePlan({ root: fileURLToPath(new URL("../../..", import.meta.url)),
    platforms: ["win32/x64"], keyId: "fixture", planDir: path.join(f.root, "plans"), allowDirty: true });
  const extra = ["--plan", file, "--allow-dirty"];
  const result = await runScript(f, output, f.resources, extra);
  assert.equal(result.messages[0]?.code, "DESKTOP_LOCAL_PACKAGE_READY");
  assert.equal(result.messages[0]?.shellVersion, plan.shellVersion);
  const installerDefines: Record<string, string> = {};
  assert.ok(result.calls[0]?.effectiveOptionComputed);
  assert.equal(await result.calls[0].effectiveOptionComputed!([installerDefines, {}]), false);
  assert.equal(installerDefines.CODEFLOW_SHELL_VERSION, plan.shellVersion);
  assert.deepEqual({ version: result.manifests[0]?.version, shellVersion: result.manifests[0]?.shellVersion }, { version: `${plan.shellVersion}.0`, shellVersion: plan.shellVersion });
  assert.equal(JSON.parse(await fs.readFile(path.join(f.shell, "package.json"), "utf8")).version, "1.0");
  const wrong = path.join(f.root, "wrong-electron");
  const failure = await runScript(f, wrong, f.resources, extra, [f.resources, wrong, ...extra], undefined, "44.0.0");
  assert.equal(failure.messages[0]?.rootCause, "DESKTOP_SHELL_ELECTRON_LOCK_MISMATCH");
  assert.equal(failure.calls.length, 0);
  await assert.rejects(fs.access(wrong), { code: "ENOENT" });
});

/** 记录真实文件字节和链接目标，不遍历链接，避免把检测本身变成目录复制。 */
async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name), file = path.join(directory, name);
      if (entry.isSymbolicLink()) result[name] = `link:${await fs.readlink(file)}`;
      else if (entry.isDirectory()) { result[name] = "directory"; await visit(name); }
      else result[name] = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
    }
  };
  await visit("");
  return result;
}

/** 相交路径必须写前失败、保留输入字节，并返回带真实目录上下文的唯一错误日志。 */
async function assertOverlapRejected(f: Fixture, output: string, input = f.resources, extraSources: string[] = []) {
  const sources = [f.resources, f.shell, ...extraSources];
  const before = await Promise.all(sources.map(snapshot));
  const result = await runScript(f, output, input);
  assert.deepEqual(await Promise.all(sources.map(snapshot)), before, "packaging must not change its inputs");
  assert.equal(result.state.exitCode, 1);
  assert.equal(result.calls.length, 0);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.code, "DESKTOP_LOCAL_PACKAGE_FAILED");
  assert.equal(result.messages[0]?.rootCause, "DESKTOP_LOCAL_PACKAGE_INPUT_OUTPUT_OVERLAP");
  assert.match(String(result.messages[0]?.requestId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(typeof result.messages[0]?.inputDirectory, "string");
  assert.equal(typeof result.messages[0]?.outputDirectory, "string");
  return result;
}

for (const [name, relative] of [
  ["resource root", "resources"], ["resource parent", "."], ["client output", "resources/client/output"],
  ["web output", "resources/web/output"], ["resource output", "resources/output"],
  ["missing resource descendants", "resources/client/missing/output"],
  ["shell root", "desktop"], ["shell output", "desktop/output"], ["shell dist output", "desktop/dist/output"],
] as const) {
  test(`rejects ${name} before modifying packaging inputs`, async t => {
    const f = await fixture(t);
    await assertOverlapRejected(f, path.join(f.root, relative));
  });
}

test("resolves an output parent junction before writing into resources", async t => {
  const f = await fixture(t), alias = path.join(f.root, "output-alias");
  await fs.symlink(path.join(f.resources, "client"), alias, process.platform === "win32" ? "junction" : "dir");
  const result = await assertOverlapRejected(f, path.join(alias, "output"));
  const resources = await fs.realpath(f.resources);
  assert.equal(result.messages[0]?.inputDirectory, resources);
  assert.equal(result.messages[0]?.outputDirectory, path.join(resources, "client/output"));
});

test("resolves a resource input junction before checking output containment", async t => {
  const f = await fixture(t), alias = path.join(f.root, "input-alias");
  await fs.symlink(f.resources, alias, process.platform === "win32" ? "junction" : "dir");
  await assertOverlapRejected(f, path.join(f.resources, "client/output"), alias);
});

for (const [name, relative] of [["client", "resources/client"], ["web", "resources/web"],
  ["client dependencies", "resources/client/node_modules"], ["shell dist", "desktop/dist"]] as const) {
  test(`protects the actual ${name} input when its root is a junction`, async t => {
    const f = await fixture(t), original = path.join(f.root, relative), actual = path.join(f.root, "actual-input");
    await fs.rename(original, actual);
    await fs.symlink(actual, original, process.platform === "win32" ? "junction" : "dir");
    const result = await assertOverlapRejected(f, path.join(actual, "output"), f.resources, [actual]);
    const source = await fs.realpath(actual);
    assert.equal(result.messages[0]?.inputDirectory, source);
    assert.equal(result.messages[0]?.outputDirectory, path.join(source, "output"));
  });
}

test("allows a separate output with a shared name prefix and preserves the local package contract", async t => {
  const f = await fixture(t), output = path.join(f.root, "resources-copy");
  const before = await Promise.all([f.resources, f.shell].map(snapshot));
  const result = await runScript(f, output);
  assert.equal(result.state.exitCode, undefined);
  assert.equal(result.messages[0]?.code, "DESKTOP_LOCAL_PACKAGE_READY");
  assert.deepEqual(await Promise.all([f.resources, f.shell].map(snapshot)), before);
  assert.equal(await fs.readFile(path.join(output, "win-unpacked/CodeFlowAI.exe"), "utf8"), "fixture");
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.publish, "never");
  assert.deepEqual(result.calls[0]?.targets, ["dir", 1]);
  await assert.rejects(fs.lstat(result.calls[0]!.projectDir), { code: "ENOENT" });
  const config = JSON.parse(await fs.readFile(path.join(output, "local-builder.json"), "utf8"));
  assert.equal(config.extraMetadata.version, "1.0.0", "builder metadata normalizes two-segment shell versions");
  assert.equal(config.electronDist, path.join(f.root, "electron-dist"));
  assert.equal(config.electronVersion, "45.0.0");
  assert.equal(config.extraResources.some((entry: { to: string }) => ["npm", "cli-runtime.json"].includes(entry.to)), false);
  assert.equal(config.npmRebuild, false);
  assert.equal(config.win.signAndEditExecutable, undefined);
  assert.equal(config.win.signExecutable, false);
  assert.equal(result.state.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
});

test("local packaging carries installed update configuration from the fixed shell resources", async t => {
  const f = await fixture(t), output = path.join(f.root, "configured-output");
  const text = JSON.stringify({ serverOrigin: "https://updates.example.test" });
  await fs.writeFile(path.join(f.resources, "desktop-update.json"), text, "utf8");
  const result = await runScript(f, output);
  assert.equal(result.state.exitCode, undefined);
  const config = JSON.parse(await fs.readFile(path.join(output, "local-builder.json"), "utf8"));
  const entry = config.extraResources.find((item: { from: string; filter?: string[] }) => item.from === f.resources && item.filter?.includes("desktop-update.json"));
  assert.ok(entry, "installed configuration must be copied into the shell resource root");
  assert.equal(entry.to, ".");
  assert.equal(await fs.readFile(path.join(f.resources, "desktop-update.json"), "utf8"), text);
});

test("allows an output parent junction that points to an independent directory", async t => {
  const f = await fixture(t), actual = path.join(f.root, "independent"), alias = path.join(f.root, "output-alias");
  await fs.mkdir(actual);
  await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
  const before = await Promise.all([f.resources, f.shell].map(snapshot));
  const result = await runScript(f, path.join(alias, "output"));
  assert.equal(result.state.exitCode, undefined);
  assert.equal(result.messages[0]?.code, "DESKTOP_LOCAL_PACKAGE_READY");
  assert.deepEqual(await Promise.all([f.resources, f.shell].map(snapshot)), before);
  assert.equal(await fs.readFile(path.join(actual, "output/win-unpacked/CodeFlowAI.exe"), "utf8"), "fixture");
});

test("packages local resources without orchestration authorization trust", async t => {
  const f = await fixture(t), output = path.join(f.root, "complete-package");
  const result = await runScript(f, output);
  assert.equal(result.state.exitCode, undefined);
  const config = JSON.parse(await fs.readFile(path.join(output, "local-builder.json"), "utf8"));
  assert.deepEqual(config.extraResources.filter((entry: { to: string }) => entry.to === "orch-asset-trust.json"), []);
});

test("keeps an existing independent output untouched and reports mkdir failure", async t => {
  const f = await fixture(t), output = path.join(f.root, "existing");
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, "marker"), "keep", "utf8");
  const before = await snapshot(f.root);
  const result = await runScript(f, output);
  assert.equal(result.state.exitCode, 1);
  assert.equal(result.calls.length, 0);
  assert.match(String(result.messages[0]?.rootCause), /EEXIST/u);
  assert.equal(result.messages[0]?.inputDirectory, undefined);
  assert.equal(result.messages[0]?.outputDirectory, undefined);
  assert.deepEqual(await snapshot(f.root), before);
});

test("retains nonrecursive output creation for independent missing parent directories", async t => {
  const f = await fixture(t), output = path.join(f.root, "missing/output");
  const before = await snapshot(f.root);
  const result = await runScript(f, output);
  assert.equal(result.state.exitCode, 1);
  assert.equal(result.calls.length, 0);
  assert.match(String(result.messages[0]?.rootCause), /ENOENT/u);
  assert.equal(result.messages[0]?.inputDirectory, undefined);
  assert.equal(result.messages[0]?.outputDirectory, undefined);
  assert.deepEqual(await snapshot(f.root), before);
});

/** 使用原签名与库存算法构造真实 held payload，临时密钥只留测试根之外的内存。 */
async function writeBaselineProof(f: Fixture, markerVersion = 1, version = "2026.11.10.01"): Promise<Buffer> {
  const keys = crypto.generateKeyPairSync("ed25519");
  const client = await fs.readFile(path.join(f.resources, "client/dist/index.cjs"));
  await fs.writeFile(path.join(f.resources, "client/dist/desktop-startup-capability.json"), JSON.stringify({ schemaVersion: 1,
    heldStartupProtocol: markerVersion, clientEntrySha256: crypto.createHash("sha256").update(client).digest("hex") }) + "\n", "utf8");
  const files = await readReleaseBundleFiles(f.resources), webSha256 = computeReleaseDirectorySha256(files, "web"), clientSha256 = computeReleaseDirectorySha256(files, "client");
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: "baseline", version, webVersion: "1", clientVersion: "1",
    protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 96, platform: "win32", arch: "x64", files, webSha256, clientSha256,
    packageSha256: computeReleasePackageSha256(webSha256, clientSha256), archiveSha256: "f".repeat(64), archiveSize: 1,
    createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2021-01-01T00:00:00.000Z", keyId: "fixture" }, keys.privateKey);
  const proof = Buffer.from(JSON.stringify(manifest) + "\n", "utf8");
  await fs.writeFile(path.join(f.resources, "baseline-release-manifest.json"), proof);
  await fs.writeFile(path.join(f.resources, "release-trust.json"), JSON.stringify({ fixture: keys.publicKey.export({ type: "spki", format: "pem" }) }), "utf8");
  return proof;
}

test("standard builder resources include the fixed baseline proof path", async () => {
  const requireBuilderLibrary = createRequire(createRequire(builderEntry).resolve("app-builder-lib")), { load } = requireBuilderLibrary("js-yaml");
  const config = load(await fs.readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  assert.ok(config.extraResources.some((entry: { from: string; to: string }) => entry.from === "dist/resources/baseline-release-manifest.json" && entry.to === "baseline-release-manifest.json"));
});

test("assisted installer exposes directory selection and run-after-finish", async () => {
  const requireBuilderLibrary = createRequire(createRequire(builderEntry).resolve("app-builder-lib")), { load } = requireBuilderLibrary("js-yaml");
  const config = load(await fs.readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  assert.equal(config.productName, "CodeFlow");
  assert.equal(config.win.executableName, "CodeFlowAI");
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(config.nsis.runAfterFinish, true);
});

for (const required of [false, true]) test(`local package carries the same verified baseline proof with explicit requirement ${required}`, async t => {
  const f = await fixture(t), proof = await writeBaselineProof(f), output = path.join(f.root, "output"), before = await snapshot(f.resources);
  const result = await runScript(f, output, f.resources, required ? ["--require-baseline-proof"] : []);
  assert.equal(result.state.exitCode, undefined); assert.equal(result.calls.length, 1);
  const config = JSON.parse(await fs.readFile(result.calls[0]!.config, "utf8"));
  assert.deepEqual(config.extraResources.filter((entry: { to: string }) => entry.to === "baseline-release-manifest.json"),
    [{ from: path.join(await fs.realpath(f.resources), "baseline-release-manifest.json"), to: "baseline-release-manifest.json" }]);
  assert.deepEqual(await fs.readFile(path.join(f.resources, "baseline-release-manifest.json")), proof);
  assert.deepEqual(await snapshot(f.resources), before);
});

test("non-date baseline version falls back to the normalized shell version", async t => {
  const f = await fixture(t), output = path.join(f.root, "output");
  await writeBaselineProof(f, 1, "baseline");
  const result = await runScript(f, output, f.resources, ["--target", "nsis"]);
  assert.equal(result.state.exitCode, undefined);
  assert.equal(result.messages[0]?.displayVersion, "1.0.0");
  assert.equal(result.messages[0]?.installer, path.join(output, "CodeFlowAI-1.0.0-win32-x64.exe"));
});

test("required missing baseline proof fails before creating output or invoking builder", async t => {
  const f = await fixture(t), output = path.join(f.root, "output"), before = await snapshot(f.root);
  const result = await runScript(f, output, f.resources, ["--require-baseline-proof"]);
  assert.equal(result.state.exitCode, 1); assert.equal(result.calls.length, 0);
  assert.equal(result.messages[0]?.rootCause, "DESKTOP_BASELINE_PROOF_REQUIRED");
  await assert.rejects(fs.lstat(output), { code: "ENOENT" }); assert.deepEqual(await snapshot(f.root), before);
});

test("NSIS packaging requires baseline proof without an extra flag before writing output", async t => {
  const f = await fixture(t), output = path.join(f.root, "output"), before = await snapshot(f.root);
  const result = await runScript(f, output, f.resources, ["--target", "nsis"]);
  assert.equal(result.state.exitCode, 1); assert.equal(result.calls.length, 0);
  assert.equal(result.messages[0]?.rootCause, "DESKTOP_BASELINE_PROOF_REQUIRED");
  assert.deepEqual(await snapshot(f.root), before);
});

for (const kind of ["missing", "directory", "hardlink"] as const) test(`packaging rejects ${kind} uninstall worker before writing output`, async t => {
  const f = await fixture(t), output = path.join(f.root, "output"), worker = path.join(f.resources, "client/dist/desktopUninstallWorker.cjs");
  if (kind === "hardlink") await fs.link(worker, path.join(f.root, "worker-alias"));
  else { await fs.unlink(worker); if (kind === "directory") await fs.mkdir(worker); }
  const before = await snapshot(f.root), result = await runScript(f, output);
  assert.equal(result.state.exitCode, 1); assert.equal(result.calls.length, 0);
  assert.equal(result.messages[0]?.rootCause, kind === "missing" ? "DESKTOP_UNINSTALL_WORKER_MISSING" : "DESKTOP_UNINSTALL_WORKER_INVALID");
  assert.deepEqual(await snapshot(f.root), before);
});

for (const invalid of ["signature", "client", "marker", "utf8", "json", "trust", "directory"] as const) test(`invalid optional baseline proof ${invalid} fails before packaging writes`, async t => {
  const f = await fixture(t), output = path.join(f.root, "output");
  await writeBaselineProof(f, invalid === "marker" ? 2 : 1);
  const proofPath = path.join(f.resources, "baseline-release-manifest.json");
  if (invalid === "signature") {
    const manifest = JSON.parse(await fs.readFile(proofPath, "utf8")); manifest.signature = `${manifest.signature[0] === "A" ? "B" : "A"}${manifest.signature.slice(1)}`;
    await fs.writeFile(proofPath, JSON.stringify(manifest), "utf8");
  } else if (invalid === "client") await fs.appendFile(path.join(f.resources, "client/dist/index.cjs"), "tampered", "utf8");
  else if (invalid === "utf8") await fs.writeFile(proofPath, Buffer.from([0xff]));
  else if (invalid === "json") await fs.writeFile(proofPath, "{", "utf8");
  else if (invalid === "trust") await fs.writeFile(path.join(f.resources, "release-trust.json"), "{}", "utf8");
  else if (invalid === "directory") {
    const original = path.join(f.root, "proof.json"); await fs.rename(proofPath, original); await fs.mkdir(proofPath);
  }
  const before = await snapshot(f.root), result = await runScript(f, output);
  assert.equal(result.state.exitCode, 1); assert.equal(result.calls.length, 0); assert.equal(result.messages.length, 1);
  await assert.rejects(fs.lstat(output), { code: "ENOENT" }); assert.deepEqual(await snapshot(f.root), before);
});

test("invalid proof cannot displace the original output containment guard", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.resources, "baseline-release-manifest.json"), "invalid", "utf8");
  await assertOverlapRejected(f, path.join(f.resources, "output"));
});

for (const extra of [["--unknown"], ["--require-baseline-proof", "--require-baseline-proof"]]) test(`unknown packaging arguments fail without writes ${extra.join(" ")}`, async t => {
  const f = await fixture(t), output = path.join(f.root, "output"), before = await snapshot(f.root);
  const result = await runScript(f, output, f.resources, extra);
  assert.equal(result.state.exitCode, 1); assert.equal(result.calls.length, 0);
  await assert.rejects(fs.lstat(output), { code: "ENOENT" }); assert.deepEqual(await snapshot(f.root), before);
});

for (const malformed of ["omitted-output", "missing-output", "missing-input", "leading-flag", "middle-flag", "unknown-output"] as const) {
  test(`misplaced packaging option ${malformed} fails before interpreting paths`, async t => {
    const f = await fixture(t), output = path.join(f.root, "output"), flag = "--require-baseline-proof";
    const argv = malformed === "omitted-output" ? [f.resources, flag] : malformed === "missing-output" ? [f.resources]
      : malformed === "missing-input" ? [flag, output] : malformed === "leading-flag" ? [flag, f.resources, output]
      : malformed === "middle-flag" ? [f.resources, flag, output] : [f.resources, "--unknown"];
    const before = await snapshot(f.root), result = await runScript(f, output, f.resources, [], argv);
    assert.equal(result.state.exitCode, 1); assert.equal(result.calls.length, 0);
    assert.match(String(result.messages[0]?.rootCause), /^用法：package-local-win\.mjs/u);
    assert.deepEqual(await snapshot(f.root), before);
  });
}

test("an explicit relative path can retain an option-like literal output name", async t => {
  const f = await fixture(t), result = await runScript(f, "./--literal-output");
  assert.equal(result.state.exitCode, undefined); assert.equal(result.calls.length, 1);
  assert.equal(await fs.readFile(path.join(f.root, "--literal-output/win-unpacked/CodeFlowAI.exe"), "utf8"), "fixture");
});

for (const [target, options] of [
  ["nsis", ["--target", "nsis"]],
  ["nsis", ["--require-baseline-proof", "--target", "nsis"]],
  ["nsis", ["--target", "nsis", "--require-baseline-proof"]],
  ["dir", ["--target", "dir"]],
] as const) {
  test(`local packaging selects ${target} with ${options.join(" ")}`, async t => {
    const f = await fixture(t), output = path.join(f.root, "output");
    await writeBaselineProof(f);
    const before = await snapshot(f.resources), result = await runScript(f, output, f.resources, [...options]);
    assert.equal(result.state.exitCode, undefined);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.calls[0]!.targets, [target, 1]);
    assert.equal(result.calls[0]!.publish, "never");
    assert.equal(result.nativeTools.length, 1);
    assert.equal(result.nativeTools[0]?.version, "1.0");
    const nativeResource = target === "nsis" ? "win-unpacked/shells/installation/resources/shell-switch.exe" : "win-unpacked/resources/shell-switch.exe";
    assert.equal(await fs.readFile(path.join(output, nativeResource), "ascii"), "native shell switch");
    assert.equal(await fs.readFile(path.join(output, path.dirname(nativeResource), "shell-icon.png"), "ascii"), "fixed shell icon");
    await assert.rejects(fs.access(result.nativeTools[0]!.outputDir), { code: "ENOENT" });
    const config = JSON.parse(await fs.readFile(result.calls[0]!.config, "utf8"));
    assert.equal(config.win.signAndEditExecutable, undefined);
    assert.equal(config.win.signExecutable, false);
    const message = result.messages[0]!;
    assert.equal(message.code, "DESKTOP_LOCAL_PACKAGE_READY");
    assert.equal(message.target, `win32-x64-${target}`);
    assert.equal(message.signed, false); assert.equal(message.published, false);
    if (target === "nsis") {
      assert.equal(await fs.readFile(path.join(output, "win-unpacked/CodeFlowAI.exe"), "ascii"), "fixed launcher");
      assert.equal(await fs.readFile(path.join(output, "win-unpacked/shells/installation/CodeFlowAI.exe"), "ascii"), "electron");
      assert.equal(await fs.readFile(path.join(output, "win-unpacked/shell-launch.ini"), "ascii"),
        "[shell]\r\nschema=1\r\nactive=installation\r\nprevious=\r\nbaseline=installation\r\n");
      assert.equal(config.nsis.runAfterFinish, true);
      assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
      assert.equal(config.artifactName, `CodeFlowAI-${localDisplayVersion()}-win32-x64.\${ext}`);
      assert.equal(message.displayVersion, localDisplayVersion());
      assert.equal(message.executable, undefined);
      assert.equal(message.installer, path.join(output, `CodeFlowAI-${localDisplayVersion()}-win32-x64.exe`));
    } else {
      assert.equal(message.executable, path.join(output, "win-unpacked/CodeFlowAI.exe"));
      assert.equal(config.afterSign, undefined);
      await assert.rejects(fs.access(path.join(output, "win-unpacked/shells")), { code: "ENOENT" });
    }
    assert.deepEqual(await snapshot(f.resources), before);
  });
}

test("native switch compilation failure stops packaging and removes the temporary project", async t => {
  const f = await fixture(t), output = path.join(f.root, "native-failure");
  const result = await runScript(f, output, f.resources, [], [f.resources, output], undefined, "45.0.0", new Error("native compile failed"));
  assert.equal(result.messages[0]?.code, "DESKTOP_LOCAL_PACKAGE_FAILED");
  assert.equal(result.messages[0]?.rootCause, "native compile failed");
  assert.equal(result.calls.length, 0);
  assert.equal(result.nativeTools.length, 1);
  await assert.rejects(fs.access(result.nativeTools[0]!.outputDir), { code: "ENOENT" });
});

for (const invalid of ["none", "multiple", "outside", "missing"] as const) {
  test(`invalid NSIS result ${invalid} fails without publishing success or changing inputs`, async t => {
    const f = await fixture(t), output = path.join(f.root, "output"), options = ["--target", "nsis"];
    await writeBaselineProof(f);
    const before = await Promise.all([f.resources, f.shell].map(snapshot));
    const result = await runScript(f, output, f.resources, options, [f.resources, output, ...options], async executable => {
      if (invalid === "none") return [];
      if (invalid === "multiple") {
        const second = path.join(output, "second.exe");
        await fs.copyFile(executable, second, fs.constants.COPYFILE_EXCL);
        return [executable, second];
      }
      if (invalid === "outside") {
        const outside = path.join(f.root, "outside.exe");
        await fs.copyFile(executable, outside, fs.constants.COPYFILE_EXCL);
        return [outside];
      }
      return [path.join(output, "missing.exe")];
    });
    assert.equal(result.state.exitCode, 1);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0]!.publish, "never");
    assert.equal(result.messages.length, 1);
    const message = result.messages[0]!;
    assert.equal(message.code, "DESKTOP_LOCAL_PACKAGE_FAILED");
    assert.match(String(message.requestId), /^[0-9a-f-]{36}$/u);
    if (invalid === "missing") assert.match(String(message.rootCause), /^ENOENT\b/u);
    else assert.equal(message.rootCause, invalid === "outside" ? "DESKTOP_LOCAL_INSTALLER_OUTSIDE_OUTPUT" : "DESKTOP_LOCAL_INSTALLER_RESULT_INVALID");
    assert.equal(message.installer, undefined);
    assert.equal(message.executable, undefined);
    assert.deepEqual(await Promise.all([f.resources, f.shell].map(snapshot)), before);
  });
}

for (const options of [["--target"], ["--target", "dmg"], ["--target", "nsis", "--target", "nsis"],
  ["--target=nsis"], ["--target", "--require-baseline-proof"], ["--require-baseline-proof", "--require-baseline-proof"]]) {
  test(`invalid package target options fail before writes: ${options.join(" ")}`, async t => {
    const f = await fixture(t), output = path.join(f.root, "output"), before = await snapshot(f.root);
    const result = await runScript(f, output, f.resources, options);
    assert.equal(result.state.exitCode, 1); assert.equal(result.calls.length, 0);
    assert.match(String(result.messages[0]?.rootCause), /^用法：package-local-win\.mjs/u);
    assert.deepEqual(await snapshot(f.root), before);
  });
}
