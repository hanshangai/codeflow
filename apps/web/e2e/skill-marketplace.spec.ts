import { expect, test, type Page, type Route } from "@playwright/test";

const WORKSPACE_ID = "workspace_chat_core_e2e";

type SkillUiState = {
  suites: Array<Record<string, unknown>>;
  installed: Set<string>;
  lastMutation: Record<string, unknown> | null;
  catalogOnly: boolean;
  suitesRequestCount: number;
};

type MockSkillOptions = {
  shared?: boolean;
  sharedCanMaintain?: boolean;
  catalogOnly?: boolean;
  installed?: string[];
  suitesFailure?: { status: number; message: string };
  installFailTargets?: string[];
};

const BUILTIN_SKILL_SUITES = [
  {
    suiteId: "anthropic-official",
    name: "Anthropic Official Skills",
    description: "官方技能集：文档生成、Web 测试、MCP Builder",
    author: "Anthropic",
    homepage: "https://github.com/anthropics/skills",
    kind: "external",
    repoUrl: "https://github.com/anthropics/skills",
    skillsPath: "skills",
    source: "builtin",
    recommended: true,
    featuredRecommended: true,
    recommendedRank: 1,
  },
  {
    suiteId: "obra-superpowers",
    name: "Superpowers",
    description: "结构化 AI 开发方法论",
    author: "Jesse Vincent (obra)",
    homepage: "https://github.com/obra/superpowers",
    kind: "external",
    repoUrl: "https://github.com/obra/superpowers",
    skillsPath: "skills",
    source: "builtin",
    recommended: true,
    recommendedRank: 2,
  },
  {
    suiteId: "sentry-dev",
    name: "Sentry Dev Workflow",
    description: "代码审查、PR 创建、Issue 管理",
    author: "Sentry",
    homepage: "https://github.com/getsentry/skills",
    kind: "external",
    repoUrl: "https://github.com/getsentry/skills",
    source: "builtin",
  },
];

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
      sessionToken: "skill-marketplace-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      workspaceId: "workspace_chat_core_e2e",
      homePath: "/orchestration/workspace",
      userSummary: {
        userId: "skill-marketplace-e2e-user",
        email: "skill-marketplace-e2e@test.local",
        fullName: "技能市场 E2E 用户",
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

async function mockSkillApi(page: Page, options: MockSkillOptions = {}): Promise<SkillUiState> {
  const state: SkillUiState = {
    suites: [...BUILTIN_SKILL_SUITES],
    installed: new Set(options.installed ?? []),
    lastMutation: null,
    catalogOnly: Boolean(options.catalogOnly),
    suitesRequestCount: 0,
  };
  const shared = Boolean(options.shared);

  await page.route("**/api/workspaces*", async (route) => {
    await sendJson(route, {
      ok: true,
      workspaces: [{
        id: WORKSPACE_ID,
        title: shared ? "共享 E2E 工作区" : "本地工作区",
        path: shared ? "D:/e2e-shared-workspace" : "D:/e2e-workspace",
        createdAt: 1,
        updatedAt: 1,
        kind: shared ? "shared" : "local",
        ...(shared
          ? { capabilities: { canMaintainAssets: Boolean(options.sharedCanMaintain), effectiveAssetRole: options.sharedCanMaintain ? "admin" : "member" } }
          : { ownerClientId: "client-a" }),
      }],
      resolvedCurrentWorkspaceId: WORKSPACE_ID,
      workspaceListAuthoritative: true,
    });
  });
  await page.route("**/api/client-fs/directory-tree", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const dirPath = String(body.dirPath ?? "");
    let nodes: Array<Record<string, unknown>>;
    if (!dirPath) {
      nodes = [
        { name: "skills", path: "/home/user/skills", isDir: true, isLeaf: false },
        { name: "tmp", path: "/tmp", isDir: true, isLeaf: true },
      ];
    } else if (dirPath === "/home/user/skills") {
      nodes = [{ name: "team-docs", path: "/home/user/skills/team-docs", isDir: true, isLeaf: true }];
    } else {
      nodes = [];
    }
    await sendJson(route, { ok: true, nodes });
  });
  await page.route("**/api/account/me/summary", async (route) => {
    await sendJson(route, {
      ok: true,
      userId: "skill-marketplace-e2e-user",
      email: "skill-marketplace-e2e@test.local",
      fullName: "技能市场 E2E 用户",
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
    state.suitesRequestCount += 1;
    const targetStatus = Object.fromEntries(state.suites.map((suite) => [String(suite.suiteId), [
      {
        suiteId: suite.suiteId,
        targetId: "codex",
        label: "Codex",
        skillsRoot: "",
        installed: state.installed.has(String(suite.suiteId)) ? { installedAt: Date.now(), source: "community" } : null,
        ready: state.installed.has(String(suite.suiteId)),
        message: state.installed.has(String(suite.suiteId)) ? "1 项技能已安装" : "未安装",
      },
      {
        suiteId: suite.suiteId,
        targetId: "claude",
        label: "Claude",
        skillsRoot: "",
        installed: null,
        ready: false,
        message: "未安装",
      },
    ]]));
    await sendJson(route, { ok: true, suites: state.suites, targetStatus, catalogOnly: state.catalogOnly });
  });
  await page.route("**/api/skills/install", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.lastMutation = body;
    const suiteId = String(body.suiteId ?? (body.suite as Record<string, unknown> | null)?.suiteId ?? "");
    if (suiteId) state.installed.add(suiteId);
    const targets = Array.isArray(body.targets) ? body.targets.map((item) => String(item)) : [];
    const failSet = new Set(options.installFailTargets ?? []);
    await sendJson(route, { ok: true, results: targets.map((targetId) => failSet.has(targetId) ? { targetId, ok: false, message: "安装失败" } : { targetId, ok: true }) });
  });
  await page.route("**/api/skills/uninstall", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.lastMutation = body;
    const suiteId = String(body.suiteId ?? "");
    if (suiteId) state.installed.delete(suiteId);
    const targets = Array.isArray(body.targets) ? body.targets.map((item) => String(item)) : [];
    await sendJson(route, { ok: true, results: targets.map((targetId) => ({ targetId, ok: true })) });
  });
  await page.route("**/api/orch/knowledge-bundles*", async (route) => sendJson(route, { ok: true, bundles: [], assetMetadata: [] }));
  await page.route("**/api/orch/asset-groups*", async (route) => sendJson(route, { ok: true, groups: [], assignments: {} }));
  await page.route("**/api/orch/skills*", async (route) => sendJson(route, { ok: true, skills: [], assetMetadata: [] }));

  return state;
}

