import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 每个用例使用独立目录，缓存不得共享调用方产物的可写文件。 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-build-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("cache restores verified files offline and never shares writable files", async t => {
  const { materializeDesktopBuildCache } = await import("../scripts/desktop-build-cache.mjs");
  const root = await fixture(t);
  const common = { cacheDir: path.join(root, "cache"), namespace: "web", key: "a".repeat(64) };
  let builds = 0;
  const first = await materializeDesktopBuildCache({ ...common, destination: path.join(root, "first"), build: async directory => {
    builds++;
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "index.html"), "original");
  } });
  assert.equal(first.hit, false);
  await fs.writeFile(path.join(root, "first/index.html"), "modified");
  const second = await materializeDesktopBuildCache({ ...common, destination: path.join(root, "second"), build: () => { throw new Error("OFFLINE"); } });
  assert.equal(second.hit, true);
  assert.equal(builds, 1);
  assert.equal(await fs.readFile(path.join(root, "second/index.html"), "utf8"), "original");
  await fs.writeFile(path.join(root, "cache/web", common.key, "payload/index.html"), "tampered");
  await assert.rejects(materializeDesktopBuildCache({ ...common, destination: path.join(root, "third"), build: () => { throw new Error("must not rebuild"); } }), /CACHE_CORRUPT/);
  await assert.rejects(fs.access(path.join(root, "third")), { code: "ENOENT" });
  await fs.writeFile(path.join(root, "cache/web", common.key, "payload/index.html"), "original");
  await fs.writeFile(path.join(root, "cache/web", common.key, "payload/extra.js"), "unsigned");
  await assert.rejects(materializeDesktopBuildCache({ ...common, destination: path.join(root, "extra"), build: () => { throw new Error("must not rebuild"); } }), /CACHE_CORRUPT/);
});

test("failed builds leave no hit and competing writers fail immediately", async t => {
  const { materializeDesktopBuildCache } = await import("../scripts/desktop-build-cache.mjs");
  const root = await fixture(t);
  const common = { cacheDir: path.join(root, "cache"), namespace: "dependencies", key: "b".repeat(64), destination: path.join(root, "package") };
  await assert.rejects(materializeDesktopBuildCache({ ...common, build: () => { throw new Error("DEPLOY_FAILED"); } }), /DEPLOY_FAILED/);
  assert.deepEqual(await fs.readdir(path.join(root, "cache/dependencies")), []);
  await fs.writeFile(path.join(root, "cache/dependencies", `${common.key}.lock`), "owner");
  await assert.rejects(materializeDesktopBuildCache({ ...common, build: () => { throw new Error("must not build"); } }), /CACHE_LOCKED/);
  assert.equal(await fs.readFile(path.join(root, "cache/dependencies", `${common.key}.lock`), "utf8"), "owner");
});

test("cache preserves falsy builder rejection reasons and removes its own partial state", async t => {
  const { materializeDesktopBuildCache } = await import("../scripts/desktop-build-cache.mjs");
  const root = await fixture(t);
  for (const reason of [undefined, null, false]) {
    await assert.rejects(materializeDesktopBuildCache({ cacheDir: path.join(root, "cache"), namespace: "web", key: "d".repeat(64), destination: path.join(root, "out"),
      build: () => Promise.reject(reason) }), error => error === reason);
    assert.deepEqual(await fs.readdir(path.join(root, "cache/web")), []);
  }
});

test("cache refuses links instead of following files outside its payload", async t => {
  const { materializeDesktopBuildCache } = await import("../scripts/desktop-build-cache.mjs");
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "outside"));
  await fs.writeFile(path.join(root, "outside/secret"), "outside");
  await assert.rejects(materializeDesktopBuildCache({ cacheDir: path.join(root, "cache"), namespace: "web", key: "c".repeat(64), destination: path.join(root, "out"), build: async directory => {
    await fs.mkdir(directory);
    await fs.symlink(path.join(root, "outside"), path.join(directory, "link"), "junction");
  } }), /CACHE_FILE_TYPE_INVALID/);
});

