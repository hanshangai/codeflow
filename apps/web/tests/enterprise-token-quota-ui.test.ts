import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_RELAY_USD_TO_CNY_RATE, type RelaySelfBalancesResponseBody } from "@codeflowai/shared";

import {
  formatRelayUsdUnitsAsUsd,
  formatRelayUsdUnitsAsYuan,
  parseRelayUsdUnits,
  relayUsdTextToUnits,
  relayYuanTextToUsdUnits,
} from "../src/features/account/relayUsdUnits.ts";
import {
  RELAY_SEND_NEGATIVE_BALANCE_THRESHOLD_USD_UNITS,
  resolveRelayBalanceReminderState,
  resolveRelayBalanceSendGuard,
} from "../src/features/composer/relayBalanceReminderState.ts";

/** 构造输入框余额提醒所需的精确个人、企业和权威汇总响应。 */
function createRelaySelfBalances(input: {
  enterpriseAvailableUsdUnits?: bigint;
  personalAvailableUsdUnits: bigint;
  includeEnterprise?: boolean;
}): RelaySelfBalancesResponseBody {
  const enterpriseAvailableUsdUnits = input.enterpriseAvailableUsdUnits ?? 0n;
  const includeEnterprise = input.includeEnterprise ?? true;
  const totalAvailableUsdUnits = (includeEnterprise ? enterpriseAvailableUsdUnits : 0n) + input.personalAvailableUsdUnits;
  return {
    personal: {
      availableUsdUnits: input.personalAvailableUsdUnits.toString(),
      frozenUsdUnits: "0",
      consumedUsdUnits: "0",
      status: "ACTIVE",
      version: "1",
      updatedAt: 1,
    },
    enterprise: includeEnterprise ? {
      enterpriseId: "ent_1",
      enterpriseName: "Test Enterprise",
      membershipId: "membership_1",
      grantedUsdUnits: enterpriseAvailableUsdUnits.toString(),
      consumedUsdUnits: "0",
      remainingUsdUnits: enterpriseAvailableUsdUnits.toString(),
      frozenUsdUnits: "0",
      status: "active",
      syncStatus: "succeeded",
      version: "1",
      updatedAt: 1,
    } : null,
    effective: {
      enterpriseAvailableUsdUnits: (includeEnterprise ? enterpriseAvailableUsdUnits : 0n).toString(),
      personalAvailableUsdUnits: input.personalAvailableUsdUnits.toString(),
      totalAvailableUsdUnits: totalAvailableUsdUnits.toString(),
      primaryScope: includeEnterprise && enterpriseAvailableUsdUnits > 0n
        ? "enterprise"
        : input.personalAvailableUsdUnits > 0n ? "personal" : "none",
    },
  };
}

test("enterprise token quota converts decimal USD to exact integer units", () => {
  assert.equal(relayUsdTextToUnits("1").toString(), "100000000");
  assert.equal(relayUsdTextToUnits("10.50").toString(), "1050000000");
  assert.equal(relayUsdTextToUnits("0.00000001").toString(), "1");
  assert.equal(parseRelayUsdUnits("9223372036854775807"), 9_223_372_036_854_775_807n);
  assert.throws(() => relayUsdTextToUnits("0"), /必须大于 0/u);
  assert.throws(() => relayUsdTextToUnits("1.000000001"), /最多八位小数/u);
  assert.throws(() => parseRelayUsdUnits("1.2"), /格式不正确/u);
});

test("enterprise token quota formats exact USD and CNY without float amount arithmetic", () => {
  assert.equal(formatRelayUsdUnitsAsUsd("100000000"), "US$1.00");
  assert.equal(formatRelayUsdUnitsAsUsd("1050000000"), "US$10.5");
  assert.equal(formatRelayUsdUnitsAsYuan("100000000"), `￥${DEFAULT_RELAY_USD_TO_CNY_RATE.toFixed(2)}`);
  assert.equal(formatRelayUsdUnitsAsYuan("1050000000"), `￥${(10.5 * DEFAULT_RELAY_USD_TO_CNY_RATE).toFixed(2)}`);
  assert.equal(formatRelayUsdUnitsAsYuan("-100000000"), `-￥${DEFAULT_RELAY_USD_TO_CNY_RATE.toFixed(2)}`);
});

