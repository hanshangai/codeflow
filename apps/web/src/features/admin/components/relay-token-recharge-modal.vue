<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Modal, message } from "ant-design-vue";
import { ClockCircleOutlined, MoneyCollectOutlined, ReloadOutlined, SyncOutlined } from "@ant-design/icons-vue";
import QRCode from "qrcode";
import {
  calculateRelayRechargePricingQuote,
  DEFAULT_RELAY_USD_TO_CNY_RATE,
  RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MAX_FEN,
  RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MIN_FEN,
  RELAY_BALANCE_PACK_CUSTOM_AMOUNT_STEP_FEN,
  type CheckoutEntrySource,
  type RelayBalancePackBusinessOrderView,
  type RelayBalancePackCheckoutContextResponseBody,
  type RelayBalancePackTargetScope,
  type RelayEnterpriseBalancePoolResponseBody,
  type RelaySelfBalancesResponseBody,
  type RelayUsageItem,
} from "@codeflowai/shared";

import {
  getEnterpriseRelayBalancePool,
  getMyRelayBalances,
  getMyRelayUsage,
  syncMyRelayUsageSnapshots,
} from "../../../api/account";
import {
  cancelRelayBalancePackBusinessOrder,
  createRelayBalancePackBusinessOrder,
  getRelayBalancePackCheckoutContext,
  refreshRelayBalancePackBusinessOrder,
} from "../../../api/relay-token-package";
import { trackProductEvent } from "../../../analytics/analytics";
import {
  createCancelledRequestError,
  isCancelledRequestError,
  type AbortKind,
} from "../../../api/request";
import { useCodeFlowRelayPricing } from "../../../composables/useCodeFlowRelayPricing";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { formatRelayUsdUnitsAsYuan } from "../../account/relayUsdUnits";
import {
  buildRelayRechargePresetOptions,
  resolveRelayRechargeAmountBucket,
} from "../relayTokenRechargePricing";

defineOptions({ name: "RelayTokenRechargeModal" });

const props = withDefaults(defineProps<{
  disabledReason?: string | null;
  defaultTargetScope?: RelayBalancePackTargetScope;
  enterpriseId?: string | null;
  entrySource?: CheckoutEntrySource;
  formatDisplayText?: (value: unknown) => string;
  open: boolean;
}>(), {
  disabledReason: null,
  defaultTargetScope: "USER",
  enterpriseId: null,
  entrySource: "ACCOUNT_DRAWER",
  formatDisplayText: undefined,
});

const emit = defineEmits<{
  (event: "opened"): void;
  (event: "succeeded"): void;
  (event: "update:open", value: boolean): void;
}>();

const { ctx } = useApiContext();
const router = useRouter();
const config = useConfigStore();

const loading = ref(false);
const refreshing = ref(false);
const cancelling = ref(false);
const ordering = ref(false);
const lastTrackedOrderFailureKey = ref("");
const lastTrackedQrExpiredOrderId = ref("");
const customAmountYuan = ref<number | null>(null);
const checkoutContext = ref<RelayBalancePackCheckoutContextResponseBody | null>(null);
const order = ref<RelayBalancePackBusinessOrderView | null>(null);
const qrDataUrl = ref("");
const qrError = ref("");
const selfBalances = ref<RelaySelfBalancesResponseBody | null>(null);
const legacyPersonalUsage = ref<RelayUsageItem | null>(null);
const enterprisePool = ref<RelayEnterpriseBalancePoolResponseBody | null>(null);
const selectedTargetScope = ref<RelayBalancePackTargetScope>(props.defaultTargetScope);
const selfLoading = ref(false);
const checkoutLoadError = ref("");
const overviewLoadError = ref("");
const successShownOrderId = ref<string | null>(null);
const pollTimer = ref<number | null>(null);
const nowTick = ref(Date.now());
const {
  catalogLoaded: relayPriceCatalogLoaded,
  catalogErrorText: relayPriceLoadError,
  featuredPriceGroups: relayFeaturedPriceGroups,
  load: loadRelayPricing,
  loading: relayPriceLoading,
} = useCodeFlowRelayPricing();
type ModalRequestScope = {
  id: number;
  controller: AbortController;
};
type ModalRequestTask<T> = {
  scopeId: number;
  promise: Promise<T>;
};

let requestScopeSequence = 0;
let activeRequestScope: ModalRequestScope | null = null;
let checkoutLoadTask: ModalRequestTask<boolean> | null = null;
let selfOverviewLoadTask: ModalRequestTask<boolean> | null = null;
let refreshTask: ModalRequestTask<void> | null = null;
let selfOverviewRefreshTask: ModalRequestTask<boolean> | null = null;
let qrGenerationSequence = 0;
let countdownTimer: number | null = null;

const amountMinYuan = RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MIN_FEN / 100;
const amountMaxYuan = RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MAX_FEN / 100;
const amountStepYuan = RELAY_BALANCE_PACK_CUSTOM_AMOUNT_STEP_FEN / 100;
const loadError = computed(() => checkoutLoadError.value || overviewLoadError.value);
const serverDisabledReason = computed(() =>
  checkoutContext.value?.disabledReason ? resolveDisplayText(checkoutContext.value.disabledReason, "") : null,
);
const paymentOrder = computed(() => order.value?.paymentOrder ?? null);
const showQr = computed(() => paymentOrder.value?.status === "QR_READY" || paymentOrder.value?.status === "PAYING");
const hasOpenOrder = computed(() => Boolean(order.value && !isTerminalOrder(order.value)));
const countdownSeconds = computed(() => {
  const expiresAt = paymentOrder.value?.qrExpiresAt;
  if (!showQr.value || !expiresAt) return null;
  return Math.max(0, Math.ceil((expiresAt - nowTick.value) / 1000));
});
const countdownText = computed(() => {
  const value = countdownSeconds.value;
  if (value == null) return "";
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
});
const countdownWarning = computed(() => countdownSeconds.value !== null && countdownSeconds.value <= 60);
const pricingUnavailableReason = computed(() => (
  checkoutContext.value?.rechargePricingErrorCode
  && !checkoutContext.value.rechargePricing
  && !hasOpenOrder.value
  && !serverDisabledReason.value
    ? "Token 充值价格暂不可用，请重试"
    : null
));
const targetEnterpriseId = computed(() => String(props.enterpriseId ?? config.userSummary?.enterpriseId ?? "").trim() || null);
const canSelectEnterprise = computed(() => config.accountRole === "enterprise_admin" && Boolean(targetEnterpriseId.value));
const targetScopeOptions = computed(() => canSelectEnterprise.value
  ? [
      { label: "个人账户", value: "USER" },
      { label: `企业账户：${config.userSummary?.enterpriseName || "当前企业"}`, value: "ENTERPRISE" },
    ]
  : [{ label: "个人账户", value: "USER" }]);
const balanceLabel = computed(() => selectedTargetScope.value === "ENTERPRISE" ? "企业可分配 Token 余额" : "个人 Token 余额");
const remainingText = computed(() => selectedTargetScope.value === "ENTERPRISE"
  ? enterprisePool.value
    ? formatRelayUsdUnitsAsYuan(enterprisePool.value.availableUsdUnits)
    : "-"
  : selfBalances.value?.personal
    ? formatRelayUsdUnitsAsYuan(selfBalances.value.personal.availableUsdUnits)
    : formatLegacyPersonalBalance(legacyPersonalUsage.value));
