import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileFunction } from "node:vm";
import { formatDesktopVersion } from "@codeflowai/shared";
import { createBuilderProject, removeBuilderProject, resolveElectronVersion, toBuilderVersion } from "../scripts/package-local-builder.mjs";
import { createDesktopReleasePlan, readDesktopReleasePlan } from "../../../tools/release/desktop-release-plan.mjs";
import { readDesktopShellInputs } from "../../../tools/release/desktop-shell-version.mjs";

const script = await fs.readFile(new URL("../scripts/package-local-mac.mjs", import.meta.url), "utf8");
const builderEntry = createRequire(import.meta.url).resolve("electron-builder");

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** 只建立本测试独占的壳与资源夹具，不读取公共 dist 或运行真实 builder。 */
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "package-mac-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources"), shell = path.join(root, "desktop");
  const files = {
    "resources/client/package.json": "{}", "resources/client/dist/index.cjs": "client",
    "resources/client/dist/desktopUninstallWorker.cjs": "uninstall worker",
    "resources/client/node_modules/dependency/index.js": "dependency", "resources/web/index.html": "web",
    "resources/client/npm/package.json": JSON.stringify({ name: "npm", version: "12.2.2" }),
    "resources/client/npm/bin/npm-cli.js": "npm cli",
    "resources/client/cli-runtime.json": JSON.stringify({ schemaVersion: 1, npm: { version: "12.2.2" }, engines: {} }),
    "resources/release-trust.json": "{}",
    "desktop/dist/main.js": "main", "desktop/dist/preload.cjs": "preload", "desktop/dist/macosUninstallHelper.cjs": "helper",
    "desktop/build/icon.png": "fixed shell icon",
    "desktop/package.json": '{"version":"1.0"}',
    "desktop/electron-builder.yml": JSON.stringify({ files: ["dist/**", "package.json"], mac: { target: "dmg", artifactName: "CodeFlowAI-${version}-${os}-${arch}.${ext}" } }),
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
  }
  return { root, resources, shell };
}

/** 执行原完整 CLI；仅替换 builder 结果与进程平台，所有写入留在独占夹具。 */
async function runScript(f: Fixture, output: string, extra: string[] = []) {
  const state: { argv: string[]; platform: string; arch: string; env: Record<string, string>; exitCode?: number } = {
    argv: [process.execPath, path.join(f.shell, "scripts/package-local-mac.mjs"), f.resources, output, ...extra],
    platform: "darwin", arch: "arm64", env: {},
  };
  const messages: Array<Record<string, unknown>> = [];
  const calls: Array<{ projectDir: string; targets: unknown; publish: string; config: string }> = [];
  const build = async (options: typeof calls[number]) => {
    calls.push(options);
    const config = JSON.parse(await fs.readFile(options.config, "utf8"));
    if ((options.targets as unknown[])[0] === "dmg") {
      const installer = path.join(config.directories.output, "CodeFlowAI-1.0.0-darwin-arm64.dmg");
      await fs.mkdir(path.dirname(installer), { recursive: true });
      await fs.writeFile(installer, "fixture", "utf8");
      return [installer];
    }
    const application = path.join(config.directories.output, "mac-arm64", "CodeFlow.app");
    await fs.mkdir(application, { recursive: true });
    return [application];
  };
  const source = script.replace(/^import .*;\r?\n/gmu, "")
    .replaceAll('import.meta.resolve("electron-builder")', JSON.stringify(pathToFileURL(builderEntry).href))
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(path.join(f.shell, "scripts/package-local-mac.mjs")).href));
  const execute = compileFunction(`return (async () => {${source}\n})();`,
    ["fs", "path", "crypto", "createRequire", "fileURLToPath", "build", "Platform", "Arch", "process", "console",
      "formatDesktopVersion", "createBuilderProject", "removeBuilderProject", "resolveElectronVersion", "toBuilderVersion",
      "assertTrustedReleaseKeys", "verifyReleaseBundlePayload", "readDesktopReleasePlan", "readDesktopShellInputs"]);
  await execute(fs, { ...path, resolve: (...segments: string[]) => path.resolve(f.root, ...segments) }, crypto, createRequire,
    fileURLToPath, build, { MAC: { createTarget: (target: string, arch: number) => [target, arch] } }, { x64: 1, arm64: 2 }, state,
    { log: (line: string) => messages.push(JSON.parse(line)), error: (line: string) => messages.push(JSON.parse(line)) },
    formatDesktopVersion, createBuilderProject, removeBuilderProject, resolveElectronVersion, toBuilderVersion, () => ({}), () => ({}),
    (options: Parameters<typeof readDesktopReleasePlan>[0]) => readDesktopReleasePlan({ ...options, root: fileURLToPath(new URL("../../..", import.meta.url)) }),
    () => readDesktopShellInputs(fileURLToPath(new URL("../../..", import.meta.url))));
  return { state, messages, calls };
}

