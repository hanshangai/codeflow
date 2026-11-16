const env = import.meta.env as Record<
  string,
  string | undefined
>;

/**
 * 解析 Web 端登录验证码开关；仅允许通过显式环境变量关闭，默认保持开启。
 */
export function isAccountCaptchaEnabled(source: Record<string, string | undefined> = env): boolean {
  const raw = String(source.VITE_AIDT_CAPTCHA_ENABLED ?? source.VITE_CODEFLOWAI_CAPTCHA_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return raw !== "0" && raw !== "false";
}
