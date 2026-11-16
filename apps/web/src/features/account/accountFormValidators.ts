/** 基础邮箱格式校验：不做完整 RFC 解析，但拒绝畸形域名。 */
const EMAIL_PATTERN = /^[A-Z0-9_%+-]+(?:\.[A-Z0-9_%+-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}$/i;
const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const VERIFICATION_CODE_PATTERN = /^\d{6}$/;
const INVITE_CODE_PATTERN = /^CF-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;

export function normalizeEmailInput(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizePhoneInput(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/[\s-]/g, "")
    .replace(/^(?:\+?86)(?=1[3-9]\d{9}$)/, "");
}

/** 校验账号邮箱输入，返回空字符串表示通过，否则返回表单提示文案。 */
export function validateEmailInput(value: string): string {
  const normalized = normalizeEmailInput(value);
  if (!normalized) return "请输入邮箱";
  if (!EMAIL_PATTERN.test(normalized)) return "请输入正确的邮箱格式";
  return "";
}

export function validatePhoneInput(value: string): string {
  const normalized = normalizePhoneInput(value);
  if (!normalized) return "请输入手机号";
  if (!PHONE_PATTERN.test(normalized)) return "请输入正确的手机号";
  return "";
}

export function validateVerificationCodeInput(value: string): string {
  const code = String(value ?? "").trim();
  if (!code) return "请输入邮箱验证码";
  if (!VERIFICATION_CODE_PATTERN.test(code)) return "验证码应为 6 位数字";
  return "";
}

export function validateDisplayNameInput(value: string): string {
  if (!String(value ?? "").trim()) return "请输入姓名";
  return "";
}

export function validatePasswordInput(value: string): string {
  const password = String(value ?? "");
  if (!password) return "请输入密码";
  if (password.length < 6) return "密码至少需要 6 位";
  return "";
}

export function validateConfirmPasswordInput(password: string, confirmPassword: string, emptyMessage = "请再次输入密码"): string {
  if (!String(confirmPassword ?? "")) return emptyMessage;
  if (String(password ?? "") !== String(confirmPassword ?? "")) return "两次密码输入不一致";
  return "";
}

export function normalizeInviteCodeInput(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

export function validateInviteCodeInput(value: string): string {
  const normalized = normalizeInviteCodeInput(value);
  if (!normalized) return "";
  return INVITE_CODE_PATTERN.test(normalized) ? "" : "请输入正确的邀请码";
}