test("enterprise token quota converts CNY input to exact internal units", () => {
  assert.equal(relayYuanTextToUsdUnits("1").toString(), "100000000");
  assert.equal(relayYuanTextToUsdUnits("10.50").toString(), "1050000000");
  assert.equal(relayYuanTextToUsdUnits("0.01").toString(), "1000000");
  assert.throws(() => relayYuanTextToUsdUnits("0"), /必须大于 0/u);
  assert.throws(() => relayYuanTextToUsdUnits("1.001"), /最多两位小数/u);
});

test("relay balance reminder puts enterprise quota before personal balance", () => {
  const source = readFileSync(new URL("../src/features/composer/components/relay-balance-reminder.vue", import.meta.url), "utf8");
  const enterpriseIndex = source.indexOf('class="relay-balance-reminder__enterprise-balance"');
  const personalIndex = source.indexOf('class="relay-balance-reminder__personal-balance"');

  assert.ok(enterpriseIndex >= 0 && personalIndex > enterpriseIndex, "企业余额主卡必须位于个人余额之前");
  assert.match(source, /企业Token余额[\s\S]*优先扣除[\s\S]*消费时优先使用企业额度/u);
  assert.match(source, /resolveRelayBalanceReminderState/u);
});

test("relay balance reminder evaluates enterprise and personal spendable balance together", () => {
  const threshold = 5n;
  const enterpriseFunded = resolveRelayBalanceReminderState(createRelaySelfBalances({
    enterpriseAvailableUsdUnits: 99n,
    personalAvailableUsdUnits: 0n,
  }), threshold);
  assert.equal(enterpriseFunded?.lowBalance, false);
  assert.equal(enterpriseFunded?.primaryScope, "enterprise");

  const personalFallback = resolveRelayBalanceReminderState(createRelaySelfBalances({
    enterpriseAvailableUsdUnits: 0n,
    personalAvailableUsdUnits: 100n,
  }), threshold);
  assert.equal(personalFallback?.lowBalance, false);
  assert.equal(personalFallback?.usesPersonalFallback, true);
  assert.equal(personalFallback?.primaryScope, "personal");

  const bothEmpty = resolveRelayBalanceReminderState(createRelaySelfBalances({
    enterpriseAvailableUsdUnits: 0n,
    personalAvailableUsdUnits: 0n,
  }), threshold);
  assert.equal(bothEmpty?.lowBalance, true);

  const personalEmpty = resolveRelayBalanceReminderState(createRelaySelfBalances({
    personalAvailableUsdUnits: 0n,
    includeEnterprise: false,
  }), threshold);
  assert.equal(personalEmpty?.lowBalance, true);
});

test("relay balance reminder keeps missing balance truth unknown instead of reporting insufficient", () => {
  assert.equal(resolveRelayBalanceReminderState(null, 5n), null);
});

test("relay balance send guard blocks unknown and negative balances but allows zero or positive balances", () => {
  assert.deepEqual(resolveRelayBalanceSendGuard(null), {
    allowed: false,
    code: "BALANCE_UNAVAILABLE",
    state: null,
  });

  const lowBalance = createRelaySelfBalances({
    personalAvailableUsdUnits: -1n,
    includeEnterprise: false,
  });
  assert.equal(resolveRelayBalanceSendGuard(lowBalance).code, "LOW_BALANCE");
  lowBalance.personal!.status = "RECONCILING";
  assert.equal(resolveRelayBalanceSendGuard(lowBalance).code, "LOW_BALANCE");

  const reconciling = createRelaySelfBalances({
    personalAvailableUsdUnits: 0n,
    includeEnterprise: false,
  });
  reconciling.personal!.status = "RECONCILING";
  assert.equal(resolveRelayBalanceSendGuard(reconciling).code, "ACCOUNT_UNAVAILABLE");

  const funded = createRelaySelfBalances({
    enterpriseAvailableUsdUnits: RELAY_SEND_NEGATIVE_BALANCE_THRESHOLD_USD_UNITS,
    personalAvailableUsdUnits: 0n,
  });
  assert.equal(resolveRelayBalanceSendGuard(funded).allowed, true);

  const personalFallback = createRelaySelfBalances({
    enterpriseAvailableUsdUnits: 0n,
    personalAvailableUsdUnits: RELAY_SEND_NEGATIVE_BALANCE_THRESHOLD_USD_UNITS,
  });
  personalFallback.enterprise!.status = "inactive";
  assert.equal(resolveRelayBalanceSendGuard(personalFallback).allowed, true);
});

