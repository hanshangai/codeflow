import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { computeReleaseDirectorySha256, computeReleasePackageSha256, readReleaseBundleFiles, signReleaseBundleManifest } from "@codeflowai/shared/desktop-release-signing";
import { createDefaultRoleExecutionConfig, createDefaultRoleExecutionCustomConfig, createDefaultRoleInputDefinition, createDefaultRoleOutputDefinition } from "@codeflowai/shared";

const entry = fileURLToPath(new URL("./electron-real-provider-assets.smoke.mjs", import.meta.url));

/** 动态导入只允许纯离线入口，缺失实现时由用例明确失败。 */
async function driver(): Promise<any> {
  assert.equal(await fs.access(entry).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  }), true, "D07_DRIVER_REQUIRED");
  return import(new URL("./electron-real-provider-assets.smoke.mjs", import.meta.url).href);
}

/** 独占外置占位工件带真实签名清单；不会启动任何应用或网络。 */
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "d07-assets-harness-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = path.join(root, "artifact/resources"), exe = path.join(root, "artifact/CodeFlowAI.exe");
  const files: Record<string, string> = {
    "../CodeFlowAI.exe": "MZ-offline-placeholder", "app.asar": "offline-shell",
    "client/dist/index.cjs": "native-dynamic runtime.submitNodeResult skill-runtime",
    "client/scripts/claude-platform-tools-mcp.cjs": "// offline MCP placeholder",
    "web/index.html": "<!doctype html><title>offline</title>",
  };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(resources, name)), { recursive: true });
    await fs.writeFile(path.join(resources, name), content, "utf8");
  }
  const sha = crypto.createHash("sha256").update(files["client/dist/index.cjs"]!).digest("hex");
  await fs.writeFile(path.join(resources, "client/dist/desktop-startup-capability.json"), JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1, clientEntrySha256: sha }), "utf8");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  await fs.writeFile(path.join(resources, "release-trust.json"), JSON.stringify({ harness: publicKey.export({ format: "pem", type: "spki" }) }), "utf8");
  const inventory = await readReleaseBundleFiles(resources), webSha256 = computeReleaseDirectorySha256(inventory, "web"), clientSha256 = computeReleaseDirectorySha256(inventory, "client");
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: "d07-offline", version: "1.0.0", webVersion: "1.0.0", clientVersion: "1.0.0", protocolVersion: 1,
    capabilityVersion: 1, dbSchemaVersion: 101, platform: "win32", arch: "x64", webSha256, clientSha256,
    packageSha256: computeReleasePackageSha256(webSha256, clientSha256), files: inventory, archiveSha256: "a".repeat(64), archiveSize: 1,
    createdAt: "2026-11-01T00:00:00.000Z", expiresAt: "2099-11-02T00:00:00.000Z", keyId: "harness" }, privateKey);
  await fs.writeFile(path.join(resources, "baseline-release-manifest.json"), JSON.stringify(manifest), "utf8");
  const cli = path.join(root, "claude.cmd"); await fs.writeFile(cli, "@exit /b 99", "utf8");
  const cliPackage = path.join(root, "node_modules/@anthropic-ai/claude-code"); await fs.mkdir(cliPackage, { recursive: true });
  await fs.writeFile(path.join(cliPackage, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "offline", bin: { claude: "cli.js" } }), "utf8");
  await fs.writeFile(path.join(cliPackage, "cli.js"), "// offline CLI entry; never executed", "utf8");
  const codex = path.join(root, "codex.cmd"), codexPackage = path.join(root, "node_modules/@openai/codex");
  const codexPlatform = `@openai/codex-win32-${process.arch}`, codexVersion = `0.166.0-win32-${process.arch}`;
  const codexNative = path.join(root, "node_modules", codexPlatform, "vendor", process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc", "bin/codex.exe");
  await fs.mkdir(path.join(codexPackage, "bin"), { recursive: true }); await fs.mkdir(path.dirname(codexNative), { recursive: true });
  await fs.writeFile(codex, "@exit /b 98", "utf8");
  await fs.writeFile(path.join(codexPackage, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.166.0", bin: { codex: "bin/codex.js" },
    optionalDependencies: { [codexPlatform]: `npm:@openai/codex@${codexVersion}` } }), "utf8");
  await fs.writeFile(path.join(codexPackage, "bin/codex.js"), "throw new Error('offline Codex entry must never execute');", "utf8");
  await fs.writeFile(path.join(root, "node_modules", codexPlatform, "package.json"), JSON.stringify({ name: "@openai/codex", version: codexVersion, os: ["win32"], cpu: [process.arch] }), "utf8");
  await fs.writeFile(codexNative, "MZ-offline-Codex; never executed", "utf8");
  const credentials = path.join(root, "provider.env"); await fs.writeFile(credentials, "DEEPSEEK_API_KEY=offline-private-key\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n", "utf8");
  return { root, resources, exe, cli, codex, codexNative, credentials, output: path.join(root, "evidence"), manifest };
}

