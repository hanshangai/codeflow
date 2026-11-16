import type { Router } from "vue-router";
import { resolveSiteOrigin } from "../seo/pageSeo";

/** Web 端应用内跳转更新日志；桌面端交给系统浏览器，避免在桌面壳内打开公开站点。 */
export function openUpgradeNotes(router: Router): void {
  if (typeof window === "undefined" || !window.codeflowDesktop) {
    void router.push("/upgrade");
    return;
  }
  // Electron 主进程 setWindowOpenHandler 会把 http(s) 链接转交系统浏览器。
  window.open(`${resolveSiteOrigin(import.meta.env.VITE_CODEFLOWAI_SITE_ORIGIN)}/upgrade`, "_blank");
}
