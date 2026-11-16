<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { message } from "ant-design-vue";
import { DownloadOutlined, ReloadOutlined, SearchOutlined, UndoOutlined } from "@ant-design/icons-vue";
import {
  DEFAULT_RELAY_USD_TO_CNY_RATE,
  type RelayIntegrationStatusResponseBody,
  type RelayProviderId,
  type RelaySelfBalancesResponseBody,
  type RelaySelfUsageLogsQuery,
  type RelayUsageItem,
  type RelayUsageLogItem,
} from "@codeflowai/shared";

import {
  getMyRelayBalances,
  getMyRelayUsage,
  listMyRelayUsageLogs,
} from "../../../api/account";
import { createCancelledRequestError, isCancelledRequestError } from "../../../api/request";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
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
import RelayBalancePackPurchaseButton from "./relay-balance-pack-purchase-button.vue";
import AccountRelayUsageSummaryTab from "./account-relay-usage-summary-tab.vue";
import { formatRelayUsdUnitsAsYuan } from "../../account/relayUsdUnits";

defineOptions({ name: "AccountRelayUsagePanel" });
const props = withDefaults(defineProps<{ mobile?: boolean }>(), { mobile: false });
const filtersOpen = ref(false);
const logsError = ref("");
let logsRequestSequence = 0;

const { ctx } = useApiContext();
const config = useConfigStore();
const builtInRelay = useBuiltInRelayKey();
const RELAY_USD_TO_CNY_RATE = DEFAULT_RELAY_USD_TO_CNY_RATE;
const RELAY_PRICE_TOKEN_BASE = 1_000_000;
const RELAY_IMPLEMENTATION_NAME_PATTERN = new RegExp(["sub2", "api"].join(""), "gi");
const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
const RELAY_TARGET_BY_PROVIDER = {
  anthropic: ANTHROPIC_RELAY_TARGET,
  openai: CODEX_RELAY_TARGET,
  deepseek: DEEPSEEK_RELAY_TARGET,
  moonshot: MOONSHOT_RELAY_TARGET,
  qwen: QWEN_RELAY_TARGET,
  zai: ZAI_RELAY_TARGET,
} satisfies Record<RelayProviderId, BuiltInRelayTarget>;

const overviewLoading = ref(false);
const logsLoading = ref(false);
const relayKeySyncing = ref(false);
const status = ref<RelayIntegrationStatusResponseBody | null>(null);
const usage = ref<RelayUsageItem | null>(null);
const balances = ref<RelaySelfBalancesResponseBody | null>(null);
const overviewError = ref("");
const logRows = ref<RelayUsageLogItem[]>([]);
const logTotal = ref(0);
const activeUsageTab = ref<"detail" | "summary">(readUsageTabFromUrl());
const summaryTabVisited = ref(activeUsageTab.value === "summary");
const summaryTabRef = ref<InstanceType<typeof AccountRelayUsageSummaryTab> | null>(null);
let overviewRequestController: AbortController | null = null;

const logFilters = reactive({
  startDate: defaultStartDate(),
  endDate: todayDate(),
  model: "",
  stream: "",
  sortBy: "created_at",
  sortOrder: "desc" as "asc" | "desc",
});

const logPaging = reactive({
  page: 1,
  pageSize: 20,
  pageSizeOptions: ["10", "20", "50", "100"],
});

const loading = computed(() => overviewLoading.value || logsLoading.value);
const logsBusy = computed(() => overviewLoading.value || logsLoading.value);
const personalBalanceText = computed(() => balances.value?.personal
  ? formatRelayUsdUnitsAsYuan(balances.value.personal.availableUsdUnits)
  : formatLegacyPersonalBalance(usage.value));
const enterpriseBalanceText = computed(() => balances.value?.enterprise
  ? formatRelayUsdUnitsAsYuan(balances.value.enterprise.remainingUsdUnits)
  : "-");
const relayKeyActionVisible = computed(() => status.value?.state === "enabled" && isActionableRelayKeyStatus(usage.value?.integrationStatus));
const relayKeyActionButtonText = computed(() => usage.value?.integrationStatus === "inactive" ? "启用" : "修复");
const relayPurchaseDisabledReason = computed(() => {
  if (status.value?.state === "disabled") return "内置中转未启用";
  if (status.value?.state === "misconfigured") return "内置中转配置不完整";
  if (usage.value?.integrationStatus === "instance_mismatch" || usage.value?.integrationStatus === "failed") {
    return "请先修复内置中转后再进行Token充值";
  }
  if (usage.value?.integrationStatus === "inactive") return "请先启用内置中转后再进行Token充值";
  return null;
});
const statusAlert = computed(() => {
  const current = status.value;
  if (!current) return null;
  if (current.state === "misconfigured") {
    return { type: "warning" as const, message: `内置中转配置不完整：${current.missingConfigKeys.join(", ") || "未知配置项"}` };
  }
  if (current.state === "enabled" && !usage.value && !overviewLoading.value) return { type: "info" as const, message: "当前账号还没有启用内置中转 Key" };
  return null;
});

type RelayUsageDisplayLine = {
  emphasis?: boolean;
  text: string;
};

/** 从 URL 恢复流量统计 Tab，非法值回退明细统计。 */
function readUsageTabFromUrl(): "detail" | "summary" {
  return new URL(window.location.href).searchParams.get("relay_tab") === "summary" ? "summary" : "detail";
}

