import { expect, test, type Page } from "@playwright/test";

const workspaceId = "left-sidebar-resize-workspace";
const mockWsOrigin = "ws://127.0.0.1:39290";

async function installHarness(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.addInitScript(({ serverWsOrigin }) => {
    if (window.localStorage.getItem("__left_sidebar_harness_initialized") === "1") return;
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.sessionStorage.setItem("codeflowai.webInstanceId", "left-sidebar-web-instance");
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin,
      authMode: "account",
      accountRole: "super_admin",
      sessionToken: "left-sidebar-resize-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/chat",
      userSummary: { userId: "left-sidebar-resize-user", email: "resize-e2e@test.local", accountRole: "super_admin", status: "active" },
      accessContext: { identityType: "SUPER_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "SUPER_ADMIN" },
    }));
    window.localStorage.setItem("ui", JSON.stringify({
      rightPanelMode: "explorer",
      explorerPanelWidth: 400,
      threadFilterTab: "all",
      leftSidebarWidth: 360,
      leftSidebarCollapsed: false,
    }));
    window.sessionStorage.setItem(
      "codeflowai.workspace.tab::ws%3A%2F%2F127.0.0.1%3A39290::left-sidebar-resize-user::left-sidebar-web-instance",
      "left-sidebar-resize-workspace",
    );
    window.localStorage.setItem("__left_sidebar_harness_initialized", "1");
  }, { serverWsOrigin: mockWsOrigin });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (url.pathname === "/api/workspaces") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          workspaces: [{ id: workspaceId, title: "拖拽验证工作区", path: "D:/left-sidebar-resize", ownerClientId: "left-sidebar-client", createdAt: 1, updatedAt: 1, kind: "local", entryStatus: "available" }],
          workspaceListAuthoritative: true,
          activeClientCount: 1,
          workspaceListSuccessCount: 1,
          workspaceListFailureCount: 0,
        }),
      });
      return;
    }
    if (url.pathname === "/api/account/me/summary") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          userId: "left-sidebar-resize-user",
          email: "resize-e2e@test.local",
          fullName: "调宽测试用户",
          accountRole: "super_admin",
          status: "active",
          accessContext: { identityType: "SUPER_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "SUPER_ADMIN" },
          packageSummary: null,
          enterpriseSummary: null,
          enterpriseMemberPackageSummary: null,
          pendingEnterpriseInvitations: [],
          keySummary: null,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        items: [],
        threads: [],
        workspaces: [],
        requirements: [],
        instances: [],
        workflows: [],
        roles: [],
        knowledgeBundles: [],
        skills: [],
        toolsets: [],
        artifacts: [],
        total: 0,
      }),
    });
  });

  await page.routeWebSocket(/\/ws\/web(?:\?|$)/u, (ws) => {
    ws.onMessage(() => undefined);
    setTimeout(() => {
      ws.send(JSON.stringify({
        t: "web.helloAck",
        webSessionId: "left-sidebar-resize-session",
        serverNow: Date.now(),
        authMode: "account",
        accountRole: "super_admin",
        homePath: "/chat",
        userSummary: { userId: "left-sidebar-resize-user", email: "resize-e2e@test.local", fullName: "调宽测试用户", accountRole: "super_admin", status: "active" },
        accessContext: { identityType: "SUPER_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "SUPER_ADMIN" },
      }));
      ws.send(JSON.stringify({
        t: "presence.event",
        event: {
          type: "presence.updated",
          ts: Date.now(),
          payload: {
            onlineWebCount: 1,
            clientOnline: true,
            onlineClients: [{
              clientId: "left-sidebar-client",
              name: "左栏测试 Client",
              version: "2026.08.21.01",
              connectedAt: Date.now(),
              workspaceIds: [workspaceId],
            }],
          },
        },
      }));
    }, 0);
  });
}

async function openEntry(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForTimeout(1000);
  await expect(page.locator('[data-testid="left-sidebar"]:visible')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("left-sidebar-resize-handle")).toBeVisible();
}

async function switchEntry(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: label }).first().click();
  await expect(page.locator('[data-testid="left-sidebar"]:visible')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="desktop-sidebar-toggle"]:visible')).toBeVisible();
}

