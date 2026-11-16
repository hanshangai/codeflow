import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function installTrace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const trace = { pushes: 0, transitions: [] as string[] };
    Object.assign(window, { mobileNavigationTrace: trace });
    const push = history.pushState.bind(history);
    history.pushState = (...args) => { trace.pushes++; return push(...args); };
    document.addEventListener("transitionrun", event => {
      const target = event.target;
      if (target instanceof HTMLElement && target.classList.contains("mobile-page")) trace.transitions.push(target.className);
    });
  });
}

async function clearTrace(page: Page): Promise<void> {
  await page.evaluate(() => Object.assign((window as any).mobileNavigationTrace, { pushes: 0, transitions: [] }));
}

async function readTrace(page: Page): Promise<{ pushes: number; transitions: string[] }> {
  return page.evaluate(() => (window as any).mobileNavigationTrace);
}

async function settlePage(page: Page): Promise<void> {
  await expect(page.locator(".mobile-page")).toHaveCount(1);
  await expect(page.locator(".mobile-page")).not.toHaveClass(/slide-/u);
}

test.beforeEach(async ({ page }) => { await installTrace(page); });

async function openWorkbench(
  page: Page,
  persistedTab: "sessions" | "home" = "sessions",
  options: { entryPath?: string; expectThreadList?: boolean } = {},
): Promise<void> {
  const { entryPath = "/chat", expectThreadList = true } = options;
  await page.goto("/");
  await page.evaluate(tab => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("ui", JSON.stringify({ activeMobileTab: tab }));
    localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290", authMode: "account", accountRole: "enterprise_admin",
      sessionToken: "mobile-navigation-test", sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/chat",
      userSummary: { userId: "mobile-navigation", email: "navigation@example.test", fullName: "导航测试", accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e" },
      accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e" },
    }));
  }, persistedTab);
  await page.goto(entryPath);
  if (expectThreadList) await expect(page.locator(".h5-workbench-home")).toBeVisible();
}

test("持久化首页 Tab 后进入会话并返回仍停留在会话列表", async ({ page, request }) => {
  await request.post("http://127.0.0.1:39290/api/test/reset");
  await openWorkbench(page, "home");
  const sessionsTab = page.locator(".mobile-tabs").getByRole("button", { name: "会话", exact: true });
  await expect(sessionsTab).toHaveClass(/active/u);
  await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
  await page.getByRole("dialog").getByPlaceholder(/例如：/u).fill("首页状态恢复测试");
  await page.getByRole("dialog").getByRole("button", { name: /创建会话|确\s*定/u }).click();
  await settlePage(page);
  expect(new URL(page.url()).searchParams.get("threadId")).toBeTruthy();
  await page.getByRole("button", { name: "返回会话列表" }).click();
  await expect(page.locator(".mobile-page")).toHaveCount(0);
  await expect(page.locator(".h5-workbench-home")).toBeVisible();
  await expect(sessionsTab).toHaveClass(/active/u);
  expect(new URL(page.url()).searchParams.has("threadId")).toBe(false);
});

test("返回列表后单击一次会话即可重新进入详情", async ({ page, request }) => {
  await request.post("http://127.0.0.1:39290/api/test/reset");
  await openWorkbench(page);
  await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
  await page.getByRole("dialog").getByPlaceholder(/例如：/u).fill("返回重入测试会话");
  await page.getByRole("dialog").getByRole("button", { name: /创建会话|确\s*定/u }).click();
  await settlePage(page);
  const threadId = new URL(page.url()).searchParams.get("threadId");
  await page.getByRole("button", { name: "返回会话列表" }).click();
  await expect(page.locator(".mobile-page")).toHaveCount(0);
  await page.locator(".h5-thread-row").filter({ hasText: "返回重入测试会话" }).click();
  await settlePage(page);
  await expect(page.locator(".mobile-page__header")).toContainText("返回重入测试会话");
  expect(new URL(page.url()).searchParams.get("threadId")).toBe(threadId);
});

test("聊天页返回列表后前进恢复同一会话", async ({ page, request }) => {
  await request.post("http://127.0.0.1:39290/api/test/reset");
  await openWorkbench(page);
  await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
  await page.getByRole("dialog").getByPlaceholder(/例如：/u).fill("导航测试会话");
  await page.getByRole("dialog").getByRole("button", { name: /创建会话|确\s*定/u }).click();
  await settlePage(page);
  const chatUrl = page.url();
  expect(new URL(chatUrl).searchParams.get("threadId")).toBeTruthy();
  await clearTrace(page);
  await page.goBack();
  await expect(page.locator(".mobile-page")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("threadId")).toBe(false);
  await page.goForward();
  await expect(page).toHaveURL(chatUrl);
  await expect(page.getByRole("button", { name: "返回会话列表" })).toBeVisible();
  await settlePage(page);
  expect(await readTrace(page)).toEqual({ pushes: 0, transitions: [] });
});

test("文件预览返回后可前进恢复，预览正文不会写入浏览器历史", async ({ page, request }) => {
  await request.post("http://127.0.0.1:39290/api/test/reset");
  await openWorkbench(page);
  await page.locator(".mobile-tabs").getByRole("button", { name: "文件", exact: true }).click();
  await page.getByText("src", { exact: true }).first().click();
  await page.getByText("index.ts", { exact: true }).first().click();
  await settlePage(page);
  await expect(page.locator(".mobile-page__header")).toContainText("index.ts");
  expect(await page.evaluate(() => JSON.stringify(history.state))).not.toMatch(/diffOriginal|base64|你好/u);
  await clearTrace(page);
  await page.goBack();
  await expect(page.locator(".mobile-page")).toHaveCount(0);
  await page.goForward();
  await settlePage(page);
  await expect(page.locator(".mobile-page__header")).toContainText("index.ts");
  expect(await readTrace(page)).toEqual({ pushes: 0, transitions: [] });
});
