<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { FileSearchOutlined, ReloadOutlined, WarningOutlined } from "@ant-design/icons-vue";
import {
  DEFAULT_RELAY_USD_TO_CNY_RATE,
  normalizeEngineKeyProviderId,
  type EngineType,
  type RelayProviderId,
  type RelayIntegrationStatusResponseBody,
  type RelaySelfBalancesResponseBody,
  type RelayUsageItem,
} from "@codeflowai/shared";

import { getMyRelayBalances, getMyRelayUsage, preflightMyRelayBalance } from "../../../api/account";
import { createCancelledRequestError, isCancelledRequestError } from "../../../api/request";
import { useCodeFlowRelayPricing } from "../../../composables/useCodeFlowRelayPricing";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useEngineKeysStore } from "../../../store/engineKeys";
import RelayBalancePackPurchaseButton from "../../admin/components/relay-balance-pack-purchase-button.vue";
import { formatRelayUsdUnitsAsYuan } from "../../account/relayUsdUnits";
import {
  RELAY_SEND_NEGATIVE_BALANCE_THRESHOLD_USD_UNITS,
  resolveRelayBalanceReminderState,
  resolveRelayBalanceSendGuard,
} from "../relayBalanceReminderState";
import {
  ANTHROPIC_RELAY_TARGET,
  CODEX_RELAY_TARGET,
  DEEPSEEK_RELAY_TARGET,
  MOONSHOT_RELAY_TARGET,
  QWEN_RELAY_TARGET,
  ZAI_RELAY_TARGET,
  type BuiltInRelayTarget,
  useBuiltInRelayKey,
} from "../../settings/composables/useBuiltInRelayKey";

defineOptions({ name: "RelayBalanceReminder" });

type Props = {
  engine: EngineType;
  providerId?: string | null;
  triggerVisible?: boolean;
};

const POLL_INTERVAL_MS = 60_000;
const RELAY_TARGET_BY_PROVIDER = {
  anthropic: ANTHROPIC_RELAY_TARGET,
  openai: CODEX_RELAY_TARGET,
  deepseek: DEEPSEEK_RELAY_TARGET,
  moonshot: MOONSHOT_RELAY_TARGET,
  qwen: QWEN_RELAY_TARGET,
  zai: ZAI_RELAY_TARGET,
} satisfies Record<RelayProviderId, BuiltInRelayTarget>;

const props = withDefaults(defineProps<Props>(), {
  triggerVisible: true,
});
const router = useRouter();
const { ctx } = useApiContext();
const config = useConfigStore();
const engineKeys = useEngineKeysStore();
const builtInRelay = useBuiltInRelayKey();

const popoverOpen = ref(false);
const loading = ref(false);
const manualRefreshing = ref(false);
const relayKeySyncing = ref(false);
const preflightLoading = ref(false);
const status = ref<RelayIntegrationStatusResponseBody | null>(null);
const usage = ref<RelayUsageItem | null>(null);
const balances = ref<RelaySelfBalancesResponseBody | null>(null);
const lastError = ref("");
const lastLoadedAt = ref<number | null>(null);
const {
  load: loadRelayPricing,
  rows: relayPriceRows,
  subtitle: relayPriceSubtitle,
  title: relayPriceTitle,
} = useCodeFlowRelayPricing();
let pollTimer: number | null = null;
let refreshTask: {
  controller: AbortController;
  providerId: RelayProviderId;
  promise: Promise<RelayUsageItem | null>;
} | null = null;
let preflightController: AbortController | null = null;

