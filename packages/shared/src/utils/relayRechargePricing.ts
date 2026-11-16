import {
  RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MAX_FEN,
  RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MIN_FEN,
  RELAY_BALANCE_PACK_CUSTOM_AMOUNT_STEP_FEN,
  RELAY_RECHARGE_ACTIVITY_TEXT_MAX_LENGTH,
  RELAY_RECHARGE_BASE_PRESET_AMOUNT_FEN,
  RELAY_RECHARGE_PRICING_TIER_COUNT,
} from "../types/billing.js";
import type {
  RelayRechargePricingDraft,
  RelayRechargePricingQuote,
  RelayRechargePricingTierInput,
  RelayRechargePricingTierView,
} from "../types/billing.js";

export type RelayRechargePricingValidationIssue = {
  code: string;
  message: string;
  field: string;
  tierIndex?: number;
};

export type RelayRechargePricingValidationResult =
  | { ok: true; value: RelayRechargePricingDraft }
  | { ok: false; issues: RelayRechargePricingValidationIssue[] };

/** 校验并规范化后台充值定价草稿；非法输入只返回明确问题，不排序或补默认值。 */
export function validateRelayRechargePricingDraft(input: unknown): RelayRechargePricingValidationResult {
  const issues: RelayRechargePricingValidationIssue[] = [];
  const record = isRecord(input) ? input : null;
  if (!record) {
    return {
      ok: false,
      issues: [{ code: "CONFIG_REQUIRED", message: "Token 充值定价配置必须是对象", field: "config" }],
    };
  }

  const activityEnabled = typeof record.activityEnabled === "boolean" ? record.activityEnabled : null;
  if (activityEnabled === null) {
    issues.push({ code: "ACTIVITY_ENABLED_INVALID", message: "活动开关必须是布尔值", field: "activityEnabled" });
  }

  const discountEnabled = typeof record.discountEnabled === "boolean" ? record.discountEnabled : null;
  if (discountEnabled === null) {
    issues.push({ code: "DISCOUNT_ENABLED_INVALID", message: "优惠开关必须是布尔值", field: "discountEnabled" });
  }

  const activityText = typeof record.activityText === "string" ? record.activityText.trim() : null;
  if (activityText === null) {
    issues.push({ code: "ACTIVITY_TEXT_INVALID", message: "活动用语必须是字符串", field: "activityText" });
  } else {
    if (/\r|\n/u.test(activityText)) {
      issues.push({ code: "ACTIVITY_TEXT_LINE_BREAK", message: "活动用语不能换行", field: "activityText" });
    }
    if (Array.from(activityText).length > RELAY_RECHARGE_ACTIVITY_TEXT_MAX_LENGTH) {
      issues.push({
        code: "ACTIVITY_TEXT_TOO_LONG",
        message: `活动用语不能超过 ${RELAY_RECHARGE_ACTIVITY_TEXT_MAX_LENGTH} 个字符`,
        field: "activityText",
      });
    }
    if (activityEnabled === true && !activityText) {
      issues.push({ code: "ACTIVITY_TEXT_REQUIRED", message: "开启活动展示时必须填写活动用语", field: "activityText" });
    }
  }

  const parsedTiers = validatePricingTiers(record.tiers, issues);

  if (
    issues.length > 0
    || activityEnabled === null
    || discountEnabled === null
    || activityText === null
    || parsedTiers.length !== RELAY_RECHARGE_PRICING_TIER_COUNT
    || parsedTiers.some((tier) => tier === null)
  ) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      discountEnabled,
      activityEnabled,
      activityText,
      tiers: parsedTiers as RelayRechargePricingTierInput[],
    },
  };
}

/** 按产品折扣口径格式化支付比例，避免低比例被误读为传统“折”。 */
export function formatRelayRechargeDiscountLabel(payPercent: number): string {
  requirePayPercent(payPercent);
  if (payPercent < 10) return `支付${payPercent}%`;
  return payPercent % 10 === 0 ? `${payPercent / 10}折` : `${payPercent}折`;
}

