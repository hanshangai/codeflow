import type { AccessContext, RelayQuotaItem } from "./account.js";
import type { PaymentCloseReason, PaymentFinalSource, PaymentOrderDetailView } from "./payment.js";

export const DEFAULT_RELAY_USD_TO_CNY_RATE = 1;
export const DEFAULT_RELAY_DISPLAY_RATE_MULTIPLIER = 0.2;
export const DEFAULT_RELAY_TOKEN_ESTIMATE_MODEL_LABEL = "GPT5.5";
export const DEFAULT_RELAY_TOKEN_ESTIMATE_TOKENS_PER_STANDARD_USD = 2_000_000;
export const RELAY_BALANCE_PACK_CUSTOM_SKU_CODE = "RELAY_BALANCE_PACK_CUSTOM";
export const RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MIN_FEN = 100;
export const RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MAX_FEN = 1_000_000;
export const RELAY_BALANCE_PACK_CUSTOM_AMOUNT_STEP_FEN = 100;
export const RELAY_RECHARGE_BASE_PRESET_AMOUNT_FEN = 1_000;
export const RELAY_RECHARGE_PRICING_TIER_COUNT = 5;
export const RELAY_RECHARGE_ACTIVITY_TEXT_MAX_LENGTH = 20;

export type RelayRechargePricingTierInput = {
  thresholdAmountFen: number;
  payPercent: number;
};

export type RelayRechargePricingTierView = RelayRechargePricingTierInput & {
  discountLabel: string;
};

export type RelayRechargePricingDraft = {
  /** 优惠总开关：关闭后所有充值档位按面额原价支付，阶梯配置仍需保持合法。 */
  discountEnabled: boolean;
  activityEnabled: boolean;
  activityText: string;
  tiers: RelayRechargePricingTierInput[];
};

export type RelayRechargePricingPublicView = RelayRechargePricingDraft & {
  version: number;
  basePresetAmountFen: number;
  tiers: RelayRechargePricingTierView[];
};

export type RelayRechargePricingQuote = {
  balanceAmountFen: number;
  paidAmountFen: number;
  savedAmountFen: number;
  payPercent: number;
  discountType: Extract<BillingDiscountType, "NONE" | "PERCENT_OFF">;
  discountValue: number;
  discountLabel: string;
  discountThresholdAmountFen: number | null;
};

export const DEFAULT_RELAY_RECHARGE_PRICING_TIERS = [
  { thresholdAmountFen: 5_000, payPercent: 98 },
  { thresholdAmountFen: 10_000, payPercent: 95 },
  { thresholdAmountFen: 20_000, payPercent: 92 },
  { thresholdAmountFen: 50_000, payPercent: 90 },
  { thresholdAmountFen: 100_000, payPercent: 88 },
] as const satisfies readonly RelayRechargePricingTierInput[];

export type BillingPlanType = "FREE" | "ENTERPRISE" | "PRIVATE_DEPLOY" | "RELAY_BALANCE_PACK";
export type BillingScopeType = "USER" | "ENTERPRISE" | "OFFLINE_LEAD";
export type BillingMode = "FREE" | "SUBSCRIPTION" | "SEAT_PACKAGE" | "OFFLINE" | "USAGE_PACK" | "ONE_TIME";
export type BillingCycle = "NONE" | "MONTH_1" | "MONTH_3" | "MONTH_6" | "MONTH_12" | "MONTH_24" | "CUSTOM";
export type BillingDiscountType = "NONE" | "PERCENT_OFF" | "DIRECT_MINUS";
export type BusinessOrderType = "NEW_PURCHASE" | "RENEWAL" | "TOP_UP";
export type BusinessOrderStatus =
  | "CREATED"
  | "PAYING"
  | "PAID"
  | "CANCELLED"
  | "TIMEOUT"
  | "FAILED";
export type BusinessOrderFulfillmentStatus = "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED";
export type CheckoutEntrySource = "PRICING" | "ACCOUNT_DRAWER" | "DIRECT_LINK";
export type OrderRefreshTriggerSource = "PAGE_REFRESH" | "ORDER_PANEL";

export type BillingPlanView = {
  planId: string;
  sourceVersionId: string | null;
  sourceVersionItemId: string | null;
  saleUnitKey: string;
  planCode: BillingPlanType;
  skuCode: string;
  planName: string;
  displayTitle: string;
  displayDescription: string;
  planType: BillingPlanType;
  scopeType: BillingScopeType;
  billingMode: BillingMode;
  billingCycle: BillingCycle;
  durationMonths: number;
  displayEnabled: boolean;
  purchaseEnabled: boolean;
  paymentRequired: boolean;
  paymentProductCode: string | null;
  priceFen: number | null;
  originalPriceFen: number | null;
  displayPriceText: string;
  discountType: BillingDiscountType;
  discountValue: number;
  discountLabel: string;
  isDefault: boolean;
  effectiveFrom: number | null;
  effectiveTo: number | null;
  orderScene: string;
  currency: string;
  benefits: string[];
  /** 展示层徽标文案（前端 UI 优先渲染），为空表示不展示徽标。 */
  pricingBadge: string | null;
  /** 展示层注释文案（前端 UI 优先渲染），为空表示不展示尾注。 */
  pricingNote: string | null;
  isActive: boolean;
  sortOrder: number;
  publishedAt: number;
};

