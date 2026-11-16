import { expect, test, type Page } from "@playwright/test";

// 注入登录态；WS 握手与编排端点由 mock-codeflow-server 提供。
async function installSession(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290",
      authMode: "account",
      accountRole: "enterprise_admin",
      sessionToken: "orch-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/chat",
      userSummary: { userId: "orch-e2e-user", email: "orch-e2e@test.local", fullName: "E2E 用户", phone: "", avatarUrl: null, accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
      accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
    }));
  });
}

test.describe("编排工作台", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:39290/api/test/reset");
  });

  test("OT-01 进入编排工作台，工作区加载", async ({ page }) => {
    await installSession(page);
    await page.goto("/orchestration/workspace");
    await expect(page.locator(".orch-layout")).toBeVisible();
  });

  test("OT-02 需求侧边栏显示", async ({ page }) => {
    await installSession(page);
    await page.goto("/orchestration/workspace");
    await expect(page.locator(".orch-layout__sidebar")).toBeVisible();
  });

  test("OT-03 需求列表渲染并支持搜索过滤", async ({ page }) => {
    const now = Date.now();
    const intakes = [
      { id: "intake-e2e-1", workspaceId: "workspace_chat_core_e2e", triggerMode: "manual", taskType: "feature", title: "订单导出", goal: "支持管理员导出订单", createdAt: now, updatedAt: now },
      { id: "intake-e2e-2", workspaceId: "workspace_chat_core_e2e", triggerMode: "manual", taskType: "bugfix", title: "登录修复", goal: "修复登录页样式", createdAt: now, updatedAt: now },
    ];
    await page.route("**/api/orch/intakes**", route => {
      const search = new URL(route.request().url()).searchParams.get("search") ?? "";
      const matched = search ? intakes.filter(item => item.title.includes(search)) : intakes;
      return route.fulfill({
        json: { ok: true, intakes: matched, hasMore: false, nextCursor: null, statusCounts: [], totalCount: matched.length, listMetaById: {} },
      });
    });
    await installSession(page);
    await page.goto("/orchestration/workspace");
    await expect(page.locator(".task-sidebar__card-title").getByText("订单导出")).toBeVisible();
    await expect(page.locator(".task-sidebar__card-title").getByText("登录修复")).toBeVisible();
    await page.getByPlaceholder("搜索需求...").fill("订单");
    await expect(page.locator(".task-sidebar__card-title").getByText("订单导出")).toHaveCount(1);
    await expect(page.locator(".task-sidebar__card-title").getByText("登录修复")).toHaveCount(0);
  });

  test("OT-04 点击需求后显示需求详情", async ({ page }) => {
    const now = Date.now();
    const goal = "支持管理员导出订单";
    const intakes = [
      { id: "intake-e2e-1", workspaceId: "workspace_chat_core_e2e", triggerMode: "manual", taskType: "feature", title: "订单导出", goal, createdAt: now, updatedAt: now },
    ];
    await page.route("**/api/orch/intakes**", route => route.fulfill({
      json: { ok: true, intakes, hasMore: false, nextCursor: null, statusCounts: [], totalCount: intakes.length, listMetaById: {} },
    }));
    await installSession(page);
    await page.goto("/orchestration/workspace");
    await page.locator(".task-sidebar__card-title").getByText("订单导出").click();
    await expect(page.locator(".task-sidebar__card--active")).toBeVisible();
    await expect(page.getByText(goal).first()).toBeVisible();
  });

  test("OT-05 流程列表渲染并可切换选中", async ({ page }) => {
    const now = Date.now();
    const workflows = ["标准开发流程", "轻量修复流程"].map((name, index) => ({
      id: `workflow-e2e-${index + 1}`,
      workspaceId: "workspace_chat_core_e2e",
      name,
      description: "",
      nodes: [{ id: "dev", type: "role", label: "实现", position: { x: 0, y: 0 } }],
      edges: [],
      kind: "custom",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));
    await page.route("**/api/orch/workflows**", route => route.fulfill({ json: { ok: true, workflows } }));
    await installSession(page);
    await page.goto("/orchestration/assets");
    const first = page.locator(".wf-sidebar__item-name-text").getByText("标准开发流程");
    const second = page.locator(".wf-sidebar__item-name-text").getByText("轻量修复流程");
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    // 默认会自动选中首项；点击第二项后必须切换选中，才能证明点击真实生效。
    await expect(page.locator(".wf-sidebar__item--selected")).toContainText("标准开发流程");
    await second.click();
    await expect(page.locator(".wf-sidebar__item--selected")).toContainText("轻量修复流程");
  });
});