const customAmountFen = computed(() => {
  const amountYuan = customAmountYuan.value;
  if (amountYuan == null) return null;
  const value = Number(amountYuan);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
});
const amountValidationMessage = computed(() => validateCustomAmountFen(customAmountFen.value));
const rechargePricing = computed(() => checkoutContext.value?.rechargePricing ?? null);
const presetAmountOptions = computed(() => rechargePricing.value
  ? buildRelayRechargePresetOptions(rechargePricing.value)
  : []);
const rechargeQuote = computed(() => {
  const pricing = rechargePricing.value;
  const amountFen = customAmountFen.value;
  if (!pricing || amountFen == null || amountValidationMessage.value) return null;
  return calculateRelayRechargePricingQuote(amountFen, pricing.tiers, pricing.discountEnabled);
});
const activityText = computed(() => {
  const pricing = rechargePricing.value;
  // 仅取显式 false 作为"已关闭"：该字段缺失（接口版本错配）时保留原有活动展示口径，
  // 与同一份 pricing 的报价结果保持同步——缺少该字段时报价仍按有折扣处理，文案不能先消失。
  if (!pricing || pricing.discountEnabled === false) return "";
  return pricing.activityEnabled ? pricing.activityText.trim() : "";
});
const canSubmitOrder = computed(() => Boolean(
  props.open
  && checkoutContext.value
  && rechargePricing.value
  && rechargeQuote.value
  && !loading.value
  && !selfLoading.value
  && !loadError.value
  && !serverDisabledReason.value
  && !amountValidationMessage.value
  && !ordering.value
  && !refreshing.value
  && !cancelling.value,
));

/** 按调用方需要转换错误文案，未提供转换器时保留原文。 */
function resolveDisplayText(value: unknown, fallback: string): string {
  const text = props.formatDisplayText
    ? props.formatDisplayText(value)
    : value == null ? "" : String(value);
  return text || fallback;
}

/** 格式化人民币分值，统一用于充值面额、节省金额和实际支付金额。 */
function formatPriceFen(value: number): string {
  return `￥${(Number(value ?? 0) / 100).toFixed(2)}`;
}

/** 精确个人当前态为空时读取历史余额；历史记录也不存在则按零余额展示。 */
function formatLegacyPersonalBalance(item: RelayUsageItem | null): string {
  if (!item) return "￥0.00";
  const balance = Number(item.quota ?? 0);
  return Number.isFinite(balance) ? `￥${(balance * DEFAULT_RELAY_USD_TO_CNY_RATE).toFixed(2)}` : "-";
}

/** 校验已输入的充值金额；空值仅禁用支付，不展示冗余提示。 */
function validateCustomAmountFen(value: number | null): string {
  if (value == null) return "";
  if (!Number.isSafeInteger(value)) return "充值金额格式不正确";
  if (value < RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MIN_FEN) return `单次最低充值 ${formatPriceFen(RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MIN_FEN)}`;
  if (value > RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MAX_FEN) return `单次最高充值 ${formatPriceFen(RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MAX_FEN)}`;
  if (value % RELAY_BALANCE_PACK_CUSTOM_AMOUNT_STEP_FEN !== 0) return "充值金额必须按整元递增";
  return "";
}

/** 选择常用充值面额，只回填输入框，不直接创建订单。 */
function selectPresetAmount(amountFen: number): void {
  customAmountYuan.value = amountFen / 100;
  trackProductEvent("token_recharge_preset_select", {
    entry_source: props.entrySource,
    amount_bucket: resolveAmountBucketFromFen(amountFen),
  });
}

/** 将分值金额转换为充值金额分组。 */
function resolveAmountBucketFromFen(value: number | null | undefined): string {
  return resolveRelayRechargeAmountBucket(value, presetAmountOptions.value);
}

/** 读取订单快照节省金额，历史无折扣订单自然返回零。 */
function resolveOrderSavedAmountFen(value: RelayBalancePackBusinessOrderView): number {
  return Math.max(0, value.balanceAmountFen - value.paidAmountFen);
}

/** 判断订单是否已经支付且 token 已到账。 */
function isPaidSucceeded(value: RelayBalancePackBusinessOrderView | null): boolean {
  return Boolean(value && value.orderStatus === "PAID" && value.fulfillmentStatus === "SUCCEEDED");
}

/** 判断订单是否已经进入不可继续轮询的终态。 */
function isTerminalOrder(value: RelayBalancePackBusinessOrderView | null): boolean {
  if (!value) return false;
  return value.orderStatus === "CANCELLED"
    || value.orderStatus === "TIMEOUT"
    || value.orderStatus === "FAILED"
    || isPaidSucceeded(value);
}

/** 判断订单是否需要继续刷新支付或到账状态。 */
function shouldPollOrder(value: RelayBalancePackBusinessOrderView | null): boolean {
  if (!value || isTerminalOrder(value)) return false;
  const status = value.paymentOrder?.status;
  return status === "QR_READY"
    || status === "PAYING"
    || (value.orderStatus === "PAID" && value.fulfillmentStatus !== "SUCCEEDED");
}

/** 展示支付和到账状态，避免把已支付未到账误读为未支付。 */
function orderStatusText(value: RelayBalancePackBusinessOrderView | null): string {
  if (!value) return "待创建订单";
  if (value.orderStatus === "PAID" && value.fulfillmentStatus === "SUCCEEDED") return "已到账";
  if (value.orderStatus === "PAID") return "充值结果确认中";
  if (value.paymentOrder?.status === "PAYING") return "支付中";
  if (value.paymentOrder?.status === "QR_READY") return "待支付";
  if (value.orderStatus === "CANCELLED") return "已取消";
  if (value.orderStatus === "TIMEOUT") return "已超时";
  if (value.orderStatus === "FAILED") return "支付失败";
  return "待支付";
}

/** 根据订单状态给状态标签选择视觉权重。 */
function orderStatusColor(value: RelayBalancePackBusinessOrderView | null): string {
  if (!value) return "default";
  if (value.orderStatus === "PAID" && value.fulfillmentStatus === "SUCCEEDED") return "green";
  if (value.orderStatus === "PAID" || value.paymentOrder?.status === "PAYING") return "blue";
  if (value.paymentOrder?.status === "QR_READY") return "orange";
  if (value.orderStatus === "CANCELLED" || value.orderStatus === "TIMEOUT") return "default";
  if (value.orderStatus === "FAILED") return "red";
  return "orange";
}

/** 解释非扫码状态，避免取消/超时订单继续占用二维码区域。 */
function orderHint(value: RelayBalancePackBusinessOrderView | null): string {
  if (!value) return "";
  if (value.orderStatus === "CANCELLED") return "订单已取消，可重新输入金额充值。";
  if (value.orderStatus === "TIMEOUT") return "订单已超时，可重新创建订单。";
  if (value.orderStatus === "FAILED") return "支付失败，请重新创建订单。";
  if (value.orderStatus === "PAID" && value.fulfillmentStatus === "SUCCEEDED") return "token已到账。";
  if (value.orderStatus === "PAID") return "支付已确认，正在确认充值结果。";
  return "当前订单暂无可用二维码，请刷新状态或重新创建订单。";
}

