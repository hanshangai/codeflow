import { expect, test, type Page } from "@playwright/test";

const enterpriseId = "enterprise_chat_core_e2e";
const workspaceId = "shared_workspace_rename_e2e";

async function installHarness(page: Page): Promise<{ patchBodies: unknown[] }> {
  const patchBodies: unknown[] = [];
  // 先进入公开首页再写 localStorage（openFresh 模式），与其它本地基线一致。
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290",
      authMode: "account",
      accountRole: "enterprise_admin",
      sessionToken: "rename-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/chat",
      userSummary: { userId: "rename-e2e-user", email: "rename-e2e@test.local", fullName: "E2E 用户", phone: "", avatarUrl: null, accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
      accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
    }));
  });
  // 仅精确拦截共享空间读写端点，其余 HTTP/WS 全走 mock server（保证 app 装配完整）。
  await page.route(/\/api\/account\/enterprise\/shared-workspaces/u, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (method === "GET" && path.endsWith("/api/account/enterprise/shared-workspaces")) {
      const renamed = patchBodies.length > 0;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          total: 1,
          items: [{
            id: workspaceId,
            enterpriseId,
            name: renamed ? "重命名后的共享空间" : "原共享空间",
            description: "",
            createdByUserId: "enterprise_admin_e2e",
            workspaceAdminUserId: "workspace_admin_e2e",
            lifecycleStatus: "active",
            hostStatus: "unbound",
            memberCount: 1,
            createdAt: 1,
            updatedAt: renamed ? 2 : 1,
            currentUserRole: "enterprise_admin",
            host: null,
          }],
        }),
      });
      return;
    }
    if (method === "PATCH" && path.endsWith(`/shared-workspaces/${workspaceId}`)) {
      patchBodies.push(request.postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          sharedWorkspace: {
            id: workspaceId,
            enterpriseId,
            name: "重命名后的共享空间",
            description: "",
            createdByUserId: "enterprise_admin_e2e",
            workspaceAdminUserId: "workspace_admin_e2e",
            lifecycleStatus: "active",
            hostStatus: "unbound",
            memberCount: 1,
            createdAt: 1,
            updatedAt: 2,
            host: null,
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  // 进入会话工作台建立连接，再经顶部"设置"切到管理视图。
  await page.goto("/chat");
  await expect(page.locator(".thread-list")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.locator(".admin-layout")).toBeVisible({ timeout: 10_000 });
  return { patchBodies };
}

test("企业管理员可以编辑共享工作区名称并在刷新列表后看到新名称", async ({ page }) => {
  const harness = await installHarness(page);
  await page.getByText("共享空间", { exact: true }).first().click();
  await expect(page.getByText("原共享空间", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑" }).click();
  await expect(page.getByRole("dialog", { name: "编辑共享工作区" })).toBeVisible();
  await page.getByRole("dialog").getByPlaceholder("请输入 2-50 个字符").fill("重命名后的共享空间");
  await page.getByRole("dialog").getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByText("重命名后的共享空间", { exact: true })).toBeVisible();
  expect(harness.patchBodies).toEqual([{ name: "重命名后的共享空间" }]);
});
