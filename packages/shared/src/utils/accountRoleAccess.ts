import type {
  AccessContext,
  AccessEditionStatus,
  AccountRole,
  EffectiveAccessScope,
  EnterpriseStatus,
  PackageStatus,
} from "../types/account.js";

export type PersonalAccountRole = Extract<AccountRole, "personal_normal">;

export type AccountPermissionInput = {
  accountRole: AccountRole | null;
  enterpriseId?: string | null;
  enterpriseName?: string | null;
  enterpriseStatus?: EnterpriseStatus | null;
  enterprisePackageStatus?: PackageStatus | null;
  enterpriseMemberPackageStatus?: PackageStatus | null;
  effectiveAccessScope?: EffectiveAccessScope | null;
  accessContext?: AccessContext | null;
};

export type AccountAccessScope = EffectiveAccessScope;

/** 个人用户在规格-流程里仅允许使用这条内置小需求流程。 */
export const COMMUNITY_SPEC_BUILTIN_LIGHT_WORKFLOW_NAME = "CodeFlow 小需求快交付";

/** 判断账号角色是否仍处于个人态，用于入企邀请等场景。 */
export function isPersonalAccountRole(role: AccountRole | null | undefined): role is PersonalAccountRole {
  return role === "personal_normal";
}

/** 按账号身份和企业状态计算访问范围，不读取购买凭证或历史人月。 */
export function buildAccessContext(input: AccountPermissionInput): AccessContext {
  const enterpriseId = normalizeEnterpriseId(input.enterpriseId);
  const enterpriseName = normalizeEnterpriseName(input.enterpriseName);

  if (input.accountRole === "super_admin") {
    return {
      identityType: "SUPER_ADMIN",
      editionType: "NONE",
      editionStatus: "NONE",
      effectiveAccessScope: "SUPER_ADMIN",
      enterpriseId: null,
      enterpriseName: null,
    };
  }

  if (input.accountRole === "enterprise_admin" || enterpriseId) {
    const identityType = input.accountRole === "enterprise_admin" ? "ENTERPRISE_ADMIN" : "ENTERPRISE_MEMBER";
    const editionStatus = enterpriseId && input.enterpriseStatus === "active"
      ? "ACTIVE"
      : "NONE";
    return {
      identityType,
      editionType: "ENTERPRISE",
      editionStatus,
      effectiveAccessScope: editionStatus === "ACTIVE"
        ? "ENTERPRISE_ACTIVE"
        : "ENTERPRISE_LIMITED",
      enterpriseId,
      enterpriseName,
    };
  }

  return {
    identityType: "PERSONAL_USER",
    editionType: "COMMUNITY",
    editionStatus: "ACTIVE",
    effectiveAccessScope: "COMMUNITY",
    enterpriseId: null,
    enterpriseName: null,
  };
}

/** 统一解析当前账号的最终权限范围，优先信任已聚合好的 effectiveAccessScope。 */
export function resolveAccountAccessScope(input: AccountPermissionInput): AccountAccessScope {
  const normalizedScope = normalizeEffectiveAccessScope(input.effectiveAccessScope);
  if (normalizedScope) return normalizedScope;
  return buildAccessContext(input).effectiveAccessScope;
}

/** 规格菜单下流程标签的新建权限。 */
export function canCreateSpecWorkflow(input: AccountPermissionInput): boolean {
  const scope = resolveAccountAccessScope(input);
  return scope === "SUPER_ADMIN" || scope === "ENTERPRISE_ACTIVE";
}

/** 规格菜单下 Agent 标签的新建权限，社区与企业受限态也允许维护自定义 Agent。 */
export function canCreateSpecRole(input: AccountPermissionInput): boolean {
  const scope = resolveAccountAccessScope(input);
  return scope === "SUPER_ADMIN"
    || scope === "ENTERPRISE_ACTIVE"
    || scope === "ENTERPRISE_LIMITED"
    || (scope === "COMMUNITY" && hasAccountIdentity(input));
}

/** 规格菜单下规则资产导入权限。 */
export function canImportRuleAssets(input: AccountPermissionInput): boolean {
  const scope = resolveAccountAccessScope(input);
  return scope === "SUPER_ADMIN" || scope === "ENTERPRISE_ACTIVE";
}

/** 规格菜单下规则资产导出权限。 */
export function canExportRuleAssets(input: AccountPermissionInput): boolean {
  const scope = resolveAccountAccessScope(input);
  return scope === "SUPER_ADMIN" || scope === "ENTERPRISE_ACTIVE";
}

/** 流程/角色资产包导入仅开放给超管与企业有效套餐账号。 */
export function canImportSpecWorkflowRoleAssets(input: AccountPermissionInput): boolean {
  const scope = resolveAccountAccessScope(input);
  return scope === "SUPER_ADMIN" || scope === "ENTERPRISE_ACTIVE";
}

/** 流程/角色资产包导出仅开放给超管与企业有效套餐账号。 */
export function canExportSpecWorkflowRoleAssets(input: AccountPermissionInput): boolean {
  const scope = resolveAccountAccessScope(input);
  return scope === "SUPER_ADMIN" || scope === "ENTERPRISE_ACTIVE";
}

/** 仅超管与有效企业版可创建自定义 Skills / MCP 接入。 */
export function canManageCustomSkillsAndMcp(input: AccountPermissionInput): boolean {
  const scope = resolveAccountAccessScope(input);
  return scope === "SUPER_ADMIN" || scope === "ENTERPRISE_ACTIVE";
}

/** 仅超管可导出系统内置流程。 */
export function canExportBuiltinSpecWorkflow(input: AccountPermissionInput): boolean {
  return resolveAccountAccessScope(input) === "SUPER_ADMIN";
}