test("relay send guard preserves confirmed enterprise funds while an adjustment is syncing", () => {
  const balances = createRelaySelfBalances({ enterpriseAvailableUsdUnits: 100n, personalAvailableUsdUnits: 50n });
  balances.enterprise!.syncStatus = "syncing";
  assert.equal(resolveRelayBalanceSendGuard(balances).allowed, true);
  balances.enterprise!.syncStatus = "failed";
  assert.equal(resolveRelayBalanceSendGuard(balances).code, "ACCOUNT_UNAVAILABLE");
  balances.enterprise!.syncStatus = "syncing";
  balances.enterprise!.status = "frozen";
  assert.equal(resolveRelayBalanceSendGuard(balances).code, "ACCOUNT_UNAVAILABLE");
  balances.enterprise!.status = "active";
  balances.personal!.status = "RECONCILING";
  assert.equal(resolveRelayBalanceSendGuard(balances).code, "ACCOUNT_UNAVAILABLE");
});

test("chat composer runs the built-in relay balance preflight before sending", () => {
  const composerSource = readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");
  const reminderSource = readFileSync(new URL("../src/features/composer/components/relay-balance-reminder.vue", import.meta.url), "utf8");
  const apiSource = readFileSync(new URL("../src/api/account/index.ts", import.meta.url), "utf8");

  assert.match(composerSource, /ensureCanStartTurn\(\)/u);
  assert.match(reminderSource, /defineExpose\(\{ ensureCanStartTurn \}\)/u);
  assert.match(reminderSource, /联系企业管理员后重试/u);
  assert.match(reminderSource, /系统会重试可恢复操作/u);
  assert.match(apiSource, /\/api\/account\/me\/relay\/usage-accounting\/preflight/u);
});

test("relay balance reminder keeps legacy upstream balance as the fallback when local balance state is absent", () => {
  const emptySummary = {
    personal: null,
    enterprise: null,
    effective: {
      enterpriseAvailableUsdUnits: "0",
      personalAvailableUsdUnits: "0",
      totalAvailableUsdUnits: "0",
      primaryScope: "none",
    },
  } satisfies RelaySelfBalancesResponseBody;
  assert.equal(resolveRelayBalanceReminderState(emptySummary, 5n), null);
  assert.throws(() => resolveRelayBalanceReminderState({
    ...emptySummary,
    effective: {
      ...emptySummary.effective,
      personalAvailableUsdUnits: "100000000",
      totalAvailableUsdUnits: "100000000",
      primaryScope: "personal",
    },
  }, 5n), /缺少资金作用域明细/u);
});

