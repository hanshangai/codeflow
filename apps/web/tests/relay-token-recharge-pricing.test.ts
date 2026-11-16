import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_RELAY_RECHARGE_PRICING_TIERS,
  formatRelayRechargeDiscountLabel,
  type RelayModelPriceView,
  type RelayRechargePricingPublicView,
} from "@codeflowai/shared";

import { buildCodeFlowFeaturedPriceGroups } from "../src/composables/useCodeFlowRelayPricing.ts";
import {
  buildRelayRechargePresetOptions,
  resolveRelayRechargeAmountBucket,
} from "../src/features/admin/relayTokenRechargePricing.ts";

const modalSource = readFileSync(
  new URL("../src/features/admin/components/relay-token-recharge-modal.vue", import.meta.url),
  "utf8",
);
const balanceReminderSource = readFileSync(
  new URL("../src/features/composer/components/relay-balance-reminder.vue", import.meta.url),
  "utf8",
);
const contextUsageBarSource = readFileSync(
  new URL("../src/features/composer/components/context-usage-bar.vue", import.meta.url),
  "utf8",
);
const pricingComposableSource = readFileSync(
  new URL("../src/composables/useCodeFlowRelayPricing.ts", import.meta.url),
  "utf8",
);

/** 构造用户侧默认充值价格配置。 */
function pricingConfig(): RelayRechargePricingPublicView {
  return {
    version: 7,
    discountEnabled: true,
    activityEnabled: true,
    activityText: "818活动特价",
    basePresetAmountFen: 1_000,
    tiers: DEFAULT_RELAY_RECHARGE_PRICING_TIERS.map((tier) => ({
      ...tier,
      discountLabel: formatRelayRechargeDiscountLabel(tier.payPercent),
    })),
  };
}

/** 构造一条模型价格视图。 */
function modelPrice(modelVersion: string, providerId: RelayModelPriceView["providerId"] = "openai"): RelayModelPriceView {
  return {
    id: `price-${modelVersion}`,
    providerId,
    currency: "CNY",
    supplier: "可编辑供应商文案",
    modelVendor: "OpenAI",
    modelVersion,
    multimodal: true,
    inputCachedPriceMilliYuanPerMillionTokens: 150,
    inputUncachedPriceMilliYuanPerMillionTokens: 1_500,
    outputPriceMilliYuanPerMillionTokens: 9_000,
    remark: "",
    sortOrder: 1,
    updatedAt: 1,
    configuredBy: { userId: "user-1", email: "admin@example.com" },
  };
}

test("充值常用金额由基础档和后台五档生成并保留报价", () => {
  const presets = buildRelayRechargePresetOptions(pricingConfig());
  assert.deepEqual(presets.map((item) => item.amountFen), [1_000, 5_000, 10_000, 20_000, 50_000, 100_000]);
  assert.deepEqual(presets.map((item) => item.discountLabel), ["", "98折", "95折", "92折", "9折", "88折"]);
  assert.equal(presets[3]?.savedAmountFen, 1_600);
  assert.equal(presets[5]?.paidAmountFen, 88_000);
  assert.equal(resolveRelayRechargeAmountBucket(20_000, presets), "200");
  assert.equal(resolveRelayRechargeAmountBucket(26_800, presets), "custom");
});

test("关闭优惠后常用金额按钮不再提供折扣报价", () => {
  const presets = buildRelayRechargePresetOptions({ ...pricingConfig(), discountEnabled: false });
  assert.deepEqual(presets.map((item) => item.amountFen), [1_000, 5_000, 10_000, 20_000, 50_000, 100_000]);
  assert.deepEqual(presets.map((item) => item.discountLabel), ["", "", "", "", "", ""]);
  assert.deepEqual(presets.map((item) => item.paidAmountFen), [1_000, 5_000, 10_000, 20_000, 50_000, 100_000]);
  assert.equal(presets.every((item) => item.savedAmountFen === 0), true);
});

/** 充值面板展示的是「价格配置的前两条」，模型名与供应商都不参与筛选。 */
test("充值面板按价格配置顺序取前两条，不受供应商限制", () => {
  const groups = buildCodeFlowFeaturedPriceGroups([
    modelPrice("kimi-k3", "moonshot"),
    modelPrice("claude-opus-5", "anthropic"),
    modelPrice("gpt-5.6-sol"),
  ]);
  assert.deepEqual(groups.map((group) => group.title), ["Kimi K3", "Claude Opus 5"]);
  assert.deepEqual(groups.map((group) => group.configured), [true, true]);
  assert.equal(groups.length, 2, "最多展示两条");
});

