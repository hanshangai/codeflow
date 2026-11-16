import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRelayRechargePresetAmounts,
  calculateRelayRechargePricingQuote,
  DEFAULT_RELAY_RECHARGE_PRICING_TIERS,
  formatRelayRechargeDiscountLabel,
  toRelayRechargePricingTierViews,
  validateRelayRechargePricingDraft,
} from "../../packages/shared/src/index.ts";

test("默认充值档位生成固定基础档和五级优惠", () => {
  assert.deepEqual(buildRelayRechargePresetAmounts(DEFAULT_RELAY_RECHARGE_PRICING_TIERS), [
    1_000,
    5_000,
    10_000,
    20_000,
    50_000,
    100_000,
  ]);
  assert.deepEqual(toRelayRechargePricingTierViews(DEFAULT_RELAY_RECHARGE_PRICING_TIERS).map((tier) => tier.discountLabel), [
    "98折",
    "95折",
    "92折",
    "9折",
    "88折",
  ]);
});

test("充值报价按最高命中门槛计算且不叠加", () => {
  assert.deepEqual(calculateRelayRechargePricingQuote(26_800, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, true), {
    balanceAmountFen: 26_800,
    paidAmountFen: 24_656,
    savedAmountFen: 2_144,
    payPercent: 92,
    discountType: "PERCENT_OFF",
    discountValue: 92,
    discountLabel: "92折",
    discountThresholdAmountFen: 20_000,
  });
  assert.equal(calculateRelayRechargePricingQuote(49_900, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, true).payPercent, 92);
  assert.equal(calculateRelayRechargePricingQuote(50_000, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, true).payPercent, 90);
  assert.equal(calculateRelayRechargePricingQuote(100_000, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, true).paidAmountFen, 88_000);
});

test("充值报价覆盖面额上下限和每档前一元及门槛", () => {
  assert.equal(calculateRelayRechargePricingQuote(100, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, true).paidAmountFen, 100);
  assert.equal(calculateRelayRechargePricingQuote(1_000_000, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, true).paidAmountFen, 880_000);
  for (const [index, tier] of DEFAULT_RELAY_RECHARGE_PRICING_TIERS.entries()) {
    const before = calculateRelayRechargePricingQuote(tier.thresholdAmountFen - 100, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, true);
    const at = calculateRelayRechargePricingQuote(tier.thresholdAmountFen, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, true);
    assert.equal(before.payPercent, index === 0 ? 100 : DEFAULT_RELAY_RECHARGE_PRICING_TIERS[index - 1]?.payPercent);
    assert.equal(at.payPercent, tier.payPercent);
  }
});

test("首档以下金额保持无折扣", () => {
  const quote = calculateRelayRechargePricingQuote(2_000, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, true);
  assert.equal(quote.discountType, "NONE");
  assert.equal(quote.paidAmountFen, 2_000);
  assert.equal(quote.savedAmountFen, 0);
  assert.equal(quote.discountThresholdAmountFen, null);
});

test("关闭优惠后任意面额按原价返回且不命中任何档位", () => {
  for (const amountFen of [100, 5_000, 26_800, 1_000_000]) {
    assert.deepEqual(calculateRelayRechargePricingQuote(amountFen, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, false), {
      balanceAmountFen: amountFen,
      paidAmountFen: amountFen,
      savedAmountFen: 0,
      payPercent: 100,
      discountType: "NONE",
      discountValue: 0,
      discountLabel: "",
      discountThresholdAmountFen: null,
    });
  }
});

test("漏传优惠开关时失败方向是不打折而不是打折", () => {
  // @ts-expect-error 第三参已改为必填；此处刻意漏传，锁定"忘记传参"的失败方向。
  const quote = calculateRelayRechargePricingQuote(26_800, DEFAULT_RELAY_RECHARGE_PRICING_TIERS);
  assert.equal(quote.discountType, "NONE");
  assert.equal(quote.paidAmountFen, 26_800);
});

test("关闭优惠仍显式拒绝非法阶梯配置", () => {
  assert.throws(() => calculateRelayRechargePricingQuote(10_000, [], false), /优惠阶梯配置无效/u);
  assert.throws(() => calculateRelayRechargePricingQuote(10_000, DEFAULT_RELAY_RECHARGE_PRICING_TIERS.map((tier, index) => ({
    ...tier,
    payPercent: index === 0 ? 100 : tier.payPercent,
  })), false), /优惠阶梯配置无效/u);
});