/** 判断异步结果是否仍属于当前打开的充值作用域。 */
function isCurrentRequestScope(scope: ModalRequestScope): boolean {
  return props.open && activeRequestScope?.id === scope.id && !scope.controller.signal.aborted;
}

/** 清除订单和余额真值；账户切换时可保留用户已输入的充值面额。 */
function resetModalTruth(options: { preserveAmount?: boolean } = {}): void {
  checkoutContext.value = null;
  order.value = null;
  clearOverviewTruth();
  checkoutLoadError.value = "";
  overviewLoadError.value = "";
  if (!options.preserveAmount) customAmountYuan.value = null;
  qrDataUrl.value = "";
  qrError.value = "";
  loading.value = false;
  selfLoading.value = false;
  refreshing.value = false;
  cancelling.value = false;
  ordering.value = false;
  checkoutLoadTask = null;
  selfOverviewLoadTask = null;
  refreshTask = null;
  selfOverviewRefreshTask = null;
  qrGenerationSequence += 1;
}

/** 清除当前余额展示真值，读取失败时不得继续展示旧资金事实。 */
function clearOverviewTruth(): void {
  selfBalances.value = null;
  legacyPersonalUsage.value = null;
  enterprisePool.value = null;
}

/** 终止当前作用域请求并使所有迟到结果失效。 */
function invalidateRequestScope(kind: AbortKind): void {
  activeRequestScope?.controller.abort(createCancelledRequestError(kind));
  activeRequestScope = null;
  requestScopeSequence += 1;
  clearPolling();
}

/** 为本次打开或账户切换创建唯一请求作用域。 */
function beginRequestScope(options: { preserveAmount?: boolean } = {}): ModalRequestScope {
  invalidateRequestScope("scope-change");
  resetModalTruth(options);
  const scope = {
    id: ++requestScopeSequence,
    controller: new AbortController(),
  };
  activeRequestScope = scope;
  return scope;
}

/** 清理订单轮询，关闭弹窗或订单终态时调用。 */
function clearPolling(): void {
  if (pollTimer.value !== null) {
    window.clearTimeout(pollTimer.value);
    pollTimer.value = null;
  }
}

/** 只记录一次订单终态失败，避免轮询反复上报同一订单。 */
function trackOrderFailure(value: RelayBalancePackBusinessOrderView | null, reason: "payment_failed" | "fulfillment_failed" | "order_timeout"): void {
  if (!value) return;
  const key = `${value.businessOrderId}:${value.orderStatus}:${value.fulfillmentStatus}:${reason}`;
  if (lastTrackedOrderFailureKey.value === key) return;
  lastTrackedOrderFailureKey.value = key;
  trackProductEvent("token_recharge_failed", {
    entry_source: props.entrySource,
    target_scope: selectedTargetScope.value,
    error_code_group: reason,
  });
}

/** 清理支付二维码倒计时，避免弹窗关闭后继续更新。 */
function clearCountdown(): void {
  if (countdownTimer === null) return;
  window.clearInterval(countdownTimer);
  countdownTimer = null;
}

/** 按服务端状态安排下一次订单刷新。 */
function schedulePolling(delayMs = 5000): void {
  clearPolling();
  if (!props.open || cancelling.value) return;
  if (!shouldPollOrder(order.value)) return;
  pollTimer.value = window.setTimeout(() => {
    void refreshOrder(false);
  }, Math.max(1500, delayMs));
}

