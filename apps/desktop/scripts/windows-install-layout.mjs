import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { buildShellLauncher } from "./build-shell-launcher.mjs";

/** 仅修改未签名打包工件的展示字符串，保留 PE 固定数字版本。 */
export async function writeWindowsDisplayVersion(executablePath, displayVersion) {
  const requireBuilder = createRequire(createRequire(import.meta.url).resolve("electron-builder"));
  const { NtExecutable, NtExecutableResource, Resource } = createRequire(requireBuilder.resolve("app-builder-lib"))("resedit");
  const executable = NtExecutable.from(await fs.readFile(executablePath));
  const resources = NtExecutableResource.from(executable);
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  if (versions.length === 0) throw new Error("DESKTOP_WINDOWS_VERSION_RESOURCE_MISSING");
  for (const version of versions) {
    const languages = version.getAllLanguagesForStringValues();
    if (languages.length === 0) throw new Error("DESKTOP_WINDOWS_VERSION_LANGUAGE_MISSING");
    for (const language of languages) version.setStringValues(language, { FileVersion: displayVersion, ProductVersion: displayVersion });
    version.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(executable);
  await fs.writeFile(executablePath, Buffer.from(executable.generate()));
}

/** 打包输入只允许普通目录和文件，链接不能随布局移动进入安装包。 */
async function assertPayloadTree(entry) {
  const stat = await fs.lstat(entry);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error("DESKTOP_WINDOWS_INSTALL_LAYOUT_ENTRY_INVALID");
  }
  if (stat.isDirectory()) {
    for (const child of await fs.readdir(entry)) await assertPayloadTree(path.join(entry, child));
  }
}

/** 仅转换 builder 的新平铺工件；验证先于移动，最后写入与完整目录一致的启动选择。 */
export async function prepareWindowsInstallLayout({ appOutDir, launcherExecutable }) {
  const rootStat = await fs.lstat(appOutDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("DESKTOP_WINDOWS_INSTALL_LAYOUT_ENTRY_INVALID");
  const root = await fs.realpath(appOutDir), launcher = await fs.realpath(launcherExecutable);
  const entries = await fs.readdir(root);
  if (entries.some(entry => ["shells", "shell-launch.ini"].includes(entry.toLowerCase()))) {
    throw new Error("DESKTOP_WINDOWS_INSTALL_LAYOUT_ALREADY_VERSIONED");
  }
  const relative = path.relative(root, launcher);
  if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error("DESKTOP_WINDOWS_INSTALL_LAYOUT_LAUNCHER_OVERLAP");
  }
  const launcherStat = await fs.lstat(launcherExecutable);
  if (!launcherStat.isFile() || launcherStat.isSymbolicLink() || launcherStat.size === 0) {
    throw new Error("DESKTOP_WINDOWS_INSTALL_LAYOUT_ENTRY_INVALID");
  }
  for (const entry of ["CodeFlowAI.exe", "resources/app.asar", "resources/baseline-release-manifest.json",
    "resources/client/dist/index.cjs", "resources/client/dist/desktopUninstallWorker.cjs", "resources/web/index.html", "resources/release-trust.json"]) {
    if (!(await fs.lstat(path.join(root, entry))).isFile()) throw new Error("DESKTOP_WINDOWS_INSTALL_LAYOUT_ENTRY_INVALID");
  }
  await assertPayloadTree(root);
  const shell = path.join(root, "shells", "installation");
  await fs.mkdir(path.join(root, "shells"));
  await fs.mkdir(shell);
  for (const entry of entries) await fs.rename(path.join(root, entry), path.join(shell, entry));
  await fs.copyFile(launcher, path.join(root, "CodeFlowAI.exe"), fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(root, "shell-launch.ini"),
    "[shell]\r\nschema=1\r\nactive=installation\r\nprevious=\r\nbaseline=installation\r\n", { encoding: "ascii", flag: "wx" });
}

/** NSIS 归档前修正展示属性，再构建真实壳号启动器并转换新工件布局。 */
export default async function afterSign(context) {
  if (context.electronPlatformName !== "win32") throw new Error("DESKTOP_WINDOWS_INSTALL_LAYOUT_PLATFORM_INVALID");
  const metadata = context.packager.info.metadata;
  if (metadata.desktopDisplayVersion) await writeWindowsDisplayVersion(path.join(context.appOutDir, "CodeFlowAI.exe"), metadata.desktopDisplayVersion);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-install-launcher-"));
  let failure;
  try {
    const iconPath = await context.packager.getIconPath();
    const launcherExecutable = await buildShellLauncher({ outputDir: path.join(temporary, "launcher"),
      version: metadata.shellVersion ?? context.packager.appInfo.version, ...(iconPath ? { iconPath } : {}) });
    await prepareWindowsInstallLayout({ appOutDir: context.appOutDir, launcherExecutable });
    // NSIS 会在归档及收尾时写入根 resources/elevate.exe，保留其安装辅助目录。
    await fs.mkdir(path.join(context.appOutDir, "resources"));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await fs.rm(temporary, { recursive: true }); }
    catch (cleanup) {
      if (failure) throw new AggregateError([failure, cleanup], "DESKTOP_WINDOWS_INSTALL_LAYOUT_CLEANUP_FAILED");
      throw cleanup;
    }
  }
}