/** 为 API 和 UI 派生只读折扣文案，配置持久层只保存金额门槛与支付比例。 */
export function toRelayRechargePricingTierViews(
  tiers: readonly RelayRechargePricingTierInput[],
): RelayRechargePricingTierView[] {
  return tiers.map((tier) => ({
    ...tier,
    discountLabel: formatRelayRechargeDiscountLabel(tier.payPercent),
  }));
}

/**
 * 使用已验证阶梯试算充值面额、实付与节省金额；关闭优惠时按面额原价返回。
 * discountEnabled 无默认值：资金口径不允许"忘记传参即按打折处理"，调用方必须显式表态。
 */
export function calculateRelayRechargePricingQuote(
  balanceAmountFen: number,
  tiers: readonly RelayRechargePricingTierInput[],
  discountEnabled: boolean,
): RelayRechargePricingQuote {
  if (
    !Number.isSafeInteger(balanceAmountFen)
    || balanceAmountFen < RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MIN_FEN
    || balanceAmountFen > RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MAX_FEN
    || balanceAmountFen % RELAY_BALANCE_PACK_CUSTOM_AMOUNT_STEP_FEN !== 0
  ) {
    throw new RangeError("Token 充值面额必须是 1 到 10000 元之间的整元分值");
  }

  const tierIssues: RelayRechargePricingValidationIssue[] = [];
  const parsedTiers = validatePricingTiers(tiers, tierIssues);
  if (tierIssues.length > 0 || parsedTiers.some((tier) => tier === null)) {
    throw new RangeError(`Token 充值优惠阶梯配置无效：${tierIssues[0]?.message ?? "存在非法档位"}`);
  }

  // 先校验再短路：配置损坏仍显式失败，关闭优惠时不匹配任何档位。
  if (!discountEnabled) return buildNoDiscountQuote(balanceAmountFen);

  let matchedTier: RelayRechargePricingTierInput | null = null;
  for (const tier of parsedTiers as RelayRechargePricingTierInput[]) {
    if (tier.thresholdAmountFen > balanceAmountFen) break;
    matchedTier = tier;
  }
  if (!matchedTier) return buildNoDiscountQuote(balanceAmountFen);

  requirePayPercent(matchedTier.payPercent);
  const numerator = balanceAmountFen * matchedTier.payPercent;
  if (!Number.isSafeInteger(numerator) || numerator % 100 !== 0) {
    throw new RangeError("Token 充值实付金额无法精确到分");
  }
  const paidAmountFen = numerator / 100;
  return {
    balanceAmountFen,
    paidAmountFen,
    savedAmountFen: balanceAmountFen - paidAmountFen,
    payPercent: matchedTier.payPercent,
    discountType: "PERCENT_OFF",
    discountValue: matchedTier.payPercent,
    discountLabel: formatRelayRechargeDiscountLabel(matchedTier.payPercent),
    discountThresholdAmountFen: matchedTier.thresholdAmountFen,
  };
}

/** 构造无折扣报价；关闭优惠与未命中任何档位共用同一结构。 */
function buildNoDiscountQuote(balanceAmountFen: number): RelayRechargePricingQuote {
  return {
    balanceAmountFen,
    paidAmountFen: balanceAmountFen,
    savedAmountFen: 0,
    payPercent: 100,
    discountType: "NONE",
    discountValue: 0,
    discountLabel: "",
    discountThresholdAmountFen: null,
  };
}

/** 生成固定基础档加五个配置门槛，供充值弹框稳定渲染三列两行。 */
export function buildRelayRechargePresetAmounts(
  tiers: readonly RelayRechargePricingTierInput[],
): number[] {
  return [RELAY_RECHARGE_BASE_PRESET_AMOUNT_FEN, ...tiers.map((tier) => tier.thresholdAmountFen)];
}