/** 等待短暂间隔后重试订单操作；作用域失效时同步释放计时器。 */
function waitActionDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? createCancelledRequestError("scope-change"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? createCancelledRequestError("scope-change"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 显示到账成功弹窗，并确保同一订单只提示一次。 */
function showSuccessModal(value: RelayBalancePackBusinessOrderView): void {
  if (successShownOrderId.value === value.businessOrderId) return;
  successShownOrderId.value = value.businessOrderId;
  trackProductEvent("token_recharge_success", {
    entry_source: props.entrySource,
    amount_bucket: resolveAmountBucketFromFen(value.balanceAmountFen),
  });
  Modal.success({
    title: "购买成功",
    content: `Token充值已到账。${balanceLabel.value}：${remainingText.value}`,
    okText: "知道了",
  });
}

/** 处理订单到账后的余额刷新、成功提示和父页面刷新。 */
async function handleSucceeded(value: RelayBalancePackBusinessOrderView, scope: ModalRequestScope): Promise<void> {
  if (!isPaidSucceeded(value)) return;
  await refreshSelfOverview(false, scope);
  if (!isCurrentRequestScope(scope)) return;
  emit("succeeded");
  showSuccessModal(value);
  closeModal();
}

/** 打开统一 token 购买弹框；企业成员仍按个人身份购买。 */
async function handleOpened(): Promise<void> {
  if (props.disabledReason) {
    message.warning(resolveDisplayText(props.disabledReason, props.disabledReason));
    closeModal();
    return;
  }
  if (!config.isAccountSession) {
    message.info("请先登录账号后再进行Token充值");
    closeModal();
    return;
  }
  selectedTargetScope.value = props.defaultTargetScope === "ENTERPRISE" && canSelectEnterprise.value ? "ENTERPRISE" : "USER";
  const scope = beginRequestScope();
  emit("opened");
  trackProductEvent("token_recharge_open", {
    entry_source: props.entrySource,
    target_scope: selectedTargetScope.value,
  });
  void loadRelayPricing(ctx.value);
  await Promise.all([loadCheckoutContext(scope), loadSelfOverview(scope)]);
  if (isCurrentRequestScope(scope)) void refreshSelfOverview(false, scope);
}

/** 关闭购买弹框并取消本轮请求，订单真源由下次打开时重新读取。 */
function closeModal(): void {
  invalidateRequestScope("scope-change");
  resetModalTruth();
  emit("update:open", false);
}

/** 重新读取当前作用域的购买上下文和余额真值。 */
async function reloadCurrentScope(): Promise<void> {
  const scope = activeRequestScope;
  if (!scope || !isCurrentRequestScope(scope) || ordering.value || refreshing.value || cancelling.value) return;
  await Promise.all([loadCheckoutContext(scope), loadSelfOverview(scope)]);
}

/** 应用内跳转模型价格面板，避免打开外部浏览器标签页。 */
function openRelayPriceConfig(): void {
  closeModal();
  void router.push({ path: "/admin", query: { panel: "relay-price-config" } });
}

/** 读取 token 购买上下文和当前可复用订单。 */
async function loadCheckoutContext(scope: ModalRequestScope): Promise<boolean> {
  if (!isCurrentRequestScope(scope)) return false;
  if (checkoutLoadTask?.scopeId === scope.id) return await checkoutLoadTask.promise;
  loading.value = true;
  checkoutContext.value = null;
  order.value = null;
  checkoutLoadError.value = "";
  clearPolling();
  const promise = (async (): Promise<boolean> => {
    try {
      const result = await getRelayBalancePackCheckoutContext(ctx.value, {
        targetScope: selectedTargetScope.value,
        enterpriseId: selectedTargetScope.value === "ENTERPRISE" ? targetEnterpriseId.value : null,
      }, {
        signal: scope.controller.signal,
      });
      if (!isCurrentRequestScope(scope)) return false;
      if (!result.ok) {
        checkoutLoadError.value = resolveDisplayText(result.message, "购买上下文加载失败");
        message.error(checkoutLoadError.value);
        return false;
      }
      checkoutContext.value = result;
      order.value = result.activeOrder;
      schedulePolling();
      return true;
    } catch (error) {
      if (isCancelledRequestError(error) || !isCurrentRequestScope(scope)) return false;
      checkoutLoadError.value = resolveDisplayText(error instanceof Error ? error.message : error, "购买上下文加载失败");
      message.error(checkoutLoadError.value);
      return false;
    }
  })();
  checkoutLoadTask = { scopeId: scope.id, promise };
  try {
    return await promise;
  } finally {
    if (checkoutLoadTask?.promise === promise) {
      checkoutLoadTask = null;
      if (isCurrentRequestScope(scope)) loading.value = false;
    }
  }
}

/** 按当前充值目标加载个人精确余额或企业池当前态。 */
async function loadSelfOverview(scope: ModalRequestScope): Promise<boolean> {
  if (!isCurrentRequestScope(scope)) return false;
  if (selfOverviewLoadTask?.scopeId === scope.id) return await selfOverviewLoadTask.promise;
  selfLoading.value = true;
  clearOverviewTruth();
  overviewLoadError.value = "";
  const targetScope = selectedTargetScope.value;
  const promise = (async (): Promise<boolean> => {
    try {
      const [balancesResult, usageResult] = await Promise.all([
        getMyRelayBalances(ctx.value, { signal: scope.controller.signal }),
        targetScope === "USER"
          ? getMyRelayUsage(ctx.value, { includeCosts: false, snapshotOnly: true }, { signal: scope.controller.signal })
          : null,
      ]);
      if (!isCurrentRequestScope(scope)) return false;
      if (!balancesResult.ok) {
        clearOverviewTruth();
        overviewLoadError.value = resolveDisplayText(balancesResult.message, "Token余额加载失败");
        message.error(overviewLoadError.value);
        return false;
      }
      if (usageResult && !usageResult.ok) {
        clearOverviewTruth();
        overviewLoadError.value = resolveDisplayText(usageResult.message, "历史 Token 余额加载失败");
        message.error(overviewLoadError.value);
        return false;
      }
      let poolResult: RelayEnterpriseBalancePoolResponseBody | null = null;
      if (targetScope === "ENTERPRISE") {
        const result = await getEnterpriseRelayBalancePool(ctx.value, { signal: scope.controller.signal });
        if (!isCurrentRequestScope(scope)) return false;
        if (!result.ok) {
          clearOverviewTruth();
          overviewLoadError.value = resolveDisplayText(result.message, "企业 Token 余额加载失败");
          message.error(overviewLoadError.value);
          return false;
        }
        poolResult = result;
      }
      if (!isCurrentRequestScope(scope)) return false;
      selfBalances.value = balancesResult;
      legacyPersonalUsage.value = usageResult?.item ?? null;
      enterprisePool.value = poolResult;
      return true;
    } catch (error) {
      if (isCancelledRequestError(error) || !isCurrentRequestScope(scope)) return false;
      clearOverviewTruth();
      overviewLoadError.value = resolveDisplayText(error instanceof Error ? error.message : error, "Token余额加载失败");
      message.error(overviewLoadError.value);
      return false;
    }
  })();
  selfOverviewLoadTask = { scopeId: scope.id, promise };
  try {
    return await promise;
  } finally {
    if (selfOverviewLoadTask?.promise === promise) {
      selfOverviewLoadTask = null;
      if (isCurrentRequestScope(scope) && selfOverviewRefreshTask?.scopeId !== scope.id) selfLoading.value = false;
    }
  }
}

/** 后台刷新中转余额快照，再回读本地快照更新弹窗展示。 */
async function refreshSelfOverview(manual: boolean, requestedScope?: ModalRequestScope): Promise<boolean> {
  const scope = requestedScope ?? activeRequestScope;
  if (!scope || !isCurrentRequestScope(scope)) return false;
  if (selfOverviewRefreshTask?.scopeId === scope.id) {
    if (manual) message.info("Token余额正在刷新，请稍后操作");
    return await selfOverviewRefreshTask.promise;
  }
  selfLoading.value = true;
  const promise = (async (): Promise<boolean> => {
    if (selfOverviewLoadTask?.scopeId === scope.id) await selfOverviewLoadTask.promise;
    if (!isCurrentRequestScope(scope)) return false;
    if (selectedTargetScope.value === "USER") {
      const syncResult = await syncMyRelayUsageSnapshots(
        ctx.value,
        { includeCosts: false },
        { signal: scope.controller.signal },
      );
      if (!isCurrentRequestScope(scope)) return false;
      if (!syncResult.ok) {
        clearOverviewTruth();
        overviewLoadError.value = resolveDisplayText(syncResult.message, "Token余额刷新失败");
        message.warning(overviewLoadError.value);
        return false;
      }
    }
    const loaded = await loadSelfOverview(scope);
    if (loaded && manual && isCurrentRequestScope(scope)) message.success("Token余额已刷新");
    return loaded;
  })();
  selfOverviewRefreshTask = { scopeId: scope.id, promise };
  try {
    return await promise;
  } catch (error) {
    if (isCancelledRequestError(error) || !isCurrentRequestScope(scope)) return false;
    clearOverviewTruth();
    overviewLoadError.value = resolveDisplayText(error instanceof Error ? error.message : error, "Token余额刷新失败");
    message.warning(overviewLoadError.value);
    return false;
  } finally {
    if (selfOverviewRefreshTask?.promise === promise) {
      selfOverviewRefreshTask = null;
      if (isCurrentRequestScope(scope)) selfLoading.value = false;
    }
  }
}

/** 创建或复用当前用户的自定义金额 token 订单。 */
async function submitOrder(): Promise<void> {
  const scope = activeRequestScope;
  if (ordering.value || refreshing.value || cancelling.value) {
    message.info("订单操作正在处理，请稍后操作");
    return;
  }
  if (loading.value || selfLoading.value) {
    message.info("充值信息正在加载，请稍后操作");
    return;
  }
  if (loadError.value) {
    message.warning("充值信息加载失败，请先重试");
    return;
  }
  if (!scope || !isCurrentRequestScope(scope) || !checkoutContext.value) {
    message.warning("购买上下文尚未加载，请先重试");
    return;
  }
  if (serverDisabledReason.value) {
    message.warning(serverDisabledReason.value);
    return;
  }
  const pricing = rechargePricing.value;
  if (!pricing) {
    message.warning("Token 充值价格暂不可用，请先重试");
    return;
  }
  const amountFen = customAmountFen.value;
  const validationMessage = validateCustomAmountFen(amountFen);
  if (validationMessage || amountFen == null) {
    message.warning(validationMessage || "请输入充值金额");
    return;
  }
  if (hasOpenOrder.value && order.value?.balanceAmountFen !== amountFen) {
    message.warning("请先取消当前待支付订单，再输入其他充值金额。");
    return;
  }
  ordering.value = true;
  try {
    const result = await createRelayBalancePackBusinessOrder(ctx.value, {
      amountFen,
      rechargePricingVersion: pricing.version,
      entrySource: props.entrySource,
      targetScope: selectedTargetScope.value,
      enterpriseId: selectedTargetScope.value === "ENTERPRISE" ? targetEnterpriseId.value : null,
    }, {
      signal: scope.controller.signal,
    });
    if (!isCurrentRequestScope(scope)) return;
    if (!result.ok) {
      if (result.code === "RELAY_RECHARGE_PRICING_CHANGED" || result.code === "RELAY_RECHARGE_UI_OUTDATED") {
        const reloaded = await loadCheckoutContext(scope);
        if (reloaded && isCurrentRequestScope(scope)) message.warning("充值优惠已更新，请确认实付金额后重新支付");
        return;
      }
      message.error(resolveDisplayText(result.message, "token下单失败"));
      trackProductEvent("token_recharge_failed", {
        entry_source: props.entrySource,
        target_scope: selectedTargetScope.value,
        error_code_group: "request_rejected",
      });
      return;
    }
    order.value = result.order;
    trackProductEvent("token_recharge_submit", {
      entry_source: props.entrySource,
      target_scope: selectedTargetScope.value,
      amount_bucket: resolveAmountBucketFromFen(amountFen),
      reused: result.reused,
      order_status: result.order.orderStatus,
      fulfillment_status: result.order.fulfillmentStatus,
    });
    message.success(result.reused ? "已复用待支付订单" : "订单已创建");
    await handleSucceeded(result.order, scope);
    schedulePolling(result.pollIntervalMs || 5000);
  } catch (error) {
    if (isCancelledRequestError(error) || !isCurrentRequestScope(scope)) return;
    trackProductEvent("token_recharge_failed", {
      entry_source: props.entrySource,
      target_scope: selectedTargetScope.value,
      error_code_group: "request_error",
    });
    message.error(resolveDisplayText(error instanceof Error ? error.message : error, "token下单失败"));
  } finally {
    if (isCurrentRequestScope(scope)) ordering.value = false;
  }
}

/** 切换充值账户后读取该作用域自己的未终态订单和余额。 */
async function handleTargetScopeChange(value: string | number): Promise<void> {
  if (ordering.value || refreshing.value || cancelling.value) {
    message.info("订单操作正在处理，请稍后切换充值账户");
    return;
  }
  const nextScope: RelayBalancePackTargetScope = value === "ENTERPRISE" && canSelectEnterprise.value ? "ENTERPRISE" : "USER";
  if (selectedTargetScope.value === nextScope) return;
  selectedTargetScope.value = nextScope;
  const scope = beginRequestScope({ preserveAmount: true });
  await Promise.all([loadCheckoutContext(scope), loadSelfOverview(scope)]);
}

/** 刷新 token 订单状态；仅手动刷新向按钮暴露 loading。 */
async function refreshOrder(manual: boolean): Promise<void> {
  const scope = activeRequestScope;
  if (!scope || !isCurrentRequestScope(scope)) return;
  if (ordering.value || cancelling.value) {
    if (manual) message.info("订单操作正在处理，请稍后刷新");
    return;
  }
  if (refreshTask?.scopeId === scope.id) {
    if (!manual) {
      await refreshTask.promise;
      return;
    }
    refreshing.value = true;
    try {
      await refreshTask.promise;
    } finally {
      if (isCurrentRequestScope(scope)) refreshing.value = false;
    }
    return;
  }
  const currentOrder = order.value;
  if (!currentOrder) return;
  clearPolling();
  if (manual) refreshing.value = true;
  let refreshSucceeded = false;
  const promise = (async () => {
    const result = await refreshRelayBalancePackBusinessOrder(ctx.value, currentOrder.businessOrderId, {
      triggerSource: manual ? "ORDER_PANEL" : "PAGE_REFRESH",
    }, {
      signal: scope.controller.signal,
    });
    if (!isCurrentRequestScope(scope)) return;
    if (!result.ok) {
      checkoutContext.value = null;
      order.value = null;
      checkoutLoadError.value = resolveDisplayText(result.message, "订单状态刷新失败");
      message.error(checkoutLoadError.value);
      return;
    }
    order.value = result.order;
    refreshSucceeded = true;
    if (result.order.orderStatus === "FAILED") trackOrderFailure(result.order, "payment_failed");
    if (result.order.orderStatus === "TIMEOUT") trackOrderFailure(result.order, "order_timeout");
    if (result.order.orderStatus === "PAID" && result.order.fulfillmentStatus === "FAILED") {
      trackOrderFailure(result.order, "fulfillment_failed");
    }
    if (isPaidSucceeded(result.order)) {
      await handleSucceeded(result.order, scope);
    } else if (manual) {
      message.success("订单状态已刷新");
    }
  })();
  refreshTask = { scopeId: scope.id, promise };
  try {
    await promise;
  } catch (error) {
    if (isCancelledRequestError(error) || !isCurrentRequestScope(scope)) return;
    checkoutContext.value = null;
    order.value = null;
    checkoutLoadError.value = resolveDisplayText(error instanceof Error ? error.message : error, "订单状态刷新失败");
    message.error(checkoutLoadError.value);
  } finally {
    if (manual && isCurrentRequestScope(scope)) refreshing.value = false;
    if (refreshTask?.promise === promise) refreshTask = null;
    if (refreshSucceeded && isCurrentRequestScope(scope) && !cancelling.value) schedulePolling();
  }
}

/** 取消未完成的 token 订单。 */
async function cancelOrder(): Promise<void> {
  const scope = activeRequestScope;
  if (!scope || !isCurrentRequestScope(scope)) return;
  if (ordering.value || cancelling.value) {
    message.info("订单操作正在处理，请稍后取消");
    return;
  }
  const currentOrder = order.value;
  if (!currentOrder) return;
  cancelling.value = true;
  clearPolling();
  try {
    if (refreshTask?.scopeId === scope.id) await refreshTask.promise;
    if (!isCurrentRequestScope(scope)) return;
    const latestOrder = order.value;
    if (!latestOrder) return;
    if (latestOrder.orderStatus === "PAID") {
      message.info("订单已支付，正在同步token，不能取消");
      return;
    }
    if (isTerminalOrder(latestOrder)) {
      message.info("订单状态已更新，无需取消");
      return;
    }
    await submitCancel(latestOrder.businessOrderId, true, scope);
  } catch (error) {
    if (isCancelledRequestError(error) || !isCurrentRequestScope(scope)) return;
    trackProductEvent("token_recharge_cancel", {
      entry_source: props.entrySource,
      target_scope: selectedTargetScope.value,
      status: "failed",
      error_code_group: "request_error",
    });
    message.error(resolveDisplayText(error instanceof Error ? error.message : error, "取消订单失败"));
  } finally {
    if (isCurrentRequestScope(scope)) {
      cancelling.value = false;
      schedulePolling();
    }
  }
}

/** 发起取消订单；遇到后端核验锁时短暂重试一次。 */
async function submitCancel(businessOrderId: string, allowRetry: boolean, scope: ModalRequestScope): Promise<void> {
  const result = await cancelRelayBalancePackBusinessOrder(
    ctx.value,
    businessOrderId,
    { reason: "USER_CANCELLED" },
    { signal: scope.controller.signal },
  );
  if (!isCurrentRequestScope(scope)) return;
  if (!result.ok) {
    if (allowRetry && result.code === "PAYMENT_VERIFY_IN_PROGRESS") {
      await waitActionDelay(1200, scope.controller.signal);
      if (!isCurrentRequestScope(scope)) return;
      await submitCancel(businessOrderId, false, scope);
      return;
    }
    message.error(result.code === "PAYMENT_VERIFY_IN_PROGRESS" ? "订单正在核验，请稍后再取消" : resolveDisplayText(result.message, "取消订单失败"));
    trackProductEvent("token_recharge_cancel", {
      entry_source: props.entrySource,
      target_scope: selectedTargetScope.value,
      status: "failed",
      error_code_group: result.code === "PAYMENT_VERIFY_IN_PROGRESS" ? "payment_verifying" : "request_rejected",
    });
    return;
  }
  order.value = result.order;
  if (isPaidSucceeded(result.order)) {
    message.info("订单已支付且Token已到账");
    await handleSucceeded(result.order, scope);
    return;
  }
  if (result.order.orderStatus === "PAID") {
    message.info("订单已支付，正在同步token，不能取消");
    return;
  }
  if (result.order.orderStatus === "CANCELLED") {
    clearPolling();
    message.success("订单已取消");
    trackProductEvent("token_recharge_cancel", {
      entry_source: props.entrySource,
      target_scope: selectedTargetScope.value,
      status: "success",
    });
    return;
  }
  if (isTerminalOrder(result.order)) {
    clearPolling();
    message.info(`订单已进入${orderStatusText(result.order)}状态`);
    return;
  }
  message.warning(result.closeAccepted ? "取消结果正在确认，将继续刷新订单状态" : "支付渠道未确认取消，将继续刷新订单状态");
}

onUnmounted(() => {
  invalidateRequestScope("component-unmount");
  clearCountdown();
  resetModalTruth();
});

watch(
  () => props.open,
  (visible) => {
    if (visible) {
      void handleOpened();
    } else {
      invalidateRequestScope("scope-change");
      resetModalTruth();
    }
  },
);

watch(
  () => [props.open, paymentOrder.value?.qrExpiresAt ?? null, showQr.value] as const,
  ([visible, expiresAt, qrVisible]) => {
    clearCountdown();
    nowTick.value = Date.now();
    if (!visible || !qrVisible || !expiresAt) return;
    countdownTimer = window.setInterval(() => {
      nowTick.value = Date.now();
      if (nowTick.value >= expiresAt) {
        clearCountdown();
        const orderId = String(order.value?.businessOrderId ?? "");
        if (orderId && lastTrackedQrExpiredOrderId.value !== orderId) {
          lastTrackedQrExpiredOrderId.value = orderId;
          trackProductEvent("token_recharge_qr_expired", {
            entry_source: props.entrySource,
            target_scope: selectedTargetScope.value,
            error_code_group: "qr_expired",
          });
        }
      }
    }, 1000);
  },
  { immediate: true },
);

watch(
  () => [paymentOrder.value?.codeUrl ?? "", showQr.value] as const,
  async ([codeUrl, visible]) => {
    const generation = ++qrGenerationSequence;
    if (!visible || !codeUrl) {
      qrDataUrl.value = "";
      qrError.value = "";
      return;
    }
    try {
      const dataUrl = await QRCode.toDataURL(codeUrl, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 216,
        color: { dark: "#111827", light: "#ffffff" },
      });
      if (generation !== qrGenerationSequence || paymentOrder.value?.codeUrl !== codeUrl || !showQr.value) return;
      qrDataUrl.value = dataUrl;
      qrError.value = "";
    } catch (error) {
      if (generation !== qrGenerationSequence || paymentOrder.value?.codeUrl !== codeUrl || !showQr.value) return;
      qrDataUrl.value = "";
      qrError.value = error instanceof Error ? error.message : "二维码生成失败";
    }
  },
);
</script>

<template>
  <a-modal
    :open="props.open"
    title="Token充值"
    :footer="null"
    :width="820"
    :body-style="{ maxHeight: 'calc(100vh - 160px)', overflowY: 'auto' }"
    @cancel="closeModal"
  >
    <div class="relay-token-pack">
      <a-alert
        v-if="serverDisabledReason"
        type="warning"
        show-icon
        :message="serverDisabledReason"
      />
      <a-alert v-if="pricingUnavailableReason" type="error" show-icon :message="pricingUnavailableReason">
        <template #action>
          <a-button size="small" :loading="loading" @click="reloadCurrentScope">
            <template #icon><ReloadOutlined /></template>
            重试
          </a-button>
        </template>
      </a-alert>
      <a-alert v-if="loadError" type="error" show-icon :message="loadError">
        <template #action>
          <a-button
            size="small"
            :loading="loading || selfLoading"
            :disabled="ordering || refreshing || cancelling"
            @click="reloadCurrentScope"
          >
            <template #icon><ReloadOutlined /></template>
            重试
          </a-button>
        </template>
      </a-alert>

      <section v-if="canSelectEnterprise" class="relay-token-pack__target">
        <span>充值账户</span>
        <a-segmented
          :value="selectedTargetScope"
          :options="targetScopeOptions"
          block
          :disabled="loading || ordering || refreshing || cancelling"
          @change="handleTargetScopeChange"
        />
      </section>

      <section class="relay-token-pack__overview">
        <div class="relay-token-pack__overview-header">
          <div class="relay-token-pack__balance">
            <span>{{ balanceLabel }}</span>
            <strong>{{ remainingText }}</strong>
          </div>
          <div class="relay-token-pack__overview-actions">
            <a-button
              size="small"
              :loading="selfLoading"
              :disabled="loading || ordering || refreshing || cancelling"
              @click="refreshSelfOverview(true)"
            >
              <template #icon><SyncOutlined /></template>
              刷新
            </a-button>
          </div>
        </div>
      </section>

      <section class="relay-token-pack__section">
        <div class="relay-token-pack__section-header">
          <strong>{{ hasOpenOrder ? "微信扫码支付" : "充值金额" }}</strong>
        </div>
        <div
          class="relay-token-pack__purchase-grid"
          :class="{ 'relay-token-pack__purchase-grid--payment': hasOpenOrder }"
        >
          <div v-if="!hasOpenOrder" class="relay-token-pack__amount-card">
            <a-form layout="vertical" :colon="false" autocomplete="off">
              <a-form-item
                :validate-status="amountValidationMessage ? 'warning' : ''"
                :help="amountValidationMessage || ' '"
              >
                <template #label>
                  <span class="relay-token-pack__amount-label">
                    <span>充值金额（元）</span>
                    <span
                      v-if="rechargeQuote && rechargeQuote.savedAmountFen > 0"
                      class="relay-token-pack__amount-discount"
                      aria-live="polite"
                    >
                      已享{{ rechargeQuote.discountLabel }}，本次节省 {{ formatPriceFen(rechargeQuote.savedAmountFen) }}
                    </span>
                  </span>
                </template>
                <a-input-number
                  v-model:value="customAmountYuan"
                  name="codeflow-relay-token-recharge-amount"
                  autocomplete="off"
                  :min="amountMinYuan"
                  :max="amountMaxYuan"
                  :step="amountStepYuan"
                  :precision="0"
                  :disabled="loading || ordering || refreshing || cancelling"
                  placeholder="请输入充值金额"
                  style="width: 100%"
                />
              </a-form-item>
            </a-form>
            <div class="relay-token-pack__preset-group">
              <div class="relay-token-pack__preset-heading">
                <span>常用金额</span>
                <em v-if="activityText">{{ activityText }}</em>
              </div>
              <div class="relay-token-pack__preset-grid">
                <div v-if="loading && !presetAmountOptions.length" class="relay-token-pack__preset-state">
                  <a-spin size="small" />
                </div>
                <span v-else-if="!presetAmountOptions.length" class="relay-token-pack__preset-state">价格配置不可用</span>
                <a-button
                  v-for="preset in presetAmountOptions"
                  :key="preset.amountFen"
                  class="relay-token-pack__preset-button"
                  :class="{ 'relay-token-pack__preset-button--active': customAmountFen === preset.amountFen }"
                  :disabled="loading || ordering || refreshing || cancelling"
                  @click="selectPresetAmount(preset.amountFen)"
                >
                  <span>{{ preset.amountFen / 100 }}元</span>
                  <small v-if="preset.discountLabel">{{ preset.discountLabel }}</small>
                  <small v-else aria-hidden="true">&nbsp;</small>
                </a-button>
              </div>
            </div>
            <a-button
              class="relay-token-pack__pay-button"
              type="primary"
              block
              :loading="ordering"
              :disabled="!canSubmitOrder"
              @click="submitOrder"
            >
              <template #icon><MoneyCollectOutlined /></template>
              {{ rechargeQuote ? `立即支付 ${formatPriceFen(rechargeQuote.paidAmountFen)}` : "立即支付" }}
            </a-button>
          </div>
          <div v-else-if="order" class="relay-token-pack__payment-card">
            <div class="relay-token-pack__payment-summary">
              <div>
                <span>应付金额</span>
                <strong>{{ formatPriceFen(order.paidAmountFen) }}</strong>
                <small>到账 {{ formatPriceFen(order.balanceAmountFen) }}<template v-if="resolveOrderSavedAmountFen(order) > 0">，已节省 {{ formatPriceFen(resolveOrderSavedAmountFen(order)) }}</template></small>
              </div>
              <a-tag :bordered="false" :color="orderStatusColor(order)">
                {{ orderStatusText(order) }}
              </a-tag>
            </div>

            <div v-if="showQr" class="relay-token-pack__payment-content">
              <div class="relay-token-pack__qr-box" :class="{ 'is-empty': !qrDataUrl }">
                <img v-if="qrDataUrl" :src="qrDataUrl" alt="微信支付二维码" />
                <span v-else>{{ qrError || "当前订单暂无可用二维码" }}</span>
              </div>
              <div class="relay-token-pack__payment-guidance">
                <strong>请使用微信扫码支付</strong>
                <div
                  v-if="countdownText"
                  class="relay-token-pack__countdown"
                  :class="{ 'relay-token-pack__countdown--warning': countdownWarning }"
                >
                  <ClockCircleOutlined />
                  <span>二维码 {{ countdownText }} 后失效</span>
                </div>
                <p>支付完成后，Token 将自动到账。</p>
                <div class="relay-token-pack__order-actions">
                  <a-button :loading="refreshing" :disabled="ordering || cancelling" @click="refreshOrder(true)">
                    <template #icon><ReloadOutlined /></template>
                    刷新状态
                  </a-button>
                  <a-popconfirm
                    v-if="!isTerminalOrder(order) && order.orderStatus !== 'PAID'"
                    title="确认取消这笔token订单？"
                    ok-text="取消订单"
                    cancel-text="保留"
                    @confirm="cancelOrder"
                  >
                    <a-button danger :loading="cancelling" :disabled="ordering || refreshing">
                      取消订单
                    </a-button>
                  </a-popconfirm>
                </div>
              </div>
            </div>

            <div v-else class="relay-token-pack__state">
              <div>
                <strong>{{ orderStatusText(order) }}</strong>
                <span>{{ orderHint(order) }}</span>
              </div>
              <div class="relay-token-pack__order-actions">
                <a-button size="small" :loading="refreshing" :disabled="ordering || cancelling" @click="refreshOrder(true)">
                  <template #icon><ReloadOutlined /></template>
                  刷新状态
                </a-button>
                <a-button
                  v-if="isTerminalOrder(order)"
                  size="small"
                  type="primary"
                  :loading="ordering"
                  :disabled="!canSubmitOrder"
                  @click="submitOrder"
                >
                  <template #icon><MoneyCollectOutlined /></template>
                  重新充值
                </a-button>
              </div>
            </div>
          </div>
          <div v-if="!hasOpenOrder" class="relay-token-pack__price-card">
            <div class="relay-token-pack__price-card-header">
              <div class="relay-token-pack__price-card-title">
                <strong>模型价格</strong>
                <span v-if="relayPriceLoading">价格读取中</span>
                <span v-else-if="relayPriceLoadError" class="relay-token-pack__price-error">{{ relayPriceLoadError }}</span>
                <span v-else>人民币 / 百万Token</span>
              </div>
              <div class="relay-token-pack__price-actions">
                <a-button
                  v-if="relayPriceLoadError"
                  size="small"
                  type="link"
                  :loading="relayPriceLoading"
                  @click="loadRelayPricing(ctx)"
                >
                  重试
                </a-button>
                <a-button size="small" type="link" @click="openRelayPriceConfig">更多模型价格</a-button>
              </div>
            </div>
            <section
              v-for="group in relayFeaturedPriceGroups"
              :key="group.key"
              class="relay-token-pack__price-group"
            >
              <div class="relay-token-pack__price-group-heading">
                <strong>{{ group.title }}</strong>
                <span v-if="relayPriceCatalogLoaded && !relayPriceLoading && !relayPriceLoadError && !group.configured">未配置</span>
              </div>
              <dl>
                <div v-for="row in group.rows" :key="row.label">
                  <dt>{{ row.label }}</dt>
                  <dd>{{ row.price }}</dd>
                </div>
              </dl>
            </section>
          </div>
        </div>
      </section>

    </div>
  </a-modal>
</template>

<style scoped>
.relay-token-pack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.relay-token-pack__target {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.relay-token-pack__target > span {
  color: var(--app-muted);
  font-size: 12px;
}

.relay-token-pack__target :deep(.ant-segmented),
.relay-token-pack__target :deep(.ant-segmented-group),
.relay-token-pack__target :deep(.ant-segmented-item) {
  min-width: 0;
}

.relay-token-pack__target :deep(.ant-segmented-item) {
  flex: 1 1 0;
}

.relay-token-pack__target :deep(.ant-segmented-item-label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.relay-token-pack__overview {
  padding: 16px 18px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-bg);
}

.relay-token-pack__overview-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.relay-token-pack__balance {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.relay-token-pack__balance strong {
  color: var(--app-text);
  font-size: 24px;
  line-height: 1.15;
  overflow-wrap: anywhere;
}

.relay-token-pack__balance span {
  color: var(--app-muted);
  font-size: 12px;
}

.relay-token-pack__overview-actions,
.relay-token-pack__order-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.relay-token-pack__section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.relay-token-pack__section-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.relay-token-pack__section-header strong {
  color: var(--app-text);
  font-size: 14px;
}

.relay-token-pack__section-header span,
.relay-token-pack__payment-summary span,
.relay-token-pack__payment-summary small,
.relay-token-pack__payment-guidance p,
.relay-token-pack__state span {
  color: var(--app-muted);
  font-size: 12px;
}

.relay-token-pack__purchase-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(260px, 0.95fr);
  gap: 12px;
  align-items: stretch;
}

.relay-token-pack__purchase-grid--payment {
  grid-template-columns: 1fr;
}

.relay-token-pack__amount-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  justify-content: flex-start;
  padding: 16px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-bg);
}

