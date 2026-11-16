import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import {
  calculateRelayRechargePricingQuote,
  DEFAULT_RELAY_RECHARGE_PRICING_TIERS,
  formatRelayRechargeDiscountLabel,
  type CreateRelayBalancePackBusinessOrderRequestBody,
  type PaymentFinalSource,
  type PaymentOrderDetailView,
  type RefreshRelayBalancePackBusinessOrderRequestBody,
  type RelayBalancePackBusinessOrderView,
  type RelayBalancePackCheckoutContextResponseBody,
  type RelayBalancePackTargetScope,
  type RelayIntegrationStatusResponseBody,
  type RelayQuotaItem,
  type RelaySelfBalancesResponseBody,
  type RelaySelfUsageResponseBody,
  type RelayUsageItem,
} from "@codeflowai/shared";

const mockWsOrigin = "ws://127.0.0.1:39290";
const enterpriseId = "enterprise_token_e2e";
const memberUserId = "member_token_e2e";
const now = Date.UTC(2026, 7, 2, 8, 30);
const relayBalancePackSkuCode = "RELAY_BALANCE_PACK_CUSTOM";
const rechargePricing = {
  version: 1,
  discountEnabled: true,
  activityEnabled: true,
  activityText: "818活动特价",
  basePresetAmountFen: 1_000,
  tiers: DEFAULT_RELAY_RECHARGE_PRICING_TIERS.map((tier) => ({
    ...tier,
    discountLabel: formatRelayRechargeDiscountLabel(tier.payPercent),
  })),
};

type OperationStatus = "PENDING" | "SYNCING" | "SUCCEEDED" | "REJECTED" | "RESULT_UNKNOWN" | "RECONCILING";
type AdjustType = "INCREASE" | "RECLAIM";
type AdjustRequest = {
  adjustType: AdjustType;
  amountUsdUnits: string;
  version: string;
  idempotencyKey: string;
  note: string | null;
};
type EnterpriseOperation = {
  operationId: string;
  operationType: string;
  operationStatus: OperationStatus;
  adjustType: AdjustType;
  amountUsdUnits: string;
  memberUserId: string;
  errorCode: string | null;
  publicMessage: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
};
type MemberAllocation = {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  accountStatus: "active" | "disabled";
  memberRole: "owner" | "member";
  membershipStatus: "active" | "removing";
  grantedUsdUnits: string;
  consumedUsdUnits: string;
  remainingUsdUnits: string;
  frozenUsdUnits: string;
  returnedUsdUnits: string;
  expiredUsdUnits: string;
  allocationStatus: "active" | "frozen" | "inactive" | "exception";
  syncStatus: "pending" | "syncing" | "succeeded" | "failed";
  version: string;
  updatedAt: number;
  operation: EnterpriseOperation | null;
};
type AdjustmentRecord = {
  operationId: string;
  operationType: string;
  operationStatus: OperationStatus;
  adjustType: AdjustType;
  amountUsdUnits: string;
  memberBeforeUsdUnits: string | null;
  memberAfterUsdUnits: string | null;
  memberUserId: string;
  membershipId: string | null;
  memberFullName: string;
  memberEmail: string;
  actorUserId: string | null;
  actorFullName: string;
  actorEmail: string;
  note: string;
  requestId: string | null;
  errorCode: string | null;
  publicMessage: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
};
type EnterpriseTokenState = {
  pool: {
    enterpriseId: string;
    personalAvailableUsdUnits: string;
    purchasedUsdUnits: string;
    availableUsdUnits: string;
    allocatedAvailableUsdUnits: string;
    consumedUsdUnits: string;
    availableFrozenUsdUnits: string;
    allocatedFrozenUsdUnits: string;
    refundedUsdUnits: string;
    expiredUsdUnits: string;
    version: string;
    updatedAt: number;
  };
  checkoutQueries: URLSearchParams[];
  balanceQueries: URLSearchParams[];
  usageQueries: URLSearchParams[];
  rechargeCreateRequests: CreateRelayBalancePackBusinessOrderRequestBody[];
  rechargeRefreshRequests: RefreshRelayBalancePackBusinessOrderRequestBody[];
  rechargeOrder: RelayBalancePackBusinessOrderView | null;
  rechargeOrderPaid: boolean;
  members: MemberAllocation[];
  records: AdjustmentRecord[];
  adjustMode: "success" | "version-conflict" | "pending" | "result-unknown";
  allocationRequests: AdjustRequest[];
  allocationQueries: URLSearchParams[];
  historyQueries: URLSearchParams[];
  poolFails: boolean;
  operationPollCount: number;
};

/** 构造每条用例独立的企业额度真值，避免跨测试共享状态。 */
function createState(options: {
  personalAvailableUsdUnits?: string;
  availableUsdUnits?: string;
  allocatedAvailableUsdUnits?: string;
} = {}): EnterpriseTokenState {
  return {
    pool: {
      enterpriseId,
      personalAvailableUsdUnits: options.personalAvailableUsdUnits ?? "2500000000",
      purchasedUsdUnits: "10000000000",
      availableUsdUnits: options.availableUsdUnits ?? "6000000000",
      allocatedAvailableUsdUnits: options.allocatedAvailableUsdUnits ?? "3000000000",
      consumedUsdUnits: "1000000000",
      availableFrozenUsdUnits: "0",
      allocatedFrozenUsdUnits: "0",
      refundedUsdUnits: "0",
      expiredUsdUnits: "0",
      version: "7",
      updatedAt: now,
    },
    checkoutQueries: [],
    balanceQueries: [],
    usageQueries: [],
    rechargeCreateRequests: [],
    rechargeRefreshRequests: [],
    rechargeOrder: null,
    rechargeOrderPaid: false,
    members: [
      {
        membershipId: "membership_token_e2e",
        userId: memberUserId,
        fullName: "额度测试成员",
        email: "token-member@example.test",
        accountStatus: "active",
        memberRole: "member",
        membershipStatus: "active",
        grantedUsdUnits: "4000000000",
        consumedUsdUnits: "1000000000",
        remainingUsdUnits: "3000000000",
        frozenUsdUnits: "0",
        returnedUsdUnits: "0",
        expiredUsdUnits: "0",
        allocationStatus: "active",
        syncStatus: "succeeded",
        version: "3",
        updatedAt: now,
        operation: null,
      },
      {
        membershipId: "membership_disabled_e2e",
        userId: "member_disabled_e2e",
        fullName: "停用成员",
        email: "disabled-member@example.test",
        accountStatus: "disabled",
        memberRole: "member",
        membershipStatus: "active",
        grantedUsdUnits: "0",
        consumedUsdUnits: "0",
        remainingUsdUnits: "0",
        frozenUsdUnits: "0",
        returnedUsdUnits: "0",
        expiredUsdUnits: "0",
        allocationStatus: "inactive",
        syncStatus: "succeeded",
        version: "-1",
        updatedAt: now,
        operation: null,
      },
    ],
    records: [createRecord("operation_history_increase", "INCREASE", "SUCCEEDED", "500000000", "历史增加"),
      createRecord("operation_history_reclaim", "RECLAIM", "RESULT_UNKNOWN", "200000000", "等待对账")],
    adjustMode: "success",
    allocationRequests: [],
    allocationQueries: [],
    historyQueries: [],
    poolFails: false,
    operationPollCount: 0,
  };
}

