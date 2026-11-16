import type {
  ApiResult,
  CancelPaymentOrderRequestBody,
  CancelPaymentOrderResponseBody,
  CreateVerificationOrderRequestBody,
  GetPaymentOrderDetailResponseBody,
  ListVerificationOrdersParams,
  ListVerificationOrdersResponseBody,
  VerificationOrderCreateResponseBody,
  VerificationProductResponseBody,
  VerifyPaymentOrderRequestBody,
  VerifyPaymentOrderResponseBody,
} from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";

export function getVerificationProduct(ctx: ApiRequestContext): Promise<ApiResult<VerificationProductResponseBody>> {
  return requestJson(ctx, { method: "GET", path: "/api/payment/verification/product" });
}

export function createVerificationOrder(
  ctx: ApiRequestContext,
  body: CreateVerificationOrderRequestBody,
): Promise<ApiResult<VerificationOrderCreateResponseBody>> {
  return requestJson(ctx, { method: "POST", path: "/api/payment/verification/orders", body });
}

export function listVerificationOrders(
  ctx: ApiRequestContext,
  query: ListVerificationOrdersParams,
): Promise<ApiResult<ListVerificationOrdersResponseBody>> {
  const params = new URLSearchParams();
  if (query.status && query.status !== "ALL") params.set("status", query.status);
  if (query.confirmedBy && query.confirmedBy !== "ALL") params.set("confirmedBy", query.confirmedBy);
  if (query.keyword?.trim()) params.set("keyword", query.keyword.trim());
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  const path = params.size ? `/api/payment/verification/orders?${params.toString()}` : "/api/payment/verification/orders";
  return requestJson(ctx, { method: "GET", path });
}

export function getPaymentOrderDetail(
  ctx: ApiRequestContext,
  orderId: string,
): Promise<ApiResult<GetPaymentOrderDetailResponseBody>> {
  return requestJson(ctx, { method: "GET", path: `/api/payment/verification/orders/${encodeURIComponent(orderId)}` });
}

export function verifyPaymentOrder(
  ctx: ApiRequestContext,
  orderId: string,
  body: VerifyPaymentOrderRequestBody,
): Promise<ApiResult<VerifyPaymentOrderResponseBody>> {
  return requestJson(ctx, {
    method: "POST",
    path: `/api/payment/verification/orders/${encodeURIComponent(orderId)}/verify`,
    body,
  });
}

export function cancelPaymentOrder(
  ctx: ApiRequestContext,
  orderId: string,
  body?: CancelPaymentOrderRequestBody,
): Promise<ApiResult<CancelPaymentOrderResponseBody>> {
  return requestJson(ctx, {
    method: "POST",
    path: `/api/payment/verification/orders/${encodeURIComponent(orderId)}/cancel`,
    body,
  });
}
