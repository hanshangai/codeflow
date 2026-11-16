import { expect, test } from "@playwright/test";

test("首页呈现研发效率、六项能力和桌面下载", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("CodeFlow · 专注提升研发效率");
  for (const name of ["自动配置环境，开箱即用", "多模型一键切换", "灵活编排工作流", "移动远程操作", "系统开源，安全可控", "Token 流量折扣"]) {
    await expect(page.locator("#features").getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(page.locator(".landing")).not.toContainText("企业 AI 研发中台");
  await expect(page).toHaveTitle("CodeFlow｜专注提升研发效率的 AI 研发工作台");
  await page.getByRole("link", { name: "查看功能演示", exact: true }).click();
  await expect(page.locator("#demo")).toBeInViewport();
  await page.locator(".landing-nav").getByRole("link", { name: "下载桌面版", exact: true }).click();
  await expect(page).toHaveURL(/\/download$/u);
});

test("演示、公开内容导航与统一源码入口可操作", async ({ page }) => {
  const modelRequests: string[] = [];
  page.on("request", request => { if (/\/api\/.*(?:send|execute|completion)/u.test(request.url())) modelRequests.push(request.url()); });
  await page.goto("/");
  const nav = page.locator(".landing-nav");
  await expect(nav.getByRole("link", { name: "最佳实践", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "更新日志", exact: true })).toBeVisible();
  const demo = page.locator("#demo");
  const change = demo.getByRole("button", { name: "03 查看改动" });
  await change.click();
  await expect(change).toHaveAttribute("aria-pressed", "true");
  await expect(demo.getByRole("heading", { name: "看清差异，再决定下一步" })).toBeVisible();
  await change.press("Tab");
  await demo.getByRole("button", { name: "01 理解现有实现" }).focus();
  await page.keyboard.press("Enter");
  await expect(demo.getByRole("button", { name: "01 理解现有实现" })).toHaveAttribute("aria-pressed", "true");
  const sourceLinks = page.getByRole("link", { name: "查看源码", exact: true });
  expect(await sourceLinks.count()).toBeGreaterThan(0);
  for (const link of await sourceLinks.all()) {
    await expect(link).toHaveAttribute("href", "https://github.com/REPLACE_WITH_OWNER/REPLACE_WITH_REPO");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  await nav.getByRole("link", { name: "最佳实践", exact: true }).click();
  await expect(page).toHaveURL(/\/best-practices$/u);
  await expect(nav.getByRole("link", { name: "最佳实践", exact: true })).toHaveClass(/landing-nav__link--active/u);
  await nav.getByRole("link", { name: "更新日志", exact: true }).click();
  await expect(page).toHaveURL(/\/upgrade$/u);
  await expect(nav.getByRole("link", { name: "更新日志", exact: true })).toHaveClass(/landing-nav__link--active/u);
  expect(modelRequests).toEqual([]);
});

test("首页滚动时保持导航和上手引导可用", async ({ page }) => {
  await page.goto("/");
  await page.locator("#scenarios").scrollIntoViewIfNeeded();
  await expect(page.locator(".landing-nav")).toBeInViewport();
  await page.locator("#start").scrollIntoViewIfNeeded();
  await expect(page.locator("#start").getByRole("heading", { name: "从第一个任务，开始更高效的研发" })).toBeVisible();
});

test("图片加载失败明确显示错误，正文保持可读", async ({ page }) => {
  await page.route("**/images/landing/efficiency-workbench.png", route => route.abort("failed"));
  await page.goto("/");
  await expect(page.locator(".hero").getByRole("status")).toContainText("图片加载失败");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

for (const width of [1024, 1440]) {
  test(`首页在 ${width}px 和减少动态效果设置下无溢出`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    await page.locator("#start").scrollIntoViewIfNeeded();
    await page.evaluate(async () => {
      await Promise.all([...document.querySelectorAll<HTMLImageElement>(".landing img")].map(image => {
        image.loading = "eager";
        return image.decode();
      }));
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`homepage-${width}.png`), fullPage: true });
    if (width === 1440) {
      await page.evaluate(async () => {
        const { pinia } = await import("../src/store/pinia.ts");
        const { useUiStore } = await import("../src/store/ui.ts");
        useUiStore(pinia).themeMode = "dark";
      });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.screenshot({ path: testInfo.outputPath("homepage-dark.png"), fullPage: true });
    }
  });
}
