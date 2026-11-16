import { computed, ref } from "vue";
import { ENGINE_MODEL_PROVIDERS, getEngineModelInfo, type RelayModelPriceView } from "@codeflowai/shared";

import { getRelayPricingCurrent } from "../api/relay-pricing";
import type { ApiRequestContext } from "../api/request";

export type CodeFlowRelayPriceRow = {
  label: string;
  price: string;
};

export type CodeFlowFeaturedRelayPriceGroup = {
  key: string;
  title: string;
  configured: boolean;
  rows: CodeFlowRelayPriceRow[];
};

const CODEFLOW_SUPPLIER = "codeflow";
/** 充值面板价格区展示的模型条数上限。 */
const FEATURED_PRICE_LIMIT = 2;
const EMPTY_PRICE_ROWS: CodeFlowRelayPriceRow[] = [
  { label: "输入（命中缓存）", price: "-" },
  { label: "输入（未命中缓存）", price: "-" },
  { label: "输出", price: "-" },
];

/** 提供 CodeFlow 供应商第一条中转价格，用于充值、余额和用量浮层统一展示。 */
export function useCodeFlowRelayPricing() {
  const loading = ref(false);
  const errorText = ref("");
  const catalogLoaded = ref(false);
  const catalogErrorText = ref("");
  const prices = ref<RelayModelPriceView[]>([]);
  const selectedPrice = ref<RelayModelPriceView | null>(null);
  let activeRequest: Promise<void> | null = null;

  const title = computed(() => {
    const modelVersion = selectedPrice.value?.modelVersion.trim();
    return modelVersion ? `内置中转${modelVersion}价格` : "内置中转价格";
  });
  const subtitle = computed(() => {
    if (loading.value) return "价格读取中";
    return errorText.value || "人民币 / 百万Token";
  });
  // 无价格时同样返回副本：调用方原地改动不应污染模块级占位常量。
  const rows = computed<CodeFlowRelayPriceRow[]>(() => selectedPrice.value ? toPriceRows(selectedPrice.value) : EMPTY_PRICE_ROWS.map((row) => ({ ...row })));
  const featuredPriceGroups = computed(() => buildCodeFlowFeaturedPriceGroups(prices.value));

  /** 拉取当前价格目录，同时保留旧浮层使用的 CodeFlow 首行选择。 */
  async function load(ctx: ApiRequestContext): Promise<void> {
    if (activeRequest) {
      await activeRequest;
      return;
    }
    loading.value = true;
    catalogLoaded.value = false;
    errorText.value = "";
    catalogErrorText.value = "";
    prices.value = [];
    selectedPrice.value = null;
    activeRequest = (async () => {
      try {
        const result = await getRelayPricingCurrent(ctx);
        if (!result.ok) {
          prices.value = [];
          selectedPrice.value = null;
          catalogErrorText.value = result.message || "价格读取失败";
          errorText.value = catalogErrorText.value;
          return;
        }
        prices.value = result.rows;
        catalogLoaded.value = true;
        const price = result.rows.find((row) => row.supplier.trim().toLowerCase() === CODEFLOW_SUPPLIER) ?? null;
        selectedPrice.value = price;
        if (!price) errorText.value = "未配置 CodeFlow 价格";
      } catch (error) {
        prices.value = [];
        selectedPrice.value = null;
        catalogErrorText.value = error instanceof Error ? error.message : "价格读取失败";
        errorText.value = catalogErrorText.value;
      } finally {
        loading.value = false;
      }
    })();
    try {
      await activeRequest;
    } finally {
      activeRequest = null;
    }
  }

  return {
    catalogLoaded,
    catalogErrorText,
    errorText,
    featuredPriceGroups,
    loading,
    rows,
    selectedPrice,
    subtitle,
    title,
    load,
  };
}

/**
 * 按「模型价格配置」的顺序取前两条生成充值面板分组：顺序即后台价格表行序
 * （后端按 sortOrder 返回），不按供应商或模型名筛选——否则前两行不是内置中转渠道时面板会误显示「未配置」。
 * 只配了一条就只展示一条；空表保留一个占位分组，让面板继续显示「未配置」而不是整块消失。
 */
export function buildCodeFlowFeaturedPriceGroups(
  prices: readonly RelayModelPriceView[],
): CodeFlowFeaturedRelayPriceGroup[] {
  const featured = prices.slice(0, FEATURED_PRICE_LIMIT).map((price) => ({
    key: price.id,
    title: resolveRelayPriceTitle(price),
    configured: true,
    rows: toPriceRows(price),
  }));
  if (featured.length) return featured;
  return [{
    key: "empty",
    title: "内置中转",
    configured: false,
    rows: EMPTY_PRICE_ROWS.map((row) => ({ ...row })),
  }];
}

/**
 * 用配置行的供应商推出所属引擎，再取该模型的展示名；查不到时回退配置里的 modelVersion。
 * 退役模型会被解析成「id（已下线）」，价格标题不该带下线标注，因此同样回退原始 id。
 */
function resolveRelayPriceTitle(price: RelayModelPriceView): string {
  const engine = price.providerId ? ENGINE_MODEL_PROVIDERS[price.providerId]?.engines[0] : undefined;
  const displayName = engine ? getEngineModelInfo(engine, price.modelVersion)?.displayName : null;
  if (!displayName || displayName.includes("（已下线）")) return price.modelVersion;
  return displayName;
}

/** 将毫元/百万 Token 配置转换为前端价格行，保留最多三位小数。 */
function toPriceRows(price: RelayModelPriceView): CodeFlowRelayPriceRow[] {
  return [
    { label: "输入（命中缓存）", price: formatMilliYuanPrice(price.inputCachedPriceMilliYuanPerMillionTokens) },
    { label: "输入（未命中缓存）", price: formatMilliYuanPrice(price.inputUncachedPriceMilliYuanPerMillionTokens) },
    { label: "输出", price: formatMilliYuanPrice(price.outputPriceMilliYuanPerMillionTokens) },
  ];
}

/** 格式化毫元价格，去掉无意义的末尾 0。 */
function formatMilliYuanPrice(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "-";
  const text = (value / 1000).toFixed(3).replace(/(?:\.0+|(\.\d*?)0+)$/, "$1");
  return `${text}元`;
}
