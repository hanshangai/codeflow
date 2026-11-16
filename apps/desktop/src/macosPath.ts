import fs from "node:fs";
import path from "node:path";

type MacOSPathDeps = {
  exists?: (target: string) => boolean;
  readdir?: (directory: string) => string[];
};

/** Finder 启动的 macOS 应用只继承 launchd 最小 PATH；补充 Homebrew、用户级与 Node 版本管理器目录。 */
export function augmentMacOSGuiPath(
  env: Readonly<Record<string, string | undefined>>,
  deps: MacOSPathDeps = {},
): string {
  const exists = deps.exists ?? ((target: string): boolean => {
    try { return fs.statSync(target).isDirectory(); }
    catch { return false; }
  });
  const readdir = deps.readdir ?? ((directory: string): string[] => {
    try { return fs.readdirSync(directory); }
    catch { return []; }
  });
  const posix = path.posix;
  const entries = String(env.PATH ?? "").split(":").filter(Boolean);
  const seen = new Set(entries);
  const add = (target: string | undefined): void => {
    if (!target) return;
    const normalized = posix.normalize(target);
    if (!seen.has(normalized) && exists(normalized)) {
      seen.add(normalized);
      entries.push(normalized);
    }
  };

  for (const target of ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"]) add(target);
  const home = String(env.HOME ?? "").trim();
  if (!home) return entries.join(":");
  for (const relative of [".local/bin", ".npm-global/bin", ".volta/bin", ".bun/bin", ".asdf/shims", ".claude/local"]) {
    add(posix.join(home, relative));
  }
  const versionManagers = [
    [posix.join(home, ".nvm", "versions", "node"), "bin"],
    [posix.join(home, ".local", "share", "fnm", "node-versions"), posix.join("installation", "bin")],
    [posix.join(home, ".fnm", "node-versions"), posix.join("installation", "bin")],
  ] as const;
  for (const [root, suffix] of versionManagers) {
    for (const version of readdir(root).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))) {
      add(posix.join(root, version, suffix));
    }
  }
  add(posix.join(home, ".nvm", "current", "bin"));
  return entries.join(":");
}
