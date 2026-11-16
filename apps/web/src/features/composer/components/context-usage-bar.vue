<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { Modal } from "ant-design-vue";
import type { EngineType, TokenUsageState } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useCodeFlowRelayPricing } from "../../../composables/useCodeFlowRelayPricing";
import { hasCurrentUsageData } from "../context-usage-snapshot";
import RelayBalancePackPurchaseButton from "../../admin/components/relay-balance-pack-purchase-button.vue";

defineOptions({ name: "ContextUsageBar" });

type Props = {
  engine?: EngineType | null;
  tokenUsage: TokenUsageState | null;
  /** 当 tokenUsage.current.modelContextWindow 缺失时，使用此值作为回退（来自模型配置）。 */
  fallbackContextWindow?: number | null;
  warnPct?: number;
  dangerPct?: number;
  disabled?: boolean;
};

type UsageRow = {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
};

type UsageBreakdownInput = {
  inputTokens: number | null | undefined;
  cachedInputTokens: number | null | undefined;
  cacheCreationInputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
};

const props = withDefaults(defineProps<Props>(), {
  engine: null,
  fallbackContextWindow: null,
  warnPct: 70,
  dangerPct: 85,
  disabled: false,
});

const emit = defineEmits<{ (e: "compact"): void; (e: "reset"): void }>();
const { ctx } = useApiContext();
const router = useRouter();
const popoverOpen = ref(false);
const {
  load: loadRelayPricing,
  rows: relayPriceRows,
  subtitle: relayPriceSubtitle,
  title: relayPriceTitle,
} = useCodeFlowRelayPricing();

const visible = computed(() => {
  return hasCurrentUsageData(props.tokenUsage);
});

/**
 * 上下文窗口占用：
 * - Claude: inputTokens 仅是非缓存输入，需要叠加 cached/cacheCreation。
 * - Codex: 直接使用引擎原生 totalTokens，不用 input 字段兜底估算。
 */
const totalContextTokens = computed<number | null>(() => {
  const cur = props.tokenUsage?.current;
  if (!cur) return null;
  if (props.engine === "codex") {
    return cur.totalTokens ?? null;
  }
  return (cur.inputTokens ?? 0) + (cur.cachedInputTokens ?? 0) + (cur.cacheCreationInputTokens ?? 0);
});

const effectiveContextWindow = computed(() => {
  const fromUsage = props.tokenUsage?.current.modelContextWindow;
  if (fromUsage && fromUsage > 0) return fromUsage;
  const fb = props.fallbackContextWindow;
  if (fb && fb > 0) return fb;
  return null;
});

/** 百分比 = 当前上下文占用 / contextWindow。 */
const contextPct = computed(() => {
  const cw = effectiveContextWindow.value;
  const total = totalContextTokens.value;
  if (!cw || total == null) return null;
  return (total / cw) * 100;
});

/** 进度条标签追加引擎上报的原始累计合计；缺失时不前端估算。 */
const cumulativeRawTotalTokens = computed<number | null>(() => {
  return props.tokenUsage?.cumulative.totalTokens ?? null;
});

const fillWidth = computed(() => {
  if (contextPct.value == null) return "0%";
  return `${Math.min(contextPct.value, 100)}%`;
});

function pctColor(pct: number | null): string {
  if (pct == null) return "var(--app-accent)";
  if (pct >= props.dangerPct) return "var(--app-danger)";
  if (pct >= props.warnPct) return "var(--app-warning)";
  return "var(--app-accent)";
}

const fillColor = computed(() => pctColor(contextPct.value));
const labelColor = computed(() => pctColor(contextPct.value));

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Popover 明细使用完整千分位，避免 K/M 缩写影响排查。 */
function formatTokenDetail(n: number | null | undefined): string {
  return n == null ? "--" : n.toLocaleString();
}

/** 仅在有真实数值时追加明细行，避免把缺失字段展示成 0。 */
function pushUsageRow(rows: UsageRow[], label: string, value: number | null | undefined, options: Omit<UsageRow, "label" | "value"> = {}): void {
  if (value == null) return;
  rows.push({ label, value: formatTokenDetail(value), ...options });
}

/** Codex inputTokens 已含缓存命中，官方展示输入时只扣 cached_input_tokens。 */
function resolveCodexUncachedInput(inputTokens: number | null | undefined, cachedInputTokens: number | null | undefined): number | null {
  if (inputTokens == null) return null;
  return Math.max(0, inputTokens - Math.max(0, cachedInputTokens ?? 0));
}

/** 合并展示用输入：缓存写入也算未命中缓存输入。 */
function resolveUncachedInput(input: UsageBreakdownInput): number | null {
  if (props.engine === "codex") {
    return resolveCodexUncachedInput(input.inputTokens, input.cachedInputTokens);
  }
  if (input.inputTokens == null && input.cacheCreationInputTokens == null) return null;
  return Math.max(0, input.inputTokens ?? 0) + Math.max(0, input.cacheCreationInputTokens ?? 0);
}