const normalizedProviderId = computed<RelayProviderId | null>(() =>
  normalizeEngineKeyProviderId(props.engine, props.providerId) as RelayProviderId | null,
);
const currentRelayTarget = computed<BuiltInRelayTarget | null>(() => {
  const providerId = normalizedProviderId.value;
  if (!providerId) return null;
  const target = RELAY_TARGET_BY_PROVIDER[providerId] ?? null;
  return target?.engine === props.engine ? target : null;
});
const currentActiveKey = computed(() => {
  const providerId = normalizedProviderId.value;
  if (!providerId) return null;
  return engineKeys.keys.find((key) => key.engine === props.engine && key.providerId === providerId && key.isActive) ?? null;
});
const currentActiveKeyId = computed(() => currentActiveKey.value?.id ?? "");
const usageProviderId = computed<RelayProviderId | null>(() => currentRelayTarget.value?.providerId ?? null);
const activeBuiltInRelay = computed(() => {
  const target = currentRelayTarget.value;
  const key = currentActiveKey.value;
  return Boolean(target && key && builtInRelay.isBuiltInRelayKey(key, target));
});
const canPoll = computed(() =>
  config.isAccountSession
  && config.hasActiveSession
  && activeBuiltInRelay.value
  && Boolean(usageProviderId.value),
);
const visible = computed(() => canPoll.value && (
  status.value?.state === "enabled" || Boolean(balances.value) || Boolean(lastError.value)
));
const hasEnterpriseBalance = computed(() => Boolean(balances.value?.enterprise));
const balanceState = computed(() => resolveRelayBalanceReminderState(
  balances.value,
  RELAY_SEND_NEGATIVE_BALANCE_THRESHOLD_USD_UNITS,
));
const lowBalance = computed(() => {
  if (balanceState.value) return balanceState.value.lowBalance;
  const remainingYuan = usage.value ? usdToRelayRmbYuan(usage.value.quota ?? 0) : null;
  return remainingYuan != null && remainingYuan < 0;
});
const balanceScopeLabel = computed(() => hasEnterpriseBalance.value ? "企业Token余额" : "个人Token余额");
const lowBalanceMessage = computed(() => hasEnterpriseBalance.value
  ? "当前企业与个人Token总余额为负，已暂停发送"
  : "当前个人Token余额为负，已暂停发送");
const enterpriseFallbackNotice = computed(() => balanceState.value?.usesPersonalFallback
  ? "企业额度即将用完，后续使用个人余额"
  : "");
const remainingText = computed(() => balances.value?.personal
  ? formatRelayUsdUnitsAsYuan(balances.value.personal.availableUsdUnits)
  : formatRelayRemainingMoney(usage.value));
const enterpriseRemainingText = computed(() => {
  const enterprise = balances.value?.enterprise;
  return enterprise ? formatRelayUsdUnitsAsYuan(enterprise.remainingUsdUnits) : "-";
});
const priorityRemainingText = computed(() => hasEnterpriseBalance.value ? enterpriseRemainingText.value : remainingText.value);
const totalRemainingText = computed(() => balanceState.value
  ? formatRelayUsdUnitsAsYuan(balanceState.value.totalAvailableUsdUnits)
  : priorityRemainingText.value);
const todayCostText = computed(() => usage.value ? formatRelayMoneyFromUsd(usage.value.todayActualCost ?? 0) : "-");
const totalCostText = computed(() => usage.value ? formatRelayMoneyFromUsd(usage.value.totalActualCost ?? 0) : "-");
const lastLoadedText = computed(() => lastLoadedAt.value ? new Date(lastLoadedAt.value).toLocaleTimeString("zh-CN") : "-");
const relayKeyActionVisible = computed(() => status.value?.state === "enabled" && isActionableRelayKeyStatus(usage.value?.integrationStatus));
const triggerTitle = computed(() => {
  if (lastError.value) return `Token余额加载失败：${lastError.value}`;
  if (relayKeyActionVisible.value) return `${balanceScopeLabel.value}同步异常：${integrationStatusLabel(usage.value)}`;
  if (lowBalance.value) return `Token总余额为负：${totalRemainingText.value}`;
  if (enterpriseFallbackNotice.value) return enterpriseFallbackNotice.value;
  return `${balanceScopeLabel.value}：${priorityRemainingText.value}`;
});
const relayKeyActionButtonText = computed(() => usage.value?.integrationStatus === "inactive" ? "重新启用" : "修复同步");
const relayKeyActionHint = computed(() => {
  if (usage.value?.integrationStatus === "instance_mismatch") return "当前账号 Token Key 与内置中转映射不一致，可点击修复同步。";
  if (usage.value?.integrationStatus === "failed") return "内置中转 Key 上次同步失败，可点击修复同步重试。";
  if (usage.value?.integrationStatus === "inactive") return "内置中转 Key 已停用，可点击重新启用。";
  return "";
});
const purchaseDisabledReason = computed(() => {
  if (status.value?.state === "disabled") return "内置中转未启用";
  if (status.value?.state === "misconfigured") return "内置中转配置不完整";
  if (usage.value?.integrationStatus === "instance_mismatch" || usage.value?.integrationStatus === "failed") {
    return "请先点击修复同步后再进行Token充值";
  }
  if (usage.value?.integrationStatus === "inactive") return "请先重新启用内置中转后再进行Token充值";
  return null;
});
/** 将上游 USD quota 按固定汇率换算为人民币元。 */
function usdToRelayRmbYuan(value: number): number {
  return Math.round(Number(value ?? 0) * DEFAULT_RELAY_USD_TO_CNY_RATE * 100) / 100;
}

