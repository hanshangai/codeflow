import type {
  ApiResult,
  CancelRelayBalancePackBusinessOrderRequestBody,
  CancelRelayBalancePackBusinessOrderResponseBody,
  CreateRelayBalancePackBusinessOrderRequestBody,
  CreateRelayBalancePackBusinessOrderResponseBody,
  GetRelayBalancePackBusinessOrderDetailResponseBody,
  RefreshRelayBalancePackBusinessOrderRequestBody,
  RefreshRelayBalancePackBusinessOrderResponseBody,
  RelayBalancePackCheckoutContextResponseBody,
  RelayBalancePackCheckoutContextQuery,
} from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";

/** 读取当前用户的中转余额购买上下文；调用方可取消过期作用域。 */
export function getRelayBalancePackCheckoutContext(
  ctx: ApiRequestContext,
  input?: RelayBalancePackCheckoutContextQuery,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<RelayBalancePackCheckoutContextResponseBody>> {
  const params = new URLSearchParams();
  const targetScope = input?.targetScope ?? "USER";
  params.set("targetScope", targetScope);
  const enterpriseId = String(input?.enterpriseId ?? "").trim();
  if (targetScope === "ENTERPRISE" && enterpriseId) params.set("enterpriseId", enterpriseId);
  return requestJson(ctx, {
    method: "GET",
    path: `/api/account/me/relay-balance-package/checkout-context${params.size ? `?${params.toString()}` : ""}`,
    signal: opts.signal,
  });
}

/** 创建或复用当前用户的中转余额订单；调用方可取消失效作用域的等待。 */
export function createRelayBalancePackBusinessOrder(
  ctx: ApiRequestContext,
  body: CreateRelayBalancePackBusinessOrderRequestBody,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<CreateRelayBalancePackBusinessOrderResponseBody>> {
  return requestJson(ctx, {
    method: "POST",
    path: "/api/account/me/relay-balance-package/orders",
    body,
    signal: opts.signal,
  });
}

/** 读取当前用户的中转余额订单详情。 */
export function getRelayBalancePackBusinessOrderDetail(
  ctx: ApiRequestContext,
  businessOrderId: string,
): Promise<ApiResult<GetRelayBalancePackBusinessOrderDetailResponseBody>> {
  return requestJson(ctx, {
    method: "GET",
    path: `/api/account/me/relay-balance-package/orders/${encodeURIComponent(businessOrderId)}`,
  });
}

/** 刷新中转余额订单支付状态，或重试已支付未完成的额度同步；支持取消过期读取。 */
export function refreshRelayBalancePackBusinessOrder(
  ctx: ApiRequestContext,
  businessOrderId: string,
  body: RefreshRelayBalancePackBusinessOrderRequestBody,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<RefreshRelayBalancePackBusinessOrderResponseBody>> {
  return requestJson(ctx, {
    method: "POST",
    path: `/api/account/me/relay-balance-package/orders/${encodeURIComponent(businessOrderId)}/refresh`,
    body,
    signal: opts.signal,
  });
}

/** 取消当前未终态的中转余额订单；支持取消失效作用域的等待。 */
export function cancelRelayBalancePackBusinessOrder(
  ctx: ApiRequestContext,
  businessOrderId: string,
  body?: CancelRelayBalancePackBusinessOrderRequestBody,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<CancelRelayBalancePackBusinessOrderResponseBody>> {
  return requestJson(ctx, {
    method: "POST",
    path: `/api/account/me/relay-balance-package/orders/${encodeURIComponent(businessOrderId)}/cancel`,
    body,
    signal: opts.signal,
  });
}
