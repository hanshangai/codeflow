import { expect, test, type Page } from "@playwright/test";

const mockHttpOrigin = "http://127.0.0.1:39290";
const mockWsOrigin = "ws://127.0.0.1:39290";
const workspaceId = "workspace_chat_core_e2e";
const markerPrefix = "codeflowai.default-thread.auto-create::";
const defaultThreadTitle = "默认会话";

type AutoCreateHarness = {
  createBodies: Array<Record<string, unknown>>;
  keyListRequests: number;
  threadListRequests: number;
};

/** 记录自动创建链路上的关键请求，用于断言"只在应该创建时才创建一次"。 */
function installRequestRecorder(page: Page): AutoCreateHarness {
  const harness: AutoCreateHarness = { createBodies: [], keyListRequests: 0, threadListRequests: 0 };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/threads/create" && request.method() === "POST") {
      harness.createBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
    if (url.pathname === "/api/engine-keys" && request.method() === "GET") harness.keyListRequests += 1;
    if (url.pathname === "/api/threads" && request.method() === "GET") harness.threadListRequests += 1;
  });
  return harness;
}

/** 打进账号会话与本地工作区，应用连上 mock server 后即满足自动创建前置条件。 */
async function openApp(page: Page): Promise<AutoCreateHarness> {
  const harness = installRequestRecorder(page);
  await installSession(page);
  await page.goto("/chat");
  return harness;
}

async function installSession(page: Page): Promise<void> {
  await page.addInitScript(({ config }) => {
    // 只在首次导航注入登录态：reload 必须保留一次性标记，否则测不到"只自动建一次"。
    if (window.localStorage.getItem("config")) return;
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify(config));
    window.localStorage.setItem("ui", JSON.stringify({ themeMode: "light" }));
  }, {
    config: {
      serverWsOrigin: mockWsOrigin,
      authMode: "account",
      accountRole: "user",
      sessionToken: "e2e-default-thread-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      workspaceId,
      homePath: "/chat",
      accessContext: {
        identityType: "ENTERPRISE_MEMBER",
        editionType: "COMMUNITY",
        editionStatus: "ACTIVE",
        effectiveAccessScope: "ENTERPRISE_MEMBER",
        enterpriseId: "enterprise-1",
        enterpriseName: "Design Co",
      },
      userSummary: {
        userId: "member-default-thread",
        email: "default-thread@example.test",
        fullName: "默认会话测试",
        phone: "",
        avatarUrl: null,
        accountRole: "user",
        status: "active",
        enterpriseId: "enterprise-1",
        enterpriseName: "Design Co",
      },
    },
  });
}

/** 通过测试端点预置引擎 Key；isActive 决定是否满足"有启用中 Key"。 */
async function presetEngineKeys(page: Page, keys: Array<{ engine: "codex" | "claude"; providerId: string; isActive: boolean }>): Promise<void> {
  const response = await page.request.post(`${mockHttpOrigin}/api/test/engine-keys`, {
    data: { keys: keys.map((key, index) => ({ ...key, label: `E2E Key ${index + 1}`, apiKey: "masked" })) },
  });
  expect(response.ok()).toBe(true);
}

async function readMockThreads(page: Page): Promise<Array<{ id: string; title: string; engine: string }>> {
  const response = await page.request.get(`${mockHttpOrigin}/api/threads?workspaceId=${encodeURIComponent(workspaceId)}`);
  expect(response.ok()).toBe(true);
  const body = await response.json() as { threads: Array<{ id: string; title: string; engine: string }> };
  return body.threads;
}

async function readAutoCreateMarker(page: Page): Promise<boolean> {
  return await page.evaluate((prefix) => (
    Object.keys(window.localStorage).some((key) => key.startsWith(prefix) && window.localStorage.getItem(key) === "1")
  ), markerPrefix);
}

