import type { ApiResult, MyMessageNotificationConfigResponseBody, UpdateMyMessageNotificationConfigRequestBody, UpdateMyMessageNotificationConfigResponseBody } from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";

function withQuery(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value == null || value === "") return;
    params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

/** 读取当前账号的消息通知配置。 */
export function getMyMessageNotificationConfig(ctx: ApiRequestContext): Promise<ApiResult<MyMessageNotificationConfigResponseBody>> {
  return requestJson<MyMessageNotificationConfigResponseBody>(ctx, {
    method: "GET",
    path: "/api/account/message-notifications/config",
  });
}

/** 保存当前账号的消息通知配置。 */
export function updateMyMessageNotificationConfig(
  ctx: ApiRequestContext,
  body: UpdateMyMessageNotificationConfigRequestBody,
): Promise<ApiResult<UpdateMyMessageNotificationConfigResponseBody>> {
  return requestJson<UpdateMyMessageNotificationConfigResponseBody>(ctx, {
    method: "POST",
    path: "/api/account/message-notifications/config",
    body,
  });
}
