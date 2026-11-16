import { expect, test, type Page, type Route } from "@playwright/test";

const WORKSPACE_ID = "workspace_builtin_first_order_e2e";
const GROUP_ID = "asset-group-builtin-first-e2e";
const GROUP_NAME = "排序验证分组";

/** 显式声明桌面端视口，避免不同 runner 默认值影响侧边栏可见性。 */
const VIEWPORT = { width: 1440, height: 960 };

type WorkflowFixture = { id: string; name: string; kind: "builtin" | "custom" };

/**
 * 数据源顺序刻意与名称顺序不同：自定义 C → 内置 B → 自定义 A → 内置 A → 自定义 B。
 * 这样「稳定分区」的结果无法由名称排序推出，可同时证明 acceptance-1（内置在前）
 * 与 acceptance-2（两段内部都保持数据源相对顺序）。
 */
const WORKFLOWS: WorkflowFixture[] = [
  { id: "wf-custom-c", name: "自定义流程 C", kind: "custom" },
  { id: "wf-builtin-b", name: "内置流程 B", kind: "builtin" },
  { id: "wf-custom-a", name: "自定义流程 A", kind: "custom" },
  { id: "wf-builtin-a", name: "内置流程 A", kind: "builtin" },
  { id: "wf-custom-b", name: "自定义流程 B", kind: "custom" },
];

/** 内置段与自定义段各保持数据源相对顺序，且不因名称升序而互相换位。 */
const EXPECTED_SIDEBAR_ORDER = ["内置流程 B", "内置流程 A", "自定义流程 C", "自定义流程 A", "自定义流程 B"];

/** 分组筛选：把数据源首位的自定义 C 与内置段的末位 内置 A 放进同一分组，用于验证筛选后排序仍生效。 */
const GROUP_ASSIGNMENTS: Record<string, string> = {
  "wf-builtin-a": GROUP_ID,
  "wf-custom-c": GROUP_ID,
};

const EXPECTED_GROUP_FILTERED_ORDER = ["内置流程 A", "自定义流程 C"];

/** 默认选中由 Store 首项决定（orchestration-layout 的 orch.workflows[0]），排序不得改变它。 */
const EXPECTED_DEFAULT_SELECTED_NAME = "自定义流程 C";

/** 数据源（Store）顺序：导出请求载荷必须沿用它，不能被展示层的排序改写。 */
const DATA_SOURCE_IDS = WORKFLOWS.map((workflow) => workflow.id);

/** 展示顺序对应的 id 序列：与载荷顺序不同，用于说明「显示顺序」与「载荷顺序」已解耦。 */
const DISPLAY_ORDER_IDS = ["wf-builtin-b", "wf-builtin-a", "wf-custom-c", "wf-custom-a", "wf-custom-b"];

function sendJson(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** 注入超管登录态：超管可导出内置流程，导出弹窗对全部流程开放。 */
async function installSession(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(({ workspaceId }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290",
      authMode: "account",
      accountRole: "super_admin",
      sessionToken: "builtin-first-order-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      workspaceId,
      homePath: "/orchestration/workspace",
      userSummary: {
        userId: "builtin-first-order-e2e-user",
        email: "builtin-first-order-e2e@test.local",
        fullName: "排序 E2E 用户",
        phone: "",
        avatarUrl: null,
        accountRole: "super_admin",
        status: "active",
      },
      accessContext: {
        identityType: "SUPER_ADMIN",
        editionType: "COMMUNITY",
        editionStatus: "ACTIVE",
        effectiveAccessScope: "SUPER_ADMIN",
      },
    }));
  }, { workspaceId: WORKSPACE_ID });
}

