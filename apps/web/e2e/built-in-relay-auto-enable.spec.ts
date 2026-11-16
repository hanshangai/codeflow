import { expect, test, type Page } from "@playwright/test";

const mockHttpOrigin = "http://127.0.0.1:39290";
const mockWsOrigin = "ws://127.0.0.1:39290";
const workspaceId = "workspace_chat_core_e2e";
const userFullName = "中转自动启用测试";
const relayPublicBaseUrl = "https://relay.e2e.test";
const relayMarkerPrefix = "codeflowai.relay.auto-enable::";

type RelayHarness = {
  relayProbeRequests: number;
  ensureRequests: number;
  upserts: Array<Record<string, unknown>>;
  activations: Array<Record<string, unknown>>;
  engineKeyWorkspaceIds: string[];
};

/** 记录自动启用链路上的关键请求，用于断言"只尝试一次"以及写入落在目标工作区。 */
function installRequestRecorder(page: Page): RelayHarness {
  const harness: RelayHarness = {
    relayProbeRequests: 0,
    ensureRequests: 0,
    upserts: [],
    activations: [],
    engineKeyWorkspaceIds: [],
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/engine-keys")) {
      harness.engineKeyWorkspaceIds.push(String(url.searchParams.get("workspaceId") ?? ""));
    }
    if (url.pathname === "/api/account/me/relay/key" && request.method() === "GET") harness.relayProbeRequests += 1;
    if (url.pathname === "/api/account/me/relay/key/ensure" && request.method() === "POST") harness.ensureRequests += 1;
    if (url.pathname === "/api/engine-keys" && request.method() === "POST") harness.upserts.push(request.postDataJSON() as Record<string, unknown>);
    if (url.pathname === "/api/engine-keys/activate" && request.method() === "POST") harness.activations.push(request.postDataJSON() as Record<string, unknown>);
  });
  return harness;
}

/** 打进账号会话与目标工作区，应用连上 mock server 后即满足自动启用前置条件。 */
async function openApp(page: Page): Promise<RelayHarness> {
  const harness = installRequestRecorder(page);
  await page.addInitScript(({ config }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify(config));
    window.localStorage.setItem("ui", JSON.stringify({ themeMode: "light" }));
  }, {
    config: {
      serverWsOrigin: mockWsOrigin,
      authMode: "account",
      accountRole: "user",
      sessionToken: "e2e-auto-relay-session",
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
        userId: "member-auto-relay",
        email: "auto-relay@example.test",
        fullName: userFullName,
        phone: "",
        avatarUrl: null,
        accountRole: "user",
        status: "active",
        enterpriseId: "enterprise-1",
        enterpriseName: "Design Co",
      },
    },
  });
  await page.goto("/chat");
  return harness;
}

async function setRelayState(page: Page, input: {
  state: "enabled" | "disabled";
  publicBaseUrl?: string;
  providerGroupsConfigured?: Record<string, boolean>;
  ensureFailureCode?: string;
}): Promise<void> {
  const response = await page.request.post(`${mockHttpOrigin}/api/test/relay-key-state`, { data: input });
  expect(response.ok()).toBe(true);
}

async function readAutoEnableMarker(page: Page): Promise<boolean> {
  return await page.evaluate((prefix) => (
    Object.keys(window.localStorage).some((key) => key.startsWith(prefix) && window.localStorage.getItem(key) === "1")
  ), relayMarkerPrefix);
}

async function readEngineKeys(page: Page): Promise<Array<{ id: string; label: string; baseUrl: string | null; isActive: boolean }>> {
  const response = await page.request.get(`${mockHttpOrigin}/api/engine-keys?workspaceId=${encodeURIComponent(workspaceId)}`);
  expect(response.ok()).toBe(true);
  const body = await response.json() as { keys: Array<{ id: string; label: string; baseUrl: string | null; isActive: boolean }> };
  return body.keys;
}