test("import has no launch, credential read or evidence side effect", async () => {
  await driver();
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(new URL("./electron-real-provider-assets.smoke.mjs", import.meta.url).href)}); console.log('IMPORTED');`], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "IMPORTED");
});

test("preflight verifies signed identity, capability and packaged MCP before any write", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), d = await driver();
  const result = await d.preflightAssets([f.exe, f.output], { cli: f.cli, credentialFile: f.credentials, env: {} });
  assert.equal(result.manifest.releaseId, "d07-offline"); assert.equal(result.provider.model, "deepseek-v4-pro");
  assert.equal(result.provider.engine, "claude"); assert.equal(result.hashes.mcp.length, 64);
  assert.equal(result.launch.consoleHost, await fs.realpath(path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT!, "System32/conhost.exe")));
  assert.equal(result.hashes.consoleHost, crypto.createHash("sha256").update(await fs.readFile(result.launch.consoleHost)).digest("hex"));
  assert.equal(result.launch.where, await fs.realpath(path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT!, "System32/where.exe")));
  assert.equal(result.hashes.where, crypto.createHash("sha256").update(await fs.readFile(result.launch.where)).digest("hex"));
  assert.equal(result.launch.taskkill, await fs.realpath(path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT!, "System32/taskkill.exe")));
  assert.equal(result.hashes.taskkill, crypto.createHash("sha256").update(await fs.readFile(result.launch.taskkill)).digest("hex"));
  assert.equal(result.codex.shim, await fs.realpath(f.codex)); assert.equal(result.codex.nativeTarget, await fs.realpath(f.codexNative));
  for (const [name, filename] of Object.entries(result.codex.files)) {
    assert.equal(result.files[`codex-${name}`], filename);
    assert.equal(result.hashes[`codex-${name}`], crypto.createHash("sha256").update(await fs.readFile(filename as string)).digest("hex"));
  }
  await assert.rejects(fs.access(f.output), { code: "ENOENT" });
});

test("preflight rejects source entry, artifact overlap and existing output", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), d = await driver(), options = { cli: f.cli, credentialFile: f.credentials, env: {} };
  await assert.rejects(d.preflightAssets([entry, f.output], options), /OUTSIDE_REPOSITORY|EXE_REQUIRED/);
  await assert.rejects(d.preflightAssets([f.exe, path.join(f.root, "artifact/new-output")], options), /OVERLAP/);
  await fs.mkdir(f.output); await assert.rejects(d.preflightAssets([f.exe, f.output], options), /OUTPUT_ALREADY_EXISTS/);
});

test("missing MCP, tampered manifest, capability and controlled CLI fail before launch", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), d = await driver(), options = { cli: f.cli, credentialFile: f.credentials, env: {} };
  await assert.rejects(d.preflightAssets([f.exe, f.output], { ...options, cli: path.join(f.root, "controlled-codex-provider.cmd") }), /REAL_CLI_REQUIRED/);
  await fs.unlink(path.join(f.resources, "client/scripts/claude-platform-tools-mcp.cjs"));
  await assert.rejects(d.preflightAssets([f.exe, f.output], options), /MCP_REQUIRED/);
  await fs.writeFile(path.join(f.resources, "client/scripts/claude-platform-tools-mcp.cjs"), "// offline MCP placeholder", "utf8");
  await fs.writeFile(path.join(f.resources, "baseline-release-manifest.json"), JSON.stringify({ ...f.manifest, dbSchemaVersion: 102 }), "utf8");
  await assert.rejects(d.preflightAssets([f.exe, f.output], options), /SIGNATURE_INVALID/);
  await fs.writeFile(path.join(f.resources, "baseline-release-manifest.json"), JSON.stringify(f.manifest), "utf8");
  await fs.writeFile(path.join(f.resources, "client/dist/desktop-startup-capability.json"), "{}", "utf8");
  await assert.rejects(d.preflightAssets([f.exe, f.output], options), /CAPABILITY|SHA|FILES_MISMATCH/);
  await assert.rejects(fs.access(f.output), { code: "ENOENT" });
});

test("CLI freezes the actual production-resolved entry and detects target changes with unchanged shim", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), d = await driver();
  const selected = await d.resolveProviderCli(f.cli, f.exe);
  assert.equal(selected.command, f.exe);
  assert.deepEqual(selected.argsPrefix, [await fs.realpath(path.join(f.root, "node_modules/@anthropic-ai/claude-code/cli.js"))]);
  await d.assertProviderCliUnchanged(selected);
  const shimBefore = await fs.readFile(f.cli);
  await fs.writeFile(selected.argsPrefix[0], "// substituted actual CLI", "utf8");
  assert.deepEqual(await fs.readFile(f.cli), shimBefore);
  await assert.rejects(d.assertProviderCliUnchanged(selected), /CLI_INPUT_CHANGED/);
});

test("CLI wrapper freezes its platform package and final native target", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), d = await driver(), packageRoot = path.join(f.root, "node_modules/@anthropic-ai/claude-code");
  await fs.unlink(path.join(packageRoot, "cli.js"));
  await fs.writeFile(path.join(packageRoot, "cli-wrapper.cjs"), "// offline wrapper; never executed", "utf8");
  const name = `@anthropic-ai/claude-code-win32-${process.arch}`;
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "offline", optionalDependencies: { [name]: "offline" } }), "utf8");
  const nativeRoot = path.join(f.root, "node_modules", name); await fs.mkdir(nativeRoot, { recursive: true });
  await fs.writeFile(path.join(nativeRoot, "package.json"), JSON.stringify({ name, version: "offline" }), "utf8");
  await fs.writeFile(path.join(nativeRoot, "claude.exe"), "MZ-offline-target", "utf8");
  const selected = await d.resolveProviderCli(f.cli, f.exe);
  assert.equal(selected.nativeTarget, await fs.realpath(path.join(nativeRoot, "claude.exe")));
  await fs.writeFile(selected.nativeTarget, "MZ-changed-native", "utf8");
  await assert.rejects(d.assertProviderCliUnchanged(selected), /CLI_INPUT_CHANGED/);
});

test("Codex version probe freezes production resolver inputs without executing either entry", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), d = await driver(), selected = await d.resolveCodexVersionProbe(f.root, f.exe);
  assert.equal(selected.shim, await fs.realpath(f.codex)); assert.equal(selected.command, f.exe);
  assert.deepEqual(selected.argsPrefix, [path.join(f.root, "node_modules/@openai/codex/bin/codex.js")]);
  assert.equal(selected.entry, await fs.realpath(selected.argsPrefix[0])); assert.equal(selected.nativeTarget, await fs.realpath(f.codexNative));
  assert.deepEqual(Object.keys(selected.files).sort(), ["entry", "nativePackage", "nativeTarget", "package", "shim"]);
  await d.assertCodexVersionProbeUnchanged(selected);
  for (const filename of Object.values(selected.files) as string[]) {
    const bytes = await fs.readFile(filename); await fs.appendFile(filename, " ", "utf8");
    await assert.rejects(d.assertCodexVersionProbeUnchanged(selected), /CODEX_INPUT_CHANGED/);
    await fs.writeFile(filename, bytes);
  }
  await fs.unlink(f.codex);
  await assert.rejects(d.resolveCodexVersionProbe(f.root, f.exe), /CODEX_ENTRY_REQUIRED/);
  await assert.rejects(d.preflightAssets([f.exe, f.output], { cli: f.cli, credentialFile: f.credentials, env: {} }), /CODEX_ENTRY_REQUIRED/);
  await assert.rejects(fs.access(f.output), { code: "ENOENT" });
});

test("Codex probe rejects missing platform package and mismatched package metadata", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), d = await driver(), selected = await d.resolveCodexVersionProbe(f.root, f.exe);
  for (const [filename, metadata] of [
    [selected.files.package, { name: "other-package", version: "0.166.0" }],
    [selected.files.nativePackage, { name: "@openai/codex", version: "other-platform", os: ["win32"], cpu: [process.arch] }],
  ] as const) {
    const bytes = await fs.readFile(filename); await fs.writeFile(filename, JSON.stringify(metadata), "utf8");
    await assert.rejects(d.resolveCodexVersionProbe(f.root, f.exe), /CODEX_PACKAGE_INVALID|CODEX_NATIVE_PACKAGE_INVALID/);
    await fs.writeFile(filename, bytes);
  }
  await fs.unlink(selected.files.nativePackage);
  await assert.rejects(d.resolveCodexVersionProbe(f.root, f.exe));
});

test("CLI resolver children preserve task temp paths within the isolated environment", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), d = await driver(), execute = spawnSync, environments: NodeJS.ProcessEnv[] = [];
  const mocked = t.mock.method(childProcess, "spawnSync", ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    environments.push(options.env); return execute(command, args, options);
  }) as typeof spawnSync); syncBuiltinESMExports();
  try {
    await d.resolveProviderCli(f.cli, f.exe); await d.resolveCodexVersionProbe(f.root, f.exe);
    assert.equal(environments.length, 2);
    for (const env of environments) {
      assert.equal(env.PATH, f.root);
      for (const key of ["TEMP", "TMP", "TMPDIR"]) assert.equal(env[key], process.env[key], key);
      assert.ok(Object.keys(env).every(key => /^(?:PATH|systemroot|windir|comspec|pathext|temp|tmp|tmpdir)$/iu.test(key)));
    }
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("cleanup rejects reused or incomplete identities before any stop side effect", async () => {
  const d = await driver(), executable = path.resolve("owned.exe"), root = path.resolve("owned-profile"), clientFile = path.resolve("client/index.cjs");
  const anchor = { pid: 101, parentPid: 90, created: 1000, executable, commandLine: `${executable} --user-data-dir=${root}` };
  const client = { pid: 102, parentPid: 101, created: 1001, executable, commandLine: `${executable} ${clientFile} --foreground` };
  const observer = { pid: 90, parentPid: 50, created: 900, executable: process.execPath, commandLine: "node driver.mjs" };
  const owner = { anchorPid: 101, observerPid: 90, launchAfter: 999, profile: root, executable, clientFile, records: [anchor, client] };
  for (const change of [{ ...client, created: 9999 }, { ...client, executable: "" }, { ...client, commandLine: "" }, { ...client, parentPid: 777 }]) {
    const stopped: number[] = [];
    await assert.rejects(d.stopAssetProcesses(structuredClone(owner), { snapshot: async () => [observer, anchor, change], stop: async (identity: any) => stopped.push(identity.pid) }));
    assert.deepEqual(stopped, []);
  }
  const stopped: number[] = [];
  await d.stopAssetProcesses(structuredClone(owner), { snapshot: async () => [observer, anchor, client].filter(identity => !stopped.includes(identity.pid)), stop: async (identity: any) => { stopped.push(identity.pid); } });
  assert.deepEqual(stopped, [102, 101]);
});

test("first process observation binds the launched anchor before discovering descendants", async () => {
  const d = await driver(), executable = path.resolve("owned.exe"), owner: any = {
    anchorPid: 101, observerPid: 90, launchAfter: 999, profile: path.resolve("owned-profile"), executable, clientFile: path.resolve("client/index.cjs"),
    records: [],
  };
  const anchor = { pid: 101, parentPid: 90, created: 1000, executable, commandLine: `${executable} --user-data-dir=${owner.profile}` };
  const child = { pid: 102, parentPid: 101, created: 1001, executable, commandLine: `${executable} ${owner.clientFile} --foreground` };
  const observer = { pid: 90, parentPid: 50, created: 900, executable: process.execPath, commandLine: "node driver.mjs" };
  const values = await d.captureAssetProcesses(owner, { snapshot: async () => [observer, anchor, child] });
  assert.deepEqual(values.map((item: any) => item.pid).sort(), [101, 102]);
  assert.deepEqual(owner.records.map((item: any) => item.pid).sort(), [101, 102]);
  const chromium = ["gpu-process", "utility", "renderer"].map((type, index) => ({ pid: 110 + index, parentPid: anchor.pid, created: 1002,
    executable, commandLine: `"${executable}" --type=${type} --user-data-dir=${owner.profile}` }));
  await d.captureAssetProcesses(owner, { snapshot: async () => [observer, anchor, child, ...chromium] });
  assert.deepEqual(owner.records.map((item: any) => item.pid).sort((a: number, b: number) => a - b), [101, 102, 110, 111, 112]);
  const stopped: number[] = [];
  const bad = { ...owner, records: [] };
  await assert.rejects(d.stopAssetProcesses(bad, { snapshot: async () => [observer, { ...anchor, commandLine: "unrelated-profile" }, child], stop: async (item: any) => stopped.push(item.pid) }), /PROFILE_REQUIRED/);
  assert.deepEqual(stopped, []);
});

test("Windows launch wrapper binds one packaged child and preserves identity checks before cleanup", async () => {
  const d = await driver(), executable = path.resolve("package/CodeFlowAI.exe"), profile = path.resolve("profile"), shell = path.resolve(process.env.ComSpec ?? "cmd.exe");
  const observer = { pid: 584, parentPid: 50, created: 1000, executable: process.execPath, commandLine: "node real-provider-assets.smoke.mjs" };
  const wrapper = { pid: 15384, parentPid: 584, created: 2000, executable: shell, commandLine: `${shell} /d /s /c "${executable}" --user-data-dir=${profile}` };
  const main = { pid: 9780, parentPid: 15384, created: 2001, executable, commandLine: `${executable} --user-data-dir=${profile}` };
  const base = { anchorPid: 15384, observerPid: 584, executable, profile, shell, launchAfter: 1900, clientFile: path.resolve("client/index.cjs"), records: [] };
  const owner: any = structuredClone(base);
  assert.deepEqual((await d.captureAssetProcesses(owner, { snapshot: async () => [observer, wrapper, main] })).map((item: any) => item.pid), [15384, 9780]);
  assert.equal(owner.mainPid, 9780); assert.deepEqual(owner.observer, observer);
  const inspectedMain = { ...main, commandLine: `"${executable}" --inspect-brk=0 --user-data-dir=${profile}` };
  assert.deepEqual((await d.captureAssetProcesses(structuredClone(base), { snapshot: async () => [observer, wrapper, inspectedMain] })).map((item: any) => item.pid), [15384, 9780]);
  const quotedMain = { ...main, commandLine: `"${executable}"  "--inspect=0" "--remote-debugging-port=0" "--user-data-dir=${profile}"` };
  assert.deepEqual((await d.captureAssetProcesses(structuredClone(base), { snapshot: async () => [observer, wrapper, quotedMain] })).map((item: any) => item.pid), [15384, 9780]);
  const cases = [
    [wrapper, main], [{ ...observer, executable: path.resolve("other-node.exe") }, wrapper, main],
    [observer, wrapper], [observer, wrapper, main, { ...main, pid: 9781 }],
    [observer, { ...wrapper, executable: path.resolve("unknown-shell.exe") }, main],
    [observer, { ...wrapper, parentPid: 999 }, main], [observer, { ...wrapper, created: 500 }, main],
    [observer, wrapper, { ...main, created: 1999 }], [observer, wrapper, { ...main, commandLine: "unrelated-profile" }],
    [observer, wrapper, { ...main, commandLine: `"${executable}"  "${base.clientFile}" --foreground ${profile}` }],
    [observer, wrapper, { ...main, commandLine: `"${executable}"extra  "--inspect=0" --user-data-dir=${profile}` }],
    [observer, { ...wrapper, commandLine: `cmd.exe ${profile}` }, main], [observer, { ...wrapper, commandLine: "" }, main],
  ];
  for (const values of cases) {
    const stopped: number[] = [];
    await assert.rejects(d.stopAssetProcesses(structuredClone(base), { snapshot: async () => values, stop: async (item: any) => stopped.push(item.pid) }));
    assert.deepEqual(stopped, []);
  }
  const reused: number[] = [];
  await assert.rejects(d.stopAssetProcesses(owner, { snapshot: async () => [observer, { ...wrapper, created: 3000 }, main], stop: async (item: any) => reused.push(item.pid) }));
  assert.deepEqual(reused, []);
  const observerReused: number[] = [];
  await assert.rejects(d.stopAssetProcesses(owner, { snapshot: async () => [{ ...observer, created: 900 }, wrapper, main], stop: async (item: any) => observerReused.push(item.pid) }));
  assert.deepEqual(observerReused, []);
  const stopped: number[] = [];
  await d.stopAssetProcesses(structuredClone(owner), { snapshot: async () => [observer, wrapper, main].filter(item => !stopped.includes(item.pid)), stop: async (item: any) => { stopped.push(item.pid); } });
  assert.deepEqual(stopped, [9780, 15384]);
});

test("unknown entries fail with traceable safe identity evidence and never stop a process", async () => {
  const d = await driver(), executable = path.resolve("private-package/CodeFlowAI.exe"), profile = path.resolve("private-profile");
  const observer = { pid: 90, parentPid: 50, created: 900, executable: process.execPath, commandLine: "node private-driver.mjs" };
  const anchor = { pid: 101, parentPid: 90, created: 1000, executable, commandLine: `${executable} --user-data-dir=${profile}` };
  const unexpected = { pid: 102, parentPid: 101, created: 1001, executable: path.resolve("Windows/System32/conhost.exe"), commandLine: "conhost.exe private-account apiKey=private-value" };
  const base = { requestId: "diagnostic-request", anchorPid: 101, observerPid: 90, launchAfter: 999, executable, profile, records: [] };
  for (const values of [[observer, { ...anchor, commandLine: `private-value ${profile}` }], [observer, anchor, unexpected]]) {
    const stopped: number[] = [];
    await assert.rejects(d.stopAssetProcesses(structuredClone(base), { snapshot: async () => values, stop: async (item: any) => stopped.push(item.pid) }), (error: any) => {
      const failure = d.safeFailure(error), marker = "D07_REAL_ASSETS_PROCESS_ENTRY_UNCONFIRMED: ";
      assert.ok(failure.message.startsWith(marker), failure.message);
      const context = JSON.parse(failure.message.slice(marker.length));
      assert.equal(context.requestId, "diagnostic-request"); assert.equal(context.anchorPid, 101); assert.equal(context.observerPid, 90);
      const rejected = context.processes[0];
      assert.equal(rejected.pid, values.length === 2 ? 101 : 102); assert.equal(rejected.parentPid, values.length === 2 ? 90 : 101);
      assert.equal(rejected.created, values.length === 2 ? 1000 : 1001); assert.match(rejected.commandLineSha256, /^[a-f0-9]{64}$/u);
      if (values.length === 3) {
        assert.equal(rejected.publicRole, "conhost.exe"); assert.deepEqual(rejected.executableMatches, []);
        assert.equal(context.processes[1].pid, 101); assert.equal(context.processes[1].created, 1000);
      }
      const encoded = JSON.stringify(failure);
      for (const secret of ["private-value", "private-account", "private-package", "private-profile", "private-driver"]) assert.equal(encoded.includes(secret), false);
      return true;
    });
    assert.deepEqual(stopped, []);
  }
});

/** 构造已验证CLI直系系统控制台的完整离线身份，不查询或启动真实进程。 */
function providerConsoleOwner() {
  const executable = path.resolve("owned/CodeFlowAI.exe"), profile = path.resolve("owned-profile"), clientFile = path.resolve("client/index.cjs");
  const consoleHost = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? path.resolve("trusted-windows"), "System32/conhost.exe");
  const cli = { command: path.resolve("trusted-cli/claude.exe"), entry: path.resolve("trusted-cli/claude.exe"), argsPrefix: [] as string[], nativeTarget: undefined as string | undefined };
  const observer = { pid: 90, parentPid: 50, created: 900, executable: process.execPath, commandLine: "node asset-driver.mjs" };
  const anchor = { pid: 101, parentPid: 90, created: 1000, executable, commandLine: `${executable} --user-data-dir=${profile}` };
  const client = { pid: 102, parentPid: 101, created: 1001, executable, commandLine: `${executable} ${clientFile} --foreground` };
  const provider = { pid: 103, parentPid: 102, created: 1002, executable: cli.command, commandLine: `${cli.command} --print` };
  const console = { pid: 104, parentPid: 103, created: 1003, executable: consoleHost, commandLine: `\\??\\${consoleHost} 0x4` };
  return { owner: { requestId: "console-owner", anchorPid: 101, observerPid: 90, launchAfter: 999, profile, executable, clientFile, cli, consoleHost, records: [] },
    observer, anchor, client, provider, console };
}

/** 合成本轮Claude直系的固定Git查询，避免启动CLI或查询真实进程。 */
function providerGitLocatorOwner(native = false) {
  const f = providerConsoleOwner(), where = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? path.resolve("trusted-windows"), "System32/where.exe");
  if (native) {
    f.owner.cli.nativeTarget = f.provider.executable;
    f.owner.cli.command = path.resolve("trusted-node/node.exe");
    f.owner.cli.entry = path.resolve("trusted-cli/cli-wrapper.cjs");
    f.owner.cli.argsPrefix = [f.owner.cli.entry];
  }
  const locator = { pid: 108, parentPid: f.provider.pid, created: 1003, executable: where, commandLine: `${where} git` };
  return { ...f, owner: { ...f.owner, where }, locator };
}

test("Claude fixed Git locator binds to its exact parent and stops before that parent", async () => {
  const d = await driver();
  for (const native of [false, true]) {
    const f = providerGitLocatorOwner(native), values = [f.observer, f.anchor, f.client, f.provider, f.locator], stopped: typeof f.locator[] = [];
    await d.captureAssetProcesses(f.owner, { snapshot: async () => values });
    assert.deepEqual(f.owner.records, values.slice(1));
    await d.stopAssetProcesses(f.owner, { snapshot: async () => values.filter(item => !stopped.some(done => done.pid === item.pid)),
      stop: async (identity: typeof f.locator) => { stopped.push(identity); } });
    assert.deepEqual(stopped, [f.locator, f.provider, f.client, f.anchor]);
  }
});

test("Git locator rejects other commands, paths, parents, timestamps and descendants before any stop", async () => {
  const d = await driver();
  const cases: Array<(f: ReturnType<typeof providerGitLocatorOwner>) => void> = [
    f => { f.locator.commandLine += " extra"; },
    f => { f.locator.commandLine = `${f.owner.where} bash`; },
    f => { f.locator.commandLine = `${f.owner.where} /q git`; },
    f => { f.locator.commandLine = `${f.owner.where} git.exe`; },
    f => { f.locator.commandLine = `${f.owner.where} *`; },
    f => { f.locator.commandLine = "where.exe git"; },
    f => { f.locator.commandLine = `${f.owner.where} git ${f.owner.profile}`; },
    f => { f.locator.commandLine = `${f.owner.where} git ${f.owner.cli.entry}`; },
    f => { f.locator.commandLine = `${f.owner.where} git & other.exe`; },
    f => { f.locator.commandLine = `${f.owner.where}  git`; },
    f => { f.locator.executable = path.resolve("fake-system/where.exe"); f.locator.commandLine = `${f.locator.executable} git`; },
    f => { f.locator.commandLine = `${path.resolve("fake-system/where.exe")} git`; },
    f => { f.locator.parentPid = f.client.pid; },
    f => { f.locator.parentPid = f.anchor.pid; },
    f => { f.locator.parentPid = f.console.pid; },
    f => { f.locator.created = f.provider.created - 1; },
    f => { f.provider.executable = path.resolve("other/claude.exe"); },
    f => { f.owner.cli.command = f.owner.executable; f.owner.cli.entry = path.resolve("trusted-cli/cli.js"); f.owner.cli.argsPrefix = [f.owner.cli.entry];
      f.provider.executable = f.owner.executable; f.provider.commandLine = `${f.owner.executable} other.js ${f.owner.cli.entry}`; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const f = providerGitLocatorOwner(), stopped: number[] = []; mutate(f);
    await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => [f.observer, f.anchor, f.client, f.provider, f.console, f.locator],
      stop: async (identity: typeof f.locator) => { stopped.push(identity.pid); } }), /PROCESS_(?:ENTRY|PARENT)_UNCONFIRMED/u, `case ${index}`);
    assert.deepEqual(stopped, [], `case ${index}`);
  }
  const f = providerGitLocatorOwner(), stopped: number[] = [];
  const child = { ...f.locator, pid: 109, parentPid: f.locator.pid, created: 1004 };
  await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => [f.observer, f.anchor, f.client, f.provider, f.locator, child],
    stop: async (identity: typeof f.locator) => { stopped.push(identity.pid); } }), /PROCESS_ENTRY_UNCONFIRMED/u);
  assert.deepEqual(stopped, []);
});

test("Git locator identity reuse fails before stopping even after an accepted observation", async () => {
  const d = await driver();
  for (const role of ["provider", "locator"] as const) {
    const f = providerGitLocatorOwner(), values = [f.observer, f.anchor, f.client, f.provider, f.locator], stopped: number[] = [];
    await d.captureAssetProcesses(f.owner, { snapshot: async () => values });
    await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => values.map(item => item.pid === f[role].pid ? { ...item, created: item.created + 100 } : item),
      stop: async (identity: typeof f.locator) => { stopped.push(identity.pid); } }), /PROCESS_IDENTITY_CHANGED/u);
    assert.deepEqual(stopped, []);
  }
});

test("fixed Git locator console preserves its full Claude ancestry and reverse stop order", async () => {
  const d = await driver();
  for (const native of [false, true]) {
    const f = providerGitLocatorOwner(native); f.console.parentPid = f.locator.pid; f.console.created = 1004;
    const values = [f.observer, f.anchor, f.client, f.provider, f.locator, f.console], stopped: number[] = [];
    await d.captureAssetProcesses(f.owner, { snapshot: async () => values });
    assert.deepEqual(f.owner.records, values.slice(1));
    await d.stopAssetProcesses(f.owner, { snapshot: async () => values.filter(item => !stopped.includes(item.pid)),
      stop: async (identity: typeof f.locator) => { stopped.push(identity.pid); } });
    assert.deepEqual(stopped, [104, 108, 103, 102, 101]);
  }
});

test("Git locator console rejects unconfirmed ancestry, command, time, reuse and extra descendants", async () => {
  const d = await driver();
  const cases: Array<(f: ReturnType<typeof providerGitLocatorOwner>) => void> = [
    f => { f.locator.commandLine += " extra"; },
    f => { f.locator.executable = path.resolve("other/where.exe"); f.locator.commandLine = `${f.locator.executable} git`; },
    f => { f.locator.parentPid = f.client.pid; },
    f => { f.console.commandLine += " extra"; },
    f => { f.console.executable = path.resolve("other/conhost.exe"); f.console.commandLine = `\\??\\${f.console.executable} 0x4`; },
    f => { f.console.commandLine = "conhost.exe 0x4"; },
    f => { f.console.created = f.locator.created - 1; },
  ];
  for (const mutate of cases) {
    const f = providerGitLocatorOwner(); f.console.parentPid = f.locator.pid; f.console.created = 1004; mutate(f);
    const stopped: number[] = [];
    await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => [f.observer, f.anchor, f.client, f.provider, f.locator, f.console],
      stop: async (identity: typeof f.locator) => { stopped.push(identity.pid); } }), /PROCESS_(?:ENTRY|PARENT)_UNCONFIRMED/u);
    assert.deepEqual(stopped, []);
  }
  for (const role of ["provider", "locator", "console"] as const) {
    const f = providerGitLocatorOwner(); f.console.parentPid = f.locator.pid; f.console.created = 1004;
    const values = [f.observer, f.anchor, f.client, f.provider, f.locator, f.console], stopped: number[] = [];
    await d.captureAssetProcesses(f.owner, { snapshot: async () => values });
    await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => values.map(item => item.pid === f[role].pid ? { ...item, created: item.created + 100 } : item),
      stop: async (identity: typeof f.locator) => { stopped.push(identity.pid); } }), /PROCESS_IDENTITY_CHANGED/u);
    assert.deepEqual(stopped, []);
  }
  const f = providerGitLocatorOwner(); f.console.parentPid = f.locator.pid; f.console.created = 1004;
  const descendant = { ...f.console, pid: 109, parentPid: f.console.pid, created: 1005 }, stopped: number[] = [];
  await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => [f.observer, f.anchor, f.client, f.provider, f.locator, f.console, descendant],
    stop: async (identity: typeof f.locator) => { stopped.push(identity.pid); } }), /PROCESS_ENTRY_UNCONFIRMED/u);
  assert.deepEqual(stopped, []);
});

test("failure cleanup preserves terminal instances and cancels only confirmed active work", async () => {
  const d = await driver(), scope = { workspaceId: "w", instanceId: "i" };
  for (const status of ["completed", "failed", "cancelled", "pending", "running", "paused", "waiting-start", "waiting-approval", "waiting-feedback"]) {
    const methods: string[] = [];
    await d.cancelUnfinishedInstance(async (method: string, body: unknown) => {
      assert.deepEqual(body, scope); methods.push(method); return { instance: { id: "i", workspaceId: "w", status } };
    }, scope);
    assert.deepEqual(methods, ["completed", "failed", "cancelled"].includes(status) ? ["orch.instances.get"] : ["orch.instances.get", "orch.instances.cancel"]);
  }
  for (const failure of [undefined, null, false, new Error("lookup failed")]) {
    const methods: string[] = [];
    await assert.rejects(d.cancelUnfinishedInstance(async (method: string) => { methods.push(method); throw failure; }, scope), (error: unknown) => Object.is(error, failure));
    assert.deepEqual(methods, ["orch.instances.get"]);
  }
  for (const instance of [null, { id: "other", workspaceId: "w", status: "running" }, { id: "i", workspaceId: "other", status: "running" }, { id: "i", workspaceId: "w", status: "unknown" }]) {
    const methods: string[] = [];
    await assert.rejects(d.cancelUnfinishedInstance(async (method: string) => { methods.push(method); return { instance }; }, scope));
    assert.deepEqual(methods, ["orch.instances.get"]);
  }
});

/** 准备先前已观测的精确MCP身份；stop命令不运行真实系统程序。 */
async function providerMcpStopOwner(d: any, native = false) {
  const f = providerGitLocatorOwner(native), mcpFile = path.resolve("client/scripts/claude-platform-tools-mcp.cjs");
  const taskkill = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT!, "System32/taskkill.exe");
  const owner = { ...f.owner, mcpFile, taskkill };
  const mcp = { pid: 110, parentPid: f.provider.pid, created: 1003, executable: owner.executable, commandLine: `${owner.executable} ${mcpFile}` };
  const values = [f.observer, f.anchor, f.client, f.provider, mcp];
  await d.captureAssetProcesses(owner, { snapshot: async () => values });
  const stop = { pid: 111, parentPid: f.provider.pid, created: 1004, executable: taskkill, commandLine: `${taskkill} /pid 110 /t /f` };
  const console = { ...f.console, pid: 112, parentPid: stop.pid, created: 1005 };
  return { ...f, owner, mcp, stop, console, values };
}

test("Claude cleanup recognizes only its previously confirmed MCP target and exact system stop command", async () => {
  const d = await driver();
  for (const native of [false, true]) for (const targetAlive of [false, true]) {
    const f = await providerMcpStopOwner(d, native), stopped: number[] = [];
    const values = [...f.values.filter(item => targetAlive || item.pid !== f.mcp.pid), f.stop, f.console];
    await d.captureAssetProcesses(f.owner, { snapshot: async () => values });
    await d.stopAssetProcesses(f.owner, { snapshot: async () => values.filter(item => !stopped.includes(item.pid)),
      stop: async (identity: typeof f.stop) => { stopped.push(identity.pid); } });
    assert.deepEqual(stopped, targetAlive ? [112, 111, 110, 103, 102, 101] : [112, 111, 103, 102, 101]);
  }
});

test("Claude stop helper rejects unconfirmed targets, reused identity and broader commands before any stop", async () => {
  const d = await driver();
  const cases: Array<(f: Awaited<ReturnType<typeof providerMcpStopOwner>>) => void> = [
    f => { f.stop.commandLine = `${f.owner.taskkill} /pid 102 /t /f`; },
    f => { f.stop.commandLine = `${f.owner.taskkill} /pid 999 /t /f`; },
    f => { f.stop.commandLine += " /im other.exe"; },
    f => { f.stop.commandLine = `${f.owner.taskkill} /pid 110 /f`; },
    f => { f.stop.executable = path.resolve("fake-system/taskkill.exe"); f.stop.commandLine = `${f.stop.executable} /pid 110 /t /f`; },
    f => { f.stop.parentPid = f.client.pid; },
    f => { f.stop.created = f.mcp.created - 1; },
    f => { f.mcp.created += 100; },
    f => { f.mcp.commandLine += " extra"; },
    f => { f.owner.records = f.owner.records.filter((item: typeof f.mcp) => item.pid !== f.mcp.pid); f.values = f.values.filter(item => item.pid !== f.mcp.pid); },
  ];
  for (const mutate of cases) {
    const f = await providerMcpStopOwner(d), stopped: number[] = []; mutate(f);
    const values = [...f.values.map(item => item.pid === f.mcp.pid ? f.mcp : item), f.stop, f.console];
    await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => values,
      stop: async (identity: typeof f.stop) => { stopped.push(identity.pid); } }));
    assert.deepEqual(stopped, []);
  }
});

/** 合成 Client→Codex JS→native→系统控制台；所有参数均固定为版本探测。 */
function codexProbeOwner(spaces = false) {
  const f = providerConsoleOwner(), directory = spaces ? "trusted Codex" : "trusted-codex";
  if (spaces) {
    f.owner.executable = path.resolve("owned package/CodeFlowAI.exe"); f.owner.clientFile = path.resolve("client package/index.cjs");
    f.anchor.executable = f.owner.executable; f.anchor.commandLine = `"${f.owner.executable}" --user-data-dir=${f.owner.profile}`;
    f.client.executable = f.owner.executable; f.client.commandLine = `"${f.owner.executable}" "${f.owner.clientFile}" --foreground`;
  }
  f.owner.cli.command = f.owner.executable; f.owner.cli.entry = path.resolve("trusted-cli/cli.js"); f.owner.cli.argsPrefix = [f.owner.cli.entry];
  f.provider.executable = f.owner.executable; f.provider.commandLine = `${f.owner.executable} ${f.owner.cli.entry} --print`;
  const entry = path.resolve(directory, "bin/codex.js"), nativeTarget = path.resolve(directory, "vendor/codex.exe");
  const jsCommandLine = spaces ? `"${f.owner.executable}" "${entry}" --version` : `${f.owner.executable} ${entry} --version`;
  const nativeCommandLine = spaces ? `"${nativeTarget}" --version` : `${nativeTarget} --version`;
  const codex = { command: f.owner.executable, argsPrefix: [entry], entry, nativeTarget, jsCommandLine: jsCommandLine.toLowerCase(), nativeCommandLine: nativeCommandLine.toLowerCase() };
  const js = { pid: 105, parentPid: f.client.pid, created: 1002, executable: f.owner.executable, commandLine: jsCommandLine };
  const native = { pid: 106, parentPid: js.pid, created: 1003, executable: nativeTarget, commandLine: nativeCommandLine };
  const console = { ...f.console, pid: 107, parentPid: native.pid, created: 1004 };
  return { ...f, owner: { ...f.owner, codex }, js, native, console };
}

test("Codex version JS, native and exact console bind to this Client and stop in reverse order", async () => {
  const d = await driver();
  for (const spaces of [false, true]) for (const consoleParent of ["js", "native"] as const) {
    const f = codexProbeOwner(spaces); f.console.parentPid = f[consoleParent].pid;
    const values = [f.observer, f.anchor, f.client, f.js, f.native, f.console], stopped: number[] = [];
    await d.captureAssetProcesses(f.owner, { snapshot: async () => values });
    assert.deepEqual(f.owner.records, values.slice(1));
    await d.stopAssetProcesses(f.owner, { snapshot: async () => values.filter(item => !stopped.includes(item.pid)),
      stop: async (identity: typeof f.js) => { stopped.push(identity.pid); } });
    assert.deepEqual(stopped, [107, 106, 105, 102, 101]);
  }
  const f = codexProbeOwner(), mcpFile = path.resolve("client/scripts/claude-platform-tools-mcp.cjs");
  const owner = { ...f.owner, mcpFile }, mcp = { pid: 108, parentPid: f.provider.pid, created: 1003, executable: owner.executable, commandLine: `${owner.executable} ${mcpFile}` };
  await d.captureAssetProcesses(owner, { snapshot: async () => [f.observer, f.anchor, f.client, f.provider, mcp] });
  assert.deepEqual(owner.records.map((item: typeof mcp) => item.pid), [101, 102, 103, 108]);
});

test("Codex probe rejects changed entry, argument, parent, time and console before every stop", async () => {
  const d = await driver();
  const cases: Array<(f: ReturnType<typeof codexProbeOwner>) => void> = [
    f => { f.js.commandLine += " extra"; },
    f => { f.js.commandLine += ` ${f.owner.profile}`; },
    f => { f.js.commandLine += ` ${f.owner.cli.entry}`; },
    f => { f.js.commandLine = f.js.commandLine.replace("--version", "app-server"); },
    f => { f.js.commandLine = f.js.commandLine.replace("codex.js", "other.js"); },
    f => { f.js.executable = path.resolve("other/CodeFlowAI.exe"); },
    f => { f.js.parentPid = f.anchor.pid; },
    f => { f.js.parentPid = f.provider.pid; },
    f => { f.client.commandLine += " extra"; },
    f => { f.client.parentPid = f.provider.pid; f.provider.parentPid = f.anchor.pid; },
    f => { f.js.created = f.client.created - 1; },
    f => { f.native.commandLine += " extra"; },
    f => { f.native.commandLine = f.native.commandLine.replace("--version", "app-server"); },
    f => { f.native.executable = path.resolve("other/codex.exe"); },
    f => { f.native.parentPid = f.client.pid; },
    f => { f.native.parentPid = f.provider.pid; },
    f => { f.native.created = f.js.created - 1; },
    f => { f.console.parentPid = f.client.pid; },
    f => { f.console.commandLine += " extra"; },
    f => { f.console.commandLine = "conhost.exe 0x4"; },
    f => { f.console.executable = path.resolve("other/conhost.exe"); },
    f => { f.console.created = f.native.created - 1; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const f = codexProbeOwner(), stopped: number[] = []; mutate(f);
    await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => [f.observer, f.anchor, f.client, f.provider, f.js, f.native, f.console],
      stop: async (identity: typeof f.js) => { stopped.push(identity.pid); } }), /PROCESS_(?:ENTRY|PARENT)_UNCONFIRMED/u, `case ${index}`);
    assert.deepEqual(stopped, [], `case ${index}`);
  }
  for (const role of ["client", "js", "native", "console"] as const) {
    const f = codexProbeOwner(), values = [f.observer, f.anchor, f.client, f.js, f.native, f.console], stopped: number[] = [];
    await d.captureAssetProcesses(f.owner, { snapshot: async () => values });
    await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => values.map(item => item.pid === f[role].pid ? { ...item, created: item.created + 100 } : item),
      stop: async (identity: typeof f.js) => { stopped.push(identity.pid); } }), /IDENTITY_CHANGED/);
    assert.deepEqual(stopped, []);
  }
});

test("Codex path aliases cannot borrow trailing Claude entry or profile allowances", async () => {
  const d = await driver();
  const aliases = [
    (entry: string) => entry,
    (entry: string) => entry.replaceAll("\\", "/"),
    (entry: string) => `"${entry.replaceAll("\\", "/").toUpperCase()}"`,
    (entry: string) => `${path.dirname(entry)}${path.sep}.${path.sep}codex.js`,
    (entry: string) => `${path.dirname(entry)}${path.sep}..${path.sep}bin${path.sep}codex.js`,
    (entry: string) => `${path.dirname(entry)}${path.sep}co"dex".js`,
    (entry: string) => `"${path.dirname(entry)}"${path.sep}codex.js`,
  ];
  for (const [index, alias] of aliases.entries()) for (const borrow of ["cli", "profile"] as const) {
    const f = codexProbeOwner(), stopped: number[] = [];
    f.js.commandLine = `${f.owner.executable} ${alias(f.owner.codex.entry)} --version ${borrow === "cli" ? f.owner.cli.entry : f.owner.profile}`;
    await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => [f.observer, f.anchor, f.client, f.js].filter(item => !stopped.includes(item.pid)),
      stop: async (identity: typeof f.js) => { stopped.push(identity.pid); } }), /PROCESS_ENTRY_UNCONFIRMED/u, `${index}:${borrow}`);
    assert.deepEqual(stopped, [], `${index}:${borrow}`);
  }
  for (const type of ["unknown", "renderer-extra", "renderer"]) {
    const f = codexProbeOwner(), stopped: number[] = [];
    f.js.commandLine = `"${f.owner.executable}" --type=${type} --user-data-dir=${f.owner.profile}`;
    await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => [f.observer, f.anchor, f.client, f.js].filter(item => !stopped.includes(item.pid)),
      stop: async (identity: typeof f.js) => { stopped.push(identity.pid); } }), /PROCESS_ENTRY_UNCONFIRMED/u);
    assert.deepEqual(stopped, []);
  }
});

test("validated CLI console is registered and stopped by full identity before its parent", async () => {
  const d = await driver();
  for (const native of [false, true]) {
    const f = providerConsoleOwner();
    if (native) {
      f.owner.cli.nativeTarget = f.provider.executable;
      f.owner.cli.command = path.resolve("trusted-node/node.exe");
      f.owner.cli.entry = path.resolve("trusted-cli/cli-wrapper.cjs");
      f.owner.cli.argsPrefix = [f.owner.cli.entry];
    }
    const values = [f.observer, f.anchor, f.client, f.provider, f.console], stopped: typeof f.console[] = [];
    await d.captureAssetProcesses(f.owner, { snapshot: async () => values });
    assert.deepEqual(f.owner.records, values.slice(1));
    await d.stopAssetProcesses(f.owner, { snapshot: async () => values.filter(item => !stopped.some(done => done.pid === item.pid)),
      stop: async (identity: typeof f.console) => { stopped.push(identity); } });
    assert.deepEqual(stopped, [f.console, f.provider, f.client, f.anchor]);
  }
});

test("console rejects wrong parent, path, command, time and unknown descendants before stopping", async () => {
  const d = await driver();
  const cases: Array<(f: ReturnType<typeof providerConsoleOwner>) => void> = [
    f => { f.console.parentPid = f.client.pid; },
    f => { f.console.executable = path.resolve("fake-system/conhost.exe"); f.console.commandLine = `\\??\\${f.console.executable} 0x4`; },
    f => { f.console.commandLine += " extra"; },
    f => { f.console.commandLine = "conhost.exe 0x4"; },
    f => { f.console.commandLine = `\\??\\${path.resolve("fake-system/conhost.exe")} 0x4`; },
    f => { f.console.commandLine = `\\??\\${f.console.executable} 0x`; },
    f => { f.console.created = f.provider.created - 1; },
    f => { f.provider.executable = path.resolve("untrusted/claude.exe"); },
    f => { f.console.executable = path.resolve("unknown-helper.exe"); },
    f => { f.console.commandLine = ""; },
  ];
  for (const mutate of cases) {
    const f = providerConsoleOwner(), stopped: number[] = []; mutate(f);
    await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => [f.observer, f.anchor, f.client, f.provider, f.console],
      stop: async (identity: typeof f.console) => { stopped.push(identity.pid); } }));
    assert.deepEqual(stopped, []);
  }
});

test("registered console and CLI parent identity reuse prevent every stop", async () => {
  const d = await driver();
  for (const role of ["console", "provider"] as const) {
    const f = providerConsoleOwner(), values = [f.observer, f.anchor, f.client, f.provider, f.console];
    await d.captureAssetProcesses(f.owner, { snapshot: async () => values });
    const changed = { ...f[role], created: f[role].created + 100 }, stopped: number[] = [];
    await assert.rejects(d.stopAssetProcesses(f.owner, { snapshot: async () => values.map(item => item.pid === changed.pid ? changed : item),
      stop: async (identity: typeof f.console) => { stopped.push(identity.pid); } }), /IDENTITY_CHANGED/);
    assert.deepEqual(stopped, []);
  }
});

test("credential parsing never evaluates env text and failures redact nested secrets", async () => {
  const d = await driver();
  assert.throws(() => d.parseProviderEnv("DEEPSEEK_API_KEY=$(sideEffect)\nDEEPSEEK_BASE_URL=http://localhost:1234"), /REMOTE_PROVIDER_REQUIRED/);
  const parsed = d.parseProviderEnv("# local\nDEEPSEEK_API_KEY='private-value'\nDEEPSEEK_BASE_URL=https://api.deepseek.com\n");
  assert.equal(parsed.apiKey, "private-value");
  const error = new AggregateError([new Error("private-value"), new Error("Bearer another-secret")], "apiKey=third-secret", { cause: new Error("https://u:pw@example.com/?token=other") });
  const encoded = JSON.stringify(d.safeFailure(error, ["private-value"]));
  for (const secret of ["private-value", "another-secret", "third-secret", "u:pw", "token=other"]) assert.equal(encoded.includes(secret), false);
});

test("failure retains explicit falsy causes and AggregateError order", async () => {
  const d = await driver();
  const causes = [undefined, false, 0, ""];
  const failure = d.safeFailure(new AggregateError(causes.map(cause => new Error("operation", { cause })), "ordered"));
  assert.deepEqual(failure.errors.map((item: any) => item.cause), [
    { type: "undefined" }, { type: "boolean", value: false }, { type: "number", value: 0 }, { type: "string", value: "" },
  ]);
  assert.equal(Object.hasOwn(d.safeFailure(new Error("without cause")), "cause"), false);
});

test("run boundary fails explicitly for undefined, false and zero rejections", async () => {
  await driver();
  for (const literal of ["undefined", "false", "0"]) {
    const script = `const {runAssets}=await import(${JSON.stringify(new URL("./electron-real-provider-assets.smoke.mjs", import.meta.url).href)}); await runAssets(['unused.exe','unused-output','--run'],{preflight:async()=>{throw ${literal};}});`;
    const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stderr.trim());
    assert.equal(report.completed, false); assert.equal(report.paidProviderExercised, false);
    assert.equal(report.phase, "preflight"); assert.equal(report.failure.type, literal === "undefined" ? "undefined" : literal === "false" ? "boolean" : "number");
  }
});

test("evidence serialization redacts provider echoes without changing assertion input", async () => {
  const d = await driver(), input = { raw: [{ output: "proof private-value Bearer unknown-token", token: "private-token" }], prompt: "https://u:pw@example.com/?token=other", proof: "expected-proof" };
  const json = d.safeEvidenceJson(input, ["private-value"]);
  for (const secret of ["private-value", "unknown-token", "private-token", "u:pw", "token=other"]) assert.equal(json.includes(secret), false);
  assert.equal(JSON.parse(json).proof, "expected-proof"); assert.match(input.raw[0]!.output, /private-value/);
});

test("evidence serialization preserves nested JSON syntax while redacting URLs and credential fields", async () => {
  const d = await driver(), encoded = JSON.stringify({ navigation: 'read "https://example.invalid/path" then verify', token: "private-token", proof: "stable-proof",
    contentJson: JSON.stringify({ password: "private-password", text: "private-value" }) });
  const input = { prompt_envelope_json: encoded, contentJson: JSON.stringify({ source: "https://example.invalid/?token=private-token", proof: "stable-proof" }) };
  const serialized = d.safeEvidenceJson(input, ["private-value"]), outer = JSON.parse(serialized), envelope = JSON.parse(outer.prompt_envelope_json);
  assert.deepEqual(envelope, { navigation: 'read "[URL]" then verify', token: "[REDACTED]", proof: "stable-proof", contentJson: JSON.stringify({ password: "[REDACTED]", text: "[REDACTED]" }) });
  assert.deepEqual(JSON.parse(outer.contentJson), { source: "[URL]", proof: "stable-proof" });
  for (const secret of ["private-value", "private-token", "private-password", "example.invalid"]) assert.equal(serialized.includes(secret), false);
  assert.equal(input.prompt_envelope_json, encoded);
  assert.throws(() => d.safeEvidenceJson({ prompt_envelope_json: '{"broken":' }));
});

test("evidence serialization preserves native JSON fragments and validates only complete stored documents", async () => {
  const d = await driver(), partial = '{"', input = { raw: [{ data: { event: { type: "input_json_delta", delta: { partial_json: partial } } } }],
    runtime_policy_json: JSON.stringify({ source: 'read "https://example.invalid/policy"' }), artifact_input_json: "null" };
  const saved = JSON.parse(d.safeEvidenceJson(input));
  assert.equal(saved.raw[0].data.event.delta.partial_json, partial);
  assert.deepEqual(JSON.parse(saved.runtime_policy_json), { source: 'read "[URL]"' });
  assert.equal(JSON.parse(saved.artifact_input_json), null);
  assert.equal(input.raw[0]!.data.event.delta.partial_json, partial);
  assert.throws(() => d.safeEvidenceJson({ runtime_policy_json: partial }));
});

test("physical reader uses workspace database and never creates or falls back to application tables", async t => {
  const d = await driver(), root = await fs.mkdtemp(path.join(os.tmpdir(), "d07-workspace-reader-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "project/.codeflow"), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  new DatabaseSync(path.join(root, "project/.codeflow/workspace.db")).close();
  await assert.rejects(d.persistedEvidence(root, {}, { instanceId: "i", workspaceId: "ws" }), /no such table: orch_instances/);
  await assert.rejects(fs.access(path.join(root, "runtime")), { code: "ENOENT" });
});

test("asset scripts read actual project and complete Skill bytes instead of returning expected answers", async t => {
  const d = await driver(), project = await fs.mkdtemp(path.join(os.tmpdir(), "d07-real-script-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const requests: any[] = [];
  const request = async (method: string, body: any) => {
    const field = method.includes("knowledgeBundles") ? "bundle" : method.includes("toolsets") ? "toolset" : method.includes("skills") ? "skill" : method.includes("roles") ? "role" : "workflow";
    requests.push({ method, body }); return { [field]: { ...body[field], id: field, workspaceId: "ws", kind: "custom", createdAt: 1, updatedAt: 1 } };
  };
  const application = { evaluate: () => {
    const executionConfig = createDefaultRoleExecutionConfig("claude");
    executionConfig.engineProfiles.claude = { enabled: true, mode: "custom", customConfig: { ...createDefaultRoleExecutionCustomConfig("claude"), model: "deepseek-v4-pro", effort: "high", maxRetries: 0 } };
    executionConfig.engineProfiles.codex.enabled = false;
    return { executionConfig, inputDefinition: createDefaultRoleInputDefinition(), outputDefinition: createDefaultRoleOutputDefinition() };
  } };
  const { assets, expected } = await d.createAssets(request, application, "ws", project, "offline-script");
  const wrap = (code: string) => `const printJson=(value)=>process.stdout.write(JSON.stringify(value));\n${code}`;
  const toolScript = path.join(project, "tool.mjs"); await fs.writeFile(toolScript, wrap(assets.toolset.tools[0].code), "utf8");
  const first = spawnSync(process.execPath, [toolScript], { encoding: "utf8", env: { ...process.env, CODEFLOWAI_TOOL_WORKSPACE_PATH: project } });
  assert.equal(first.status, 0, first.stderr); assert.equal(JSON.parse(first.stdout).sha256, crypto.createHash("sha256").update(await fs.readFile(path.join(project, "proof.bin"))).digest("hex"));
  await fs.writeFile(path.join(project, "proof.bin"), "changed-input", "utf8");
  const changed = spawnSync(process.execPath, [toolScript], { encoding: "utf8", env: { ...process.env, CODEFLOWAI_TOOL_WORKSPACE_PATH: project } });
  assert.equal(changed.status, 0, changed.stderr); assert.notEqual(JSON.parse(changed.stdout).sha256, expected.toolDigest);
  const skillRoot = path.join(project, "skill");
  for (const file of assets.skill.files) {
    const bytes = file.contentText != null ? Buffer.from(file.contentText, "utf8") : Buffer.from(file.contentBase64, "base64");
    assert.equal(bytes.length, file.sizeBytes); assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), file.sha256);
    await fs.mkdir(path.dirname(path.join(skillRoot, file.relPath)), { recursive: true }); await fs.writeFile(path.join(skillRoot, file.relPath), bytes);
  }
  const skillScript = path.join(skillRoot, "run.mjs"); await fs.writeFile(skillScript, wrap(assets.skill.files.find((f: any) => f.relPath === "scripts/check.mjs").contentText), "utf8");
  const skill = spawnSync(process.execPath, [skillScript], { encoding: "utf8", cwd: skillRoot });
  assert.equal(skill.status, 0, skill.stderr); assert.equal(JSON.parse(skill.stdout).sha256, expected.skillDigest);
  await fs.unlink(path.join(skillRoot, "assets/proof.bin"));
  assert.notEqual(spawnSync(process.execPath, [skillScript], { encoding: "utf8", cwd: skillRoot }).status, 0);
  assert.equal(requests.length, 5); assert.deepEqual(assets.role.defaultKnowledgeBundleIds, [assets.knowledge.id]);
  assert.deepEqual(assets.role.defaultSkillIds, [assets.skill.id]); assert.equal(assets.role.toolRefs[0].toolsetId, assets.toolset.id);
});

/** 事件夹具手写同链工具事实；缺一项不得凭最终文字通过。 */
function evidence() {
  const definition = { id: "r", defaultKnowledgeBundleIds: ["k"], defaultSkillIds: ["s"], toolRefs: [{ toolsetId: "t", toolId: "inspect-project" }] };
  const entry = (assetType: string, id: string, value: object) => ({ assetType, assetId: id, definition: value, source: { authorityMode: "legacy", createdAt: 1, updatedAt: 2 } });
  const assets = { role: { ...definition, createdAt: 1, updatedAt: 2 }, knowledge: { id: "k", createdAt: 1, updatedAt: 2 }, toolset: { id: "t", createdAt: 1, updatedAt: 2 },
    skill: { id: "s", slug: "d07-proof", files: [{ relPath: "SKILL.md", kind: "skill-md", contentText: "abc", sizeBytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }], createdAt: 1, updatedAt: 2 }, workflow: { id: "w", nodes: [{ id: "verify", type: "role", roleId: "r" }], edges: [], createdAt: 1, updatedAt: 2 } };
  const graph = { authorityMode: "legacy", workflow: { ...entry("workflow", "w", { id: "w", nodes: assets.workflow.nodes, edges: [] }), source: null },
    roles: { r: entry("role", "r", definition) }, knowledgeBundles: { k: entry("knowledge_bundle", "k", { id: "k" }) }, toolsets: { t: entry("toolset", "t", { id: "t" }) }, skills: { s: entry("skill", "s", { id: "s", slug: "d07-proof", files: assets.skill.files }) } };
  const names = ["Read", "aidt_inspect-project", "aidt_skill_d07-proof_check", "aidt_runtime_submitNodeResult"];
  const canonical: any[] = [{ workspaceId: "ws", threadId: "th", engine: "claude", type: "turn.started", payload: { turnId: "turn1" } }, ...names.flatMap((toolName, i) => [
    { workspaceId: "ws", threadId: "th", engine: "claude", type: "item.tool.started", payload: { itemId: `u${i}`, toolName, input: toolName === "Read" ? { file_path: "knowledge.txt" } : {} } },
    { workspaceId: "ws", threadId: "th", engine: "claude", type: "item.tool.completed", payload: { itemId: `u${i}`, toolName, status: "completed", output: "knowledge-nonce tool-digest skill-digest" } },
  ]), { workspaceId: "ws", threadId: "th", engine: "claude", type: "turn.completed", payload: { turnId: "turn1" } }];
  return { assets, expected: { workspaceId: "ws", instanceId: "i", threadId: "th", knowledgeNonce: "knowledge-nonce", toolDigest: "tool-digest", skillDigest: "skill-digest", skillToolId: "skill.d07-proof.check" },
    instance: { id: "i", workspaceId: "ws", status: "completed", assetRuntimeSnapshot: graph, intakeSnapshot: { workspaceScope: { scopeType: "local_workspace", scopeId: "ws" } }, nodeStates: { verify: { status: "completed", threadId: "th" } } },
    canonical, raw: names.flatMap((name, i) => [{ type: "tool_use", id: `u${i}`, name, input: name === "Read" ? { file_path: "knowledge.txt" } : {} }, { type: "tool_result", tool_use_id: `u${i}`, content: "knowledge-nonce tool-digest skill-digest" }]).map(data => ({ workspaceId: "ws", threadId: "th", engine: "claude", source: "claude.stream-json.stdout", data })),
    turns: [{ id: "turn1", status: "completed", engine: "claude" }],
    prompts: [{ thread_id: "th", node_id: "verify", turn_id: "turn1", engine: "claude", model: "deepseek-v4-pro", effort: "high", system_message: "system", developer_message: "runtime.submitNodeResult", user_message: "verify", prompt_envelope_json: "{}", tool_registry_json: JSON.stringify({ tools: ["inspect-project", "skill.d07-proof.check", "runtime.submitNodeResult"].map(toolId => ({ toolId })) }), knowledge_catalogs_json: '{"catalogs":[{"bundleId":"k"}],"warnings":[]}' }],
    artifacts: [{ id: "a", nodeId: "verify", contentJson: "knowledge-nonce tool-digest skill-digest" }], events: [{ type: "orchestration.completed" }], retainedTools: ["inspect-project", "skill.d07-proof.check"],
    materializedSkillFiles: [{ relPath: "SKILL.md", sizeBytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }] };
}

test("evidence requires every frozen dependency, tool pair, raw trace and durable result", async () => {
  const d = await driver(); assert.doesNotThrow(() => d.assertAssetEvidence(evidence()));
  const cases: Array<(e: ReturnType<typeof evidence>) => void> = [
    e => { delete (e.instance.assetRuntimeSnapshot.roles as any).r; },
    e => { delete (e.instance.assetRuntimeSnapshot.knowledgeBundles as any).k; },
    e => { delete (e.instance.assetRuntimeSnapshot.toolsets as any).t; },
    e => { delete (e.instance.assetRuntimeSnapshot.skills as any).s; },
    e => { (e.instance.assetRuntimeSnapshot.roles.r as any).source = null; },
    e => { e.raw = []; }, e => { e.canonical = []; }, e => { e.turns = []; }, e => { e.prompts = []; }, e => { e.artifacts = []; },
    e => { e.retainedTools = []; }, e => { e.raw = e.raw.filter((x: any) => x.data.tool_use_id !== "u3"); },
    e => { e.canonical = e.canonical.filter(x => x.payload.itemId !== "u2"); },
    e => { e.canonical[0]!.threadId = "other"; }, e => { e.prompts[0]!.model = "other-model"; },
    e => { e.raw[0]!.threadId = "other"; }, e => { e.materializedSkillFiles = []; },
    e => { e.materializedSkillFiles[0]!.sha256 = "wrong"; }, e => { e.canonical = e.canonical.filter(x => x.type !== "turn.started"); },
  ];
  for (const mutate of cases) { const value = evidence(); mutate(value); assert.throws(() => d.assertAssetEvidence(value)); }
});

test("evidence preserves actual stderr and catalog envelopes without treating stderr as tool proof", async () => {
  const d = await driver(), value = evidence();
  value.raw.push({ workspaceId: "ws", threadId: "th", engine: "claude", source: "claude.stderr", data: { line: "provider diagnostic" } } as any);
  assert.doesNotThrow(() => d.assertAssetEvidence(value));
  const cases: Array<(e: ReturnType<typeof evidence>) => void> = [
    e => { e.prompts[0]!.knowledge_catalogs_json = '[{"bundleId":"k"}]'; },
    e => { e.prompts[0]!.knowledge_catalogs_json = '{"catalogs":[],"warnings":[]}'; },
    e => { e.prompts[0]!.knowledge_catalogs_json = '{"catalogs":[{"bundleId":"k"}],"warnings":["missing source"]}'; },
    e => { e.raw[0]!.source = "other"; },
    e => { e.raw[0]!.source = "claude.stderr"; },
    e => { e.raw.push({ workspaceId: "other", threadId: "th", engine: "claude", source: "claude.stderr", data: { line: "diagnostic" } } as any); },
  ];
  for (const mutate of cases) { const e = evidence(); mutate(e); assert.throws(() => d.assertAssetEvidence(e)); }
});

test("Read evidence uses its final streamed input and matching complete native tool input", async () => {
  const d = await driver(), value = evidence();
  value.canonical[1]!.payload.input = { file_path: "F" };
  const update = { workspaceId: "ws", threadId: "th", engine: "claude", type: "item.tool.inputUpdated", payload: { itemId: "u0", toolName: "Read", input: { file_path: "knowledge.txt" } } };
  value.canonical.splice(2, 0, update);
  assert.doesNotThrow(() => d.assertAssetEvidence(value));
  for (const kind of ["wrong-id", "wrong-tool", "final-wrong-path", "raw-wrong-path"]) {
    const e = structuredClone(value);
    if (kind === "wrong-id") e.canonical[2]!.payload.itemId = "other";
    if (kind === "wrong-tool") e.canonical[2]!.payload.toolName = "other";
    if (kind === "final-wrong-path") e.canonical.splice(3, 0, { ...update, payload: { ...update.payload, input: { file_path: "other.txt" } } });
    if (kind === "raw-wrong-path") (e.raw[0]!.data as any).input.file_path = "other.txt";
    assert.throws(() => d.assertAssetEvidence(e), /TOOL_EVIDENCE_INCOMPLETE/u);
  }
});
