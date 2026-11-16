import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import {
  calculateRelayRechargePricingQuote,
  DEFAULT_RELAY_RECHARGE_PRICING_TIERS,
  formatRelayRechargeDiscountLabel,
  type CreateRelayBalancePackBusinessOrderRequestBody,
  type PaymentOrderDetailView,
  type RelayBalancePackBusinessOrderView,
  type RelayModelPriceView,
  type RelayRechargePricingPublicView,
} from "@codeflowai/shared";

const mockWsOrigin = "ws://127.0.0.1:39290";
const now = Date.UTC(2026, 7, 26, 9, 30);

type PricingE2eState = {
  config: RelayRechargePricingPublicView;
  createMode: "success" | "stale-once";
  createRequests: CreateRelayBalancePackBusinessOrderRequestBody[];
  modelMode: "success" | "failure";
  pricingUnavailable: boolean;
  activeOrder: RelayBalancePackBusinessOrderView | null;
  cancelRequests: number;
  refreshDelayMs: number;
  refreshRequests: number;
};

/** 构造每条 E2E 用例独立的充值定价状态。 */
function createState(): PricingE2eState {
  return {
    config: {
      version: 1,
      discountEnabled: true,
      activityEnabled: true,
      activityText: "818活动特价",
      basePresetAmountFen: 1_000,
      tiers: DEFAULT_RELAY_RECHARGE_PRICING_TIERS.map((tier) => ({
        ...tier,
        discountLabel: formatRelayRechargeDiscountLabel(tier.payPercent),
      })),
    },
    createMode: "success",
    createRequests: [],
    modelMode: "success",
    pricingUnavailable: false,
    activeOrder: null,
    cancelRequests: 0,
    refreshDelayMs: 0,
    refreshRequests: 0,
  };
}

/** 构造通用版超级管理员账号摘要。 */
function createAccountSummary() {
  return {
    ok: true,
    userId: "super-admin-e2e",
    email: "admin@example.test",
    fullName: "平台管理员",
    phone: "",
    avatarUrl: null,
    accountRole: "super_admin",
    status: "active",
    accessContext: {
      identityType: "SUPER_ADMIN",
      editionType: "COMMUNITY",
      editionStatus: "ACTIVE",
      effectiveAccessScope: "SUPER_ADMIN",
      enterpriseId: null,
      enterpriseName: null,
    },
    enterpriseSummary: null,
    enterpriseMemberPackageSummary: null,
    pendingEnterpriseInvitations: [],
    packageSummary: {
      purchasedPersonMonths: 0,
      allocatedPersonMonths: 0,
      availablePersonMonths: 0,
      expiresAt: 0,
      isEnterprise: false,
      scopeType: "NONE",
      status: "NONE",
    },
    keySummary: null,
    securitySummary: {
      lastPasswordChangedAt: now,
      failedAttempts: 0,
      lockedUntil: 0,
      forceReset: false,
    },
  };
}

/** 构造 Sol/Terra 两条稳定模型价格。 */
function createModelPrices(): RelayModelPriceView[] {
  const base = {
    providerId: "openai" as const,
    currency: "CNY" as const,
    supplier: "可编辑供应商文案",
    modelVendor: "OpenAI",
    multimodal: true,
    remark: "",
    updatedAt: now,
    configuredBy: { userId: "super-admin-e2e", email: "admin@example.test" },
  };
  return [
    { ...base, id: "price-sol", modelVersion: "GPT5.6-Sol", sortOrder: 1, inputCachedPriceMilliYuanPerMillionTokens: 150, inputUncachedPriceMilliYuanPerMillionTokens: 1_500, outputPriceMilliYuanPerMillionTokens: 9_000 },
    { ...base, id: "price-terra", modelVersion: "GPT5.6-Terra", sortOrder: 2, inputCachedPriceMilliYuanPerMillionTokens: 75, inputUncachedPriceMilliYuanPerMillionTokens: 750, outputPriceMilliYuanPerMillionTokens: 4_500 },
  ];
}