/** 格式化中转金额；会话输入框只展示人民币 token 余额口径。 */
function formatRelayMoneyFromUsd(value: number): string {
  return `￥${usdToRelayRmbYuan(value).toFixed(2)}`;
}

/** 格式化当前余额；未同步时保留占位，不伪造 0 元。 */
function formatRelayRemainingMoney(item: RelayUsageItem | null): string {
  if (!item) return "-";
  const balance = Number(item.quota ?? 0);
  return Number.isFinite(balance) ? formatRelayMoneyFromUsd(balance) : "-";
}

/** 展示当前账号内置中转同步状态，避免泄露上游实现细节。 */
function integrationStatusLabel(item: RelayUsageItem | null): string {
  if (!item) return status.value?.state === "enabled" ? "未同步" : "不可用";
  if (item.integrationStatus === "synced") return "已同步";
  if (item.integrationStatus === "missing") return "未同步";
  if (item.integrationStatus === "inactive") return "已停用";
  if (item.integrationStatus === "failed") return "同步失败";
  if (item.integrationStatus === "instance_mismatch") return "映射异常";
  return "同步异常";
}

/** 为同步状态选择标签颜色，只区分可用、未同步和需处理。 */
function integrationStatusColor(item: RelayUsageItem | null): string {
  if (!item) return "default";
  if (item.integrationStatus === "synced") return "green";
  if (item.integrationStatus === "missing") return "default";
  if (item.integrationStatus === "inactive") return "orange";
  return "red";
}

/** 将接口或运行时异常规整为可展示错误文案。 */
function normalizeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error || fallback);
}

/** 判断当前 Key 状态是否允许用户在提醒弹层内一键修复。 */
function isActionableRelayKeyStatus(value: RelayUsageItem["integrationStatus"] | null | undefined): boolean {
  return value === "failed" || value === "instance_mismatch" || value === "inactive";
}

/** 规整内置中转错误文案，避免把上游实现名直接展示给用户。 */
function toBuiltInRelayDisplayText(value: unknown): string {
  return String(value ?? "")
    .replace(/Relay|RELAY|relay/g, "内置中转")
    .trim();
}

/** 清理余额轮询计时器，组件卸载或会话失效时调用。 */
function clearPollTimer(): void {
  if (pollTimer === null) return;
  window.clearTimeout(pollTimer);
  pollTimer = null;
}

/** 取消当前余额请求，阻止账号或供应商切换后的迟到响应写入。 */
function cancelRefreshTask(kind: "scope-change" | "component-unmount" = "scope-change"): void {
  refreshTask?.controller.abort(createCancelledRequestError(kind));
  refreshTask = null;
  loading.value = false;
  manualRefreshing.value = false;
}

/** 取消账号或供应商切换前发起的发送门禁，禁止迟到响应污染新作用域。 */
function cancelPreflight(kind: "scope-change" | "component-unmount" = "scope-change"): void {
  preflightController?.abort(createCancelledRequestError(kind));
  preflightController = null;
  preflightLoading.value = false;
}

/** 重置本地展示态，避免登出后继续展示旧账号余额。 */
function resetState(): void {
  clearPollTimer();
  cancelRefreshTask();
  cancelPreflight();
  popoverOpen.value = false;
  status.value = null;
  usage.value = null;
  balances.value = null;
  lastError.value = "";
  lastLoadedAt.value = null;
}

/** 将余额读取失败落为显式错误并清除旧资金真值。 */
function setRefreshFailure(error: unknown, fallback: string, manual: boolean): void {
  status.value = null;
  usage.value = null;
  balances.value = null;
  lastLoadedAt.value = null;
  lastError.value = normalizeErrorMessage(error, fallback);
  if (manual) message.error(lastError.value);
}

/** 判断响应是否仍属于当前账号、模型供应商和请求控制器。 */
function isCurrentRefreshTask(controller: AbortController, providerId: RelayProviderId): boolean {
  return refreshTask?.controller === controller
    && !controller.signal.aborted
    && canPoll.value
    && usageProviderId.value === providerId;
}

