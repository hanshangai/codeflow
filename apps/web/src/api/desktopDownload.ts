import { wsOriginToHttpOrigin } from "./request";

export type DesktopDownloadInfo = {
  version: string; platform: "win32"; arch: "x64"; publishedAt: number; size: number; sha256: string; downloadPath: string;
};

/** 公开读取完整安装包信息，异常或缺发布明确失败，不以空对象代替成功。 */
export async function getDesktopDownload(serverWsOrigin: string, signal?: AbortSignal): Promise<DesktopDownloadInfo> {
  const response = await fetch(`${wsOriginToHttpOrigin(serverWsOrigin)}/api/public/desktop-download`, { signal, headers: { accept: "application/json" } });
  const body = await response.json();
  if (!response.ok || body?.ok !== true) throw new Error(typeof body?.message === "string" ? body.message : "桌面安装包信息读取失败");
  if (body.platform !== "win32" || body.arch !== "x64" || typeof body.version !== "string" || !body.version.trim()
    || !Number.isSafeInteger(body.publishedAt) || body.publishedAt <= 0 || !Number.isSafeInteger(body.size) || body.size <= 0
    || typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(body.sha256)
    || body.downloadPath !== "/api/public/desktop-download/windows-x64") throw new Error("桌面安装包信息格式无效");
  return { version: body.version, platform: body.platform, arch: body.arch, publishedAt: body.publishedAt, size: body.size, sha256: body.sha256, downloadPath: body.downloadPath };
}