.relay-token-pack__amount-card :deep(.ant-form-item) {
  margin-bottom: 0;
}

.relay-token-pack__amount-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  height: 22px;
  min-width: 0;
  overflow: hidden;
  line-height: 22px;
  white-space: nowrap;
}

.relay-token-pack__amount-discount {
  min-width: 0;
  overflow: hidden;
  color: #d46b08;
  font-size: 12px;
  font-weight: 700;
  line-height: 22px;
  text-overflow: ellipsis;
}

.relay-token-pack__preset-group {
  display: grid;
  gap: 8px;
}

.relay-token-pack__preset-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}

.relay-token-pack__preset-heading span {
  color: var(--app-muted);
  font-size: 12px;
}

.relay-token-pack__preset-heading em {
  color: #d46b08;
  font-size: 12px;
  font-style: normal;
  font-weight: 700;
}

.relay-token-pack__preset-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  min-height: 112px;
}

.relay-token-pack__preset-state {
  display: grid;
  grid-column: 1 / -1;
  place-items: center;
  min-height: 112px;
  color: var(--app-muted);
  font-size: 12px;
}

.relay-token-pack__preset-button.ant-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  height: 52px;
  padding-inline: 0;
  border-color: color-mix(in srgb, var(--app-border) 86%, #fa8c16 14%);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel-bg) 96%, var(--app-text) 4%);
  color: var(--app-text);
  font-weight: 600;
}

