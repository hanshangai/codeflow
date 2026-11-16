import {
  calculateRelayRechargePricingQuote,
  type RelayRechargePricingPublicView,
  type RelayRechargePricingQuote,
} from "@codeflowai/shared";

export type RelayRechargePresetOption = RelayRechargePricingQuote & {
  amountFen: number;
};

/** 由服务端配置生成固定基础档和五个优惠档，供个人与企业充值共用。 */
export function buildRelayRechargePresetOptions(
  pricing: RelayRechargePricingPublicView,
): RelayRechargePresetOption[] {
  return [pricing.basePresetAmountFen, ...pricing.tiers.map((tier) => tier.thresholdAmountFen)].map((amountFen) => ({
    amountFen,
    ...calculateRelayRechargePricingQuote(amountFen, pricing.tiers, pricing.discountEnabled),
  }));
}

/** 将充值面额归入当前常用档或 custom，避免埋点记录具体金额。 */
export function resolveRelayRechargeAmountBucket(
  amountFen: number | null | undefined,
  presets: readonly RelayRechargePresetOption[],
): string {
  const normalized = Number(amountFen);
  if (!Number.isSafeInteger(normalized)) return "custom";
  return presets.some((preset) => preset.amountFen === normalized)
    ? String(normalized / 100)
    : "custom";
}