/** 生成简洁版四行：未命中输入、命中输入、输出、总计。 */
function buildCompactUsageRows(input: UsageBreakdownInput): UsageRow[] {
  const rows: UsageRow[] = [];
  const uncachedInput = resolveUncachedInput(input);
  const cachedInput = input.cachedInputTokens == null ? null : Math.max(0, input.cachedInputTokens);
  const output = input.outputTokens == null ? null : Math.max(0, input.outputTokens);
  const total = uncachedInput == null && cachedInput == null && output == null
    ? null
    : Math.max(0, uncachedInput ?? 0) + Math.max(0, cachedInput ?? 0) + Math.max(0, output ?? 0);

  pushUsageRow(rows, "输入（未命中缓存）", uncachedInput);
  pushUsageRow(rows, "输入（命中缓存）", cachedInput);
  pushUsageRow(rows, "输出", output);
  pushUsageRow(rows, "总计", total);
  return rows;
}

/** label 展示百分比及上下文总占用 / contextWindow。 */
const label = computed(() => {
  const total = totalContextTokens.value;
  const cw = effectiveContextWindow.value;
  const rawTotal = cumulativeRawTotalTokens.value;
  if (total == null) {
    if (cw && rawTotal != null) return `-- / ${formatTokens(cw)} / ${formatTokens(rawTotal)}`;
    return cw ? `-- / ${formatTokens(cw)}` : "--";
  }
  if (cw) {
    const pct = contextPct.value != null ? `${Math.round(contextPct.value)}%` : "--";
    const usageText = rawTotal != null
      ? `${formatTokens(total)} / ${formatTokens(cw)} / ${formatTokens(rawTotal)}`
      : `${formatTokens(total)} / ${formatTokens(cw)}`;
    return `${pct} (${usageText})`;
  }
  if (rawTotal != null) return `${formatTokens(total)} / -- / ${formatTokens(rawTotal)}`;
  return formatTokens(total);
});

const isDanger = computed(() => contextPct.value != null && contextPct.value >= props.dangerPct);

/** Popover 顶部百分比，与底部进度条保持同一口径。 */
const usagePercentText = computed(() => {
  return contextPct.value == null ? "--" : `${Math.round(contextPct.value)}%`;
});

/** Popover 顶部展示当前上下文占用与窗口上限。 */
const usageWindowText = computed(() => {
  const total = totalContextTokens.value;
  const cw = effectiveContextWindow.value;
  if (total != null && cw) return `${formatTokenDetail(total)} / ${formatTokenDetail(cw)}`;
  if (total != null) return formatTokenDetail(total);
  if (cw) return `-- / ${formatTokenDetail(cw)}`;
  return "--";
});

/** 最近一次请求明细：Codex 按引擎 last usage 展示，会随当前请求上报更新。 */
const currentUsageRows = computed<UsageRow[]>(() => {
  const t = props.tokenUsage;
  if (!t) return [];
  const cur = t.current;
  return buildCompactUsageRows(cur);
});

/** 会话累计明细：只展示引擎已上报的累计字段，不在前端重新扫描历史。 */
const cumulativeUsageRows = computed<UsageRow[]>(() => {
  const cum = props.tokenUsage?.cumulative;
  if (!cum) return [];
  const hasData = Boolean(cum.inputTokens || cum.outputTokens || cum.cachedInputTokens || cum.cacheCreationInputTokens);
  return hasData ? buildCompactUsageRows(cum) : [];
});

const hasCumulativeUsage = computed(() => cumulativeUsageRows.value.length > 0);

const isMobile = typeof window !== "undefined" && window.innerWidth <= 767;

/** 同步 hover 浮层开关，便于打开充值弹窗前主动收起。 */
function handleUsagePopoverOpenChange(open: boolean): void {
  popoverOpen.value = open;
  if (open) void loadRelayPricing(ctx.value);
}

/** 打开充值弹窗时收起上下文浮层，避免层级遮挡。 */
function closeUsagePopover(): void {
  popoverOpen.value = false;
}

/** 应用内跳转模型价格面板，避免打开外部浏览器标签页。 */
function openRelayPriceConfig(): void {
  closeUsagePopover();
  void router.push({ path: "/admin", query: { panel: "relay-price-config" } });
}

function confirmCompact(): void {
  if (props.disabled) return;
  Modal.confirm({ title: "压缩上下文？", okText: "压缩", cancelText: "取消", onOk: () => emit("compact") });
}
function confirmReset(): void {
  if (props.disabled) return;
  Modal.confirm({ title: "重置上下文？（不可恢复）", okText: "重置", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => emit("reset") });
}
</script>

