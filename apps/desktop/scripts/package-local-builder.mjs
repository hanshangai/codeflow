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

/** electron-builder 在读取配置前直接校验 projectDir/package.json；用临时壳目录补零，不改源码清单。 */
export async function createBuilderProject(desktopDir, shellVersion) {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-build-"));
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(desktopDir, "package.json"), "utf8"));
    await fs.writeFile(path.join(stage, "package.json"),
      `${JSON.stringify({ ...packageJson, version: toBuilderVersion(shellVersion) }, null, 2)}\n`, "utf8");
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