/** 安排下一次余额检查；只有账号会话有效时才继续轮询。 */
function scheduleNextPoll(): void {
  clearPollTimer();
  if (!canPoll.value || typeof window === "undefined") return;
  pollTimer = window.setTimeout(() => {
    void refreshRelayUsage({ manual: false });
  }, POLL_INTERVAL_MS);
}

/** 拉取当前账号 token 余额，并把失败显式落到组件错误态。 */
async function refreshRelayUsage(input: { manual: boolean; force?: boolean }): Promise<RelayUsageItem | null> {
  if (!canPoll.value) {
    resetState();
    return null;
  }
  const providerId = usageProviderId.value;
  if (!providerId) {
    resetState();
    return null;
  }
  if (refreshTask) {
    if (!input.force && refreshTask.providerId === providerId) {
      if (input.manual) message.info("Token余额正在刷新");
      return await refreshTask.promise;
    }
    cancelRefreshTask();
  }
  clearPollTimer();
  const controller = new AbortController();
  if (input.manual) manualRefreshing.value = true;
  else loading.value = true;
  const promise = (async (): Promise<RelayUsageItem | null> => {
    try {
      const [usageResult, balanceResult] = await Promise.all([
        getMyRelayUsage(ctx.value, { providerId }, { signal: controller.signal }),
        getMyRelayBalances(ctx.value, { signal: controller.signal }),
      ]);
      if (!isCurrentRefreshTask(controller, providerId)) return null;
      if (!usageResult.ok) {
        setRefreshFailure(usageResult.message, "Token用量加载失败", input.manual);
        return null;
      }
      if (!balanceResult.ok) {
        setRefreshFailure(balanceResult.message, "Token余额加载失败", input.manual);
        return null;
      }
      resolveRelayBalanceReminderState(balanceResult, RELAY_SEND_NEGATIVE_BALANCE_THRESHOLD_USD_UNITS);
      status.value = usageResult.status;
      usage.value = usageResult.item;
      balances.value = balanceResult;
      lastError.value = "";
      lastLoadedAt.value = Date.now();
      return usageResult.item;
    } catch (error) {
      if (isCancelledRequestError(error) || !isCurrentRefreshTask(controller, providerId)) return null;
      setRefreshFailure(error, "Token余额加载失败", input.manual);
      return null;
    }
  })();
  const task = { controller, providerId, promise };
  refreshTask = task;
  try {
    return await promise;
  } finally {
    if (refreshTask === task) {
      loading.value = false;
      manualRefreshing.value = false;
      refreshTask = null;
      scheduleNextPoll();
    }
  }
}

/** 将发送前余额校验错误转换为用户可执行的提示，不暴露中转实现名。 */
function resolvePreflightFailureMessage(code: string, rawMessage: string): string {
  if (code === "RELAY_USAGE_RECONCILING") {
    return "Token账务正在对账，已暂停发送；系统会重试可恢复操作，持续未恢复请联系平台客服。";
  }
  if (code === "RELAY_USAGE_FINALITY_CONTRACT_UNAVAILABLE") {
    return "暂时无法确认最新Token消费，已暂停发送，请稍后重试。";
  }
  if (code === "RELAY_USER_LINK_INVALID" || code === "RELAY_USER_SYNC_FAILED" || code === "RELAY_INSTANCE_MISMATCH") {
    return "内置中转Key尚未就绪，已暂停发送；请先在Token余额入口修复同步。";
  }
  const detail = toBuiltInRelayDisplayText(rawMessage);
  return detail ? `Token余额校验失败，已暂停发送：${detail}` : "Token余额校验失败，已暂停发送，请稍后重试。";
}

/** 按当前资金范围生成低余额行动提示，企业成员优先引导联系管理员。 */
function buildLowBalanceBlockMessage(): string {
  const remaining = balanceState.value
    ? formatRelayUsdUnitsAsYuan(balanceState.value.totalAvailableUsdUnits)
    : "未知";
  return hasEnterpriseBalance.value
    ? `当前企业与个人Token总余额为 ${remaining}，已低于零。为避免继续透支，已暂停发送；请充值个人Token或联系企业管理员后重试。`
    : `当前个人Token余额为 ${remaining}，已低于零。为避免继续透支，已暂停发送；请充值后重试。`;
}