/** 构造企业管理员首屏需要的账号摘要，避免 shell 侧请求把页面挡在空白态。 */
function createEnterpriseAccountSummary() {
  return {
    ok: true,
    userId: "enterprise_owner_e2e",
    email: "enterprise-owner@example.test",
    fullName: "企业管理员",
    phone: "",
    avatarUrl: null,
    accountRole: "enterprise_admin",
    accessContext: {
      identityType: "ENTERPRISE_ADMIN",
      editionType: "ENTERPRISE",
      editionStatus: "ACTIVE",
      effectiveAccessScope: "ENTERPRISE_ACTIVE",
      enterpriseId,
      enterpriseName: "额度自动化企业",
    },
    enterpriseSummary: {
      enterpriseId,
      name: "额度自动化企业",
      contactName: "",
      contactEmail: "",
      contactPhone: "",
      ownerUserId: "enterprise_owner_e2e",
      status: "active",
      packageSummary: {
        purchasedPersonMonths: 0,
        allocatedPersonMonths: 0,
        availablePersonMonths: 0,
        expiresAt: 0,
        isEnterprise: true,
        scopeType: "ENTERPRISE",
        status: "NONE",
      },
      allocatedUsageUserCount: 1,
      keyOverview: {
        active: 1,
        disabled: 0,
        missing: 0,
      },
    },
    enterpriseMemberPackageSummary: null,
    pendingEnterpriseInvitations: [],
    packageSummary: {
      purchasedPersonMonths: 0,
      allocatedPersonMonths: 0,
      availablePersonMonths: 0,
      expiresAt: 0,
      isEnterprise: true,
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

/** 构造分配记录，覆盖列表和详情抽屉需要的公开字段。 */
function createRecord(
  operationId: string,
  adjustType: AdjustType,
  operationStatus: OperationStatus,
  amountUsdUnits: string,
  note: string,
): AdjustmentRecord {
  return {
    operationId,
    operationType: adjustType === "INCREASE" ? "ENTERPRISE_INCREASE" : "ADMIN_RECLAIM",
    operationStatus,
    adjustType,
    amountUsdUnits,
    memberBeforeUsdUnits: "3000000000",
    memberAfterUsdUnits: adjustType === "INCREASE" ? "3500000000" : "2800000000",
    memberUserId,
    membershipId: "membership_token_e2e",
    memberFullName: "额度测试成员",
    memberEmail: "token-member@example.test",
    actorUserId: "enterprise_owner_e2e",
    actorFullName: "企业管理员",
    actorEmail: "enterprise-owner@example.test",
    note,
    requestId: `request_${operationId}`,
    errorCode: operationStatus === "RESULT_UNKNOWN" ? "UPSTREAM_RESULT_UNKNOWN" : null,
    publicMessage: operationStatus === "RESULT_UNKNOWN" ? "额度操作结果待确认" : null,
    startedAt: now,
    updatedAt: now,
    completedAt: operationStatus === "SUCCEEDED" ? now + 1000 : null,
  };
}

/** 构造分页和状态边界用的成员快照。 */
function createMemberAllocation(
  membershipId: string,
  userId: string,
  fullName: string,
  email: string,
  overrides: Partial<MemberAllocation> = {},
): MemberAllocation {
  return {
    membershipId,
    userId,
    fullName,
    email,
    accountStatus: "active",
    memberRole: "member",
    membershipStatus: "active",
    grantedUsdUnits: "100000000",
    consumedUsdUnits: "0",
    remainingUsdUnits: "100000000",
    frozenUsdUnits: "0",
    returnedUsdUnits: "0",
    expiredUsdUnits: "0",
    allocationStatus: "active",
    syncStatus: "succeeded",
    version: "1",
    updatedAt: now,
    operation: null,
    ...overrides,
  };
}

/** 固定当前企业管理员可见的 relay 开关状态，供充值弹窗和 usage 响应复用。 */
function createRelayIntegrationStatus(): RelayIntegrationStatusResponseBody {
  return {
    enabled: true,
    state: "enabled",
    managementState: "enabled",
    publicBaseUrl: "https://relay.example.test",
    managementBaseUrlConfigured: true,
    publicBaseUrlConfigured: true,
    technicalUserConfigured: true,
    defaultGroupConfigured: true,
    providerGroupsConfigured: {
      anthropic: true,
      deepseek: true,
      moonshot: true,
      openai: true,
      qwen: true,
      zai: true,
    },
    defaultKeyQuota: 0,
    missingConfigKeys: [],
    lastHealthCheckAt: now,
    lastErrorCode: "",
  };
}

/** 构造个人余额和企业余额快照；企业部分会跟随企业池变化。 */
function createRelaySelfBalances(pool: EnterpriseTokenState["pool"]): RelaySelfBalancesResponseBody {
  return {
    personal: {
      availableUsdUnits: pool.personalAvailableUsdUnits,
      frozenUsdUnits: "0",
      consumedUsdUnits: "500000000",
      status: "ACTIVE",
      version: "12",
      updatedAt: now,
    },
    enterprise: {
      enterpriseId: pool.enterpriseId,
      enterpriseName: "额度自动化企业",
      membershipId: "membership_token_e2e",
      grantedUsdUnits: pool.allocatedAvailableUsdUnits,
      consumedUsdUnits: pool.consumedUsdUnits,
      remainingUsdUnits: pool.availableUsdUnits,
      frozenUsdUnits: "0",
      status: "active",
      syncStatus: "succeeded",
      version: pool.version,
      updatedAt: pool.updatedAt,
    },
  };
}

/** 构造个人 usage 快照，满足切换到账户目标时的辅助读取。 */
function createRelayUsageResponse(): RelaySelfUsageResponseBody {
  const item: RelayUsageItem = {
    ...createRelayQuotaItem(),
    todayActualCost: 0,
    totalActualCost: 0,
  };
  return {
    status: createRelayIntegrationStatus(),
    item,
  };
}

/** 构造充值弹窗的 checkout-context，activeOrder 由测试状态决定。 */
function createRechargeCheckoutContext(state: EnterpriseTokenState, targetScope: RelayBalancePackTargetScope): RelayBalancePackCheckoutContextResponseBody {
  return {
    planCode: "RELAY_BALANCE_PACK",
    plans: [],
    defaultSkuCode: null,
    selectedSkuCode: null,
    activeOrder: state.rechargeOrder && state.rechargeOrder.scopeType === targetScope ? state.rechargeOrder : null,
    paymentEnabled: true,
    disabledReason: null,
    rechargePricing,
    rechargePricingErrorCode: null,
    accessContext: createEnterpriseAccountSummary().accessContext,
  };
}

/** 构造充值支付单，既支持待支付态，也支持成功刷新后的到账态。 */
function createRechargeOrderView(input: {
  businessOrderId: string;
  balanceAmountFen: number;
  targetScope: RelayBalancePackTargetScope;
  orderStatus: RelayBalancePackBusinessOrderView["orderStatus"];
  fulfillmentStatus: RelayBalancePackBusinessOrderView["fulfillmentStatus"];
  paymentStatus: PaymentOrderDetailView["status"];
  finalSource: PaymentFinalSource | null;
  paidAt: number | null;
  fulfilledAt: number | null;
  targetQuotaUsd: number | null;
}): RelayBalancePackBusinessOrderView {
  const quote = calculateRelayRechargePricingQuote(input.balanceAmountFen, rechargePricing.tiers, rechargePricing.discountEnabled);
  const paymentOrderId = `payment_${input.businessOrderId}`;
  const codeUrl = input.paymentStatus === "QR_READY" || input.paymentStatus === "PAYING"
    ? `https://pay.example.test/${input.businessOrderId}`
    : null;
  return {
    businessOrderId: input.businessOrderId,
    planCode: "RELAY_BALANCE_PACK",
    skuCode: relayBalancePackSkuCode,
    scopeType: input.targetScope,
    saleUnitKeySnapshot: relayBalancePackSkuCode,
    planVersionIdSnapshot: null,
    planVersionItemIdSnapshot: null,
    billingMode: "USAGE_PACK",
    orderType: "TOP_UP",
    orderStatus: input.orderStatus,
    fulfillmentStatus: input.fulfillmentStatus,
    entrySource: "ACCOUNT_DRAWER",
    amountFen: quote.paidAmountFen,
    originalPriceFen: input.balanceAmountFen,
    discountType: quote.discountType,
    discountValue: quote.discountValue,
    discountLabel: quote.discountLabel || "无折扣",
    currency: "CNY",
    billingCycle: "NONE",
    durationMonths: 0,
    title: "Token充值",
    description: input.targetScope === "ENTERPRISE" ? "企业 Token 充值" : "个人 Token 充值",
    paymentFinalSource: input.finalSource,
    currentPaymentOrderId: paymentOrderId,
    paidAt: input.paidAt,
    fulfilledAt: input.fulfilledAt,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
    lastFulfillErrorCode: null,
    lastFulfillErrorMessage: null,
    paymentOrder: {
      orderId: paymentOrderId,
      outTradeNo: `out_${input.businessOrderId}`,
      productCode: "RELAY_BALANCE_PACK",
      status: input.paymentStatus,
      amountFen: quote.paidAmountFen,
      currency: "CNY",
      finalSource: input.finalSource,
      qrExpiresAt: codeUrl ? now + 3_600_000 : null,
      finalizedAt: input.paymentStatus === "PAID" ? now + 2_000 : null,
      createdAt: now,
      updatedAt: now,
      title: "Token充值",
      description: input.targetScope === "ENTERPRISE" ? "企业 Token 充值" : "个人 Token 充值",
      orderScene: "RELAY_BALANCE_PACK_TOP_UP",
      bizRefType: "BUSINESS_ORDER",
      bizRefId: input.businessOrderId,
      codeUrl,
      closeReason: null,
      wechatTransactionIdMasked: input.paymentStatus === "PAID" ? "wx1234****5678" : null,
      verifyAttemptCount: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
      latestCallback: null,
      latestQueryCheck: null,
      evidence: null,
      statusLogs: [],
    } as PaymentOrderDetailView,
    entitlement: null,
    balanceAmountFen: input.balanceAmountFen,
    paidAmountFen: quote.paidAmountFen,
    rechargePricingVersion: 1,
    discountThresholdAmountFen: quote.discountThresholdAmountFen,
    displayCurrency: "CNY",
    exchangeRateSnapshot: 1,
    grantedQuotaUsd: input.balanceAmountFen / 100,
    quotaUnit: "USD",
    targetQuotaUsd: input.targetQuotaUsd,
    targetEnterpriseId: input.targetScope === "ENTERPRISE" ? enterpriseId : null,
    relayQuotaItem: null,
  } as RelayBalancePackBusinessOrderView;
}

/** 构造充值上下文里用到的 quotaItem，保证 usage 响应是合法结构。 */
function createRelayQuotaItem(): RelayQuotaItem {
  return {
    userId: "enterprise_owner_e2e",
    fullName: "企业管理员",
    email: "enterprise-owner@example.test",
    enterpriseId,
    enterpriseName: "额度自动化企业",
    accountStatus: "active",
    memberRole: "owner",
    membershipStatus: "active",
    codeflowApiKeyId: null,
    codeflowKeyPrefix: null,
    codeflowKeyStatus: "active",
    providerId: null,
    linkId: null,
    upstreamKeyId: null,
    upstreamKeyPrefix: null,
    upstreamKeyName: null,
    linkStatus: "active",
    syncStatus: "synced",
    integrationStatus: "synced",
    upstreamStatus: "active",
    allocatedQuota: 3000000000,
    quota: 2500000000,
    quotaUsed: 500000000,
    usage5h: 100000000,
    usage1d: 200000000,
    usage7d: 300000000,
    lastUsedAt: now,
    lastSyncedAt: now,
    lastErrorCode: "",
    lastErrorMessage: "",
  };
}

/** 将充值金额以 fen 增量累加到 USD units，保持与页面展示的 1:1 汇率一致。 */
function addFenToUsdUnits(value: string, amountFen: number): string {
  return (BigInt(value) + BigInt(amountFen) * 1_000_000n).toString();
}

/** 将企业 Token 充值成功原子反映到 mock 池，供页面刷新验证余额变化。 */
function settleRechargeSuccess(state: EnterpriseTokenState, amountFen: number): void {
  state.pool.purchasedUsdUnits = addFenToUsdUnits(state.pool.purchasedUsdUnits, amountFen);
  state.pool.availableUsdUnits = addFenToUsdUnits(state.pool.availableUsdUnits, amountFen);
  state.pool.version = String(Number(state.pool.version) + 1);
  state.pool.updatedAt = now + 2_000;
  state.rechargeOrderPaid = true;
}

/** 返回企业 Token 页面依赖的有状态接口，并捕获查询与写请求。 */
async function fulfillEnterpriseTokenApi(route: Route, state: EnterpriseTokenState): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const json = (status: number, body: unknown) => route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });

  if (url.pathname === "/api/status" && request.method() === "GET") {
    await json(200, {
      ok: true,
      now: Date.now(),
      keyHash: "enterprise-token-e2e-key",
      authVia: "account",
      clientConnected: true,
      clientConnectedAt: now,
      clientVersion: "2026.07.05.11",
      latestClientVersion: "2026.07.05.11",
      clients: [],
      onlineWebCount: 1,
      lastSeq: 0,
    });
    return;
  }
  if (url.pathname === "/api/account/me/ws-bridge" && (request.method() === "POST" || request.method() === "GET")) {
    await json(200, { ok: true, bridgeToken: "enterprise-token-e2e-bridge", expiresAt: Date.now() + 60_000, serverNow: Date.now() });
    return;
  }
  if (url.pathname === "/api/account/me/summary" && request.method() === "GET") {
    await json(200, createEnterpriseAccountSummary());
    return;
  }
  if (url.pathname === "/api/account/me/relay/key" && request.method() === "GET") {
    await json(200, { ok: true, status: { state: "disabled", publicBaseUrl: "", providerGroupsConfigured: {} } });
    return;
  }
  if (url.pathname === "/api/account/relay/pricing/current" && request.method() === "GET") {
    const base = {
      providerId: "openai",
      currency: "CNY",
      supplier: "codeflow",
      modelVendor: "OpenAI",
      multimodal: true,
      remark: "",
      updatedAt: now,
      configuredBy: { userId: "enterprise_owner_e2e", email: "enterprise-owner@example.test" },
    };
    await json(200, {
      ok: true,
      serverNow: now,
      emptyReason: null,
      rows: [
        { ...base, id: "price-sol", modelVersion: "gpt-5.6-sol", sortOrder: 1, inputCachedPriceMilliYuanPerMillionTokens: 150, inputUncachedPriceMilliYuanPerMillionTokens: 1500, outputPriceMilliYuanPerMillionTokens: 9000 },
        { ...base, id: "price-terra", modelVersion: "gpt-5.6-terra", sortOrder: 2, inputCachedPriceMilliYuanPerMillionTokens: 75, inputUncachedPriceMilliYuanPerMillionTokens: 750, outputPriceMilliYuanPerMillionTokens: 4500 },
      ],
    });
    return;
  }
  if (url.pathname === "/api/account/me/relay-balance-package/checkout-context" && request.method() === "GET") {
    state.checkoutQueries.push(new URLSearchParams(url.searchParams));
    const targetScope = (url.searchParams.get("targetScope") ?? "USER") as RelayBalancePackTargetScope;
    await json(200, { ok: true, ...createRechargeCheckoutContext(state, targetScope) });
    return;
  }
  if (url.pathname === "/api/account/me/relay/balances" && request.method() === "GET") {
    state.balanceQueries.push(new URLSearchParams(url.searchParams));
    await json(200, { ok: true, ...createRelaySelfBalances(state.pool) });
    return;
  }
  if (url.pathname === "/api/account/me/relay/usage" && request.method() === "GET") {
    state.usageQueries.push(new URLSearchParams(url.searchParams));
    await json(200, { ok: true, ...createRelayUsageResponse() });
    return;
  }
  if (url.pathname === "/api/account/me/relay-balance-package/orders" && request.method() === "POST") {
    const body = request.postDataJSON() as CreateRelayBalancePackBusinessOrderRequestBody;
    state.rechargeCreateRequests.push(body);
    const balanceAmountFen = Number(body.amountFen ?? 0);
    const targetScope = (body.targetScope ?? "USER") as RelayBalancePackTargetScope;
    const order = createRechargeOrderView({
      businessOrderId: `relay_top_up_${targetScope.toLowerCase()}_${state.rechargeCreateRequests.length}`,
      balanceAmountFen,
      targetScope,
      orderStatus: "CREATED",
      fulfillmentStatus: "PENDING",
      paymentStatus: "QR_READY",
      finalSource: null,
      paidAt: null,
      fulfilledAt: null,
      targetQuotaUsd: null,
    });
    state.rechargeOrder = order;
    state.rechargeOrderPaid = false;
    await json(200, {
      ok: true,
      reused: false,
      order,
      pollIntervalMs: 300_000,
    });
    return;
  }
  const rechargeRefreshMatch = /^\/api\/account\/me\/relay-balance-package\/orders\/([^/]+)\/refresh$/u.exec(url.pathname);
  if (rechargeRefreshMatch && request.method() === "POST") {
    const body = request.postDataJSON() as RefreshRelayBalancePackBusinessOrderRequestBody;
    state.rechargeRefreshRequests.push(body);
    const currentOrder = state.rechargeOrder;
    if (!currentOrder) {
      await json(404, { ok: false, code: "NOT_FOUND", message: "订单不存在" });
      return;
    }
    if (!state.rechargeOrderPaid) {
      settleRechargeSuccess(state, currentOrder.balanceAmountFen);
    }
    const paidOrder = createRechargeOrderView({
      businessOrderId: currentOrder.businessOrderId,
      balanceAmountFen: currentOrder.balanceAmountFen,
      targetScope: currentOrder.scopeType,
      orderStatus: "PAID",
      fulfillmentStatus: "SUCCEEDED",
      paymentStatus: "PAID",
      finalSource: "QUERY",
      paidAt: now + 2_000,
      fulfilledAt: now + 2_000,
      targetQuotaUsd: Number(BigInt(state.pool.availableUsdUnits)) / 100_000_000,
    });
    state.rechargeOrder = paidOrder;
    await json(200, {
      ok: true,
      order: paidOrder,
      nextVerifyAt: null,
      retriedFulfillment: false,
    });
    return;
  }
  const rechargeOrderDetailMatch = /^\/api\/account\/me\/relay-balance-package\/orders\/([^/]+)$/u.exec(url.pathname);
  if (rechargeOrderDetailMatch && request.method() === "GET") {
    if (!state.rechargeOrder || state.rechargeOrder.businessOrderId !== rechargeOrderDetailMatch[1]) {
      await json(404, { ok: false, code: "NOT_FOUND", message: "订单不存在" });
      return;
    }
    await json(200, { ok: true, order: state.rechargeOrder });
    return;
  }
  if (url.pathname === "/api/account/in-app-notices/active" && request.method() === "GET") {
    await json(200, { ok: true, items: [], serverNow: Date.now() });
    return;
  }
  if (url.pathname === "/api/threads/groups" && request.method() === "GET") {
    await json(200, { ok: true, groups: [] });
    return;
  }
  if (url.pathname === "/api/workspaces" && request.method() === "GET") {
    await json(200, {
      ok: true,
      workspaces: [],
      resolvedCurrentWorkspaceId: null,
      workspaceListAuthoritative: true,
      activeClientCount: 0,
      workspaceListSuccessCount: 0,
      workspaceListFailureCount: 0,
    });
    return;
  }
  if (url.pathname === "/api/client/latest" && request.method() === "GET") {
    await json(200, {
      ok: true,
      version: "2026.07.05.11",
      url: "/downloads/codeflowai-test.tgz",
      platformKey: url.searchParams.has("platform") ? "win32-x64" : null,
    });
    return;
  }
  if (url.pathname === "/api/account/enterprise/summary" && request.method() === "GET") {
    await json(200, createEnterpriseAccountSummary().enterpriseSummary);
    return;
  }
  if (url.pathname === "/api/account/enterprise/relay/balance-pool" && request.method() === "GET") {
    await json(state.poolFails ? 500 : 200, state.poolFails
      ? { ok: false, code: "ENTERPRISE_POOL_FAILED", message: "企业池暂时不可用" }
      : { ok: true, ...state.pool });
    return;
  }
  if (url.pathname === "/api/account/enterprise/relay/allocations" && request.method() === "GET") {
    state.allocationQueries.push(new URLSearchParams(url.searchParams));
    const search = String(url.searchParams.get("search") ?? "").toLowerCase();
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const filtered = state.members.filter((item) => !search
      || item.fullName.toLowerCase().includes(search)
      || item.email.toLowerCase().includes(search));
    await json(200, { ok: true, items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit });
    return;
  }
  if (url.pathname === "/api/account/enterprise/relay/allocation-records" && request.method() === "GET") {
    state.historyQueries.push(new URLSearchParams(url.searchParams));
    const adjustType = url.searchParams.get("adjustType");
    const status = url.searchParams.get("status");
    const search = String(url.searchParams.get("search") ?? "").toLowerCase();
    const items = state.records.filter((record) => (!adjustType || record.adjustType === adjustType)
      && (!status || (status === "PROCESSING"
        ? ["PENDING", "SYNCING", "RECONCILING"].includes(record.operationStatus)
        : record.operationStatus === status))
      && (!search || record.memberFullName.toLowerCase().includes(search) || record.memberEmail.toLowerCase().includes(search)));
    await json(200, { ok: true, items, total: items.length, offset: 0, limit: 20 });
    return;
  }
  const operationMatch = /^\/api\/account\/enterprise\/relay\/operations\/([^/]+)$/u.exec(url.pathname);
  if (operationMatch && request.method() === "GET") {
    state.operationPollCount += 1;
    const member = state.members[0]!;
    const operation = member.operation;
    if (!operation) {
      await json(404, { ok: false, code: "NOT_FOUND", message: "操作不存在" });
      return;
    }
    if (state.adjustMode === "pending") settleMemberAdjustment(state, operation.adjustType, operation.amountUsdUnits);
    await json(200, { ok: true, ...operation, operationStatus: "SUCCEEDED", completedAt: now + 2000 });
    return;
  }
  const adjustMatch = /^\/api\/account\/enterprise\/relay\/allocations\/([^/]+)\/adjust$/u.exec(url.pathname);
  if (adjustMatch && request.method() === "POST") {
    const body = request.postDataJSON() as AdjustRequest;
    state.allocationRequests.push(body);
    if (state.adjustMode === "version-conflict") {
      state.members[0]!.version = "4";
      await json(409, { ok: false, code: "VERSION_CONFLICT", message: "成员额度版本已变化" });
      return;
    }
    const operation = createOperation(state.adjustMode, body);
    if (state.adjustMode === "success") {
      settleMemberAdjustment(state, body.adjustType, body.amountUsdUnits);
    } else {
      const member = state.members[0]!;
      member.operation = operation;
      if (body.adjustType === "RECLAIM") {
        const amount = BigInt(body.amountUsdUnits);
        member.remainingUsdUnits = (BigInt(member.remainingUsdUnits) - amount).toString();
        member.frozenUsdUnits = (BigInt(member.frozenUsdUnits) + amount).toString();
        state.pool.allocatedAvailableUsdUnits = (BigInt(state.pool.allocatedAvailableUsdUnits) - amount).toString();
        state.pool.allocatedFrozenUsdUnits = (BigInt(state.pool.allocatedFrozenUsdUnits) + amount).toString();
      }
    }
    await json(state.adjustMode === "success" ? 200 : 202, {
      ok: true,
      operationId: operation.operationId,
      operationStatus: operation.operationStatus,
      adjustType: body.adjustType,
      amountUsdUnits: body.amountUsdUnits,
      enterpriseId,
      memberUserId,
      version: state.members[0]!.version,
    });
    return;
  }
  await route.fallback();
}

