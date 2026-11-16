export const WORKSPACE_EXECUTION_PROFILE_MAX_CHARS = 12_000;

export type WorkspaceExecutionProfileValidationErrorCode =
  | "PROFILE_TOO_LONG"
  | "PROFILE_SENSITIVE_CONTENT";

export type WorkspaceExecutionProfileValidationResult =
  | { ok: true; text: string }
  | { ok: false; code: WorkspaceExecutionProfileValidationErrorCode; message: string; ruleId?: string };

const SENSITIVE_PROFILE_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { id: "generic_pem_block", pattern: /-----BEGIN [A-Z0-9 ]+-----/i },
  { id: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "openai_like_key", pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/ },
  { id: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: "github_token", pattern: /\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: "secret_assignment", pattern: /\b(?:access_token|refresh_token|api[_-]?key|password|passwd|token|secret|cookie)\s*[:=]/i },
];

/** 统一规整工作区执行 Profile 文本；空白内容等价于清空。 */
export function normalizeWorkspaceExecutionProfileText(value: unknown): string {
  return String(value ?? "").trim();
}

/** 保存 Profile 前做长度和明显凭据模式检查，命中时必须显式失败。 */
export function validateWorkspaceExecutionProfileText(value: unknown): WorkspaceExecutionProfileValidationResult {
  const text = normalizeWorkspaceExecutionProfileText(value);
  if (text.length > WORKSPACE_EXECUTION_PROFILE_MAX_CHARS) {
    return {
      ok: false,
      code: "PROFILE_TOO_LONG",
      message: `Profile 内容不能超过 ${WORKSPACE_EXECUTION_PROFILE_MAX_CHARS} 个字符`,
    };
  }
  for (const rule of SENSITIVE_PROFILE_PATTERNS) {
    if (!rule.pattern.test(text)) continue;
    return {
      ok: false,
      code: "PROFILE_SENSITIVE_CONTENT",
      message: "Profile 是 AI 可读说明，不能填写密码、token、私钥或可直接授权的明文凭据",
      ruleId: rule.id,
    };
  }
  return { ok: true, text };
}