.relay-token-pack__preset-button span,
.relay-token-pack__preset-button small {
  line-height: 1.25;
}

.relay-token-pack__preset-button small {
  color: #d46b08;
  font-size: 11px;
  font-weight: 700;
}

.relay-token-pack__pay-button {
  margin-top: 8px;
}

.relay-token-pack__preset-button.ant-btn:hover,
.relay-token-pack__preset-button--active.ant-btn {
  border-color: #fa8c16;
  background: color-mix(in srgb, var(--app-panel-bg) 86%, #fa8c16 14%);
  color: #d46b08;
}

.relay-token-pack__price-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel-bg) 96%, var(--app-text) 4%);
}

.relay-token-pack__price-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 2px;
}

.relay-token-pack__price-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
}

.relay-token-pack__price-card-title {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.relay-token-pack__price-card-header strong {
  color: var(--app-text);
  font-size: 14px;
}

.relay-token-pack__price-card-header .ant-btn-link {
  flex: 0 0 auto;
  height: 24px;
  padding-inline: 4px;
  font-size: 12px;
}

.relay-token-pack__price-card-header span,
.relay-token-pack__price-card dt {
  color: var(--app-muted);
  font-size: 12px;
}

.relay-token-pack__price-card-header .relay-token-pack__price-error {
  color: #cf1322;
  overflow-wrap: anywhere;
}

.relay-token-pack__price-group {
  display: grid;
  gap: 2px;
}

.relay-token-pack__price-group + .relay-token-pack__price-group {
  padding-top: 4px;
  border-top: 1px solid var(--app-divider);
}

.relay-token-pack__price-group-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.relay-token-pack__price-group-heading strong {
  color: var(--app-text);
  font-size: 13px;
}

.relay-token-pack__price-group-heading span {
  color: #cf1322;
  font-size: 11px;
}

.relay-token-pack__price-card dl {
  display: grid;
  gap: 0;
  margin: 0;
}

.relay-token-pack__price-card dl div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
  border-top: 1px solid var(--app-border);
}