/** 根据提交模式构造公开 operation，避免测试依赖上游技术载荷。 */
function createOperation(mode: EnterpriseTokenState["adjustMode"], body: AdjustRequest): EnterpriseOperation {
  const operationStatus: OperationStatus = mode === "result-unknown" ? "RESULT_UNKNOWN" : mode === "pending" ? "PENDING" : "SUCCEEDED";
  return {
    operationId: `operation_${mode}`,
    operationType: body.adjustType === "INCREASE" ? "ENTERPRISE_INCREASE" : "ADMIN_RECLAIM",
    operationStatus,
    adjustType: body.adjustType,
    amountUsdUnits: body.amountUsdUnits,
    memberUserId,
    errorCode: operationStatus === "RESULT_UNKNOWN" ? "UPSTREAM_RESULT_UNKNOWN" : null,
    publicMessage: operationStatus === "RESULT_UNKNOWN" ? "额度操作结果待确认" : null,
    startedAt: now,
    updatedAt: now,
    completedAt: operationStatus === "SUCCEEDED" ? now + 1000 : null,
  };
}

/** 增加累加 granted，回收累加 returned；异步回收从冻结额度结算并保留历史总额。 */
function settleMemberAdjustment(state: EnterpriseTokenState, adjustType: AdjustType, amountUsdUnits: string): void {
  const member = state.members[0]!;
  const amount = BigInt(amountUsdUnits);
  const direction = adjustType === "INCREASE" ? 1n : -1n;
  if (adjustType === "INCREASE") {
    member.grantedUsdUnits = (BigInt(member.grantedUsdUnits) + amount).toString();
  } else {
    member.returnedUsdUnits = (BigInt(member.returnedUsdUnits) + amount).toString();
  }
  if (adjustType === "RECLAIM" && member.operation?.adjustType === "RECLAIM") {
    member.frozenUsdUnits = (BigInt(member.frozenUsdUnits) - amount).toString();
    state.pool.allocatedFrozenUsdUnits = (BigInt(state.pool.allocatedFrozenUsdUnits) - amount).toString();
  } else {
    member.remainingUsdUnits = (BigInt(member.remainingUsdUnits) + direction * amount).toString();
    state.pool.allocatedAvailableUsdUnits = (BigInt(state.pool.allocatedAvailableUsdUnits) + direction * amount).toString();
  }
  state.pool.availableUsdUnits = (BigInt(state.pool.availableUsdUnits) - direction * amount).toString();
  member.version = String(Number(member.version) + 1);
  member.operation = null;
}

