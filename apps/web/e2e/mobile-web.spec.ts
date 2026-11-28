import { expect, test, type Page } from "@playwright/test";

const workspaceId = "workspace_chat_core_e2e";
const mockOrigin = "http://127.0.0.1:39290";
const session = {
  serverWsOrigin: "ws://127.0.0.1:39290", authMode: "account", accountRole: "enterprise_admin",
  sessionToken: "mobile-web-test-session", sessionExpiresAt: Date.now() + 7 * 24 * 3600_000,
  homePath: "/chat", setupComplete: true,
  userSummary: { userId: "chat-core-e2e-user", email: "mobile@example.test", fullName: "移动测试", accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e" },
  accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e" },
};

/** Reuse an isolated account session with the existing local mock server. */
async function prepare(page: Page, loggedIn = true, role = "enterprise_admin"): Promise<string[]> {
  const retiredRequests: string[] = [];
  page.on("request", (request) => {
    if (/^\/api\/(?:office-h5|h5|admin\/office-h5|account\/enterprise\/office-h5)\//.test(new URL(request.url()).pathname)) retiredRequests.push(request.url());
  });
  const isSuperAdmin = role === "super_admin";
  const value = {
    ...session, accountRole: role, homePath: isSuperAdmin ? "/admin" : "/chat",
    userSummary: {
      ...session.userSummary, accountRole: role,
      userId: isSuperAdmin ? "super_admin_01" : session.userSummary.userId,
      enterpriseId: isSuperAdmin ? null : session.userSummary.enterpriseId,
    },
    accessContext: isSuperAdmin
      ? { ...session.accessContext, identityType: "SUPER_ADMIN", effectiveAccessScope: "SUPER_ADMIN", enterpriseId: null }
      : session.accessContext,
  };
  if (role === "super_admin") {
    await page.route("**/api/account/me/ws-bridge", (route) => route.fulfill({ json: { ok: true, bridgeToken: "mobile-super-admin" } }));
    await page.route("**/api/account/me/summary", (route) => route.fulfill({ json: {
      ok: true, ...value.userSummary, accessContext: { ...value.accessContext, identityType: "SUPER_ADMIN", effectiveAccessScope: "SUPER_ADMIN" }, enterpriseSummary: null,
    } }));
  }
  await page.goto("/");
  await page.evaluate(({ value, loggedIn }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("config", JSON.stringify(loggedIn ? value : { serverWsOrigin: value.serverWsOrigin }));
  }, { value, loggedIn });
  await page.route("**/api/orch/pending-mine?*", (route) => route.fulfill({ json: { ok: true, items: [] } }));
  await page.route("**/api/account/enterprise/relay/status", (route) => route.fulfill({ json: { ok: true, state: "disabled" } }));
  await page.route("**/api/threads/draft/clear", (route) => route.fulfill({ json: { ok: true } }));
  return retiredRequests;
}

test.beforeEach(async ({ request }) => { await request.post(`${mockOrigin}/api/test/reset`); });

/** 模拟 iOS 键盘只改变可见视口，不改变布局视口的行为。 */
async function installKeyboardViewport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    const bounds = { height: innerHeight, offsetTop: 0, scale: 1 };
    for (const key of ["height", "offsetTop", "scale"] as const) {
      Object.defineProperty(viewport, key, { get: () => bounds[key] });
    }
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.assign(window, {
      setKeyboardViewport(height: number, offsetTop: number, event: string) {
        bounds.height = height;
        bounds.offsetTop = offsetTop;
        viewport.dispatchEvent(new Event(event));
      },
    });
  });
}

/** 驱动可见视口事件，不发送 window.resize，覆盖 iOS 独立键盘视口。 */
async function setKeyboardViewport(page: Page, height: number, top = 0, event = "resize"): Promise<void> {
  await page.evaluate(({ height, top, event }) => {
    (window as unknown as { setKeyboardViewport: (h: number, top: number, event: string) => void })
      .setKeyboardViewport(height, top, event);
  }, { height, top, event });
}

