import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareNumericVersion } from "@codeflowai/shared";

declare const CODEFLOWAI_BUNDLED_VERSION: string | undefined;

/**
 * 读取自身版本号（统一版本源）：
 * 1. 优先读取 `CODEFLOWAI_VERSION`
 * 2. 读取构建时注入的 bundle 版本（发布包场景）
 * 3. 向上查找公开仓库或旧 monorepo 根 package.json
 * 4. 兜底：直接上级 package.json 的 version（npm 安装包模式）
 */
export function readSelfVersion(): string | null {
  // 1. env 优先（生产环境统一维护）
  const fromEnv = (process.env.CODEFLOWAI_VERSION ?? "").trim();
  if (fromEnv) return fromEnv;

  const fromBundled = readBundledVersion();
  if (fromBundled) return fromBundled;

  const fromArgv = String(process.argv[1] ?? "").trim();
  const fromImportMeta = resolveImportMetaUrl();
  const thisFile =
    typeof __filename === "string" && __filename
      ? __filename
      : fromArgv
        ? path.resolve(fromArgv)
        : fromImportMeta
          ? fileURLToPath(fromImportMeta)
          : path.resolve(process.cwd(), "index.js");
  const thisDir = path.dirname(thisFile);

  // 源码运行兼容公开新仓与旧monorepo；不读取私有Server根版本。
  let dir = thisDir;
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, "package.json");
    const ver = readVersionIfName(pkgPath, ["codeflow", "codeflowai"]);
    if (ver) return ver;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3. 兜底：直接上级 package.json（npm install 模式，release 脚本注入了 version）
  const clientPkgPath = path.resolve(thisDir, "..", "package.json");
  return readVersionFromPackageJson(clientPkgPath);
}

/** 读取构建时注入的版本常量，兜住发布包缺少源码树 package.json 的场景。 */
function readBundledVersion(): string | null {
  try {
    if (typeof CODEFLOWAI_BUNDLED_VERSION !== "string") return null;
    const version = CODEFLOWAI_BUNDLED_VERSION.trim();
    return version || null;
  } catch {
    return null;
  }
}

/** 读取 package.json 中 version 字段（仅当 name 匹配时）。 */
function readVersionIfName(pkgPath: string, expectedNames: readonly string[]): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (!expectedNames.includes(String(pkg?.name ?? ""))) return null;
    const version = String(pkg?.version ?? "").trim();
    return version || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readVersionFromPackageJson(pkgPath: string): string | null {
  try {
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const version = String(pkg?.version ?? "").trim();
    return version || null;
  } catch {
    return null;
  }
}

function resolveImportMetaUrl(): string | null {
  try {
    const value = Function("return import.meta.url")();
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

/** 轻量版本比较（支持 3 段及以上数字版本号），返回 -1/0/1 */
export function compareSemver(a: string, b: string): number {
  return compareNumericVersion(a, b);
}