/** 打桩资产库所需的编排端点，流程列表固定为内置/自定义交错的数据源。 */
async function mockAssetsApi(page: Page): Promise<void> {
  // 兜底路由必须先注册：Playwright 先匹配最近注册的处理器，后注册的具体路由才能覆盖它。
  // 只兜底 API 请求，避免把 Vite 提供的源码模块也当成 JSON 响应。
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    await sendJson(route, {
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
    });
  });

  await page.route("**/api/workspaces*", async (route) => {
    await sendJson(route, {
      ok: true,
      workspaces: [{
        id: WORKSPACE_ID,
        title: "内置优先排序 E2E 工作区",
        path: "D:/builtin-first-order-workspace",
        ownerClientId: "builtin-first-order-e2e-client",
        createdAt: 1,
        updatedAt: 1,
        kind: "local",
        entryStatus: "available",
      }],
      resolvedCurrentWorkspaceId: WORKSPACE_ID,
      workspaceListAuthoritative: true,
      activeClientCount: 1,
      workspaceListSuccessCount: 1,
      workspaceListFailureCount: 0,
    });
  });
  await page.route("**/api/account/me/ws-bridge", async (route) => {
    await sendJson(route, { ok: true, bridgeToken: "builtin-first-order-bridge-token" });
  });
  await page.route("**/api/account/me/summary", async (route) => {
    await sendJson(route, {
      ok: true,
      userId: "builtin-first-order-e2e-user",
      email: "builtin-first-order-e2e@test.local",
      fullName: "排序 E2E 用户",
      phone: "",
      avatarUrl: null,
      accountRole: "super_admin",
      accessContext: {
        identityType: "SUPER_ADMIN",
        editionType: "COMMUNITY",
        editionStatus: "ACTIVE",
        effectiveAccessScope: "SUPER_ADMIN",
      },
      packageSummary: null,
      enterpriseSummary: null,
      enterpriseMemberPackageSummary: null,
      pendingEnterpriseInvitations: [],
      keySummary: null,
      securitySummary: null,
      inviteCode: "",
    });
  });
  await page.route("**/api/orch/workflows*", async (route) => {
    if (route.request().method() === "POST") {
      await sendJson(route, { ok: true });
      return;
    }
    await sendJson(route, {
      ok: true,
      workflows: WORKFLOWS.map((workflow) => ({
        id: workflow.id,
        workspaceId: WORKSPACE_ID,
        name: workflow.name,
        description: "",
        family: null,
        kind: workflow.kind,
        version: 1,
        workflowKnowledgeBundleIds: [],
        nodes: [
          { id: "start", type: "start", label: "START", position: { x: 0, y: 0 } },
          { id: "node-1", type: "role", label: "执行", position: { x: 0, y: 120 }, roleId: "role-e2e", knowledgeOverrideBundleIds: [] },
          { id: "end", type: "end", label: "END", position: { x: 0, y: 240 } },
        ],
        edges: [],
      })),
      assetMetadata: WORKFLOWS.map((workflow) => ({
        assetType: "workflow",
        assetId: workflow.id,
        revision: 1,
        scopeType: workflow.kind === "builtin" ? "builtin" : "user",
        contentHash: "b".repeat(64),
      })),
    });
  });
  await page.route("**/api/orch/roles*", async (route) => sendJson(route, { ok: true, roles: [], assetMetadata: [] }));
  await page.route("**/api/orch/knowledge-bundles*", async (route) => sendJson(route, { ok: true, bundles: [], assetMetadata: [] }));
  await page.route("**/api/orch/skills*", async (route) => sendJson(route, { ok: true, skills: [], assetMetadata: [] }));
  await page.route("**/api/orch/asset-groups*", async (route) => {
    await sendJson(route, {
      ok: true,
      groups: [{
        id: GROUP_ID,
        workspaceId: WORKSPACE_ID,
        assetType: "workflow",
        name: GROUP_NAME,
        builtin: false,
        createdAt: 1,
        updatedAt: 1,
      }],
      assignments: GROUP_ASSIGNMENTS,
    });
  });
  await page.route("**/api/orch/toolsets*", async (route) => sendJson(route, { ok: true, toolsets: [], assetMetadata: [] }));
}

/** 打桩 Web 会话与在线 Client 状态：资产页只在当前工作区 Client 在线时才拉取列表。 */
async function mockWebSession(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws\/web(?:\?|$)/u, (ws) => {
    ws.onMessage(() => undefined);
    setTimeout(() => {
      ws.send(JSON.stringify({
        t: "web.helloAck",
        webSessionId: "builtin-first-order-web-session",
        serverNow: Date.now(),
        authMode: "account",
        accountRole: "super_admin",
        homePath: "/orchestration/workspace",
        userSummary: { userId: "builtin-first-order-e2e-user", email: "builtin-first-order-e2e@test.local", fullName: "排序 E2E 用户", accountRole: "super_admin", status: "active" },
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
              clientId: "builtin-first-order-e2e-client",
              name: "排序 E2E Client",
              version: "2026.08.21.01",
              connectedAt: Date.now(),
              workspaceIds: [WORKSPACE_ID],
            }],
          },
        },
      }));
    }, 0);
  });
}

/** 进入资产库的工作流页签并等待左侧流程列表就绪。 */
async function openWorkflowAssets(page: Page): Promise<void> {
  await mockAssetsApi(page);
  await mockWebSession(page);
  await installSession(page);
  await page.goto("/orchestration/assets");
  await page.getByRole("tab", { name: "WF", exact: true }).click();
  await expect(page.locator(".wf-sidebar__item").first()).toBeVisible({ timeout: 15_000 });
}

/** 按 DOM 顺序读取左侧流程列表的名称。 */
async function sidebarWorkflowNames(page: Page): Promise<string[]> {
  const names = await page.locator(".wf-sidebar__item .wf-sidebar__item-name-text").allTextContents();
  return names.map((name) => name.trim());
}

/** 按 DOM 顺序读取导出弹窗清单的流程名（strong 的首个文本节点，忽略「内置」标签）。 */
async function exportBundleWorkflowNames(page: Page): Promise<string[]> {
  return page.locator(".wf-sidebar__bundle-item strong").evaluateAll((elements) =>
    elements.map((element) => (element.childNodes[0]?.textContent ?? "").trim()),
  );
}

