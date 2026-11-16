import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyNpmPackage } from "../scripts/cli-runtime-resources.mjs";

test("copies the bundled npm package and rejects version mismatch", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-resources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "npm"), target = path.join(root, "out");
  await fs.mkdir(path.join(source, "bin"), { recursive: true });
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "npm", version: "12.2.2" }));
  await fs.writeFile(path.join(source, "bin", "npm-cli.js"), "fake npm cli", "utf8");
  await copyNpmPackage({ npmPackageDir: source, targetDir: target, expectedVersion: "12.2.2" });
  assert.equal(await fs.readFile(path.join(target, "bin", "npm-cli.js"), "utf8"), "fake npm cli");
  await assert.rejects(
    () => copyNpmPackage({ npmPackageDir: source, targetDir: path.join(root, "bad"), expectedVersion: "11.0.0" }),
    (error: unknown) => (error as { code?: string; message?: string }).code === "DESKTOP_NPM_VERSION_MISMATCH"
      && /DESKTOP_NPM_VERSION_MISMATCH/u.test(String((error as { message?: string }).message)),
  );
});

test("rejects an npm package without bin/npm-cli.js before copying", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-resources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "npm-without-bin"), target = path.join(root, "out");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "npm", version: "12.2.2" }), "utf8");
  await assert.rejects(
    () => copyNpmPackage({ npmPackageDir: source, targetDir: target, expectedVersion: "12.2.2" }),
    (error: unknown) => (error as { code?: string }).code === "DESKTOP_NPM_PACKAGE_INVALID",
  );
  await assert.rejects(fs.access(target), { code: "ENOENT" });
});

test("rejects a non-npm package with a coded error before copying", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-resources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "not-npm"), target = path.join(root, "out");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "not-npm", version: "12.2.2" }), "utf8");
  await assert.rejects(
    () => copyNpmPackage({ npmPackageDir: source, targetDir: target, expectedVersion: "12.2.2" }),
    (error: unknown) => (error as { code?: string; message?: string }).code === "DESKTOP_NPM_PACKAGE_INVALID"
      && /DESKTOP_NPM_PACKAGE_INVALID/u.test(String((error as { message?: string }).message)),
  );
  await assert.rejects(fs.access(target), { code: "ENOENT" });
});
