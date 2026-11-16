import type { AccountLoginRequestBody, AccountLoginResponseBody, AccountOrderInfoPackagesResponseBody, AccountOrderInfoPaymentOrdersQuery, AccountOrderInfoPaymentOrdersResponseBody, AccountWebSocketBridgeResponseBody, AdminSessionInfo, AdminStatsKeyDetailsResponseBody, AdminStatsUsageDetailsResponseBody, AuditLogFilters, AuditLogsResponseBody, AccountMeSummaryResponseBody, AccountRegisterRequestBody, AccountRegisterResponseBody, CheckEnterpriseNameRequestBody, CheckEnterpriseNameResponseBody, AddEnterpriseMemberRequestBody, AddEnterpriseMemberResponseBody, ApiResult, CaptchaChallengeResponseBody, NumericCaptchaChallengeResponseBody, ChangePasswordRequestBody, ChangePasswordResponseBody, CancelMyAccountRequestBody, CancelMyAccountResponseBody, CreateMyEnterpriseRequestBody, CreateEnterpriseResponseBody, CreateInvoiceApplicationRequestBody, CreateInvoiceApplicationResponseBody, EnterpriseCandidatesResponseBody, EnterpriseMembersResponseBody, EnterpriseResetPasswordRequestBody, EnterpriseResetPasswordResponseBody, EnterpriseSummaryResponseBody, ForgotPasswordRequestBody, ForgotPasswordResponseBody, GetInvoiceProfileResponseBody, PreviewRemoveEnterpriseMemberResponseBody, MyRedemptionRecordsResponseBody, MyInvitationInviteesResponseBody, MyInvitationListQuery, RemoveEnterpriseMemberResponseBody, RespondEnterpriseInvitationRequestBody, RespondEnterpriseInvitationResponseBody, RedeemCodeRequestBody, RedeemCodeResponseBody, RotateDefaultKeyResponseBody, SendDefaultKeyResponseBody, RelayEnsureKeyRequestBody, RelayEnsureKeyResponseBody, RelayEnterpriseBalanceOperationView, RelayEnterpriseBalancePoolResponseBody, RelayEnterpriseMemberAllocationListResponseBody, RelayEnterpriseQuotaAdjustmentRecordListQuery, RelayEnterpriseQuotaAdjustmentRecordListResponseBody, RelayAllocateMemberQuotaRequestBody, RelayAllocateMemberQuotaResponseBody, RelaySelfKeyStatusResponseBody, RelaySelfQuotaLedgerResponseBody, RelaySelfUsageLogStatsResponseBody, RelaySelfUsageLogsQuery, RelaySelfUsageLogsResponseBody, RelaySelfUsageSummaryQuery, RelaySelfUsageSummaryResponseBody, RelaySelfUsageQuery, RelaySelfUsageResponseBody, RelaySelfUsageSnapshotResponseBody, RelaySelfBalancesResponseBody, RelayUsageSyncResponseBody, SendVerificationCodeRequestBody, SendVerificationCodeResponseBody, VerificationEmailCheckRequestBody, VerificationEmailCheckResponseBody, UpdateEnterpriseMemberStatusRequestBody, UpdateEnterpriseMemberStatusResponseBody, UpdateEnterpriseProfileRequestBody, UpdateEnterpriseProfileResponseBody, UpdateInvoiceProfileRequestBody, UpdateInvoiceProfileResponseBody, UpdateMyProfileRequestBody, UpdateMyProfileResponseBody, UsageOverview } from "@codeflowai/shared";

import { requestBlob, requestJson, type ApiRequestContext, wsOriginToHttpOrigin } from "../request";

/** 普通用户只提交企业名，Owner 使用当前账号且不创建支付订单。 */
export function createMyEnterprise(ctx: ApiRequestContext, body: CreateMyEnterpriseRequestBody): Promise<ApiResult<CreateEnterpriseResponseBody>> {
  return requestJson(ctx, { method: "POST", path: "/api/account/me/enterprise", body });
}

