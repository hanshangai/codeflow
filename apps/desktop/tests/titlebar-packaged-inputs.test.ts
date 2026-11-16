import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

type ProcessFact = { pid: number; parentPid: number; executable: string; commandLine: string; created: string };
const { preflight, collectOwnedProcesses } = await import(new URL("./electron-packaged-titlebar.smoke.mjs", import.meta.url).href) as {
  preflight(args: string[]): Promise<{ root: string; manifest: { releaseId: string } }>;
  collectOwnedProcesses(all: ProcessFact[], input: { pid: number; driverPid: number; executable: string; profile: string; launchAfter: number }): ProcessFact[];
};

const require = createRequire(import.meta.url), builder = createRequire(require.resolve("electron-builder"));
const asar = createRequire(builder.resolve("app-builder-lib"))("@electron/asar") as { createPackage(a: string, b: string): Promise<void> };
const { buildReleaseBundle } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../scripts/build-release-bundle.mjs")).href) as {
  buildReleaseBundle(input: { resourcesDir: string; outputDir: string; privateKeyFile: string; metadata: Record<string, unknown> }): Promise<unknown>;
};

/** 创建最小真实 ASAR、编译目录和签名完整包；不启动 Electron、不读公共 dist。 */
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "titlebar-input-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifact = path.join(root, "Program Files"), resources = path.join(artifact, "resources"), compiled = path.join(root, "frozen dist");
  for (const dir of [resources, compiled, path.join(resources, "web"), path.join(resources, "client/dist"), path.join(root, "asar/dist")]) await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries({ "main.js": "frame: false; desktop:windowControl", "preload.cjs": "windowControls" })) {
    await fs.writeFile(path.join(compiled, name), content);
    await fs.writeFile(path.join(root, "asar/dist", name), content);
  }
  await asar.createPackage(path.join(root, "asar"), path.join(resources, "app.asar"));
  await fs.writeFile(path.join(artifact, "CodeFlowAI.exe"), "fixture");
  await fs.writeFile(path.join(resources, "web/index.html"), '<script src="/titlebar.js"></script>');
  await fs.writeFile(path.join(resources, "web/titlebar.js"), "desktop-window-bar window-minimize window-maximize window-close");
  await fs.writeFile(path.join(resources, "client/dist/index.cjs"), "client");
  const keys = crypto.generateKeyPairSync("ed25519"), privateFile = path.join(root, "private.pem");
  await fs.writeFile(privateFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  await fs.writeFile(path.join(resources, "release-trust.json"), JSON.stringify({ titlebar: keys.publicKey.export({ type: "spki", format: "pem" }) }));
  const bundle = path.join(root, "bundle");
  await buildReleaseBundle({ resourcesDir: resources, outputDir: bundle, privateKeyFile: privateFile,
    metadata: { releaseId: "titlebar-fixture", version: "2026.11.02.1", webVersion: "1.0.0", clientVersion: "1.0.0", capabilityVersion: 1,
      platform: "win32", arch: "x64", protocolVersion: 1, dbSchemaVersion: 100, keyId: "titlebar", createdAt: "2026-11-02T00:00:00.000Z", expiresAt: "2099-11-02T00:00:00.000Z" } });
  await fs.copyFile(path.join(bundle, "manifest.json"), path.join(resources, "baseline-release-manifest.json"));
  const args = [path.join(artifact, "CodeFlowAI.exe"), compiled, bundle, path.join(root, "new run")];
  return { root, artifact, resources, compiled, bundle, args };
}

test("titlebar preflight accepts compatible frozen shell and signed payload without creating output", async t => {
  const f = await fixture(t), result = await preflight(f.args);
  assert.equal(result.root, path.join(await fs.realpath(f.root), "new run"));
  assert.equal(result.manifest.releaseId, "titlebar-fixture");
  await assert.rejects(fs.access(f.args[3]!), { code: "ENOENT" });
});

test("titlebar preflight rejects missing and extra arguments", async () => {
  await assert.rejects(preflight([]), /用法/);
  await assert.rejects(preflight(["a", "b", "c", "d", "e"]), /用法/);
});

for (const target of ["artifact", "compiled", "bundle"] as const) {
  test(`titlebar output cannot overwrite or contain ${target} input`, async t => {
    const f = await fixture(t);
    await assert.rejects(preflight([...f.args.slice(0, 3), path.join(f[target], "new")]), /PATH_OVERLAP/);
    await assert.rejects(preflight([...f.args.slice(0, 3), f.root]), /PATH_OVERLAP/);
  });
}

test("titlebar preflight rejects an existing output and a junction into inputs", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.args[3]!);
  await assert.rejects(preflight(f.args), /OUTPUT_EXISTS/);
  const link = path.join(f.root, "redirect"); await fs.symlink(f.bundle, link, "junction");
  await assert.rejects(preflight([...f.args.slice(0, 3), path.join(link, "new")]), /PATH_OVERLAP/);
});

