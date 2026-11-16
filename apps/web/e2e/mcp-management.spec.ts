import { expect, test, type Page, type Route } from "@playwright/test";

const WORKSPACE_ID = "workspace_chat_core_e2e";

type McpUiState = {
  servers: Array<Record<string, unknown>>;
  suitesRequestCount: number;
  installed: Set<string>;
  configuredClaude: Set<string>;
  configuredCodex: Set<string>;
  configuredInProject: Set<string>;
  credentialConfigured: Set<string>;
  updateAvailable: Set<string>;
  lastMutation: Record<string, unknown> | null;
  imported: boolean;
  catalogOnly: boolean;
  failure: {
    operation: "enable" | "update" | "test";
    mcpId: string;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  } | null;
};

type MockMcpOptions = {
  shared?: boolean;
  sharedCanMaintain?: boolean;
  catalogOnly?: boolean;
  suitesFailure?: { status: number; message: string };
  installed?: string[];
  configuredCodex?: string[];
  configuredInProject?: string[];
  importDocker?: boolean;
};

const BUILTIN_SERVERS = [
  {
    mcpId: "builtin.playwright",
    npmPackage: "@playwright/mcp",
    serverName: "playwright",
    name: "Playwright",
    description: "浏览器自动化与端到端测试",
    homepage: "https://github.com/microsoft/playwright-mcp",
    source: "builtin",
    installType: "npm",
    transportType: "stdio",
    recommended: true,
    featuredRecommended: true,
    recommendedRank: 1,
    categories: ["浏览器自动化"],
    prerequisites: ["当前 Client 可运行 Node.js 和 npm"],
    securityLevel: "medium",
  },
  {
    mcpId: "builtin.github",
    npmPackage: "@modelcontextprotocol/server-github",
    serverName: "github",
    name: "GitHub",
    description: "访问仓库、Issue 和 Pull Request",
    homepage: "https://github.com/modelcontextprotocol/servers",
    source: "builtin",
    installType: "npm",
    transportType: "stdio",
    recommended: true,
    featuredRecommended: true,
    recommendedRank: 3,
    categories: ["代码协作"],
    prerequisites: ["当前 Client 可运行 Node.js 和 npm", "需要配置 GitHub Token"],
    securityLevel: "medium",
  },
  {
    mcpId: "builtin.internal-docs",
    npmPackage: null,
    serverName: "internal-docs",
    name: "内部文档",
    description: "通过远程地址查询团队文档",
    homepage: null,
    source: "builtin",
    installType: "http",
    transportType: "streamable-http",
    recommended: false,
    featuredRecommended: false,
    recommendedRank: null,
    categories: ["文档"],
    prerequisites: ["需要可访问远程 MCP 地址"],
    securityLevel: "low",
    url: "https://example.test/mcp",
  },
];

function createState(options: MockMcpOptions = {}): McpUiState {
  return {
    servers: [...BUILTIN_SERVERS],
    suitesRequestCount: 0,
    installed: new Set(options.installed ?? []),
    configuredClaude: new Set(),
    configuredCodex: new Set(options.configuredCodex ?? []),
    configuredInProject: new Set(options.configuredInProject ?? []),
    credentialConfigured: new Set(),
    updateAvailable: new Set(),
    lastMutation: null,
    imported: false,
    catalogOnly: Boolean(options.catalogOnly),
    failure: null,
  };
}

function makeStatus(server: Record<string, unknown>, state: McpUiState): Record<string, unknown> {
  const mcpId = String(server.mcpId);
  const remote = server.installType === "http" || server.installType === "sse";
  const configured = state.configuredClaude.has(mcpId) || state.configuredCodex.has(mcpId) || state.configuredInProject.has(mcpId);
  return {
    mcpId,
    instanceId: `${mcpId}::workspace:${WORKSPACE_ID}`,
    npmPackage: server.npmPackage ?? null,
    installed: remote ? false : state.installed.has(mcpId),
    currentVersion: state.installed.has(mcpId) && !remote ? "1.0.0" : null,
    latestVersion: state.updateAvailable.has(mcpId) ? "1.1.0" : null,
    updateAvailable: state.updateAvailable.has(mcpId),
    configuredInClaude: state.configuredClaude.has(mcpId),
    configuredInCodex: state.configuredCodex.has(mcpId),
    configuredInProject: state.configuredInProject.has(mcpId),
    installType: server.installType,
    transportType: server.transportType,
    installationStatus: remote ? "not-required" : configured ? "installed" : "not-installed",
    credentialConfigured: state.credentialConfigured.has(mcpId),
    error: null,
  };
}