async function requestAccountAuth<T extends object>(
  serverWsOrigin: string,
  path: string,
  body: unknown,
): Promise<ApiResult<T>> {
  const url = `${wsOriginToHttpOrigin(serverWsOrigin)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (error) {
    return {
      ok: false,
      code: "CLIENT_ERROR",
      message: error instanceof Error ? error.message : "请求发送失败",
      details: error instanceof Error ? error.stack : error,
    };
  }

  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResult<T>;
  } catch {
    return {
      ok: false,
      code: "NON_JSON",
      message: `响应不是 JSON（status=${res.status}）`,
      details: text,
    };
  }
}

async function requestAccountAuthGet<T extends object>(serverWsOrigin: string, path: string): Promise<ApiResult<T>> {
  const url = `${wsOriginToHttpOrigin(serverWsOrigin)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (error) {
    return {
      ok: false,
      code: "CLIENT_ERROR",
      message: error instanceof Error ? error.message : "请求发送失败",
      details: error instanceof Error ? error.stack : error,
    };
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResult<T>;
  } catch {
    return {
      ok: false,
      code: "NON_JSON",
      message: `响应不是 JSON（status=${res.status}）`,
      details: text,
    };
  }
}

function withQuery(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value == null || value === "") return;
    params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

export function getCaptchaChallenge(
  serverWsOrigin: string,
  theme?: "light" | "dark",
): Promise<ApiResult<CaptchaChallengeResponseBody>> {
  return requestAccountAuthGet<CaptchaChallengeResponseBody>(
    serverWsOrigin,
    withQuery("/api/account/auth/captcha", { theme }),
  );
}

export function getNumericCaptchaChallenge(
  serverWsOrigin: string,
  theme?: "light" | "dark",
): Promise<ApiResult<NumericCaptchaChallengeResponseBody>> {
  return requestAccountAuthGet<NumericCaptchaChallengeResponseBody>(
    serverWsOrigin,
    withQuery("/api/account/auth/captcha/numeric", { theme }),
  );
}

export function sendVerificationCode(
  serverWsOrigin: string,
  body: SendVerificationCodeRequestBody,
): Promise<ApiResult<SendVerificationCodeResponseBody>> {
  return requestAccountAuth<SendVerificationCodeResponseBody>(serverWsOrigin, "/api/account/auth/verification-code", body);
}

export function checkVerificationEmail(
  serverWsOrigin: string,
  body: VerificationEmailCheckRequestBody,
): Promise<ApiResult<VerificationEmailCheckResponseBody>> {
  return requestAccountAuth<VerificationEmailCheckResponseBody>(
    serverWsOrigin,
    "/api/account/auth/verification-email/check",
    body,
  );
}

/** 注册前校验企业名称是否可用。 */
export function checkEnterpriseName(
  serverWsOrigin: string,
  body: CheckEnterpriseNameRequestBody,
): Promise<ApiResult<CheckEnterpriseNameResponseBody>> {
  return requestAccountAuth<CheckEnterpriseNameResponseBody>(
    serverWsOrigin,
    "/api/account/auth/enterprise-name/check",
    body,
  );
}

export function registerAccount(
  serverWsOrigin: string,
  body: AccountRegisterRequestBody,
): Promise<ApiResult<AccountRegisterResponseBody>> {
  return requestAccountAuth<AccountRegisterResponseBody>(serverWsOrigin, "/api/account/auth/register", body);
}

export function loginAccount(
  serverWsOrigin: string,
  body: AccountLoginRequestBody,
): Promise<ApiResult<AccountLoginResponseBody>> {
  return requestAccountAuth<AccountLoginResponseBody>(serverWsOrigin, "/api/account/auth/login", body);
}

export function forgotPassword(
  serverWsOrigin: string,
  body: ForgotPasswordRequestBody,
): Promise<ApiResult<ForgotPasswordResponseBody>> {
  return requestAccountAuth<ForgotPasswordResponseBody>(serverWsOrigin, "/api/account/auth/password/forgot", body);
}

export function getMeSummary(ctx: ApiRequestContext): Promise<ApiResult<AccountMeSummaryResponseBody>> {
  return requestJson<AccountMeSummaryResponseBody>(ctx, {
    method: "GET",
    path: "/api/account/me/summary",
  });
}

/** 分页读取当前账号自己的受邀注册记录。 */
export function listMyInvitations(
  ctx: ApiRequestContext,
  query: MyInvitationListQuery,
): Promise<ApiResult<MyInvitationInviteesResponseBody>> {
  return requestJson<MyInvitationInviteesResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/me/invitations", query),
  });
}

export function updateMyProfile(
  ctx: ApiRequestContext,
  body: UpdateMyProfileRequestBody,
): Promise<ApiResult<UpdateMyProfileResponseBody>> {
  return requestJson<UpdateMyProfileResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/me/profile/update",
    body,
  });
}

export function changeMyPassword(
  ctx: ApiRequestContext,
  body: ChangePasswordRequestBody,
): Promise<ApiResult<ChangePasswordResponseBody>> {
  return requestJson<ChangePasswordResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/me/password/change",
    body,
  });
}

