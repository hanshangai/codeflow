import type { RelaySelfBalancesResponseBody } from "@codeflowai/shared";

import { parseRelayUsdUnits } from "../account/relayUsdUnits";

/** 余额门禁只阻断负数；零余额仍允许发起回合并由服务端记账。 */
export const RELAY_SEND_NEGATIVE_BALANCE_THRESHOLD_USD_UNITS = 0n;

type CompatibleRelaySelfBalances = Omit<RelaySelfBalancesResponseBody, "effective"> & {
  effective?: RelaySelfBalancesResponseBody["effective"];
};

export type RelayBalanceReminderState = {
  enterpriseAvailableUsdUnits: bigint;
  personalAvailableUsdUnits: bigint;
  totalAvailableUsdUnits: bigint;
  primaryScope: "enterprise" | "personal" | "none";
  lowBalance: boolean;
  enterpriseLowBalance: boolean;
  usesPersonalFallback: boolean;
};

export type RelayBalanceSendGuardDecision = {
  allowed: boolean;
  code: "ALLOWED" | "BALANCE_UNAVAILABLE" | "ACCOUNT_UNAVAILABLE" | "LOW_BALANCE";
  state: RelayBalanceReminderState | null;
};

/** 按服务端权威摘要计算提醒状态；旧响应仅在发布切换窗口按明细兼容推导。 */
export function resolveRelayBalanceReminderState(
  balances: CompatibleRelaySelfBalances | null,
  lowBalanceThresholdUsdUnits: bigint,
): RelayBalanceReminderState | null {
  if (!balances) return null;
  if (lowBalanceThresholdUsdUnits < 0n) throw new Error("Token 余额提醒阈值不能为负数");

  // 存量用户尚未建立本地余额当前态时，仅允许明确的空摘要回到同一轮 usage 余额。
  if (!balances.personal && !balances.enterprise) {
    if (balances.effective) {
      const enterpriseAvailable = parseRelayUsdUnits(balances.effective.enterpriseAvailableUsdUnits);
      const personalAvailable = parseRelayUsdUnits(balances.effective.personalAvailableUsdUnits);
      const totalAvailable = parseRelayUsdUnits(balances.effective.totalAvailableUsdUnits);
      if (enterpriseAvailable !== 0n || personalAvailable !== 0n || totalAvailable !== 0n || balances.effective.primaryScope !== "none") {
        throw new Error("Token 余额摘要缺少资金作用域明细");
      }
    }
    return null;
  }

  const legacyEnterpriseAvailable = balances.enterprise
    ? parseRelayUsdUnits(balances.enterprise.remainingUsdUnits)
    : 0n;
  const legacyPersonalAvailable = balances.personal
    ? parseRelayUsdUnits(balances.personal.availableUsdUnits)
    : 0n;
  const effective = balances.effective;
  const enterpriseAvailableUsdUnits = effective
    ? parseRelayUsdUnits(effective.enterpriseAvailableUsdUnits)
    : legacyEnterpriseAvailable;
  const personalAvailableUsdUnits = effective
    ? parseRelayUsdUnits(effective.personalAvailableUsdUnits)
    : legacyPersonalAvailable;
  const totalAvailableUsdUnits = effective
    ? parseRelayUsdUnits(effective.totalAvailableUsdUnits)
    : enterpriseAvailableUsdUnits + personalAvailableUsdUnits;

  if (totalAvailableUsdUnits !== enterpriseAvailableUsdUnits + personalAvailableUsdUnits) {
    throw new Error("Token 余额摘要合计不一致");
  }
  const primaryScope = enterpriseAvailableUsdUnits > 0n
    ? "enterprise"
    : personalAvailableUsdUnits > 0n ? "personal" : "none";
  if (effective && effective.primaryScope !== primaryScope) {
    throw new Error("Token 余额摘要扣减范围不一致");
  }

  const lowBalance = totalAvailableUsdUnits < lowBalanceThresholdUsdUnits;
  const enterpriseLowBalance = Boolean(balances.enterprise)
    && enterpriseAvailableUsdUnits < lowBalanceThresholdUsdUnits;
  return {
    enterpriseAvailableUsdUnits,
    personalAvailableUsdUnits,
    totalAvailableUsdUnits,
    primaryScope,
    lowBalance,
    enterpriseLowBalance,
    usesPersonalFallback: enterpriseLowBalance && !lowBalance && personalAvailableUsdUnits > 0n,
  };
}

/** 发送前追平消费后使用已确认剩余额度；同步中的预留金额不计入可用余额。 */
export function resolveRelayBalanceSendGuard(
  balances: CompatibleRelaySelfBalances | null,
  safetyThresholdUsdUnits: bigint = RELAY_SEND_NEGATIVE_BALANCE_THRESHOLD_USD_UNITS,
): RelayBalanceSendGuardDecision {
  const state = resolveRelayBalanceReminderState(balances, safetyThresholdUsdUnits);
  if (!balances || !state) return { allowed: false, code: "BALANCE_UNAVAILABLE", state };
  if (state.totalAvailableUsdUnits < safetyThresholdUsdUnits) {
    return { allowed: false, code: "LOW_BALANCE", state };
  }
  if (!balances.personal || balances.personal.status !== "ACTIVE") {
    return { allowed: false, code: "ACCOUNT_UNAVAILABLE", state };
  }
  if (state.enterpriseAvailableUsdUnits > 0n
    && (!balances.enterprise
      || balances.enterprise.status !== "active"
      || !["succeeded", "syncing"].includes(balances.enterprise.syncStatus))) {
    return { allowed: false, code: "ACCOUNT_UNAVAILABLE", state };
  }
  return { allowed: true, code: "ALLOWED", state };
}