/** 注入企业管理员会话并打开企业 Token 页面。 */
async function openEnterpriseTokenPage(page: Page, state: EnterpriseTokenState): Promise<void> {
  await page.route("**/api/**", (route) => fulfillEnterpriseTokenApi(route, state));
  await page.routeWebSocket(/\/ws\/web(?:\?|$)/u, (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Record<string, any>;
      if (message.t === "web.subscribeReplace") {
        ws.send(JSON.stringify({
          t: "web.subscribeAck",
          requestId: message.requestId,
          workspaceId: message.workspaceId ?? null,
          sinceSeq: Number(message.sinceSeq ?? 0),
          bufferedCount: 0,
          serverSeq: 0,
        }));
      }
    });
    setTimeout(() => {
      ws.send(JSON.stringify({
        t: "web.helloAck",
        webSessionId: "enterprise-token-e2e-web-session",
        serverNow: Date.now(),
        authMode: "account",
        accountRole: "enterprise_admin",
        homePath: "/admin",
        userSummary: createEnterpriseAccountSummary(),
        accessContext: createEnterpriseAccountSummary().accessContext,
      }));
    }, 0);
  });
  await page.addInitScript(({ serverWsOrigin, expiresAt, currentEnterpriseId }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin,
      authMode: "account",
      accountRole: "enterprise_admin",
      sessionToken: "e2e-enterprise-admin-session",
      sessionExpiresAt: expiresAt,
      homePath: "/admin",
      accessContext: {
        identityType: "ENTERPRISE_ADMIN",
        editionType: "ENTERPRISE",
        editionStatus: "ACTIVE",
        effectiveAccessScope: "ENTERPRISE_ACTIVE",
        enterpriseId: currentEnterpriseId,
        enterpriseName: "额度自动化企业",
      },
      userSummary: {
        userId: "enterprise_owner_e2e",
        email: "enterprise-owner@example.test",
        fullName: "企业管理员",
        phone: "",
        avatarUrl: null,
        accountRole: "enterprise_admin",
        status: "active",
        enterpriseId: currentEnterpriseId,
        enterpriseName: "额度自动化企业",
      },
    }));
  }, { serverWsOrigin: mockWsOrigin, expiresAt: Date.now() + 3_600_000, currentEnterpriseId: enterpriseId });
  await page.goto("/admin?panel=enterprise-token");
  await expect(page).not.toHaveURL(/\/auth\/login/u);
  if (state.poolFails) return;
  await expect(page.getByRole("tab", { name: "Token分配" })).toBeVisible({ timeout: 20_000 });
}