/** 可见视口缩小后，标题、输入区和发送按钮均须位于键盘上方。 */
async function expectChatInsideViewport(page: Page, height: number, top = 0): Promise<void> {
  const chatPage = page.locator(".mobile-page--h5-chat");
  await expect.poll(async () => Math.round((await chatPage.boundingBox())!.height)).toBe(height);
  await expect.poll(async () => Math.round((await chatPage.boundingBox())!.y)).toBe(top);
  for (const selector of [".mobile-page__header", ".composer__textarea", ".composer__send-btn"]) {
    const box = await chatPage.locator(selector).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(top - 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(top + height + 1);
  }
  expect((await chatPage.locator(".chat-panel__messages").boundingBox())!.height).toBeGreaterThan(40);
}

test("移动会话在键盘展开、偏移、收起和重新进入时保持输入区可见", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installKeyboardViewport(page);
  await prepare(page);
  const response = await request.post(`${mockOrigin}/api/threads/create`, { data: { workspaceId, engine: "codex", title: "键盘遮挡回归" } });
  const created = await response.json();
  const threadId = created.thread?.id ?? created.threadId;
  expect(threadId).toBeTruthy();
  await page.goto(`/chat?workspaceId=${workspaceId}&threadId=${threadId}`);
  const input = page.locator(".mobile-page--h5-chat .composer__textarea");
  await expect(input).toBeVisible();
  await expect(input).not.toBeFocused();
  await input.fill("键盘遮挡回归\n第二行\n第三行\n第四行\n第五行\n第六行");
  expect(await input.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await setKeyboardViewport(page, 420);
  await expectChatInsideViewport(page, 420);
  await setKeyboardViewport(page, 420, 55, "scroll");
  await expectChatInsideViewport(page, 420, 55);
  await page.screenshot({ path: testInfo.outputPath("keyboard-open.png"), animations: "disabled" });
  await setKeyboardViewport(page, 844);
  await expectChatInsideViewport(page, 844);
  await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await expect(page.locator(".mobile-page--h5-chat")).toHaveCount(0);
  await setKeyboardViewport(page, 380, 25);
  await page.locator(".h5-thread-row").first().click();
  await expectChatInsideViewport(page, 380, 25);
});

test("移动会话在无 VisualViewport API 时随窗口缩放恢复高度", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined }));
  await prepare(page);
  const response = await request.post(`${mockOrigin}/api/threads/create`, { data: { workspaceId, engine: "codex", title: "窗口高度回归" } });
  const created = await response.json();
  const threadId = created.thread?.id ?? created.threadId;
  expect(threadId).toBeTruthy();
  await page.goto(`/chat?workspaceId=${workspaceId}&threadId=${threadId}`);
  await expect(page.locator(".mobile-page--h5-chat .composer__textarea")).toBeVisible();
  await expectChatInsideViewport(page, 844);
  await page.setViewportSize({ width: 390, height: 420 });
  await expectChatInsideViewport(page, 420);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectChatInsideViewport(page, 844);
});

test("mobile root opens login and returns to conversations after sign-in", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, false);
  await page.route("**/api/account/auth/login", (route) => route.fulfill({ json: { ok: true, ...session, deployment: { edition: "public" } } }));
  await page.goto("/");
  await expect(page.locator("#login-email")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("redirect")).toBe("/chat");
  await page.locator("#login-email").fill("mobile@example.test");
  await page.locator("#login-password").fill("mock-password");
  await page.locator(".auth-login__submit").click();
  await expect(page).toHaveURL(/\/chat(?:\?|$)/);
  await expect(page.getByRole("tab").first()).toBeVisible();
});

test("mobile root reuses a persisted login", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/chat(?:\?|$)/);
  await expect(page.getByRole("tab").first()).toBeVisible();
});

test("desktop root remains on the public home with an active session", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 844 });
  await prepare(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("CodeFlow", { exact: false }).first()).toBeVisible();
});