function sendJson(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installSession(page: Page, shared = false): Promise<void> {
  await page.goto("/");
  await page.evaluate(({ sharedWorkspace }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290",
      authMode: "account",
      accountRole: "enterprise_admin",
      sessionToken: "mcp-management-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      workspaceId: "workspace_chat_core_e2e",
      homePath: "/orchestration/workspace",
      userSummary: {
        userId: "mcp-management-e2e-user",
        email: "mcp-management-e2e@test.local",
        fullName: "MCP E2E 用户",
        phone: "",
        avatarUrl: null,
        accountRole: "enterprise_admin",
        status: "active",
        enterpriseId: "enterprise_chat_core_e2e",
        enterpriseName: "E2E 企业",
      },
      accessContext: {
        identityType: "ENTERPRISE_ADMIN",
        editionType: "ENTERPRISE",
        editionStatus: "ACTIVE",
        effectiveAccessScope: "ENTERPRISE_ACTIVE",
        enterpriseId: "enterprise_chat_core_e2e",
        enterpriseName: "E2E 企业",
      },
      e2eSharedWorkspace: sharedWorkspace,
    }));
  }, { sharedWorkspace: shared });
}

async function mockMcpApi(page: Page, options: MockMcpOptions = {}): Promise<McpUiState> {
  const state = createState(options);
  const shared = Boolean(options.shared);
  await page.route("**/api/workspaces*", async (route) => {
    if (!shared) return route.fallback();
    await sendJson(route, {
      ok: true,
      workspaces: [{
        id: WORKSPACE_ID,
        title: "共享 E2E 工作区",
        path: "D:/e2e-shared-workspace",
        createdAt: 1,
        updatedAt: 1,
        kind: "shared",
         capabilities: { canMaintainAssets: Boolean(options.sharedCanMaintain), effectiveAssetRole: options.sharedCanMaintain ? "admin" : "member" },
      }],
      resolvedCurrentWorkspaceId: WORKSPACE_ID,
      workspaceListAuthoritative: true,
    });
  });
  await page.route("**/api/account/me/summary", async (route) => {
    await sendJson(route, {
      ok: true,
      userId: "mcp-management-e2e-user",
      email: "mcp-management-e2e@test.local",
      fullName: "MCP E2E 用户",
      phone: "",
      avatarUrl: null,
      accountRole: "enterprise_admin",
      accessContext: {
        identityType: "ENTERPRISE_ADMIN",
        editionType: "ENTERPRISE",
        editionStatus: "ACTIVE",
        effectiveAccessScope: "ENTERPRISE_ACTIVE",
        enterpriseId: "enterprise_chat_core_e2e",
        enterpriseName: "E2E 企业",
      },
      enterpriseSummary: { enterpriseId: "enterprise_chat_core_e2e", name: "E2E 企业" },
      enterpriseMemberPackageSummary: null,
      pendingEnterpriseInvitations: [],
      packageSummary: null,
      keySummary: null,
      securitySummary: null,
      inviteCode: "",
    });
  });
  await page.route("**/api/skills/suites*", async (route) => {
    if (options.suitesFailure) {
      await sendJson(route, { ok: false, message: options.suitesFailure.message }, options.suitesFailure.status);
      return;
    }
    if (new URL(route.request().url()).searchParams.get("includeMcpStatus") === "true") state.suitesRequestCount += 1;
    const mcpStatus = Object.fromEntries(state.servers.map((server) => [String(server.mcpId), makeStatus(server, state)]));
    await sendJson(route, { ok: true, suites: [], targetStatus: {}, mcpServers: state.servers, mcpStatus: state.catalogOnly ? {} : mcpStatus, catalogOnly: state.catalogOnly });
  });
  await page.route("**/api/orch/knowledge-bundles*", async (route) => {
    await sendJson(route, { ok: true, bundles: [], assetMetadata: [] });
  });
  await page.route("**/api/orch/asset-groups*", async (route) => {
    await sendJson(route, { ok: true, groups: [], assignments: {} });
  });
  await page.route("**/api/mcp/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const body = method === "POST" ? route.request().postDataJSON() as Record<string, unknown> : {};
    state.lastMutation = body;
    const mcpId = String(body.mcpId ?? "");
    let server = state.servers.find((item) => item.mcpId === mcpId) ?? null;

    if (url.pathname.endsWith("/import")) {
      const importedServer = {
        ...BUILTIN_SERVERS[2],
        mcpId: "imported.vscode.internal-docs",
        name: "VS Code 内部文档",
        source: "imported",
        installType: "http",
        url: "https://example.test/imported-mcp",
      };
      if (!state.imported) state.servers.push(importedServer);
      state.imported = true;
      const errors = [{ source: "cursor", path: "~/.cursor/mcp.json", message: "文件不存在" }];
      if (options.importDocker) errors.push({ source: "vscode", path: "~/.vscode/mcp.json", message: "MCP 使用 Docker，当前版本不支持导入" });
      await sendJson(route, { ok: true, items: [importedServer], errors });
      return;
    }
    if (url.pathname.endsWith("/test")) {
      if (state.failure?.operation === "test" && state.failure.mcpId === mcpId) {
        await sendJson(route, { ok: false, code: state.failure.code, message: state.failure.message }, 502);
        return;
      }
      await sendJson(route, { ok: true, mcpId, instanceId: `${mcpId}::workspace:${WORKSPACE_ID}`, engine: body.engine ?? "codex", errorCode: null, message: "MCP 配置检测通过" });
      return;
    }
    if (url.pathname.endsWith("/configure")) {
      if (body.engine === "claude") state.configuredClaude.add(mcpId);
      else state.configuredCodex.add(mcpId);
      await sendJson(route, { ok: true, mcpId, engine: body.engine ?? "codex", error: null });
      return;
    }
    if (url.pathname.endsWith("/unconfigure")) {
      if (body.engine === "claude") state.configuredClaude.delete(mcpId);
      else state.configuredCodex.delete(mcpId);
      await sendJson(route, { ok: true, mcpId, engine: body.engine ?? "codex", error: null });
      return;
    }
    if (url.pathname.endsWith("/enable") || url.pathname.endsWith("/update")) {
      const operation = url.pathname.endsWith("/update") ? "update" : "enable";
      if (state.failure?.operation === operation && state.failure.mcpId === mcpId) {
        await sendJson(route, {
          ok: false,
          code: state.failure.code,
          message: state.failure.message,
          ...(state.failure.details ? { details: state.failure.details } : {}),
        }, 502);
        return;
      }
      if (!server && !mcpId && body.serverName) {
        const customMcpId = `custom.${String(body.serverName).trim()}`;
        server = {
          mcpId: customMcpId,
          npmPackage: body.npmPackage ?? null,
          serverName: body.serverName,
          name: body.name ?? body.serverName,
          description: body.description ?? "自定义 MCP",
          homepage: body.homepage ?? null,
          source: "custom",
          installType: body.installType ?? "npm",
          transportType: body.transportType ?? "stdio",
          recommended: false,
          featuredRecommended: false,
          recommendedRank: null,
          categories: [],
          prerequisites: [],
          securityLevel: "medium",
        };
        state.servers.push(server);
      }
      if (!server) {
        await sendJson(route, { ok: false, code: "MCP_NOT_FOUND", message: "MCP 不存在" }, 404);
        return;
      }
      const effectiveMcpId = String(server.mcpId);
      if (server.installType !== "http" && server.installType !== "sse") state.installed.add(effectiveMcpId);
      state.configuredCodex.add(effectiveMcpId);
      if (Array.isArray(body.credentialInputs) && body.credentialInputs.length) state.credentialConfigured.add(mcpId);
      const isUpdate = operation === "update";
      state.updateAvailable.delete(effectiveMcpId);
      if (!isUpdate) state.updateAvailable.add(effectiveMcpId);
      await sendJson(route, {
        ok: true,
        operationId: `mcp-op-${Date.now()}`,
        mcpId: effectiveMcpId,
        instanceId: `${effectiveMcpId}::workspace:${WORKSPACE_ID}`,
        npmPackage: server.npmPackage ?? null,
        engine: body.engine ?? "codex",
        stage: null,
        stages: [
          { name: "resolve_target", status: "succeeded", message: "目标 Client 已确认" },
          { name: "prepare_install_or_remote_config", status: "succeeded", message: "本地依赖已准备完成" },
          { name: "configure_engine", status: "succeeded", message: "引擎配置已写入" },
          { name: "test_connection", status: "succeeded", message: "配置检测通过" },
        ],
        installedVersion: server.installType === "npm" ? "1.0.0" : null,
        enabled: true,
        errorCode: null,
        message: isUpdate ? "MCP 已更新并启用" : "MCP 已启用",
        credentialConfigured: state.credentialConfigured.has(effectiveMcpId),
      });
      return;
    }
    if (url.pathname.endsWith("/uninstall")) {
      state.installed.delete(mcpId);
      if (server) state.servers = state.servers.filter((item) => item.mcpId !== mcpId);
      await sendJson(route, { ok: true, npmPackage: server?.npmPackage ?? body.npmPackage ?? null, error: null });
      return;
    }
    await sendJson(route, { ok: true, mcpId, success: true, error: null });
  });
  return state;
}