test("titlebar preflight rejects a stale compiled shell", async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.compiled, "main.js"), "changed");
  await assert.rejects(preflight(f.args), /ASAR_MISMATCH/);
});

test("titlebar preflight rejects an old shell without controls", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.compiled, "main.js"), "frame: true");
  await fs.writeFile(path.join(f.root, "asar/dist/main.js"), "frame: true");
  await asar.createPackage(path.join(f.root, "asar"), path.join(f.resources, "app.asar"));
  await assert.rejects(preflight(f.args), /TITLEBAR_REQUIRED/);
});

test("titlebar preflight rejects a corrupted archive", async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.bundle, "bundle.tar.gz"), "changed");
  await assert.rejects(preflight(f.args), /ARCHIVE_MISMATCH/);
});

test("titlebar preflight rejects a changed baseline Web", async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.resources, "web/titlebar.js"), "changed");
  await assert.rejects(preflight(f.args), /SHA-256/);
});

test("titlebar preflight rejects a modified manifest signature", async t => {
  const f = await fixture(t), file = path.join(f.bundle, "manifest.json"), manifest = JSON.parse(await fs.readFile(file, "utf8"));
  manifest.version = "2026.11.02.2"; await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(preflight(f.args), /SIGNATURE_INVALID/);
});

test("titlebar preflight requires the actual signed baseline proof used by startup", async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.resources, "baseline-release-manifest.json"));
  await assert.rejects(preflight(f.args), /ENOENT/);
});

test("titlebar process ownership refuses a reused root PID before registering descendants", () => {
  const input = { pid: 100, driverPid: 50, executable: "C:/test/CodeFlowAI.exe", profile: "C:/test/profile", launchAfter: 10_000 };
  const unrelated = { pid: 100, parentPid: 50, executable: "C:/other/tool.exe", commandLine: "tool.exe", created: new Date(11_000).toISOString() };
  assert.throws(() => collectOwnedProcesses([unrelated], input), /OWNERSHIP/);
  assert.deepEqual(collectOwnedProcesses([], input), []);
});

test("titlebar process ownership requires launch time and actual driver ancestry", () => {
  const input = { pid: 100, driverPid: 50, executable: "C:/test/CodeFlowAI.exe", profile: "C:/test/profile", launchAfter: 10_000 };
  const root = { pid: 100, parentPid: 50, executable: input.executable, commandLine: input.executable + " --user-data-dir=" + input.profile, created: new Date(11_000).toISOString() };
  const child = { pid: 101, parentPid: 100, executable: "C:/test/client.exe", commandLine: "client", created: new Date(12_000).toISOString() };
  assert.deepEqual(collectOwnedProcesses([root, child], input), [root, child]);
  assert.throws(() => collectOwnedProcesses([{ ...root, parentPid: 999 }], input), /OWNERSHIP/);
  assert.throws(() => collectOwnedProcesses([{ ...root, created: new Date(1_000).toISOString() }], input), /OWNERSHIP/);
});

test("titlebar process ownership binds the Windows launch wrapper to its actual packaged child", () => {
  const input = { pid: 90, driverPid: 50, executable: "C:/test/CodeFlowAI.exe", profile: "C:/test/profile", launchAfter: 10_000 };
  const wrapper = { pid: 90, parentPid: 50, executable: process.env.ComSpec!, commandLine: `cmd.exe /d /s /c "${input.executable}" --user-data-dir=${input.profile}`, created: new Date(11_000).toISOString() };
  const root = { pid: 100, parentPid: 90, executable: input.executable, commandLine: input.executable + " --user-data-dir=" + input.profile, created: new Date(11_000).toISOString() };
  assert.deepEqual(collectOwnedProcesses([wrapper, root], input), [wrapper, root]);
  assert.throws(() => collectOwnedProcesses([wrapper], input), /OWNERSHIP/);
  assert.throws(() => collectOwnedProcesses([wrapper, { ...root, executable: "C:/other/tool.exe" }], input), /OWNERSHIP/);
});

test("titlebar ownership excludes historical children of a reused parent PID", () => {
  const input = { pid: 100, driverPid: 50, executable: "C:/test/CodeFlowAI.exe", profile: "C:/test/profile", launchAfter: 10_000 };
  const root = { pid: 100, parentPid: 50, executable: input.executable, commandLine: input.executable + " --user-data-dir=" + input.profile, created: new Date(11_000).toISOString() };
  const child = { pid: 101, parentPid: 100, executable: "C:/test/client.exe", commandLine: "client", created: new Date(12_000).toISOString() };
  const historical = { pid: 300, parentPid: 101, executable: "C:/other/tool.exe", commandLine: "unrelated", created: new Date(1_000).toISOString() };
  assert.deepEqual(collectOwnedProcesses([root, child, historical], input), [root, child]);
});