test("enterprise token quota UI keeps the exact adjust and conflict boundaries", () => {
  const apiSource = readFileSync(new URL("../src/api/account/index.ts", import.meta.url), "utf8");
  const checkoutApiSource = readFileSync(new URL("../src/api/relay-token-package/index.ts", import.meta.url), "utf8");
  const tabSource = readFileSync(new URL("../src/features/account/components/enterprise-token-quota-tab.vue", import.meta.url), "utf8");
  const historySource = readFileSync(new URL("../src/features/account/components/enterprise-token-adjustment-history.vue", import.meta.url), "utf8");
  const drawerSource = readFileSync(new URL("../src/features/account/components/enterprise-drawer.vue", import.meta.url), "utf8");
  const managementSource = readFileSync(new URL("../src/features/admin/components/enterprise-management-panel.vue", import.meta.url), "utf8");
  const tokenPanelSource = readFileSync(new URL("../src/features/admin/components/enterprise-token-panel.vue", import.meta.url), "utf8");
  const rechargeSource = readFileSync(new URL("../src/features/admin/components/relay-token-recharge-modal.vue", import.meta.url), "utf8");

  assert.match(apiSource, /enterprise\/relay\/allocations\/\$\{encodeURIComponent\(userId\)\}\/adjust/u);
  assert.match(tabSource, /result\.code === "VERSION_CONFLICT"/u);
  assert.match(tabSource, /operationStatus === ["']RESULT_UNKNOWN["']/u);
  assert.match(tabSource, /scheduleVisibleOperationPoll/u);
  assert.match(tabSource, /record\.operation\.operationId/u);
  assert.match(tabSource, /year: "numeric"[\s\S]*month: "2-digit"[\s\S]*day: "2-digit"[\s\S]*hour: "2-digit"[\s\S]*minute: "2-digit"/u);
  assert.match(tabSource, /membershipStatus === "removing"/u);
  assert.match(tabSource, /record\.membershipStatus === 'removing'[\s\S]*移除处理中/u);
  assert.match(tabSource, /额度调整被拒绝，企业池与成员额度未变更/u);
  assert.match(tabSource, /<a-popover[\s\S]*title="额度使用规则"[\s\S]*trigger="click"/u);
  assert.match(tabSource, /aria-label="查看额度使用规则"/u);
  assert.doesNotMatch(tabSource, /<a-alert type="info" show-icon message="额度使用规则"/u);
  assert.match(tabSource, /“增加”按钮为成员增加token额度[\s\S]*企业“可分配”余额[\s\S]*已消费额度不能回收/u);
  assert.match(tabSource, /回收期间会暂时停用该成员中转 Key[\s\S]*操作成功或明确拒绝后按当前权限恢复/u);
  assert.match(tabSource, /显示“处理中”或“对账中”时请等待原操作结束[\s\S]*联系运维提供操作 ID/u);
  assert.match(tabSource, /禁用或移除成员会触发未消费额度回收[\s\S]*清理未完成时成员保持不可用[\s\S]*重新启用或重新加入后需重新分配/u);
  assert.match(tabSource, /v-if="loadError"/u);
  assert.match(tabSource, /v-if="loading && !pool && !loadError"[\s\S]*<a-spin size="large"[\s\S]*企业Token加载中/u);
  assert.match(tabSource, /pool\.value = null/u);
  assert.match(tabSource, /max-width: 100%/u);
  assert.match(tabSource, /default-target-scope="ENTERPRISE"/u);
  assert.match(tabSource, /item\.label === '累计购买'[\s\S]*label="企业Token充值"/u);
  assert.doesNotMatch(tabSource, /label="企业充值"/u);
  assert.doesNotMatch(tabSource, /版本\s*\{\{\s*pool\.version/u);
  assert.doesNotMatch(tabSource, /formatRelayUsdUnitsAsUsd/u);
  assert.doesNotMatch(tabSource, /调整额度（USD）/u);
  assert.match(tabSource, /relayYuanTextToUsdUnits\(adjustForm\.amountYuan\)/u);
  assert.match(tabSource, /label="调整额度（元）"/u);
  assert.match(tabSource, /<a-form-item label="备注">/u);
  assert.doesNotMatch(tabSource, /备注（必填）|回收额度必须填写备注/u);
  assert.doesNotMatch(drawerSource, /key="token-quota"|Token 分配/u);
  assert.doesNotMatch(managementSource, /show-token-quota-tab|token-quota-enterprise-id/u);
  assert.match(tokenPanelSource, /<EnterpriseTokenQuotaTab[\s\S]*:enterprise-id="managedEnterpriseId"/u);
  assert.match(apiSource, /\/api\/account\/enterprise\/relay\/allocation-records/u);
  assert.match(apiSource, /listEnterpriseRelayQuotaAdjustmentRecords\([\s\S]*signal: opts\.signal/u);
  assert.match(tabSource, /<a-tab-pane key="members" tab="Token分配"/u);
  assert.match(tabSource, /<a-tab-pane key="history" tab="分配记录">/u);
  assert.match(tabSource, /adjustForm\.adjustType === 'RECLAIM'[\s\S]*回收期间将暂时停用成员中转 Key[\s\S]*按成员当前权限恢复可用的中转 Key/u);
  assert.doesNotMatch(tabSource, /historyTotal|total-change/u);
  assert.match(tabSource, /<EnterpriseTokenAdjustmentHistory[\s\S]*v-if="historyVisited"/u);
  assert.match(historySource, /搜索成员姓名或邮箱/u);
  assert.match(historySource, /全部类型[\s\S]*全部状态[\s\S]*最近 30 天/u);
  assert.match(historySource, /requestController\?\.abort\(\)/u);
  assert.match(historySource, /class="enterprise-token-history__table"/u);
  assert.match(historySource, /:loading="\{ spinning: loading, tip: '记录加载中\.\.\.' \}"/u);
  assert.match(historySource, /#emptyText[\s\S]*v-if="loading" class="enterprise-token-history__table-loading-placeholder"[\s\S]*<a-empty v-else description="暂无分配或回收记录"/u);
  assert.match(historySource, /class="enterprise-token-history__mobile-list"/u);
  assert.match(historySource, /v-if="loading" class="enterprise-token-history__mobile-loading"[\s\S]*记录加载中\.\.\.[\s\S]*<template v-else>/u);
  assert.match(historySource, /<a-table-column title="成员"[\s\S]*memberDisplay\(record\)\.primary[\s\S]*<\/a-table-column>/u);
  assert.match(historySource, /<a-table-column title="类型"[\s\S]*record\.adjustType === "INCREASE" \? "增加" : "回收"[\s\S]*<\/a-table-column>/u);
  assert.match(historySource, /<a-table-column title="状态"[\s\S]*statusMeta\(record\.operationStatus\)\.text[\s\S]*<\/a-table-column>/u);
  assert.match(historySource, /const primary = record\.memberEmail \|\| record\.memberFullName \|\| record\.memberUserId \|\| "未知成员"/u);
  assert.doesNotMatch(historySource, /title="操作人 \/ 状态"|enterprise-token-history__source|enterprise-token-history__actor/u);
  assert.doesNotMatch(historySource, /memberDisplay\(record\)\.secondary|actorDisplay\(record\)\.primary|operationSourceLabel\(record\)/u);
  assert.match(historySource, /enterprise-token-history__table :deep\(\.ant-table-tbody > tr > td\)[\s\S]*padding: 6px 10px;[\s\S]*white-space: nowrap;/u);
  assert.doesNotMatch(historySource, /enterprise-token-history__loading/u);
  assert.doesNotMatch(historySource, /ReloadOutlined|刷新分配与回收记录|total-change/u);
  assert.match(historySource, /<a-drawer[\s\S]*title="操作详情"/u);
  assert.match(historySource, /操作 ID[\s\S]*请求 ID/u);
  assert.doesNotMatch(historySource, /upstreamResultJson|metadataJson/u);
  assert.match(rechargeSource, /targetScope: selectedTargetScope\.value/u);
  assert.match(rechargeSource, /<a-segmented/u);
  assert.match(rechargeSource, /企业账户：\$\{config\.userSummary\?\.enterpriseName/u);
  assert.match(rechargeSource, /activeRequestScope\?\.controller\.abort\(createCancelledRequestError\(kind\)\)/u);
  assert.match(rechargeSource, /getRelayBalancePackCheckoutContext\([\s\S]*signal: scope\.controller\.signal/u);
  assert.match(rechargeSource, /const canSubmitOrder = computed\(\(\) => Boolean\([\s\S]*checkoutContext\.value/u);
  assert.match(rechargeSource, /enterprisePool\.value[\s\S]*formatRelayUsdUnitsAsYuan\(enterprisePool\.value\.availableUsdUnits\)[\s\S]*: "-"/u);
  assert.match(rechargeSource, /checkoutContext\.value = null;\s*order\.value = null;\s*checkoutLoadError\.value/u);
  assert.match(rechargeSource, /if \(!syncResult\.ok\) \{\s*clearOverviewTruth\(\);/u);
  assert.match(rechargeSource, /refreshSucceeded && isCurrentRequestScope\(scope\)/u);
  assert.match(rechargeSource, /充值结果确认中/u);
  assert.match(rechargeSource, /支付已确认，正在确认充值结果。/u);
  assert.doesNotMatch(rechargeSource, /return ["']已支付，token同步中["']|return ["']正在同步token["']/u);
  assert.doesNotMatch(rechargeSource, /enterprisePool\.value\?\.availableUsdUnits \?\? "0"/u);
  assert.match(apiSource, /getMyRelayBalances\([\s\S]*signal: opts\.signal/u);
  assert.match(checkoutApiSource, /getRelayBalancePackCheckoutContext\([\s\S]*signal: opts\.signal/u);
  assert.doesNotMatch(tabSource, /allocatedQuota/u);
});

test("relay token recharge modal owns async tasks and serializes order actions", () => {
  const source = readFileSync(new URL("../src/features/admin/components/relay-token-recharge-modal.vue", import.meta.url), "utf8");

  assert.match(source, /if \(checkoutLoadTask\?\.scopeId === scope\.id\) return await checkoutLoadTask\.promise/u);
  assert.match(source, /if \(checkoutLoadTask\?\.promise === promise\) \{[\s\S]*checkoutLoadTask = null;[\s\S]*loading\.value = false/u);
  assert.match(source, /if \(selfOverviewLoadTask\?\.scopeId === scope\.id\) return await selfOverviewLoadTask\.promise/u);
  assert.match(source, /if \(selfOverviewLoadTask\?\.promise === promise\) \{[\s\S]*selfOverviewLoadTask = null;/u);
  assert.match(source, /const canSubmitOrder = computed\(\(\) => Boolean\([\s\S]*!selfLoading\.value[\s\S]*!loadError\.value[\s\S]*!refreshing\.value[\s\S]*!cancelling\.value/u);
  assert.match(source, /if \(loadError\.value\) \{\s*message\.warning\("充值信息加载失败，请先重试"\);\s*return;/u);

  const poolFailureIndex = source.indexOf("overviewLoadError.value = resolveDisplayText(result.message, \"企业 Token 余额加载失败\")");
  const overviewCommitIndex = source.indexOf("selfBalances.value = balancesResult;");
  assert.ok(poolFailureIndex >= 0 && overviewCommitIndex > poolFailureIndex, "overview truth must commit only after enterprise pool succeeds");
  assert.match(source, /if \(ordering\.value \|\| refreshing\.value \|\| cancelling\.value\) \{\s*message\.info\("订单操作正在处理，请稍后操作"\)/u);
  assert.match(source, /if \(ordering\.value \|\| cancelling\.value\) \{\s*if \(manual\) message\.info\("订单操作正在处理，请稍后刷新"\)/u);
  assert.match(source, /if \(ordering\.value \|\| cancelling\.value\) \{\s*message\.info\("订单操作正在处理，请稍后取消"\)/u);

  assert.match(source, /order\.value = result\.order;\s*if \(isPaidSucceeded\(result\.order\)\) \{[\s\S]*await handleSucceeded\(result\.order, scope\);[\s\S]*if \(result\.order\.orderStatus === "CANCELLED"\) \{[\s\S]*message\.success\("订单已取消"\)/u);
  assert.doesNotMatch(source, /order\.value = result\.order;\s*clearPolling\(\);\s*message\.success\("订单已取消"\)/u);
});