test("macOS 打包声明最低系统为 Ventura", async () => {
  const requireBuilderLibrary = createRequire(createRequire(builderEntry).resolve("app-builder-lib"));
  const { load } = requireBuilderLibrary("js-yaml");
  const config = load(await fs.readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  assert.equal(config.mac.minimumSystemVersion, "13.0");
});

test("macOS planned packaging consumes the allocated shell version", async t => {
  const f = await fixture(t);
  const { file, plan } = await createDesktopReleasePlan({ root: fileURLToPath(new URL("../../..", import.meta.url)),
    platforms: ["darwin/arm64"], keyId: "fixture", planDir: path.join(f.root, "plans"), allowDirty: true });
  const result = await runScript(f, path.join(f.root, "planned"), ["--plan", file, "--allow-dirty"]);
  assert.equal(result.messages[0]?.code, "DESKTOP_LOCAL_PACKAGE_READY");
  assert.equal(result.messages[0]?.shellVersion, plan.shellVersion);
  const config = JSON.parse(await fs.readFile(result.calls[0]!.config, "utf8"));
  assert.equal(config.extraMetadata.version, `${plan.shellVersion}.0`);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.shell, "package.json"), "utf8")).version, "1.0");
});

test("macOS 本地包拒绝与输入重叠的输出目录", async t => {
  const f = await fixture(t), result = await runScript(f, f.resources);
  assert.equal(result.state.exitCode, 1);
  assert.equal(result.calls.length, 0);
  assert.equal(result.messages[0]?.code, "DESKTOP_LOCAL_PACKAGE_FAILED");
  assert.equal(result.messages[0]?.rootCause, "DESKTOP_LOCAL_PACKAGE_INPUT_OUTPUT_OVERLAP");
});

test("macOS 未签名 dir 包禁用签名并携带本地标记", async t => {
  const f = await fixture(t), output = path.join(f.root, "output");
  const result = await runScript(f, output);
  assert.equal(result.state.exitCode, undefined);
  assert.equal(result.messages[0]?.code, "DESKTOP_LOCAL_PACKAGE_READY");
  assert.equal(result.messages[0]?.target, "darwin-arm64-dir");
  assert.equal(result.messages[0]?.signed, false);
  assert.equal(result.messages[0]?.adhocSigned, true);
  assert.equal(result.messages[0]?.baseline, false);
  const config = JSON.parse(await fs.readFile(result.calls[0]!.config, "utf8"));
  assert.equal(config.mac.identity, null);
  const icon = config.extraResources.find((entry: { to: string }) => entry.to === "shell-icon.png");
  assert.equal(await fs.readFile(icon.from, "ascii"), "fixed shell icon");
  assert.equal(config.mac.hardenedRuntime, false);
  assert.match(String(config.afterPack).replaceAll("\\", "/"), /\/scripts\/packaged-resource-copy\.mjs$/u);
  assert.deepEqual(config.dmg.contents, [
    { x: 130, y: 220 },
    { x: 410, y: 220, type: "link", path: "/Applications" },
  ]);
  assert.ok(config.extraResources.some((entry: { to: string; from: string }) => entry.to === "desktop-unsigned-local.json"
    && entry.from === path.join(output, "desktop-unsigned-local.json")));
  assert.ok(config.extraResources.some((entry: { to: string }) => entry.to === "macosUninstallHelper.cjs"));
});

test("macOS dmg 目标返回唯一安装包", async t => {
  const f = await fixture(t), output = path.join(f.root, "output-dmg");
  const result = await runScript(f, output, ["--target", "dmg"]);
  assert.equal(result.messages[0]?.code, "DESKTOP_LOCAL_PACKAGE_READY");
  assert.equal(result.messages[0]?.target, "darwin-arm64-dmg");
  assert.equal(result.messages[0]?.displayVersion, "1.0.0");
  assert.equal(result.messages[0]?.adhocSigned, true);
  assert.match(String(result.messages[0]?.installer), /CodeFlowAI-1\.0\.0-darwin-arm64\.dmg$/u);
  const config = JSON.parse(await fs.readFile(result.calls[0]!.config, "utf8"));
  assert.equal(config.artifactName, "CodeFlowAI-1.0.0-darwin-${arch}.${ext}");
  assert.equal(config.dmg.title, "CodeFlow 1.0.0");
});
