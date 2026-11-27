import fs from "node:fs";
import path from "node:path";

/** 固定 origin 不接受凭据、路径或参数；错误仅带固定代码，不回显配置正文。 */
function validateOrigin(value: unknown): string {
  const invalid = () => Object.assign(new Error("DESKTOP_UPDATE_CONFIG_INVALID"), { code: "DESKTOP_UPDATE_CONFIG_INVALID" });
  if (typeof value !== "string" || !URL.canParse(value)) throw invalid();
  const origin = new URL(value);
  if (origin.origin !== value || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw invalid();
  return value;
}

/** 壳安装配置优先；仅未携带配置的旧工件/开发态沿用显式环境或离线模式。 */
export function readInstalledUpdateOrigin(resourcesDir: string, environmentOrigin?: string): string | undefined {
  const file = path.join(resourcesDir, "desktop-update.json");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const configured = environmentOrigin?.trim();
    return configured ? validateOrigin(configured) : undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error("DESKTOP_UPDATE_CONFIG_INVALID"), { code: "DESKTOP_UPDATE_CONFIG_INVALID" });
  let config: unknown;
  const bytes = fs.readFileSync(file);
  try { config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) {
    throw Object.assign(new Error("DESKTOP_UPDATE_CONFIG_INVALID", { cause: new Error(error instanceof SyntaxError ? "INVALID_JSON" : "INVALID_UTF8") }),
      { code: "DESKTOP_UPDATE_CONFIG_INVALID" });
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).length !== 1 || !("serverOrigin" in config)) {
    throw Object.assign(new Error("DESKTOP_UPDATE_CONFIG_INVALID"), { code: "DESKTOP_UPDATE_CONFIG_INVALID" });
  }
  return validateOrigin(config.serverOrigin);
}

/** 从当前安装的更新来源构造固定平台下载地址，离线和不支持的平台无下载入口。 */
export function readDesktopRepairDownloadUrl(resourcesDir: string, platform: string, arch: string): string | undefined {
  const target = platform === "win32" && arch === "x64" ? "windows-x64"
    : platform === "darwin" && (arch === "arm64" || arch === "x64") ? `darwin-${arch}` : undefined;
  if (!target) return undefined;
  const origin = readInstalledUpdateOrigin(resourcesDir);
  return origin ? `${origin}/api/public/desktop-download/${target}` : undefined;
}
