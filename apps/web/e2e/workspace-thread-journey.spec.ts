import { expect, test, type Page } from "@playwright/test";

// 注入企业管理员会话；mock 负责工作区、会话与消息接口。
async function installSession(page: Page): Promise<void> {
  await page.route("**/api/account/me/model-context-preferences", route => route.fulfill({ json: { ok: true, preferences: [] } }));
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290",
      authMode: "account",
      accountRole: "enterprise_admin",
      sessionToken: "journey-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/chat",
      userSummary: { userId: "journey-e2e-user", email: "journey-e2e@test.local", fullName: "E2E 用户", phone: "", avatarUrl: null, accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
      accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
    }));
  });
}

test.describe("工作区到消息的完整旅程", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:39290/api/test/reset");
  });

  test("创建工作区、新建会话并发送消息", async ({ page }) => {
    const created = { id: "workspace_journey_e2e", title: "旅程工作区", path: "D:/e2e-journey", kind: "local", createdAt: 1, updatedAt: 1 };
    let workspaces = [{ id: "workspace_chat_core_e2e", title: "E2E 工作区", path: "D:/e2e", kind: "local", createdAt: 1, updatedAt: 1 }];
    await page.route("**/api/workspaces?**", route => route.fulfill({
      json: { ok: true, workspaces, workspaceListAuthoritative: true },
    }));
    await page.route("**/api/workspaces/upsert", route => {
      workspaces = [...workspaces, created];
      return route.fulfill({ json: { ok: true, workspace: created } });
    });
    await installSession(page);
    await page.goto("/chat");

    await test.step("创建工作区", async () => {
      await page.locator(".ws-compact-trigger").click();
      await page.getByRole("button", { name: "新建工作区", exact: true }).click();
      const dialog = page.locator(".ant-modal:visible");
      await dialog.getByPlaceholder(/XXX项目/u).fill("旅程工作区");
      await dialog.getByPlaceholder(/ 或 /u).fill("D:/e2e-journey");
      await dialog.getByRole("button", { name: /创\s*建/u }).click();
      await expect(page.locator(".ws-compact-trigger")).toHaveAttribute("aria-label", /旅程工作区/u, { timeout: 20_000 });
    });

    await test.step("在新工作区新建会话", async () => {
      await page.getByText("+ 新建").click();
      await page.getByRole("dialog").getByPlaceholder(/例如：修复登录页样式/u).fill("旅程会话");
      await page.getByRole("dialog").getByRole("button", { name: /确\s*定/u }).click();
      await expect(page.getByText("旅程会话").first()).toBeVisible();
    });

    await test.step("发送消息并收到回复", async () => {
      const input = page.locator(".composer__textarea");
      await input.fill("工作区旅程验证");
      await page.locator(".composer__send-btn").click();
      await expect(page.getByText("已收到：工作区旅程验证").first()).toBeVisible({ timeout: 10_000 });
    });
  });
});
