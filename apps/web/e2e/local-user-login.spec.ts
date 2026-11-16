import { expect, test } from "@playwright/test";

// 本机联调用例：账号与地址只从环境变量读取，不写入仓库。
const email = process.env.CODEFLOWAI_E2E_USER_EMAIL ?? "";
const password = process.env.CODEFLOWAI_E2E_USER_PASSWORD ?? "";
const localWeb = (process.env.CODEFLOWAI_E2E_LOCAL_WEB ?? "").replace(/\/+$/u, "");

test.describe("普通用户已登录（本机联调）", () => {
  test.skip(!email || !password || !localWeb, "需设置 CODEFLOWAI_E2E_USER_EMAIL / CODEFLOWAI_E2E_USER_PASSWORD / CODEFLOWAI_E2E_LOCAL_WEB");

  test("普通用户真实登录后进入工作台", async ({ page }) => {
    await page.goto(localWeb + "/auth/login");
    await page.getByPlaceholder("name@company.com").fill(email);
    await page.getByPlaceholder("请输入密码").fill(password);
    await page.getByRole("button", { name: /登\s*录/u }).click();
    await expect(page).not.toHaveURL(/\/auth\/login/u, { timeout: 45_000 });
    await expect(page.locator(".user-menu-trigger").first()).toBeVisible({ timeout: 45_000 });
  });
});
