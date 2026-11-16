import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyDesktopClientRuntime } from "../scripts/prepare-resources.mjs";
import { resolveClientBuildVersion } from "../client/scripts/build-version.mjs";

test("planned build version wins over a changed repository version", () => {
  assert.equal(resolveClientBuildVersion("2026.11.11.02", "2026.11.11.01"), "2026.11.11.01");
  assert.equal(resolveClientBuildVersion("2026.11.11.02", undefined), "2026.11.11.02");
  for (const invalid of ["", "latest", "1.0", "2026.11.11.01\nextra"]) {
    assert.throws(() => resolveClientBuildVersion("2026.11.11.02", invalid), { code: "DESKTOP_CLIENT_BUILD_VERSION_INVALID" });
  }
});

async function fixture(context, body) {
  const clientDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-client-version-"));
  context.after(() => fs.rm(clientDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(clientDir, "dist"));
  await fs.mkdir(path.join(clientDir, "node_modules"));
  await fs.writeFile(path.join(clientDir, "package.json"), JSON.stringify({ dependencies: {} }));
  await fs.writeFile(path.join(clientDir, "dist/index.cjs"), body);
  return { clientDir, runtimeExecutable: process.execPath, expectedClientVersion: "2026.11.11.01" };
}

test("release preflight rejects an actual Client version different from the plan", async context => {
  const options = await fixture(context, 'console.log("2026.11.11.02");');
  await assert.rejects(verifyDesktopClientRuntime(options), { code: "DESKTOP_CLIENT_VERSION_MISMATCH" });
});

test("release preflight accepts the actual planned version", async context => {
  const options = await fixture(context, 'if (process.argv[2] !== "--version") process.exit(2); console.log("2026.11.11.01");');
  const runtime = await verifyDesktopClientRuntime(options);
  assert.equal(runtime.nodeMajor, Number(process.versions.node.split(".")[0]));
});

test("external runtime version override cannot hide a stale bundle", async context => {
  const previous = process.env.CODEFLOWAI_VERSION;
  context.after(() => { if (previous === undefined) delete process.env.CODEFLOWAI_VERSION; else process.env.CODEFLOWAI_VERSION = previous; });
  process.env.CODEFLOWAI_VERSION = "2026.11.11.01";
  const options = await fixture(context, 'console.log(process.env.CODEFLOWAI_VERSION || "2026.11.11.02");');
  await assert.rejects(verifyDesktopClientRuntime(options), { code: "DESKTOP_CLIENT_VERSION_MISMATCH" });
});

test("failed version probe stops release preflight", async context => {
  const options = await fixture(context, 'process.stderr.write("probe failed"); process.exit(7);');
  await assert.rejects(verifyDesktopClientRuntime(options), { code: "DESKTOP_CLIENT_RUNTIME_INCOMPATIBLE" });
});
