import type { ApiResult, RelayPricingCurrentResponseBody } from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";

/** 匿名也可读取公开模型价目表，不要求账号或 WebSocket 会话。 */
export function getPublicRelayPricingCurrent(ctx: ApiRequestContext): Promise<ApiResult<RelayPricingCurrentResponseBody>> {
  return requestJson(ctx, { method: "GET", path: "/api/public/relay/pricing/current" });
}

/** 读取当前登录用户可见的模型价目表，不依赖内置中转是否启用。 */
export function getRelayPricingCurrent(ctx: ApiRequestContext): Promise<ApiResult<RelayPricingCurrentResponseBody>> {
  return requestJson(ctx, { method: "GET", path: "/api/account/relay/pricing/current" });
}
