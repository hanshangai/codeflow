import { expect, test, type Page } from "@playwright/test";

// 注入登录态；WS 握手与 presence 由 mock-codeflow-server 提供。
async function installSession(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290",
      authMode: "account",
      accountRole: "enterprise_admin",
      sessionToken: "term-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/chat",
      userSummary: { userId: "term-e2e-user", email: "term-e2e@test.local", fullName: "E2E 用户", phone: "", avatarUrl: null, accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
      accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
    }));
  });
}

test.describe("终端", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:39290/api/test/reset");
  });

  test("TR-01 进入工作台后打开终端面板", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await expect(page.locator(".thread-list")).toBeVisible();
    const rightPanel = page.getByTestId("desktop-right-panel");
    if (!(await rightPanel.isVisible())) {
      await page.getByRole("button", { name: "终端" }).click();
    }
    await expect(rightPanel).toBeVisible();
  });
});