/** 校验五级优惠阶梯并保留原始顺序，供配置保存与资金报价复用同一裁决。 */
function validatePricingTiers(
  input: unknown,
  issues: RelayRechargePricingValidationIssue[],
): Array<RelayRechargePricingTierInput | null> {
  const rawTiers = Array.isArray(input) ? input : null;
  if (!rawTiers) {
    issues.push({ code: "TIERS_INVALID", message: "优惠阶梯必须是数组", field: "tiers" });
  } else if (rawTiers.length !== RELAY_RECHARGE_PRICING_TIER_COUNT) {
    issues.push({
      code: "TIER_COUNT_INVALID",
      message: `优惠阶梯必须恰好配置 ${RELAY_RECHARGE_PRICING_TIER_COUNT} 档`,
      field: "tiers",
    });
  }

  const parsedTiers = (rawTiers ?? []).map((rawTier, tierIndex): RelayRechargePricingTierInput | null => {
    if (!isRecord(rawTier)) {
      issues.push({ code: "TIER_INVALID", message: `第 ${tierIndex + 1} 档必须是对象`, field: `tiers.${tierIndex}`, tierIndex });
      return null;
    }
    const thresholdAmountFen = typeof rawTier.thresholdAmountFen === "number" ? rawTier.thresholdAmountFen : null;
    const payPercent = typeof rawTier.payPercent === "number" ? rawTier.payPercent : null;
    let valid = true;
    if (
      thresholdAmountFen === null
      || !Number.isSafeInteger(thresholdAmountFen)
      || thresholdAmountFen % RELAY_BALANCE_PACK_CUSTOM_AMOUNT_STEP_FEN !== 0
      || thresholdAmountFen <= RELAY_RECHARGE_BASE_PRESET_AMOUNT_FEN
      || thresholdAmountFen < RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MIN_FEN
      || thresholdAmountFen > RELAY_BALANCE_PACK_CUSTOM_AMOUNT_MAX_FEN
    ) {
      valid = false;
      issues.push({
        code: "TIER_THRESHOLD_INVALID",
        message: `第 ${tierIndex + 1} 档起充金额必须是大于 10 元且不超过 10000 元的整元分值`,
        field: `tiers.${tierIndex}.thresholdAmountFen`,
        tierIndex,
      });
    }
    if (payPercent === null || !Number.isSafeInteger(payPercent) || payPercent < 1 || payPercent > 99) {
      valid = false;
      issues.push({
        code: "TIER_PAY_PERCENT_INVALID",
        message: `第 ${tierIndex + 1} 档支付比例必须是 1 到 99 的整数`,
        field: `tiers.${tierIndex}.payPercent`,
        tierIndex,
      });
    }
    return valid && thresholdAmountFen !== null && payPercent !== null ? { thresholdAmountFen, payPercent } : null;
  });

  for (let index = 1; index < parsedTiers.length; index += 1) {
    const previous = parsedTiers[index - 1];
    const current = parsedTiers[index];
    if (!previous || !current) continue;
    if (current.thresholdAmountFen <= previous.thresholdAmountFen) {
      issues.push({
        code: "TIER_THRESHOLD_ORDER_INVALID",
        message: `第 ${index + 1} 档起充金额必须高于前一档`,
        field: `tiers.${index}.thresholdAmountFen`,
        tierIndex: index,
      });
    }
    if (current.payPercent >= previous.payPercent) {
      issues.push({
        code: "TIER_PAY_PERCENT_ORDER_INVALID",
        message: `第 ${index + 1} 档支付比例必须低于前一档`,
        field: `tiers.${index}.payPercent`,
        tierIndex: index,
      });
    }
  }
  return parsedTiers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requirePayPercent(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 99) {
    throw new RangeError("Token 充值支付比例必须是 1 到 99 的整数");
  }
}