/** 进入 AI 资产 Skill Tab，默认停留在「Skill 市场」子视图。 */
async function openSkillTab(page: Page, options: MockSkillOptions = {}): Promise<SkillUiState> {
  const state = await mockSkillApi(page, options);
  await installSession(page, Boolean(options.shared));
  await page.goto("/orchestration/workspace");
  await page.getByRole("button", { name: "资产库" }).click();
  await page.getByRole("tab", { name: "Skill", exact: true }).click();
  await expect(page.getByTestId("skill-view-switch")).toBeVisible();
  return state;
}

/** 进入 AI 资产 Skill Tab 并切到「Skill 市场」子视图。 */
async function openSkillMarket(page: Page, options: MockSkillOptions = {}): Promise<{
  panel: ReturnType<Page["locator"]>;
  sidebar: ReturnType<Page["locator"]>;
  toolbar: ReturnType<Page["locator"]>;
  state: SkillUiState;
}> {
  const state = await openSkillTab(page, options);
  await page.getByTestId("skill-view-switch").getByText("Skill 市场", { exact: true }).click();

  const panel = page.locator(".skill-market-panel:visible").last();
  const sidebar = page.locator("#orch-skill-market-sidebar-host:visible .skill-market-panel__sidebar").last();
  const toolbar = page.locator("#orch-asset-toolbar-host:visible .skill-market-panel__toolbar").last();
  await expect(panel).toBeVisible();
  await expect(sidebar).toBeVisible();
  if (!options.suitesFailure) await expect(sidebar.locator(".skill-market-panel__list-item").first()).toBeVisible();
  return { panel, sidebar, toolbar, state };
}