test("折扣标签覆盖整十、非整十和低比例", () => {
  assert.equal(formatRelayRechargeDiscountLabel(90), "9折");
  assert.equal(formatRelayRechargeDiscountLabel(98), "98折");
  assert.equal(formatRelayRechargeDiscountLabel(5), "支付5%");
  assert.throws(() => formatRelayRechargeDiscountLabel(0), /支付比例/u);
});

test("配置校验规范化活动文案并保留合法档位顺序", () => {
  const result = validateRelayRechargePricingDraft({
    discountEnabled: true,
    activityEnabled: true,
    activityText: " 818活动特价 ",
    tiers: DEFAULT_RELAY_RECHARGE_PRICING_TIERS.map((tier) => ({ ...tier })),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.discountEnabled, true);
  assert.equal(result.value.activityText, "818活动特价");
  assert.deepEqual(result.value.tiers, DEFAULT_RELAY_RECHARGE_PRICING_TIERS);
});

test("配置校验要求优惠开关为布尔值", () => {
  const result = validateRelayRechargePricingDraft({
    activityEnabled: false,
    activityText: "",
    tiers: DEFAULT_RELAY_RECHARGE_PRICING_TIERS.map((tier) => ({ ...tier })),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.issues, [{ code: "DISCOUNT_ENABLED_INVALID", message: "优惠开关必须是布尔值", field: "discountEnabled" }]);
});

test("配置校验拒绝档位数量、顺序、比例和活动文案错误", () => {
  const result = validateRelayRechargePricingDraft({
    discountEnabled: true,
    activityEnabled: true,
    activityText: "第一行\n第二行",
    tiers: [
      { thresholdAmountFen: 5_000, payPercent: 98 },
      { thresholdAmountFen: 5_000, payPercent: 98 },
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(new Set(result.issues.map((issue) => issue.code)), new Set([
    "ACTIVITY_TEXT_LINE_BREAK",
    "TIER_COUNT_INVALID",
    "TIER_THRESHOLD_ORDER_INVALID",
    "TIER_PAY_PERCENT_ORDER_INVALID",
  ]));
});

test("配置校验覆盖支付比例和活动文案长度边界", () => {
  const valid = validateRelayRechargePricingDraft({
    discountEnabled: true,
    activityEnabled: true,
    activityText: "活".repeat(20),
    tiers: [
      { thresholdAmountFen: 5_000, payPercent: 99 },
      { thresholdAmountFen: 10_000, payPercent: 75 },
      { thresholdAmountFen: 20_000, payPercent: 50 },
      { thresholdAmountFen: 50_000, payPercent: 25 },
      { thresholdAmountFen: 100_000, payPercent: 1 },
    ],
  });
  assert.equal(valid.ok, true);

  for (const invalidPercent of [0, 100]) {
    const invalid = validateRelayRechargePricingDraft({
      discountEnabled: true,
      activityEnabled: true,
      activityText: "活".repeat(21),
      tiers: DEFAULT_RELAY_RECHARGE_PRICING_TIERS.map((tier, index) => ({
        ...tier,
        payPercent: index === 0 ? invalidPercent : tier.payPercent,
      })),
    });
    assert.equal(invalid.ok, false);
    if (invalid.ok) continue;
    assert.equal(invalid.issues.some((issue) => issue.code === "ACTIVITY_TEXT_TOO_LONG"), true);
    assert.equal(invalid.issues.some((issue) => issue.code === "TIER_PAY_PERCENT_INVALID"), true);
  }
});

test("充值报价拒绝空、乱序和非法比例阶梯", () => {
  assert.throws(() => calculateRelayRechargePricingQuote(10_000, [], true), /优惠阶梯配置无效/u);
  assert.throws(() => calculateRelayRechargePricingQuote(10_000, [
    ...DEFAULT_RELAY_RECHARGE_PRICING_TIERS.slice(0, 2).reverse(),
    ...DEFAULT_RELAY_RECHARGE_PRICING_TIERS.slice(2),
  ], true), /优惠阶梯配置无效/u);
  assert.throws(() => calculateRelayRechargePricingQuote(10_000, DEFAULT_RELAY_RECHARGE_PRICING_TIERS.map((tier, index) => ({
    ...tier,
    payPercent: index === 0 ? 100 : tier.payPercent,
  })), true), /优惠阶梯配置无效/u);
});

test("充值报价拒绝非整元和越界金额", () => {
  assert.throws(() => calculateRelayRechargePricingQuote(1_050, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, true), /整元分值/u);
  assert.throws(() => calculateRelayRechargePricingQuote(1_000_100, DEFAULT_RELAY_RECHARGE_PRICING_TIERS, true), /整元分值/u);
});