<template>
  <div v-if="visible" class="context-bar">
    <a-popconfirm v-if="!isMobile" title="压缩上下文？" ok-text="压缩" cancel-text="取消"
      placement="topLeft" :disabled="props.disabled" @confirm="!props.disabled && emit('compact')">
      <a-button size="small" type="link"
        :disabled="props.disabled"
        :class="isDanger ? 'context-bar__action--danger' : 'context-bar__action--subtle'">压缩</a-button>
    </a-popconfirm>
    <a-button v-else size="small" type="link"
      :disabled="props.disabled"
      :class="isDanger ? 'context-bar__action--danger' : 'context-bar__action--subtle'"
      @click="confirmCompact">压缩</a-button>

    <a-popconfirm v-if="!isMobile" title="重置上下文？（不可恢复）" ok-text="重置" cancel-text="取消"
      :ok-button-props="{ danger: true }" placement="topLeft" :disabled="props.disabled" @confirm="!props.disabled && emit('reset')">
      <a-button size="small" type="link"
        :disabled="props.disabled"
        :class="isDanger ? 'context-bar__action--danger' : 'context-bar__action--subtle'">重置</a-button>
    </a-popconfirm>
    <a-button v-else size="small" type="link"
      :disabled="props.disabled"
      :class="isDanger ? 'context-bar__action--danger' : 'context-bar__action--subtle'"
      @click="confirmReset">重置</a-button>

    <a-popover
      :open="popoverOpen"
      placement="topRight"
      trigger="hover"
      overlay-class-name="context-usage-popover__overlay"
      :overlay-style="{ maxWidth: '360px' }"
      @open-change="handleUsagePopoverOpenChange"
    >
      <template #content>
        <div class="context-usage-popover">
          <header class="context-usage-popover__header">
            <div class="context-usage-popover__headline">
              <span class="context-usage-popover__eyebrow">上下文窗口</span>
              <strong class="context-usage-popover__window">{{ usageWindowText }}</strong>
            </div>
            <strong class="context-usage-popover__percent" :style="{ color: labelColor }">{{ usagePercentText }}</strong>
          </header>
          <div class="context-usage-popover__meter">
            <div class="context-usage-popover__meter-fill" :style="{ width: fillWidth, background: fillColor }" />
          </div>
          <section v-if="currentUsageRows.length" class="context-usage-popover__section">
            <div class="context-usage-popover__section-heading">
              <div class="context-usage-popover__section-title">最近一次请求</div>
              <span class="context-usage-popover__section-meta">会随请求更新</span>
            </div>
            <div class="context-usage-popover__rows">
              <div
                v-for="row in currentUsageRows"
                :key="`current-${row.label}-${row.hint ?? ''}`"
                class="context-usage-popover__row"
                :class="{ 'context-usage-popover__row--muted': row.muted }"
              >
                <span class="context-usage-popover__label">
                  {{ row.label }}
                  <span v-if="row.hint" class="context-usage-popover__hint">{{ row.hint }}</span>
                </span>
                <strong class="context-usage-popover__value">{{ row.value }}</strong>
              </div>
            </div>
          </section>
          <section v-if="hasCumulativeUsage" class="context-usage-popover__section">
            <div class="context-usage-popover__section-heading">
              <div class="context-usage-popover__section-title">会话累计</div>
              <span class="context-usage-popover__section-meta">引擎累计</span>
            </div>
            <div class="context-usage-popover__rows">
              <div
                v-for="row in cumulativeUsageRows"
                :key="`cumulative-${row.label}-${row.hint ?? ''}`"
                class="context-usage-popover__row"
                :class="{ 'context-usage-popover__row--muted': row.muted }"
              >
                <span class="context-usage-popover__label">
                  {{ row.label }}
                  <span v-if="row.hint" class="context-usage-popover__hint">{{ row.hint }}</span>
                </span>
                <strong class="context-usage-popover__value">{{ row.value }}</strong>
              </div>
            </div>
          </section>
          <section class="context-usage-popover__section context-usage-popover__relay">
            <div class="context-usage-popover__relay-heading">
              <div class="context-usage-popover__relay-title">
                <div class="context-usage-popover__section-title">{{ relayPriceTitle }}</div>
                <span class="context-usage-popover__section-meta">{{ relayPriceSubtitle }}</span>
              </div>
              <div class="context-usage-popover__relay-actions">
                <a-button size="small" type="link" @click="openRelayPriceConfig">更多模型价格</a-button>
                <RelayBalancePackPurchaseButton
                  size="small"
                  entry-source="DIRECT_LINK"
                  label="Token充值"
                  @opened="closeUsagePopover"
                />
              </div>
            </div>
            <dl class="context-usage-popover__price-rows">
              <div
                v-for="row in relayPriceRows"
                :key="row.label"
                class="context-usage-popover__price-row"
              >
                <dt>{{ row.label }}</dt>
                <dd>{{ row.price }}</dd>
              </div>
            </dl>
          </section>
        </div>
      </template>
      <div class="context-bar__usage">
        <div class="context-bar__track">
          <div class="context-bar__fill" :style="{ width: fillWidth, background: fillColor }" />
        </div>
        <span class="context-bar__label" :style="{ color: labelColor }">{{ label }}</span>
      </div>
    </a-popover>
  </div>
</template>
