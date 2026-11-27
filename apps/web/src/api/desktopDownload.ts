import { wsOriginToHttpOrigin } from "./request";

export type DesktopDownloadPackage = {
  version: string; displayVersion?: string; platform: "win32" | "darwin"; arch: "x64" | "arm64";
  publishedAt: number; size: number; sha256: string; downloadPath: string;
};

export type DesktopDownloadInfo = { packages: DesktopDownloadPackage[] };

/** 浏览器从页面同源下载，避免跳到 WS 端口；桌面自定义协议继续使用配置的 Server。 */
export function resolveDesktopDownloadBase(serverWsOrigin: string, desktop = false): string {
  if (!desktop && typeof window !== "undefined" && (window.location.protocol === "http:" || window.location.protocol === "https:")) {
    return window.location.origin;
  }
  return wsOriginToHttpOrigin(serverWsOrigin);
}

const DISPLAY_VERSION = /^\d+\.\d+\.\d{4}(?:\.[1-9]\d*)?$/u;
const DOWNLOAD_PATH = /^\/api\/public\/desktop-download\/(?:windows-x64|win32-x64|darwin-x64|darwin-arm64)$/u;

/** 校验单个平台包；旧服务端单包响应也复用这条严格合同。 */
function parsePackage(value: unknown): DesktopDownloadPackage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("桌面安装包信息格式无效");
  const body = value as Record<string, unknown>;
  const platform = body.platform;
  const arch = body.arch;
  if (platform !== "win32" && platform !== "darwin" || arch !== "x64" && arch !== "arm64"
    || platform === "win32" && arch !== "x64") throw new Error("桌面安装包信息格式无效");
  if (typeof body.version !== "string" || !body.version.trim()
    || body.displayVersion !== undefined && (typeof body.displayVersion !== "string" || !DISPLAY_VERSION.test(body.displayVersion))
    || !Number.isSafeInteger(body.publishedAt) || (body.publishedAt as number) <= 0
    || !Number.isSafeInteger(body.size) || (body.size as number) <= 0
    || typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(body.sha256)
    || typeof body.downloadPath !== "string" || !DOWNLOAD_PATH.test(body.downloadPath)) {
    throw new Error("桌面安装包信息格式无效");
  }
  const expectedPath = platform === "win32" ? ["/api/public/desktop-download/windows-x64", "/api/public/desktop-download/win32-x64"]
    : [`/api/public/desktop-download/darwin-${arch}`];
  if (!expectedPath.includes(body.downloadPath)) throw new Error("桌面安装包信息格式无效");
  return { version: body.version, ...(body.displayVersion !== undefined ? { displayVersion: body.displayVersion as string } : {}),
    platform, arch, publishedAt: body.publishedAt as number, size: body.size as number, sha256: body.sha256,
    downloadPath: body.downloadPath };
}

/** 公开读取完整安装包信息；兼容旧单包响应，新响应按平台列表严格校验。 */
export async function getDesktopDownload(serverWsOrigin: string, signal?: AbortSignal): Promise<DesktopDownloadInfo> {
  const response = await fetch(`${wsOriginToHttpOrigin(serverWsOrigin)}/api/public/desktop-download`, { signal, headers: { accept: "application/json" } });
  const body = await response.json();
  if (!response.ok || body?.ok !== true) throw new Error(typeof body?.message === "string" ? body.message : "桌面安装包信息读取失败");
  const rawPackages = Array.isArray(body.packages) ? body.packages : [body];
  if (!rawPackages.length) throw new Error("桌面安装包信息格式无效");
  const packages = rawPackages.map(parsePackage);
  const seen = new Set<string>();
  for (const item of packages) {
    const key = `${item.platform}:${item.arch}`;
    if (seen.has(key)) throw new Error("桌面安装包信息格式无效");
    seen.add(key);
  }
  return { packages };
}