export type BillingBusinessOrderView = {
  businessOrderId: string;
  planCode: BillingPlanType;
  skuCode: string;
  scopeType: BillingScopeType;
  saleUnitKeySnapshot: string;
  planVersionIdSnapshot: string | null;
  planVersionItemIdSnapshot: string | null;
  billingMode: BillingMode;
  orderType: BusinessOrderType;
  orderStatus: BusinessOrderStatus;
  fulfillmentStatus: BusinessOrderFulfillmentStatus;
  entrySource: CheckoutEntrySource;
  amountFen: number;
  originalPriceFen: number;
  discountType: BillingDiscountType;
  discountValue: number;
  discountLabel: string;
  currency: string;
  billingCycle: BillingCycle;
  durationMonths: number;
  title: string;
  description: string;
  paymentFinalSource: PaymentFinalSource | null;
  currentPaymentOrderId: string | null;
  paidAt: number | null;
  fulfilledAt: number | null;
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastFulfillErrorCode: string | null;
  lastFulfillErrorMessage: string | null;
  paymentOrder: PaymentOrderDetailView | null;
};

export type RelayBalanceCurrency = "CNY";
export type RelayQuotaUnit = "USD";
export type RelayBalancePackTargetScope = "USER" | "ENTERPRISE";

export type RelayBalancePackPlanView = BillingPlanView & {
  planCode: "RELAY_BALANCE_PACK";
  planType: "RELAY_BALANCE_PACK";
  scopeType: "USER";
  billingMode: "USAGE_PACK";
  billingCycle: "NONE";
  durationMonths: 0;
  priceFen: number;
  originalPriceFen: number;
  paymentProductCode: string;
  balanceAmountFen: number;
  displayCurrency: RelayBalanceCurrency;
  exchangeRateSnapshot: number;
  grantedQuotaUsd: number;
  quotaUnit: RelayQuotaUnit;
};

export type RelayBalancePackBusinessOrderView = BillingBusinessOrderView & {
  planCode: "RELAY_BALANCE_PACK";
  scopeType: RelayBalancePackTargetScope;
  billingMode: "USAGE_PACK";
  orderType: "TOP_UP";
  balanceAmountFen: number;
  paidAmountFen: number;
  rechargePricingVersion: number | null;
  discountThresholdAmountFen: number | null;
  displayCurrency: RelayBalanceCurrency;
  exchangeRateSnapshot: number;
  grantedQuotaUsd: number;
  quotaUnit: RelayQuotaUnit;
  targetQuotaUsd: number | null;
  targetEnterpriseId: string | null;
  relayQuotaItem: RelayQuotaItem | null;
};

export type RelayBalancePackCheckoutContextResponseBody = {
  planCode: "RELAY_BALANCE_PACK";
  plans: RelayBalancePackPlanView[];
  defaultSkuCode: string | null;
  selectedSkuCode: string | null;
  activeOrder: RelayBalancePackBusinessOrderView | null;
  paymentEnabled: boolean;
  disabledReason: string | null;
  rechargePricing: RelayRechargePricingPublicView | null;
  rechargePricingErrorCode: "RELAY_RECHARGE_PRICING_UNAVAILABLE" | null;
  accessContext: AccessContext;
};

export type RelayBalancePackCheckoutContextQuery = {
  targetScope?: RelayBalancePackTargetScope;
  enterpriseId?: string | null;
};

export type CreateRelayBalancePackBusinessOrderRequestBody = {
  /** 自定义 Token 充值金额，单位分；服务端不再接受固定套餐价格下单。 */
  amountFen?: number | null;
  /** 页面确认的充值价格配置版本；服务端按同版本重新报价。 */
  rechargePricingVersion: number;
  entrySource?: CheckoutEntrySource;
  /** 不传时兼容为个人充值；企业充值必须同时提供当前企业 ID。 */
  targetScope?: RelayBalancePackTargetScope;
  enterpriseId?: string | null;
};

export type CreateRelayBalancePackBusinessOrderResponseBody = {
  reused: boolean;
  order: RelayBalancePackBusinessOrderView;
  pollIntervalMs: number;
};

export type GetRelayBalancePackBusinessOrderDetailResponseBody = {
  order: RelayBalancePackBusinessOrderView;
};

export type RefreshRelayBalancePackBusinessOrderRequestBody = {
  triggerSource: OrderRefreshTriggerSource;
};

export type RefreshRelayBalancePackBusinessOrderResponseBody = {
  order: RelayBalancePackBusinessOrderView;
  nextVerifyAt: number | null;
  retriedFulfillment: boolean;
};

export type CancelRelayBalancePackBusinessOrderRequestBody = {
  reason?: PaymentCloseReason;
};

export type CancelRelayBalancePackBusinessOrderResponseBody = {
  order: RelayBalancePackBusinessOrderView;
  closeAccepted: boolean;
};
