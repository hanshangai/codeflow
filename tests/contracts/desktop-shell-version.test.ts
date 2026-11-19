import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createDesktopReleasePlan, readDesktopReleasePlan } from "../../tools/release/desktop-release-plan.mjs";

/** 使用真实临时 Git 提交，验证壳与资源的来源隔离。 */
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shell-version-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "package.json": '{"version":"2026.11.17.01"}',
    "apps/desktop/package.json": JSON.stringify({ version: "1.0", scripts: { build: "tsc" }, dependencies: { "@codeflowai/shared": "workspace:*" }, devDependencies: { electron: "45.0.0" } }),
    "apps/desktop/src/main.ts": 'import { value } from "@codeflowai/shared"; console.log(value);\n',
    "apps/desktop/build/installer.nsh": "installer",
    "apps/desktop/electron-builder.yml": "productName: CodeFlow",
    "apps/desktop/client/src/db/clientDbSchemaVersion.ts": "export const CLIENT_DB_SCHEMA_VERSION = 1;",
    "apps/desktop/client/src/main.ts": "client",
    "apps/desktop/tests/shell.test.ts": "test",
    "apps/web/src/main.ts": "web",
    "packages/shared/package.json": JSON.stringify({ exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" } } }),
    "packages/shared/src/index.ts": "export const value = 1;",
    "packages/shared/src/clientOnly.ts": "export const client = 1;",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  apps/desktop:\n    devDependencies:\n      electron:\n        specifier: 45.0.0\n        version: 45.0.0\n  apps/web:\n    dependencies: {}\npackages:\n  electron@45.0.0:\n    resolution: {integrity: electron}\nsnapshots:\n  electron@45.0.0: {}\n",
  };
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content, "utf8");
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ...Object.keys(files));
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  const planDir = path.join(root, ".git", "plans");
  const allocate = () => createDesktopReleasePlan({ root, planDir, platforms: ["win32/x64"], keyId: "fixture", expiresAt: "2099-01-01T00:00:00.000Z" });
  const change = async (file: string, content: string) => {
    await fs.appendFile(path.join(root, file), content, "utf8");
    git("add", file); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "change");
  };
  return { root, planDir, allocate, change };
}

test("shell allocation increments a legacy baseline and reuses unchanged inputs across resource and test commits", async t => {
  const f = await fixture(t);
  const first = await f.allocate();
  assert.equal(first.plan.shellVersion, "1.1");
  assert.match(first.plan.shellInputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await readDesktopReleasePlan({ root: f.root, file: first.file })).shellVersion, "1.1");
  for (const file of ["apps/web/src/main.ts", "apps/desktop/client/src/main.ts", "apps/desktop/tests/shell.test.ts", "packages/shared/src/clientOnly.ts"]) {
    await f.change(file, "\n// resource or test change");
    const next = await f.allocate();
    assert.equal(next.plan.shellVersion, "1.1");
    assert.equal(next.plan.shellInputFingerprint, first.plan.shellInputFingerprint);
  }
});

test("shell source, build, actual shared inputs and Electron resolution increment the final numeric segment", async t => {
  const f = await fixture(t);
  await f.allocate();
  let expected = 1;
  for (const file of ["apps/desktop/src/main.ts", "apps/desktop/build/installer.nsh", "packages/shared/src/index.ts"]) {
    await f.change(file, "\n// shell change");
    assert.equal((await f.allocate()).plan.shellVersion, `1.${++expected}`);
  }
  const lock = path.join(f.root, "pnpm-lock.yaml");
  await fs.writeFile(lock, (await fs.readFile(lock, "utf8")).replaceAll("45.0.0", "45.0.1"), "utf8");
  assert.equal((await createDesktopReleasePlan({ root: f.root, planDir: f.planDir, platforms: ["win32/x64"], keyId: "fixture", allowDirty: true })).plan.shellVersion, "1.5");
});

test("plan retry rejects changed shell inputs and corrupted history cannot bind one shell version to two fingerprints", async t => {
  const f = await fixture(t), first = await f.allocate();
  await fs.appendFile(path.join(f.root, "apps/desktop/src/main.ts"), "\n// dirty change", "utf8");
  await assert.rejects(readDesktopReleasePlan({ root: f.root, file: first.file, allowDirty: true }), /SHELL_INPUT_MISMATCH/);
  const conflict = { ...first.plan, version: "2026.11.18.999", shellInputFingerprint: "f".repeat(64) };
  await fs.writeFile(path.join(f.planDir, `${conflict.version}.json`), JSON.stringify(conflict), "utf8");
  await assert.rejects(createDesktopReleasePlan({ root: f.root, planDir: f.planDir, platforms: ["win32/x64"], keyId: "fixture", allowDirty: true }), /SHELL_VERSION_CONTENT_CONFLICT/);
});

test("exclusive allocation rejects concurrent planners without leaving a held lock", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.allocate(), f.allocate()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal((await f.allocate()).plan.shellVersion, "1.1");
});

test("legacy plans establish a conservative baseline and a three-part shell increments its last segment", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.planDir);
  await fs.writeFile(path.join(f.planDir, "2026.11.17.01.json"), JSON.stringify({ version: "2026.11.17.01", shellVersion: "1.0.9" }), "utf8");
  assert.equal((await f.allocate()).plan.shellVersion, "1.0.10");
});

test("checkout line endings and unrelated lock entries do not change shell input identity", async t => {
  const f = await fixture(t), first = await f.allocate();
  const source = path.join(f.root, "apps/desktop/src/main.ts");
  await fs.writeFile(source, (await fs.readFile(source, "utf8")).replaceAll("\n", "\r\n"), "utf8");
  await fs.appendFile(path.join(f.root, "pnpm-lock.yaml"), "\n  unrelated-web-only@1.0.0: {}\n", "utf8");
  const next = await createDesktopReleasePlan({ root: f.root, planDir: f.planDir, platforms: ["win32/x64"], keyId: "fixture", allowDirty: true });
  assert.equal(next.plan.shellVersion, "1.1");
  assert.equal(next.plan.shellInputFingerprint, first.plan.shellInputFingerprint);
});
