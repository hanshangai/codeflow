import { expect, test, type Page } from "@playwright/test";

/** 复用实际账号抽屉，以受控账号接口验证免费建企交互和失败边界。 */
async function openAccount(page: Page, fail: boolean) {
  let created = false;
  const requests: unknown[] = [];
  const access = () => ({ identityType: created ? "ENTERPRISE_ADMIN" : "PERSONAL_USER", editionType: created ? "ENTERPRISE" : "COMMUNITY",
    editionStatus: "ACTIVE", effectiveAccessScope: created ? "ENTERPRISE_ACTIVE" : "COMMUNITY",
    enterpriseId: created ? "free-team" : null, enterpriseName: created ? "免费协作团队" : null });
  const user = () => ({ userId: "free-owner", email: "free@example.test", fullName: "免费用户", phone: "", avatarUrl: null,
    accountRole: created ? "enterprise_admin" : "personal_normal", status: "active",
    enterpriseId: created ? "free-team" : null, enterpriseName: created ? "免费协作团队" : null });
  await page.route("**/api/account/me/summary", route => route.fulfill({ json: { ok: true, ...user(), accessContext: access(),
    enterpriseSummary: created ? { enterpriseId: "free-team", name: "免费协作团队", status: "active" } : null,
    pendingEnterpriseInvitations: [], keySummary: null, securitySummary: null, inviteCode: "" } }));
  await page.route("**/api/account/me/enterprise", async route => {
    requests.push(route.request().postDataJSON());
    if (fail) { await route.fulfill({ status: 409, json: { ok: false, code: "ENTERPRISE_NAME_ALREADY_EXISTS", message: "企业名称已存在" } }); return; }
    created = true;
    await route.fulfill({ json: { ok: true, enterpriseId: "free-team", ownerUserId: "free-owner", accountRoleUpdated: true } });
  });
  await page.routeWebSocket(/\/ws\/web(?:\?|$)/u, ws => {
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.t === "web.subscribeReplace") ws.send(JSON.stringify({ t: "web.subscribeAck", requestId: message.requestId,
        workspaceId: message.workspaceId ?? null, sinceSeq: 0, bufferedCount: 0, serverSeq: 0 }));
    });
    ws.send(JSON.stringify({ t: "web.helloAck", webSessionId: "free-enterprise-web", serverNow: Date.now(), authMode: "account",
      accountRole: user().accountRole, homePath: "/chat", userSummary: user(), accessContext: access() }));
  });
  await page.addInitScript(({ userSummary, accessContext }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("config", JSON.stringify({ serverWsOrigin: "ws://127.0.0.1:39290", authMode: "account", accountRole: "personal_normal",
      sessionToken: "free-enterprise-session", sessionExpiresAt: Date.now() + 3_600_000, homePath: "/chat", userSummary, accessContext }));
  }, { userSummary: user(), accessContext: access() });
  await page.goto("/chat");
  await page.locator(".user-menu-trigger").first().click();
  await page.getByRole("menuitem", { name: "个人信息" }).click();
  await page.getByRole("button", { name: "创建企业", exact: true }).click();
  return requests;
}

test("免费建企只提交名称，刷新身份后进入企业管理", async ({ page }) => {
  const requests = await openAccount(page, false);
  const modal = page.getByRole("dialog", { name: "创建企业" });
  await modal.getByPlaceholder("请输入企业名称").fill("免费协作团队");
  await modal.getByRole("button", { name: "创建企业", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\?panel=enterprise-member-management/u);
  expect(requests).toEqual([{ name: "免费协作团队" }]);
  await expect(modal).not.toBeVisible();
});

test("建企失败显示错误并保留输入，页面不跳转", async ({ page }) => {
  const requests = await openAccount(page, true);
  const modal = page.getByRole("dialog", { name: "创建企业" });
  await modal.getByPlaceholder("请输入企业名称").fill("重复企业");
  await modal.getByRole("button", { name: "创建企业", exact: true }).click();
  await expect(modal.getByText("企业名称已存在", { exact: true })).toBeVisible();
  await expect(modal.getByPlaceholder("请输入企业名称")).toHaveValue("重复企业");
  await expect(page).toHaveURL(/\/chat/u);
  expect(requests).toEqual([{ name: "重复企业" }]);
});