.relay-token-pack__price-card dd {
  margin: 0;
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.relay-token-pack__price-card dt,
.relay-token-pack__price-card dd {
  line-height: 20px;
}

.relay-token-pack__payment-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-bg);
}

.relay-token-pack__payment-summary,
.relay-token-pack__payment-summary div,
.relay-token-pack__state div:first-child {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.relay-token-pack__payment-summary {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
}

.relay-token-pack__payment-summary strong,
.relay-token-pack__state strong {
  color: var(--app-text);
  overflow-wrap: anywhere;
}

.relay-token-pack__payment-summary strong {
  font-size: 24px;
  line-height: 1.2;
}

.relay-token-pack__payment-summary small {
  line-height: 1.5;
}

.relay-token-pack__payment-content {
  display: grid;
  grid-template-columns: 188px minmax(0, 1fr);
  gap: 16px;
  align-items: center;
  align-self: center;
  width: min(560px, 100%);
  margin-block: auto;
}

.relay-token-pack__qr-box {
  display: grid;
  place-items: center;
  width: 188px;
  height: 188px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.12);
}

.relay-token-pack__qr-box.is-empty {
  background: var(--app-panel-bg);
}

.relay-token-pack__qr-box img {
  width: 176px;
  height: 176px;
}

.relay-token-pack__qr-box span {
  padding: 12px;
  color: var(--app-muted);
  font-size: 12px;
  text-align: center;
}