/** 少于两条按实际数量展示；空表保留「未配置」占位，面板不会整块消失。 */
test("配置不足两条时按实际数量展示，空表保留未配置占位", () => {
  const single = buildCodeFlowFeaturedPriceGroups([modelPrice("claude-opus-5", "anthropic")]);
  assert.equal(single.length, 1);
  assert.equal(single[0]?.configured, true);
  assert.equal(single[0]?.title, "Claude Opus 5");

  const empty = buildCodeFlowFeaturedPriceGroups([]);
  assert.equal(empty.length, 1);
  assert.equal(empty[0]?.configured, false);
  assert.equal(empty[0]?.title, "内置中转");
  assert.deepEqual(empty[0]?.rows.map((row) => row.price), ["-", "-", "-"]);
});

/** 取不到展示名、模型已退役或缺供应商时，标题回退配置里的 id，不出现「（已下线）」。 */
test("价格标题在退役或缺展示名时回退配置 id", () => {
  const legacy = buildCodeFlowFeaturedPriceGroups([modelPrice("deepseek-v4-flash", "deepseek")]);
  assert.deepEqual(legacy.map((group) => group.title), ["deepseek-v4-flash"]);

  const unknown = buildCodeFlowFeaturedPriceGroups([modelPrice("unknown-model-x", "openai")]);
  assert.deepEqual(unknown.map((group) => group.title), ["unknown-model-x"]);

  const noProvider = buildCodeFlowFeaturedPriceGroups([modelPrice("claude-opus-5", null)]);
  assert.deepEqual(noProvider.map((group) => group.title), ["claude-opus-5"]);
});

test("模型价格与使用日志入口使用应用内后台路由", () => {
  const relayPriceTarget = /path: "\/admin", query: \{ panel: "relay-price-config" \}/u;
  assert.match(modalSource, relayPriceTarget);
  assert.match(balanceReminderSource, relayPriceTarget);
  assert.match(contextUsageBarSource, relayPriceTarget);
  assert.match(balanceReminderSource, /path: "\/admin", query: \{ panel: "relay-self-usage" \}/u);
  for (const source of [modalSource, balanceReminderSource, contextUsageBarSource]) {
    assert.doesNotMatch(source, /window\.open\([^)]*relay-price-config/u);
  }
});

test("充值弹框使用配置版本、充值面额和订单实付快照", () => {
  assert.match(modalSource, /rechargePricingVersion: pricing\.version/u);
  assert.match(modalSource, /calculateRelayRechargePricingQuote\(amountFen, pricing\.tiers, pricing\.discountEnabled\)/u);
  assert.match(modalSource, /pricing\.discountEnabled === false/u);
  assert.match(modalSource, /if \(amountYuan == null\) return null/u);
  assert.match(modalSource, /order\.value\?\.balanceAmountFen !== amountFen/u);
  assert.match(modalSource, /resolveAmountBucketFromFen\(value\.balanceAmountFen\)/u);
  assert.match(modalSource, /formatPriceFen\(order\.paidAmountFen\)/u);
  assert.match(modalSource, /RELAY_RECHARGE_PRICING_CHANGED/u);
  assert.match(modalSource, /RELAY_RECHARGE_UI_OUTDATED/u);
  assert.match(modalSource, /pricingUnavailableReason/u);
  assert.match(modalSource, /beginRequestScope\(\{ preserveAmount: true \}\)/u);
  assert.match(modalSource, /relayPriceCatalogLoaded && !relayPriceLoading && !relayPriceLoadError && !group\.configured/u);
  assert.match(modalSource, /relay-token-pack__purchase-grid--payment[\s\S]*<div v-else-if="order" class="relay-token-pack__payment-card">/u);
  assert.match(modalSource, /<div v-if="!hasOpenOrder" class="relay-token-pack__price-card">/u);
  assert.doesNotMatch(modalSource, /本次订单已锁定|>订单信息<|paymentOrder\?\.outTradeNo/u);
  assert.match(modalSource, /<a-segmented[\s\S]*block/u);
  assert.match(modalSource, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/u);
  assert.match(modalSource, /\.relay-token-pack__purchase-grid \{[\s\S]*align-items: stretch/u);
  assert.match(modalSource, /\.relay-token-pack__pay-button \{\s*margin-top: 8px/u);
  assert.doesNotMatch(modalSource, /margin-top: auto/u);
  assert.match(modalSource, /\.relay-token-pack__price-card dl div \{[\s\S]*padding: 3px 0/u);
  assert.match(modalSource, /maxHeight: 'calc\(100vh - 160px\)'/u);
  assert.match(modalSource, /paymentOrder\.value\?\.qrExpiresAt/u);
  assert.match(modalSource, /二维码 \{\{ countdownText \}\} 后失效/u);
  assert.match(modalSource, /if \(manual\) refreshing\.value = true/u);
  assert.doesNotMatch(modalSource, /付款后页面会自动刷新状态/u);
  assert.match(pricingComposableSource, /catalogLoaded\.value = false/u);
  assert.match(pricingComposableSource, /catalogLoaded\.value = true/u);
  assert.doesNotMatch(modalSource, /presetAmountYuanOptions/u);
  assert.doesNotMatch(modalSource, /order\.amountFen/u);
});
