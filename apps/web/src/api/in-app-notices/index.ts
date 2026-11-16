import type { ActiveInAppNoticesResponseBody, ApiResult } from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";

export function listActiveInAppNotices(
  ctx: ApiRequestContext,
): Promise<ApiResult<ActiveInAppNoticesResponseBody>> {
  return requestJson<ActiveInAppNoticesResponseBody>(ctx, {
    method: "GET",
    path: "/api/account/in-app-notices/active",
  });
}