for (const width of [390, 1366]) {
  test(`notification Web preserves login and targets at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const retired = await prepare(page);
    const target = `/chat?workspaceId=${workspaceId}&tab=pending&targetId=instance-1`;
    await page.goto(`/office-h5/wecom?corpId=retired&redirect=${encodeURIComponent(target.replace("/chat", "/h5"))}`);
    await expect(page).toHaveURL(new RegExp(`/chat\\?workspaceId=${workspaceId}`));
    await expect(page.locator(".h5-pending-panel")).toBeVisible();
    await page.reload();
    await expect(page.locator(".h5-pending-panel")).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("config")!).sessionToken)).toBe(session.sessionToken);
    expect(retired).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(overflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`notification-${width}.png`), fullPage: true, animations: 'disabled' });
    const reopened = await page.context().newPage();
    await reopened.route("**/api/orch/pending-mine?*", (route) => route.fulfill({ json: { ok: true, items: [] } }));
    await reopened.goto(target);
    await expect(reopened.locator(".h5-pending-panel")).toBeVisible();
    await reopened.close();
  });

  for (const role of ["enterprise_admin", "super_admin"]) test(`${role} loses H5 configuration at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const retired = await prepare(page, true, role);
    await page.goto("/admin?panel=office-h5");
    await expect(page.locator(".admin-mobile-settings-panel")).toBeVisible();
    await expect(page.getByText("办公 H5", { exact: true })).toHaveCount(0);
    await expect(page.locator(".office-h5-panel")).toHaveCount(0);
    expect(retired).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`notifications-settings-${width}.png`), fullPage: true, animations: 'disabled' });
  });
}

test("mobile workbench retains categories, tools and full-screen conversation", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const retired = await prepare(page);
  await page.goto(`/chat?workspaceId=${workspaceId}`);
  for (const name of ["自建会话", "编排会话", "归档会话", "待办"]) {
    await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "打开个人信息", exact: true }).click();
  await expect(page.getByText("消息通知", { exact: true })).toBeVisible();
  await expect(page.getByText("办公平台绑定", { exact: true })).toHaveCount(0);
  const response = await request.post(`${mockOrigin}/api/threads/create`, { data: { workspaceId, engine: "codex", title: "移动 Web 会话" } });
  const created = await response.json();
  const threadId = created.thread?.id ?? created.threadId;
  expect(threadId).toBeTruthy();
  await page.goto(`/chat?workspaceId=${workspaceId}&threadId=${threadId}`, { waitUntil: 'networkidle' });
  await expect(page.locator(".composer__textarea")).toBeVisible();
  await page.locator(".composer__textarea").fill("移动 Web 验证");
  await page.locator(".composer__send-btn").click();
  await expect(page.getByText("已收到：移动 Web 验证").first()).toBeVisible();
  await expect(page.locator(".composer__send-btn")).not.toHaveClass(/running/);
  expect(retired).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("mobile-conversation.png"), fullPage: true, animations: 'disabled' });
});

test("expired sessions require login without losing the notification target", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page);
  await page.evaluate(() => {
    const value = JSON.parse(localStorage.getItem("config")!);
    value.sessionExpiresAt = Date.now() - 1;
    localStorage.setItem("config", JSON.stringify(value));
  });
  const target = `/chat?workspaceId=${workspaceId}&tab=pending&targetId=instance-3`;
  await page.goto(target);
  await expect(page.locator("#login-email")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("redirect")).toBe(target);
});

test("legacy DingTalk link returns to its target after CodeFlow login", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const retired = await prepare(page, false);
  const target = `/h5?workspaceId=${workspaceId}&tab=pending&targetId=instance-2`;
  await page.route("**/api/account/auth/login", (route) => route.fulfill({ json: { ok: true, ...session, deployment: { edition: "public" } } }));
  await page.goto(`/office-h5/dingtalk/?corpId=retired&code=used&state=used&redirect=${encodeURIComponent(target)}`);
  await expect(page.locator(".auth-shell--mobile-login")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("redirect")).toBe(target.replace("/h5", "/chat"));
  await page.locator("#login-email").fill("mobile@example.test");
  await page.locator("#login-password").fill("mock-password");
  await page.locator(".auth-login__submit").click();
  await expect(page.locator(".h5-pending-panel")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("targetId")).toBe("instance-2");
  expect(retired).toEqual([]);
});