async function openMcpPanel(page: Page, options: MockMcpOptions = {}): Promise<{
  panel: ReturnType<Page["locator"]>;
  sidebar: ReturnType<Page["locator"]>;
  toolbar: ReturnType<Page["locator"]>;
  state: McpUiState;
}> {
  const state = await mockMcpApi(page, options);
  await installSession(page, Boolean(options.shared));
  await page.goto("/orchestration/workspace");
  await page.getByRole("button", { name: "资产库" }).click();
  await page.getByRole("tab", { name: "MCP", exact: true }).click();
  const panel = page.locator(".mcp-panel:visible").last();
  const sidebar = page.locator("#orch-mcp-sidebar-host:visible .mcp-panel__sidebar").last();
  const toolbar = page.locator("#orch-asset-toolbar-host:visible .mcp-panel__toolbar").last();
  await expect(panel).toBeVisible();
  await expect(sidebar).toBeVisible();
  await expect(toolbar).toBeVisible();
  if (!options.suitesFailure) await expect(sidebar.locator(".mcp-panel__list-item").first()).toBeVisible();
  return { panel, sidebar, toolbar, state };
}

/** 在自定义 MCP 表单中切换安装方式，并等待下拉选项完成选择。 */
async function chooseCustomInstallType(page: Page, dialog: ReturnType<Page["locator"]>, label: string): Promise<void> {
  await dialog.locator(".ant-select").first().click();
  await page.locator(".ant-select-dropdown:visible").last().getByText(label, { exact: true }).click();
}