/** 生成订单快照，充值面额与支付实付保持独立。 */
function createOrder(
  businessOrderId: string,
  balanceAmountFen: number,
  pricing: RelayRechargePricingPublicView,
): RelayBalancePackBusinessOrderView {
  const quote = calculateRelayRechargePricingQuote(balanceAmountFen, pricing.tiers, pricing.discountEnabled);
  const paymentOrderId = `payment-${businessOrderId}`;
  return {
    businessOrderId,
    planCode: "RELAY_BALANCE_PACK",
    skuCode: "RELAY_BALANCE_PACK_CUSTOM",
    scopeType: "USER",
    saleUnitKeySnapshot: "RELAY_BALANCE_PACK_CUSTOM",
    planVersionIdSnapshot: null,
    planVersionItemIdSnapshot: null,
    billingMode: "USAGE_PACK",
    orderType: "TOP_UP",
    orderStatus: "CREATED",
    fulfillmentStatus: "PENDING",
    entrySource: "ACCOUNT_DRAWER",
    amountFen: quote.paidAmountFen,
    originalPriceFen: quote.balanceAmountFen,
    discountType: quote.discountType,
    discountValue: quote.discountValue,
    discountLabel: quote.discountLabel || "无折扣",
    currency: "CNY",
    billingCycle: "NONE",
    durationMonths: 0,
    title: "Token充值",
    description: "个人 Token 充值",
    paymentFinalSource: null,
    currentPaymentOrderId: paymentOrderId,
    paidAt: null,
    fulfilledAt: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
    lastFulfillErrorCode: null,
    lastFulfillErrorMessage: null,
    paymentOrder: {
      orderId: paymentOrderId,
      outTradeNo: `out-${businessOrderId}`,
      productCode: "RELAY_BALANCE_PACK",
      status: "QR_READY",
      amountFen: quote.paidAmountFen,
      currency: "CNY",
      finalSource: null,
      qrExpiresAt: Date.now() + 3_600_000,
      finalizedAt: null,
      createdAt: now,
      updatedAt: now,
      title: "Token充值",
      description: "个人 Token 充值",
      orderScene: "RELAY_BALANCE_PACK_TOP_UP",
      bizRefType: "BUSINESS_ORDER",
      bizRefId: businessOrderId,
      codeUrl: `https://pay.example.test/${businessOrderId}`,
      closeReason: null,
      wechatTransactionIdMasked: null,
      verifyAttemptCount: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
      latestCallback: null,
      latestQueryCheck: null,
      evidence: null,
      statusLogs: [],
    } as PaymentOrderDetailView,
    entitlement: null,
    balanceAmountFen: quote.balanceAmountFen,
    paidAmountFen: quote.paidAmountFen,
    rechargePricingVersion: pricing.version,
    discountThresholdAmountFen: quote.discountThresholdAmountFen,
    displayCurrency: "CNY",
    exchangeRateSnapshot: 1,
    grantedQuotaUsd: quote.balanceAmountFen / 100,
    quotaUnit: "USD",
    targetQuotaUsd: null,
    targetEnterpriseId: null,
    relayQuotaItem: null,
  } as RelayBalancePackBusinessOrderView;
}