/** 触发回前台重评估，验证"未就绪不消耗、就绪后仍能自动完成"。 */
async function revisitPage(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

test.describe("首次安装后自动启用内置中转 Key", () => {
  // mock server 进程在整轮用例间复用，必须逐例重置内置中转与 Key 列表，避免用例互相污染。
  test.beforeEach(async ({ page }) => {
    const response = await page.request.post(`${mockHttpOrigin}/api/test/reset`);
    expect(response.ok()).toBe(true);
  });

  test("内置中转就绪时自动启用一次 Codex Key 且不额外切换", async ({ page }) => {
    await setRelayState(page, {
      state: "enabled",
      publicBaseUrl: relayPublicBaseUrl,
      providerGroupsConfigured: { openai: true },
    });
    const harness = await openApp(page);

    await expect.poll(() => harness.upserts.length).toBe(1);
    expect(harness.upserts[0]?.label).toBe("CodeFlow 内置中转（Codex）");
    expect(harness.upserts[0]?.engine).toBe("codex");
    expect(harness.upserts[0]?.providerId).toBe("openai");
    expect(String(harness.upserts[0]?.baseUrl)).toBe(`${relayPublicBaseUrl}/v1`);
    // Client 侧首个 Key 自动激活，不需要额外的 activate 调用。
    expect(harness.activations).toHaveLength(0);
    // 所有引擎 Key 请求都必须落在当前工作区，避免写错作用域。
    expect(harness.engineKeyWorkspaceIds.length).toBeGreaterThan(0);
    expect([...new Set(harness.engineKeyWorkspaceIds)]).toEqual([workspaceId]);
    expect(await readAutoEnableMarker(page)).toBe(true);
    expect((await readEngineKeys(page))[0]).toMatchObject({ label: "CodeFlow 内置中转（Codex）", isActive: true });
  });

  test("内置中转未就绪时不消耗机会，就绪后仍可自动完成", async ({ page }) => {
    const harness = await openApp(page);

    // 已评估并探测过内置中转，但中转未启用：不消耗机会，也不发起任何 Key 写请求。
    // 说明：Key 列表 GET 不再作为本用例的判据——「默认会话」自动创建是独立功能，
    // 它会在工作区就绪后读取 Key 列表，与内置中转是否就绪无关。
    await expect.poll(() => harness.relayProbeRequests).toBeGreaterThan(0);
    expect(await readAutoEnableMarker(page)).toBe(false);
    expect(harness.ensureRequests).toBe(0);
    expect(harness.upserts).toHaveLength(0);

    await setRelayState(page, {
      state: "enabled",
      publicBaseUrl: relayPublicBaseUrl,
      providerGroupsConfigured: { openai: true },
    });
    await revisitPage(page);

    await expect.poll(() => harness.upserts.length).toBe(1);
    expect(harness.ensureRequests).toBe(1);
    expect(await readAutoEnableMarker(page)).toBe(true);
  });

  test("自动启用失败时记录结果且不再重试", async ({ page }) => {
    await setRelayState(page, {
      state: "enabled",
      publicBaseUrl: relayPublicBaseUrl,
      providerGroupsConfigured: { openai: true },
      ensureFailureCode: "INTERNAL_ERROR",
    });
    const harness = await openApp(page);

    await expect.poll(() => harness.ensureRequests).toBe(1);
    expect(await readAutoEnableMarker(page)).toBe(true);
    expect(harness.upserts).toHaveLength(0);

    await revisitPage(page);
    await expect.poll(() => harness.ensureRequests).toBe(1);
    await expect.poll(() => harness.upserts.length).toBe(0);
  });

  test("用户手动停用后不再自动启用", async ({ page }) => {
    await setRelayState(page, {
      state: "enabled",
      publicBaseUrl: relayPublicBaseUrl,
      providerGroupsConfigured: { openai: true },
    });
    const harness = await openApp(page);
    await expect.poll(() => harness.upserts.length).toBe(1);

    const created = (await readEngineKeys(page))[0];
    expect(created?.isActive).toBe(true);
    const deactivated = await page.request.post(
      `${mockHttpOrigin}/api/engine-keys/deactivate?workspaceId=${encodeURIComponent(workspaceId)}`,
      { data: { id: created?.id } },
    );
    expect(deactivated.ok()).toBe(true);
    expect((await readEngineKeys(page))[0]?.isActive).toBe(false);

    await revisitPage(page);
    await expect.poll(() => harness.upserts.length).toBe(1);
    expect((await readEngineKeys(page))[0]?.isActive).toBe(false);
  });
});