test("mobile workflow approval uses standard authenticated APIs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page);
  const captures: Record<string, unknown>[] = [];
  const item = {
    intake: { id: "intake-1", title: "移动审核", goal: "核对结果" },
    reminder: { id: "reminder-1", title: "审核节点", summary: "等待审核", isActionRequired: true, updatedAt: Date.now(), routeTarget: { workspaceId, instanceId: "instance-1", nodeId: "review-1" } },
    listMeta: { latestInstance: { runSummary: { activeNodeLabel: "审核节点" } } },
    pendingMineStatus: "waiting-approval", pendingMineStatusLabel: "待审核",
  };
  await page.route("**/api/orch/pending-mine?*", (route) => route.fulfill({ json: { ok: true, items: captures.length ? [] : [item] } }));
  await page.route("**/api/orch/instances/get", (route) => route.fulfill({ json: { ok: true, instance: {
    id: "instance-1", workflowSnapshot: { nodes: [{ id: "review-1", label: "审核节点" }] },
    nodeStates: { "review-1": { nodeId: "review-1", status: "waiting-approval", outputArtifactIds: [] } },
  } } }));
  await page.route("**/api/orch/artifacts/list", (route) => route.fulfill({ json: { ok: true, artifacts: [] } }));
  await page.route("**/api/orch/instances/feedback", async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${session.sessionToken}`);
    expect(route.request().headers()["x-office-h5-corp-id"]).toBeUndefined();
    captures.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/chat?workspaceId=${workspaceId}&tab=pending&targetId=instance-1`);
  await page.locator('[data-h5-pending-target="true"]').click();
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await expect(page.getByText("操作已提交。", { exact: true })).toBeVisible();
  expect(captures).toHaveLength(1);
  expect(captures[0]).toMatchObject({ workspaceId, instanceId: "instance-1", nodeId: "review-1", action: "approve" });
});

for (const width of [320, 390]) test(`流量明细 Fast 在 ${width}px 下展示开启、未开启及未知状态`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await prepare(page);
  await page.route('**/api/account/me/relay/usage', route => route.fulfill({ json: {
    ok: true, status: { state: 'enabled' }, item: { integrationStatus: 'synced', quota: 2, upstreamStatus: 'active' },
  } }));
  await page.route('**/api/account/me/relay/balances', route => route.fulfill({ json: {
    ok: true, personal: { availableUsdUnits: '200000000' }, enterprise: null,
  } }));
  const scenarios = [
    { tier: 'priority', expected: 'Fast：已开启' },
    { tier: 'default', expected: 'Fast：未开启' },
    { tier: null, expected: 'Fast：未知' },
  ];
  await page.route('**/api/account/me/relay/usage-logs?*', route => route.fulfill({ json: {
    ok: true, status: { state: 'enabled' }, total: scenarios.length, page: 1, pageSize: 20,
    items: scenarios.map((scenario, index) => ({
      id: index + 1, model: 'gpt-6.1-sol', service_tier: scenario.tier, created_at: '2026-10-16T05:00:00Z',
      stream: true, input_tokens: 100, output_tokens: 20, cache_read_tokens: 0,
      cache_creation_tokens: 0, actual_cost: .01, duration_ms: 1500,
    })),
  } }));
  await page.goto(`/chat?workspaceId=${workspaceId}`);
  await page.getByRole('button', { name: '打开个人信息' }).click();
  await page.locator('.h5-settings').getByRole('button', { name: /流量统计/ }).click();

  const cards = page.locator('.relay-mobile-log');
  await expect(cards).toHaveCount(scenarios.length);
  for (const [index, scenario] of scenarios.entries()) {
    await expect(cards.nth(index)).toContainText(scenario.expected);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
});

