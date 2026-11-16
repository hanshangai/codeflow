import { ref } from "vue";
import type { DesktopUpdateNotice } from "@codeflowai/shared";

import { DesktopUpdateServiceError, dismissDesktopUpdateNotice, reportDesktopUpdateError } from "../../services/desktop";

/** 全局唯一待展示提醒；推送与启动补查共用，避免同一提醒叠加多个弹窗。 */
export const activeDesktopUpdateNotice = ref<DesktopUpdateNotice | null>(null);

export function showDesktopUpdateNotice(notice: DesktopUpdateNotice): void {
  activeDesktopUpdateNotice.value = notice;
}

export function hideDesktopUpdateNotice(): void {
  activeDesktopUpdateNotice.value = null;
}

/** 按 24 小时节流关闭指定提醒；调用方已隐藏弹框时仍能持久化关闭。 */
export function dismissDesktopUpdateNoticeLater(notice: DesktopUpdateNotice): void {
  void dismissDesktopUpdateNotice("later").catch(error => {
    const code = error instanceof DesktopUpdateServiceError ? error.code : "DESKTOP_UPDATE_NOTICE_DISMISS_FAILED";
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    console.error("[desktop_update_notice_suppress_failed]", {
      code, requestId: `update-notice-suppress:${notice.releaseId}`, releaseId: notice.releaseId, rootCause: message,
    });
    void reportDesktopUpdateError({ phase: "discovery", code, releaseId: notice.releaseId, message });
  });
}

/** 用户已确认看到提醒：隐藏并按 24 小时节流记录。 */
export function suppressDesktopUpdateNotice(): void {
  const notice = activeDesktopUpdateNotice.value;
  if (!notice) return;
  activeDesktopUpdateNotice.value = null;
  dismissDesktopUpdateNoticeLater(notice);
}
