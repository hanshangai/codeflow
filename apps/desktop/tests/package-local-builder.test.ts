import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBuilderProject, removeBuilderProject, resolveInstalledElectronDist, toBuilderVersion } from "../scripts/package-local-builder.mjs";

/** 仅构造架构校验所需的 DOS/PE 头，不启动测试二进制。 */
function peExecutable(machine: number) {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  bytes.writeUInt16LE(machine === 0x014c ? 224 : 240, 0x94);
  return bytes;
}

/** 构造已安装 Electron 的目录结构，不依赖下载缓存或真实 Electron 进程。 */
async function electronFixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "installed-electron-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimePath = process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
  await fs.mkdir(path.dirname(path.join(root, "dist", runtimePath)), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"electron","version":"45.0.0"}', "utf8");
  await fs.writeFile(path.join(root, "path.txt"), runtimePath, "utf8");
  await fs.writeFile(path.join(root, "dist", "version"), "45.0.0\n", "utf8");
  await fs.writeFile(path.join(root, "dist", runtimePath), process.platform === "win32"
    ? peExecutable(process.arch === "x64" ? 0x8664 : process.arch === "arm64" ? 0xaa64 : 0x014c) : "runtime");
  return { root, runtimePath };
}

test("resolves the installed unpacked Electron distribution with its exact version", async t => {
  const { root } = await electronFixture(t);
  assert.deepEqual(await resolveInstalledElectronDist({ electronPackageDir: root }), {
    electronDist: await fs.realpath(path.join(root, "dist")), electronVersion: "45.0.0",
  });
});

test("installed Electron rejects version drift, missing files, links and foreign targets", async t => {
  const { root, runtimePath } = await electronFixture(t);
  await assert.rejects(resolveInstalledElectronDist({ electronPackageDir: root, platform: "foreign" }), /DESKTOP_LOCAL_ELECTRON_TARGET_MISMATCH/);
  await assert.rejects(resolveInstalledElectronDist({ electronPackageDir: root, arch: "foreign" }), /DESKTOP_LOCAL_ELECTRON_TARGET_MISMATCH/);
  await fs.writeFile(path.join(root, "dist", "version"), "44.0.0", "utf8");
  await assert.rejects(resolveInstalledElectronDist({ electronPackageDir: root }), /DESKTOP_LOCAL_ELECTRON_VERSION_MISMATCH/);
  await fs.writeFile(path.join(root, "dist", "version"), "45.0.0", "utf8");
  await fs.rm(path.join(root, "dist", runtimePath));
  await assert.rejects(resolveInstalledElectronDist({ electronPackageDir: root }), { code: "ENOENT" });
  await fs.rm(path.join(root, "dist"), { recursive: true });
  const linked = path.join(root, "linked-dist");
  await fs.mkdir(linked);
  await fs.symlink(linked, path.join(root, "dist"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(resolveInstalledElectronDist({ electronPackageDir: root }), /DESKTOP_LOCAL_ELECTRON_PATH_INVALID/);
});

test("installed Windows Electron rejects a same-version binary with a different PE architecture", { skip: process.platform !== "win32" }, async t => {
  const { root, runtimePath } = await electronFixture(t);
  const ownMachine = process.arch === "x64" ? 0x8664 : process.arch === "arm64" ? 0xaa64 : 0x014c;
  for (const machine of [0x8664, 0xaa64, 0x014c, 0xffff].filter(value => value !== ownMachine)) {
    await fs.writeFile(path.join(root, "dist", runtimePath), peExecutable(machine));
    await assert.rejects(resolveInstalledElectronDist({ electronPackageDir: root }), /DESKTOP_LOCAL_ELECTRON_ARCH_MISMATCH/);
  }
});

test("installed Windows Electron rejects malformed or truncated PE headers", { skip: process.platform !== "win32" }, async t => {
  const { root, runtimePath } = await electronFixture(t);
  const missingDos = peExecutable(0x8664), missingPe = peExecutable(0x8664), badOffset = peExecutable(0x8664), shortOffset = peExecutable(0x8664);
  missingDos.write("XX");
  missingPe.writeUInt32LE(0, 0x80);
  badOffset.writeUInt32LE(0xffffffff, 0x3c);
  shortOffset.writeUInt32LE(0, 0x3c);
  const oversizedOptional = peExecutable(0x8664), emptyOptional = peExecutable(0x8664);
  oversizedOptional.writeUInt16LE(0xffff, 0x94);
  emptyOptional.writeUInt16LE(0, 0x94);
  for (const bytes of [Buffer.from("runtime"), missingDos, missingPe, badOffset, shortOffset, oversizedOptional, emptyOptional,
    peExecutable(0x8664).subarray(0, 0x85), peExecutable(0x8664).subarray(0, 0x98)]) {
    await fs.writeFile(path.join(root, "dist", runtimePath), bytes);
    await assert.rejects(resolveInstalledElectronDist({ electronPackageDir: root }), /DESKTOP_LOCAL_ELECTRON_BINARY_INVALID/);
  }
});

test("stages a normalized shell manifest and cleans links without touching source", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "package-builder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const desktop = path.join(root, "desktop");
  for (const [relative, text] of Object.entries({
    "package.json": '{"version":"1.0"}', "dist/main.js": "main", "build/installer.nsh": "nsh",
    "node_modules/dep/package.json": "{}",
  })) {
    const file = path.join(desktop, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
  }
  const stage = await createBuilderProject(desktop, "1.0");
  try {
    assert.equal(JSON.parse(await fs.readFile(path.join(stage, "package.json"), "utf8")).version, "1.0.0");
    assert.equal(await fs.readFile(path.join(stage, "dist/main.js"), "utf8"), "main");
    assert.equal(await fs.readFile(path.join(stage, "node_modules/dep/package.json"), "utf8"), "{}");
    await fs.access(path.join(stage, "build/installer.nsh"));
  } finally {
    await removeBuilderProject(stage);
  }
  await assert.rejects(fs.lstat(stage), { code: "ENOENT" });
  assert.equal(JSON.parse(await fs.readFile(path.join(desktop, "package.json"), "utf8")).version, "1.0");
  assert.equal(toBuilderVersion("1.0"), "1.0.0");
  assert.equal(toBuilderVersion("1.0.0"), "1.0.0");
});
