<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { DownloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import {
  DEFAULT_RELAY_USD_TO_CNY_RATE,
  type RelaySelfUsageSummaryResponseBody,
  type RelayUsageSummaryDimensionItem,
  type RelayUsageSummarySeriesItem,
} from "@codeflowai/shared";

import { getMyRelayUsageSummary } from "../../../api/account";
import { useApiContext } from "../../../composables/useApiContext";

defineOptions({ name: "AccountRelayUsageSummaryTab" });
const props = withDefaults(defineProps<{ mobile?: boolean }>(), { mobile: false });

const { ctx } = useApiContext();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
const loading = ref(false);
const data = ref<RelaySelfUsageSummaryResponseBody | null>(null);
const rangePreset = ref<"yesterday" | "7d" | "30d" | "custom">("30d");
const startDate = ref(offsetDate(-29));
const endDate = ref(offsetDate(0));
const apiKeyId = ref<number | undefined>();
const dimension = ref<"model" | "api_key">("model");
const hoveredDate = ref("");
const scanLimitExceeded = ref(false);
const errorMessage = ref("");
const appliedApiKeyId = ref<number | undefined>();
const chartRef = ref<HTMLDivElement | null>(null);

const chartWidth = ref(900);
const chartHeight = 250;
const chartPadding = { top: 18, right: 18, bottom: 34, left: 58 };
const palette = ["#f97316", "#2563eb", "#16a34a", "#dc2626", "#0891b2", "#7c3aed", "#ca8a04", "#64748b"];

const selectedDimension = computed(() => dimension.value === "model" ? data.value?.byModel : data.value?.byApiKey);
const dimensionRows = computed(() => selectedDimension.value?.dimensions ?? []);
const chartDimensions = computed(() => dimensionRows.value.slice(0, 7));
const chartDates = computed(() => enumerateDates(data.value?.range.startDate ?? startDate.value, data.value?.range.endDate ?? endDate.value));
const chartMax = computed(() => {
  const totals = chartDates.value.map((date) => seriesForDate(date).reduce((sum, item) => sum + item.actualCost, 0));
  return Math.max(0.000001, ...totals);
});
const plotWidth = computed(() => chartWidth.value - chartPadding.left - chartPadding.right);
const plotHeight = chartHeight - chartPadding.top - chartPadding.bottom;
const barSlotWidth = computed(() => plotWidth.value / Math.max(1, chartDates.value.length));
const barWidth = computed(() => Math.max(4, Math.min(22, barSlotWidth.value * 0.62)));
const hoveredItems = computed(() => hoveredDate.value ? seriesForDate(hoveredDate.value) : []);
const hoveredTotal = computed(() => hoveredItems.value.reduce((sum, item) => sum + item.actualCost, 0));
const apiKeyOptions = computed(() => data.value?.apiKeys ?? []);
const tooltipStyle = computed(() => {
  const index = chartDates.value.indexOf(hoveredDate.value);
  if (index < 0) return {};
  const center = chartPadding.left + index * barSlotWidth.value + barSlotWidth.value / 2;
  const leftPercent = center / chartWidth.value * 100;
  return {
    left: `${leftPercent}%`,
    transform: leftPercent > 72 ? "translateX(-100%)" : leftPercent < 28 ? "translateX(0)" : "translateX(-50%)",
  };
});

/** 返回指定日期偏移的本地 YYYY-MM-DD。 */
function offsetDate(offset: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 应用预设时间范围，自定义范围保持用户输入。 */
function applyRangePreset(value: "yesterday" | "7d" | "30d" | "custom"): void {
  rangePreset.value = value;
  if (value === "yesterday") {
    startDate.value = offsetDate(-1);
    endDate.value = offsetDate(-1);
    return;
  }
  if (value === "7d") startDate.value = offsetDate(-6);
  if (value === "30d") startDate.value = offsetDate(-29);
  if (value !== "custom") endDate.value = offsetDate(0);
}

/** 拉取当前筛选范围的完整汇总。 */
async function loadSummary(): Promise<void> {
  if (loading.value) return;
  const rangeError = validateDateRange(startDate.value, endDate.value);
  if (rangeError) {
    message.warning(rangeError);
    return;
  }
  loading.value = true;
  scanLimitExceeded.value = false;
  errorMessage.value = "";
  const submittedQuery = {
    startDate: startDate.value,
    endDate: endDate.value,
    timezone,
    apiKeyId: apiKeyId.value,
  };
  try {
    const result = await getMyRelayUsageSummary(ctx.value, submittedQuery);
    if (!result.ok) {
      scanLimitExceeded.value = result.code === "RELAY_USAGE_SUMMARY_SCAN_LIMIT";
      throw new Error(result.message || "汇总统计加载失败");
    }
    data.value = result;
    appliedApiKeyId.value = submittedQuery.apiKeyId;
  } catch (error) {
    data.value = null;
    const text = error instanceof Error ? error.message : "汇总统计加载失败";
    if (!scanLimitExceeded.value) errorMessage.value = text;
  } finally {
    loading.value = false;
  }
}

/** 校验汇总日期闭区间，前端与服务端统一限制为最多 31 天。 */
function validateDateRange(start: string, end: string): string | null {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return "请选择有效的日期范围";
  if (startTime > endTime) return "开始日期不能晚于结束日期";
  const days = Math.floor((endTime - startTime) / 86_400_000) + 1;
  return days > 31 ? "汇总统计最多查询 31 天" : null;
}

/** 缩小到近 7 天并重新查询。 */
async function retryWithSevenDays(): Promise<void> {
  applyRangePreset("7d");
  await loadSummary();
}

/** 枚举闭区间内的日期，用于补齐无数据日期。 */
function enumerateDates(start: string, end: string): string[] {
  const result: string[] = [];
  const current = new Date(`${start}T12:00:00Z`);
  const target = new Date(`${end}T12:00:00Z`);
  while (current <= target && result.length < 31) {
    result.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return result;
}

/** 按日期范围密度选择横轴刻度，始终保留首尾日期。 */
function shouldShowDateLabel(index: number): boolean {
  const total = chartDates.value.length;
  if (index === 0 || index === total - 1) return true;
  const step = total <= 8 ? 2 : total <= 16 ? 4 : 7;
  return index % step === 0;
}

/** 同步 SVG 坐标宽度与实际容器宽度，消除宽屏下的左右留白。 */
function syncChartWidth(): void {
  const width = chartRef.value?.clientWidth ?? 0;
  if (width > 0) chartWidth.value = Math.max(320, Math.round(width));
}

let chartResizeObserver: ResizeObserver | null = null;

/** 在图表挂载后监听容器尺寸变化。 */
async function attachChartResizeObserver(): Promise<void> {
  await nextTick();
  chartResizeObserver?.disconnect();
  syncChartWidth();
  if (!chartRef.value) return;
  chartResizeObserver = new ResizeObserver(syncChartWidth);
  chartResizeObserver.observe(chartRef.value);
}

/** 返回指定日期的前七维度和“其他”费用序列。 */
function seriesForDate(date: string): RelayUsageSummarySeriesItem[] {
  const source = selectedDimension.value?.series.filter((item) => item.date === date) ?? [];
  const topKeys = new Set(chartDimensions.value.map((item) => item.key));
  const top = source.filter((item) => topKeys.has(item.dimensionKey));
  const other = source.filter((item) => !topKeys.has(item.dimensionKey));
  if (other.length === 0) return top;
  return [...top, {
    date,
    dimensionKey: "__other__",
    dimensionLabel: "其他",
    ...sumSeries(other),
  }];
}

/** 合并多条序列指标，tooltip 仅消费可加指标。 */
function sumSeries(items: RelayUsageSummarySeriesItem[]) {
  return items.reduce((sum, item) => ({
    requests: sum.requests + item.requests,
    uncachedInputTokens: sum.uncachedInputTokens + item.uncachedInputTokens,
    cachedInputTokens: sum.cachedInputTokens + item.cachedInputTokens,
    outputTokens: sum.outputTokens + item.outputTokens,
    totalTokens: sum.totalTokens + item.totalTokens,
    actualCost: sum.actualCost + item.actualCost,
    averageDurationMs: 0,
  }), { requests: 0, uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, actualCost: 0, averageDurationMs: 0 });
}

/** 计算堆叠柱段几何位置。 */
function barSegments(date: string, dateIndex: number) {
  let accumulated = 0;
  return seriesForDate(date).map((item) => {
    const height = item.actualCost / chartMax.value * plotHeight;
    const segment = {
      ...item,
      x: chartPadding.left + dateIndex * barSlotWidth.value + (barSlotWidth.value - barWidth.value) / 2,
      y: chartPadding.top + plotHeight - accumulated - height,
      width: barWidth.value,
      height,
      color: colorForDimension(item.dimensionKey),
    };
    accumulated += height;
    return segment;
  });
}

/** 为维度分配稳定颜色。 */
function colorForDimension(key: string): string {
  if (key === "__other__") return palette[7]!;
  const index = chartDimensions.value.findIndex((item) => item.key === key);
  return palette[Math.max(0, index) % (palette.length - 1)]!;
}

/** 格式化人民币费用。 */
function formatMoney(value: number, digits = 2): string {
  return `￥${(Number(value ?? 0) * DEFAULT_RELAY_USD_TO_CNY_RATE).toFixed(digits)}`;
}

/** 根据趋势最大金额选择纵轴精度，避免小额费用全部显示为零。 */
function formatAxisMoney(value: number): string {
  const maxRmb = chartMax.value * DEFAULT_RELAY_USD_TO_CNY_RATE;
  return formatMoney(value, maxRmb < 1 ? 4 : maxRmb < 10 ? 2 : 0);
}

/** 格式化大整数。 */
function formatNumber(value: number): string {
  return Number(value ?? 0).toLocaleString("zh-CN");
}

/** 格式化平均耗时。 */
function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

/** 导出页面总览与当前维度构成，保持导出内容和当前展示口径一致。 */
function exportSummary(): void {
  if (!data.value || dimensionRows.value.length === 0) return;
  const headers = ["维度", "费用(人民币)", "费用占比", "请求数", "输入（未命中缓存）", "输入（命中缓存）", "输出", "Token总量", "平均耗时(ms)"];
  const rows = dimensionRows.value.map((item) => [
    item.label,
    (item.actualCost * DEFAULT_RELAY_USD_TO_CNY_RATE).toFixed(6),
    `${(item.costRatio * 100).toFixed(2)}%`,
    item.requests,
    item.uncachedInputTokens,
    item.cachedInputTokens,
    item.outputTokens,
    item.totalTokens,
    item.averageDurationMs.toFixed(2),
  ]);
  const overview = [
    ["统计范围", `${data.value.range.startDate} 至 ${data.value.range.endDate}`],
    ["API Key", appliedApiKeyId.value == null ? "全部 Key" : apiKeyOptions.value.find((item) => item.id === appliedApiKeyId.value)?.name ?? `Key #${appliedApiKeyId.value}`],
    ["消费金额(人民币)", (data.value.total.actualCost * DEFAULT_RELAY_USD_TO_CNY_RATE).toFixed(6)],
    ["API请求次数", data.value.total.requests],
    ["Token总量", data.value.total.totalTokens],
    ["平均耗时(ms)", data.value.total.averageDurationMs.toFixed(2)],
    [],
  ];
  const csv = [...overview, headers, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `relay-usage-summary-${data.value.range.startDate}-${data.value.range.endDate}-${dimension.value}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/** 转义 CSV 单元格。 */
function escapeCsvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

defineExpose({ refresh: loadSummary });
onMounted(() => void loadSummary());
watch(data, (value) => {
  if (value) void attachChartResizeObserver();
});
onBeforeUnmount(() => chartResizeObserver?.disconnect());
</script>

<template>
  <div class="relay-summary">
    <div class="relay-summary__filters">
      <label>
        <span>时间范围</span>
        <a-select :value="rangePreset" size="small" :disabled="loading" @change="applyRangePreset">
          <a-select-option value="yesterday">昨天</a-select-option>
          <a-select-option value="7d">近 7 天</a-select-option>
          <a-select-option value="30d">近 30 天</a-select-option>
          <a-select-option value="custom">自定义</a-select-option>
        </a-select>
      </label>
      <template v-if="rangePreset === 'custom'">
        <label><span>开始日期</span><input v-if="props.mobile" v-model="startDate" type="date" :disabled="loading" /><a-date-picker v-else v-model:value="startDate" size="small" value-format="YYYY-MM-DD" :allow-clear="false" :disabled="loading" /></label>
        <label><span>结束日期</span><input v-if="props.mobile" v-model="endDate" type="date" :disabled="loading" /><a-date-picker v-else v-model:value="endDate" size="small" value-format="YYYY-MM-DD" :allow-clear="false" :disabled="loading" /></label>
      </template>
      <label class="relay-summary__key-filter">
        <span>API Key</span>
        <a-select v-model:value="apiKeyId" size="small" allow-clear placeholder="全部 Key" :disabled="loading">
          <a-select-option v-for="key in apiKeyOptions" :key="key.id" :value="key.id">{{ key.name }}</a-select-option>
        </a-select>
      </label>
      <a-button type="primary" size="small" :loading="loading" @click="loadSummary">
        <template #icon><SearchOutlined /></template>查询
      </a-button>
      <a-button size="small" :disabled="loading || !data || dimensionRows.length === 0" @click="exportSummary">
        <template #icon><DownloadOutlined /></template>导出汇总
      </a-button>
    </div>

    <a-alert v-if="scanLimitExceeded" type="warning" show-icon message="当前范围记录较多，请缩小日期范围">
      <template #action><a-button size="small" @click="retryWithSevenDays">改为近 7 天</a-button></template>
    </a-alert>
    <a-alert v-else-if="errorMessage" type="error" show-icon :message="errorMessage">
      <template #action><a-button size="small" @click="loadSummary">重新查询</a-button></template>
    </a-alert>

    <a-spin :spinning="loading">
      <template v-if="data">
        <div class="relay-summary__metrics">
          <div><span>消费金额</span><strong>{{ formatMoney(data.total.actualCost) }}</strong></div>
          <div><span>API 请求次数</span><strong>{{ formatNumber(data.total.requests) }}</strong></div>
          <div><span>Token 总量</span><strong>{{ formatNumber(data.total.totalTokens) }}</strong></div>
          <div><span>平均耗时</span><strong>{{ formatDuration(data.total.averageDurationMs) }}</strong></div>
        </div>

        <section class="relay-summary__trend">
          <div class="relay-summary__section-heading">
            <div><h3>消费趋势</h3><span>{{ data.range.startDate }} 至 {{ data.range.endDate }}</span></div>
            <a-segmented v-model:value="dimension" :options="[{ label: '模型', value: 'model' }, { label: 'API Key', value: 'api_key' }]" size="small" />
          </div>
          <div class="relay-summary__legend">
            <span v-for="item in chartDimensions" :key="item.key"><i :style="{ background: colorForDimension(item.key) }" />{{ item.label }}</span>
            <span v-if="dimensionRows.length > 7"><i :style="{ background: colorForDimension('__other__') }" />其他</span>
          </div>
          <div v-if="data.total.requests === 0" class="relay-summary__empty">当前范围暂无使用记录</div>
          <div v-else ref="chartRef" class="relay-summary__chart" @mouseleave="hoveredDate = ''">
            <svg :viewBox="`0 0 ${chartWidth} ${chartHeight}`" role="img" aria-label="按日消费金额趋势">
              <g v-for="ratio in [0, 0.25, 0.5, 0.75, 1]" :key="ratio">
                <line class="relay-summary__grid" :x1="chartPadding.left" :x2="chartWidth - chartPadding.right" :y1="chartPadding.top + plotHeight * (1 - ratio)" :y2="chartPadding.top + plotHeight * (1 - ratio)" />
                <text class="relay-summary__axis-label" :x="chartPadding.left - 8" :y="chartPadding.top + plotHeight * (1 - ratio) + 4" text-anchor="end">{{ formatAxisMoney(chartMax * ratio) }}</text>
              </g>
              <g v-for="(date, dateIndex) in chartDates" :key="date" @mouseenter="hoveredDate = date" @pointerdown="hoveredDate = date">
                <rect class="relay-summary__hit" :x="chartPadding.left + dateIndex * barSlotWidth" :y="chartPadding.top" :width="barSlotWidth" :height="plotHeight" />
                <rect v-for="segment in barSegments(date, dateIndex)" :key="segment.dimensionKey" class="relay-summary__bar-segment" :x="segment.x" :y="segment.y" :width="segment.width" :height="Math.max(0.5, segment.height)" :fill="segment.color" rx="2" />
                <text v-if="shouldShowDateLabel(dateIndex)" class="relay-summary__axis-label" :x="chartPadding.left + dateIndex * barSlotWidth + barSlotWidth / 2" :y="chartHeight - 10" text-anchor="middle">{{ date.slice(5).replace('-', '/') }}</text>
              </g>
            </svg>
            <div v-if="hoveredDate" class="relay-summary__tooltip" :style="tooltipStyle">
              <strong>{{ hoveredDate }} · {{ formatMoney(hoveredTotal, 4) }}</strong>
              <span v-for="item in hoveredItems" :key="item.dimensionKey">
                {{ item.dimensionLabel }}：{{ formatMoney(item.actualCost, 4) }} · {{ formatNumber(item.requests) }} 次 · {{ formatNumber(item.totalTokens) }} Token
              </span>
            </div>
          </div>
        </section>

        <section class="relay-summary__breakdown">
          <div class="relay-summary__section-heading"><div><h3>构成明细</h3><span>{{ dimension === 'model' ? '按模型聚合' : '按 API Key 聚合' }}</span></div></div>
          <a-table :data-source="dimensionRows" row-key="key" size="small" :pagination="false" :scroll="{ x: 1050 }">
            <a-table-column :title="dimension === 'model' ? '模型' : 'API Key'" data-index="label" :width="170" fixed="left" />
            <a-table-column title="费用" :width="110"><template #default="{ record }">{{ formatMoney(record.actualCost, 4) }}</template></a-table-column>
            <a-table-column title="占比" :width="90"><template #default="{ record }">{{ (record.costRatio * 100).toFixed(2) }}%</template></a-table-column>
            <a-table-column title="请求数" :width="100"><template #default="{ record }">{{ formatNumber(record.requests) }}</template></a-table-column>
            <a-table-column title="输入（未命中缓存）" :width="150"><template #default="{ record }">{{ formatNumber(record.uncachedInputTokens) }}</template></a-table-column>
            <a-table-column title="输入（命中缓存）" :width="140"><template #default="{ record }">{{ formatNumber(record.cachedInputTokens) }}</template></a-table-column>
            <a-table-column title="输出" :width="120"><template #default="{ record }">{{ formatNumber(record.outputTokens) }}</template></a-table-column>
            <a-table-column title="Token 总量" :width="130"><template #default="{ record }">{{ formatNumber(record.totalTokens) }}</template></a-table-column>
            <a-table-column title="平均耗时" :width="110"><template #default="{ record }">{{ formatDuration(record.averageDurationMs) }}</template></a-table-column>
          </a-table>
          <div class="relay-summary__mobile-list">
            <article v-for="item in dimensionRows" :key="item.key">
              <div><strong>{{ item.label }}</strong><b>{{ (item.costRatio * 100).toFixed(2) }}%</b></div>
              <p>{{ formatMoney(item.actualCost, 4) }} · {{ formatNumber(item.requests) }} 次</p>
              <small>未命中 {{ formatNumber(item.uncachedInputTokens) }} · 命中 {{ formatNumber(item.cachedInputTokens) }} · 输出 {{ formatNumber(item.outputTokens) }}</small>
              <p>总 Token {{ formatNumber(item.totalTokens) }} · 平均耗时 {{ formatDuration(item.averageDurationMs) }}</p>
            </article>
          </div>
        </section>
      </template>
      <div v-else-if="loading" class="relay-summary__loading-placeholder">
        <a-skeleton active :paragraph="{ rows: 5 }" />
      </div>
    </a-spin>
  </div>
</template>

<style scoped>
.relay-summary { display: grid; gap: 16px; }
.relay-summary__filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; padding: 4px 0 14px; border-bottom: 1px solid var(--app-border); }
.relay-summary__filters label { display: grid; gap: 5px; color: var(--app-muted); font-size: 12px; }
.relay-summary__filters :deep(.ant-select), .relay-summary__filters :deep(.ant-picker) { width: 142px; }
.relay-summary__filters .relay-summary__key-filter :deep(.ant-select) { width: 190px; }
.relay-summary__loading-placeholder { min-height: 260px; padding: 22px 2px; }
.relay-summary__metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--app-border); border-radius: 8px; overflow: hidden; background: var(--app-bg); }
.relay-summary__metrics > div { display: grid; gap: 8px; min-width: 0; padding: 16px 18px; }
.relay-summary__metrics > div + div { border-left: 1px solid var(--app-border); }
.relay-summary__metrics span, .relay-summary__section-heading span { color: var(--app-muted); font-size: 12px; }
.relay-summary__metrics strong { overflow: hidden; color: var(--app-text); font-size: 24px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.relay-summary__trend, .relay-summary__breakdown { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--app-border); border-radius: 8px; background: var(--app-bg); }
.relay-summary__section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.relay-summary__section-heading h3 { margin: 0 0 2px; color: var(--app-text); font-size: 15px; }
.relay-summary__chart { position: relative; min-height: 250px; overflow: hidden; }
.relay-summary__chart svg { display: block; width: 100%; height: 250px; }
.relay-summary__grid { stroke: var(--app-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
.relay-summary__axis-label { fill: var(--app-muted); font-size: 11px; }
.relay-summary__hit { fill: transparent; }
.relay-summary__bar-segment { pointer-events: none; }
.relay-summary__tooltip { position: absolute; top: 8px; z-index: 2; display: grid; gap: 3px; width: max-content; max-width: min(300px, 70%); padding: 9px 11px; border: 1px solid var(--app-border); border-radius: 6px; background: var(--app-bg-elevated, var(--app-bg)); box-shadow: var(--app-shadow); color: var(--app-text); font-size: 11px; pointer-events: none; transition: left 120ms ease, transform 120ms ease; }
.relay-summary__tooltip strong { font-size: 12px; }
.relay-summary__legend { display: flex; flex-wrap: wrap; gap: 8px 14px; color: var(--app-muted); font-size: 11px; }
.relay-summary__legend span { display: inline-flex; align-items: center; gap: 5px; }
.relay-summary__legend i { width: 8px; height: 8px; border-radius: 2px; }
.relay-summary__empty { display: grid; min-height: 220px; place-items: center; color: var(--app-muted); font-size: 13px; }
.relay-summary__mobile-list { display: none; }
.relay-summary input[type="date"] { width: 100%; min-width: 0; min-height: 40px; border: 1px solid var(--app-border); border-radius: 8px; color: var(--app-text); background: var(--app-panel-bg); font-size: 13px; padding: 4px; }
@media (max-width: 900px) {
  .relay-summary__metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .relay-summary__metrics > div:nth-child(3) { border-left: 0; border-top: 1px solid var(--app-border); }
  .relay-summary__metrics > div:nth-child(4) { border-top: 1px solid var(--app-border); }
}
@media (max-width: 640px) {
  .relay-summary__filters > *, .relay-summary__filters :deep(.ant-select), .relay-summary__filters :deep(.ant-picker), .relay-summary__filters .relay-summary__key-filter :deep(.ant-select) { width: 100%; }
  .relay-summary__metrics strong { font-size: 19px; }
  .relay-summary__trend, .relay-summary__breakdown { padding: 12px; }
  .relay-summary__breakdown :deep(.ant-table-wrapper) { display: none; }
  .relay-summary__mobile-list { display: grid; gap: 8px; }
  .relay-summary__mobile-list article { padding: 11px 0; border-bottom: 1px solid var(--app-border); }
  .relay-summary__mobile-list article > div { display: flex; justify-content: space-between; gap: 12px; color: var(--app-text); }
  .relay-summary__mobile-list b { color: var(--app-primary); }
  .relay-summary__mobile-list p { margin: 5px 0; color: var(--app-text); font-size: 12px; }
  .relay-summary__mobile-list small { color: var(--app-muted); line-height: 1.5; }
}
</style>
