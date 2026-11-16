import { expect, test } from "@playwright/test";

const mockWsOrigin = "ws://127.0.0.1:39290";

/** Clears persisted app state so each black-box scenario starts from a fresh browser profile. */
async function openFresh(page: import("@playwright/test").Page, path: string): Promise<void> {
  await page.goto("/");
  await page.evaluate((serverWsOrigin) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({ serverWsOrigin }));
  }, mockWsOrigin);
  await page.goto(path);
}

/** 校验认证页标题和关键字段可见，避免只依赖 heading 角色。 */
async function expectAuthPage(page: import("@playwright/test").Page, title: string, requiredSelectors: string[]): Promise<void> {
  const shell = page.locator(".auth-shell");
  await expect(shell, `认证页「${title}」外壳应可见`).toBeVisible();
  await expect(shell, `认证页应显示「${title}」`).toContainText(title);
  for (const selector of requiredSelectors) {
    await expect(page.locator(selector), `认证页「${title}」应显示 ${selector}`).toBeVisible();
  }
}

test.describe("CodeFlow UI 基础黑盒用例", () => {
  test("公开首页可访问并能进入登录页", async ({ page }) => {
    await openFresh(page, "/");

    await expect(page.getByText("CodeFlow", { exact: false }).first()).toBeVisible();
    await page.getByRole("button", { name: /进入|登录|试用|开始/ }).first().click();

    await expect(page).toHaveURL(/\/auth\/login/);
    await expectAuthPage(page, "用户登录", ["#login-email", "#login-password"]);
  });

  test("受保护的聊天页未登录时重定向到登录页", async ({ page }) => {
    await openFresh(page, "/chat");

    await expect(page).toHaveURL(/\/auth\/login\/?(?:\?|$)/);
    await expectAuthPage(page, "用户登录", ["#login-email", "#login-password"]);
  });

  test("mobile login dark surface follows manual and system themes", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    try {
      const page = await context.newPage();
      await openFresh(page, "/auth/login");
      for (const themeMode of ["dark", "auto"] as const) {
        await page.evaluate((mode) => localStorage.setItem("ui", JSON.stringify({ themeMode: mode })), themeMode);
        await page.reload();
        const shell = page.locator(".auth-shell--mobile-login");
        await expect(shell).toBeVisible();
        await expect(shell.locator(".auth-shell__card")).toHaveCSS("background-color", "rgba(35, 43, 40, 0.96)");
        await expect(shell.locator(".auth-shell__header h2")).toHaveCSS("color", "rgb(229, 231, 235)");
        await expect(shell.locator(".auth-login__footer .ant-btn-link").first()).toHaveCSS("color", "rgb(244, 179, 149)");
        await expect(page.locator("#login-email")).toHaveCSS("background-color", "rgb(27, 36, 33)");
        await expect(shell.locator(".auth-login__form .ant-input-affix-wrapper")).toHaveCSS("background-color", "rgb(27, 36, 33)");
        const placeholder = await page.locator("#login-email").evaluate((input) => getComputedStyle(input, "::placeholder").color);
        expect(placeholder).toBe("rgb(179, 195, 181)");
      }
      await page.evaluate(() => localStorage.setItem("ui", JSON.stringify({ themeMode: "light" })));
      await page.reload();
      await expect(page.locator(".auth-shell--mobile-login .auth-shell__card"))
        .toHaveCSS("background-color", "rgba(255, 253, 246, 0.92)");
    } finally {
      await context.close();
    }
  });

  test("WeCom mobile login inputs remain touch-editable", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Mobile Safari/537.36 MicroMessenger/8.0 wxwork/4.1",
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await openFresh(page, "/h5/login?redirect=%2Fh5");
      const email = page.locator("#login-email");
      const password = page.locator("#login-password");

      await expect(email).toBeEditable();
      await expect(password).toBeEditable();
      await email.tap();
      await email.pressSequentially("wecom-user@example.test");
      await password.tap();
      await password.pressSequentially("wecom-password");

      await expect(email).toHaveValue("wecom-user@example.test");
      await expect(password).toHaveValue("wecom-password");
      await page.setViewportSize({ width: 390, height: 480 });
      await expect(password).toBeFocused();
    } finally {
      await context.close();
    }
  });
  test("登录页基础表单和校验可见", async ({ page }) => {
    await openFresh(page, "/auth/login");

    await expect(page.locator("#login-email")).toBeVisible();
    const password = page.locator("#login-password");
    await expect(password).toBeVisible();
    await expect(password).toHaveCSS("font-family", /^Arial/u);
    await page.locator(".auth-login__submit").click();

    await expect(page.getByText("请输入邮箱和密码")).toBeVisible();
  });

  test("登录失败时展示服务端错误且停留在登录页", async ({ page }) => {
    await openFresh(page, "/auth/login");

    await page.locator("#login-email").fill("wrong@example.test");
    await page.locator("#login-password").fill("wrong-password");
    await page.locator(".auth-login__submit").click();

    await expect(page.getByText("邮箱或密码不正确")).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/login/);
  });

  test("注册与找回密码入口可从登录页到达", async ({ page }) => {
    await openFresh(page, "/auth/login");

    await page.getByRole("button", { name: "没有账号，去注册" }).click();
    await expect(page).toHaveURL(/\/auth\/register/);
    await expectAuthPage(page, "用户注册", ["#register-email"]);

    await page.goto("/auth/login");
    await page.getByRole("button", { name: "忘记密码" }).click();
    await expect(page).toHaveURL(/\/auth\/forgot/);
    await expectAuthPage(page, "找回密码", ["#forgot-email"]);
  });

  test("公开首页不再提供产品定价入口", async ({ page }) => {
    await openFresh(page, "/");
    await expect(page.getByRole("button", { name: "产品定价", exact: true })).toHaveCount(0);
    await page.goto("/pricing");
    await expect(page.locator(".pricing-page")).toHaveCount(0);
  });
});