export function logoutMySession(ctx: ApiRequestContext): Promise<ApiResult<{ loggedOutAt: number }>> {
  return requestJson<{ loggedOutAt: number }>(ctx, {
    method: "POST",
    path: "/api/account/me/logout",
  });
}

/** Cancels current account; server revokes active sessions after success. */
export function cancelMyAccount(
  ctx: ApiRequestContext,
  body: CancelMyAccountRequestBody,
): Promise<ApiResult<CancelMyAccountResponseBody>> {
  return requestJson<CancelMyAccountResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/me/cancel",
    body,
  });
}

export function sendMyDefaultKey(ctx: ApiRequestContext): Promise<ApiResult<SendDefaultKeyResponseBody>> {
  return requestJson<SendDefaultKeyResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/me/default-key/send",
  });
}

export function issueMyWebSocketBridge(ctx: ApiRequestContext): Promise<ApiResult<AccountWebSocketBridgeResponseBody>> {
  return requestJson<AccountWebSocketBridgeResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/me/ws-bridge",
  });
}

export function rotateMyDefaultKey(ctx: ApiRequestContext): Promise<ApiResult<RotateDefaultKeyResponseBody>> {
  return requestJson<RotateDefaultKeyResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/me/default-key/rotate",
  });
}

/** 查询当前账号的内置中转 key 映射状态，不触发创建。 */
export function getMyRelayKeyStatus(ctx: ApiRequestContext): Promise<ApiResult<RelaySelfKeyStatusResponseBody>> {
  return requestJson<RelaySelfKeyStatusResponseBody>(ctx, {
    method: "GET",
    path: "/api/account/me/relay/key",
  });
}

/** 确保当前账号指定 provider 的内置中转 key 已同步到上游。 */
export function ensureMyRelayKey(ctx: ApiRequestContext, body?: RelayEnsureKeyRequestBody): Promise<ApiResult<RelayEnsureKeyResponseBody>> {
  return requestJson<RelayEnsureKeyResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/me/relay/key/ensure",
    body,
  });
}

/** 查询当前账号自己的中转余额；调用方可在作用域变化时取消请求。 */
export function getMyRelayUsage(
  ctx: ApiRequestContext,
  query?: RelaySelfUsageQuery,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<RelaySelfUsageResponseBody>> {
  return requestJson<RelaySelfUsageResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/me/relay/usage", query as Record<string, string | number | boolean | undefined | null>),
    signal: opts.signal,
  });
}

/** 查询当前账号本地精确个人余额与本人企业额度；调用方可取消过期读取。 */
export function getMyRelayBalances(
  ctx: ApiRequestContext,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<RelaySelfBalancesResponseBody>> {
  return requestJson<RelaySelfBalancesResponseBody>(ctx, {
    method: "GET",
    path: "/api/account/me/relay/balances",
    signal: opts.signal,
  });
}

/** 发送模型请求前追平当前账号的终态消费，并返回最新本地精确余额。 */
export function preflightMyRelayBalance(
  ctx: ApiRequestContext,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<RelaySelfBalancesResponseBody>> {
  return requestJson<RelaySelfBalancesResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/me/relay/usage-accounting/preflight",
    signal: opts.signal,
  });
}

/** 查询当前企业精确 Token 池当前态；调用方可取消过期读取。 */
export function getEnterpriseRelayBalancePool(
  ctx: ApiRequestContext,
  opts: { signal?: AbortSignal; enterpriseId?: string | null } = {},
): Promise<ApiResult<RelayEnterpriseBalancePoolResponseBody>> {
  return requestJson<RelayEnterpriseBalancePoolResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/relay/balance-pool", {
      enterpriseId: opts.enterpriseId || undefined,
    }),
    signal: opts.signal,
  });
}

/** 分页查询当前企业成员 Token allocation。 */
export function listEnterpriseRelayMemberAllocations(
  ctx: ApiRequestContext,
  query?: { search?: string; offset?: number; limit?: number; enterpriseId?: string | null },
): Promise<ApiResult<RelayEnterpriseMemberAllocationListResponseBody>> {
  return requestJson<RelayEnterpriseMemberAllocationListResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/relay/allocations", query),
  });
}

