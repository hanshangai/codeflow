import { ref } from "vue";
import { useRouter } from "vue-router";

import { getDesktopDownload, type DesktopDownloadInfo } from "../../api/desktopDownload";
import { wsOriginToHttpOrigin } from "../../api/request";
import { trackProductEvent } from "../../analytics/analytics";
import { useConfigStore } from "../../store/config";

export type DesktopDownloadPlatform = "win32" | "darwin" | "linux" | "unknown";
export type DesktopDownloadTarget = { kind: "direct"; url: string } | { kind: "page" };

/** 从浏览器事实判断下载平台；未知平台回落到下载页。 */
export function detectDesktopDownloadPlatform(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): DesktopDownloadPlatform {
  const ua = userAgent.toLowerCase();
  const value = platform.toLowerCase();
  if (value.includes("win") || ua.includes("windows")) return "win32";
  if (value.includes("mac") || /mac os|macintosh|darwin/u.test(ua)) return "darwin";
  if (value.includes("linux") || value.includes("x11") || /linux|x11/u.test(ua)) return "linux";
  return "unknown";
}

/** 只有已登记当前平台安装包时才直接下载；其它平台或读取失败回到下载页。 */
export async function resolveDesktopDownloadTarget(input: {
  platform: DesktopDownloadPlatform;
  origin: string;
  load: () => Promise<DesktopDownloadInfo>;
  onError?: (error: unknown) => void;
}): Promise<DesktopDownloadTarget> {
  if (input.platform !== "win32") return { kind: "page" };
  try {
    const info = await input.load();
    return { kind: "direct", url: `${wsOriginToHttpOrigin(input.origin)}${info.downloadPath}` };
  } catch (error) {
    input.onError?.(error);
    return { kind: "page" };
  }
}

/** 官网下载入口：按平台直达安装包，未提供时进入下载页说明。 */
export function useDesktopDownloadEntry(source: string) {
  const router = useRouter();
  const config = useConfigStore();
  const pending = ref(false);

  async function download(): Promise<void> {
    if (pending.value) return;
    pending.value = true;
    const platform = detectDesktopDownloadPlatform();
    trackProductEvent("desktop_download_entry", { source, platform });
    try {
      const target = await resolveDesktopDownloadTarget({
        platform,
        origin: config.serverWsOrigin,
        load: () => getDesktopDownload(config.serverWsOrigin),
        onError: (error) => {
          console.warn("[DESKTOP_DOWNLOAD_ENTRY_RESOLVE_FAILED]", {
            code: "DESKTOP_DOWNLOAD_ENTRY_RESOLVE_FAILED",
            source,
            platform,
            rootCause: error instanceof Error ? error.message : String(error),
          });
        },
      });
      if (target.kind === "direct") {
        window.location.assign(target.url);
        return;
      }
      void router.push("/download");
    } finally {
      pending.value = false;
    }
  }

  return { download, pending };
}