test.describe("AI 资产 Skill 市场", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:39290/api/test/reset");
  });

  test("SKILL-01 推荐分组、搜索、列表与安装卸载", async ({ page }) => {
    const { panel, sidebar, toolbar, state } = await openSkillMarket(page);

    // 默认「全部」分组展示全部套件
    await expect(sidebar.locator(".skill-market-panel__list-item")).toHaveCount(3);
    await expect(sidebar.getByText("Anthropic Official Skills", { exact: true }).first()).toBeVisible();

    // 搜索按名称/作者匹配
    const search = toolbar.locator("input[placeholder='搜索技能...']").first();
    await search.fill("Superpowers");
    await expect(sidebar.locator(".skill-market-panel__list-item")).toHaveCount(1);
    await expect(sidebar.locator(".skill-market-panel__list-item").first()).toContainText("Superpowers");
    await search.fill("Sentry");
    await expect(sidebar.locator(".skill-market-panel__list-item")).toHaveCount(1);
    await expect(sidebar.locator(".skill-market-panel__list-item").first()).toContainText("Sentry");
    await search.fill("");

    // 推荐分组只展示推荐套件
    const groupSelect = sidebar.locator(".skill-market-panel__group-bar .ant-select");
    await groupSelect.click();
    await page.locator(".ant-select-dropdown:visible").last().getByText("推荐", { exact: true }).click();
    await expect(sidebar.locator(".skill-market-panel__list-item")).toHaveCount(2);

    // 选中推荐套件并安装
    await sidebar.locator(".skill-market-panel__list-item").filter({ hasText: "Anthropic Official Skills" }).click();
    await panel.getByRole("button", { name: /安\s*装/ }).click();
    await expect(page.getByText("安装完成", { exact: true })).toBeVisible();
    await expect(state.installed.has("anthropic-official")).toBe(true);
    // 列表出现「已安装」标签
    await expect(sidebar.locator(".skill-market-panel__list-item").filter({ hasText: "Anthropic Official Skills" }).getByText("已安装")).toBeVisible();
    // 已安装数量属于普通状态，不使用高强调 Alert。
    const installedTarget = panel.locator(".skill-market-panel__target-row").filter({ hasText: "Codex" });
    await expect(installedTarget.locator(".skill-market-panel__target-message")).toHaveText("1 项技能已安装");
    await expect(installedTarget.locator(".ant-alert")).toHaveCount(0);

    // 卸载
    await panel.getByRole("button", { name: /卸\s*载/ }).click();
    await page.getByRole("button", { name: /卸\s*载/ }).last().click();
    await expect(page.getByText("卸载完成", { exact: true })).toBeVisible();
    await expect(state.installed.has("anthropic-official")).toBe(false);
  });

  test("SKILL-02 自定义接入四种安装方式切换与 url 提交", async ({ page }) => {
    const { toolbar, state } = await openSkillMarket(page);
    await toolbar.getByRole("button", { name: "自定义接入" }).click();

    const dialog = page.locator(".ant-modal").filter({ hasText: "自定义 Skills 接入" });
    await expect(dialog).toBeVisible();

    // github（默认）→ 仓库 URL 字段
    await expect(dialog.locator("input[placeholder='https://github.com/org/repo']")).toBeVisible();

    // git → Git 仓库 URL 字段
    const installTypeSelect = dialog.locator(".ant-select").first();
    await installTypeSelect.click();
    await page.locator(".ant-select-dropdown:visible").last().getByText("Git 仓库", { exact: true }).click();
    await expect(dialog.locator("input[placeholder='https://gitlab.example.com/org/repo']")).toBeVisible();

    // local → 本机目录路径字段，且不显示「仓库/包内路径」
    await installTypeSelect.click();
    await page.locator(".ant-select-dropdown:visible").last().getByText("本地目录", { exact: true }).click();
    await expect(dialog.locator("input[placeholder='/path/to/skills 或 ~/skills/team']")).toBeVisible();
    await expect(dialog.getByText("仓库/包内路径", { exact: true })).toHaveCount(0);

    // url → 下载地址字段
    await installTypeSelect.click();
    await page.locator(".ant-select-dropdown:visible").last().getByText("下载链接", { exact: true }).click();
    await expect(dialog.locator("input[placeholder='https://example.com/skills.zip']")).toBeVisible();

    // 填写并提交（url 类型，默认安装目标为 codex+claude）
    await dialog.locator("input[name='codeflow-custom-skill-name']").fill("团队技能");
    await dialog.locator("input[placeholder='https://example.com/skills.zip']").fill("https://example.com/skills.zip");
    await dialog.getByRole("button", { name: /安\s*装/ }).click();
    await expect(page.getByText("自定义 Skills 已安装", { exact: true })).toBeVisible();
    await expect(state.lastMutation?.suite).toMatchObject({ installType: "url", archiveUrl: "https://example.com/skills.zip", source: "custom", author: "自定义" });
    await expect(state.lastMutation?.targets).toEqual(["codex", "claude"]);
  });

  test("SKILL-03 共享工作区成员只能查看", async ({ page }) => {
    const { panel, toolbar } = await openSkillMarket(page, { shared: true, sharedCanMaintain: false });

    await expect(panel.getByText("共享工作区成员不可维护 Skills", { exact: true })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "自定义接入" })).toBeDisabled();
    await expect(panel.getByRole("button", { name: /安\s*装/ })).toBeDisabled();
  });

  test("SKILL-04 共享工作区管理员可以维护", async ({ page }) => {
    const { panel, toolbar } = await openSkillMarket(page, { shared: true, sharedCanMaintain: true });

    await expect(toolbar.getByRole("button", { name: "自定义接入" })).toBeEnabled();
    await expect(panel.getByRole("button", { name: /安\s*装/ })).toBeEnabled();
    await panel.getByRole("button", { name: /安\s*装/ }).click();
    await expect(page.getByText("安装完成", { exact: true })).toBeVisible();
  });

  test("SKILL-05 无目标 Client 时仅展示公共目录，操作禁用", async ({ page }) => {
    const { panel, sidebar, toolbar } = await openSkillMarket(page, { catalogOnly: true });

    await expect(panel.getByText("当前仅展示公共市场目录", { exact: true })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "自定义接入" })).toBeDisabled();
    await sidebar.locator(".skill-market-panel__list-item").first().click();
    await expect(panel.getByRole("button", { name: /安\s*装/ })).toBeDisabled();
  });

  test("SKILL-06 目录状态查询失败显示失败态，不降级为空", async ({ page }) => {
    const { panel } = await openSkillMarket(page, { suitesFailure: { status: 502, message: "Client 状态查询失败" } });

    await expect(panel.getByText(/技能加载失败/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "重新加载", exact: true })).toBeVisible();
  });

  test("SKILL-07 安装部分失败显示逐 target 结果", async ({ page }) => {
    const { panel, sidebar } = await openSkillMarket(page, { installFailTargets: ["claude"] });
    await sidebar.locator(".skill-market-panel__list-item").first().click();
    await panel.getByRole("button", { name: /安\s*装/ }).click();
    await expect(page.getByText(/部分失败.*claude/)).toBeVisible();
  });

  test("SKILL-08 子视图默认 Skill 市场，可切换互斥", async ({ page }) => {
    await openSkillTab(page);

    // 默认停留在「Skill 市场」：显示 Skill 市场面板
    await expect(page.locator(".skill-market-panel:visible").last()).toBeVisible();

    // 切到平台 Skill：Skill 市场面板卸载
    await page.getByTestId("skill-view-switch").getByText("平台 Skill", { exact: true }).click();
    await expect(page.locator(".skill-market-panel")).toHaveCount(0);

    // 切回 Skill 市场：面板重新挂载
    await page.getByTestId("skill-view-switch").getByText("Skill 市场", { exact: true }).click();
    await expect(page.locator(".skill-market-panel:visible").last()).toBeVisible();
  });

  test("SKILL-09 切换子视图复用缓存，30s 内不重复请求", async ({ page }) => {
    const { state } = await openSkillMarket(page);
    const initialCount = state.suitesRequestCount;
    expect(initialCount).toBeGreaterThan(0);

    // 切回平台 Skill 再切回 Skill 市场，缓存命中不重新请求 suites
    await page.getByTestId("skill-view-switch").getByText("平台 Skill", { exact: true }).click();
    await page.getByTestId("skill-view-switch").getByText("Skill 市场", { exact: true }).click();
    await expect(page.locator(".skill-market-panel:visible").last()).toBeVisible();
    expect(state.suitesRequestCount).toBe(initialCount);
  });

  test("SKILL-10 自定义接入真实案例：四种安装方式", async ({ page }) => {
    const { toolbar, state } = await openSkillMarket(page);

    /** 打开自定义接入表单，选安装方式、填名称与来源，提交并断言提交内容。 */
    async function submitCase(input: {
      optionLabel: string;
      name: string;
      sourcePlaceholder: string;
      source: string;
      skillsPath?: string;
      expectFields: Record<string, unknown>;
    }): Promise<void> {
      await toolbar.getByRole("button", { name: "自定义接入" }).click();
      const dialog = page.locator(".ant-modal").filter({ hasText: "自定义 Skills 接入" });
      await expect(dialog).toBeVisible();
      if (input.optionLabel !== "GitHub 仓库") {
        await dialog.locator(".ant-select").first().click();
        await page.locator(".ant-select-dropdown:visible").last().getByText(input.optionLabel, { exact: true }).click();
      }
      await dialog.locator("input[name='codeflow-custom-skill-name']").fill(input.name);
      await dialog.locator(`input[placeholder='${input.sourcePlaceholder}']`).fill(input.source);
      if (input.skillsPath) {
        await dialog.locator("input[placeholder='默认根目录，可选 skills']").fill(input.skillsPath);
      }
      await dialog.getByRole("button", { name: /安\s*装/ }).click();
      await expect(page.getByText("自定义 Skills 已安装", { exact: true }).last()).toBeVisible();
      await expect(state.lastMutation?.suite).toMatchObject(input.expectFields);
    }

    // GitHub 仓库
    await submitCase({
      optionLabel: "GitHub 仓库",
      name: "Anthropic 官方技能",
      sourcePlaceholder: "https://github.com/org/repo",
      source: "https://github.com/anthropics/skills",
      skillsPath: "skills",
      expectFields: { installType: "github", repoUrl: "https://github.com/anthropics/skills", skillsPath: "skills", source: "custom" },
    });

    // Git 仓库
    await submitCase({
      optionLabel: "Git 仓库",
      name: "Superpowers",
      sourcePlaceholder: "https://gitlab.example.com/org/repo",
      source: "https://github.com/obra/superpowers.git",
      skillsPath: "skills",
      expectFields: { installType: "git", gitUrl: "https://github.com/obra/superpowers.git", skillsPath: "skills", source: "custom" },
    });

    // 本地目录
    await submitCase({
      optionLabel: "本地目录",
      name: "团队自定义技能",
      sourcePlaceholder: "/path/to/skills 或 ~/skills/team",
      source: "~/skills/team-docs",
      expectFields: { installType: "local", localPath: "~/skills/team-docs", source: "custom" },
    });

    // 下载链接
    await submitCase({
      optionLabel: "下载链接",
      name: "官方技能打包",
      sourcePlaceholder: "https://example.com/skills.zip",
      source: "https://github.com/anthropics/skills/archive/refs/heads/main.tar.gz",
      expectFields: { installType: "url", archiveUrl: "https://github.com/anthropics/skills/archive/refs/heads/main.tar.gz", source: "custom" },
    });
  });

  test("SKILL-11 local 安装支持浏览目录选择", async ({ page }) => {
    const { toolbar } = await openSkillMarket(page);
    await toolbar.getByRole("button", { name: "自定义接入" }).click();
    const dialog = page.locator(".ant-modal").filter({ hasText: "自定义 Skills 接入" });
    await expect(dialog).toBeVisible();

    // 切到本地目录
    await dialog.locator(".ant-select").first().click();
    await page.locator(".ant-select-dropdown:visible").last().getByText("本地目录", { exact: true }).click();

    // 点击浏览目录打开目录选择器
    await dialog.getByRole("button", { name: /浏览目录/ }).click();
    const picker = page.locator(".ant-modal").filter({ hasText: "选择 Client 本机目录" });
    await expect(picker).toBeVisible();

    // 展开 skills 节点，选中 team-docs
    await picker.locator(".ant-tree-treenode").filter({ hasText: "skills" }).locator(".ant-tree-switcher").first().click();
    await picker.locator(".ant-tree-treenode").filter({ hasText: "team-docs" }).locator(".ant-tree-node-content-wrapper").first().click();

    // 使用此目录回填
    await picker.getByRole("button", { name: "使用此目录", exact: true }).click();
    await expect(dialog.locator("input[placeholder='/path/to/skills 或 ~/skills/team']")).toHaveValue("/home/user/skills/team-docs");
  });
});