test("cache input keys bind source bytes and relevant environment without unrelated business invalidations", async t => {
  const { hashDesktopBuildInputs, selectDesktopBuildInputs } = await import("../scripts/desktop-build-cache.mjs");
  const root = await fixture(t);
  const files = ["apps/web/src/main.ts", "apps/desktop/client/src/index.ts", "apps/desktop/client/package.json", "apps/desktop/client/scripts/postinstall.mjs", "packages/shared/src/index.ts", "pnpm-lock.yaml", "package.json", "scripts/generate-site-seo.mjs", "tools/release/desktop-resources.mjs", "apps/web/.env.production"];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), file === "package.json" ? '{"version":"1","packageManager":"pnpm@10","pnpm":{"overrides":{}}}' : "before");
  }
  const webFiles = selectDesktopBuildInputs(files, "web");
  const dependencyFiles = selectDesktopBuildInputs(files, "dependencies");
  assert.ok(webFiles.includes("apps/web/.env.production"));
  assert.ok(webFiles.includes("packages/shared/src/index.ts"));
  assert.ok(!webFiles.includes("apps/desktop/client/src/index.ts"));
  assert.ok(!dependencyFiles.includes("apps/desktop/client/src/index.ts"));
  const context = { node: "24", pnpm: "10", platform: "win32", arch: "x64" };
  const key = kind => hashDesktopBuildInputs({ root, kind, files: kind === "web" ? webFiles : dependencyFiles, context, env: { VITE_PUBLIC: "one", SECRET: "ignored" } });
  const web = await key("web"), dependencies = await key("dependencies");
  await fs.writeFile(path.join(root, "apps/web/src/main.ts"), "after");
  assert.notEqual(await key("web"), web);
  assert.equal(await key("dependencies"), dependencies);
  await fs.writeFile(path.join(root, "package.json"), '{"version":"2","packageManager":"pnpm@10","pnpm":{"overrides":{}}}');
  assert.equal(await key("dependencies"), dependencies);
  await fs.writeFile(path.join(root, "apps/desktop/client/scripts/postinstall.mjs"), "changed");
  assert.notEqual(await key("dependencies"), dependencies);
  const a = await hashDesktopBuildInputs({ root, kind: "web", files: webFiles, context, env: { VITE_PUBLIC: "one", SECRET: "a" } });
  const b = await hashDesktopBuildInputs({ root, kind: "web", files: webFiles, context, env: { VITE_PUBLIC: "two", SECRET: "a" } });
  const c = await hashDesktopBuildInputs({ root, kind: "web", files: webFiles, context, env: { VITE_PUBLIC: "one", SECRET: "b" } });
  assert.notEqual(a, b);
  assert.equal(a, c);
  const changedRuntime = await hashDesktopBuildInputs({ root, kind: "web", files: webFiles, context: { ...context, node: "25" }, env: { VITE_PUBLIC: "one", SECRET: "a" } });
  assert.notEqual(a, changedRuntime);
  const deployEnvA = await hashDesktopBuildInputs({ root, kind: "dependencies", files: dependencyFiles, context, env: { npm_config_omit: "optional" } });
  const deployEnvB = await hashDesktopBuildInputs({ root, kind: "dependencies", files: dependencyFiles, context, env: { npm_config_omit: "dev" } });
  assert.notEqual(deployEnvA, deployEnvB);
});

