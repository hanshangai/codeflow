import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatDesktopVersion } from "@codeflowai/shared";
import { verifyReleaseBundlePayload } from "@codeflowai/shared/desktop-release-signing";
import { prepareRelease, verifyPreparedRelease } from "../scripts/prepare-release.mjs";
import { createDesktopReleasePlan } from "../../../tools/release/desktop-release-plan.mjs";
import { fileURLToPath } from "node:url";

/** 仅外部安装器构建用替身，其余编号、签名、文件与复验使用真实临时资源。 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-candidate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resourcesDir = path.join(root, "resources"), desktopDir = path.join(root, "desktop");
  const keys = crypto.generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(root, "private.pem"), notesFile = path.join(root, "notes.md");
  const files = {
    "resources/client/dist/index.cjs": "client",
    "resources/client/dist/desktop-startup-capability.json": JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1,
      clientEntrySha256: crypto.createHash("sha256").update("client").digest("hex") }),
    "resources/client/package.json": '{"version":"2026.11.09.01"}',
    "resources/client/npm/package.json": '{"version":"12.2.2"}',
    "resources/client/cli-runtime.json": "{}",
    "resources/web/index.html": "页面",
    "resources/release-trust.json": JSON.stringify({ fixture: keys.publicKey.export({ type: "spki", format: "pem" }) }),
    "desktop/package.json": '{"version":"1.0"}',
    "desktop/dist/main.js": "shell",
    "desktop/dist/preload.cjs": "preload",
    "desktop/electron-builder.yml": "productName: CodeFlow\n",
    "desktop/build/installer.nsh": "installer",
    "notes.md": "修复更新能力\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }
  await fs.writeFile(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  const packageInstaller = async ({ resourcesDir: source, outputDir }) => {
    const proof = JSON.parse(await fs.readFile(path.join(source, "baseline-release-manifest.json"), "utf8"));
    await verifyReleaseBundlePayload({ directory: source, manifest: proof, trustedKeys: { fixture: keys.publicKey },
      platform: "win32", arch: "x64", requireHeldStartup: true });
    await fs.mkdir(outputDir);
    const installer = path.join(outputDir, "CodeFlow-1.0.exe");
    await fs.writeFile(installer, `installer:${proof.version}`, "utf8");
    return { installer, shellVersion: "1.0", displayVersion: formatDesktopVersion("1.0", proof.version) };
  };
  return { root, resourcesDir, desktopDir, privateKeyFile, notesFile, packageInstaller,
    validateRuntime: async ({ resourcesDir: source }) => await fs.access(path.join(source, "client/dist/desktop-startup-capability.json")),
    outputRoot: path.join(root, "candidates"), baselineVersion: "2026.11.08.01", now: new Date(2026, 10, 9, 12),
    metadata: { webVersion: "2026.11.09.01", clientVersion: "2026.11.09.01", protocolVersion: 1, capabilityVersion: 1,
      dbSchemaVersion: 96, platform: "win32", arch: "x64", expiresAt: "2099-01-01T00:00:00.000Z", keyId: "fixture" } };
}

test("one candidate binds real resource, complete installer and notes and reuses its number on retry", async t => {
  const f = await fixture(t);
  const first = await prepareRelease(f);
  assert.equal(first.metadata.version, "2026.11.09.01");
  assert.equal(first.shellVersion, "1.0");
  assert.equal(first.displayVersion, "1.0.1109");
  assert.equal(await fs.readFile(path.join(first.directory, "release-notes.md"), "utf8"), "修复更新能力\n");
  const bundle = JSON.parse(await fs.readFile(path.join(first.directory, "bundle/manifest.json"), "utf8"));
  assert.equal(bundle.version, first.metadata.version);
  assert.equal(bundle.releaseId, first.metadata.releaseId);
  assert.equal((await verifyPreparedRelease({ directory: first.directory })).metadata.version, "2026.11.09.01");
  const second = await prepareRelease({ ...f, now: new Date(2026, 10, 10, 12),
    packageInstaller: async () => { throw new Error("finished candidate must not rebuild"); } });
  assert.equal(second.directory, first.directory);
  assert.deepEqual(await fs.readdir(f.outputRoot), ["2026.11.09.01"]);
});

test("a planned candidate consumes its allocated resource and shell versions without modifying the workspace manifest", async t => {
  const f = await fixture(t);
  const { file: planFile, plan } = await createDesktopReleasePlan({ root: fileURLToPath(new URL("../../..", import.meta.url)),
    platforms: ["win32/x64"], keyId: "fixture", planDir: path.join(f.root, "plans"), allowDirty: true });
  const before = await fs.readFile(path.join(f.desktopDir, "package.json"), "utf8");
  let attempts = 0;
  const input = { ...f, planFile, planRoot: fileURLToPath(new URL("../../..", import.meta.url)), allowDirty: true,
    packageInstaller: async ({ resourcesDir, outputDir, planFile: usedPlan }) => {
      assert.equal(usedPlan, planFile);
      const proof = JSON.parse(await fs.readFile(path.join(resourcesDir, "baseline-release-manifest.json"), "utf8"));
      assert.equal(proof.version, plan.version);
      if (++attempts === 1) throw new Error("planned build failed");
      await fs.mkdir(outputDir);
      const installer = path.join(outputDir, "planned.exe");
      await fs.writeFile(installer, "planned installer", "utf8");
      return { installer, shellVersion: plan.shellVersion, displayVersion: formatDesktopVersion(plan.shellVersion, plan.version) };
    } };
  await assert.rejects(prepareRelease(input), /planned build failed/);
  const candidate = await prepareRelease(input);
  assert.equal(candidate.shellVersion, plan.shellVersion);
  assert.equal(candidate.metadata.version, plan.version);
  assert.equal(candidate.sourceCommit, plan.sourceCommit);
  assert.equal(await fs.readFile(path.join(f.desktopDir, "package.json"), "utf8"), before);
});

test("changed content requires an explicit candidate and increments the same-day patch", async t => {
  const f = await fixture(t);
  await prepareRelease(f);
  await fs.appendFile(path.join(f.resourcesDir, "web/index.html"), "改动", "utf8");
  await assert.rejects(() => prepareRelease(f), /DESKTOP_CANDIDATE_INPUT_CHANGED/);
  const patch = await prepareRelease({ ...f, newCandidate: true });
  assert.equal(patch.metadata.version, "2026.11.09.02");
  assert.equal(patch.displayVersion, "1.0.1109.2");
});

for (const failed of [false, true]) {
  test(`retry selects numeric .100 over .99 when the latest installer ${failed ? "failed" : "completed"}`, async t => {
    const f = await fixture(t);
    const first = await prepareRelease({ ...f, baselineVersion: "2026.11.09.98" });
    assert.equal(first.metadata.version, "2026.11.09.99");
    const next = { ...f, newCandidate: true };
    if (failed) {
      next.packageInstaller = async () => { throw new Error("fixture latest installer failed"); };
      await assert.rejects(prepareRelease(next), /fixture latest installer failed/);
    } else assert.equal((await prepareRelease(next)).metadata.version, "2026.11.09.100");
    const replay = await prepareRelease(f);
    assert.equal(replay.metadata.version, "2026.11.09.100");
    assert.equal(replay.directory, path.join(f.outputRoot, "2026.11.09.100"));
    assert.deepEqual((await fs.readdir(f.outputRoot)).sort(), ["2026.11.09.100", "2026.11.09.99"]);
  });
}

test("next-year numbering uses the internal year and refuses a backwards clock", async t => {
  const f = await fixture(t);
  const next = await prepareRelease({ ...f, baselineVersion: "2026.12.31.99", now: new Date(2027, 0, 1, 12) });
  assert.equal(next.metadata.version, "2027.01.01.01");
  await assert.rejects(() => prepareRelease({ ...f, newCandidate: true }), /DESKTOP_CANDIDATE_CLOCK_BEHIND/);
});

test("installer failure retains the number and retries into a fresh attempt without overwriting", async t => {
  const f = await fixture(t);
  await assert.rejects(() => prepareRelease({ ...f, packageInstaller: async ({ outputDir }) => {
    await fs.mkdir(outputDir);
    await fs.writeFile(path.join(outputDir, "failed-marker"), "keep", "utf8");
    throw new Error("fixture installer failed");
  } }), /fixture installer failed/);
  const next = await prepareRelease(f);
  assert.equal(next.metadata.version, "2026.11.09.01");
  assert.equal(await fs.readFile(path.join(next.directory, "installer-attempt-1/failed-marker"), "utf8"), "keep");
  assert.match(next.installer.path, /^installer-attempt-2\//);
  const log = await fs.readFile(path.join(next.directory, "events.jsonl"), "utf8");
  assert.match(log, /DESKTOP_CANDIDATE_FAILED/);
  assert.match(log, /fixture installer failed/);
});

test("candidate verification fails explicitly on installer, archive or note corruption", async t => {
  for (const artifact of ["installer", "bundle/bundle.tar.gz", "release-notes.md"]) {
    const f = await fixture(t), candidate = await prepareRelease(f);
    const file = artifact === "installer" ? candidate.installer.path : artifact;
    await fs.appendFile(path.join(candidate.directory, file), "corrupt", "utf8");
    await assert.rejects(() => verifyPreparedRelease({ directory: candidate.directory }), /MISMATCH/);
    await assert.rejects(() => prepareRelease(f), /MISMATCH/);
  }
});

test("shell input changes require a new candidate and metadata cannot override the allocated version", async t => {
  const f = await fixture(t);
  await prepareRelease(f);
  await fs.appendFile(path.join(f.desktopDir, "dist/main.js"), "changed", "utf8");
  await assert.rejects(() => prepareRelease(f), /DESKTOP_CANDIDATE_INPUT_CHANGED/);
  await assert.rejects(() => prepareRelease({ ...f, metadata: { ...f.metadata, version: "wrong" } }), /METADATA_RESERVED/);
});

test("candidate output nested in payload and signing key inside input are rejected before writes", async t => {
  const f = await fixture(t);
  await assert.rejects(() => prepareRelease({ ...f, outputRoot: path.join(f.resourcesDir, "output") }), /OUTPUT_OVERLAP/);
  const privateKeyFile = path.join(f.resourcesDir, "client/private.pem");
  await fs.copyFile(f.privateKeyFile, privateKeyFile);
  await assert.rejects(() => prepareRelease({ ...f, privateKeyFile }), /PRIVATE_KEY_INSIDE/);
  await assert.rejects(() => fs.access(f.outputRoot), { code: "ENOENT" });
});

test("runtime compatibility failure stops candidate allocation and installer construction", async t => {
  const f = await fixture(t);
  await assert.rejects(() => prepareRelease({ ...f, validateRuntime: async () => { throw new Error("DESKTOP_RUNTIME_ABI_MISMATCH"); } }), /DESKTOP_RUNTIME_ABI_MISMATCH/);
  await assert.rejects(() => fs.access(f.outputRoot), { code: "ENOENT" });
});

test("retry refuses a corrupted archive before starting another installer attempt", async t => {
  const f = await fixture(t);
  await assert.rejects(() => prepareRelease({ ...f, packageInstaller: async () => { throw new Error("fixture failed"); } }), /fixture failed/);
  await fs.appendFile(path.join(f.outputRoot, "2026.11.09.01/bundle/bundle.tar.gz"), "corrupt", "utf8");
  let invoked = false;
  await assert.rejects(() => prepareRelease({ ...f, packageInstaller: async input => { invoked = true; return await f.packageInstaller(input); } }), /MISMATCH/);
  assert.equal(invoked, false);
});

test("shell changes during installer build fail instead of recording a completed candidate", async t => {
  const f = await fixture(t);
  await assert.rejects(() => prepareRelease({ ...f, packageInstaller: async input => {
    const result = await f.packageInstaller(input);
    await fs.appendFile(path.join(f.desktopDir, "dist/main.js"), "raced", "utf8");
    return result;
  } }), /INPUT_CHANGED_DURING_BUILD/);
  const record = JSON.parse(await fs.readFile(path.join(f.outputRoot, "2026.11.09.01/candidate.json"), "utf8"));
  assert.equal(record.installer, null);
});

test("standalone verification returns the candidate identity and never publishes", async t => {
  const f = await fixture(t), candidate = await prepareRelease(f);
  const result = execFileSync(process.execPath, ["--conditions=development", "--import", "tsx", "scripts/prepare-release.mjs", "--verify", candidate.directory],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  const ready = JSON.parse(result);
  assert.equal(ready.version, "2026.11.09.01");
  assert.equal(ready.published, false);
});

test("signing keys inside shell inputs or candidate artifacts are rejected before building", async t => {
  for (const location of ["dist/release-private.pem", "build/release-private.pem", "release-private.pem", "../candidates/release-private.pem"]) {
    const f = await fixture(t), privateKeyFile = path.resolve(f.desktopDir, location);
    await fs.mkdir(path.dirname(privateKeyFile), { recursive: true });
    await fs.copyFile(f.privateKeyFile, privateKeyFile);
    let invoked = false;
    await assert.rejects(() => prepareRelease({ ...f, privateKeyFile, packageInstaller: async () => { invoked = true; } }), /DESKTOP_CANDIDATE_PRIVATE_KEY_INSIDE_INPUT_OR_OUTPUT/);
    assert.equal(invoked, false);
    assert.equal((await fs.stat(privateKeyFile)).size, (await fs.stat(f.privateKeyFile)).size);
  }
});

test("a copied signing key inside a packaged shell tree is rejected even when the selected key is external", async t => {
  const f = await fixture(t);
  await fs.copyFile(f.privateKeyFile, path.join(f.desktopDir, "dist/copied-private.pem"));
  await assert.rejects(() => prepareRelease(f), /DESKTOP_CANDIDATE_PRIVATE_KEY_INSIDE_INPUT_OR_OUTPUT/);
  await assert.rejects(() => fs.access(f.outputRoot), { code: "ENOENT" });
});

test("a signing key cannot be copied into release notes through the notes input", async t => {
  const f = await fixture(t);
  await assert.rejects(() => prepareRelease({ ...f, notesFile: f.privateKeyFile }), /DESKTOP_CANDIDATE_PRIVATE_KEY_AS_NOTES/);
  await assert.rejects(() => fs.access(f.outputRoot), { code: "ENOENT" });
});

test("interrupted allocation reserves its date number and permits a later explicit candidate", async t => {
  const f = await fixture(t), interrupted = path.join(f.outputRoot, "2026.11.09.01");
  await fs.mkdir(interrupted, { recursive: true });
  await fs.writeFile(path.join(interrupted, "candidate.json.interrupted.tmp"), "partial", "utf8");
  const candidate = await prepareRelease({ ...f, newCandidate: true });
  assert.equal(candidate.metadata.version, "2026.11.09.02");
  assert.equal(await fs.readFile(path.join(interrupted, "candidate.json.interrupted.tmp"), "utf8"), "partial");
  const log = await fs.readFile(path.join(candidate.directory, "events.jsonl"), "utf8");
  assert.match(log, /DESKTOP_CANDIDATE_ALLOCATION_INCOMPLETE/);
  assert.match(log, /2026\.11\.09\.01/);
});

test("a failed initial record write remains explicit and the retry never reuses its allocated number", async t => {
  const f = await fixture(t), write = fs.writeFile.bind(fs);
  const probe = t.mock.method(fs, "writeFile", async (file, ...args) => {
    if (String(file).includes("candidate.json.")) throw Object.assign(new Error("fixture allocation disk failed"), { code: "EIO" });
    return await write(file, ...args);
  });
  await assert.rejects(() => prepareRelease(f), /fixture allocation disk failed/);
  probe.mock.restore();
  const candidate = await prepareRelease(f);
  assert.equal(candidate.metadata.version, "2026.11.09.02");
  await assert.rejects(() => fs.access(path.join(f.outputRoot, "2026.11.09.01/candidate.json")), { code: "ENOENT" });
});

test("an existing damaged candidate record still stops allocation even with --new", async t => {
  const f = await fixture(t), directory = path.join(f.outputRoot, "2026.11.09.01");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "candidate.json"), "{broken", "utf8");
  await assert.rejects(() => prepareRelease({ ...f, newCandidate: true }), SyntaxError);
  assert.deepEqual(await fs.readdir(f.outputRoot), ["2026.11.09.01"]);
});

test("a missing record beside built artifacts is corruption instead of an interrupted allocation", async t => {
  const f = await fixture(t), candidate = await prepareRelease(f);
  await fs.unlink(path.join(candidate.directory, "candidate.json"));
  await assert.rejects(() => prepareRelease({ ...f, newCandidate: true }), /DESKTOP_CANDIDATE_RECORD_MISSING/);
  assert.deepEqual(await fs.readdir(f.outputRoot), ["2026.11.09.01"]);
});