async function readSidebarLayoutMetrics(page: Page): Promise<{
  sidebarHeight: number;
  scrollportHeight: number;
  scrollClientHeight: number;
  scrollHeight: number;
  overflowY: string;
}> {
  return page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>('[data-testid="left-sidebar"]:not([style*="display: none"])');
    const scrollport = document.querySelector<HTMLElement>('[data-testid="left-sidebar-scrollport"]:not([style*="display: none"])');
    const scroll = document.querySelector<HTMLElement>('.thread-list__scroll');
    if (!sidebar || !scrollport || !scroll) throw new Error("left sidebar scroll containers are not mounted");
    const sidebarRect = sidebar.getBoundingClientRect();
    const scrollportRect = scrollport.getBoundingClientRect();
    return {
      sidebarHeight: sidebarRect.height,
      scrollportHeight: scrollportRect.height,
      scrollClientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      overflowY: getComputedStyle(scroll).overflowY,
    };
  });
}

test.describe("桌面左侧边栏拖拽调宽", () => {
  test.setTimeout(120_000);
  test("会话、需求编排和 AI 资产共享拖拽宽度并在刷新后恢复", async ({ page }) => {
    await installHarness(page, { width: 1440, height: 900 });
    await openEntry(page, "/chat");

    const sidebar = page.locator('[data-testid="left-sidebar"]:visible');
    const handle = page.getByTestId("left-sidebar-resize-handle");
    await expect(handle).toHaveAttribute("role", "separator");
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    const before = await sidebar.boundingBox();
    const handleBox = await handle.boundingBox();
    expect(before).not.toBeNull();
    expect(handleBox).not.toBeNull();
    await page.mouse.move(handleBox!.x + 4, handleBox!.y + 120);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + 104, handleBox!.y + 120);
    await page.mouse.up();
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan((before?.width ?? 0) + 80);

    await handle.focus();
    await handle.press("Home");
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBe(300);
    await handle.press("End");
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBe(520);

    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("ui") ?? "{}"));
    expect(stored.leftSidebarWidth).toBeGreaterThan(440);

    await switchEntry(page, "编排");
    const orchestrationWidth = (await page.locator('[data-testid="left-sidebar"]:visible').boundingBox())?.width ?? 0;
    expect(orchestrationWidth).toBeGreaterThan(440);
    await page.getByRole("button", { name: "资产库" }).first().click();
    await expect(page.locator('[data-testid="left-sidebar"]:visible')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("left-sidebar-resize-handle")).toBeVisible();
    const assetWidth = (await page.locator('[data-testid="left-sidebar"]:visible').boundingBox())?.width ?? 0;
    expect(assetWidth).toBeGreaterThan(440);

    await page.reload();
    await expect.poll(async () => (await page.locator('[data-testid="left-sidebar"]:visible').boundingBox())?.width ?? 0).toBeGreaterThan(440);
    await page.screenshot({ path: "../../.tmp/playwright-output/local/left-sidebar-resize-ui.png", fullPage: false });
  });

  test("三入口共享折叠状态，键盘与减少动态效果保持可用并兼容右侧文件面板", async ({ page }) => {
    await installHarness(page, { width: 1440, height: 900 });
    await openEntry(page, "/chat");

    const sidebar = page.locator('[data-testid="left-sidebar"]:visible');
    const main = page.locator('[data-testid="desktop-main-pane"]:visible').last();
    const collapseToggle = page.locator('[data-testid="desktop-sidebar-toggle"]:visible');
    const expandedWidth = (await sidebar.boundingBox())?.width ?? 0;
    const expandedMainWidth = (await main.boundingBox())?.width ?? 0;
    const searchInput = page.getByPlaceholder("搜索会话标题");
    await searchInput.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = "保留的搜索条件";
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "保留的搜索条件",
        inputType: "insertText",
      }));
    });
    const scrollPosition = await page.locator(".thread-list__scroll").evaluate((element) => {
      for (let index = 0; index < 80; index += 1) {
        const row = document.createElement("div");
        row.className = index === 37 ? "thread-list__item thread-list__item--selected" : "thread-list__item";
        row.style.height = "32px";
        row.style.flex = "0 0 32px";
        row.textContent = `生命周期测试行 ${index}`;
        element.append(row);
      }
      element.scrollTop = 320;
      return element.scrollTop;
    });
    expect(scrollPosition).toBeGreaterThan(0);
    await expect(collapseToggle).toHaveAttribute("aria-label", "收起左侧边栏");
    await expect(collapseToggle).toHaveAttribute("aria-expanded", "true");
    await collapseToggle.focus();
    await collapseToggle.press("Space");

    const expandToggle = page.locator('[data-testid="desktop-sidebar-toggle"]:visible');
    await expect(expandToggle).toHaveAttribute("aria-label", "展开左侧边栏");
    await expect(expandToggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBe(32);
    await expect.poll(async () => (await main.boundingBox())?.width ?? 0).toBeGreaterThan(expandedMainWidth + 250);
    await expect(page.locator("#desktop-left-sidebar-content")).toHaveCount(1);
    await expect(page.locator("#desktop-left-sidebar-content")).toHaveAttribute("aria-hidden", "true");
    expect(await page.getByTestId("left-sidebar-resize-handle").evaluateAll((handles) => handles.every((handle) => getComputedStyle(handle).display === "none"))).toBe(true);
    await expect(searchInput).toHaveValue("保留的搜索条件");
    await expect(page.locator(".thread-list__segmented .ant-segmented-item-selected")).toContainText("普通会话");
    await expect(page.locator(".thread-list__item--selected")).toHaveText("生命周期测试行 37");
    expect(await page.locator(".thread-list__scroll").evaluate((element) => element.scrollTop)).toBe(scrollPosition);

    const mainClickCount = await main.evaluate((element) => {
      element.dataset.collapseTestClicks = "0";
      element.addEventListener("click", () => {
        element.dataset.collapseTestClicks = String(Number(element.dataset.collapseTestClicks ?? "0") + 1);
      }, { once: true });
      return Number(element.dataset.collapseTestClicks);
    });
    expect(mainClickCount).toBe(0);
    await main.click({ position: { x: Math.max(40, expandedMainWidth / 2), y: 80 } });
    await expect.poll(async () => Number(await main.getAttribute("data-collapse-test-clicks"))).toBe(1);

    await switchEntry(page, "编排");
    await expect(page.locator('[data-testid="desktop-sidebar-toggle"]:visible')).toHaveAttribute("aria-label", "展开左侧边栏");
    await switchEntry(page, "资产库");
    await expect(page.locator('[data-testid="desktop-sidebar-toggle"]:visible')).toHaveAttribute("aria-label", "展开左侧边栏");
    await switchEntry(page, "会话");
    await expect(searchInput).toHaveValue("保留的搜索条件");
    await expect(page.locator(".thread-list__segmented .ant-segmented-item-selected")).toContainText("普通会话");
    await expect(page.locator(".thread-list__item--selected")).toHaveText("生命周期测试行 37");
    expect(await page.locator(".thread-list__scroll").evaluate((element) => element.scrollTop)).toBe(scrollPosition);

    await page.locator('[data-testid="desktop-sidebar-toggle"]:visible').click();
    await expect.poll(async () => (await page.locator('[data-testid="left-sidebar"]:visible').boundingBox())?.width ?? 0).toBeGreaterThan(expandedWidth - 2);
    await page.locator('[data-testid="desktop-sidebar-toggle"]:visible').click();
    await expect.poll(async () => (await page.locator('[data-testid="left-sidebar"]:visible').boundingBox())?.width ?? 0).toBe(32);

    const rightPanel = page.getByTestId("desktop-right-panel");
    if (!(await rightPanel.isVisible())) {
      await page.getByRole("button", { name: "文件" }).click();
    }
    await expect(rightPanel).toBeVisible();
    const collapsedLeft = await page.locator('[data-testid="left-sidebar"]:visible').boundingBox();
    const collapsedMain = await main.boundingBox();
    const right = await rightPanel.boundingBox();
    expect(collapsedLeft && collapsedMain && right).toBeTruthy();
    expect(collapsedLeft!.x + collapsedLeft!.width).toBeLessThanOrEqual(collapsedMain!.x + 1);
    expect(collapsedMain!.x + collapsedMain!.width).toBeLessThanOrEqual(right!.x + 1);

    await page.emulateMedia({ reducedMotion: "reduce" });
    const transitionDuration = await page.locator('[data-testid="left-sidebar"]:visible').evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(transitionDuration).toBe("0s");
    await page.locator('[data-testid="desktop-sidebar-toggle"]:visible').focus();
    await page.locator('[data-testid="desktop-sidebar-toggle"]:visible').press("Enter");
    await expect.poll(async () => (await page.locator('[data-testid="left-sidebar"]:visible').boundingBox())?.width ?? 0).toBeGreaterThan(300);

    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("ui") ?? "{}"));
    expect(stored.leftSidebarCollapsed).toBe(false);
    await page.locator('[data-testid="desktop-sidebar-toggle"]:visible').press("Space");
    await page.reload();
    await expect.poll(async () => (await page.locator('[data-testid="left-sidebar"]:visible').boundingBox())?.width ?? 0).toBe(32);
    await expect(page.locator('[data-testid="desktop-sidebar-toggle"]:visible')).toHaveAttribute("aria-label", "展开左侧边栏");
  });

  test("1200px 临界视口与右侧文件面板保持三栏不相交", async ({ page }) => {
    await installHarness(page, { width: 1200, height: 800 });
    await page.addInitScript(() => {
      window.localStorage.setItem("ui", JSON.stringify({ rightPanelMode: "explorer", explorerPanelWidth: 700, leftSidebarWidth: 520 }));
    });
    await openEntry(page, "/chat");
    const left = await page.locator('[data-testid="left-sidebar"]:visible').boundingBox();
    const main = await page.getByTestId("desktop-main-pane").boundingBox();
    const right = await page.getByTestId("desktop-right-panel").boundingBox();
    expect(left && main && right).toBeTruthy();
    expect(left!.x + left!.width).toBeLessThanOrEqual(main!.x + 1);
    expect(main!.x + main!.width).toBeLessThanOrEqual(right!.x + 1);
    expect(right!.width).toBeLessThanOrEqual(360 + 1);
    expect(main!.width).toBeGreaterThanOrEqual(440 - 1);
  });

  test("加载、空、少量和长列表状态保持固定外层高度并仅在内部滚动", async ({ page }) => {
    await installHarness(page, { width: 1440, height: 900 });
    await openEntry(page, "/chat");

    const setSyntheticListState = async (state: "loading" | "empty" | "sparse" | "long"): Promise<void> => {
      await page.evaluate((nextState) => {
        const scroll = document.querySelector<HTMLElement>(".thread-list__scroll");
        if (!scroll) throw new Error("thread list scroll container is not mounted");
        scroll.replaceChildren();
        if (nextState === "loading") {
          const hint = document.createElement("div");
          hint.className = "thread-list__hint";
          hint.textContent = "加载中...";
          scroll.append(hint);
          return;
        }
        if (nextState === "empty") return;
        const count = nextState === "sparse" ? 1 : 100;
        for (let index = 0; index < count; index += 1) {
          const row = document.createElement("div");
          row.className = "thread-list__item";
          row.textContent = `${nextState === "sparse" ? "少量" : "长列表"}会话 ${index}`;
          scroll.append(row);
        }
      }, state);
    };

    await setSyntheticListState("loading");
    const loadingMetrics = await readSidebarLayoutMetrics(page);
    await setSyntheticListState("empty");
    const emptyMetrics = await readSidebarLayoutMetrics(page);
    await setSyntheticListState("sparse");
    const sparseMetrics = await readSidebarLayoutMetrics(page);
    await setSyntheticListState("long");
    const longMetrics = await readSidebarLayoutMetrics(page);

    for (const metrics of [emptyMetrics, sparseMetrics, longMetrics]) {
      expect(metrics.sidebarHeight).toBeCloseTo(loadingMetrics.sidebarHeight, 0);
      expect(metrics.scrollportHeight).toBeCloseTo(loadingMetrics.scrollportHeight, 0);
      expect(metrics.overflowY).toBe("auto");
    }
    expect(loadingMetrics.scrollportHeight).toBeCloseTo(loadingMetrics.sidebarHeight, 0);
    expect(emptyMetrics.scrollHeight).toBeLessThanOrEqual(emptyMetrics.scrollClientHeight + 1);
    expect(sparseMetrics.scrollHeight).toBeLessThanOrEqual(sparseMetrics.scrollClientHeight + 1);
    expect(longMetrics.scrollHeight).toBeGreaterThan(longMetrics.scrollClientHeight);
  });
});