/** 切换流量统计 Tab，首次进入时挂载汇总页，并把当前位置写入 URL。 */
function handleUsageTabChange(value: string | number): void {
  activeUsageTab.value = value === "summary" ? "summary" : "detail";
  if (activeUsageTab.value === "summary") {
    summaryTabVisited.value = true;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("relay_tab", activeUsageTab.value);
  window.history.replaceState(window.history.state, "", url);
}

/** 判断 Key 状态是否需要用户在当前页触发修复或重新启用。 */
function isActionableRelayKeyStatus(value: RelayUsageItem["integrationStatus"] | null | undefined): boolean {
  return value === "failed" || value === "instance_mismatch" || value === "inactive";
}

/** 返回今天的日期输入值，使用本地时区。 */
function todayDate(): string {
  return toDateInputValue(new Date());
}

/** 返回默认开始日期，覆盖最近 7 天。 */
function defaultStartDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 6);
  return toDateInputValue(date);
}

/** 将日期转成 input[type=date] 需要的 YYYY-MM-DD。 */
function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 规整内置中转错误文案，避免把上游实现名直接展示给用户。 */
function toBuiltInRelayDisplayText(value: unknown): string {
  return String(value ?? "")
    .replace(RELAY_IMPLEMENTATION_NAME_PATTERN, "内置中转")
    .replace(/Relay|RELAY|relay/g, "内置中转");
}

/** 将上游 USD quota/cost 按固定汇率换算为人民币元。 */
function usdToRelayRmbYuan(value: number): number {
  return Number(value ?? 0) * RELAY_USD_TO_CNY_RATE;
}

/** 格式化中转金额；用户侧不展示上游 USD quota。 */
function formatRelayMoneyFromUsd(value: number, fractionDigits = 2): string {
  return `￥${usdToRelayRmbYuan(value).toFixed(fractionDigits)}`;
}

/** 精确个人当前态尚未建立时，保留历史个人账号的既有上游余额展示。 */
function formatLegacyPersonalBalance(item: RelayUsageItem | null): string {
  if (!item) return "-";
  const balance = Number(item.quota ?? 0);
  return Number.isFinite(balance) ? formatRelayMoneyFromUsd(balance) : "-";
}

/** 格式化中转费用明细，小额费用保留 6 位精度。 */
function formatRelayCostDetailFromUsd(value: number): string {
  return formatRelayMoneyFromUsd(value, 6);
}

/** 按人民币费用和 token 数计算每百万 token 实时价格。 */
function relayPricePerMillionTokens(costUsd: number, tokens: number): number | null {
  const tokenCount = Number(tokens ?? 0);
  const costRmb = usdToRelayRmbYuan(costUsd);
  if (!Number.isFinite(tokenCount) || tokenCount <= 0 || !Number.isFinite(costRmb)) return null;
  return (costRmb * RELAY_PRICE_TOKEN_BASE) / tokenCount;
}

/** 格式化实时单价；无对应 token 时保持占位。 */
function formatRelayPricePerMillionTokens(costUsd: number, tokens: number): string {
  const price = relayPricePerMillionTokens(costUsd, tokens);
  return price == null ? "-" : `￥${price.toFixed(4)}`;
}

/** 格式化 token 数量，前端统一使用 token 单位。 */
function formatTokens(value: number): string {
  return `${Number(value ?? 0).toLocaleString("zh-CN")}`;
}