/** 返回阶段 6 页面依赖的有状态 API。 */
async function fulfillPricingApi(route: Route, state: PricingE2eState): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const json = (status: number, body: unknown) => route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });

  if (url.pathname === "/api/account/me/summary" && request.method() === "GET") {
    await json(200, createAccountSummary());
    return;
  }
  if (url.pathname === "/api/account/me/relay/balances" && request.method() === "GET") {
    await json(200, {
      ok: true,
      personal: { availableUsdUnits: "2500000000", frozenUsdUnits: "0", consumedUsdUnits: "0", status: "ACTIVE", version: "1", updatedAt: now },
      enterprise: null,
    });
    return;
  }
  if (url.pathname === "/api/account/me/relay/usage" && request.method() === "GET") {
    await json(200, { ok: true, item: null, status: { enabled: true, state: "enabled", missingConfigKeys: [] } });
    return;
  }
  if (url.pathname === "/api/account/me/relay/usage/sync" && request.method() === "POST") {
    await json(200, { ok: true, item: null });
    return;
  }
  if (url.pathname === "/api/account/me/relay/key" && request.method() === "GET") {
    await json(200, { ok: true, status: { state: "disabled", publicBaseUrl: "", providerGroupsConfigured: {} } });
    return;
  }
  if (url.pathname === "/api/account/relay/pricing/current" && request.method() === "GET") {
    if (state.modelMode === "failure") {
      await json(503, { ok: false, code: "RELAY_PRICING_UNAVAILABLE", message: "模型价格暂不可用" });
    } else {
      await json(200, { ok: true, rows: createModelPrices(), serverNow: now, emptyReason: null });
    }
    return;
  }
  if (url.pathname === "/api/account/me/relay-balance-package/checkout-context" && request.method() === "GET") {
    await json(200, {
      ok: true,
      planCode: "RELAY_BALANCE_PACK",
      plans: [],
      defaultSkuCode: null,
      selectedSkuCode: null,
      activeOrder: state.activeOrder,
      paymentEnabled: true,
      disabledReason: null,
      rechargePricing: state.pricingUnavailable ? null : {
        version: state.config.version,
        discountEnabled: state.config.discountEnabled,
        activityEnabled: state.config.activityEnabled,
        activityText: state.config.activityText,
        basePresetAmountFen: state.config.basePresetAmountFen,
        tiers: state.config.tiers,
      },
      rechargePricingErrorCode: state.pricingUnavailable ? "RELAY_RECHARGE_PRICING_UNAVAILABLE" : null,
      accessContext: createAccountSummary().accessContext,
    });
    return;
  }
  if (url.pathname === "/api/account/me/relay-balance-package/orders" && request.method() === "POST") {
    const body = request.postDataJSON() as CreateRelayBalancePackBusinessOrderRequestBody;
    state.createRequests.push(body);
    if (state.createMode === "stale-once" && state.createRequests.length === 1) {
      const nextTiers = state.config.tiers.map((tier, index) => index === 2
        ? { ...tier, payPercent: 91, discountLabel: "91折" }
        : tier);
      state.config = { ...state.config, version: state.config.version + 1, tiers: nextTiers };
      await json(409, { ok: false, code: "RELAY_RECHARGE_PRICING_CHANGED", message: "充值优惠已更新，请确认后重新支付" });
      return;
    }
    state.activeOrder = createOrder(`order-${state.createRequests.length}`, Number(body.amountFen), state.config);
    await json(200, { ok: true, reused: false, order: state.activeOrder, pollIntervalMs: 300_000 });
    return;
  }
  const cancelMatch = /^\/api\/account\/me\/relay-balance-package\/orders\/([^/]+)\/cancel$/u.exec(url.pathname);
  if (cancelMatch && request.method() === "POST" && state.activeOrder) {
    state.cancelRequests += 1;
    state.activeOrder = {
      ...state.activeOrder,
      orderStatus: "CANCELLED",
      closedAt: now + 1_000,
      paymentOrder: state.activeOrder.paymentOrder ? {
        ...state.activeOrder.paymentOrder,
        status: "CLOSED",
        codeUrl: null,
        closeReason: "USER_CANCELLED",
      } : null,
    };
    await json(200, { ok: true, order: state.activeOrder, closeAccepted: true });
    return;
  }
  const refreshMatch = /^\/api\/account\/me\/relay-balance-package\/orders\/([^/]+)\/refresh$/u.exec(url.pathname);
  if (refreshMatch && request.method() === "POST" && state.activeOrder) {
    state.refreshRequests += 1;
    if (state.refreshDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.refreshDelayMs));
    await json(200, { ok: true, order: state.activeOrder, nextVerifyAt: null, retriedFulfillment: false });
    return;
  }
  await route.fallback();
}