for (const width of [320, 390]) test(`avatar owns mobile settings and compact usage at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  await prepare(page);
  const queries: URLSearchParams[] = [];
  let logState: 'rows' | 'empty' | 'error' = 'rows';
  await page.route('**/api/account/me/relay/usage', route => route.fulfill({ json: { ok: true, status: { state: 'enabled' }, item: { integrationStatus: 'synced', quota: 2, upstreamStatus: 'active' } } }));
  await page.route('**/api/account/me/relay/balances', route => route.fulfill({ json: { ok: true, personal: { availableUsdUnits: '200000000' }, enterprise: null } }));
  await page.route('**/api/account/me/relay/usage-logs?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    queries.push(params);
    if (logState === 'error') { await route.fulfill({ json: { ok: false, code: 'TEST_ERROR', message: '用量查询暂时失败' } }); return; }
    await route.fulfill({ json: { ok: true, status: { state: 'enabled' }, total: logState === 'empty' ? 0 : 21, page: Number(params.get('page')), pageSize: 20, items: logState === 'empty' ? [] : [{
      id: Number(params.get('page')), model: `gpt-mobile-page-${params.get('page')}`, created_at: '2026-09-22T00:00:00Z', stream: true,
      input_tokens: 100, output_tokens: 20, cache_read_tokens: 40, cache_creation_tokens: 0, actual_cost: .01, duration_ms: 1500,
    }] } });
  });
  await page.route('**/api/account/me/relay/usage-summary?*', route => {
    const total = { actualCost: .01, requests: 1, totalTokens: 160, uncachedInputTokens: 100, cachedInputTokens: 40, outputTokens: 20, averageDurationMs: 1500 };
    const dimension = { dimensions: [{ ...total, key: 'gpt', label: 'GPT 移动统计', costRatio: 1 }], series: [{ ...total, date: '2026-09-22', dimensionKey: 'gpt', dimensionLabel: 'GPT 移动统计' }] };
    return route.fulfill({ json: { ok: true, range: { startDate: '2026-09-16', endDate: '2026-09-22' }, total, byModel: dimension, byApiKey: { dimensions: [], series: [] }, apiKeys: [] } });
  });
  await page.route('**/api/engine-keys/models?*', route => route.fulfill({ json: { ok: true, models: [] } }));
  await page.goto(`/chat?workspaceId=${workspaceId}`);
  await expect(page.locator('.mobile-tabs button')).toHaveText(['会话', '文件']);
  const headerActions = page.locator('.h5-workbench-home__actions button');
  expect(await headerActions.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['切换工作区', '分组管理与切换', '新建会话']);
  await expect(page.locator('.h5-workbench-home__group-filter')).toHaveCount(0);
  await expect(page.locator('.h5-workbench-home__group-switch')).toHaveText('全部分组');
  await page.screenshot({ path: testInfo.outputPath(`header-${width}.png`), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '打开个人信息' }).click();
  await expect(page.getByText('系统设置', { exact: true })).toHaveCount(0);
  const settings = page.locator('.h5-settings');
  await expect(settings.locator('.h5-settings__row-copy strong')).toHaveText(['工作区管理', '模型与密钥', '流量统计', '支付订单', '消息通知', '个人信息']);
  await expect(settings.getByRole('group', { name: '亮暗模式' }).getByRole('button')).toHaveText(['亮色', '暗色', '自动']);
  await expect(settings.getByRole('group', { name: '亮暗模式' }).locator('svg')).toHaveCount(0);
  await expect(settings.getByText('外观', { exact: true })).toHaveCount(0);
  await expect(settings.getByText('进入', { exact: true })).toHaveCount(0);
  await expect(settings.locator('.h5-settings__chevron, .anticon-right')).toHaveCount(0);
  const icons = settings.locator('.h5-settings__row-icon');
  await expect(icons).toHaveCount(6);
  expect(await icons.evaluateAll(nodes => nodes.every(node => {
    const style = getComputedStyle(node);
    return style.width === '40px' && style.height === '40px' && style.borderRadius === '13px' && style.color === 'rgb(255, 255, 255)' && style.backgroundImage !== 'none';
  }))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`avatar-${width}.png`), fullPage: true, animations: 'disabled' });
  await page.locator('.h5-settings').getByRole('button', { name: /模型与密钥/ }).click();
  await expect(page.getByRole('tab', { name: '密钥管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /添加 Key/ }).click();
  await expect(page.locator('.h5-engine-key-modal .ant-modal')).toBeVisible();
  await expect(page.locator('.h5-engine-key-modal .ant-modal-content')).toBeInViewport();
  await page.locator('.h5-engine-key-modal').getByRole('button', { name: /取\s*消/ }).click();
  await page.getByRole('tab', { name: '自定义模型', exact: true }).click();
  await expect(page.getByRole('button', { name: /添加模型/ })).toBeVisible();
  await page.getByRole('button', { name: /添加模型/ }).click();
  await expect(page.locator('.h5-engine-key-modal:visible')).toContainText('模型 ID');
  await page.locator('.h5-engine-key-modal:visible').getByRole('button', { name: /取\s*消/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath(`models-${width}.png`), fullPage: true, animations: 'disabled' });
  await page.locator('.mobile-page__back').click();
  await expect(page.locator('.h5-profile-drawer')).toHaveClass(/ant-drawer-open/);
  await page.locator('.h5-settings').getByRole('button', { name: /流量统计/ }).click();
  await expect(page.locator('.relay-mobile-log')).toContainText('gpt-mobile-page-1');
  await expect(page.locator('.relay-mobile-log')).toContainText('160');
  await page.locator('.relay-mobile-log summary').click();
  await expect(page.locator('.relay-mobile-log__details')).toBeVisible();
  await page.locator('.ant-pagination-next').click();
  await expect(page.locator('.relay-mobile-log')).toContainText('gpt-mobile-page-2');
  await page.getByRole('button', { name: /筛选/ }).click();
  await page.getByPlaceholder('全部模型', { exact: true }).fill('gpt');
  await page.getByRole('button', { name: /查\s*询/ }).click();
  await expect.poll(() => queries.at(-1)?.get('model')).toBe('gpt');
  expect(queries.at(-1)?.get('page')).toBe('1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath(`usage-${width}.png`), fullPage: true, animations: 'disabled' });
  const panelHeight = await page.locator('.relay-self-usage--mobile').evaluate(el => el.getBoundingClientRect().height);
  logState = 'error';
  await page.getByRole('button', { name: /查\s*询/ }).click();
  await expect(page.getByText('用量查询暂时失败', { exact: true })).toBeVisible();
  logState = 'empty';
  await page.getByRole('button', { name: /重\s*试/ }).click();
  await expect(page.getByText('当前范围暂无使用记录', { exact: true })).toBeVisible();
  expect(await page.locator('.relay-self-usage--mobile').evaluate(el => el.getBoundingClientRect().height)).toBe(panelHeight);
  await page.getByRole('tab', { name: '汇总统计', exact: true }).click();
  await expect(page.locator('.relay-summary__metrics')).toContainText('160');
  await expect(page.locator('.relay-summary__mobile-list')).toContainText('GPT 移动统计');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath(`usage-summary-${width}.png`), fullPage: true, animations: 'disabled' });
  await page.locator('.mobile-page__back').click();
  await expect(page.locator('.h5-profile-drawer')).toHaveClass(/ant-drawer-open/);
});

test('all avatar setting subpages return to the setting drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await prepare(page);
  const emptyChannel = (channel: 'dingtalk' | 'wecom') => ({
    channel, enabled: false, webhook: '', webhookConfigured: false, webhookPreview: '', secret: '', secretConfigured: false,
    keyword: '', atMobiles: [], atUserIds: [], atAll: false, createdAt: 0, updatedAt: 0,
  });
  await page.route('**/api/account/message-notifications/config', route => route.fulfill({ json: {
    ok: true, channels: { dingtalk: emptyChannel('dingtalk'), wecom: emptyChannel('wecom') },
  } }));
  await page.route('**/api/account/order-info/payment-orders?*', route => route.fulfill({ json: {
    ok: true, items: [], total: 0, page: 1, pageSize: 20, serverNow: Date.now(),
  } }));
  await page.route('**/api/account/me/relay/usage', route => route.fulfill({ json: { ok: true, status: { state: 'disabled' }, item: null } }));
  await page.route('**/api/account/me/relay/balances', route => route.fulfill({ json: { ok: true, personal: null, enterprise: null } }));
  await page.route('**/api/account/me/relay/usage-logs?*', route => route.fulfill({ json: { ok: true, status: { state: 'disabled' }, total: 0, page: 1, pageSize: 20, items: [] } }));
  await page.goto(`/chat?workspaceId=${workspaceId}`);
  await page.getByRole('button', { name: '打开个人信息', exact: true }).click();
  for (const entry of [
    { menu: '工作区管理', title: '工作区管理' },
    { menu: '模型与密钥', title: '模型与密钥' },
    { menu: '流量统计', title: '流量统计' },
    { menu: '支付订单', title: '支付订单' },
    { menu: '消息通知', title: '消息通知' },
  ]) {
    await page.locator('.h5-settings').getByRole('button', { name: new RegExp(entry.menu) }).click();
    await expect(page.locator('.mobile-page__header')).toContainText(entry.title);
    await expect(page.locator('.h5-profile-drawer')).not.toHaveClass(/ant-drawer-open/);
    await page.locator('.mobile-page__back').click();
    await expect(page.locator('.h5-profile-drawer')).toHaveClass(/ant-drawer-open/);
    await expect(page.locator('.h5-settings')).toBeVisible();
  }
  expect(pageErrors).toEqual([]);
});

test('mobile groups default to all and support switching, CRUD and grouped creation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page);
  let groups = [{ id: 'group-a', name: '产品研发', createdAt: 1, updatedAt: 1 }];
  let threads = [{ id: 'thread-a', title: '组内会话', groupId: 'group-a' }, { id: 'thread-b', title: '未分组会话', groupId: null }];
  let createdGroup: string | null = null;
  let groupLoadFails = false;
  const requests: URLSearchParams[] = [];
  await page.route('**/api/threads/groups**', async route => {
    const request = route.request();
    if (request.method() === 'GET') { await route.fulfill({ json: groupLoadFails ? { ok: false, code: 'TEST_ERROR', message: '分组查询失败' } : { ok: true, groups } }); return; }
    const body = request.postDataJSON();
    expect(body.workspaceId).toBe(workspaceId);
    if (request.url().endsWith('/create')) groups.push({ id: 'group-new', name: body.name, createdAt: 1, updatedAt: 1 });
    if (request.url().endsWith('/rename')) groups = groups.map(g => g.id === body.groupId ? { ...g, name: body.name } : g);
    if (request.url().endsWith('/delete')) { groups = groups.filter(g => g.id !== body.groupId); threads = threads.map(t => ({ ...t, groupId: t.groupId === body.groupId ? null : t.groupId })); }
    await route.fulfill({ json: { ok: true, group: groups.find(g => g.id === body.groupId) ?? groups.at(-1) } });
  });
  await page.route(/\/api\/threads\?/, async route => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const group = params.get('groupId');
    const cursor = params.get('cursor');
    const rows = cursor ? [{ id: 'thread-page2', title: '组内第二页', groupId: group }] : threads.filter(t => !group || (group === 'ungrouped' ? !t.groupId : t.groupId === group));
    const hasMore = group === 'group-a' && !cursor;
    await route.fulfill({ json: { ok: true, threads: rows.map(t => ({ ...t, engine: 'codex', threadType: 'chat', createdAt: 1, updatedAt: 1 })), runningByThreadId: {}, hasMore, nextCursor: hasMore ? 'page2' : null } });
  });
  await page.route('**/api/threads/create', async route => { createdGroup = route.request().postDataJSON().groupId; await route.continue(); });
  await page.goto(`/chat?workspaceId=${workspaceId}`);
  await expect(page.locator('.h5-thread-row')).toHaveCount(2);
  await expect(page.locator('.h5-thread-row__group').first()).toHaveText('产品研发');
  expect(requests[0]?.get('groupId')).toBeNull();
  await page.getByRole('button', { name: '分组管理与切换' }).click();
  await page.locator('.mobile-groups__choice').filter({ hasText: '产品研发' }).click();
  await expect(page.locator('.h5-thread-row')).toHaveCount(1);
  await expect(page.locator('.h5-workbench-home__group-switch')).toHaveText('产品研发');
  await expect(page.getByRole('tab', { name: '会话', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(requests.at(-1)?.get('groupId')).toBe('group-a');
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.locator('.h5-thread-row')).toHaveCount(2);
  expect(requests.at(-1)?.get('groupId')).toBe('group-a');
  expect(requests.at(-1)?.get('cursor')).toBe('page2');
  await page.getByRole('tab', { name: '流程', exact: true }).click();
  await page.getByRole('button', { name: '分组管理与切换' }).click();
  await page.locator('.mobile-groups__choice').filter({ hasText: '全部分组' }).click();
  await expect(page.getByRole('tab', { name: '会话', exact: true })).toHaveAttribute('aria-selected', 'true');
  groupLoadFails = true;
  await page.getByRole('button', { name: '分组管理与切换' }).click();
  await expect(page.getByText('分组加载失败，请重试', { exact: true })).toBeVisible();
  groupLoadFails = false;
  await page.locator('.mobile-groups').getByRole('button', { name: /重\s*试/ }).click();
  await expect(page.getByText('分组加载失败，请重试', { exact: true })).toHaveCount(0);
  await page.locator('.mobile-groups__choice').filter({ hasText: '产品研发' }).click();
  await page.getByRole('button', { name: '分组管理与切换' }).click();
  await page.getByRole('button', { name: '重命名 产品研发' }).click();
  await page.getByRole('textbox', { name: '分组名称' }).fill('研发讨论');
  await page.getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.locator('.mobile-groups__choice').filter({ hasText: '研发讨论' })).toBeVisible();
  await page.getByRole('textbox', { name: '分组名称' }).fill('临时项目');
  await page.locator('.mobile-groups__form').getByRole('button', { name: /新\s*建/ }).click();
  await expect(page.locator('.mobile-groups__choice').filter({ hasText: '临时项目' })).toBeVisible();
  await page.getByRole('button', { name: '删除 临时项目' }).click();
  await expect(page.getByText('删除后，组内会话移至未分组，不会删除会话。')).toBeVisible();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.locator('.mobile-groups__choice').filter({ hasText: '临时项目' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('groups.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '删除 研发讨论' }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.locator('.mobile-groups__choice').filter({ hasText: '全部分组' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: '分组名称' }).fill('新分组');
  await page.locator('.mobile-groups__form').getByRole('button', { name: /新\s*建/ }).click();
  await page.locator('.mobile-groups__choice').filter({ hasText: '新分组' }).click();
  await expect(page.locator('.h5-thread-row')).toHaveCount(0);
  await page.getByRole('button', { name: '分组管理与切换' }).click();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await page.getByPlaceholder('例如：移动工作台交互评审').fill('分组新会话');
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect.poll(() => createdGroup).toBe('group-new');
});

for (const tab of ['orders', 'workspace']) test(`retired persisted mobile tab ${tab} restores conversations`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page);
  await page.evaluate(tab => localStorage.setItem('ui', JSON.stringify({ activeMobileTab: tab, threadFilterTab: 'current' })), tab);
  await page.goto(`/chat?workspaceId=${workspaceId}`);
  await expect(page.locator('.h5-workbench-home')).toBeVisible();
  await expect(page.locator('.mobile-tabs button')).toHaveText(['会话', '文件']);
  await expect(page.getByRole('tab', { name: '自建会话', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.h5-workbench-home__group-switch')).toContainText('全部分组');
});

test('avatar account destinations and appearance remain functional after menu reorder', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await prepare(page);
  // The legacy mock uses null; the account API contract always returns a security summary.
  await page.route('**/api/account/me/summary', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), securitySummary: {
      lastPasswordChangedAt: 0, failedAttempts: 0, lockedUntil: 0, forceReset: false,
    } } });
  });
  await page.goto(`/chat?workspaceId=${workspaceId}`);
  const profileDrawer = page.locator('.h5-profile-drawer');
  const profileDrawerClass = await profileDrawer.count() ? await profileDrawer.first().getAttribute('class') : '';
  if (!profileDrawerClass?.includes('ant-drawer-open')) {
    await page.getByRole('button', { name: '打开个人信息', exact: true }).click();
  }
  await expect(page.locator('.h5-profile-drawer')).toHaveClass(/ant-drawer-open/);
  await page.locator('.h5-settings').getByRole('button', { name: '个人信息' }).click();
  await expect(page.locator('.account-drawer__h5-title strong')).toHaveText('个人信息');
  await expect(page.locator('.h5-profile-drawer')).not.toHaveClass(/ant-drawer-open/);
  await page.getByRole('button', { name: '返回个人中心', exact: true }).click();
  await expect(page.locator('.account-drawer__h5-title')).toBeHidden();
  await expect(page.locator('.h5-profile-drawer')).toHaveClass(/ant-drawer-open/);
  await expect(page.locator('.h5-settings')).toBeVisible();
  const appearance = page.getByRole('group', { name: '亮暗模式' });
  await appearance.getByRole('button', { name: '暗色', exact: true }).click();
  await expect(appearance.getByRole('button', { name: '暗色', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('avatar-dark-lower.png'), fullPage: true, animations: 'disabled' });
  await appearance.getByRole('button', { name: '亮色', exact: true }).click();
  await expect(appearance.getByRole('button', { name: '亮色', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('avatar-light-lower.png'), fullPage: true, animations: 'disabled' });
  await expect(page.locator('.h5-settings').getByRole('button', { name: '退出登录', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  expect(pageErrors).toEqual([]);
});