/** 格式化毫秒耗时，空值统一显示占位。 */
function formatDuration(value: number | null | undefined): string {
  const ms = Number(value ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** 格式化日期时间，兼容上游 ISO 字符串和本地毫秒时间戳。 */
function formatRelayDateTime(value: string | number | null | undefined): string {
  if (!value) return "-";
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
  return new Date(timestamp).toLocaleString("zh-CN");
}

/** 计算单条请求未命中缓存的输入，缓存写入计入未命中输入。 */
function uncachedInputTokensOf(record: RelayUsageLogItem): number {
  return Number(record.input_tokens ?? 0) + Number(record.cache_creation_tokens ?? 0);
}

/** 计算单条请求命中缓存的输入。 */
function cachedInputTokensOf(record: RelayUsageLogItem): number {
  return Number(record.cache_read_tokens ?? 0);
}

/** 计算单条请求的总 token，按未命中输入、命中输入和输出合计。 */
function totalTokensOf(record: RelayUsageLogItem): number {
  return uncachedInputTokensOf(record)
    + cachedInputTokensOf(record)
    + Number(record.output_tokens ?? 0);
}

/** 计算单条请求实际扣费相对标准费用的折算比例。 */
function actualCostRatioOf(record: RelayUsageLogItem): number {
  const multiplier = Number(record.rate_multiplier ?? Number.NaN);
  if (Number.isFinite(multiplier) && multiplier >= 0) return multiplier;
  const totalCost = Number(record.total_cost ?? 0);
  const actualCost = Number(record.actual_cost ?? 0);
  if (Number.isFinite(totalCost) && totalCost > 0 && Number.isFinite(actualCost) && actualCost >= 0) {
    return actualCost / totalCost;
  }
  return 1;
}

/** 按实际扣费比例折算单项费用，避免明细和总费用口径不一致。 */
function actualCostPartOf(record: RelayUsageLogItem, standardCost: number): number {
  const value = Number(standardCost ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value * actualCostRatioOf(record);
}

/** 计算未命中缓存输入的实际费用，缓存写入成本计入未命中输入。 */
function uncachedInputCostOf(record: RelayUsageLogItem): number {
  return actualCostPartOf(record, Number(record.input_cost ?? 0) + Number(record.cache_creation_cost ?? 0));
}

/** 计算命中缓存输入的实际费用。 */
function cachedInputCostOf(record: RelayUsageLogItem): number {
  return actualCostPartOf(record, Number(record.cache_read_cost ?? 0));
}

/** 计算输出 token 的实际费用。 */
function outputCostOf(record: RelayUsageLogItem): number {
  return actualCostPartOf(record, Number(record.output_cost ?? 0));
}

/** 展示未命中缓存输入实时价格。 */
function uncachedInputRealtimePriceOf(record: RelayUsageLogItem): string {
  return formatRelayPricePerMillionTokens(uncachedInputCostOf(record), uncachedInputTokensOf(record));
}

/** 展示命中缓存输入实时价格。 */
function cachedInputRealtimePriceOf(record: RelayUsageLogItem): string {
  return formatRelayPricePerMillionTokens(cachedInputCostOf(record), cachedInputTokensOf(record));
}

/** 展示输出实时价格。 */
function outputRealtimePriceOf(record: RelayUsageLogItem): string {
  return formatRelayPricePerMillionTokens(outputCostOf(record), Number(record.output_tokens ?? 0));
}

/** 组装多行单元格文本，CSV 用换行保留页面展示层级。 */
function joinDisplayLines(lines: RelayUsageDisplayLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

/** 生成模型列文本，空值使用占位符。 */
function modelDisplayText(record: RelayUsageLogItem): string {
  return String(record.model || "-");
}

/** 生成 Token 用量列展示行，和表格中的明细完全一致。 */
function tokenUsageDisplayLines(record: RelayUsageLogItem): RelayUsageDisplayLine[] {
  const lines: RelayUsageDisplayLine[] = [
    { emphasis: true, text: `总Token ${formatTokens(totalTokensOf(record))}` },
    { text: `输入（未命中缓存）${formatTokens(uncachedInputTokensOf(record))}` },
  ];
  const cachedTokens = cachedInputTokensOf(record);
  if (cachedTokens > 0) {
    lines.push({ text: `输入（命中缓存）${formatTokens(cachedTokens)}` });
  }
  lines.push({ text: `输出 ${formatTokens(record.output_tokens)}` });
  return lines;
}

/** 生成费用明细列展示行，和表格中的费用拆分一致。 */
function costDetailDisplayLines(record: RelayUsageLogItem): RelayUsageDisplayLine[] {
  return [
    { emphasis: true, text: `总费用 ${formatRelayCostDetailFromUsd(record.actual_cost)}` },
    { text: `输入（未命中缓存）${formatRelayCostDetailFromUsd(uncachedInputCostOf(record))}` },
    { text: `输入（命中缓存）${formatRelayCostDetailFromUsd(cachedInputCostOf(record))}` },
    { text: `输出 ${formatRelayCostDetailFromUsd(outputCostOf(record))}` },
  ];
}

/** 生成实时价格列展示行，和表格中的三类价格一致。 */
function realtimePriceDisplayLines(record: RelayUsageLogItem): RelayUsageDisplayLine[] {
  return [
    { text: `输入（未命中缓存）${uncachedInputRealtimePriceOf(record)}` },
    { text: `输入（命中缓存）${cachedInputRealtimePriceOf(record)}` },
    { text: `输出 ${outputRealtimePriceOf(record)}` },
  ];
}

/** 生成会话耗时列展示行，和表格中的首 token 与总耗时一致。 */
function durationDisplayLines(record: RelayUsageLogItem): RelayUsageDisplayLine[] {
  return [
    { text: `首Token耗时： ${formatDuration(record.first_token_ms)}` },
    { text: `会话总耗时： ${formatDuration(record.duration_ms)}` },
  ];
}

/** 展示请求入口和上游 endpoint，便于排查路由差异。 */
function formatUsageEndpoints(record: RelayUsageLogItem): string {
  const inbound = String(record.inbound_endpoint ?? "").trim();
  const upstream = String(record.upstream_endpoint ?? "").trim();
  if (inbound && upstream && inbound !== upstream) return `${inbound} -> ${upstream}`;
  return inbound || upstream || "-";
}

/** 展示请求类型和 stream 标记。 */
function formatRequestType(record: RelayUsageLogItem): string {
  const type = String(record.request_type ?? "").trim() || "request";
  return record.stream ? `流式` : type;
}

/** 仅识别到 fast 或 priority 时展示已开启，其余统一展示未开启。 */
function fastModeLabel(record: RelayUsageLogItem): string {
  switch (String(record.service_tier ?? "").trim().toLowerCase()) {
    case "fast":
    case "priority": return "已开启";
    default: return "未开启";
  }
}

/** 中转同步状态展示文案。 */
function integrationStatusLabel(item: RelayUsageItem | null): string {
  if (!item) return status.value?.state === "enabled" ? "未同步" : "不可用";
  if (item.integrationStatus === "synced") return "已同步";
  if (item.integrationStatus === "missing") return "未同步";
  if (item.integrationStatus === "inactive") return "已停用";
  if (item.integrationStatus === "failed") return "同步失败";
  if (item.integrationStatus === "instance_mismatch") return "需修复";
  return "同步异常";
}

/** 中转同步状态标签颜色。 */
function integrationStatusColor(item: RelayUsageItem | null): string {
  if (!item) return "default";
  if (item.integrationStatus === "synced") return "green";
  if (item.integrationStatus === "missing") return "default";
  if (item.integrationStatus === "inactive") return "orange";
  return "red";
}

/** 上游 key 运行状态展示文案，仅在中转已同步后使用。 */
function upstreamStatusLabel(value: string | null | undefined): string {
  if (value === "active") return "可用";
  if (value === "inactive") return "已停用";
  if (value === "quota_exhausted") return "余额耗尽";
  if (value === "expired") return "已过期";
  return "未知";
}

/** 上游 key 运行状态标签颜色，仅在中转已同步后使用。 */
function upstreamStatusColor(value: string | null | undefined): string {
  if (value === "active") return "green";
  if (value === "inactive" || value === "expired") return "default";
  if (value === "quota_exhausted") return "red";
  return "default";
}

/** 展示当前账号可用 Key 状态；未同步时优先展示集成状态，避免误报未知。 */
function relayKeyStatusLabel(item: RelayUsageItem | null): string {
  if (!item || item.integrationStatus !== "synced") return integrationStatusLabel(item);
  return upstreamStatusLabel(item.upstreamStatus);
}

/** 当前账号可用 Key 状态标签颜色；未同步时沿用集成状态颜色。 */
function relayKeyStatusColor(item: RelayUsageItem | null): string {
  if (!item || item.integrationStatus !== "synced") return integrationStatusColor(item);
  return upstreamStatusColor(item.upstreamStatus);
}

/** 根据当前筛选条件构造真实使用日志查询。 */
function buildUsageLogQuery(): RelaySelfUsageLogsQuery {
  return {
    page: logPaging.page,
    pageSize: logPaging.pageSize,
    startDate: logFilters.startDate || undefined,
    endDate: logFilters.endDate || undefined,
    timezone: userTimezone,
    model: logFilters.model.trim() || undefined,
    stream: logFilters.stream === "" ? undefined : logFilters.stream === "true",
    sortBy: logFilters.sortBy,
    sortOrder: logFilters.sortOrder,
  };
}

/** 拉取当前登录账号的实时余额和用量概览。 */
async function loadOverview(): Promise<void> {
  overviewRequestController?.abort(createCancelledRequestError("scope-change"));
  const controller = new AbortController();
  overviewRequestController = controller;
  status.value = null;
  usage.value = null;
  balances.value = null;
  overviewError.value = "";
  overviewLoading.value = true;
  try {
    const [usageResult, balanceResult] = await Promise.all([
      getMyRelayUsage(ctx.value, undefined, { signal: controller.signal }),
      getMyRelayBalances(ctx.value, { signal: controller.signal }),
    ]);
    if (overviewRequestController !== controller || controller.signal.aborted) return;
    if (!usageResult.ok) {
      overviewError.value = usageResult.message || "流量概览加载失败";
      return;
    }
    if (!balanceResult.ok) {
      overviewError.value = balanceResult.message || "Token 余额加载失败";
      return;
    }
    status.value = usageResult.status;
    usage.value = usageResult.item;
    balances.value = balanceResult;
  } catch (error) {
    if (isCancelledRequestError(error) || overviewRequestController !== controller) return;
    overviewError.value = error instanceof Error ? error.message : "余额概览加载失败";
  } finally {
    if (overviewRequestController === controller) {
      overviewRequestController = null;
      overviewLoading.value = false;
    }
  }
}

/** 拉取当前登录账号的真实请求日志分页。 */
async function loadUsageLogs(): Promise<void> {
  const sequence = ++logsRequestSequence;
  logsLoading.value = true;
  logsError.value = "";
  try {
    const result = await listMyRelayUsageLogs(ctx.value, buildUsageLogQuery());
    if (sequence !== logsRequestSequence) return;
    if (!result.ok) {
      throw new Error(result.message || "使用日志加载失败");
    }
    status.value = result.status;
    logRows.value = result.items;
    logTotal.value = result.total;
    logPaging.page = result.page || logPaging.page;
    logPaging.pageSize = result.pageSize || logPaging.pageSize;
  } catch (error) {
    if (sequence !== logsRequestSequence || isCancelledRequestError(error)) return;
    logsError.value = error instanceof Error ? error.message : "使用日志加载失败";
    console.error({ code: "RELAY_USAGE_LOGS_LOAD_FAILED", requestId: null,
      userId: config.userSummary?.userId, page: logPaging.page, cause: logsError.value });
  } finally {
    if (sequence === logsRequestSequence) logsLoading.value = false;
  }
}

/** 刷新公共状态和当前 Tab，不触发未激活 Tab 的高成本查询。 */
async function refreshAll(): Promise<void> {
  if (activeUsageTab.value === "summary") {
    await Promise.all([loadOverview(), summaryTabRef.value?.refresh()]);
    return;
  }
  await Promise.all([loadOverview(), loadUsageLogs()]);
}

/** 购买到账后刷新个人余额和日志统计。 */
async function refreshAfterRelayPurchase(): Promise<void> {
  await refreshAll();
}

/** 按当前 Key 异常状态锚定 provider 修复或重新启用内置中转，并写入本地 Engine Key。 */
async function repairOwnRelayKey(): Promise<void> {
  const providerId = (usage.value?.providerId ?? "anthropic") as RelayProviderId;
  const target = RELAY_TARGET_BY_PROVIDER[providerId] ?? ANTHROPIC_RELAY_TARGET;
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
    message.success("内置中转已启用");
    await refreshAll();
  } catch (error) {
    message.error(toBuiltInRelayDisplayText(error instanceof Error ? error.message : String(error)) || "内置中转启用失败");
  } finally {
    relayKeySyncing.value = false;
  }
}

/** 应用日志筛选并同步刷新顶部余额概览。 */
async function applyLogFilters(): Promise<void> {
  logPaging.page = 1;
  await loadUsageLogs();
}

/** 重置日志筛选为最近 7 天，并同步刷新顶部余额概览。 */
async function resetLogFilters(): Promise<void> {
  logFilters.startDate = defaultStartDate();
  logFilters.endDate = todayDate();
  logFilters.model = "";
  logFilters.stream = "";
  logFilters.sortBy = "created_at";
  logFilters.sortOrder = "desc";
  logPaging.page = 1;
  await loadUsageLogs();
}

/** 处理真实日志分页变化。 */
async function handleLogPageChange(page: number, pageSize?: number): Promise<void> {
  const sizeChanged = pageSize !== undefined && pageSize !== logPaging.pageSize;
  logPaging.page = sizeChanged ? 1 : page;
  logPaging.pageSize = pageSize ?? logPaging.pageSize;
  await loadUsageLogs();
}

/** 导出当前页日志 CSV；不做后台批量导出，避免引入新任务链路。 */
function exportCurrentPage(): void {
  if (logRows.value.length === 0) {
    message.info("当前页没有可导出的使用日志");
    return;
  }
  const headers = [
    "时间",
    "模型",
    "Endpoint",
    "模式",
    "Fast",
    "Token 用量",
    "费用明细",
    "实时价格（元/百万Token）",
    "会话耗时",
    "请求 ID",
  ];
  const rows = logRows.value.map((record) => [
    formatRelayDateTime(record.created_at),
    modelDisplayText(record),
    formatUsageEndpoints(record),
    formatRequestType(record),
    fastModeLabel(record),
    joinDisplayLines(tokenUsageDisplayLines(record)),
    joinDisplayLines(costDetailDisplayLines(record)),
    joinDisplayLines(realtimePriceDisplayLines(record)),
    joinDisplayLines(durationDisplayLines(record)),
    record.request_id || "-",
  ]);
  const csv = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `relay-usage-logs-${logFilters.startDate || "all"}-${logFilters.endDate || "all"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/** 转义 CSV 单元格，避免逗号和换行破坏导出结构。 */
function escapeCsvCell(value: unknown): string {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

onMounted(() => {
  void refreshAll();
});

onBeforeUnmount(() => {
  logsRequestSequence += 1;
  overviewRequestController?.abort(createCancelledRequestError("component-unmount"));
  overviewRequestController = null;
});
</script>

<template>
  <div class="admin-panel relay-self-usage" :class="{ 'relay-self-usage--mobile': props.mobile }">
    <div class="relay-self-usage__toolbar">
      <div class="relay-self-usage__subtitle">只统计CodeFlow内置的中转流量记录</div>
    </div>

    <a-alert
      v-if="overviewError"
      type="error"
      message="余额概览加载失败"
      :description="overviewError"
      show-icon
      class="relay-self-usage__alert"
    >
      <template #action>
        <a-button size="small" :loading="overviewLoading" @click="loadOverview">重试</a-button>
      </template>
    </a-alert>

    <a-alert
      v-else-if="statusAlert"
      :type="statusAlert.type"
      :message="statusAlert.message"
      show-icon
      class="relay-self-usage__alert"
    />

    <div class="relay-self-usage__summary" :class="{ 'has-enterprise': Boolean(balances?.enterprise) }">
      <div class="relay-self-usage__summary-item relay-self-usage__summary-item--balance">
        <span>个人 Token 余额（人民币）</span>
        <div class="relay-self-usage__balance-main">
          <strong>{{ personalBalanceText }}</strong>
          <div class="relay-self-usage__balance-actions">
            <RelayBalancePackPurchaseButton
              size="small"
              :disabled-reason="relayPurchaseDisabledReason"
              @succeeded="refreshAfterRelayPurchase"
            />
            <a-button size="small" :loading="loading" @click="refreshAll">
              <template #icon><ReloadOutlined /></template>
              刷新
            </a-button>
          </div>
        </div>
      </div>
      <div v-if="balances?.enterprise" class="relay-self-usage__summary-item relay-self-usage__summary-item--balance">
        <span>{{ balances.enterprise.enterpriseName }}企业额度（人民币）</span>
        <div class="relay-self-usage__balance-main">
          <strong>{{ enterpriseBalanceText }}</strong>
        </div>
      </div>
      <div class="relay-self-usage__summary-item">
        <span>Key 状态</span>
        <div class="relay-self-usage__summary-status">
          <a-tag :bordered="false" :color="relayKeyStatusColor(usage)">
            {{ relayKeyStatusLabel(usage) }}
          </a-tag>
          <a-button
            v-if="relayKeyActionVisible"
            type="link"
            size="small"
            class="relay-self-usage__key-action"
            :loading="relayKeySyncing"
            :disabled="loading && !relayKeySyncing"
            @click="repairOwnRelayKey"
          >
            {{ relayKeyActionButtonText }}
          </a-button>
        </div>
      </div>
    </div>

    <a-tabs :active-key="activeUsageTab" class="relay-self-usage__tabs" @change="handleUsageTabChange">
      <a-tab-pane key="detail" tab="明细统计">
        <div class="relay-self-usage__logs">
      <button v-if="props.mobile" type="button" class="relay-self-usage__filter-toggle" :aria-expanded="filtersOpen" @click="filtersOpen = !filtersOpen">
        <span>{{ logFilters.startDate }} 至 {{ logFilters.endDate }}</span><b>{{ filtersOpen ? '收起筛选' : '筛选' }}</b>
      </button>
      <div v-show="!props.mobile || filtersOpen" class="relay-self-usage__filters">
        <label class="relay-self-usage__filter relay-self-usage__filter--date">
          <span>开始日期</span>
          <a-date-picker
            v-if="!props.mobile"
            v-model:value="logFilters.startDate"
            size="small"
            value-format="YYYY-MM-DD"
            :allow-clear="false"
          />
          <input v-else v-model="logFilters.startDate" type="date" aria-label="开始日期" />
        </label>
        <label class="relay-self-usage__filter relay-self-usage__filter--date">
          <span>结束日期</span>
          <a-date-picker
            v-if="!props.mobile"
            v-model:value="logFilters.endDate"
            size="small"
            value-format="YYYY-MM-DD"
            :allow-clear="false"
          />
          <input v-else v-model="logFilters.endDate" type="date" aria-label="结束日期" />
        </label>
        <label class="relay-self-usage__filter relay-self-usage__filter--model">
          <span>模型</span>
          <a-input v-model:value="logFilters.model" size="small" allow-clear placeholder="全部模型" />
        </label>
        <label class="relay-self-usage__filter relay-self-usage__filter--stream">
          <span>模式</span>
          <a-select v-model:value="logFilters.stream" size="small">
            <a-select-option value="">全部</a-select-option>
            <a-select-option value="true">流式</a-select-option>
            <a-select-option value="false">非流式</a-select-option>
          </a-select>
        </label>
        <label class="relay-self-usage__filter relay-self-usage__filter--sort">
          <span>排序</span>
          <a-select v-model:value="logFilters.sortBy" size="small">
            <a-select-option value="created_at">时间</a-select-option>
            <a-select-option value="model">模型</a-select-option>
            <a-select-option value="actual_cost">费用</a-select-option>
            <a-select-option value="duration_ms">耗时</a-select-option>
            <a-select-option value="input_tokens">输入 token</a-select-option>
            <a-select-option value="output_tokens">输出 token</a-select-option>
          </a-select>
        </label>
        <label class="relay-self-usage__filter relay-self-usage__filter--compact">
          <span>方向</span>
          <a-select v-model:value="logFilters.sortOrder" size="small">
            <a-select-option value="desc">降序</a-select-option>
            <a-select-option value="asc">升序</a-select-option>
          </a-select>
        </label>
        <div class="relay-self-usage__filter-actions">
          <a-button type="primary" size="small" :loading="logsBusy" @click="applyLogFilters">
            <template #icon><SearchOutlined /></template>
            查询
          </a-button>
          <a-button size="small" :disabled="logsBusy" @click="resetLogFilters">
            <template #icon><UndoOutlined /></template>
            重置
          </a-button>
        </div>
        <div class="relay-self-usage__filter-export-actions">
          <a-button size="small" :disabled="logsLoading || logRows.length === 0" @click="exportCurrentPage">
            <template #icon><DownloadOutlined /></template>
            导出当前页
          </a-button>
        </div>
      </div>

      <a-alert v-if="logsError" type="error" show-icon :message="logsError">
        <template #action><a-button @click="loadUsageLogs">重试</a-button></template>
      </a-alert>
      <div v-if="props.mobile" class="relay-mobile-logs" :aria-busy="logsLoading">
        <a-skeleton v-if="logsLoading" active :paragraph="{ rows: 6 }" />
        <p v-else-if="!logsError && !logRows.length" class="relay-mobile-logs__empty">当前范围暂无使用记录</p>
        <template v-else-if="!logsError">
          <article v-for="record in logRows" :key="record.id" class="relay-mobile-log">
            <header><strong>{{ modelDisplayText(record) }}</strong><b>{{ formatRelayCostDetailFromUsd(record.actual_cost) }}</b></header>
            <p>{{ formatRelayDateTime(record.created_at) }} · {{ formatRequestType(record) }} · Fast：{{ fastModeLabel(record) }}</p>
            <div class="relay-mobile-log__metrics"><span>总 Token<strong>{{ formatTokens(totalTokensOf(record)) }}</strong></span><span>总耗时<strong>{{ formatDuration(record.duration_ms) }}</strong></span></div>
            <details><summary>用量与费用明细</summary>
              <div class="relay-mobile-log__details">
                <span v-for="line in tokenUsageDisplayLines(record)" :key="line.text">{{ line.text }}</span>
                <span v-for="line in costDetailDisplayLines(record)" :key="line.text">{{ line.text }}</span>
                <span v-for="line in realtimePriceDisplayLines(record)" :key="line.text">{{ line.text }} 元/百万 Token</span>
                <span>首 Token：{{ formatDuration(record.first_token_ms) }}</span>
                <span>Endpoint：{{ formatUsageEndpoints(record) }}</span>
                <span>请求 ID：{{ record.request_id || '-' }}</span>
              </div>
            </details>
          </article>
        </template>
      </div>
      <a-table
        v-else
        :data-source="logRows"
        :loading="logsLoading"
        :pagination="false"
        row-key="id"
        size="small"
        :scroll="{ x: 'max-content' }"
      >
        <a-table-column title="时间" :width="150" fixed="left">
          <template #default="{ record }">
            <div class="relay-self-usage__cell">
              <strong>{{ formatRelayDateTime(record.created_at) }}</strong>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="模型" :width="120">
          <template #default="{ record }">
            <div class="relay-self-usage__cell">
              <strong>{{ record.model || "-" }}</strong>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="Endpoint" :width="120">
          <template #default="{ record }">
            <span class="relay-self-usage__endpoint">{{ formatUsageEndpoints(record) }}</span>
          </template>
        </a-table-column>
        <a-table-column title="模式" :width="120">
          <template #default="{ record }">
            <div class="relay-self-usage__cell">
              <a-tag :bordered="false" :color="record.stream ? 'blue' : 'default'">
                {{ formatRequestType(record) }}
              </a-tag>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="Fast" :width="90">
          <template #default="{ record }">
            <a-tag :bordered="false" :color="fastModeLabel(record) === '已开启' ? 'purple' : 'default'" :title="record.service_tier || '未记录服务等级'">
              {{ fastModeLabel(record) }}
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="Token 用量" :width="220">
          <template #default="{ record }">
            <div class="relay-self-usage__cell">
              <template v-for="line in tokenUsageDisplayLines(record)" :key="line.text">
                <strong v-if="line.emphasis">{{ line.text }}</strong>
                <small v-else>{{ line.text }}</small>
              </template>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="费用明细（人民币）" :width="220">
          <template #default="{ record }">
            <div class="relay-self-usage__cell">
              <template v-for="line in costDetailDisplayLines(record)" :key="line.text">
                <strong v-if="line.emphasis">{{ line.text }}</strong>
                <small v-else>{{ line.text }}</small>
              </template>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="实时价格（元/百万Token）" :width="220">
          <template #default="{ record }">
            <div class="relay-self-usage__cell">
              <small v-for="line in realtimePriceDisplayLines(record)" :key="line.text">{{ line.text }}</small>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="耗时" :width="160">
          <template #default="{ record }">
            <div class="relay-self-usage__cell">
              <small v-for="line in durationDisplayLines(record)" :key="line.text">{{ line.text }}</small>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="请求 ID" :width="260">
          <template #default="{ record }">
            <span class="relay-self-usage__mono">{{ record.request_id || "-" }}</span>
          </template>
        </a-table-column>
      </a-table>
      <div class="relay-self-usage__pagination">
        <span>共 {{ logTotal }} 条使用日志</span>
        <a-pagination
          :current="logPaging.page"
          :page-size="logPaging.pageSize"
          :total="logTotal"
          :simple="props.mobile"
          :disabled="logsBusy"
          :show-size-changer="!props.mobile"
          :page-size-options="logPaging.pageSizeOptions"
          size="small"
          @change="handleLogPageChange"
          @show-size-change="handleLogPageChange"
        />
      </div>
        </div>
      </a-tab-pane>
      <a-tab-pane key="summary" tab="汇总统计">
        <AccountRelayUsageSummaryTab v-if="summaryTabVisited" ref="summaryTabRef" :mobile="props.mobile" />
      </a-tab-pane>
    </a-tabs>
  </div>
</template>

<style scoped>
.relay-self-usage {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
}

.relay-self-usage__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0 12px;
  border-bottom: 1px solid var(--app-border);
}

.relay-self-usage__subtitle {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.4;
}

.relay-self-usage__filter-actions,
.relay-self-usage__filter-export-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
}

.relay-self-usage__alert {
  flex: 0 0 auto;
  margin-top: 12px;
}

.relay-self-usage__summary {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr);
  gap: 28px;
  min-width: 0;
  padding: 14px 0 13px;
  border-bottom: 1px solid var(--app-border);
}

.relay-self-usage__summary.has-enterprise {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.relay-self-usage__summary-item {
  display: grid;
  align-content: center;
  gap: 5px;
  min-width: 0;
  padding: 0;
}

.relay-self-usage__summary-item + .relay-self-usage__summary-item {
  padding-left: 28px;
  border-left: 1px solid var(--app-border);
}

.relay-self-usage__summary-item > span,
.relay-self-usage__cell small,
.relay-self-usage__pagination {
  color: var(--app-muted);
  font-size: 12px;
}

.relay-self-usage__summary-item strong {
  color: var(--app-text);
  font-size: 20px;
  font-weight: 650;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.relay-self-usage__balance-main {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 10px 14px;
  min-width: 0;
}

.relay-self-usage__balance-main strong {
  flex: 0 1 auto;
  min-width: 88px;
}

.relay-self-usage__balance-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
}

.relay-self-usage__summary-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.relay-self-usage__tabs {
  min-width: 0;
}

.relay-self-usage__tabs :deep(.ant-tabs-nav) {
  margin: 0 0 12px;
}

.relay-self-usage__tabs :deep(.ant-tabs-tab) {
  padding: 10px 0 9px;
}

.relay-self-usage__summary-status :deep(.ant-tag) {
  margin-inline-end: 0;
}

.relay-self-usage__key-action {
  height: 22px;
  padding: 0 2px;
  font-size: 12px;
}

.relay-self-usage__logs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.relay-self-usage__filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 96%, #f4f6f8);
}

.relay-self-usage__filter {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
}

.relay-self-usage__filter--date {
  flex-basis: 184px;
}

.relay-self-usage__filter--model,
.relay-self-usage__filter--request-type {
  flex-basis: 150px;
}

.relay-self-usage__filter--stream {
  flex-basis: 112px;
}

.relay-self-usage__filter--sort {
  flex-basis: 132px;
}

.relay-self-usage__filters .relay-self-usage__filter-actions {
  flex: 0 1 auto;
  justify-content: flex-start;
  margin-left: 0;
  min-width: 0;
  max-width: 100%;
}

.relay-self-usage__filters .relay-self-usage__filter-export-actions {
  flex: 0 1 auto;
  justify-content: flex-end;
  margin-left: auto;
  min-width: 0;
  max-width: 100%;
}

.relay-self-usage__filter span {
  color: var(--app-muted);
  font-size: 12px;
  white-space: nowrap;
}

.relay-self-usage__filter--compact {
  flex-basis: 98px;
}

.relay-self-usage__filter :deep(.ant-input),
.relay-self-usage__filter :deep(.ant-select),
.relay-self-usage__filter :deep(.ant-picker) {
  width: 100%;
  min-width: 0;
}

.relay-self-usage__filter :deep(.ant-input),
.relay-self-usage__filter :deep(.ant-picker),
.relay-self-usage__filter :deep(.ant-select-selector) {
  height: 24px;
  border-radius: 6px;
}

.relay-self-usage__filter :deep(.ant-picker-input > input) {
  min-width: 0;
}

.relay-self-usage__cell {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.relay-self-usage__cell strong,
.relay-self-usage__cell small,
.relay-self-usage__endpoint,
.relay-self-usage__mono {
  min-width: 0;
  overflow-wrap: anywhere;
}

.relay-self-usage__cell strong {
  color: var(--app-text);
  font-size: 13px;
}

.relay-self-usage__endpoint,
.relay-self-usage__mono {
  color: var(--app-text);
  font-size: 12px;
}

.relay-self-usage__mono {
  font-family: var(--app-mono-font, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}

.relay-self-usage__pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 8px;
}

@media (max-width: 1280px) {
  .relay-self-usage__filter-actions {
    justify-content: flex-start;
  }
}

@media (max-width: 900px) {
  .relay-self-usage__summary {
    grid-template-columns: minmax(0, 2fr) minmax(180px, 1fr);
  }

  .relay-self-usage__summary.has-enterprise {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .relay-self-usage__toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .relay-self-usage__filters .relay-self-usage__filter-actions,
  .relay-self-usage__filters .relay-self-usage__filter-export-actions {
    width: 100%;
    justify-content: flex-start;
    margin-left: 0;
  }

  .relay-self-usage__summary {
    grid-template-columns: 1fr;
  }

  .relay-self-usage__summary.has-enterprise {
    grid-template-columns: 1fr;
  }

  .relay-self-usage__summary-item + .relay-self-usage__summary-item {
    padding-top: 12px;
    padding-left: 0;
    border-top: 1px solid var(--app-border);
    border-left: 0;
  }
}
</style>

<style scoped>
.relay-self-usage--mobile { height: 100%; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 14px; display: block; background: var(--app-bg); overscroll-behavior: contain; }
.relay-self-usage--mobile .relay-self-usage__toolbar { flex-direction: row; align-items: center; }
.relay-self-usage--mobile .relay-self-usage__summary { gap: 10px; border: 0; }
.relay-self-usage--mobile .relay-self-usage__summary-item { padding: 14px; border: 1px solid var(--app-divider); border-radius: 16px; background: var(--app-panel-bg); }
.relay-self-usage--mobile .relay-self-usage__summary-item--balance { background: linear-gradient(135deg, color-mix(in srgb, var(--app-accent) 9%, var(--app-panel-bg)), var(--app-panel-bg)); }
.relay-self-usage--mobile .relay-self-usage__balance-main { justify-content: space-between; }
.relay-self-usage--mobile .relay-self-usage__balance-main strong { font-size: 26px; font-variant-numeric: tabular-nums; }
.relay-self-usage--mobile :deep(.ant-btn) { min-height: 40px; border-radius: 10px; }
.relay-self-usage--mobile .relay-self-usage__filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 12px; border: 1px solid var(--app-divider); border-radius: 14px; background: var(--app-panel-bg); }
.relay-self-usage--mobile .relay-self-usage__filter { width: auto; min-width: 0; }
.relay-self-usage--mobile .relay-self-usage__filter { display: grid; gap: 5px; }
.relay-self-usage--mobile .relay-self-usage__filter :deep(.ant-select), .relay-self-usage--mobile .relay-self-usage__filter :deep(.ant-input-affix-wrapper) { width: 100%; min-height: 40px; }
.relay-self-usage--mobile .relay-self-usage__filter :deep(.ant-select-selector) { min-height: 40px; align-items: center; }
.relay-self-usage--mobile .relay-self-usage__filter input[type="date"] { width: 100%; min-width: 0; min-height: 40px; border: 1px solid var(--app-border); border-radius: 8px; padding: 4px; color: var(--app-text); background: var(--app-panel-bg); font-size: 13px; }
.relay-self-usage--mobile .relay-self-usage__filter-actions, .relay-self-usage--mobile .relay-self-usage__filter-export-actions { grid-column: 1 / -1; }
.relay-self-usage__filter-toggle { width: 100%; display: flex; justify-content: space-between; align-items: center; min-height: 44px; padding: 0; border: 0; background: transparent; color: var(--app-muted); font-size: 12px; }
.relay-self-usage__filter-toggle b { color: var(--app-accent); }
.relay-mobile-logs { display: grid; align-content: start; gap: 10px; min-height: 200px; }
.relay-mobile-logs__empty { margin: 0; padding: 50px 12px; text-align: center; color: var(--app-muted); }
.relay-mobile-log { min-width: 0; padding: 14px; border: 1px solid var(--app-divider); border-radius: 16px; background: var(--app-panel-bg); }
.relay-mobile-log header { display: flex; gap: 10px; align-items: flex-start; }
.relay-mobile-log header strong { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 14px; }
.relay-mobile-log header b { color: var(--app-accent); font-size: 13px; }
.relay-mobile-log p { color: var(--app-muted); font-size: 11px; margin: 7px 0 12px; }
.relay-mobile-log__metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.relay-mobile-log__metrics span { display: grid; gap: 3px; color: var(--app-muted); font-size: 11px; }
.relay-mobile-log__metrics strong { color: var(--app-text); font-size: 17px; font-variant-numeric: tabular-nums; }
.relay-mobile-log details { margin-top: 10px; border-top: 1px solid var(--app-divider); font-size: 12px; }
.relay-mobile-log summary { padding: 12px 0 0; color: var(--app-muted); cursor: pointer; }
.relay-mobile-log__details { display: grid; gap: 6px; margin-top: 12px; overflow-wrap: anywhere; color: var(--app-muted); }
.relay-self-usage--mobile .relay-self-usage__pagination { padding: 14px 0 max(14px, var(--safe-bottom)); justify-content: center; }
.relay-self-usage--mobile :deep(.relay-summary__metrics), .relay-self-usage--mobile :deep(.relay-summary__trend), .relay-self-usage--mobile :deep(.relay-summary__breakdown) { border-radius: 16px; background: var(--app-panel-bg); }
.relay-self-usage--mobile :deep(.relay-summary__filters) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.relay-self-usage--mobile :deep(.relay-summary__filters > *) { min-width: 0; }
.relay-self-usage--mobile :deep(.relay-summary__filters .ant-select-selector) { min-height: 40px; align-items: center; }
.relay-self-usage--mobile :deep(.relay-summary__mobile-list strong) { overflow-wrap: anywhere; }
</style>