test.describe("AI 资产 MCP 管理", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:39290/api/test/reset");
  });

  test("MCP-01 推荐、搜索、启用、阶段结果和更新检测", async ({ page }) => {
    const { panel, sidebar, toolbar, state } = await openMcpPanel(page);
    await expect(sidebar.getByText("Playwright", { exact: true }).first()).toBeVisible();

    const groupSelect = sidebar.locator(".mcp-panel__group-bar .ant-select");
    await groupSelect.click();
    const groupDropdown = page.locator(".ant-select-dropdown:visible").last();
    await expect(groupDropdown.getByText("推荐", { exact: true })).toBeVisible();
    await expect(groupDropdown.getByText("全部", { exact: true })).toBeVisible();
    await expect(groupDropdown.getByText("已安装", { exact: true })).toBeVisible();
    await groupDropdown.getByText("推荐", { exact: true }).click();
    await expect(sidebar.locator(".mcp-panel__list-item")).toHaveCount(2);
    await groupSelect.click();
    await page.locator(".ant-select-dropdown:visible").last().getByText("全部", { exact: true }).click();

    const search = toolbar.locator("input[placeholder='搜索 MCP 工具...']").first();
    await search.fill("GitHub", { force: true });
    await expect(sidebar.locator(".mcp-panel__list-item")).toHaveCount(1);
    await expect(sidebar.locator(".mcp-panel__list-item").first()).toContainText("GitHub");
    await search.fill("", { force: true });
    await sidebar.locator(".mcp-panel__list-item").filter({ hasText: "Playwright" }).click();
    const primaryAction = panel.locator(".mcp-panel__actions .mcp-panel__action-row").first().locator("button");
    await primaryAction.click();
    await expect(page.getByText("Playwright 已启用并接入 Codex", { exact: true })).toBeVisible();
    await expect(panel.getByText("已接入 Codex，可直接使用。", { exact: true })).toBeVisible();
    expect(state.lastMutation?.engine).toBe("codex");

    await expect(primaryAction).toContainText("更新并检测");
    await primaryAction.click();
    await expect(page.getByText("Playwright 已更新并完成配置检测", { exact: true })).toBeVisible();
    expect(state.lastMutation?.version).toBe("1.1.0");
    await expect(primaryAction).toContainText("检测连接");
    await primaryAction.click();
    await expect(page.getByText("Playwright 配置检测通过", { exact: true })).toBeVisible();
  });

  test("MCP-02 凭据补录和导入显示部分结果", async ({ page }) => {
    const { panel, sidebar, toolbar, state } = await openMcpPanel(page);
    await sidebar.locator(".mcp-panel__list-item").filter({ hasText: "内部文档" }).click();
    await panel.locator(".mcp-panel__action-buttons button").first().click();
    const dialog = page.locator(".ant-modal").filter({ hasText: "配置 MCP 凭据" });
    await expect(dialog).toBeVisible();
    const inputs = dialog.locator("input.ant-input");
    await inputs.nth(0).fill("X-API-Key");
    await inputs.nth(1).click();
    await inputs.nth(1).fill("e2e-secret-value");
    await dialog.locator("button").filter({ hasText: /添/ }).first().click();
    await dialog.getByRole("button", { name: "保存并检测", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(state.lastMutation?.credentialInputs).toEqual([{ name: "X-API-Key", value: "e2e-secret-value", kind: "header" }]);

    await toolbar.locator("button").nth(0).click();
    await expect(page.getByText("已导入 1 项，1 个来源或条目未导入", { exact: true })).toBeVisible();
    expect(state.imported).toBe(true);
  });

  test("MCP-03 共享工作区成员只能查看，不能执行维护操作", async ({ page }) => {
    const { panel, sidebar, toolbar } = await openMcpPanel(page, { shared: true });
    await sidebar.locator(".mcp-panel__list-item").filter({ hasText: "Playwright" }).click();
    await expect(panel.getByText("共享工作区成员不可维护 Skills / MCP", { exact: true })).toBeVisible();
    await expect(toolbar.locator("button").nth(0)).toBeDisabled();
    await expect(toolbar.locator("button").nth(1)).toBeDisabled();
    await expect(panel.locator(".mcp-panel__actions .mcp-panel__action-row").first().locator("button")).toBeDisabled();
    await expect(panel.locator(".mcp-panel__action-buttons button").first()).toBeDisabled();
  });

  test("MCP-04 桌面和平板保持通用资产布局，移动端进入既有移动工作台", async ({ page }) => {
    const { panel } = await openMcpPanel(page);
    for (const viewport of [{ width: 1366, height: 900 }, { width: 768, height: 900 }]) {
      await page.setViewportSize(viewport);
      const visiblePanel = page.locator(".mcp-panel:visible").last();
      await expect(visiblePanel).toBeVisible();
      await expect(page.locator(".orch-layout__asset-shell:visible").last()).toBeVisible();
      const layout = await visiblePanel.evaluate((element) => {
        return {
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
      const shellLayout = await page.locator(".orch-layout__asset-shell:visible").last().evaluate((element) => {
        const shell = element.getBoundingClientRect();
        const sidebar = element.querySelector<HTMLElement>(".orch-layout__sidebar--assets")?.getBoundingClientRect();
        const content = element.querySelector<HTMLElement>(".orch-layout__content--asset")?.getBoundingClientRect();
        const segmented = element.querySelector<HTMLElement>(".orch-layout__asset-segmented")?.getBoundingClientRect();
        return {
          shellWidth: shell.width,
          shellHeight: shell.height,
          sidebarHeight: sidebar?.height ?? 0,
          sidebarWidth: sidebar?.width ?? 0,
          contentWidth: content?.width ?? 0,
          contentHeight: content?.height ?? 0,
          segmentedWidth: segmented?.width ?? 0,
          sidebarRight: sidebar?.right ?? 0,
          contentLeft: content?.left ?? 0,
          sidebarBottom: sidebar?.bottom ?? 0,
          contentTop: content?.top ?? 0,
        };
      });
      expect(shellLayout.sidebarWidth).toBeGreaterThan(0);
      expect(shellLayout.sidebarWidth).toBeLessThanOrEqual(shellLayout.shellWidth + 1);
      expect(shellLayout.segmentedWidth).toBeLessThanOrEqual(shellLayout.sidebarWidth + 1);
      expect(shellLayout.contentWidth).toBeGreaterThan(0);
      expect(shellLayout.contentHeight).toBeGreaterThan(0);
      const toolbarBox = await page.locator("#orch-asset-toolbar-host .mcp-panel__toolbar").last().boundingBox();
      const segmentedBox = await page.locator(".orch-layout__asset-segmented").last().boundingBox();
      const groupBarBox = await page.locator("#orch-mcp-sidebar-host .mcp-panel__group-bar").last().boundingBox();
      expect(toolbarBox).not.toBeNull();
      expect(segmentedBox).not.toBeNull();
      expect(groupBarBox).not.toBeNull();
      if (!toolbarBox || !segmentedBox || !groupBarBox) throw new Error("MCP 通用资产布局元素未找到");
      expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(segmentedBox.y + 1);
      expect(segmentedBox.y + segmentedBox.height).toBeLessThanOrEqual(groupBarBox.y + 1);
      expect(
        shellLayout.contentLeft >= shellLayout.sidebarRight - 1
        || shellLayout.contentTop >= shellLayout.sidebarBottom - 1,
      ).toBeTruthy();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".h5-workbench-home:visible")).toBeVisible();
    await expect(page.locator(".mcp-panel")).toHaveCount(0);
  });

  test("MCP-14 切换 Tab 优先使用缓存，手动刷新强制请求最新状态", async ({ page }) => {
    const { toolbar, state } = await openMcpPanel(page);
    expect(state.suitesRequestCount).toBe(1);

    await page.getByRole("tab", { name: "Tool", exact: true }).click();
    expect(state.suitesRequestCount).toBe(1);
    const requestCountBeforeReopen = state.suitesRequestCount;
    await page.getByRole("tab", { name: "MCP", exact: true }).click();
    await page.waitForTimeout(50);
    expect(await page.locator(".mcp-panel__loading:visible").count()).toBe(0);
    await expect(page.locator("#orch-mcp-sidebar-host:visible .mcp-panel__list-item").first()).toBeVisible();
    expect(state.suitesRequestCount).toBeLessThanOrEqual(requestCountBeforeReopen + 1);

    const requestCountBeforeManualRefresh = state.suitesRequestCount;
    await toolbar.getByRole("button", { name: "刷新 MCP 状态" }).click();
    await expect.poll(() => state.suitesRequestCount).toBe(requestCountBeforeManualRefresh + 1);
  });

  test("MCP-05 自定义 MCP 启用、引擎切换和卸载", async ({ page }) => {
    const { panel, sidebar, toolbar, state } = await openMcpPanel(page);
    await toolbar.locator("button").nth(1).click();
    const dialog = page.locator(".ant-modal").filter({ hasText: "添加自定义 MCP" });
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder("例如：team-docs-mcp").fill("team-local");
    await dialog.locator(".ant-modal-footer button").last().click();
    await expect(dialog).toBeHidden();
    await expect(sidebar.getByText("team-local", { exact: true }).last()).toBeVisible();
    expect(state.lastMutation?.serverName).toBe("team-local");

    const claudeSwitch = panel.locator(".mcp-panel__action-row").nth(1).locator(".ant-switch");
    await claudeSwitch.click();
    await expect(panel.getByText("已接入 Claude，可直接使用。", { exact: true })).toBeVisible();
    await claudeSwitch.click();
    const removeDialog = page.locator(".ant-modal-confirm");
    await expect(removeDialog).toBeVisible();
    await removeDialog.locator(".ant-modal-confirm-btns button").last().click();
    await expect(panel.getByText("未接入 Claude。", { exact: true })).toBeVisible();

    // 卸载会自动移除 Claude/Codex 接入，无需手动关闭引擎开关
    const uninstallButton = panel.locator(".mcp-panel__action-buttons button").last();
    await expect(uninstallButton).toBeEnabled();
    await uninstallButton.click();
    const uninstallDialog = page.locator(".ant-modal-confirm");
    await expect(uninstallDialog).toBeVisible();
    await uninstallDialog.locator(".ant-modal-confirm-btns button").last().click();
    await expect(page.getByText("team-local 已从当前 Client 卸载", { exact: true })).toBeVisible();
    expect(state.installed.has("custom.team-local")).toBe(false);
    await expect(sidebar.getByText("team-local", { exact: true })).toHaveCount(0);
  });

  test("MCP-06 启用失败显示失败阶段，不误报为成功", async ({ page }) => {
    const { panel, sidebar, state } = await openMcpPanel(page);
    state.failure = {
      operation: "enable",
      mcpId: "builtin.playwright",
      code: "MCP_INSTALL_FAILED",
      message: "本地依赖准备失败",
      details: {
        mcpId: "builtin.playwright",
        instanceId: `builtin.playwright::workspace:${WORKSPACE_ID}`,
        engine: "codex",
        stage: "prepare_install_or_remote_config",
        stages: [
          { name: "resolve_target", status: "succeeded", message: "目标 Client 已确认" },
          { name: "prepare_install_or_remote_config", status: "failed", message: "本地依赖准备失败" },
        ],
      },
    };
    await sidebar.locator(".mcp-panel__list-item").filter({ hasText: "Playwright" }).click();
    await panel.locator(".mcp-panel__actions .mcp-panel__action-row").first().locator("button").click();
    await expect(page.getByText("本地依赖准备失败", { exact: true })).toBeVisible();
    await expect(panel.locator(".mcp-panel__actions .mcp-panel__action-row").first().locator("button")).toContainText(/启\s*用/);
  });

  test("MCP-07 无目标 Client 时只展示目录，所有维护操作禁用", async ({ page }) => {
    const { panel, sidebar, toolbar } = await openMcpPanel(page, { catalogOnly: true });
    await expect(panel.getByText("当前仅展示公共市场目录", { exact: true })).toBeVisible();
    await sidebar.locator(".mcp-panel__list-item").filter({ hasText: "Playwright" }).click();
    await expect(panel.locator(".mcp-panel__actions .mcp-panel__action-row").first().locator("button")).toBeDisabled();
    await expect(toolbar.locator("button").nth(0)).toBeDisabled();
    await expect(toolbar.locator("button").nth(1)).toBeDisabled();
    await expect(panel.locator(".mcp-panel__action-buttons button").first()).toBeDisabled();
  });

  test("MCP-08 Client 状态查询失败时显示失败态，不降级为公共目录", async ({ page }) => {
    const { panel } = await openMcpPanel(page, { suitesFailure: { status: 503, message: "当前 Client 状态查询失败" } });
    await expect(panel.locator(".mcp-panel__load-error")).toContainText("当前 Client 状态查询失败");
    await expect(panel.getByRole("button", { name: "重新加载", exact: true })).toBeVisible();
    await expect(panel.getByText("当前仅展示公共市场目录", { exact: true })).toHaveCount(0);
  });

  test("MCP-09 共享工作区管理员可以维护 MCP", async ({ page }) => {
    const { panel, sidebar, toolbar, state } = await openMcpPanel(page, { shared: true, sharedCanMaintain: true });
    await sidebar.locator(".mcp-panel__list-item").filter({ hasText: "Playwright" }).click();
    await expect(panel.getByText("共享工作区成员不可维护 Skills / MCP", { exact: true })).toHaveCount(0);
    await expect(toolbar.locator("button").nth(0)).toBeEnabled();
    await panel.locator(".mcp-panel__actions .mcp-panel__action-row").first().locator("button").click();
    await expect(page.getByText("Playwright 已启用并接入 Codex", { exact: true })).toBeVisible();
    expect(state.lastMutation?.workspaceId).toBe(WORKSPACE_ID);
  });

  test("MCP-10 自定义表单覆盖本地命令、HTTP、SSE、NPM 和 PyPI，且不提供 Docker", async ({ page }) => {
    const { panel, toolbar } = await openMcpPanel(page);
    await toolbar.locator("button").nth(1).click();
    const dialog = page.locator(".ant-modal").filter({ hasText: "添加自定义 MCP" });
    await expect(dialog).toBeVisible();
    await dialog.locator(".ant-select").first().click();
    const dropdown = page.locator(".ant-select-dropdown:visible").last();
    await expect(dropdown.getByText("Docker", { exact: false })).toHaveCount(0);
    await dropdown.getByText("NPM 包", { exact: true }).click();

    await chooseCustomInstallType(page, dialog, "本地命令（stdio）");
    await expect(dialog.getByPlaceholder("例如：team-docs-mcp")).toBeVisible();
    await chooseCustomInstallType(page, dialog, "远程 HTTP");
    await expect(dialog.getByPlaceholder("https://example.com/mcp")).toBeVisible();
    await chooseCustomInstallType(page, dialog, "远程 SSE");
    await expect(dialog.getByPlaceholder("https://example.com/mcp")).toBeVisible();
    await chooseCustomInstallType(page, dialog, "NPM 包");
    await expect(dialog.getByPlaceholder("@scope/package-name")).toBeVisible();
    await chooseCustomInstallType(page, dialog, "PyPI 包");
    await expect(dialog.getByPlaceholder("例如：mcp-server-fetch")).toBeVisible();
    await expect(dialog.getByPlaceholder("uvx 或 python")).toBeVisible();
    await dialog.locator(".ant-modal-footer button").last().click();
  });

  test("MCP-11 项目级配置只参与检测，不能误判为引擎接入并阻止卸载", async ({ page }) => {
    const { panel, sidebar } = await openMcpPanel(page, { installed: ["builtin.playwright"], configuredInProject: ["builtin.playwright"] });
    await sidebar.locator(".mcp-panel__list-item").filter({ hasText: "Playwright" }).click();
    await expect(panel.getByText("项目配置：已检测", { exact: true })).toBeVisible();
    await expect(panel.locator(".mcp-panel__actions .mcp-panel__action-row").first().locator("button")).toContainText("检测连接");
    const uninstallButton = panel.locator(".mcp-panel__action-buttons button").last();
    await expect(uninstallButton).toBeEnabled();
    await uninstallButton.click();
    await expect(page.getByText("请先移除项目配置", { exact: true })).toBeVisible();
    await expect(page.getByText(/Playwright 仍在项目 .mcp.json 中配置/)).toBeVisible();
  });

  test("MCP-12 连接检测失败显示失败结果和错误码", async ({ page }) => {
    const { panel, sidebar, state } = await openMcpPanel(page, { configuredCodex: ["builtin.playwright"] });
    state.failure = { operation: "test", mcpId: "builtin.playwright", code: "MCP_CONNECTION_TEST_FAILED", message: "配置检测失败" };
    await sidebar.locator(".mcp-panel__list-item").filter({ hasText: "Playwright" }).click();
    await panel.locator(".mcp-panel__actions .mcp-panel__action-row").first().locator("button").click();
    await expect(page.getByText("配置检测失败", { exact: true })).toBeVisible();
  });

  test("MCP-13 导入 Docker 条目时只部分成功，合法条目仍可导入", async ({ page }) => {
    const { panel, sidebar, toolbar, state } = await openMcpPanel(page, { importDocker: true });
    await toolbar.locator("button").nth(0).click();
    await expect(page.getByText("已导入 1 项，2 个来源或条目未导入", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("VS Code 内部文档", { exact: true })).toBeVisible();
    await expect(panel.getByText("Docker", { exact: false })).toHaveCount(0);
    expect(state.imported).toBe(true);
  });

  test("MCP-15 自定义 MCP 用五种安装方式提交真实样例并成功启用", async ({ page }) => {
    const { sidebar, toolbar, state } = await openMcpPanel(page);
    const samples: Array<{
      type: string;
      placeholder: string;
      value: string;
      name: string;
      installType: string;
      transportType: string;
      runner?: string;
    }> = [
      { type: "本地命令（stdio）", placeholder: "例如：team-docs-mcp", value: "npx -y @modelcontextprotocol/server-everything", name: "server-everything", installType: "local-command", transportType: "stdio" },
      { type: "NPM 包", placeholder: "@scope/package-name", value: "@modelcontextprotocol/server-memory", name: "server-memory", installType: "npm", transportType: "stdio" },
      { type: "PyPI 包", placeholder: "例如：mcp-server-fetch", value: "mcp-server-time", runner: "uvx", name: "mcp-server-time", installType: "pypi", transportType: "stdio" },
      { type: "远程 HTTP", placeholder: "https://example.com/mcp", value: "https://3dassets.dev/mcp", name: "3dassets", installType: "http", transportType: "streamable-http" },
      { type: "远程 SSE", placeholder: "https://example.com/mcp", value: "https://g-guest.app/api/mcp", name: "g-guest", installType: "sse", transportType: "sse" },
    ];
    for (const sample of samples) {
      await toolbar.locator("button").nth(1).click();
      const dialog = page.locator(".ant-modal").filter({ hasText: "添加自定义 MCP" });
      await expect(dialog).toBeVisible();
      await chooseCustomInstallType(page, dialog, sample.type);
      await dialog.getByPlaceholder(sample.placeholder).fill(sample.value);
      if (sample.runner) await dialog.getByPlaceholder("uvx 或 python").fill(sample.runner);
      await dialog.locator(".ant-modal-footer button").last().click();
      await expect(page.getByText("自定义 MCP 已启用", { exact: true }).last()).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(sidebar.getByText(sample.name, { exact: true }).last()).toBeVisible();
      expect(state.lastMutation?.installType).toBe(sample.installType);
      expect(state.lastMutation?.transportType).toBe(sample.transportType);
      expect(state.lastMutation?.serverName).toBe(sample.name);
    }
  });
});