/** 分页查询企业成员额度分配、回收及其处理状态记录。 */
export function listEnterpriseRelayQuotaAdjustmentRecords(
  ctx: ApiRequestContext,
  query: RelayEnterpriseQuotaAdjustmentRecordListQuery,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<RelayEnterpriseQuotaAdjustmentRecordListResponseBody>> {
  return requestJson<RelayEnterpriseQuotaAdjustmentRecordListResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/relay/allocation-records", query as Record<string, string | number | undefined | null>),
    signal: opts.signal,
  });
}

/** 使用精确 units、页面版本和幂等键调整成员企业额度。 */
export function adjustEnterpriseRelayMemberAllocation(
  ctx: ApiRequestContext,
  userId: string,
  body: RelayAllocateMemberQuotaRequestBody,
  enterpriseId?: string | null,
): Promise<ApiResult<RelayAllocateMemberQuotaResponseBody>> {
  return requestJson<RelayAllocateMemberQuotaResponseBody>(ctx, {
    method: "POST",
    path: withQuery(`/api/account/enterprise/relay/allocations/${encodeURIComponent(userId)}/adjust`, {
      enterpriseId: enterpriseId || undefined,
    }),
    body,
  });
}

/** 查询当前企业单个额度 operation 的公开状态。 */
export function getEnterpriseRelayBalanceOperation(
  ctx: ApiRequestContext,
  operationId: string,
  enterpriseId?: string | null,
): Promise<ApiResult<RelayEnterpriseBalanceOperationView>> {
  return requestJson<RelayEnterpriseBalanceOperationView>(ctx, {
    method: "GET",
    path: withQuery(`/api/account/enterprise/relay/operations/${encodeURIComponent(operationId)}`, {
      enterpriseId: enterpriseId || undefined,
    }),
  });
}

/** 查询当前账号自己的真实中转请求日志。 */
export function listMyRelayUsageLogs(
  ctx: ApiRequestContext,
  query?: RelaySelfUsageLogsQuery,
): Promise<ApiResult<RelaySelfUsageLogsResponseBody>> {
  return requestJson<RelaySelfUsageLogsResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/me/relay/usage-logs", query as Record<string, string | number | boolean | undefined | null>),
  });
}

/** 查询当前账号自己的真实中转请求统计。 */
export function getMyRelayUsageLogStats(
  ctx: ApiRequestContext,
  query?: RelaySelfUsageLogsQuery,
): Promise<ApiResult<RelaySelfUsageLogStatsResponseBody>> {
  return requestJson<RelaySelfUsageLogStatsResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/me/relay/usage-log-stats", query as Record<string, string | number | boolean | undefined | null>),
  });
}

/** 拉取当前账号自己的对账快照；调用方可取消已失效作用域的同步。 */
export function syncMyRelayUsageSnapshots(
  ctx: ApiRequestContext,
  query?: Pick<RelaySelfUsageQuery, "includeCosts">,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<RelayUsageSyncResponseBody>> {
  return requestJson<RelayUsageSyncResponseBody>(ctx, {
    method: "POST",
    path: withQuery("/api/account/me/relay/usage/sync", query as Record<string, string | number | boolean | undefined | null>),
    signal: opts.signal,
  });
}

/** 查询当前账号自己的按日、模型和 API Key 流量汇总。 */
export function getMyRelayUsageSummary(
  ctx: ApiRequestContext,
  query: RelaySelfUsageSummaryQuery,
): Promise<ApiResult<RelaySelfUsageSummaryResponseBody>> {
  return requestJson<RelaySelfUsageSummaryResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/me/relay/usage-summary", query as unknown as Record<string, string | number | undefined | null>),
  });
}

/** 查询当前账号自己的中转余额变动账本。 */
export function listMyRelayQuotaLedger(
  ctx: ApiRequestContext,
  query?: { offset?: number; limit?: number },
): Promise<ApiResult<RelaySelfQuotaLedgerResponseBody>> {
  return requestJson<RelaySelfQuotaLedgerResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/me/relay/quota-ledger", query),
  });
}

/** 查询当前账号自己的对账快照记录。 */
export function listMyRelayUsageSnapshots(
  ctx: ApiRequestContext,
  query?: { offset?: number; limit?: number },
): Promise<ApiResult<RelaySelfUsageSnapshotResponseBody>> {
  return requestJson<RelaySelfUsageSnapshotResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/me/relay/usage-snapshots", query),
  });
}

export function getEnterpriseSummary(
  ctx: ApiRequestContext,
  query?: { enterpriseId?: string | null },
): Promise<ApiResult<EnterpriseSummaryResponseBody>> {
  return requestJson<EnterpriseSummaryResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/summary", query),
  });
}

