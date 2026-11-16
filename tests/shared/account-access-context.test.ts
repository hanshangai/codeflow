import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAccessContext,
  canCreateSpecRole,
  canCreateSpecWorkflow,
  canExportRuleAssets,
  canImportRuleAssets,
  canManageCustomSkillsAndMcp,
  canManageEnterpriseWorkspace,
  canManageSpecKnowledgeAndToolsets,
  canViewEnterpriseWorkspace,
  isPersonalAccountRole,
  resolveAccountAccessScope,
  shouldKeepPaidMenusVisibleWhenExpired,
  shouldLimitSpecWorkflowRoleUsageToCommunityAvailable,
  shouldRestrictSpecWorkflowListToBuiltin,
  type AccountPermissionInput,
} from "../../packages/shared/src/utils/accountRoleAccess.ts";

test("旧 user 角色和有效个人套餐不再授予专业版权限", () => {
  const legacyInput = {
    accountRole: "user",
    personalPackageStatus: "ACTIVE",
  } as unknown as AccountPermissionInput;

  assert.deepEqual(buildAccessContext(legacyInput), {
    identityType: "PERSONAL_USER",
    editionType: "COMMUNITY",
    editionStatus: "ACTIVE",
    effectiveAccessScope: "COMMUNITY",
    enterpriseId: null,
    enterpriseName: null,
  });
  assert.equal(canCreateSpecWorkflow(legacyInput), false);
  assert.equal(canImportRuleAssets(legacyInput), false);
  assert.equal(canExportRuleAssets(legacyInput), false);
  assert.equal(canManageCustomSkillsAndMcp(legacyInput), false);
  assert.equal(isPersonalAccountRole(legacyInput.accountRole), false);
});

test("旧专业版 scope 不再覆盖社区权限", () => {
  const legacyInput = {
    accountRole: "personal_normal",
    effectiveAccessScope: "PERSONAL_PRO_ACTIVE",
  } as unknown as AccountPermissionInput;

  assert.equal(resolveAccountAccessScope(legacyInput), "COMMUNITY");
  assert.equal(canCreateSpecWorkflow(legacyInput), false);
  assert.equal(canImportRuleAssets(legacyInput), false);
  assert.equal(canExportRuleAssets(legacyInput), false);
  assert.equal(canManageCustomSkillsAndMcp(legacyInput), false);
});

test("社区账号可创建 Agent 和维护知识工具，但不能创建自定义流程", () => {
  const input: AccountPermissionInput = { accountRole: "personal_normal" };

  assert.equal(isPersonalAccountRole(input.accountRole), true);
  assert.equal(canCreateSpecRole(input), true);
  assert.equal(canManageSpecKnowledgeAndToolsets(input), true);
  assert.equal(canCreateSpecWorkflow(input), false);
  assert.equal(canManageCustomSkillsAndMcp(input), false);
  assert.equal(shouldRestrictSpecWorkflowListToBuiltin(input), true);
  assert.equal(shouldLimitSpecWorkflowRoleUsageToCommunityAvailable(input), true);
});

test("匿名社区输入不获得 Agent 或知识工具维护权限", () => {
  const input: AccountPermissionInput = { accountRole: null };

  assert.equal(canCreateSpecRole(input), false);
  assert.equal(canManageSpecKnowledgeAndToolsets(input), false);
});

test("旧套餐输入不能替代有效企业状态", () => {
  const legacyInput = {
    accountRole: "user",
    personalPackageStatus: "ACTIVE",
    enterpriseId: " enterprise-1 ",
    enterpriseName: " 示例企业 ",
    enterprisePackageStatus: "ACTIVE",
    enterpriseMemberPackageStatus: "NONE",
  } as unknown as AccountPermissionInput;

  assert.deepEqual(buildAccessContext(legacyInput), {
    identityType: "ENTERPRISE_MEMBER",
    editionType: "ENTERPRISE",
    editionStatus: "NONE",
    effectiveAccessScope: "ENTERPRISE_LIMITED",
    enterpriseId: "enterprise-1",
    enterpriseName: "示例企业",
  });
  assert.equal(canCreateSpecWorkflow(legacyInput), false);
  assert.equal(canManageCustomSkillsAndMcp(legacyInput), false);
});

test("有效企业成员无需人月分配即可使用企业能力", () => {
  const input: AccountPermissionInput = {
    accountRole: "personal_normal", enterpriseId: "enterprise-1", enterpriseStatus: "active",
  };
  assert.equal(buildAccessContext(input).identityType, "ENTERPRISE_MEMBER");
  assert.equal(resolveAccountAccessScope(input), "ENTERPRISE_ACTIVE");
  assert.equal(canCreateSpecWorkflow(input), true);
  assert.equal(canImportRuleAssets(input), true);
  assert.equal(canExportRuleAssets(input), true);
  assert.equal(canManageCustomSkillsAndMcp(input), true);
});

test("企业关系无效时保留 Agent，但不能写入知识工具", () => {
  const input: AccountPermissionInput = {
    accountRole: "personal_normal",
    enterpriseId: "enterprise-1",
    enterpriseMemberPackageStatus: "NONE",
  };
  input.accessContext = buildAccessContext(input);

  assert.equal(canCreateSpecRole(input), true);
  assert.equal(canManageSpecKnowledgeAndToolsets(input), false);
  assert.equal(canCreateSpecWorkflow(input), false);
  assert.equal(shouldLimitSpecWorkflowRoleUsageToCommunityAvailable(input), true);
});

test("企业停用后保留管理查询，企业写操作与知识工具维护受限", () => {
  const input: AccountPermissionInput = {
    accountRole: "personal_normal",
    enterpriseId: "enterprise-1",
    enterpriseStatus: "disabled",
  };
  input.accessContext = buildAccessContext(input);

  assert.equal(resolveAccountAccessScope(input), "ENTERPRISE_LIMITED");
  assert.equal(canCreateSpecRole(input), true);
  assert.equal(canManageSpecKnowledgeAndToolsets(input), false);
  assert.equal(canCreateSpecWorkflow(input), false);
  assert.equal(canManageCustomSkillsAndMcp(input), false);
  assert.equal(canViewEnterpriseWorkspace(input), true);
  assert.equal(canManageEnterpriseWorkspace(input), false);
  assert.equal(shouldKeepPaidMenusVisibleWhenExpired(input), true);
});

test("企业管理员按企业状态判定，停用不改变身份", () => {
  const input: AccountPermissionInput = {
    accountRole: "enterprise_admin",
    enterpriseId: "enterprise-1",
    enterpriseStatus: "disabled",
  };
  input.accessContext = buildAccessContext(input);

  assert.equal(input.accessContext.identityType, "ENTERPRISE_ADMIN");
  assert.equal(input.accessContext.editionStatus, "NONE");
  assert.equal(canManageEnterpriseWorkspace(input), false);
  assert.equal(canViewEnterpriseWorkspace(input), true);
  assert.equal(canManageSpecKnowledgeAndToolsets(input), false);
});

test("超管权限优先于企业归属和到期状态", () => {
  const input: AccountPermissionInput = {
    accountRole: "super_admin",
    enterpriseId: "enterprise-1",
    enterprisePackageStatus: "EXPIRED",
  };

  assert.equal(resolveAccountAccessScope(input), "SUPER_ADMIN");
  assert.equal(buildAccessContext(input).enterpriseId, null);
  assert.equal(canCreateSpecWorkflow(input), true);
  assert.equal(canManageCustomSkillsAndMcp(input), true);
  assert.equal(canManageEnterpriseWorkspace(input), true);
});