test.describe("工作流列表内置流程排最前", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
  });

  test("ORDER-01 内置流程排在列表最前，且两段内部保持数据源相对顺序", async ({ page }, testInfo) => {
    await openWorkflowAssets(page);

    await expect.poll(() => sidebarWorkflowNames(page)).toEqual(EXPECTED_SIDEBAR_ORDER);
    // 内置段连续占据列表最前，不与自定义条目交错。
    await expect(page.locator(".wf-sidebar__item").first().locator(".wf-sidebar__item-name-text")).toHaveText("内置流程 B");
    await expect(page.locator(".wf-sidebar__item").first().locator(".wf-sidebar__item-kind")).toHaveText("内置");

    // 留存真实页面视觉证据，供下游与线框图做顺序一致性抽检。
    await testInfo.attach("wf-sidebar-builtin-first", {
      body: await page.locator(".wf-sidebar").screenshot(),
      contentType: "image/png",
    });
  });

  test("ORDER-02 关键词搜索后命中结果内部仍内置在前", async ({ page }) => {
    await openWorkflowAssets(page);

    const searchInput = page.locator(".wf-sidebar__search-input");
    await searchInput.fill("B");

    // 数据源里 自定义流程 B 在内置流程 B 之前，搜索命中两个后仍必须是内置在前。
    await expect.poll(() => sidebarWorkflowNames(page)).toEqual(["内置流程 B", "自定义流程 B"]);

    await searchInput.fill("流程");
    await expect.poll(() => sidebarWorkflowNames(page)).toEqual(EXPECTED_SIDEBAR_ORDER);

    await searchInput.fill("不存在的关键词");
    await expect(page.locator(".wf-sidebar__item")).toHaveCount(0);
    await expect(page.locator(".wf-sidebar__empty")).toBeVisible();

    await searchInput.fill("");
    await expect.poll(() => sidebarWorkflowNames(page)).toEqual(EXPECTED_SIDEBAR_ORDER);
  });

  test("ORDER-03 分组筛选后命中结果内部仍内置在前", async ({ page }) => {
    await openWorkflowAssets(page);

    await page.locator(".asset-group-bar .ant-select-selector").first().click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: GROUP_NAME }).click();

    await expect.poll(() => sidebarWorkflowNames(page)).toEqual(EXPECTED_GROUP_FILTERED_ORDER);

    // 切回全部分组后恢复完整顺序。
    await page.locator(".asset-group-bar .ant-select-selector").first().click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "全部分组" }).click();
    await expect.poll(() => sidebarWorkflowNames(page)).toEqual(EXPECTED_SIDEBAR_ORDER);
  });

  test("ORDER-04 导出弹窗清单与左侧列表顺序一致（内置在前）", async ({ page }) => {
    await openWorkflowAssets(page);

    await page.locator('button[aria-label="导出流程资产"]').click();
    const modal = page.locator(".orch-asset-bundle-modal");
    await expect(modal).toBeVisible();

    await expect.poll(() => exportBundleWorkflowNames(page)).toEqual(EXPECTED_SIDEBAR_ORDER);
    // 当前选中的流程（数据源首项 自定义流程 C）默认已勾选，勾选态与排序无关。
    await expect(modal.getByText("已选 1 / 5")).toBeVisible();

    // 显示顺序变化不得改变选择载荷顺序：全选后选中集合覆盖全部流程。
    await modal.getByRole("button", { name: "全选" }).click();
    await expect(modal.getByText("已选 5 / 5")).toBeVisible();
  });

  test("ORDER-05 排序不改变默认选中项（仍为数据源首项）", async ({ page }) => {
    await openWorkflowAssets(page);

    // 数据源首项是自定义流程 C；排序后首位变成内置流程 B，但默认选中必须仍是数据源首项。
    await expect(page.locator(".wf-sidebar__item--selected .wf-sidebar__item-name-text")).toHaveText(EXPECTED_DEFAULT_SELECTED_NAME);
    await expect(page.locator(".wf-sidebar__item--selected .wf-sidebar__item-kind")).toHaveText("自定义");
  });

  test("ORDER-06 导出请求载荷仍按数据源顺序组装，不受展示层排序影响", async ({ page }) => {
    await openWorkflowAssets(page);

    // 兜底路由在 openWorkflowAssets 里先注册；此处后注册才能覆盖 /api/orch/asset-bundles/export。
    const exportBodies: Array<Record<string, unknown>> = [];
    await page.route("**/api/orch/asset-bundles/export*", async (route) => {
      exportBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await sendJson(route, { ok: true, bundle: { title: "workflow-bundle", warnings: [] } });
    });

    await page.locator('button[aria-label="导出流程资产"]').click();
    const modal = page.locator(".orch-asset-bundle-modal");
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "全选" }).click();
    await expect(modal.getByText("已选 5 / 5")).toBeVisible();
    await modal.getByRole("button", { name: "开始导出" }).click();

    await expect.poll(() => exportBodies.length).toBe(1);
    // 显示顺序是内置在前，载荷顺序仍是数据源顺序：两者解耦，导出包内容顺序不变。
    expect(exportBodies[0]?.workflowIds).toEqual(DATA_SOURCE_IDS);
    expect(exportBodies[0]?.workflowIds).not.toEqual(DISPLAY_ORDER_IDS);
  });
});
