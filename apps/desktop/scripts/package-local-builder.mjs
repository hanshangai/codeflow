import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

/** electron-builder 只接受三段 semver；源码壳版本可保持两位，打包元数据补零。 */
export function toBuilderVersion(version) {
  return /^\d+\.\d+$/.test(version) ? `${version}.0` : version;
}

/** 临时壳目录没有 lockfile，显式读取已安装 Electron 精确版本供 builder 使用。 */
export async function resolveElectronVersion() {
  const packageFile = createRequire(import.meta.resolve("electron-builder")).resolve("electron/package.json");
  return JSON.parse(await fs.readFile(packageFile, "utf8")).version;
}

/** 只读 Windows 可执行头，拒绝损坏文件及与目标不符的真实架构。 */
async function assertWindowsElectronArch(runtime, arch) {
  const file = await fs.open(runtime, "r");
  let failure;
  try {
    const dos = Buffer.alloc(64), pe = Buffer.alloc(24);
    if ((await file.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) {
      throw new Error("DESKTOP_LOCAL_ELECTRON_BINARY_INVALID");
    }
    const offset = dos.readUInt32LE(0x3c);
    const size = (await file.stat()).size;
    if (offset < dos.length || offset > size - pe.length
      || (await file.read(pe, 0, pe.length, offset)).bytesRead !== pe.length || pe.readUInt32LE(0) !== 0x00004550) {
      throw new Error("DESKTOP_LOCAL_ELECTRON_BINARY_INVALID");
    }
    const optionalSize = pe.readUInt16LE(20);
    if (optionalSize < 2 || offset + pe.length + optionalSize > size) throw new Error("DESKTOP_LOCAL_ELECTRON_BINARY_INVALID");
    const machine = pe.readUInt16LE(4), expected = { x64: 0x8664, ia32: 0x014c, arm64: 0xaa64 }[arch];
    if (machine !== expected) throw new Error(`DESKTOP_LOCAL_ELECTRON_ARCH_MISMATCH: expected=${arch}, machine=0x${machine.toString(16)}`);
  } catch (error) {
    failure = { error };
  }
  try { await file.close(); }
  catch (error) {
    throw failure ? new AggregateError([failure.error, error], "DESKTOP_LOCAL_ELECTRON_CLOSE_FAILED") : error;
  }
  if (failure) throw failure.error;
}

/** 复用本机已解压 Electron；校验版本、路径及 Windows PE 架构，不查询下载缓存。 */
export async function resolveInstalledElectronDist({ electronPackageDir, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== process.platform || arch !== process.arch) throw new Error("DESKTOP_LOCAL_ELECTRON_TARGET_MISMATCH");
  const packageDirectory = electronPackageDir ?? path.dirname(createRequire(import.meta.resolve("electron-builder")).resolve("electron/package.json"));
  const packageRoot = await fs.realpath(packageDirectory);
  const electronDist = path.join(packageRoot, "dist");
  for (const [entry, directory] of [[electronDist, true], [path.join(packageRoot, "package.json"), false], [path.join(packageRoot, "path.txt"), false],
    [path.join(electronDist, "version"), false]]) {
    const stat = await fs.lstat(entry);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`DESKTOP_LOCAL_ELECTRON_PATH_INVALID: ${entry}`);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  const electronVersion = manifest.version;
  if (manifest.name !== "electron" || typeof electronVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(electronVersion)
    || (await fs.readFile(path.join(electronDist, "version"), "utf8")).trim() !== electronVersion) {
    throw new Error("DESKTOP_LOCAL_ELECTRON_VERSION_MISMATCH");
  }
  const runtimePath = platform === "win32" ? "electron.exe" : platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
  if ((await fs.readFile(path.join(packageRoot, "path.txt"), "utf8")).trim() !== runtimePath) throw new Error("DESKTOP_LOCAL_ELECTRON_PATH_INVALID");
  const runtime = path.join(electronDist, runtimePath), stat = await fs.lstat(runtime);
  if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(runtime) !== runtime) throw new Error("DESKTOP_LOCAL_ELECTRON_PATH_INVALID");
  if (platform === "win32") await assertWindowsElectronArch(runtime, arch);
  return { electronDist, electronVersion };
}

/** 复制壳产物；可选目录不存在时静默跳过。 */
async function copyDirectory(source, target, excluded) {
  try { await fs.lstat(source); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  await fs.cp(source, target, { recursive: true, ...(excluded ? { filter: entry => path.resolve(entry) !== excluded } : {}) });
}

/** 优先链接依赖树，失败时回退复制；可选目录不存在时静默跳过。 */
async function linkOrCopy(source, target) {
  try { await fs.lstat(source); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  try { await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir"); }
  catch { await fs.cp(source, target, { recursive: true }); }
}

/** 删除临时壳目录前先移除链接，避免 Windows 递归删除进入链接目标。 */
export async function removeBuilderProject(stage) {
  for (const entry of await fs.readdir(stage)) {
    const target = path.join(stage, entry);
    if ((await fs.lstat(target)).isSymbolicLink()) await fs.unlink(target);
  }
  await fs.rm(stage, { recursive: true, force: true });
}

/** 临时清单保存精确计划壳号；builder 的 semver 独立补零，不改工作区清单。 */
export async function createBuilderProject(desktopDir, shellVersion) {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-build-"));
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(desktopDir, "package.json"), "utf8"));
    await fs.writeFile(path.join(stage, "package.json"),
      `${JSON.stringify({ ...packageJson, version: toBuilderVersion(shellVersion), shellVersion }, null, 2)}\n`, "utf8");
    /** electron-builder 不跟随 dist 目录链接，壳产物必须复制；资源目录由 extraResources 单独携带。 */
    const resourcesDir = path.resolve(desktopDir, "dist", "resources");
    await copyDirectory(path.join(desktopDir, "dist"), path.join(stage, "dist"), resourcesDir);
    await copyDirectory(path.join(desktopDir, "build"), path.join(stage, "build"));
    await linkOrCopy(path.join(desktopDir, "node_modules"), path.join(stage, "node_modules"));
    return stage;
  } catch (error) {
    try { await removeBuilderProject(stage); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "DESKTOP_LOCAL_PACKAGE_CLEANUP_FAILED"); }
    throw error;
  }
}