/** 通过真实用户菜单打开桌面个人信息抽屉。 */
async function openPersonalInfoDrawer(page: Page): Promise<Locator> {
  const trigger = page.locator(".user-menu-trigger").first();
  await expect(trigger, "页面应展示用户菜单入口").toBeVisible();
  await trigger.click();
  const menuItem = page.getByRole("menuitem", { name: "个人信息" });
  await expect(menuItem, "用户菜单应包含个人信息入口").toBeVisible();
  await menuItem.click();

  const drawer = page.locator(".ant-drawer-content").filter({
    has: page.locator(".ant-drawer-title", { hasText: /^个人信息$/u }),
  }).last();
  await expect(drawer, "个人信息抽屉应打开").toBeVisible();
  return drawer;
}

/** 校验余额卡及数值文本的真实几何边界，避免仅用 toBeVisible 掩盖裁切。 */
async function assertBalanceGeometry(value: Locator, expectedText: string): Promise<void> {
  await expect(value).toHaveText(expectedText);
  const metrics = await value.evaluate((element) => {
    const balances = element.closest(".account-drawer__hero-token-balances");
    const card = element.closest(".account-drawer__hero-meta-item--token");
    if (!balances || !card) throw new Error("余额元素缺少可测量的容器");
    const range = document.createRange();
    range.selectNodeContents(element);
    const elementRect = element.getBoundingClientRect();
    const balancesRect = balances.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      text: element.textContent,
      element: {
        left: elementRect.left,
        right: elementRect.right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      },
      balances: {
        left: balancesRect.left,
        right: balancesRect.right,
        scrollWidth: balances.scrollWidth,
        clientWidth: balances.clientWidth,
      },
      card: {
        left: cardRect.left,
        right: cardRect.right,
        scrollWidth: card.scrollWidth,
        clientWidth: card.clientWidth,
      },
      textRects: Array.from(range.getClientRects()).map((rect) => ({
        left: rect.left,
        right: rect.right,
      })),
    };
  });

  expect(metrics.text).toBe(expectedText);
  expect(metrics.element.scrollWidth).toBeLessThanOrEqual(metrics.element.clientWidth + 1);
  expect(metrics.balances.scrollWidth).toBeLessThanOrEqual(metrics.balances.clientWidth + 1);
  expect(metrics.card.scrollWidth).toBeLessThanOrEqual(metrics.card.clientWidth + 1);
  expect(metrics.element.left).toBeGreaterThanOrEqual(metrics.balances.left - 1);
  expect(metrics.element.right).toBeLessThanOrEqual(metrics.balances.right + 1);
  expect(metrics.element.left).toBeGreaterThanOrEqual(metrics.card.left - 1);
  expect(metrics.element.right).toBeLessThanOrEqual(metrics.card.right + 1);
  for (const rect of metrics.textRects) {
    expect(rect.left).toBeGreaterThanOrEqual(metrics.element.left - 1);
    expect(rect.right).toBeLessThanOrEqual(metrics.element.right + 1);
    expect(rect.left).toBeGreaterThanOrEqual(metrics.card.left - 1);
    expect(rect.right).toBeLessThanOrEqual(metrics.card.right + 1);
  }
}

test.describe("个人信息 Token 余额布局", () => {
  test("桌面长企业余额完整显示且不越过 Token 卡片边界", async ({ page }) => {
    const state = createState({
      personalAvailableUsdUnits: "194000000",
      availableUsdUnits: "102707000000",
      allocatedAvailableUsdUnits: "0",
    });
    await openEnterpriseTokenPage(page, state);
    const drawer = await openPersonalInfoDrawer(page);
    const card = drawer.locator(".account-drawer__hero-meta-item--token");
    const rows = card.locator(".account-drawer__hero-token-balance-row");

    await expect(card).toBeVisible();
    await expect(rows).toHaveCount(2);
    await assertBalanceGeometry(rows.nth(0).locator("strong"), "￥1.94");
    await assertBalanceGeometry(rows.nth(1).locator("strong"), "￥1,027.07");
    await expect(drawer.getByText("企业归属", { exact: true })).toBeVisible();
    await expect(drawer.getByText("套餐余量", { exact: true })).toBeVisible();

    await drawer.locator(".ant-drawer-close").click();
    await expect(drawer).not.toBeVisible();
    state.pool.availableUsdUnits = "102700000000000";
    const longValueDrawer = await openPersonalInfoDrawer(page);
    const longRows = longValueDrawer.locator(".account-drawer__hero-token-balance-row");
    await assertBalanceGeometry(longRows.nth(0).locator("strong"), "￥1.94");
    await assertBalanceGeometry(longRows.nth(1).locator("strong"), "￥1,027,000.00");
  });
});

/** 返回指定成员桌面表格行，避免同名移动端节点干扰定位。 */
function memberRow(page: Page) {
  return page.locator(".enterprise-token-quota__table .ant-table-row", { hasText: "token-member@example.test" });
}