/** 写入 E2E 账号会话并打开指定页面。 */
async function openWithSession(page: Page, state: PricingE2eState, path: string): Promise<void> {
  await page.route("**/api/**", (route) => fulfillPricingApi(route, state));
  await page.goto("/");
  await page.evaluate(({ serverWsOrigin, expiresAt }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin,
      authMode: "account",
      accountRole: "super_admin",
      sessionToken: "relay-pricing-e2e-session",
      sessionExpiresAt: expiresAt,
      homePath: "/",
      accessContext: {
        identityType: "SUPER_ADMIN",
        editionType: "COMMUNITY",
        editionStatus: "ACTIVE",
        effectiveAccessScope: "SUPER_ADMIN",
        enterpriseId: null,
        enterpriseName: null,
      },
      userSummary: {
        userId: "super-admin-e2e",
        email: "admin@example.test",
        fullName: "平台管理员",
        phone: "",
        avatarUrl: null,
        accountRole: "super_admin",
        status: "active",
        enterpriseId: null,
        enterpriseName: null,
      },
    }));
  }, { serverWsOrigin: mockWsOrigin, expiresAt: Date.now() + 3_600_000 });
  await page.goto(path);
}

/** 沿桌面账号中心或移动流量统计的可见入口打开充值弹框。 */
async function openRechargeDialog(page: Page, state: PricingE2eState): Promise<Locator> {
  await openWithSession(page, state, "/admin?panel=settings");
  const mobileAccount = page.getByRole("button", { name: "打开个人信息", exact: true });
  const desktopAccount = page.getByRole("button", { name: /平台管理员/u });
  await expect(mobileAccount.or(desktopAccount).first()).toBeVisible();
  if (await mobileAccount.isVisible()) {
    await mobileAccount.click();
    await page.getByRole("button", { name: /^流量统计/u }).click();
  } else {
    await desktopAccount.click();
    await page.getByRole("menuitem", { name: /个人信息/u }).click();
  }
  const purchaseSurface = page.locator(".account-drawer-host, .relay-self-usage");
  await expect(purchaseSurface).toBeVisible();
  await purchaseSurface.getByRole("button", { name: /充值/u }).first().click();
  const dialog = page.getByRole("dialog", { name: "Token充值" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("个人 Token 折扣充值", () => {
  test("268 元试算、活动文案、双模型价格和版本变化人工重确认", async ({ page }) => {
    const state = createState();
    state.createMode = "stale-once";
    const dialog = await openRechargeDialog(page, state);

    await expect(dialog.getByText("请输入充值金额", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "10元" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "1000元 88折" })).toBeVisible();
    await expect(dialog.getByText("818活动特价", { exact: true })).toBeVisible();
    const amountInput = dialog.getByPlaceholder("请输入充值金额");
    const inputBoxBeforeDiscount = await amountInput.evaluate(async (element) => {
      let previousY = Number.NaN;
      let stableFrames = 0;
      while (stableFrames < 3) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const currentY = element.getBoundingClientRect().y;
        stableFrames = Number.isFinite(previousY) && Math.abs(currentY - previousY) < 0.01 ? stableFrames + 1 : 0;
        previousY = currentY;
      }
      const rect = element.getBoundingClientRect();
      return { y: rect.y, height: rect.height };
    });
    await amountInput.fill("268");
    await expect(dialog.getByText("已享92折，本次节省 ￥21.44", { exact: true })).toBeVisible();
    const inputBoxAfterDiscount = await amountInput.boundingBox();
    expect(inputBoxAfterDiscount).not.toBeNull();
    expect(inputBoxAfterDiscount?.y).toBe(inputBoxBeforeDiscount.y);
    const presetGroupBox = await dialog.locator(".relay-token-pack__preset-group").boundingBox();
    expect(presetGroupBox).not.toBeNull();
    expect(presetGroupBox!.y - (inputBoxAfterDiscount!.y + inputBoxAfterDiscount!.height)).toBeLessThanOrEqual(24);
    const payButton = dialog.getByRole("button", { name: "立即支付 ￥246.56" });
    await expect(payButton).toBeEnabled();
    const [amountCardBox, priceCardBox, payButtonBox] = await Promise.all([
      dialog.locator(".relay-token-pack__amount-card").boundingBox(),
      dialog.locator(".relay-token-pack__price-card").boundingBox(),
      payButton.boundingBox(),
    ]);
    expect(amountCardBox).not.toBeNull();
    expect(priceCardBox).not.toBeNull();
    expect(payButtonBox).not.toBeNull();
    const payButtonGap = payButtonBox!.y - (presetGroupBox!.y + presetGroupBox!.height);
    expect(payButtonGap).toBeGreaterThanOrEqual(18);
    expect(payButtonGap).toBeLessThanOrEqual(24);
    expect(amountCardBox!.y + amountCardBox!.height - (payButtonBox!.y + payButtonBox!.height)).toBeLessThanOrEqual(20);
    expect(Math.abs(amountCardBox!.y + amountCardBox!.height - priceCardBox!.y - priceCardBox!.height)).toBeLessThanOrEqual(1);
    await expect(dialog.getByText("GPT5.6-Sol", { exact: true })).toBeVisible();
    await expect(dialog.getByText("GPT5.6-Terra", { exact: true })).toBeVisible();
    await expect(dialog.getByText("4.5元", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "立即支付 ￥246.56" }).click();
    await expect.poll(() => state.createRequests.length).toBe(1);
    await expect(dialog.getByText("已享91折，本次节省 ￥24.12", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "立即支付 ￥243.88" })).toBeEnabled();
    expect(state.createRequests[0]?.rechargePricingVersion).toBe(1);

    await dialog.getByRole("button", { name: "立即支付 ￥243.88" }).click();
    await expect.poll(() => state.createRequests.length).toBe(2);
    expect(state.createRequests[1]).toMatchObject({ amountFen: 26_800, rechargePricingVersion: 2, targetScope: "USER" });
    await expect(dialog.getByText("微信扫码支付", { exact: true })).toBeVisible();
    await expect(dialog.getByText("应付金额", { exact: true })).toBeVisible();
    await expect(dialog.getByText("到账 ￥268.00，已节省 ￥24.12", { exact: true })).toBeVisible();
    await expect(dialog.getByText("订单信息", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("本次订单已锁定", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("模型价格", { exact: true })).toHaveCount(0);
  });

  test("关闭优惠后无折扣标签、无活动文案且按原价支付", async ({ page }) => {
    const state = createState();
    state.config.discountEnabled = false;
    const dialog = await openRechargeDialog(page, state);

    await expect(dialog.getByRole("button", { name: "1000元 88折" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "1000元" })).toBeVisible();
    await expect(dialog.getByText("818活动特价", { exact: true })).toHaveCount(0);

    await dialog.getByPlaceholder("请输入充值金额").fill("268");
    await expect(dialog.getByText(/本次节省/u)).toHaveCount(0);
    await dialog.getByRole("button", { name: "立即支付 ￥268.00" }).click();
    await expect.poll(() => state.createRequests.length).toBe(1);
    expect(state.createRequests[0]).toMatchObject({ amountFen: 26_800, rechargePricingVersion: 1, targetScope: "USER" });

    await expect(dialog.getByText("应付金额", { exact: true })).toBeVisible();
    await expect(dialog.getByText("到账 ￥268.00", { exact: false })).toBeVisible();
    await expect(dialog.getByText(/已节省/u)).toHaveCount(0);
  });

  test("模型价格加载失败不误报未配置且不阻断支付", async ({ page }) => {
    const state = createState();
    state.modelMode = "failure";
    state.config.activityEnabled = false;
    const dialog = await openRechargeDialog(page, state);

    await dialog.getByPlaceholder("请输入充值金额").fill("50");
    await expect(dialog.getByText("模型价格暂不可用", { exact: true })).toBeVisible();
    await expect(dialog.getByText("未配置", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("818活动特价", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "立即支付 ￥49.00" })).toBeEnabled();

    state.modelMode = "success";
    await dialog.getByRole("button", { name: "重试", exact: true }).click();
    await expect(dialog.getByText("0.075元", { exact: true })).toBeVisible();
  });

  test("当前配置故障不阻断已有订单，取消后明确禁止新建", async ({ page }) => {
    const state = createState();
    state.pricingUnavailable = true;
    state.activeOrder = createOrder("existing-order", 20_000, state.config);
    const dialog = await openRechargeDialog(page, state);

    await expect(dialog.getByText("微信扫码支付", { exact: true })).toBeVisible();
    await expect(dialog.getByText("到账 ￥200.00，已节省 ￥16.00", { exact: true })).toBeVisible();
    await expect(dialog.getByText("订单信息", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("模型价格", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("img", { name: "微信支付二维码" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "刷新状态" })).toBeEnabled();
    await dialog.getByRole("button", { name: "刷新状态" }).click();
    await expect.poll(() => state.refreshRequests).toBe(1);
    await dialog.getByRole("button", { name: "取消订单" }).click();
    await page.locator(".ant-popover").getByRole("button", { name: "取消订单" }).click();
    await expect.poll(() => state.cancelRequests).toBe(1);
    await expect(dialog.getByText("Token 充值价格暂不可用，请重试")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "立即支付" })).toBeDisabled();
  });

  test("付款倒计时稳定展示且后台轮询不锁定操作按钮", async ({ page }) => {
    const state = createState();
    state.activeOrder = createOrder("polling-order", 20_000, state.config);
    state.refreshDelayMs = 2_000;
    const dialog = await openRechargeDialog(page, state);

    await expect(dialog.getByText(/二维码 \d{2}:\d{2} 后失效/u)).toBeVisible();
    await expect(dialog.getByText("付款后页面会自动刷新状态", { exact: false })).toHaveCount(0);
    await expect.poll(() => state.refreshRequests, { timeout: 7_000 }).toBe(1);
    await expect(dialog.getByRole("button", { name: "刷新状态" })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "取消订单" })).toBeEnabled();
    await expect(dialog.locator(".ant-btn-loading")).toHaveCount(0);
  });
});

