/** 桌面端未登录启动提醒的本地存储键；勾选后不再自动弹出。 */
export const DESKTOP_LOGIN_PROMPT_KEY = "codeflowai.desktop-login-prompt.dismissed";

/** 读取用户是否选择不再自动提醒登录。 */
export function isDesktopLoginPromptDismissed(): boolean {
  return localStorage.getItem(DESKTOP_LOGIN_PROMPT_KEY) === "1";
}

/** 保存“不再提醒登录”选择；取消勾选时恢复后续自动提醒。 */
export function setDesktopLoginPromptDismissed(value: boolean): void {
  if (value) localStorage.setItem(DESKTOP_LOGIN_PROMPT_KEY, "1");
  else localStorage.removeItem(DESKTOP_LOGIN_PROMPT_KEY);
}
