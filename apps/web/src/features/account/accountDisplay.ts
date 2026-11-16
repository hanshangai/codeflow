import type {
  AccessContext,
  AccountRole,
  AccountStatus,
  AuditOperationType,
  EnterpriseMemberDisplayRole,
  EnterpriseMemberItem,
  EnterpriseStatus,
  MemberRole,
  PackageSummary,
  UserKeyStatus,
} from "@codeflowai/shared";

export const auditOperationTypeOptions: Array<{ value: AuditOperationType; label: string }> = [
  { value: "package_purchase", label: "套餐购买/续费" },
  { value: "package_adjustment", label: "套餐调整" },
  { value: "password_change", label: "密码变更" },
  { value: "member_management", label: "成员管理" },
  { value: "user_profile_change", label: "个人信息变更" },
  { value: "enterprise_profile_change", label: "企业信息变更" },
  { value: "account_management", label: "账号管理" },
  { value: "enterprise_management", label: "企业管理" },
  { value: "authentication", label: "认证事件" },
  { value: "credential_delivery", label: "凭据发放" },
  { value: "system_management", label: "系统管理" },
  { value: "shared_workspace", label: "共享空间" },
  { value: "unknown", label: "其他" },
];

export const auditResultOptions: Array<{ value: string; label: string }> = [
  { value: "success", label: "成功" },
  { value: "failed", label: "失败" },
  { value: "rejected", label: "拒绝" },
  { value: "processing", label: "处理中" },
];

/** 统一格式化账号身份展示名，优先读取服务端聚合好的 accessContext。 */
export function formatAccountRole(role: AccountRole | null | undefined, accessContext?: AccessContext | null): string {
  if (accessContext?.identityType === "SUPER_ADMIN") return "超级管理员";
  if (accessContext?.identityType === "ENTERPRISE_ADMIN") return "企业管理员";
  if (accessContext?.identityType === "ENTERPRISE_MEMBER") return "企业版";
  if (role === "personal_normal" || accessContext?.editionType === "COMMUNITY") return "个人用户";
  if (role === "super_admin") return "超级管理员";
  if (role === "enterprise_admin") return "企业管理员";
  return "个人用户";
}

export function formatAccountRoleTag(role: AccountRole | null | undefined, accessContext?: AccessContext | null): string {
  if (accessContext?.identityType === "SUPER_ADMIN") return "red";
  if (accessContext?.identityType === "ENTERPRISE_ADMIN") return "gold";
  if (accessContext?.identityType === "ENTERPRISE_MEMBER") return "blue";
  if (accessContext?.identityType === "PERSONAL_USER") return "cyan";
  if (role === "super_admin") return "red";
  if (role === "enterprise_admin") return "gold";
  if (role === "personal_normal") return "cyan";
  return "blue";
}

/** 统一格式化当前账号的权益标签，和身份标签拆开显示。 */
export function formatAccessEdition(accessContext: AccessContext | null | undefined): string {
  if (!accessContext) return "-";
  if (accessContext.identityType === "SUPER_ADMIN") return "平台权限";
  if (accessContext.editionType === "ENTERPRISE") {
    if (accessContext.editionStatus === "NONE") return "企业已停用或归属无效";
    return "企业版";
  }
  return "个人用户";
}

export function formatAccessEditionTag(accessContext: AccessContext | null | undefined): string {
  if (!accessContext) return "default";
  if (accessContext.editionStatus === "EXPIRING") return "gold";
  if (accessContext.editionStatus === "EXPIRED") return "red";
  if (accessContext.editionStatus === "NONE") return "default";
  if (accessContext.identityType === "SUPER_ADMIN") return "red";
  return "green";
}

export function formatAccountStatus(status: AccountStatus | null | undefined): string {
  if (status === "locked") return "已锁定";
  if (status === "disabled") return "已禁用";
  if (status === "cancelled") return "已注销";
  return "正常";
}

export function formatEnterpriseStatus(status: EnterpriseStatus | null | undefined): string {
  return status === "disabled" ? "已禁用" : "正常";
}