/** 仅超管可导出系统内置角色。 */
export function canExportBuiltinSpecRole(input: AccountPermissionInput): boolean {
  return resolveAccountAccessScope(input) === "SUPER_ADMIN";
}

/** 仅超管可导出系统内置知识库。 */
export function canExportBuiltinSpecKnowledgeBundle(input: AccountPermissionInput): boolean {
  return resolveAccountAccessScope(input) === "SUPER_ADMIN";
}

/** 仅超管可导出系统内置工具集。 */
export function canExportBuiltinSpecToolset(input: AccountPermissionInput): boolean {
  return resolveAccountAccessScope(input) === "SUPER_ADMIN";
}

/** 内置资产随 Client 包发布，所有角色只读，只能复制为自定义。 */
export function canMaintainBuiltinSpecAssets(_input: AccountPermissionInput): boolean {
  return false;
}

/** 角色页右侧知识库、工具标签仅要求账号已登录。 */
export function canUseRoleKnowledgeAndToolsTabs(input: AccountPermissionInput): boolean {
  return normalizeEffectiveAccessScope(input.effectiveAccessScope) != null || input.accountRole != null;
}

/** 社区能力下流程列表仅展示内置流程，避免误选自定义流程。 */
export function shouldRestrictSpecWorkflowListToBuiltin(input: AccountPermissionInput): boolean {
  return isCommunityAccess(input);
}

/** 社区与受限企业账号需要在执行前校验流程是否仍在可用范围内。 */
export function shouldLimitSpecWorkflowRoleUsageToCommunityAvailable(input: AccountPermissionInput): boolean {
  const accessContext = input.accessContext;
  if (accessContext) {
    if (accessContext.editionType === "COMMUNITY") return true;
    return isLimitedPaidEdition(accessContext);
  }
  const scope = resolveAccountAccessScope(input);
  return scope === "COMMUNITY" || scope === "ENTERPRISE_LIMITED";
}

/** 自定义 Agent 对社区和企业受限态开放，不再按套餐状态限制为内置 Agent。 */
export function shouldLimitSpecRoleUsageToBuiltin(_input: AccountPermissionInput): boolean {
  return false;
}

/** 兼容旧调用名：当前已不再限制企业受限态使用自定义 Agent。 */
export function shouldLimitSpecRoleUsageToBuiltinWhenEnterpriseExpired(input: AccountPermissionInput): boolean {
  return shouldLimitSpecRoleUsageToBuiltin(input);
}

/** 已登录社区和有效企业可维护知识工具，受限企业保持只读边界。 */
export function canManageSpecKnowledgeAndToolsets(input: AccountPermissionInput): boolean {
  const scope = resolveAccountAccessScope(input);
  return scope === "SUPER_ADMIN"
    || scope === "ENTERPRISE_ACTIVE"
    || (scope === "COMMUNITY" && hasAccountIdentity(input));
}

/** 企业身份在有效期内或受限态下都允许查看企业信息。 */
export function canViewEnterpriseWorkspace(input: AccountPermissionInput): boolean {
  const scope = resolveAccountAccessScope(input);
  return scope === "SUPER_ADMIN" || scope === "ENTERPRISE_ACTIVE" || scope === "ENTERPRISE_LIMITED";
}

/** 企业身份仅在有效期内允许执行成员/资料/额度等写操作。 */
export function canManageEnterpriseWorkspace(input: AccountPermissionInput): boolean {
  const scope = resolveAccountAccessScope(input);
  return scope === "SUPER_ADMIN" || scope === "ENTERPRISE_ACTIVE";
}

/** 受限企业保留原有企业菜单，具体操作由权限与 ACL 校验。 */
export function shouldKeepPaidMenusVisibleWhenExpired(input: AccountPermissionInput): boolean {
  const accessContext = input.accessContext;
  if (!accessContext) return resolveAccountAccessScope(input) === "ENTERPRISE_LIMITED";
  return isLimitedPaidEdition(accessContext);
}

/** 受限企业沿用社区可用流程范围。 */
function isLimitedPaidEdition(accessContext: AccessContext): boolean {
  return accessContext.editionType === "ENTERPRISE"
    && !isActivePaidEditionStatus(accessContext.editionStatus);
}

/** 判断是否为社区访问范围，供规格资产权限统一复用。 */
function isCommunityAccess(input: AccountPermissionInput): boolean {
  const accessContext = input.accessContext;
  if (accessContext) return accessContext.effectiveAccessScope === "COMMUNITY";
  return resolveAccountAccessScope(input) === "COMMUNITY";
}

/** 判断权限输入是否来自已识别账号，避免空输入被 COMMUNITY 兜底放权。 */
function hasAccountIdentity(input: AccountPermissionInput): boolean {
  return input.accountRole != null || input.accessContext != null;
}

/** ACTIVE and EXPIRING still keep full paid-edition access. */
function isActivePaidEditionStatus(status: AccessEditionStatus): boolean {
  return status === "ACTIVE" || status === "EXPIRING";
}

/** Normalize enterprise id to avoid treating blanks as membership. */
function normalizeEnterpriseId(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

/** 规范化企业名称，避免空字符串污染展示。 */
function normalizeEnterpriseName(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

/** 规整外部传入的 effectiveAccessScope，避免非法字符串污染权限判断。 */
function normalizeEffectiveAccessScope(value: EffectiveAccessScope | null | undefined): EffectiveAccessScope | null {
  return value === "SUPER_ADMIN"
    || value === "ENTERPRISE_ACTIVE"
    || value === "ENTERPRISE_LIMITED"
    || value === "COMMUNITY"
    ? value
    : null;
}
