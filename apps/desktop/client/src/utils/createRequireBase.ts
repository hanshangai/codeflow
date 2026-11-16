import fs from "node:fs";
import path from "node:path";

/** 解析 createRequire 基准路径；CJS bundle 用自身文件，源码运行时定位 client 包。 */
export function resolveCreateRequireBase(): string {
  if (typeof __filename === "string") return __filename;
  const argvEntry = String(process.argv[1] ?? "").trim();
  const argvPath = argvEntry ? path.resolve(argvEntry) : "";
  if (argvPath && argvPath.includes(`${path.sep}apps${path.sep}desktop${path.sep}client${path.sep}`)) return argvPath;
  const repoClientPackage = path.resolve(process.cwd(), "apps", "desktop", "client", "package.json");
  if (fs.existsSync(repoClientPackage)) return repoClientPackage;
  const cwdPackage = path.resolve(process.cwd(), "package.json");
  if (fs.existsSync(cwdPackage)) return cwdPackage;
  return argvPath || process.cwd();
}
