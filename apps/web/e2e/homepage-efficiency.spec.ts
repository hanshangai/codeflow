import { expect, test } from "@playwright/test";

test("首页呈现研发效率、六项能力和桌面下载", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("把研发规范变成可执行的工作流");
  for (const name of ["可视化规格管理", "内置工作流", "研发度量体系", "多模型一键切换", "可视化自定义", "研发操作一体"]) {
    await expect(page.locator(".features").getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(page.locator(".landing")).not.toContainText("企业 AI 研发中台");
  await expect(page).toHaveTitle("CodeFlow｜规格约束的软件开发工作流平台");
  await page.getByRole("link", { name: /查看功能演示/u }).click();
  await expect(page.locator(".productivity")).toBeInViewport();
  await page.locator(".landing-nav").getByRole("link", { name: "下载桌面版", exact: true }).click();
  await expect(page).toHaveURL(/\/download$/u);
});

test("功能演示、公开内容导航与统一源码入口可操作", async ({ page }) => {
  const modelRequests: string[] = [];
  page.on("request", request => { if (/\/api\/.*(?:send|execute|completion)/u.test(request.url())) modelRequests.push(request.url()); });
  await page.goto("/");
  const nav = page.locator(".landing-nav");
  await expect(nav.getByRole("link", { name: "最佳实践", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "更新日志", exact: true })).toBeVisible();
  await page.locator(".hero").getByRole("link", { name: /查看功能演示/u }).click();
  await expect(page.locator(".productivity")).toBeInViewport();
  const sourceLinks = page.getByRole("link", { name: /查看源码/u });
  expect(await sourceLinks.count()).toBeGreaterThan(0);
  for (const link of await sourceLinks.all()) {
    await expect(link).toHaveAttribute("href", "https://github.com/hanshangai/codeflow");
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

test("首页滚动时保持导航和内容区块可用", async ({ page }) => {
  await page.goto("/");
  await page.locator(".productivity").scrollIntoViewIfNeeded();
  await expect(page.locator(".landing-nav")).toBeInViewport();
  await page.locator(".security").scrollIntoViewIfNeeded();
  await expect(page.locator(".security").getByRole("heading", { name: "系统开源，安全可控", exact: true })).toBeVisible();
});

test("图片加载失败明确显示错误，正文保持可读", async ({ page }) => {
  await page.route("**/images/landing/desktop-workbench.png", route => route.abort("failed"));
  await page.goto("/");
  await expect(page.locator(".hero").getByRole("status")).toContainText("图片加载失败");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("更新日志页跟随暗色主题", async ({ page }, testInfo) => {
  /** color-mix 在 Chromium 下可能输出 color(srgb ...)，统一换算成 0-255。 */
  function channels(value: string): number[] {
    const numbers = value.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
    return value.startsWith("color(srgb") ? numbers.slice(0, 3).map(item => item * 255) : numbers.slice(0, 3);
  }
  await page.route("**/api/release-notes", route => route.fulfill({ json: { ok: true, items: [{ version: "2026.10.19.01", releasedAt: "2026-10-18", title: "", scope: "full" }] } }));
  await page.route("**/api/release-notes/**", route => route.fulfill({ json: { ok: true, note: { version: "2026.10.19.01", releasedAt: "2026-10-18", title: "", scope: "full", content: "## 新增功能\n\n测试更新内容\n\n- 测试条目" } } }));
  await page.goto("/upgrade");
  const root = page.locator(".upgrade-page");
  await expect(root).toBeVisible();
  await expect(page.locator(".upgrade-page__card")).toBeVisible();
  const lightColor = await root.evaluate(element => getComputedStyle(element).color);
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await page.locator("html").getAttribute("data-theme")).toBeNull();
  await expect.poll(() => root.evaluate(element => getComputedStyle(element).color)).not.toBe(lightColor);
  expect(channels(await root.evaluate(element => getComputedStyle(element).color)).reduce((sum, value) => sum + value, 0) / 3).toBeGreaterThan(150);
  expect(channels(await page.locator(".landing-nav__inner").evaluate(element => getComputedStyle(element).backgroundColor)).reduce((sum, value) => sum + value, 0) / 3).toBeLessThan(100);
  expect(channels(await page.locator(".upgrade-page__sidebar-inner").evaluate(element => getComputedStyle(element).backgroundColor)).reduce((sum, value) => sum + value, 0) / 3).toBeLessThan(100);
  expect(channels(await page.locator(".upgrade-page__card-body p").first().evaluate(element => getComputedStyle(element).color)).reduce((sum, value) => sum + value, 0) / 3).toBeGreaterThan(150);
  await page.screenshot({ path: testInfo.outputPath("upgrade-dark.png"), fullPage: true });
});

for (const width of [1024, 1440]) {
  test(`首页在 ${width}px 和减少动态效果设置下无溢出`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    await page.locator(".security").scrollIntoViewIfNeeded();
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
