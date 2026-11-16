import os from "node:os";
import path from "node:path";

/** 稳定的 electron-builder 工具缓存；位于用户缓存目录，跨构建复用 NSIS/7zip。 */
export function resolveSharedShellBuilderCache() {
  const base = process.platform === "win32"
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
    : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"));
  if (!base) throw new Error("DESKTOP_SHELL_BUILD_CACHE_HOME_UNRESOLVED");
  return path.join(base, "electron-builder", "Cache", "codeflow-shell");
}