/** 企业会话管理总览：按当前企业作用域返回在线会话、密钥和当日消息统计。 */
export function getEnterpriseSessionOverview(
  ctx: ApiRequestContext,
  query?: { enterpriseId?: string | null },
): Promise<ApiResult<UsageOverview>> {
  return requestJson<UsageOverview>(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/sessions/overview", query),
  });
}

/** 企业会话管理在线列表：仅返回当前企业范围内的会话。 */
export function listEnterpriseSessions(
  ctx: ApiRequestContext,
  query?: { enterpriseId?: string | null },
): Promise<ApiResult<{ sessions: AdminSessionInfo[] }>> {
  return requestJson<{ sessions: AdminSessionInfo[] }>(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/sessions", query),
  });
}

/** 企业会话管理密钥明细：复用平台会话管理的明细结构，方便前端按同一表格渲染。 */
export function listEnterpriseSessionKeys(
  ctx: ApiRequestContext,
  query?: { enterpriseId?: string | null; activeOnly?: boolean; offset?: number; limit?: number },
): Promise<ApiResult<AdminStatsKeyDetailsResponseBody>> {
  return requestJson<AdminStatsKeyDetailsResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/sessions/keys", query as Record<string, string | number | boolean | null | undefined>),
  });
}

/** 企业会话管理消息明细：按企业成员 keyHash 过滤 usage log，并保留服务端分页。 */
export function listEnterpriseSessionUsageLogs(
  ctx: ApiRequestContext,
  query?: { enterpriseId?: string | null; action?: string; createdFrom?: number; createdTo?: number; offset?: number; limit?: number },
): Promise<ApiResult<AdminStatsUsageDetailsResponseBody>> {
  return requestJson<AdminStatsUsageDetailsResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/sessions/usage-logs", query),
  });
}

/** 企业管理员踢出企业内部会话：后端会按企业作用域再次校验目标会话归属。 */
export function kickEnterpriseSession(
  ctx: ApiRequestContext,
  id: string,
): Promise<ApiResult<{ kicked: boolean }>> {
  return requestJson<{ kicked: boolean }>(ctx, {
    method: "POST",
    path: `/api/account/enterprise/sessions/${encodeURIComponent(id)}/kick`,
  });
}

/** 分页读取当前企业审计记录，并支持调用方在作用域切换时取消请求。 */
export function listEnterpriseAuditLogs(
  ctx: ApiRequestContext,
  query?: AuditLogFilters,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<AuditLogsResponseBody>> {
  return requestJson<AuditLogsResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/audit-logs", query),
    signal: opts.signal,
  });
}

export function exportEnterpriseAuditLogs(
  ctx: ApiRequestContext,
  query?: AuditLogFilters,
) {
  return requestBlob(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/audit-logs/export", query),
  });
}

export function updateEnterpriseProfile(
  ctx: ApiRequestContext,
  body: UpdateEnterpriseProfileRequestBody,
): Promise<ApiResult<UpdateEnterpriseProfileResponseBody>> {
  return requestJson<UpdateEnterpriseProfileResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/enterprise/profile/update",
    body,
  });
}

export function listEnterpriseMembers(
  ctx: ApiRequestContext,
  query?: Record<string, string | number | undefined | null>,
): Promise<ApiResult<EnterpriseMembersResponseBody>> {
  return requestJson<EnterpriseMembersResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/members", query),
  });
}

export function searchEnterpriseCandidates(
  ctx: ApiRequestContext,
  keyword: string,
  enterpriseId?: string | null,
): Promise<ApiResult<EnterpriseCandidatesResponseBody>> {
  return requestJson<EnterpriseCandidatesResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/enterprise/candidates", { keyword, enterpriseId }),
  });
}

export function addEnterpriseMember(
  ctx: ApiRequestContext,
  body: AddEnterpriseMemberRequestBody,
): Promise<ApiResult<AddEnterpriseMemberResponseBody>> {
  return requestJson<AddEnterpriseMemberResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/enterprise/members",
    body,
  });
}

export function respondEnterpriseInvitation(
  ctx: ApiRequestContext,
  invitationId: string,
  body: RespondEnterpriseInvitationRequestBody,
): Promise<ApiResult<RespondEnterpriseInvitationResponseBody>> {
  return requestJson<RespondEnterpriseInvitationResponseBody>(ctx, {
    method: "POST",
    path: `/api/account/me/enterprise-invitations/${invitationId}/respond`,
    body,
  });
}