.relay-token-pack__payment-guidance,
.relay-token-pack__state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}

.relay-token-pack__payment-guidance strong,
.relay-token-pack__state strong {
  font-size: 16px;
  line-height: 1.2;
}

.relay-token-pack__payment-guidance p,
.relay-token-pack__state span {
  line-height: 1.6;
  margin: 0;
}

.relay-token-pack__countdown {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--app-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.relay-token-pack__countdown--warning {
  color: #d46b08;
  font-weight: 600;
}

.relay-token-pack__payment-guidance .relay-token-pack__order-actions {
  justify-content: flex-start;
}

.relay-token-pack__state {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border: 1px dashed var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-bg);
}

@media (max-width: 720px) {
  .relay-token-pack__target,
  .relay-token-pack__overview-header,
  .relay-token-pack__state {
    align-items: stretch;
    flex-direction: column;
  }

  .relay-token-pack__target :deep(.ant-segmented) {
    width: 100%;
  }

  .relay-token-pack__purchase-grid,
  .relay-token-pack__payment-content {
    grid-template-columns: 1fr;
  }

  .relay-token-pack__overview-actions {
    justify-content: flex-start;
  }

  .relay-token-pack__price-card-header {
    align-items: stretch;
    flex-direction: column;
    gap: 6px;
  }

  .relay-token-pack__price-actions {
    justify-content: flex-start;
  }

  .relay-token-pack__qr-box {
    justify-self: center;
  }
}
</style>
