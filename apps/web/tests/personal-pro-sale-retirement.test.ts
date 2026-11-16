import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { resolvePostLoginTarget } from "../src/features/account/loginRedirect";
import { formatAccountRole, formatAuditActorRole } from "../src/features/account/accountDisplay";

function readSource(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("旧个人版参数不再覆盖正常登录回跳，未知购买路径走默认目标", () => {
  assert.deepEqual(resolvePostLoginTarget("/chat", {
    redirect: "/chat?threadId=thread-1",
    purchaseIntent: "PERSONAL_PRO",
    purchaseSource: "PRICING",
    purchaseResume: "confirm",
    purchaseSkuCode: "PERSONAL_PRO_MONTH_12",
  }), { path: "/chat", query: { threadId: "thread-1" } });

  assert.deepEqual(resolvePostLoginTarget("/chat", {
    redirect: "/payment/personal-pro?mode=ENTERPRISE",
  }), { path: "/chat" });
});

test("社区账号和缺失身份显示个人用户，审计不再映射旧专业版角色", () => {
  assert.equal(formatAccountRole("personal_normal"), "个人用户");
  assert.equal(formatAccountRole(undefined), "个人用户");
  assert.equal(formatAccountRole("personal_normal", { identityType: "PERSONAL_USER", editionType: "COMMUNITY" } as never), "个人用户");
  assert.equal(formatAuditActorRole("personal_normal"), "个人用户");
  assert.equal(formatAuditActorRole("user"), "user");
});

test("Shell 与账号中心不再暴露个人版购买或续费入口", () => {
  const modalServiceSource = readSource("apps/web/src/services/appModals.ts");
  const shellSource = readSource("apps/web/src/composables/useAppShell.ts");
  const modalSource = readSource("apps/web/src/components/app-shell/app-shell-modals.vue");
  const accountSource = readSource("apps/web/src/features/account/components/account-drawer.vue");
  const topbarSource = readSource("apps/web/src/components/app-shell/app-topbar.vue");

  assert.doesNotMatch(modalServiceSource, /openPersonalPurchase|closePersonalPurchase/u);
  assert.doesNotMatch(shellSource, /openPersonalPurchase|personalPurchaseOpen|PERSONAL_PURCHASE_REDIRECT_QUERY/u);
  assert.doesNotMatch(modalSource, /PersonalPurchaseDialogHost|personalPurchaseOpen|switchPersonalPurchase/u);
  assert.doesNotMatch(accountSource, /openPersonalPurchase|payment\/personal-pro|套餐续费|立即购买/u);
  assert.doesNotMatch(accountSource, /heroPackageMetaTitle|heroPrimaryPackageLine|heroSecondaryPackageLine|ClockCircleOutlined|个人用户基础能力/u);
  assert.doesNotMatch(topbarSource, /个人专业版|PERSONAL_PRO/u);
  assert.doesNotMatch(topbarSource, /openPersonalPurchase/u);
});