/** 开始新模型回合前追平终态消费并检查是否已透支；非内置中转不参与该门禁。 */
async function ensureCanStartTurn(): Promise<boolean> {
  if (!canPoll.value) return true;
  if (preflightLoading.value) {
    message.info("Token余额正在校验，请稍候");
    return false;
  }
  clearPollTimer();
  cancelRefreshTask();
  const providerId = usageProviderId.value;
  if (!providerId) return false;
  const controller = new AbortController();
  preflightController = controller;
  preflightLoading.value = true;
  try {
    const result = await preflightMyRelayBalance(ctx.value, { signal: controller.signal });
    if (preflightController !== controller || controller.signal.aborted
      || !canPoll.value || usageProviderId.value !== providerId) return false;
    if (!result.ok) {
      const displayMessage = resolvePreflightFailureMessage(result.code, result.message);
      balances.value = null;
      lastLoadedAt.value = null;
      lastError.value = displayMessage;
      if (props.triggerVisible) popoverOpen.value = true;
      console.error("[relay.turn_preflight.failed]", {
        code: result.code,
        requestId: null,
        providerId: usageProviderId.value,
        rootCause: result.message,
      });
      message.error(displayMessage);
      return false;
    }
    const decision = resolveRelayBalanceSendGuard(result);
    balances.value = result;
    lastLoadedAt.value = Date.now();
    lastError.value = "";
    if (!decision.allowed) {
      const personalStatus = result.personal?.status;
      const displayMessage = decision.code === "LOW_BALANCE"
        ? buildLowBalanceBlockMessage()
        : personalStatus === "FROZEN" || personalStatus === "RECONCILING"
          ? "当前余额正在对账或处于冻结状态；负余额充值到账后将恢复，其他账务异常请联系平台客服。"
          : "Token余额状态暂不可用。为避免产生超额消费，已暂停发送；请刷新余额或联系平台客服。";
      if (props.triggerVisible) popoverOpen.value = true;
      message.warning(displayMessage);
      return false;
    }
    return true;
  } catch (error) {
    if (isCancelledRequestError(error) || preflightController !== controller || controller.signal.aborted) return false;
    const rootCause = normalizeErrorMessage(error, "Token余额校验失败");
    const displayMessage = resolvePreflightFailureMessage("TOKEN_BALANCE_PREFLIGHT_FAILED", rootCause);
    balances.value = null;
    lastLoadedAt.value = null;
    lastError.value = displayMessage;
    if (props.triggerVisible) popoverOpen.value = true;
    console.error("[relay.turn_preflight.failed]", {
      code: "TOKEN_BALANCE_PREFLIGHT_FAILED",
      requestId: null,
      providerId: usageProviderId.value,
      rootCause,
    });
    message.error(displayMessage);
    return false;
  } finally {
    if (preflightController === controller) {
      preflightController = null;
      preflightLoading.value = false;
      scheduleNextPoll();
    }
  }
}

defineExpose({ ensureCanStartTurn });

/** 打开详情时立即刷新一次，确保弹层显示的是最新余额。 */
function handlePopoverOpenChange(open: boolean): void {
  popoverOpen.value = open;
  if (open) {
    void loadRelayPricing(ctx.value);
    void refreshRelayUsage({ manual: false });
  }
}

/** 购买到账后同步刷新提醒余额。 */
function refreshAfterPurchase(): void {
  void refreshRelayUsage({ manual: false });
}

/** 打开充值弹窗时关闭余额浮层，避免两个浮层层级互相遮挡。 */
function closePopoverBeforePurchase(): void {
  popoverOpen.value = false;
}

/** 应用内打开 Token 使用日志，避免跳转外部浏览器。 */
function openTokenUsageLogs(): void {
  popoverOpen.value = false;
  void router.push({ path: "/admin", query: { panel: "relay-self-usage" } });
}

/** 应用内跳转模型价格面板，避免打开外部浏览器标签页。 */
function openRelayPriceConfig(): void {
  popoverOpen.value = false;
  void router.push({ path: "/admin", query: { panel: "relay-price-config" } });
}

/** 根据余额接口确认后的集成状态展示修复结果，避免同步动作和最终状态提示矛盾。 */
function showRelayRepairResult(item: RelayUsageItem | null): void {
  if (item?.integrationStatus === "synced") {
    message.success("内置中转 Key 已同步");
    return;
  }
  if (!item) {
    message.warning(`同步请求已完成，但未能确认当前状态：${toBuiltInRelayDisplayText(lastError.value || "Token余额加载失败")}`);
    return;
  }
  const reason = toBuiltInRelayDisplayText(item.lastErrorMessage);
  message.warning(reason
    ? `同步请求已完成，但当前状态仍为${integrationStatusLabel(item)}：${reason}`
    : `同步请求已完成，但当前状态仍为${integrationStatusLabel(item)}`);
}