test("Git input enumeration also binds untracked Vite environment files", async t => {
  const { desktopBuildCacheKey } = await import("../scripts/desktop-build-cache.mjs");
  const { spawnSync } = await import("node:child_process");
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "apps/web"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{}');
  for (const args of [["init", "--quiet"], ["add", "package.json"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
  }
  const before = await desktopBuildCacheKey({ root, kind: "web", context: {}, env: {} });
  await fs.writeFile(path.join(root, "apps/web/.env.local"), "VITE_PUBLIC=local");
  const after = await desktopBuildCacheKey({ root, kind: "web", context: {}, env: {} });
  assert.notEqual(before, after);
});

test("cache keys include uppercase package manager options and Web rejected deployment settings", async t => {
  const { hashDesktopBuildInputs } = await import("../scripts/desktop-build-cache.mjs");
  const root = await fixture(t);
  const key = (kind, env) => hashDesktopBuildInputs({ root, kind, files: [], context: {}, env });
  assert.notEqual(await key("dependencies", { NPM_CONFIG_OPTIONAL: "true" }), await key("dependencies", { NPM_CONFIG_OPTIONAL: "false" }));
  assert.notEqual(await key("dependencies", { NPM_CONFIG_IGNORE_SCRIPTS: "true" }), await key("dependencies", { NPM_CONFIG_IGNORE_SCRIPTS: "false" }));
  for (const setting of ["CODEFLOWAI_RELEASE_EDITION", "CODEFLOWAI_EDITION", "AIDT_EDITION"]) {
    assert.notEqual(await key("web", {}), await key("web", { [setting]: "community" }));
  }
});

test("Web cache follows the host's case rules for environment names", async () => {
  const { hashDesktopBuildInputs } = await import("../scripts/desktop-build-cache.mjs");
  const key = env => hashDesktopBuildInputs({ root: process.cwd(), kind: "web", files: [], context: {}, env });
  const empty = await key({});
  for (const name of ["VITE_CODEFLOWAI_SITE_ORIGIN", "CODEFLOWAI_SEO_INDEXING", "NODE_ENV", "CODEFLOWAI_RELEASE_EDITION", "CODEFLOWAI_EDITION", "AIDT_EDITION"]) {
    const lower = name.toLowerCase();
    if (process.platform === "win32") {
      assert.notEqual(await key({ [lower]: "one" }), empty, name);
      assert.notEqual(await key({ [lower]: "one" }), await key({ [lower]: "two" }), name);
      assert.equal(await key({ [lower]: "one" }), await key({ [name]: "one" }), name);
    } else {
      assert.equal(await key({ [lower]: "one" }), empty, name);
      assert.notEqual(await key({ [name]: "one" }), empty, name);
    }
  }
});

test("Windows Web cache uses the same duplicate environment value as the build child", { skip: process.platform !== "win32" }, async () => {
  const { hashDesktopBuildInputs } = await import("../scripts/desktop-build-cache.mjs");
  const { spawnSync } = await import("node:child_process");
  const env = { vite_codeflowai_site_origin: "shadowed", VITE_CODEFLOWAI_SITE_ORIGIN: "effective" };
  const child = spawnSync(process.execPath, ["--eval", "process.stdout.write(process.env.VITE_CODEFLOWAI_SITE_ORIGIN)"], { env, encoding: "utf8" });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "effective");
  const key = settings => hashDesktopBuildInputs({ root: process.cwd(), kind: "web", files: [], context: {}, env: settings });
  assert.equal(await key(env), await key({ VITE_CODEFLOWAI_SITE_ORIGIN: child.stdout }));
});

test("Windows cache keys stay stable when mixed-case names change their enumeration order", { skip: process.platform !== "win32" }, async () => {
  const { hashDesktopBuildInputs } = await import("../scripts/desktop-build-cache.mjs");
  for (const [kind, canonical, mixed] of [
    ["web", { VITE_A: "a", VITE_B: "b" }, { vite_a: "a", VITE_B: "b" }],
    ["dependencies", { NODE_ENV: "production", NPM_CONFIG_OPTIONAL: "false" }, { node_env: "production", NPM_CONFIG_OPTIONAL: "false" }],
  ]) {
    const key = env => hashDesktopBuildInputs({ root: process.cwd(), kind, files: [], context: {}, env });
    assert.equal(await key(canonical), await key(mixed));
  }
});

test("Windows cache publish retries transient rename failures", { skip: process.platform !== "win32" }, async t => {
  const { materializeDesktopBuildCache } = await import("../scripts/desktop-build-cache.mjs");
  const root = await fixture(t);
  const rename = fs.rename.bind(fs);
  let calls = 0;
  t.mock.method(fs, "rename", async (...args) => {
    calls++;
    if (calls <= 2) throw Object.assign(new Error("busy"), { code: "EPERM" });
    return rename(...args);
  });
  const result = await materializeDesktopBuildCache({ cacheDir: path.join(root, "cache"), namespace: "web", key: "e".repeat(64),
    destination: path.join(root, "out"), build: async directory => {
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "index.html"), "ok");
    } });
  assert.equal(result.hit, false);
  assert.ok(calls >= 3);
  assert.equal(await fs.readFile(path.join(root, "out/index.html"), "utf8"), "ok");
});

test("Windows cache publish falls back to copy when rename stays busy", { skip: process.platform !== "win32" }, async t => {
  const { materializeDesktopBuildCache } = await import("../scripts/desktop-build-cache.mjs");
  const root = await fixture(t);
  let calls = 0;
  t.mock.method(fs, "rename", async () => { calls++; throw Object.assign(new Error("busy"), { code: "EPERM" }); });
  const common = { cacheDir: path.join(root, "cache"), namespace: "web", key: "f".repeat(64) };
  const first = await materializeDesktopBuildCache({ ...common, destination: path.join(root, "first"), build: async directory => {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "index.html"), "ok");
  } });
  assert.equal(first.hit, false);
  assert.ok(calls >= 6);
  const second = await materializeDesktopBuildCache({ ...common, destination: path.join(root, "second"),
    build: () => { throw new Error("must not rebuild"); } });
  assert.equal(second.hit, true);
  assert.equal(await fs.readFile(path.join(root, "second/index.html"), "utf8"), "ok");
});