for (const viewport of [
  { width: 360, height: 640 },
  { width: 768, height: 720 },
  { width: 1200, height: 800 },
]) {
  test(`充值弹框在 ${viewport.width}x${viewport.height} 下无横向溢出且小屏内部滚动`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const state = createState();
    const dialog = await openRechargeDialog(page, state);
    await dialog.getByPlaceholder("请输入充值金额").fill("268");
    await expect(dialog.getByRole("button", { name: "立即支付 ￥246.56" })).toBeVisible();

    const layout = await dialog.evaluate((element) => {
      const body = element.querySelector<HTMLElement>(".ant-modal-body");
      const rect = element.querySelector<HTMLElement>(".ant-modal")?.getBoundingClientRect();
      return {
        bodyOverflow: body ? body.scrollWidth - body.clientWidth : Number.POSITIVE_INFINITY,
        bodyScrollable: body ? body.scrollHeight > body.clientHeight + 1 : false,
        left: rect?.left ?? -1,
        right: rect?.right ?? Number.POSITIVE_INFINITY,
      };
    });
    expect(layout.bodyOverflow).toBeLessThanOrEqual(1);
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(viewport.width);
    if (viewport.width === 360) expect(layout.bodyScrollable).toBe(true);
    await testInfo.attach(`token-recharge-${viewport.width}x${viewport.height}`, {
      body: await dialog.screenshot(),
      contentType: "image/png",
    });

    await dialog.getByRole("button", { name: "立即支付 ￥246.56" }).click();
    await expect(dialog.getByRole("img", { name: "微信支付二维码" })).toBeVisible();
    await expect(dialog.getByText("模型价格", { exact: true })).toHaveCount(0);
    const paymentLayout = await dialog.evaluate((element) => {
      const body = element.querySelector<HTMLElement>(".ant-modal-body");
      const rect = element.querySelector<HTMLElement>(".ant-modal")?.getBoundingClientRect();
      return {
        bodyOverflow: body ? body.scrollWidth - body.clientWidth : Number.POSITIVE_INFINITY,
        left: rect?.left ?? -1,
        right: rect?.right ?? Number.POSITIVE_INFINITY,
      };
    });
    expect(paymentLayout.bodyOverflow).toBeLessThanOrEqual(1);
    expect(paymentLayout.left).toBeGreaterThanOrEqual(0);
    expect(paymentLayout.right).toBeLessThanOrEqual(viewport.width);
    await testInfo.attach(`token-payment-${viewport.width}x${viewport.height}`, {
      body: await dialog.screenshot(),
      contentType: "image/png",
    });
  });
}