/** 修复当前账号的内置中转 Key 映射，并写入当前工作区本地 Engine Key。 */
async function repairOwnRelayKey(): Promise<void> {
  const target = currentRelayTarget.value;
  if (!target) {
    message.info("当前模型暂不支持内置中转余额提醒");
    return;
  }
  if (status.value?.state !== "enabled") {
    message.info("内置中转未启用或配置不完整");
    return;
  }
  if (!status.value.providerGroupsConfigured?.[target.providerId as RelayProviderId]) {
    message.info("当前供应商未配置内置中转分组");
    return;
  }
  if (!String(config.workspaceId ?? "").trim()) {
    message.info("当前工作区不可写入本地 Key");
    return;
  }
  relayKeySyncing.value = true;
  try {
    await builtInRelay.syncBuiltInRelayKey(target, config.workspaceId);
    const refreshedItem = await refreshRelayUsage({ manual: false, force: true });
    showRelayRepairResult(refreshedItem);
  } catch (error) {
    message.error(toBuiltInRelayDisplayText(error instanceof Error ? error.message : String(error)) || "内置中转 Key 同步失败");
  } finally {
    relayKeySyncing.value = false;
  }
}

watch(
  () => [
    config.isAccountSession,
    config.hasActiveSession,
    config.sessionToken,
    props.engine,
    normalizedProviderId.value,
    activeBuiltInRelay.value,
    usageProviderId.value,
    currentActiveKeyId.value,
  ] as const,
  ([accountSession, activeSession, _sessionToken, _engine, _providerId, builtInActive, usageProviderId]) => {
    if (!accountSession || !activeSession || !builtInActive || !usageProviderId) {
      resetState();
      return;
    }
    resetState();
    void refreshRelayUsage({ manual: false });
  },
  { immediate: true },
);

onUnmounted(() => {
  clearPollTimer();
  cancelRefreshTask("component-unmount");
  cancelPreflight("component-unmount");
});
</script>