/** 返回指定邮箱的成员行，避免分页场景下误命中其他同类状态行。 */
function memberRowByEmail(page: Page, email: string) {
  return page.locator(".enterprise-token-quota__table .ant-table-row", { hasText: email });
}

/** 返回当前额度调整弹框，避免按钮选择器命中顶部 Client 状态。 */
function adjustDialog(page: Page) {
  return page.getByRole("dialog", { name: /成员额度/u });
}

/** 返回充值弹框，避免把页面上的同名按钮和提示误命中。 */
function rechargeDialog(page: Page) {
  return page.getByRole("dialog", { name: "Token充值" });
}

/** 填写当前额度弹窗的金额输入。 */
async function fillAdjustAmount(page: Page, amount: string): Promise<void> {
  await page.getByPlaceholder("例如 10.50").fill(amount);
}

/** 点击当前额度调整弹框的确认按钮。 */
async function confirmAdjust(page: Page): Promise<void> {
  await adjustDialog(page).getByRole("button", { name: /确\s*认/u }).click();
}

test.describe("企业 Token 额度管理第一阶段", () => {
  test("企业管理员可查看精确企业池、成员字段和使用规则", async ({ page }) => {
    const state = createState();
    await openEnterpriseTokenPage(page, state);

    await expect(page.getByText("￥100.00", { exact: true })).toBeVisible();
    await expect(page.getByText("￥60.00", { exact: true })).toBeVisible();
    await expect(page.getByText("￥30.00", { exact: true }).first()).toBeVisible();
    await expect(memberRow(page)).toContainText("额度测试成员");
    await expect(memberRow(page)).toContainText("正常");
    await expect(page.getByRole("columnheader", { name: "净分配", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /企业Token充值/u })).toBeVisible();
    await page.getByRole("button", { name: /查看额度使用规则/u }).click();
    const guidePopover = page.locator(".ant-popover").last();
    await expect(guidePopover).toBeVisible();
    await expect(guidePopover).toContainText("“增加”按钮为成员增加token额度，会同步减少企业“可分配”余额。");
    await expect(guidePopover).toContainText("“回收”按钮仅能回收成员的“可用额度”，已消费额度不能回收。");
    await expect(guidePopover).toContainText("“净分配”为累计增加减去已回收、已过期的额度，包含已消费、可用及冻结额度。");
    await expect(guidePopover).toContainText("回收期间会暂时停用该成员中转 Key，操作成功或明确拒绝后按当前权限恢复。");
    await expect(guidePopover).toContainText("显示“处理中”或“对账中”时请等待原操作结束。");
    await expect(guidePopover).toContainText("显示“结果待确认”时不要再次调整，并联系运维提供操作 ID。");
    await expect(guidePopover).toContainText("禁用或移除成员会触发未消费额度回收；清理未完成时成员保持不可用，重新启用或重新加入后需重新分配。");
  });
  test("成员搜索和手动刷新始终使用服务端最新快照", async ({ page }) => {
    const state = createState();
    await openEnterpriseTokenPage(page, state);

    const search = page.getByPlaceholder("搜索成员姓名或邮箱").first();
    await search.fill("disabled-member");
    await page.getByRole("button", { name: "查询" }).first().click();
    await expect(page.locator(".enterprise-token-quota__table")).toContainText("停用成员");
    await expect(page.locator(".enterprise-token-quota__table")).not.toContainText("额度测试成员");
    expect(state.allocationQueries.at(-1)?.get("search")).toBe("disabled-member");

    state.members[1]!.fullName = "已同步停用成员";
    await page.getByRole("button", { name: /刷新/u }).click();
    await expect(page.locator(".enterprise-token-quota__table")).toContainText("已同步停用成员");
  });

  test("增加额度提交精确 units、版本和唯一幂等键并刷新余额", async ({ page }) => {
    const state = createState();
    await openEnterpriseTokenPage(page, state);

    await memberRow(page).getByRole("button", { name: "增加" }).click();
    await fillAdjustAmount(page, "10.50");
    await expect(page.locator(".ant-form-item", { hasText: "调整后成员可用额度" }).locator("input")).toHaveValue("￥40.50");
    await confirmAdjust(page);

    await expect.poll(() => state.allocationRequests.length).toBe(1);
    expect(state.allocationRequests[0]).toMatchObject({
      adjustType: "INCREASE",
      amountUsdUnits: "1050000000",
      version: "3",
      note: null,
    });
    expect(state.allocationRequests[0]?.idempotencyKey).toMatch(/^enterprise-token-adjust:member_token_e2e:[0-9a-f-]{36}$/u);
    await expect(page.getByText("成员额度已调整")).toBeVisible();
    await expect(memberRow(page)).toContainText("￥40.50");
    await expect(memberRow(page).getByRole("cell").nth(1)).toHaveText("￥50.50");
  });

  test("回收额度明确提示 Key 影响并允许不填写备注", async ({ page }) => {
    const state = createState();
    await openEnterpriseTokenPage(page, state);

    await memberRow(page).getByRole("button", { name: "回收" }).click();
    await expect(page.getByText("回收期间将暂时停用成员中转 Key")).toBeVisible();
    await expect(page.getByText("操作完成或明确拒绝后，将按成员当前权限恢复可用的中转 Key。")).toBeVisible();
    await fillAdjustAmount(page, "31");
    await expect(page.getByText("成员可回收额度不足")).toBeVisible();
    await fillAdjustAmount(page, "5");
    await expect(page.getByText("回收额度必须填写备注")).not.toBeVisible();
    await confirmAdjust(page);

    await expect.poll(() => state.allocationRequests.length).toBe(1);
    expect(state.allocationRequests[0]).toMatchObject({
      adjustType: "RECLAIM",
      amountUsdUnits: "500000000",
      version: "3",
      note: null,
    });
    await expect(memberRow(page)).toContainText("￥25.00");
    expect(state.members[0]!.grantedUsdUnits).toBe("4000000000");
    expect(state.members[0]!.returnedUsdUnits).toBe("500000000");
    await expect(memberRow(page).getByRole("cell").nth(1)).toHaveText("￥35.00");
    await expect(memberRow(page).getByRole("cell").nth(2)).toHaveText("￥25.00");
    await expect(memberRow(page).getByRole("cell").nth(3)).toHaveText("￥10.00");

    await page.reload();
    await expect(memberRow(page).getByRole("cell").nth(1)).toHaveText("￥35.00");
    await memberRow(page).getByRole("button", { name: "增加" }).click();
    await fillAdjustAmount(page, "2");
    await confirmAdjust(page);
    await expect(memberRow(page).getByRole("cell").nth(1)).toHaveText("￥37.00");
    await expect(memberRow(page).getByRole("cell").nth(2)).toHaveText("￥27.00");
    expect(state.members[0]!.grantedUsdUnits).toBe("4200000000");
    expect(state.members[0]!.returnedUsdUnits).toBe("500000000");
  });

  for (const scenario of [
    { name: "历史回收", granted: "85000000000", returned: "20000000000", expired: "0", consumed: "44881000000", remaining: "20119000000", frozen: "0", expected: "￥650.00" },
    { name: "回收和到期同时扣减且保留冻结", granted: "4000000000", returned: "500000000", expired: "1000000000", consumed: "1000000000", remaining: "1000000000", frozen: "500000000", expected: "￥25.00" },
    { name: "全部回收", granted: "4000000000", returned: "4000000000", expired: "0", consumed: "0", remaining: "0", frozen: "0", expected: "￥0.00" },
    { name: "全部过期", granted: "4000000000", returned: "0", expired: "4000000000", consumed: "0", remaining: "0", frozen: "0", expected: "￥0.00" },
    { name: "超出安全整数范围仍精确相减", granted: "9007199255240991", returned: "9007199254740992", expired: "0", consumed: "0", remaining: "499999", frozen: "0", expected: "￥0.00" },
  ]) {
    test(`净分配正确展示${scenario.name}的服务端快照`, async ({ page }) => {
      const state = createState();
      Object.assign(state.members[0]!, {
        grantedUsdUnits: scenario.granted,
        returnedUsdUnits: scenario.returned,
        expiredUsdUnits: scenario.expired,
        consumedUsdUnits: scenario.consumed,
        remainingUsdUnits: scenario.remaining,
        frozenUsdUnits: scenario.frozen,
      });
      await openEnterpriseTokenPage(page, state);

      await expect(memberRow(page).getByRole("cell").nth(1)).toHaveText(scenario.expected);
      expect(state.members[0]!.grantedUsdUnits).toBe(scenario.granted);
      expect(state.allocationRequests).toHaveLength(0);
    });
  }

  test("回收处理中不提前减少净分配，成功后才按已回收金额扣减", async ({ page }) => {
    const state = createState();
    state.adjustMode = "pending";
    await openEnterpriseTokenPage(page, state);

    await memberRow(page).getByRole("button", { name: "回收" }).click();
    await fillAdjustAmount(page, "5");
    await confirmAdjust(page);
    await expect(memberRow(page)).toContainText("处理中");
    await expect(memberRow(page).getByRole("cell").nth(1)).toHaveText("￥40.00");
    await expect(memberRow(page).getByRole("cell").nth(2)).toHaveText("￥25.00");
    expect(state.members[0]!.frozenUsdUnits).toBe("500000000");
    expect(state.members[0]!.returnedUsdUnits).toBe("0");

    await expect.poll(() => state.operationPollCount, { timeout: 8_000 }).toBeGreaterThan(0);
    await expect(memberRow(page).getByRole("cell").nth(1)).toHaveText("￥35.00");
    await expect(memberRow(page).getByRole("cell").nth(2)).toHaveText("￥25.00");
    expect(state.members[0]!.grantedUsdUnits).toBe("4000000000");
    expect(state.members[0]!.returnedUsdUnits).toBe("500000000");
    expect(state.members[0]!.frozenUsdUnits).toBe("0");
    expect(state.allocationRequests).toHaveLength(1);
  });

  test("回收结果待确认时冻结额度仍计入净分配且刷新不提前扣减", async ({ page }) => {
    const state = createState();
    state.adjustMode = "result-unknown";
    await openEnterpriseTokenPage(page, state);

    await memberRow(page).getByRole("button", { name: "回收" }).click();
    await fillAdjustAmount(page, "5");
    await confirmAdjust(page);

    await expect(memberRow(page)).toContainText("结果待确认");
    await expect(memberRow(page).getByRole("cell").nth(1)).toHaveText("￥40.00");
    await expect(memberRow(page).getByRole("cell").nth(2)).toHaveText("￥25.00");
    await expect(memberRow(page).getByRole("button", { name: "回收" })).toBeDisabled();
    expect(state.members[0]!.frozenUsdUnits).toBe("500000000");
    expect(state.members[0]!.returnedUsdUnits).toBe("0");

    await page.reload();
    await expect(memberRow(page).getByRole("cell").nth(1)).toHaveText("￥40.00");
    expect(state.operationPollCount).toBe(0);
    expect(state.allocationRequests).toHaveLength(1);
  });

  test("版本冲突刷新成员版本且不自动重放调整", async ({ page }) => {
    const state = createState();
    state.adjustMode = "version-conflict";
    await openEnterpriseTokenPage(page, state);

    await memberRow(page).getByRole("button", { name: "增加" }).click();
    await fillAdjustAmount(page, "2");
    await confirmAdjust(page);

    await expect(page.getByText("成员额度已变化，数据已刷新，请重新确认")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "增加成员额度" })).toBeHidden();
    expect(state.allocationRequests).toHaveLength(1);
    expect(state.allocationRequests[0]?.version).toBe("3");
  });

  test("处理中 operation 自动轮询并在完成后恢复可调整状态", async ({ page }) => {
    const state = createState();
    state.adjustMode = "pending";
    await openEnterpriseTokenPage(page, state);

    await memberRow(page).getByRole("button", { name: "增加" }).click();
    await fillAdjustAmount(page, "1");
    await confirmAdjust(page);
    await expect(memberRow(page)).toContainText("处理中");
    await expect(memberRow(page).getByRole("button", { name: "增加" })).toBeDisabled();

    await expect.poll(() => state.operationPollCount, { timeout: 8_000 }).toBeGreaterThan(0);
    await expect(memberRow(page).getByRole("button", { name: "增加" })).toBeEnabled();
    await expect(memberRow(page)).toContainText("￥31.00");
  });

  test("结果待确认展示操作 ID 并阻止重复调整", async ({ page }) => {
    const state = createState();
    state.adjustMode = "result-unknown";
    await openEnterpriseTokenPage(page, state);

    await memberRow(page).getByRole("button", { name: "增加" }).click();
    await fillAdjustAmount(page, "1");
    await confirmAdjust(page);

    await expect(page.getByText("额度操作结果待确认").first()).toBeVisible();
    await expect(page.getByText("操作 ID：operation_result-unknown")).toBeVisible();
    await expect(memberRow(page).getByRole("button", { name: "增加" })).toBeDisabled();
    await expect(memberRow(page).getByRole("button", { name: "回收" })).toBeDisabled();
    expect(state.operationPollCount).toBe(0);
  });

  test("分配记录支持筛选并在详情中保留公开追踪字段", async ({ page }) => {
    const state = createState();
    await openEnterpriseTokenPage(page, state);

    await page.getByRole("tab", { name: "分配记录" }).click();
    await expect(page.getByRole("region", { name: "分配与回收记录" })).toBeVisible();
    await page.getByLabel("操作类型").click();
    await page.getByText("回收", { exact: true }).last().click();
    await page.getByLabel("操作状态").click();
    await page.getByText("结果待确认", { exact: true }).last().click();
    await page.getByRole("button", { name: "查询" }).last().click();

    await expect(page.locator(".enterprise-token-history__table")).toContainText("结果待确认");
    expect(state.historyQueries.at(-1)?.get("adjustType")).toBe("RECLAIM");
    expect(state.historyQueries.at(-1)?.get("status")).toBe("RESULT_UNKNOWN");
    await expect(page.locator(".enterprise-token-history__table .ant-table-row")).toHaveCount(1);
    await page.locator('.enterprise-token-history__table [data-row-key="operation_history_reclaim"]').getByLabel("查看操作详情").click();
    await expect(page.getByText("operation_history_reclaim", { exact: true })).toBeVisible();
    await expect(page.getByText("request_operation_history_reclaim", { exact: true })).toBeVisible();
    await expect(page.getByText("UPSTREAM_RESULT_UNKNOWN")).toHaveCount(0);
  });

  test("加载失败可显式重试且窄屏内容不撑破视口", async ({ page }) => {
    const state = createState();
    state.poolFails = true;
    await openEnterpriseTokenPage(page, state);

    await expect(page.getByText("企业 Token 额度加载失败")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("企业池暂时不可用")).toBeVisible();
    state.poolFails = false;
    await page.setViewportSize({ width: 1200, height: 844 });
    await page.getByRole("button", { name: /重\s*试/u }).click();
    await expect(page.locator(".enterprise-token-quota__table")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("企业 Token 额度管理第二阶段", () => {
  test("成员分页遇到移除中和禁用成员时仍能正确锁定调整权限", async ({ page }) => {
    const state = createState();
    state.members = [
      ...state.members,
      ...Array.from({ length: 18 }, (_, index) => createMemberAllocation(
        `membership_filler_${index + 1}`,
        `member_filler_${index + 1}`,
        `填充成员 ${index + 1}`,
        `filler-${index + 1}@example.test`,
      )),
      createMemberAllocation(
        "membership_removing_e2e",
        "member_removing_e2e",
        "移除中的成员",
        "removing-member@example.test",
        {
          grantedUsdUnits: "200000000",
          consumedUsdUnits: "50000000",
          remainingUsdUnits: "150000000",
          allocationStatus: "frozen",
          membershipStatus: "removing",
          syncStatus: "failed",
          version: "8",
        },
      ),
      createMemberAllocation(
        "membership_disabled_e2e",
        "member_disabled_stage2_e2e",
        "禁用成员",
        "disabled-stage2-member@example.test",
        {
          accountStatus: "disabled",
          grantedUsdUnits: "0",
          consumedUsdUnits: "0",
          remainingUsdUnits: "0",
          allocationStatus: "inactive",
          version: "-1",
        },
      ),
    ];
    await openEnterpriseTokenPage(page, state);

    const paginationBar = page.locator(".enterprise-token-quota__pagination");
    await expect(paginationBar).toContainText("共 22 名成员");
    expect((await paginationBar.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(48);
    await page.locator(".ant-pagination-item-2").click();

    await expect.poll(() => state.allocationQueries.at(-1)?.get("offset")).toBe("20");
    await expect(memberRowByEmail(page, "removing-member@example.test")).toContainText("移除处理中");
    await expect(memberRowByEmail(page, "disabled-stage2-member@example.test")).toContainText("账号不可用");
    await expect(memberRowByEmail(page, "removing-member@example.test").getByRole("button", { name: "增加" })).toBeDisabled();
    await expect(memberRowByEmail(page, "removing-member@example.test").getByRole("button", { name: "回收" })).toBeDisabled();
    await expect(memberRowByEmail(page, "disabled-stage2-member@example.test").getByRole("button", { name: "增加" })).toBeDisabled();
    await expect(memberRowByEmail(page, "disabled-stage2-member@example.test").getByRole("button", { name: "回收" })).toBeDisabled();
  });

  test("历史记录展示成员离企、账号失权和到期回收来源", async ({ page }) => {
    const state = createState();
    state.records = [
      {
        ...createRecord("operation_membership_reclaim", "RECLAIM", "SUCCEEDED", "300000000", "成员离企回收"),
        operationType: "MEMBERSHIP_RECLAIM",
        memberBeforeUsdUnits: "500000000",
        memberAfterUsdUnits: "200000000",
        memberUserId: "member_removing_e2e",
        membershipId: "membership_removing_e2e",
        memberFullName: "移除中的成员",
        memberEmail: "removing-member@example.test",
        actorFullName: "系统任务",
        actorEmail: "",
        actorUserId: null,
      },
      {
        ...createRecord("operation_account_revoke", "RECLAIM", "RECONCILING", "120000000", "账号失权回收对账中"),
        operationType: "ACCOUNT_REVOKE",
        memberBeforeUsdUnits: "220000000",
        memberAfterUsdUnits: "100000000",
        memberUserId: "member_disabled_stage2_e2e",
        membershipId: "membership_disabled_e2e",
        memberFullName: "禁用成员",
        memberEmail: "disabled-stage2-member@example.test",
        actorFullName: "系统任务",
        actorEmail: "",
        actorUserId: null,
        publicMessage: "账号失权回收对账中",
      },
      {
        ...createRecord("operation_expiry_reclaim", "RECLAIM", "RESULT_UNKNOWN", "50000000", "额度到期回收结果待确认"),
        operationType: "EXPIRY_RECLAIM",
        memberBeforeUsdUnits: "100000000",
        memberAfterUsdUnits: "50000000",
        memberUserId: "member_expiry_e2e",
        membershipId: "membership_expiry_e2e",
        memberFullName: "到期成员",
        memberEmail: "expiry-member@example.test",
        actorFullName: "系统任务",
        actorEmail: "",
        actorUserId: null,
        publicMessage: "额度到期回收结果待确认",
      },
    ];
    await openEnterpriseTokenPage(page, state);

    await page.getByRole("tab", { name: "分配记录" }).click();
    await expect(page.getByRole("region", { name: "分配与回收记录" })).toBeVisible();
    await expect(page.locator(".enterprise-token-history__table")).toContainText("对账中");
    await expect(page.locator(".enterprise-token-history__table")).toContainText("结果待确认");

    for (const [index, source] of ["成员离企回收", "账号失权回收", "额度到期回收"].entries()) {
      const record = state.records[index]!;
      const row = page.locator(".enterprise-token-history__table").getByRole("row", { name: record.memberEmail });
      await row.getByLabel("查看操作详情").click();
      const detail = page.locator(".ant-drawer", { has: page.locator(".ant-drawer-title", { hasText: "操作详情" }) });
      await expect(detail).toBeVisible();
      await expect(detail.locator(".ant-descriptions-row", { hasText: "操作类型" })).toContainText(source);
      await expect(detail).toContainText(record.note);
      await expect(detail.getByText(record.operationId, { exact: true })).toBeVisible();
      await detail.locator(".ant-drawer-close").click();
      await expect(detail).not.toBeVisible();
    }
  });
});

test.describe("企业 Token 充值链路第二阶段", () => {
  test("个人/企业充值目标切换会同步刷新 checkout-context 与余额", async ({ page }) => {
    const state = createState();
    await openEnterpriseTokenPage(page, state);

    await page.getByRole("button", { name: /企业Token充值/u }).click();
    const dialog = rechargeDialog(page);

    await expect(dialog).toBeVisible();
    await expect.poll(() => state.checkoutQueries.length).toBe(1);
    expect(state.checkoutQueries[0]?.get("targetScope")).toBe("ENTERPRISE");
    expect(state.checkoutQueries[0]?.get("enterpriseId")).toBe(enterpriseId);
    await expect(dialog.getByText("企业可分配 Token 余额")).toBeVisible();
    await expect(dialog.getByText("￥60.00", { exact: true })).toBeVisible();
    await dialog.getByPlaceholder("请输入充值金额").fill("268");
    await expect(dialog.getByText("已享92折，本次节省 ￥21.44", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "立即支付 ￥246.56" })).toBeEnabled();

    await dialog.getByText("个人账户", { exact: true }).click();
    await expect.poll(() => state.checkoutQueries.length).toBe(2);
    expect(state.checkoutQueries[1]?.get("targetScope")).toBe("USER");
    expect(state.checkoutQueries[1]?.get("enterpriseId")).toBeNull();
    await expect.poll(() => state.usageQueries.length).toBe(1);
    expect(state.usageQueries[0]?.get("includeCosts")).toBe("false");
    expect(state.usageQueries[0]?.get("snapshotOnly")).toBe("true");
    await expect(dialog.getByText("个人 Token 余额")).toBeVisible();
    await expect(dialog.getByText("￥25.00", { exact: true })).toBeVisible();
    await expect(dialog.getByText("企业可分配 Token 余额")).toHaveCount(0);
    await expect(dialog.getByPlaceholder("请输入充值金额")).toHaveValue("268");
    await expect(dialog.getByRole("button", { name: "立即支付 ￥246.56" })).toBeEnabled();

    await dialog.getByText("企业账户：额度自动化企业", { exact: true }).click();
    await expect.poll(() => state.checkoutQueries.length).toBe(3);
    expect(state.checkoutQueries[2]?.get("targetScope")).toBe("ENTERPRISE");
    expect(state.checkoutQueries[2]?.get("enterpriseId")).toBe(enterpriseId);
    await expect(dialog.getByText("企业可分配 Token 余额")).toBeVisible();
    await expect(dialog.getByText("￥60.00", { exact: true })).toBeVisible();
    await expect(dialog.getByPlaceholder("请输入充值金额")).toHaveValue("268");
    await expect(dialog.getByRole("button", { name: "立即支付 ￥246.56" })).toBeEnabled();
  });

  test("支付成功后企业池刷新并回写到企业 Token 页面", async ({ page }) => {
    const state = createState();
    await openEnterpriseTokenPage(page, state);

    await page.getByRole("button", { name: /企业Token充值/u }).click();
    const dialog = rechargeDialog(page);

    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "200元 92折" }).click();
    await dialog.getByRole("button", { name: "立即支付 ￥184.00" }).click();

    await expect.poll(() => state.rechargeCreateRequests.length).toBe(1);
    expect(state.rechargeCreateRequests[0]).toMatchObject({
      amountFen: 20000,
      rechargePricingVersion: 1,
      targetScope: "ENTERPRISE",
      enterpriseId,
      entrySource: "ACCOUNT_DRAWER",
    });
    await expect(dialog.getByText("微信扫码支付", { exact: true })).toBeVisible();
    await expect(dialog.getByText("待支付", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "刷新状态" }).click();

    await expect.poll(() => state.rechargeRefreshRequests.length).toBe(1);
    expect(state.rechargeRefreshRequests[0]?.triggerSource).toBe("ORDER_PANEL");
    await expect.poll(() => state.pool.purchasedUsdUnits).toBe("30000000000");
    await expect.poll(() => state.pool.availableUsdUnits).toBe("26000000000");
    await expect(page.getByRole("dialog", { name: "Token充值" })).toBeHidden();
    await expect(page.locator(".enterprise-token-quota__metric").filter({ hasText: "累计购买" })).toContainText("￥300.00");
    await expect(page.locator(".enterprise-token-quota__metric").filter({ hasText: "可分配" })).toContainText("￥260.00");
  });
});