/** 触发回前台重评估，验证"未就绪不消耗、就绪后仍能自动完成"。 */
async function revisitPage(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

test.describe("没有会话的工作区自动创建默认会话", () => {
  // mock server 进程在整轮用例间复用，必须逐例重置线程与 Key 列表，避免用例互相污染。
  test.beforeEach(async ({ page }) => {
    const response = await page.request.post(`${mockHttpOrigin}/api/test/reset`);
    expect(response.ok()).toBe(true);
  });

  test("DT-01 没有启用中 Key 时不创建也不消耗机会", async ({ page }) => {
    const harness = await openApp(page);

    // 已评估并拉取过 Key 列表，但没有启用中 Key：不创建、不写标记。
    await expect.poll(() => harness.keyListRequests).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    // 等待态必须静止：评估链路自己的刷新不得再触发下一轮评估，否则会变成无休止的请求循环。
    const settledKeyListRequests = harness.keyListRequests;
    const settledThreadListRequests = harness.threadListRequests;
    await page.waitForTimeout(2_000);
    expect(harness.keyListRequests).toBe(settledKeyListRequests);
    expect(harness.threadListRequests).toBe(settledThreadListRequests);
    expect(harness.createBodies).toHaveLength(0);
    expect(await readAutoCreateMarker(page)).toBe(false);
    expect(await readMockThreads(page)).toHaveLength(0);
  });

  test("DT-02 有启用中 Codex Key 时创建一次默认会话并自动打开", async ({ page }) => {
    await presetEngineKeys(page, [{ engine: "codex", providerId: "openai", isActive: true }]);
    const harness = await openApp(page);

    await expect.poll(() => harness.createBodies.length).toBe(1);
    expect(harness.createBodies[0]?.title).toBe(defaultThreadTitle);
    expect(harness.createBodies[0]?.engine).toBe("codex");
    expect(harness.createBodies[0]?.workspaceId).toBe(workspaceId);
    expect(await readAutoCreateMarker(page)).toBe(true);

    const created = await readMockThreads(page);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: defaultThreadTitle, engine: "codex" });
    // 自动选中并打开：地址栏带上本次创建的会话，且会话内容区可见。
    await expect(page).toHaveURL(new RegExp(`threadId=${created[0]?.id}`, "u"));
    await expect(page.locator(".composer__textarea")).toBeVisible();
  });

  test("DT-03 已有会话时不再创建但仍然消耗机会", async ({ page }) => {
    await presetEngineKeys(page, [{ engine: "codex", providerId: "openai", isActive: true }]);
    const preset = await page.request.post(`${mockHttpOrigin}/api/threads/create`, {
      data: { workspaceId, engine: "codex", title: "已有会话" },
    });
    expect(preset.ok()).toBe(true);

    const harness = await openApp(page);
    await expect.poll(() => harness.threadListRequests).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);

    expect(harness.createBodies).toHaveLength(0);
    expect(await readAutoCreateMarker(page)).toBe(true);
    expect((await readMockThreads(page)).map((thread) => thread.title)).toEqual(["已有会话"]);
  });

  test("DT-04 创建后删除会话再刷新不会再次自动创建", async ({ page }) => {
    await presetEngineKeys(page, [{ engine: "codex", providerId: "openai", isActive: true }]);
    const harness = await openApp(page);
    await expect.poll(() => harness.createBodies.length).toBe(1);

    const [created] = await readMockThreads(page);
    const deleted = await page.request.post(`${mockHttpOrigin}/api/threads/delete`, {
      data: { workspaceId, threadId: created?.id },
    });
    expect(deleted.ok()).toBe(true);
    expect(await readMockThreads(page)).toHaveLength(0);

    await revisitPage(page);
    await page.reload();
    await expect(page.locator(".thread-list")).toBeVisible();
    await page.waitForTimeout(1_500);

    expect(harness.createBodies).toHaveLength(1);
    expect(await readAutoCreateMarker(page)).toBe(true);
  });

  test("DT-05 只有启用中 Claude Key 时回落到 Claude", async ({ page }) => {
    await presetEngineKeys(page, [{ engine: "claude", providerId: "anthropic", isActive: true }]);
    const harness = await openApp(page);

    await expect.poll(() => harness.createBodies.length).toBe(1);
    expect(harness.createBodies[0]?.engine).toBe("claude");
    expect((await readMockThreads(page))[0]).toMatchObject({ title: defaultThreadTitle, engine: "claude" });
  });

  test("DT-06 未就绪时不消耗机会，启用 Key 后仍会自动创建", async ({ page }) => {
    await presetEngineKeys(page, [{ engine: "codex", providerId: "openai", isActive: false }]);
    const harness = await openApp(page);

    await expect.poll(() => harness.keyListRequests).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    expect(harness.createBodies).toHaveLength(0);
    expect(await readAutoCreateMarker(page)).toBe(false);

    const keysBody = await (await page.request.get(`${mockHttpOrigin}/api/engine-keys?workspaceId=${encodeURIComponent(workspaceId)}`))
      .json() as { keys: Array<{ id: string }> };
    const activated = await page.request.post(`${mockHttpOrigin}/api/engine-keys/activate?workspaceId=${encodeURIComponent(workspaceId)}`, {
      data: { id: keysBody.keys[0]?.id },
    });
    expect(activated.ok()).toBe(true);
    await revisitPage(page);

    await expect.poll(() => harness.createBodies.length).toBe(1);
    expect(harness.createBodies[0]?.engine).toBe("codex");
    expect(await readAutoCreateMarker(page)).toBe(true);
  });

  test("DT-07 页面停留不动时，Client 侧写入 Key 的广播即唤醒默认会话", async ({ page }) => {
    // 复刻客户现场：页面先开着、Key 后到。这里刻意不调用 revisitPage，也不刷新页面，
    // 只下发真实 Server 会转发的 engineKeys.changed，验证「广播 → 刷新 → 唤醒 → 建会话」这一跳。
    await presetEngineKeys(page, [{ engine: "codex", providerId: "openai", isActive: false }]);
    const harness = await openApp(page);

    await expect.poll(() => harness.keyListRequests).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    expect(harness.createBodies).toHaveLength(0);
    expect(await readAutoCreateMarker(page)).toBe(false);

    const keysBody = await (await page.request.get(`${mockHttpOrigin}/api/engine-keys?workspaceId=${encodeURIComponent(workspaceId)}`))
      .json() as { keys: Array<{ id: string }> };
    const activated = await page.request.post(`${mockHttpOrigin}/api/engine-keys/activate?workspaceId=${encodeURIComponent(workspaceId)}`, {
      data: { id: keysBody.keys[0]?.id },
    });
    expect(activated.ok()).toBe(true);

    const keyListRequestsBeforeBroadcast = harness.keyListRequests;
    const broadcast = await page.request.post(`${mockHttpOrigin}/api/test/engine-keys-changed`);
    expect(broadcast.ok()).toBe(true);

    // 硬化：唤醒必须由广播引起的刷新带出来。否则将来 mock 中转若被打开，
    // 内置中转链路可能顺带刷新并建出会话，让本用例在广播被改坏时仍然变绿。
    await expect.poll(() => harness.keyListRequests).toBeGreaterThan(keyListRequestsBeforeBroadcast);
    await expect.poll(() => harness.createBodies.length).toBe(1);
    expect(harness.createBodies[0]?.engine).toBe("codex");
    expect(await readMockThreads(page)).toHaveLength(1);
    expect(await readAutoCreateMarker(page)).toBe(true);
  });
});