<template>
  <a-popover
    v-if="visible && props.triggerVisible"
    :open="popoverOpen"
    trigger="click"
    placement="topRight"
    overlay-class-name="relay-balance-reminder__overlay"
    @open-change="handlePopoverOpenChange"
  >
    <template #content>
      <div class="relay-balance-reminder">
        <header class="relay-balance-reminder__header">
          <div class="relay-balance-reminder__header-intro">
            <span class="relay-balance-reminder__eyebrow">Token余额概览</span>
          </div>
          <div class="relay-balance-reminder__status-actions">
            <a-tag :bordered="false" :color="integrationStatusColor(usage)">
              {{ integrationStatusLabel(usage) }}
            </a-tag>
            <small>刷新时间 {{ lastLoadedText }}</small>
          </div>
        </header>

        <section v-if="hasEnterpriseBalance" class="relay-balance-reminder__enterprise-balance">
          <div class="relay-balance-reminder__enterprise-copy">
            <div class="relay-balance-reminder__balance-heading">
              <span>企业Token余额</span>
              <span class="relay-balance-reminder__balance-order">优先扣除</span>
            </div>
            <strong>{{ enterpriseRemainingText }}</strong>
            <p>消费时优先使用企业额度</p>
            <a-alert
              v-if="enterpriseFallbackNotice"
              class="relay-balance-reminder__enterprise-alert"
              type="info"
              :message="enterpriseFallbackNotice"
            />
          </div>
        </section>

        <section class="relay-balance-reminder__personal-balance" :class="{ 'relay-balance-reminder__personal-balance--secondary': hasEnterpriseBalance }">
          <div class="relay-balance-reminder__balance-heading">
            <span>个人Token余额</span>
            <span v-if="hasEnterpriseBalance" class="relay-balance-reminder__balance-note">企业额度用完后使用</span>
          </div>
          <strong>{{ remainingText }}</strong>
        </section>

        <a-alert
          v-if="lowBalance"
          class="relay-balance-reminder__alert"
          type="warning"
          show-icon
          :message="lowBalanceMessage"
        />
        <a-alert
          v-if="lastError"
          class="relay-balance-reminder__alert"
          type="error"
          show-icon
          :message="lastError"
        />
        <a-alert
          v-if="relayKeyActionHint"
          class="relay-balance-reminder__alert"
          type="warning"
          show-icon
          :message="relayKeyActionHint"
        />

        <a-spin :spinning="loading && !usage">
          <div class="relay-balance-reminder__stats">
            <div>
              <span>今日成本</span>
              <strong>{{ todayCostText }}</strong>
            </div>
            <div>
              <span>累计成本</span>
              <strong>{{ totalCostText }}</strong>
            </div>
          </div>
          <section class="relay-balance-reminder__pricing">
            <div class="relay-balance-reminder__pricing-title">
              <div class="relay-balance-reminder__pricing-title-main">
                <strong>{{ relayPriceTitle }}</strong>
                <span>{{ relayPriceSubtitle }}</span>
              </div>
              <a-button size="small" type="link" @click="openRelayPriceConfig">更多模型价格</a-button>
            </div>
            <dl>
              <div v-for="row in relayPriceRows" :key="row.label">
                <dt>{{ row.label }}</dt>
                <dd>{{ row.price }}</dd>
              </div>
            </dl>
          </section>
        </a-spin>

        <footer class="relay-balance-reminder__actions">
          <a-button size="small" :loading="manualRefreshing" @click="refreshRelayUsage({ manual: true })">
            <template #icon><ReloadOutlined /></template>
            刷新
          </a-button>
          <a-button
            v-if="relayKeyActionVisible"
            size="small"
            type="primary"
            :loading="relayKeySyncing"
            :disabled="loading && !relayKeySyncing"
            @click="repairOwnRelayKey"
          >
            {{ relayKeyActionButtonText }}
          </a-button>
          <RelayBalancePackPurchaseButton
            class="relay-balance-reminder__purchase"
            size="small"
            entry-source="DIRECT_LINK"
            :disabled-reason="purchaseDisabledReason"
            @opened="closePopoverBeforePurchase"
            @succeeded="refreshAfterPurchase"
          />
          <a-button size="small" @click="openTokenUsageLogs">
            <template #icon><FileSearchOutlined /></template>
            流量统计
          </a-button>
        </footer>
      </div>
    </template>
    <a-button
      size="small"
      type="text"
      class="relay-balance-reminder__trigger"
      :class="{ 'relay-balance-reminder__trigger--low': lowBalance, 'relay-balance-reminder__trigger--error': Boolean(lastError) || relayKeyActionVisible }"
      :title="triggerTitle"
      :aria-label="triggerTitle"
    >
      <WarningOutlined v-if="lowBalance || relayKeyActionVisible" />
      <span v-else aria-hidden="true">￥</span>
    </a-button>
  </a-popover>
</template>

<style scoped>
.relay-balance-reminder {
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: 350px;
  max-width: min(350px, calc(100vw - 24px));
}

.relay-balance-reminder__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 1px 2px 0;
}

.relay-balance-reminder__header-intro {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  min-width: 0;
}

.relay-balance-reminder__eyebrow {
  color: var(--app-text);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.25;
}

.relay-balance-reminder__balance-order {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 1px 7px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 24%, var(--app-border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent) 10%, var(--app-panel-bg));
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text));
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
}

.relay-balance-reminder__enterprise-balance {
  display: flex;
  position: relative;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  overflow: hidden;
  min-height: 92px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 30%, var(--app-border));
  border-radius: 12px;
  background:
    radial-gradient(circle at 92% 8%, color-mix(in srgb, var(--app-accent) 18%, transparent), transparent 42%),
    linear-gradient(135deg, color-mix(in srgb, var(--app-accent) 13%, var(--app-panel-bg)), var(--app-panel-bg));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 70%, transparent), var(--app-shadow-sm);
}

.relay-balance-reminder__enterprise-copy {
  display: grid;
  flex: 1 1 auto;
  gap: 4px;
  min-width: 0;
}

.relay-balance-reminder__balance-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.relay-balance-reminder__balance-heading > span:first-child {
  color: color-mix(in srgb, var(--app-text) 82%, var(--app-muted));
  font-size: 12px;
  font-weight: 600;
  line-height: 1.25;
}

.relay-balance-reminder__enterprise-balance strong {
  color: var(--app-text);
  font-size: 26px;
  letter-spacing: -0.03em;
  line-height: 1.1;
}

