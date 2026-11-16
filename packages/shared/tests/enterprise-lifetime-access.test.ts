import assert from "node:assert/strict";
import test from "node:test";
import { buildAccessContext, canManageEnterpriseWorkspace, canManageSpecKnowledgeAndToolsets } from "../src/utils/accountRoleAccess.ts";

test("有效企业成员无需付费凭证即可获得企业能力", () => {
  const input = { accountRole: "personal_normal" as const, enterpriseId: "enterprise-1", enterpriseStatus: "active" as const };
  assert.deepEqual(buildAccessContext(input), {
    identityType: "ENTERPRISE_MEMBER", editionType: "ENTERPRISE", editionStatus: "ACTIVE",
    effectiveAccessScope: "ENTERPRISE_ACTIVE", enterpriseId: "enterprise-1", enterpriseName: null,
  });
  assert.equal(canManageEnterpriseWorkspace(input), true);
});

test("缺少有效企业状态时旧套餐不能授予企业能力", () => {
  assert.equal(buildAccessContext({ accountRole: "enterprise_admin", enterpriseId: "enterprise-1",
    enterprisePackageStatus: "ACTIVE", enterpriseMemberPackageStatus: "ACTIVE" }).effectiveAccessScope, "ENTERPRISE_LIMITED");
});

test("企业停用保留身份但限制企业能力", () => {
  const input = { accountRole: "enterprise_admin" as const, enterpriseId: "enterprise-1", enterpriseStatus: "disabled" as const };
  assert.equal(buildAccessContext(input).effectiveAccessScope, "ENTERPRISE_LIMITED");
  assert.equal(canManageEnterpriseWorkspace(input), false);
  assert.equal(canManageSpecKnowledgeAndToolsets(input), false);
  assert.equal(buildAccessContext({ ...input, enterpriseStatus: "active" }).effectiveAccessScope, "ENTERPRISE_ACTIVE");
});

test("缺少企业关系时不能提升个人权限", () => {
  assert.equal(buildAccessContext({ accountRole: "personal_normal", enterpriseStatus: "active" }).effectiveAccessScope, "COMMUNITY");
});