export function resetEnterpriseMemberPassword(
  ctx: ApiRequestContext,
  membershipId: string,
  body: EnterpriseResetPasswordRequestBody,
): Promise<ApiResult<EnterpriseResetPasswordResponseBody>> {
  return requestJson<EnterpriseResetPasswordResponseBody>(ctx, {
    method: "POST",
    path: `/api/account/enterprise/members/${membershipId}/password/reset`,
    body,
  });
}

export function updateEnterpriseMemberStatus(
  ctx: ApiRequestContext,
  membershipId: string,
  body: UpdateEnterpriseMemberStatusRequestBody,
): Promise<ApiResult<UpdateEnterpriseMemberStatusResponseBody>> {
  return requestJson<UpdateEnterpriseMemberStatusResponseBody>(ctx, {
    method: "POST",
    path: `/api/account/enterprise/members/${membershipId}/status/update`,
    body,
  });
}

export function removeEnterpriseMember(
  ctx: ApiRequestContext,
  membershipId: string,
  enterpriseId?: string | null,
): Promise<ApiResult<RemoveEnterpriseMemberResponseBody>> {
  return requestJson<RemoveEnterpriseMemberResponseBody>(ctx, {
    method: "POST",
    path: `/api/account/enterprise/members/${membershipId}/remove`,
    body: { enterpriseId: enterpriseId ?? undefined },
  });
}

export function previewRemoveEnterpriseMember(
  ctx: ApiRequestContext,
  membershipId: string,
  enterpriseId?: string | null,
): Promise<ApiResult<PreviewRemoveEnterpriseMemberResponseBody>> {
  return requestJson<PreviewRemoveEnterpriseMemberResponseBody>(ctx, {
    method: "GET",
    path: withQuery(`/api/account/enterprise/members/${membershipId}/remove/preview`, { enterpriseId }),
  });
}

/** Redeem a code for the current account. */
export function redeemCode(
  ctx: ApiRequestContext,
  body: RedeemCodeRequestBody,
): Promise<ApiResult<RedeemCodeResponseBody>> {
  return requestJson<RedeemCodeResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/redemption-codes/redeem",
    body,
  });
}

/** List redemption records for the current account. */
export function listMyRedemptionRecords(
  ctx: ApiRequestContext,
  query?: { offset?: number; limit?: number },
): Promise<ApiResult<MyRedemptionRecordsResponseBody>> {
  return requestJson<MyRedemptionRecordsResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/redemption-records", query),
  });
}

export function listAccountOrderInfoPackages(
  ctx: ApiRequestContext,
): Promise<ApiResult<AccountOrderInfoPackagesResponseBody>> {
  return requestJson<AccountOrderInfoPackagesResponseBody>(ctx, {
    method: "GET",
    path: "/api/account/order-info/packages",
  });
}

export function listAccountOrderInfoPaymentOrders(
  ctx: ApiRequestContext,
  query?: AccountOrderInfoPaymentOrdersQuery,
): Promise<ApiResult<AccountOrderInfoPaymentOrdersResponseBody>> {
  return requestJson<AccountOrderInfoPaymentOrdersResponseBody>(ctx, {
    method: "GET",
    path: withQuery("/api/account/order-info/payment-orders", query),
  });
}

/** 读取当前账号发票资料，默认接收邮箱由后端返回。 */
export function getInvoiceProfile(ctx: ApiRequestContext): Promise<ApiResult<GetInvoiceProfileResponseBody>> {
  return requestJson<GetInvoiceProfileResponseBody>(ctx, {
    method: "GET",
    path: "/api/account/invoice-profile",
  });
}

/** 保存当前账号发票资料，非法字段由后端校验。 */
export function updateInvoiceProfile(
  ctx: ApiRequestContext,
  body: UpdateInvoiceProfileRequestBody,
): Promise<ApiResult<UpdateInvoiceProfileResponseBody>> {
  return requestJson<UpdateInvoiceProfileResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/invoice-profile",
    body,
  });
}

/** 为指定业务订单提交发票申请。 */
export function createInvoiceApplication(
  ctx: ApiRequestContext,
  businessOrderId: string,
  body: CreateInvoiceApplicationRequestBody,
): Promise<ApiResult<CreateInvoiceApplicationResponseBody>> {
  return requestJson<CreateInvoiceApplicationResponseBody>(ctx, {
    method: "POST",
    path: `/api/account/order-info/payment-orders/${encodeURIComponent(businessOrderId)}/invoice-applications`,
    body,
  });
}