.relay-balance-reminder__enterprise-balance p {
  margin: 0;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.3;
}

.relay-balance-reminder__personal-balance {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-panel-bg) 92%, var(--app-text) 4%);
}

.relay-balance-reminder__personal-balance strong {
  color: var(--app-text);
  font-size: 19px;
  letter-spacing: -0.02em;
  line-height: 1.15;
}

.relay-balance-reminder__personal-balance--secondary {
  gap: 3px;
  padding-block: 8px;
  background: color-mix(in srgb, var(--app-panel-bg) 97%, var(--app-text) 3%);
}

.relay-balance-reminder__personal-balance--secondary strong {
  font-size: 16px;
}

.relay-balance-reminder__balance-note {
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.25;
  text-align: right;
}

.relay-balance-reminder__header > .relay-balance-reminder__status-actions {
  display: grid;
  justify-content: flex-end;
  gap: 4px;
  text-align: right;
  white-space: nowrap;
}

.relay-balance-reminder__status-actions :deep(.ant-tag) {
  margin-inline-end: 0;
}

.relay-balance-reminder__status-actions small {
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.2;
}

.relay-balance-reminder__stats span,
.relay-balance-reminder__pricing-title span,
.relay-balance-reminder__pricing dt {
  color: var(--app-muted);
  font-size: 12px;
}

.relay-balance-reminder__stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}

.relay-balance-reminder__stats div {
  display: grid;
  gap: 3px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel-bg) 92%, var(--app-text) 4%);
}

.relay-balance-reminder__stats strong {
  color: var(--app-text);
  font-size: 14px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.relay-balance-reminder__alert {
  margin: 0;
  border-radius: 8px;
  padding: 6px 8px;
}

.relay-balance-reminder__alert :deep(.ant-alert-message) {
  font-size: 12px;
  line-height: 1.35;
}

.relay-balance-reminder__enterprise-alert {
  margin-top: 2px;
  border-radius: 8px;
  padding: 5px 8px;
}

.relay-balance-reminder__enterprise-alert :deep(.ant-alert-icon) {
  margin-inline-end: 6px;
  font-size: 13px;
}

.relay-balance-reminder__enterprise-alert :deep(.ant-alert-message) {
  font-size: 11px;
  line-height: 1.25;
}

.relay-balance-reminder__pricing {
  display: grid;
  gap: 6px;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 18%, var(--app-border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-panel-bg) 94%, var(--app-accent) 6%);
}

.relay-balance-reminder__pricing-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.relay-balance-reminder__pricing-title-main {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.relay-balance-reminder__pricing-title strong {
  color: var(--app-text);
  font-size: 13px;
  line-height: 1.2;
}

.relay-balance-reminder__pricing-title .ant-btn-link {
  flex: 0 0 auto;
  height: 22px;
  padding-inline: 4px;
  font-size: 12px;
}

.relay-balance-reminder__pricing dl {
  display: grid;
  gap: 6px;
  margin: 0;
}

.relay-balance-reminder__pricing dl > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.relay-balance-reminder__pricing dt,
.relay-balance-reminder__pricing dd {
  margin: 0;
}

.relay-balance-reminder__pricing dd {
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
}

.relay-balance-reminder__actions {
  display: flex;
  align-items: center;
  justify-content: stretch;
  flex-wrap: wrap;
  gap: 6px;
}

.relay-balance-reminder__actions :deep(.ant-btn) {
  min-height: 29px;
  border-radius: 7px;
}

.relay-balance-reminder__purchase {
  flex: 1 1 120px;
}

.relay-balance-reminder__trigger {
  position: relative;
  width: 28px;
  min-width: 28px;
  padding-inline: 0;
}

.relay-balance-reminder__trigger--low {
  color: #d46b08;
}

.relay-balance-reminder__trigger--low::before {
  position: absolute;
  inset: 2px;
  content: "";
  border-radius: 999px;
  background: rgba(250, 173, 20, 0.2);
  animation: relay-balance-reminder-breathe 1.6s ease-in-out infinite;
}

.relay-balance-reminder__trigger--error {
  color: #cf1322;
}

.relay-balance-reminder__trigger :deep(.anticon) {
  position: relative;
  z-index: 1;
}

@keyframes relay-balance-reminder-breathe {
  0%,
  100% {
    opacity: 0.45;
    transform: scale(0.82);
  }

  50% {
    opacity: 1;
    transform: scale(1.18);
  }
}
</style>
