import { expect, test, type Page } from "@playwright/test";

// 注入登录态；WS 握手与 threads 端点由 mock-codeflow-server 提供。
async function installSession(page: Page): Promise<void> {
  // 创建会话会读取账号模型偏好；mock 未提供该路由，本地空偏好即可，避免 404 阻断创建。
  await page.route("**/api/account/me/model-context-preferences", route => route.fulfill({ json: { ok: true, preferences: [] } }));
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290",
      authMode: "account",
      accountRole: "enterprise_admin",
      sessionToken: "composer-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/chat",
      userSummary: { userId: "composer-e2e-user", email: "composer-e2e@test.local", fullName: "E2E 用户", phone: "", avatarUrl: null, accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
      accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
    }));
  });
}

/** 通过「+ 新建」弹框创建一个会话并断言其出现在列表。 */
async function createThread(page: Page, title: string): Promise<void> {
  await page.getByText("+ 新建").click();
  await page.getByRole("dialog").getByPlaceholder(/例如：修复登录页样式/u).fill(title);
  await page.getByRole("dialog").getByRole("button", { name: /确\s*定/u }).click();
  await expect(page.getByText(title).first()).toBeVisible();
}

test.describe("聊天输入区", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:39290/api/test/reset");
  });

  test("Enter 发送，Shift+Enter 只换行", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await createThread(page, "按键会话");
    const input = page.locator(".composer__textarea");
    await input.fill("第一行");
    await input.press("Shift+Enter");
    await input.pressSequentially("第二行", { delay: 20 });
    await expect(input).toHaveValue("第一行\n第二行");
    await expect(page.getByText(/^已收到：/u)).toHaveCount(0);
    await input.press("Enter");
    await expect(page.getByText(/已收到：第一行\s+第二行/u).first()).toBeVisible();
  });

  test("空输入时发送按钮禁用，输入后启用", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await createThread(page, "空输入会话");
    const input = page.locator(".composer__textarea");
    const send = page.locator(".composer__send-btn");
    await expect(send).toBeDisabled();
    await input.fill("可发送");
    await expect(send).toBeEnabled();
  });

  test("附件选择后显示并可移除", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await createThread(page, "附件会话");
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "acceptance-composer.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("附件内容"),
    });
    await expect(page.locator(".composer__attachment-name").getByText("acceptance-composer.txt")).toBeVisible();
    await expect(page.locator(".composer__send-btn")).toBeEnabled();
    await page.locator(".composer__attachment-name").getByText("acceptance-composer.txt").locator("xpath=ancestor::*[self::div or self::li][1]")
      .getByRole("button", { name: "移除", exact: true }).click();
    await expect(page.locator(".composer__attachment-name")).toHaveCount(0);
  });

  test("常用提示词新增并插入输入框", async ({ page }) => {
    // mock 未提供常用提示词接口，用内存集合模拟账号范围的新增与读取。
    let revision = 1;
    const items: Array<Record<string, unknown>> = [];
    await page.route("**/api/account/me/quick-phrases", route => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON() as { title?: string; content?: string };
        items.push({
          id: `qp-${items.length + 1}`,
          title: String(body.title ?? ""),
          content: String(body.content ?? ""),
          sortOrder: items.length,
          version: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        revision += 1;
      }
      return route.fulfill({ json: { ok: true, revision, items } });
    });
    await installSession(page);
    await page.goto("/chat");
    await createThread(page, "提示词会话");
    await page.getByRole("button", { name: "常用提示词" }).click();
    await page.locator(".quick-phrase-head").getByRole("button").click();
    const modal = page.locator(".ant-modal:visible");
    await modal.locator("input").first().fill("验收提示词");
    await modal.locator("textarea").first().fill("请总结本轮改动");
    await modal.locator(".ant-btn-primary").click();
    await page.locator(".quick-phrase-item").filter({ hasText: "验收提示词" }).click();
    await expect(page.locator(".composer__textarea")).toHaveValue(/请总结本轮改动/u);
  });
});