export function formatMemberRole(role: MemberRole | null | undefined): string {
  return role === "owner" ? "Owner" : "成员";
}

/** 格式化企业成员列表展示角色，真实权限仍由 memberRole 判定。 */
export function formatEnterpriseMemberDisplayRole(role: EnterpriseMemberDisplayRole | MemberRole | null | undefined): string {
  if (role === "enterprise_admin" || role === "owner") return "企业管理员";
  if (role === "shared_workspace_admin") return "共享工作区管理员";
  return "企业成员";
}

export function formatPackageSource(summary: PackageSummary | null | undefined): string {
  if (!summary) return "-";
  if (!summary.sourceType) {
    return summary.isEnterprise ? "企业套餐" : "个人用户";
  }
  if (summary.sourceType === "renew") return "续费";
  if (summary.sourceType === "manual_adjust") return "人工调整";
  return "初始化";
}

export function formatKeyStatus(status: UserKeyStatus | EnterpriseMemberItem["keyStatus"] | null | undefined): string {
  if (status === "disabled") return "已禁用";
  if (status === "revoked") return "已撤销";
  if (status === "missing") return "未绑定";
  return "可用";
}

export function formatPackageHealth(status: "normal" | "warning" | "expired" | "none" | null | undefined): string {
  if (status === "warning") return "即将到期";
  if (status === "expired") return "已过期";
  if (status === "none") return "未分配";
  return "正常";
}

export function formatPackageHealthTag(status: "normal" | "warning" | "expired" | "none" | null | undefined): string {
  if (status === "warning") return "gold";
  if (status === "expired") return "red";
  if (status === "none") return "default";
  return "green";
}

export function formatTimestamp(ts: number | null | undefined): string {
  if (!ts || ts <= 0) return "-";
  return new Date(ts).toLocaleString("zh-CN");
}

export function formatAuditOperationType(type: AuditOperationType | null | undefined): string {
  return auditOperationTypeOptions.find((item) => item.value === type)?.label || "其他";
}

export function formatAuditOperationTypeTag(type: AuditOperationType | null | undefined): string {
  if (type === "package_purchase") return "green";
  if (type === "package_adjustment") return "cyan";
  if (type === "password_change") return "gold";
  if (type === "member_management") return "blue";
  if (type === "user_profile_change" || type === "enterprise_profile_change") return "purple";
  if (type === "account_management" || type === "enterprise_management") return "orange";
  if (type === "authentication") return "volcano";
  if (type === "credential_delivery") return "geekblue";
  if (type === "system_management") return "red";
  if (type === "shared_workspace") return "purple";
  return "default";
}

export function formatAuditResult(result: string | null | undefined): string {
  if (result === "success") return "成功";
  if (result === "failed") return "失败";
  if (result === "rejected") return "拒绝";
  if (result === "processing") return "处理中";
  return result?.trim() || "-";
}

export function formatAuditResultTag(result: string | null | undefined): string {
  if (result === "success") return "green";
  if (result === "failed") return "red";
  if (result === "rejected") return "gold";
  if (result === "processing") return "blue";
  return "default";
}

/** 审计列表沿用前台角色命名，保证账号角色口径一致。 */
export function formatAuditActorRole(role: string | null | undefined): string {
  if (role === "system") return "系统";
  if (role === "admin") return "平台管理员";
  if (role === "super_admin") return "超级管理员";
  if (role === "enterprise_admin") return "企业管理员";
  if (role === "personal_normal") return "个人用户";
  return role?.trim() || "-";
}

export function formatDateOnly(ts: number | null | undefined): string {
  if (!ts || ts <= 0) return "-";
  return new Date(ts).toLocaleDateString("zh-CN");
}

export function maskEmail(email: string): string {
  const text = String(email ?? "").trim();
  const [name, domain] = text.split("@");
  if (!name || !domain) return text;
  if (name.length <= 2) return String(name[0] ?? "*") + "*@" + domain;
  return name.slice(0, 2) + "***@" + domain;
}

export function initialsOf(name: string | null | undefined): string {
  const text = String(name ?? "").trim();
  if (!text) return "U";
  return text
    .split(/\s+/g)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
